// A small PostgreSQL-flavoured SQL subset for the "Index Fund" game. Pure logic, no DOM.
//
// It parses the statements the game supports (SELECT with JOINs, EXPLAIN [ANALYZE], CREATE/DROP INDEX,
// ALTER TABLE ADD/DROP COLUMN and constraints), edits an in-memory catalog, and plans SELECTs with a
// cost model shaped like Postgres's: sequential scan vs index scan vs bitmap heap scan, sort, limit,
// nested-loop and hash joins. Costs are in the same units as real EXPLAIN output (a sequential page is
// 1.0, a random page 4.0, a row 0.01) and are turned into milliseconds with one constant.
//
// What it models, because topics/database/notes/03 teaches it: a seq scan reads every row; a B-tree
// index jumps to matching rows; the planner ignores an index when a filter matches a large share of
// the table; an index on (a, b) serves a and (a AND b) but not b alone; an index can return rows in
// order so a `ORDER BY ... LIMIT` needs no sort; every index must be maintained on write.

export const MS_PER_COST = 0.02;
const COST = { seqPage: 1, randPage: 4, cpuTuple: 0.01, cpuOp: 0.0025, cpuIdx: 0.005, idxStart: 0.43 };

export class SqlError extends Error {
  constructor(message, pos, hint) {
    super(message);
    this.pos = pos;
    this.hint = hint;
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const round2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export { fmtInt };

// ---------------------------------------------------------------- tokenizer

const OPS2 = ['<=', '>=', '<>', '!=', '::'];

export function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    const pos = i;
    if (c === "'") {
      let s = '';
      i += 1;
      for (;;) {
        if (i >= src.length) throw new SqlError('unterminated quoted string', pos);
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          break;
        }
        s += src[i];
        i += 1;
      }
      i += 1;
      toks.push({ t: 'str', v: s, raw: src.slice(pos, i), pos });
    } else if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new SqlError('unterminated quoted identifier', pos);
      toks.push({ t: 'id', v: src.slice(i + 1, end), raw: src.slice(pos, end + 1), q: true, pos });
      i = end + 1;
    } else if (/[0-9]/.test(c)) {
      while (i < src.length && /[0-9.]/.test(src[i])) i += 1;
      toks.push({ t: 'num', v: src.slice(pos, i), raw: src.slice(pos, i), pos });
    } else if (c === '$' && /[0-9]/.test(src[i + 1] || '')) {
      i += 1;
      while (i < src.length && /[0-9]/.test(src[i])) i += 1;
      toks.push({ t: 'param', v: src.slice(pos, i), raw: src.slice(pos, i), pos });
    } else if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i += 1;
      const raw = src.slice(pos, i);
      toks.push({ t: 'id', v: raw.toLowerCase(), raw, pos });
    } else if (c === '\\') {
      throw new SqlError(`invalid command \\${src[i + 1] || ''}`, pos);
    } else {
      const two = src.slice(i, i + 2);
      const op = OPS2.includes(two) ? two : c;
      if (!'(),;.*=<>+-/!:%'.includes(op[0])) throw new SqlError(`syntax error at or near "${c}"`, pos);
      i += op.length;
      toks.push({ t: 'op', v: op, raw: op, pos });
    }
  }
  return toks.map((t) => ({ ...t, end: t.pos + t.raw.length }));
}

// Splits tokens on `;` into statements with their source text (so carets point into the right place).
export function splitStatements(src) {
  const toks = tokenize(src);
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].pos;
    const end = cur[cur.length - 1].end;
    const text = src.slice(start, end);
    out.push({ text, toks: cur.map((t) => ({ ...t, pos: t.pos - start, end: t.end - start })) });
    cur = [];
  };
  for (const t of toks) {
    if (t.t === 'op' && t.v === ';') flush();
    else cur.push(t);
  }
  flush();
  return out;
}

// psql-style error text: ERROR line, the offending line with a caret, optional HINT.
export function formatError(e, text) {
  const lines = [`ERROR:  ${e.message}`];
  if (e.pos !== undefined && text) {
    const flat = text.replace(/\s+/g, ' ');
    const start = Math.max(0, Math.min(e.pos, flat.length) - 32);
    const shown = (start > 0 ? '...' : '') + flat.slice(start, start + 70) + (start + 70 < flat.length ? '...' : '');
    const label = 'LINE 1: ';
    lines.push(`${label}${shown}`);
    lines.push(`${' '.repeat(label.length + (start > 0 ? 3 : 0) + Math.min(e.pos, flat.length) - start)}^`);
  }
  if (e.hint) lines.push(`HINT:  ${e.hint}`);
  return lines;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(toks, text) {
    this.toks = toks;
    this.text = text;
    this.i = 0;
  }

  peek(o = 0) {
    return this.toks[this.i + o];
  }

  next() {
    return this.toks[this.i++];
  }

  isKw(...words) {
    const t = this.peek();
    return Boolean(t && t.t === 'id' && !t.q && words.includes(t.v));
  }

  eatKw(w) {
    if (!this.isKw(w)) return false;
    this.i += 1;
    return true;
  }

  expectKw(w) {
    if (!this.eatKw(w)) throw this.syntax();
  }

  isOp(o) {
    const t = this.peek();
    return Boolean(t && t.t === 'op' && t.v === o);
  }

  eatOp(o) {
    if (!this.isOp(o)) return false;
    this.i += 1;
    return true;
  }

  expectOp(o) {
    if (!this.eatOp(o)) throw this.syntax();
  }

  atEnd() {
    return this.i >= this.toks.length;
  }

  syntax() {
    const t = this.peek();
    return t ? new SqlError(`syntax error at or near "${t.raw}"`, t.pos) : new SqlError('syntax error at end of input', this.text.length);
  }

  unsupported(what) {
    const t = this.peek() || { pos: this.text.length };
    return new SqlError(`${what} is not supported by this exercise's SQL subset`, t.pos);
  }

  ident() {
    const t = this.peek();
    if (!t || t.t !== 'id') throw this.syntax();
    this.i += 1;
    return t;
  }

  colRef() {
    const first = this.ident();
    if (this.eatOp('.')) {
      const second = this.ident();
      return { alias: first.v, col: second.v, pos: first.pos, text: `${first.raw}.${second.raw}` };
    }
    return { alias: null, col: first.v, pos: first.pos, text: first.raw };
  }

  value() {
    const t = this.peek();
    if (!t) throw this.syntax();
    let v;
    if (t.t === 'str') v = { lit: t.v, kind: 'str', text: `'${t.v.replace(/'/g, "''")}'` };
    else if (t.t === 'num') v = { lit: t.v, kind: 'num', text: t.v };
    else if (t.t === 'param') v = { lit: undefined, kind: 'param', text: t.v };
    else if (t.t === 'id' && ['true', 'false'].includes(t.v)) v = { lit: t.v, kind: 'bool', text: t.v };
    else throw this.syntax();
    this.i += 1;
    if (this.eatOp('::')) this.ident(); // 'x'::text
    return v;
  }
}

const CMP = ['=', '<', '>', '<=', '>=', '<>', '!='];

function parseSelect(p) {
  p.expectKw('select');
  const startTok = p.peek();
  if (!startTok) throw p.syntax();
  let depth = 0;
  while (p.peek() && !(depth === 0 && p.isKw('from'))) {
    const t = p.next();
    if (t.t === 'op' && t.v === '(') depth += 1;
    if (t.t === 'op' && t.v === ')') depth -= 1;
  }
  if (p.atEnd()) throw new SqlError('syntax error at end of input', p.text.length, 'This exercise needs a FROM clause: SELECT ... FROM table.');
  const selectText = p.text.slice(startTok.pos, p.peek().pos).trim();
  const selectToks = p.toks.slice(p.toks.indexOf(startTok), p.i);
  p.expectKw('from');
  const from = parseRel(p);
  const joins = [];
  for (;;) {
    let left = false;
    if (p.isKw('inner')) p.next();
    else if (p.isKw('left')) {
      p.next();
      p.eatKw('outer');
      left = true;
    } else if (p.isKw('right', 'full', 'cross')) throw p.unsupported(`${p.peek().raw.toUpperCase()} JOIN`);
    if (!p.eatKw('join')) {
      if (left) throw p.syntax();
      break;
    }
    const rel = parseRel(p);
    p.expectKw('on');
    const a = p.colRef();
    p.expectOp('=');
    const b = p.colRef();
    if (p.isKw('and', 'or')) throw p.unsupported('more than one ON condition');
    joins.push({ rel, left, a, b });
  }
  const where = [];
  if (p.eatKw('where')) {
    for (;;) {
      const ref = p.colRef();
      const t = p.peek();
      if (!t) throw p.syntax();
      if (t.t === 'op' && CMP.includes(t.v)) {
        p.next();
        const nxt = p.peek();
        if (nxt && nxt.t === 'id' && !['true', 'false'].includes(nxt.v)) throw p.unsupported('comparing two columns in WHERE (use JOIN ... ON)');
        where.push({ ref, op: t.v === '!=' ? '<>' : t.v, val: p.value() });
      } else if (p.isKw('is')) {
        p.next();
        const not = p.eatKw('not');
        p.expectKw('null');
        where.push({ ref, op: not ? 'notnull' : 'isnull', val: { lit: undefined, kind: 'null', text: 'NULL' } });
      } else if (p.isKw('in', 'like', 'ilike', 'between')) throw p.unsupported(`${t.raw.toUpperCase()}`);
      else throw p.syntax();
      if (p.eatKw('and')) continue;
      if (p.isKw('or')) throw p.unsupported('OR');
      break;
    }
  }
  if (p.isKw('group', 'having', 'union', 'offset')) throw p.unsupported(p.peek().raw.toUpperCase());
  const order = [];
  if (p.eatKw('order')) {
    p.expectKw('by');
    do {
      const ref = p.colRef();
      let desc = false;
      if (p.eatKw('desc')) desc = true;
      else p.eatKw('asc');
      order.push({ ref, desc });
    } while (p.eatOp(','));
  }
  let limit = null;
  if (p.eatKw('limit')) {
    const t = p.next();
    if (!t || t.t !== 'num') throw p.syntax();
    limit = Number(t.v);
  }
  if (!p.atEnd()) throw p.syntax();
  return { kind: 'select', selectText, selectToks, from, joins, where, order, limit };
}

function parseRel(p) {
  const table = p.ident();
  let alias = table;
  if (p.eatKw('as')) alias = p.ident();
  else {
    const t = p.peek();
    const stop = ['join', 'inner', 'left', 'right', 'full', 'cross', 'on', 'where', 'order', 'limit', 'group', 'having'];
    if (t && t.t === 'id' && (t.q || !stop.includes(t.v))) alias = p.ident();
  }
  return { table: table.v, tablePos: table.pos, alias: alias.v };
}

function parseColumnList(p) {
  const cols = [];
  p.expectOp('(');
  do {
    cols.push(p.ident());
    if (p.isKw('asc', 'desc')) throw p.unsupported('a sort direction in an index column');
  } while (p.eatOp(','));
  p.expectOp(')');
  return cols;
}

export function parseStatement(toks, text) {
  const p = new Parser(toks, text);
  const first = p.peek();
  if (!first || first.t !== 'id') throw p.syntax();
  switch (first.v) {
    case 'select':
      return parseSelect(p);
    case 'explain': {
      p.next();
      let analyze = false;
      if (p.eatOp('(')) {
        while (!p.eatOp(')')) {
          const t = p.next();
          if (!t) throw p.syntax();
          if (t.t === 'id' && t.v === 'analyze') analyze = true;
        }
      } else {
        while (p.isKw('analyze', 'analyse', 'verbose')) if (p.next().v !== 'verbose') analyze = true;
      }
      const sel = parseSelect(p);
      return { kind: 'explain', analyze, select: sel };
    }
    case 'create': {
      p.next();
      const unique = p.eatKw('unique');
      p.expectKw('index');
      p.eatKw('concurrently');
      let ifNot = false;
      if (p.eatKw('if')) {
        p.expectKw('not');
        p.expectKw('exists');
        ifNot = true;
      }
      let name = null;
      if (!p.isKw('on')) name = p.ident();
      p.expectKw('on');
      const table = p.ident();
      if (p.eatKw('using')) {
        const m = p.ident();
        if (m.v !== 'btree') throw new SqlError(`this exercise only models btree indexes, not "${m.raw}"`, m.pos);
      }
      const cols = parseColumnList(p);
      if (p.isKw('where')) throw p.unsupported('a partial index (WHERE)');
      if (!p.atEnd()) throw p.syntax();
      return { kind: 'create_index', unique, ifNot, name: name && name.v, table: table.v, tablePos: table.pos, cols: cols.map((c) => ({ v: c.v, pos: c.pos })) };
    }
    case 'drop': {
      p.next();
      if (!p.isKw('index')) throw p.unsupported(`DROP ${p.peek() ? p.peek().raw.toUpperCase() : ''}`);
      p.next();
      p.eatKw('concurrently');
      let ifExists = false;
      if (p.eatKw('if')) {
        p.expectKw('exists');
        ifExists = true;
      }
      const names = [];
      do {
        if (p.eatKw('public') && !p.eatOp('.')) throw p.syntax();
        names.push(p.ident());
      } while (p.eatOp(','));
      if (!p.atEnd()) throw p.syntax();
      return { kind: 'drop_index', ifExists, names: names.map((n) => ({ v: n.v, pos: n.pos })) };
    }
    case 'alter': {
      p.next();
      p.expectKw('table');
      const table = p.ident();
      const actions = [];
      do {
        if (p.eatKw('add')) {
          if (p.eatKw('constraint')) {
            const name = p.ident();
            if (p.eatKw('unique')) actions.push({ op: 'add_unique', name: name.v, cols: parseColumnList(p).map((c) => ({ v: c.v, pos: c.pos })) });
            else throw p.unsupported('this constraint type');
          } else {
            p.eatKw('column');
            let ifNot = false;
            if (p.eatKw('if')) {
              p.expectKw('not');
              p.expectKw('exists');
              ifNot = true;
            }
            const col = p.ident();
            const type = p.ident();
            let typeText = type.v;
            if (p.eatOp('(')) {
              while (!p.eatOp(')')) if (!p.next()) throw p.syntax();
              typeText = `${type.v}(n)`;
            }
            const a = { op: 'add_column', name: col.v, namePos: col.pos, type: typeText, typePos: type.pos, notNull: false, def: null, ifNot };
            while (!p.atEnd() && !p.isOp(',')) {
              if (p.eatKw('not')) {
                p.expectKw('null');
                a.notNull = true;
              } else if (p.eatKw('null')) a.notNull = false;
              else if (p.eatKw('default')) a.def = p.value().text;
              else if (p.eatKw('unique')) a.unique = true;
              else throw p.syntax();
            }
            actions.push(a);
          }
        } else if (p.eatKw('drop')) {
          if (p.eatKw('constraint')) {
            let ifExists = false;
            if (p.eatKw('if')) {
              p.expectKw('exists');
              ifExists = true;
            }
            const name = p.ident();
            actions.push({ op: 'drop_constraint', name: name.v, pos: name.pos, ifExists });
          } else {
            p.eatKw('column');
            let ifExists = false;
            if (p.eatKw('if')) {
              p.expectKw('exists');
              ifExists = true;
            }
            const col = p.ident();
            p.eatKw('cascade');
            actions.push({ op: 'drop_column', name: col.v, pos: col.pos, ifExists });
          }
        } else throw p.unsupported(p.peek() ? `ALTER TABLE ${p.peek().raw.toUpperCase()}` : 'this ALTER TABLE form');
      } while (p.eatOp(','));
      if (!p.atEnd()) throw p.syntax();
      return { kind: 'alter_table', table: table.v, tablePos: table.pos, actions };
    }
    case 'analyze':
    case 'analyse':
      return { kind: 'analyze' };
    case 'begin':
    case 'commit':
    case 'rollback':
      return { kind: 'tx', word: first.v.toUpperCase() };
    case 'vacuum':
      return { kind: 'analyze', word: 'VACUUM' };
    default:
      throw new SqlError(`this exercise supports SELECT, EXPLAIN, CREATE INDEX, DROP INDEX, ALTER TABLE and ANALYZE, not ${first.raw.toUpperCase()}`, first.pos);
  }
}

// ---------------------------------------------------------------- catalog

const TYPES = {
  bigint: ['bigint', 8],
  int8: ['bigint', 8],
  integer: ['integer', 4],
  int: ['integer', 4],
  int4: ['integer', 4],
  smallint: ['smallint', 2],
  text: ['text', 24],
  varchar: ['character varying', 24],
  'varchar(n)': ['character varying', 24],
  boolean: ['boolean', 1],
  bool: ['boolean', 1],
  timestamptz: ['timestamp with time zone', 8],
  timestamp: ['timestamp without time zone', 8],
  date: ['date', 4],
  numeric: ['numeric', 8],
  uuid: ['uuid', 16],
  jsonb: ['jsonb', 48],
};

export function makeColumn(c) {
  const info = TYPES[c.type] || [c.type, 8];
  return { type: info[0], width: c.width || info[1], notNull: Boolean(c.notNull), def: c.def || c.default || null, stat: c.stat || { frac: 0.1 } };
}

// Turns the scenario's table list ([{name, cols: [...]}]) into the working catalog.
export function buildCatalog(spec) {
  const tables = {};
  for (const t of spec.tables) {
    tables[t.name] = { rows: t.rows, cols: Object.fromEntries(t.cols.map((c) => [c.name, makeColumn(c)])), fks: t.fks || [] };
  }
  const indexes = spec.indexes.map((ix) => ({ scans: 0, unique: false, kind: 'index', ...ix, cols: [...ix.cols] }));
  return { tables, indexes };
}

export const rowWidth = (t) => 24 + Object.values(t.cols).reduce((s, c) => s + c.width, 0);
export const rowsPerPage = (t) => Math.max(1, Math.floor(8000 / rowWidth(t)));
export const pagesOf = (t) => Math.max(1, Math.ceil(t.rows / rowsPerPage(t)));
export const tableBytes = (t) => t.rows * rowWidth(t);
export const indexBytes = (t, ix) => t.rows * (ix.cols.reduce((s, c) => s + (t.cols[c] ? t.cols[c].width : 8), 0) + 12);
export const indexesOf = (db, table) => db.indexes.filter((ix) => ix.table === table);

export function storageMb(db) {
  let bytes = 0;
  for (const [name, t] of Object.entries(db.tables)) {
    bytes += tableBytes(t);
    for (const ix of indexesOf(db, name)) bytes += indexBytes(t, ix);
  }
  return bytes / 1048576;
}

// A comparable fingerprint of the schema, used to tell whether two databases (or a database and a
// replay of its migrations) have the same structure.
export function signature(db) {
  const tables = Object.entries(db.tables)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, t]) => `${name}(${Object.entries(t.cols).map(([c, d]) => `${c}:${d.type}${d.notNull ? '!' : ''}${d.def ? `=${d.def}` : ''}`).sort().join(',')})`);
  const indexes = db.indexes.map((ix) => `${ix.name}:${ix.table}(${ix.cols.join(',')})${ix.unique ? 'u' : ''}`).sort();
  return `${tables.join(';')}|${indexes.join(';')}`;
}

// ---------------------------------------------------------------- binding

function findRel(rels, name) {
  return rels.find((r) => r.alias === name) || rels.find((r) => r.table === name && r.alias === r.table) || rels.find((r) => r.table === name);
}

function resolveCol(db, rels, ref) {
  if (ref.alias) {
    const rel = findRel(rels, ref.alias);
    if (!rel) throw new SqlError(`missing FROM-clause entry for table "${ref.alias}"`, ref.pos);
    if (!db.tables[rel.table].cols[ref.col]) throw new SqlError(`column ${ref.alias}.${ref.col} does not exist`, ref.pos);
    return { alias: rel.alias, table: rel.table, col: ref.col };
  }
  const hits = rels.filter((r) => db.tables[r.table].cols[ref.col]);
  if (!hits.length) throw new SqlError(`column "${ref.col}" does not exist`, ref.pos);
  if (hits.length > 1) throw new SqlError(`column reference "${ref.col}" is ambiguous`, ref.pos);
  return { alias: hits[0].alias, table: hits[0].table, col: ref.col };
}

// Checks names against the catalog and returns the select in the form the planner uses.
export function bindSelect(db, ast) {
  const rels = [];
  const addRel = (r) => {
    if (!db.tables[r.table]) throw new SqlError(`relation "${r.table}" does not exist`, r.tablePos);
    if (rels.some((x) => x.alias === r.alias)) throw new SqlError(`table name "${r.alias}" specified more than once`, r.tablePos);
    rels.push({ table: r.table, alias: r.alias });
  };
  addRel(ast.from);
  for (const j of ast.joins) addRel(j.rel);
  const edges = ast.joins.map((j) => {
    const a = resolveCol(db, rels, j.a);
    const b = resolveCol(db, rels, j.b);
    if (a.alias === b.alias) throw new SqlError('a JOIN condition must compare columns of two different tables', j.a.pos);
    return { a, b, left: j.left, rel: j.rel.alias };
  });
  const conds = ast.where.map((w) => {
    const r = resolveCol(db, rels, w.ref);
    return { alias: r.alias, table: r.table, col: r.col, op: w.op, lit: w.val.lit, kind: w.val.kind, valText: w.val.text };
  });
  const order = ast.order.map((o) => ({ ...resolveCol(db, rels, o.ref), desc: o.desc }));
  // qualified references in the select list must exist too
  const st = ast.selectToks;
  for (let i = 0; i + 2 < st.length; i += 1) {
    if (st[i].t === 'id' && st[i + 1].t === 'op' && st[i + 1].v === '.' && st[i + 2].t === 'id') {
      resolveCol(db, rels, { alias: st[i].v, col: st[i + 2].v, pos: st[i].pos });
    }
  }
  return { rels, edges, conds, order, limit: ast.limit, selectText: ast.selectText };
}

// ---------------------------------------------------------------- statistics

// Fraction of the table one condition keeps.
function condFrac(t, c) {
  const col = t.cols[c.col];
  const st = col.stat || {};
  const rows = Math.max(1, t.rows);
  const eq = () => {
    if (st.unique) return 1 / rows;
    if (st.values && c.lit !== undefined && c.lit in st.values) return st.values[c.lit];
    if (st.per) return Math.min(1, st.per / rows);
    if (st.frac) return st.frac;
    return 0.01;
  };
  if (c.op === '=') return eq();
  if (c.op === '<>') return 1 - eq();
  if (c.op === 'isnull') return st.nullFrac || 0.001;
  if (c.op === 'notnull') return 1 - (st.nullFrac || 0.001);
  return 1 / 3;
}

const estRows = (t, conds) => Math.max(1, Math.round(t.rows * conds.reduce((f, c) => f * condFrac(t, c), 1)));

// ---------------------------------------------------------------- plan nodes

function node(type, props) {
  return { type, startup: 0, total: 0, rows: 1, width: 0, kids: [], loops: 1, ...props };
}

function condText(c) {
  if (c.joinFrom) return `${c.col} = ${c.joinFrom}`;
  const op = c.op === 'isnull' ? 'IS NULL' : c.op === 'notnull' ? 'IS NOT NULL' : c.op;
  if (c.op === 'isnull' || c.op === 'notnull') return `${c.col} ${op}`;
  const cast = c.kind === 'str' ? '::text' : '';
  return `${c.col} ${op} ${c.valText}${cast}`;
}

const condsText = (conds) => (conds.length === 1 ? `(${condText(conds[0])})` : `(${conds.map((c) => `(${condText(c)})`).join(' AND ')})`);

function seqScan(t, rel, conds) {
  const total = pagesOf(t) * COST.seqPage + t.rows * COST.cpuTuple + t.rows * COST.cpuOp * conds.length;
  return node('Seq Scan', { rel, total, rows: estRows(t, conds), width: rowWidth(t) - 24, filter: conds });
}

function matchIndex(ix, conds) {
  const used = [];
  let eqPrefix = 0;
  for (const col of ix.cols) {
    const eq = conds.find((c) => c.col === col && c.op === '=' && !used.includes(c));
    if (eq) {
      used.push(eq);
      eqPrefix += 1;
      continue;
    }
    for (const r of conds.filter((c) => c.col === col && ['<', '>', '<=', '>='].includes(c.op))) used.push(r);
    break;
  }
  return { used, eqPrefix };
}

function providesOrder(ix, eqPrefix, order) {
  if (!order) return false;
  const cols = ix.cols.slice(eqPrefix, eqPrefix + order.cols.length);
  return cols.length === order.cols.length && cols.every((c, i) => c === order.cols[i]);
}

function indexPaths(db, t, rel, conds, order) {
  const out = [];
  const pages = pagesOf(t);
  for (const ix of indexesOf(db, rel.table)) {
    const { used, eqPrefix } = matchIndex(ix, conds);
    const ordered = providesOrder(ix, eqPrefix, order);
    if (!used.length && !ordered) continue;
    const m = estRows(t, used);
    const rest = conds.filter((c) => !used.includes(c));
    const leaf = Math.max(1, Math.ceil(m / 300));
    const rowsOut = estRows(t, conds);
    const width = rowWidth(t) - 24;
    const heap = m * COST.randPage + m * (COST.cpuTuple + COST.cpuOp * rest.length);
    const scan = node('Index Scan', {
      rel,
      index: ix,
      indexConds: used,
      filter: rest,
      startup: COST.idxStart,
      total: COST.idxStart + leaf * COST.randPage + heap,
      rows: rowsOut,
      width,
      ordered,
      backward: Boolean(ordered && order.desc),
    });
    out.push(scan);
    if (!ordered && used.length && m > 2) {
      const idxPart = COST.idxStart + leaf * COST.randPage + m * COST.cpuIdx;
      const heapPages = Math.min(m, pages);
      const perPage = COST.randPage - (COST.randPage - COST.seqPage) * Math.sqrt(heapPages / pages);
      const total = idxPart + 0.1 + heapPages * perPage + m * (COST.cpuTuple + COST.cpuOp * (rest.length + used.length));
      const bitmapIdx = node('Bitmap Index Scan', { rel, index: ix, indexConds: used, startup: COST.idxStart, total: idxPart, rows: m, width: 0 });
      out.push(node('Bitmap Heap Scan', { rel, recheck: used, filter: rest, startup: idxPart + 0.1, total, rows: rowsOut, width, kids: [bitmapIdx] }));
    }
  }
  return out;
}

function sortNode(child, order, limit) {
  const m = child.rows;
  const cost = 2 * COST.cpuOp * m * Math.log2(Math.max(limit || m, 2));
  const startup = child.total + cost;
  return node('Sort', { startup, total: startup, rows: m, width: child.width, kids: [child], sortKeys: order.map((o) => `${o.col}${o.desc ? ' DESC' : ''}`), topN: Boolean(limit && limit < m) });
}

function limitNode(child, limit) {
  const rows = Math.min(limit, child.rows);
  const total = child.rows > limit ? child.startup + ((child.total - child.startup) * limit) / child.rows : child.total;
  return node('Limit', { startup: child.startup, total, rows, width: child.width, kids: [child] });
}

// Best way to read one table: every path, wrapped in the sort and limit the query wants.
function bestSingle(db, rel, conds, want = {}) {
  const t = db.tables[rel.table];
  const order = want.order && want.order.length ? { cols: want.order.map((o) => o.col), desc: want.order[0].desc } : null;
  const mixed = want.order && want.order.some((o) => o.desc !== want.order[0].desc);
  const paths = [...indexPaths(db, t, rel, conds, mixed ? null : order), seqScan(t, rel, conds)];
  let best = null;
  for (const path of paths) {
    let plan = path;
    if (want.order && want.order.length && !path.ordered) plan = sortNode(plan, want.order, want.limit);
    if (want.limit) plan = limitNode(plan, want.limit);
    if (!best || plan.total < best.total - 1e-9) best = plan;
  }
  return best;
}

// Joins: try every table as the driving table, extend along the ON edges, and per step pick the
// cheaper of a nested loop with an index lookup on the inner side and a hash join.
function planJoins(db, b) {
  const relConds = (rel) => b.conds.filter((c) => c.alias === rel.alias);
  let best = null;
  for (const start of b.rels) {
    let cur = bestSingle(db, start, relConds(start));
    const joined = [start.alias];
    let ok = true;
    while (joined.length < b.rels.length) {
      const edge = b.edges.find((e) => (joined.includes(e.a.alias) && !joined.includes(e.b.alias)) || (joined.includes(e.b.alias) && !joined.includes(e.a.alias)));
      if (!edge) {
        ok = false;
        break;
      }
      const innerSide = joined.includes(edge.a.alias) ? edge.b : edge.a;
      const outerSide = innerSide === edge.a ? edge.b : edge.a;
      const rel = b.rels.find((r) => r.alias === innerSide.alias);
      const t = db.tables[rel.table];
      const own = relConds(rel);
      const joinCond = { alias: rel.alias, table: rel.table, col: innerSide.col, op: '=', joinFrom: `${outerSide.alias}.${outerSide.col}` };
      const left = edge.left && edge.rel === rel.alias;
      // nested loop: one index lookup per outer row
      const probe = bestSingle(db, rel, [...own, joinCond]);
      const nlRows = Math.max(1, cur.rows * probe.rows);
      const nl = node(left ? 'Nested Loop Left Join' : 'Nested Loop', {
        startup: cur.startup + probe.startup,
        total: cur.total + cur.rows * probe.total + nlRows * COST.cpuTuple,
        rows: nlRows,
        width: cur.width + probe.width,
        kids: [cur, { ...probe, loops: cur.rows }],
      });
      // hash join: read the inner table once, build a hash, probe it with the outer rows
      const scan = bestSingle(db, rel, own);
      const hashed = node('Hash', { startup: scan.total + scan.rows * COST.cpuOp, total: scan.total + scan.rows * COST.cpuOp, rows: scan.rows, width: scan.width, kids: [scan] });
      const hjRows = Math.max(1, Math.round(cur.rows * (t.rows ? probe.rows : 1)));
      const hj = node(left ? 'Hash Left Join' : 'Hash Join', {
        startup: hashed.total + cur.startup,
        total: hashed.total + cur.total + cur.rows * COST.cpuOp + hjRows * COST.cpuTuple,
        rows: hjRows,
        width: cur.width + scan.width,
        hashCond: `${innerSide.alias}.${innerSide.col} = ${outerSide.alias}.${outerSide.col}`,
        kids: [cur, hashed],
      });
      cur = nl.total <= hj.total ? nl : hj;
      joined.push(rel.alias);
    }
    if (!ok) continue;
    if (!best || cur.total < best.total) best = cur;
  }
  if (!best) throw new SqlError('this exercise needs every table to be connected by a JOIN ... ON condition');
  return best;
}

export function planSelect(db, bound) {
  let plan;
  if (bound.rels.length === 1) {
    plan = bestSingle(db, bound.rels[0], bound.conds, { order: bound.order, limit: bound.limit });
  } else {
    plan = planJoins(db, bound);
    if (bound.order.length) plan = sortNode(plan, bound.order, bound.limit);
    if (bound.limit) plan = limitNode(plan, bound.limit);
  }
  return plan;
}

export const planMs = (plan) => plan.total * MS_PER_COST;

export function indexesUsed(plan) {
  const out = [];
  const walk = (n) => {
    if (n.index) out.push(n.index.name);
    n.kids.forEach(walk);
  };
  walk(plan);
  return out;
}

export function planTopNode(plan) {
  let n = plan;
  while ((n.type === 'Limit' || n.type === 'Sort') && n.kids.length) n = n.kids[0];
  return n;
}

// A short label for the feed card: "Seq Scan on users" / "Index Scan using users_email_idx".
export function planSummary(plan) {
  const parts = [];
  const walk = (n) => {
    if (n.type === 'Seq Scan') parts.push(`Seq Scan on ${n.rel.table}`);
    else if (n.type === 'Index Scan') parts.push(`${n.backward ? 'Index Scan Backward' : 'Index Scan'} using ${n.index.name}`);
    else if (n.type === 'Bitmap Heap Scan') parts.push(`Bitmap Scan using ${n.kids[0].index.name}`);
    else if (n.type === 'Sort') parts.push('Sort');
    else if (/Join|Nested/.test(n.type)) parts.unshift(n.type);
    if (n.type !== 'Bitmap Heap Scan') n.kids.forEach(walk);
  };
  walk(plan);
  return parts.join(' + ');
}

// ---------------------------------------------------------------- EXPLAIN text

function nodeTitle(n) {
  const relName = (r) => (r.alias !== r.table ? `${r.table} ${r.alias}` : r.table);
  switch (n.type) {
    case 'Seq Scan':
      return `Seq Scan on ${relName(n.rel)}`;
    case 'Index Scan':
      return `Index Scan${n.backward ? ' Backward' : ''} using ${n.index.name} on ${relName(n.rel)}`;
    case 'Bitmap Heap Scan':
      return `Bitmap Heap Scan on ${relName(n.rel)}`;
    case 'Bitmap Index Scan':
      return `Bitmap Index Scan on ${n.index.name}`;
    default:
      return n.type;
  }
}

function nodeDetails(n, analyze) {
  const out = [];
  if (n.type === 'Sort') out.push(`Sort Key: ${n.sortKeys.join(', ')}`);
  if (n.type === 'Sort' && analyze) out.push(`Sort Method: ${n.topN ? 'top-N heapsort' : 'quicksort'}  Memory: ${Math.max(25, Math.round(n.rows * 0.2))}kB`);
  if (n.hashCond) out.push(`Hash Cond: (${n.hashCond})`);
  if (n.indexConds && n.indexConds.length) out.push(`Index Cond: ${condsText(n.indexConds)}`);
  if (n.recheck && n.recheck.length) out.push(`Recheck Cond: ${condsText(n.recheck)}`);
  if (n.filter && n.filter.length) out.push(`Filter: ${condsText(n.filter)}`);
  return out;
}

export function explainLines(plan, { analyze = false, nrel = 1 } = {}) {
  const lines = [];
  const walk = (n, depth, loops, parent) => {
    const indent = depth === 0 ? '' : `${' '.repeat(6 * depth - 4)}->  `;
    const cost = `(cost=${round2(n.startup)}..${round2(n.total)} rows=${n.rows} width=${n.width})`;
    let act = '';
    if (analyze) {
      // under a LIMIT a streaming node stops early, so it reports only the rows and time actually used
      const early = parent && parent.type === 'Limit' && n.type !== 'Sort';
      const rows = early ? parent.rows : n.rows;
      const end = early ? parent.total : n.total;
      act = ` (actual time=${(n.startup * MS_PER_COST).toFixed(3)}..${(end * MS_PER_COST).toFixed(3)} rows=${rows} loops=${loops})`;
    }
    lines.push(`${indent}${nodeTitle(n)}  ${cost}${act}`);
    for (const d of nodeDetails(n, analyze)) lines.push(`${' '.repeat(6 * depth + 2)}${d}`);
    for (const k of n.kids) walk(k, depth + 1, k.loops || 1, n);
  };
  walk(plan, 0, 1, null);
  if (analyze) {
    lines.push(`Planning Time: ${(0.08 + 0.05 * nrel).toFixed(3)} ms`);
    lines.push(`Execution Time: ${planMs(plan).toFixed(3)} ms`);
  }
  const width = Math.max(11, ...lines.map((l) => l.length)) + 2;
  const pad = Math.floor((width - 10) / 2);
  const out = [`${' '.repeat(pad)}QUERY PLAN`, '-'.repeat(width), ...lines.map((l) => ` ${l}`), `(${lines.length} row${lines.length === 1 ? '' : 's'})`];
  return out;
}

// ---------------------------------------------------------------- DDL on the catalog

function needTable(db, name, pos) {
  if (!db.tables[name]) throw new SqlError(`relation "${name}" does not exist`, pos);
  return db.tables[name];
}

function defaultIndexName(table, cols, unique) {
  return `${table}_${cols.join('_')}_${unique ? 'key' : 'idx'}`;
}

// Applies one parsed DDL statement to `db` (mutating it). Returns the command tag psql prints.
export function applyDdl(db, st) {
  switch (st.kind) {
    case 'create_index': {
      const t = needTable(db, st.table, st.tablePos);
      for (const c of st.cols) if (!t.cols[c.v]) throw new SqlError(`column "${c.v}" does not exist`, c.pos);
      const cols = st.cols.map((c) => c.v);
      const name = st.name || defaultIndexName(st.table, cols, st.unique);
      if (db.indexes.some((ix) => ix.name === name)) {
        if (st.ifNot) return { tag: 'CREATE INDEX', note: `NOTICE:  relation "${name}" already exists, skipping`, changed: false };
        throw new SqlError(`relation "${name}" already exists`);
      }
      db.indexes.push({ name, table: st.table, cols, unique: st.unique, kind: st.unique ? 'unique' : 'index', scans: 0 });
      return { tag: 'CREATE INDEX', changed: true };
    }
    case 'drop_index': {
      let changed = false;
      let note = null;
      for (const n of st.names) {
        const ix = db.indexes.find((x) => x.name === n.v);
        if (!ix) {
          if (st.ifExists) {
            note = `NOTICE:  index "${n.v}" does not exist, skipping`;
            continue;
          }
          throw new SqlError(`index "${n.v}" does not exist`, n.pos);
        }
        if (ix.kind === 'pkey' || ix.constraint) {
          throw new SqlError(`cannot drop index ${ix.name} because constraint ${ix.name} on table ${ix.table} requires it`, n.pos, `You can drop constraint ${ix.name} on table ${ix.table} instead.`);
        }
        db.indexes.splice(db.indexes.indexOf(ix), 1);
        changed = true;
      }
      return { tag: 'DROP INDEX', note, changed };
    }
    case 'alter_table': {
      const t = needTable(db, st.table, st.tablePos);
      let changed = false;
      for (const a of st.actions) {
        if (a.op === 'add_column') {
          if (t.cols[a.name]) {
            if (a.ifNot) continue;
            throw new SqlError(`column "${a.name}" of relation "${st.table}" already exists`, a.namePos);
          }
          if (!TYPES[a.type]) throw new SqlError(`type "${a.type}" does not exist`, a.typePos);
          t.cols[a.name] = makeColumn({ type: a.type, notNull: a.notNull, def: a.def, stat: { frac: 0.1 } });
          if (a.unique) db.indexes.push({ name: `${st.table}_${a.name}_key`, table: st.table, cols: [a.name], unique: true, kind: 'unique', constraint: true, scans: 0 });
          changed = true;
        } else if (a.op === 'drop_column') {
          if (!t.cols[a.name]) {
            if (a.ifExists) continue;
            throw new SqlError(`column "${a.name}" of relation "${st.table}" does not exist`, a.pos);
          }
          delete t.cols[a.name];
          db.indexes = db.indexes.filter((ix) => !(ix.table === st.table && ix.cols.includes(a.name)));
          changed = true;
        } else if (a.op === 'add_unique') {
          for (const c of a.cols) if (!t.cols[c.v]) throw new SqlError(`column "${c.v}" named in key does not exist`, c.pos);
          if (db.indexes.some((ix) => ix.name === a.name)) throw new SqlError(`relation "${a.name}" already exists`);
          db.indexes.push({ name: a.name, table: st.table, cols: a.cols.map((c) => c.v), unique: true, kind: 'unique', constraint: true, scans: 0 });
          changed = true;
        } else if (a.op === 'drop_constraint') {
          const ix = db.indexes.find((x) => x.table === st.table && x.name === a.name && x.constraint);
          if (!ix) {
            if (a.ifExists) continue;
            throw new SqlError(`constraint "${a.name}" of relation "${st.table}" does not exist`, a.pos);
          }
          db.indexes.splice(db.indexes.indexOf(ix), 1);
          changed = true;
        }
      }
      return { tag: 'ALTER TABLE', changed };
    }
    default:
      throw new Error(`applyDdl: ${st.kind}`);
  }
}

// ---------------------------------------------------------------- psql-style meta output

const padTo = (s, n) => String(s).padEnd(n);

export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => ` ${cells.map((c, i) => padTo(c, widths[i])).join(' | ')}`;
  return [line(headers).trimEnd(), widths.map((w) => '-'.repeat(w + 2)).join('+'), ...rows.map((r) => line(r).trimEnd()), `(${rows.length} row${rows.length === 1 ? '' : 's'})`];
}

export function describeTable(db, name) {
  const t = db.tables[name];
  if (!t) return [`Did not find any relation named "${name}".`];
  const rows = Object.entries(t.cols).map(([c, d]) => [c, d.type, d.notNull ? 'not null' : '', d.def || '']);
  const out = [`Table "public.${name}"`, ...table(['Column', 'Type', 'Nullable', 'Default'], rows).slice(0, -1)];
  const ixs = indexesOf(db, name);
  if (ixs.length) {
    out.push('Indexes:');
    for (const ix of ixs) {
      const kind = ix.kind === 'pkey' ? 'PRIMARY KEY, ' : ix.constraint ? 'UNIQUE CONSTRAINT, ' : ix.unique ? 'UNIQUE, ' : '';
      out.push(`    "${ix.name}" ${kind}btree (${ix.cols.join(', ')})`);
    }
  }
  if (t.fks && t.fks.length) {
    out.push('Foreign-key constraints:');
    for (const fk of t.fks) out.push(`    "${name}_${fk.cols.join('_')}_fkey" FOREIGN KEY (${fk.cols.join(', ')}) REFERENCES ${fk.ref}`);
  }
  return out;
}

export function listTables(db) {
  return table(['Name', 'Type', 'Rows'], Object.entries(db.tables).map(([n, t]) => [n, 'table', fmtInt(t.rows)]));
}

export function listIndexes(db) {
  return table(
    ['Name', 'Table', 'Columns', 'Size'],
    db.indexes.map((ix) => [ix.name, ix.table, ix.cols.join(', '), `${(indexBytes(db.tables[ix.table], ix) / 1048576).toFixed(1)} MB`]),
  );
}

// Catalog views: `SELECT ... FROM pg_stat_user_indexes [WHERE idx_scan = 0]` answers from the catalog.
function statIndexes(db) {
  return {
    headers: ['relname', 'indexrelname', 'idx_scan', 'size'],
    rows: db.indexes.map((ix) => [ix.table, ix.name, ix.scans || 0, `${(indexBytes(db.tables[ix.table], ix) / 1048576).toFixed(1)} MB`]),
  };
}

function statTables(db) {
  return {
    headers: ['relname', 'n_live_tup', 'size'],
    rows: Object.entries(db.tables).map(([n, t]) => [n, t.rows, `${(tableBytes(t) / 1048576).toFixed(1)} MB`]),
  };
}

export const VIEWS = { pg_stat_user_indexes: statIndexes, pg_stat_user_tables: statTables };

// Runs a parsed SELECT against one of the views: column list, equality/range filters, LIMIT.
export function selectFromView(db, ast) {
  const view = VIEWS[ast.from.table](db);
  const names = ast.selectText.trim() === '*' ? view.headers : ast.selectText.split(',').map((x) => x.trim().toLowerCase());
  const at = (name, pos) => {
    const i = view.headers.indexOf(name);
    if (i < 0) throw new SqlError(`column "${name}" does not exist`, pos);
    return i;
  };
  const picks = names.map((n) => at(n, 0));
  let rows = view.rows;
  for (const w of ast.where) {
    const i = at(w.ref.col, w.ref.pos);
    rows = rows.filter((r) => {
      const v = r[i];
      const lit = typeof v === 'number' ? Number(w.val.lit) : String(w.val.lit);
      if (w.op === '=') return v === lit;
      if (w.op === '<>') return v !== lit;
      if (w.op === '<') return v < lit;
      if (w.op === '>') return v > lit;
      if (w.op === '<=') return v <= lit;
      if (w.op === '>=') return v >= lit;
      return true;
    });
  }
  if (ast.limit) rows = rows.slice(0, ast.limit);
  return table(picks.map((i) => view.headers[i]), rows.map((r) => picks.map((i) => (typeof r[i] === 'number' ? fmtInt(r[i]) : r[i]))));
}

export { clone };
