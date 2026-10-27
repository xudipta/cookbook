// The "Index Fund" simulation: a tiny shop database that gets slower as it grows, and a migration
// pipeline that can go wrong. Pure logic, no DOM; the SQL subset and planner live in sql.js.
//
// It models what topics/database/notes/02 and 03 teach and nothing that contradicts them:
//   * a seq scan reads every row, an index jumps to matching rows, and the planner ignores an index
//     whose filter keeps a big share of the table (`status = 'shipped'`);
//   * an index on (a, b) serves a and (a AND b) but not b alone, and can return rows in order so
//     ORDER BY ... LIMIT needs no sort; Postgres does not index a foreign key for you;
//   * every index costs write latency and storage, so unused ones should go (pg_stat_user_indexes);
//   * N+1 queries pay one round trip per row; a JOIN pays one;
//   * migrations are numbered up/down pairs applied in order and tracked per database; a down that
//     does not undo its up, a column dropped while the running app still reads it, and an edited
//     already-applied file are the classic ways to break a deploy.
// The world is data from scenarios.json (catalog, app queries, migration files, schedule).

import * as Q from './sql.js';

export { fmtInt } from './sql.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- small helpers

export function checksum(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function say(w, text, kind = 'out') {
  if (kind === 'err') w.hadError = true;
  for (const line of String(text).split('\n')) w.term.push({ text: line, kind });
  if (w.term.length > 400) w.term.splice(0, w.term.length - 400);
}

function hurt(w, n) {
  w.health = Math.max(0, w.health - n);
}

function weightedPercentile(items, p) {
  if (!items.length) return 0;
  const sorted = [...items].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let cum = 0;
  for (const x of sorted) {
    cum += x.w / total;
    if (cum >= p - 1e-9) return x.v;
  }
  return sorted[sorted.length - 1].v;
}

const shopDb = (w) => w.dbs[w.shop];
const curDb = (w) => w.dbs[w.conn];

// ---------------------------------------------------------------- world

function prepareQuery(q) {
  const out = { visible: !q.launch, kind: 'read', weight: 1, burn: 8, perDay: 1000, ...q };
  if (out.kind !== 'write') {
    const toks = Q.splitStatements(q.sql)[0];
    out.ast = Q.parseStatement(toks.toks, toks.text);
  }
  if (q.each) {
    const e = Q.splitStatements(q.each.sql)[0];
    out.eachAst = Q.parseStatement(e.toks, e.text);
  }
  return out;
}

export function createWorld(sc) {
  const migrations = sc.mode === 'migrations';
  const baseDb = Q.buildCatalog(sc.catalog);
  const w = {
    mode: sc.mode,
    days: 0,
    winTicks: sc.winTicks,
    minHealth: sc.minHealth,
    health: 100,
    targetMs: sc.targetMs,
    writeBudgetMs: sc.writeBudgetMs,
    storageBudgetMb: sc.storageBudgetMb,
    rttMs: sc.rttMs ?? 0.8,
    writeBaseMs: sc.writeBaseMs ?? 0.12,
    writePerIndexMs: sc.writePerIndexMs ?? 0.09,
    dailyGrowth: sc.dailyGrowth || 0,
    shop: 'shop',
    conn: 'shop',
    dbs: { shop: baseDb },
    queries: (sc.queries || []).map(prepareQuery),
    term: [],
    open: [],
    explained: new Set(),
    lastSelect: null,
    shownNote: false,
    healthLabel: sc.healthLabel,
  };
  for (const [name, n] of Object.entries(sc.scans || {})) {
    const ix = baseDb.indexes.find((x) => x.name === name);
    if (ix) ix.scans = n;
  }
  if (migrations) {
    w.shop = 'prod';
    w.conn = 'prod';
    const base = { tables: clone(baseDb.tables), indexes: clone(baseDb.indexes) };
    const prod = { ...clone(base), version: sc.baseline, applied: [] };
    w.baseline = sc.baseline;
    w.base = base;
    w.files = sc.files.map((f) => ({ ...f, committedUp: f.up, committedDown: f.down }));
    for (const f of w.files) if (f.version <= sc.baseline) prod.applied.push({ version: f.version, name: f.name, checksum: checksum(f.up), up: null });
    w.dbs = { prod, staging: clone(prod) };
    delete w.dbs.shop;
    w.apps = clone(sc.apps);
    w.app = sc.app;
    w.releases = clone(sc.releases).map((r) => ({ ...r, status: 'waiting' }));
    w.appBroken = false;
    w.breakCause = null;
  }
  return w;
}

// ---------------------------------------------------------------- metrics

function writeMs(w, q) {
  const db = shopDb(w);
  const t = db.tables[q.table];
  return w.writeBaseMs + w.writePerIndexMs * Q.indexesOf(db, q.table).length + 0.02 * Math.log10(Math.max(10, t.rows));
}

// One app query as the player sees it: plan, latency of one call, and of a whole request.
export function evalQuery(w, q) {
  const db = shopDb(w);
  if (q.kind === 'write') {
    const ms = writeMs(w, q);
    return { ms, requestMs: ms + w.rttMs, plan: null, budget: null, slow: false, summary: `${Q.indexesOf(db, q.table).length} indexes to update`, calls: 1, indexes: [] };
  }
  const plan = Q.planSelect(db, Q.bindSelect(db, q.ast.kind === 'explain' ? q.ast.select : q.ast));
  const ms = Q.planMs(plan);
  let requestMs = ms + w.rttMs;
  let calls = 1;
  let eachPlan = null;
  const indexes = Q.indexesUsed(plan);
  if (q.each) {
    eachPlan = Q.planSelect(db, Q.bindSelect(db, q.eachAst));
    requestMs += q.each.count * (Q.planMs(eachPlan) + w.rttMs);
    calls += q.each.count;
    indexes.push(...Q.indexesUsed(eachPlan));
  }
  const budget = q.budgetMs ?? (q.kind === 'batch' ? Infinity : w.targetMs);
  return { ms, requestMs, plan, eachPlan, budget, slow: requestMs > budget, summary: Q.planSummary(eachPlan || plan), calls, indexes };
}

const visibleQueries = (w) => w.queries.filter((q) => q.visible);

export function metrics(w) {
  const db = shopDb(w);
  const reads = [];
  const writes = [];
  for (const q of visibleQueries(w)) {
    const e = evalQuery(w, q);
    if (q.kind === 'read') reads.push({ v: e.requestMs, w: q.weight });
    if (q.kind === 'write') writes.push({ v: e.ms, w: q.weight });
  }
  const writeAvg = writes.length ? writes.reduce((s, x) => s + x.v * x.w, 0) / writes.reduce((s, x) => s + x.w, 0) : 0;
  return { p95: weightedPercentile(reads, 0.95), writeMs: writeAvg, storageMb: Q.storageMb(db), writeOver: writeAvg > w.writeBudgetMs, storageOver: Q.storageMb(db) > w.storageBudgetMb };
}

export const slowQueries = (w) => visibleQueries(w).filter((q) => q.kind === 'read' && evalQuery(w, q).slow);

// ---------------------------------------------------------------- migrations model

const fileOf = (w, version) => w.files.find((f) => f.version === version);
const appliedIn = (db, version) => db.applied.some((a) => a.version === version);

function statementsOf(sqlText) {
  return Q.splitStatements(sqlText).map((s) => ({ ...s, ast: Q.parseStatement(s.toks, s.text) }));
}

// Runs a migration file's statements against a copy of `db`; the file is all-or-nothing like a
// Postgres transaction. Returns the new catalog, or throws {message, stmt}.
function runFile(db, sqlText) {
  const work = { tables: clone(db.tables), indexes: clone(db.indexes) };
  for (const s of statementsOf(sqlText)) {
    try {
      if (!['create_index', 'drop_index', 'alter_table'].includes(s.ast.kind)) throw new Q.SqlError('this exercise runs CREATE/DROP INDEX and ALTER TABLE in migrations', 0);
      Q.applyDdl(work, s.ast);
    } catch (e) {
      if (e instanceof Q.SqlError) {
        e.stmt = s.text;
        throw e;
      }
      throw e;
    }
  }
  return work;
}

function replaySig(w, db) {
  const sim = clone(w.base);
  for (const a of db.applied) {
    if (!a.up) continue;
    try {
      const out = runFile(sim, a.up);
      sim.tables = out.tables;
      sim.indexes = out.indexes;
    } catch {
      return 'replay-failed';
    }
  }
  return Q.signature(sim);
}

export const drifted = (w, name) => Q.signature(w.dbs[name]) !== replaySig(w, w.dbs[name]);

const modifiedFiles = (w, db) => w.files.filter((f) => db.applied.some((a) => a.version === f.version && a.checksum !== checksum(f.up)));

function missingNeeds(w) {
  const prod = w.dbs.prod;
  return (w.apps[w.app].needs || []).filter((n) => {
    const [t, c] = n.split('.');
    return !(prod.tables[t] && prod.tables[t].cols[c]);
  });
}

// Does this file's down undo its up, starting from `before`?
function roundTrips(file, before) {
  try {
    let s = runFile(before, file.up);
    s = runFile(s, file.down);
    return Q.signature(s) === Q.signature(before);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- events

function openEvent(w, ctx, id, detail, done, extra = {}) {
  const key = extra.key || id;
  if (w.open.some((e) => e.key === key)) return false;
  ctx.fire(id, detail);
  w.open.push({ id, key, done, onDone: extra.onDone });
  return true;
}

// Events that open on their own when something is wrong, and close when it is not.
function conditions(w, ctx) {
  if (w.mode === 'tuning') {
    for (const q of slowQueries(w)) {
      const e = evalQuery(w, q);
      openEvent(w, ctx, q.event, `${q.name}: ${e.requestMs.toFixed(1)} ms, budget ${e.budget} ms`, () => !evalQuery(w, q).slow, { key: `q:${q.id}` });
    }
    const m = metrics(w);
    if (m.writeOver || m.storageOver) {
      const why = m.writeOver ? `write latency ${m.writeMs.toFixed(2)} ms, budget ${w.writeBudgetMs} ms` : `storage ${Math.round(m.storageMb)} MB, budget ${w.storageBudgetMb} MB`;
      openEvent(w, ctx, 'over-indexed', why, () => {
        const now = metrics(w);
        return !now.writeOver && !now.storageOver;
      });
    }
  } else {
    const missing = missingNeeds(w);
    if (missing.length) {
      if (!w.appBroken) {
        w.appBroken = true;
        hurt(w, 12);
        say(w, `shop-app: ERROR: column ${missing[0]} does not exist (v${w.app.slice(1)} is failing requests)`, 'err');
        ctx.log(`Production is returning errors: the running app needs ${missing.join(', ')} (-12 ${w.healthLabel.toLowerCase()}).`, { kind: 'warn' });
      }
      openEvent(w, ctx, w.breakCause === 'deploy' ? 'deploy-before-migrate' : 'drop-in-use', missing.join(', '), () => missingNeeds(w).length === 0, { key: 'app-broken' });
    } else w.appBroken = false;
    if (drifted(w, 'prod')) openEvent(w, ctx, 'schema-drift', 'prod differs from what its migrations produce', () => !drifted(w, 'prod'), { key: 'drift' });
  }
}

export function reconcile(w, ctx) {
  conditions(w, ctx);
  let again = true;
  while (again) {
    again = false;
    for (const e of [...w.open]) {
      if (!e.done(w)) continue;
      w.open = w.open.filter((x) => x !== e);
      ctx.resolve(e.id);
      if (e.onDone) e.onDone(w, ctx);
      again = true;
    }
  }
}

export function afterMove(w, ctx) {
  reconcile(w, ctx);
}

// ---------------------------------------------------------------- SQL prompt

const prompt = (w) => `${w.conn}=#`;

const HELP_TUNING = [
  'SQL, Postgres style. Reading is free; changing the database costs a move.',
  '  EXPLAIN [ANALYZE] SELECT ...        show the plan (ANALYZE adds timings)',
  '  CREATE [UNIQUE] INDEX name ON table (col, ...)',
  '  DROP INDEX name',
  '  ALTER TABLE t ADD CONSTRAINT name UNIQUE (col)',
  '  SELECT * FROM pg_stat_user_indexes [WHERE idx_scan = 0]   index usage',
  '  \\d [table]   \\dt   \\di             describe tables and indexes',
].join('\n');

const HELP_MIGRATIONS = [
  'SQL runs against the connected database; \\c prod or \\c staging switches.',
  '  migrate status | version | validate',
  '  migrate up [N] | migrate down N     apply or reverse migrations here',
  '  migrate create NAME                 add NNNN_NAME.up.sql and .down.sql',
  '  deploy vN                           roll the app out (needs the schema it reads)',
  '  git restore FILE                    undo an uncommitted edit of a migration file',
  '  \\d [table]   \\dt   \\di   ALTER TABLE, CREATE INDEX, ...',
].join('\n');

function execSelect(w, st) {
  const db = curDb(w);
  const ast = st.ast;
  if (!ast.joins.length && Q.VIEWS[ast.from.table]) {
    say(w, Q.selectFromView(db, ast).join('\n'));
    return false;
  }
  const bound = Q.bindSelect(db, ast);
  const plan = Q.planSelect(db, bound);
  w.lastSelect = { text: st.text, ast, bound, plan };
  if (!w.shownNote) {
    say(w, 'Note: this exercise plans and times the query; it does not return the rows themselves.', 'note');
    w.shownNote = true;
  }
  say(w, `(about ${Q.fmtInt(plan.rows)} row${plan.rows === 1 ? '' : 's'})`);
  say(w, `Time: ${Q.planMs(plan).toFixed(3)} ms`);
  return false;
}

const signatureOf = (bound) => `${bound.rels.map((r) => r.table).sort().join('+')}|${bound.conds.map((c) => `${c.table}.${c.col}${c.op}`).sort().join(',')}`;

function execExplain(w, st) {
  const db = curDb(w);
  const bound = Q.bindSelect(db, st.ast.select);
  const plan = Q.planSelect(db, bound);
  w.lastSelect = { text: st.text.replace(/^\s*explain\s+(\([^)]*\)\s*|analy[sz]e\s+)?/i, ''), ast: st.ast.select, bound, plan };
  w.explained.add(signatureOf(bound));
  say(w, Q.explainLines(plan, { analyze: st.ast.analyze, nrel: bound.rels.length }).join('\n'));
  return false;
}

function runStatement(w, ctx, st) {
  const db = curDb(w);
  const ast = st.ast;
  switch (ast.kind) {
    case 'select':
      return execSelect(w, st);
    case 'explain':
      return execExplain(w, st);
    case 'create_index':
    case 'drop_index':
    case 'alter_table': {
      const out = Q.applyDdl(db, ast);
      if (out.note) say(w, out.note);
      say(w, out.tag);
      if (w.mode === 'migrations' && w.conn === 'prod') w.breakCause = 'schema';
      return out.changed;
    }
    case 'analyze':
      say(w, ast.word || 'ANALYZE');
      return false;
    case 'tx':
      say(w, ast.word);
      return false;
    default:
      return false;
  }
}

function runSql(w, ctx, text) {
  let changed = false;
  let stmts;
  try {
    stmts = Q.splitStatements(text);
  } catch (e) {
    say(w, Q.formatError(e, text).join('\n'), 'err');
    return false;
  }
  for (const s of stmts) {
    try {
      s.ast = Q.parseStatement(s.toks, s.text);
      if (runStatement(w, ctx, s)) changed = true;
    } catch (e) {
      if (!(e instanceof Q.SqlError)) throw e;
      say(w, Q.formatError(e, s.text).join('\n'), 'err');
    }
  }
  return changed;
}

function metaCommand(w, text) {
  const [cmd, arg] = text.split(/\s+/);
  const db = curDb(w);
  switch (cmd) {
    case '\\dt':
      say(w, Q.listTables(db).join('\n'));
      return;
    case '\\di':
      say(w, Q.listIndexes(db).join('\n'));
      return;
    case '\\d':
      say(w, (arg ? Q.describeTable(db, arg) : Q.listTables(db)).join('\n'));
      return;
    case '\\c': {
      if (!arg || !w.dbs[arg]) {
        say(w, `connection to database "${arg || ''}" failed: FATAL:  database "${arg || ''}" does not exist${w.mode === 'migrations' ? ' (try prod or staging)' : ''}`, 'err');
        return;
      }
      w.conn = arg;
      say(w, `You are now connected to database "${arg}" as user "app".`);
      return;
    }
    case '\\?':
    case '\\h':
      say(w, w.mode === 'migrations' ? HELP_MIGRATIONS : HELP_TUNING);
      return;
    default:
      say(w, `invalid command ${cmd}. Try \\? for help.`, 'err');
  }
}

// ---------------------------------------------------------------- migrate / deploy / git

function parseFlags(words) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < words.length; i += 1) {
    const x = words[i];
    if (x === '-database' || x === '-path' || x === '-source' || x === '-ext' || x === '-dir') flags[x.slice(1)] = words[++i];
    else if (x === '-seq' || x === '-verbose') flags[x.slice(1)] = true;
    else rest.push(x);
  }
  return { flags, rest };
}

function versionNumber(v) {
  return Number.parseInt(v, 10);
}

function validateApplied(w, db) {
  const bad = modifiedFiles(w, db);
  const missing = db.applied.filter((a) => !fileOf(w, a.version));
  return { bad, missing };
}

function validateLines(w, db) {
  const { bad } = validateApplied(w, db);
  if (!bad.length) return null;
  const f = bad[0];
  const rec = db.applied.find((a) => a.version === f.version);
  return [
    `error: validate failed: migration ${f.version}_${f.name} was changed after it was applied`,
    `  applied checksum : ${rec.checksum}`,
    `  file checksum    : ${checksum(f.up)}`,
    'An applied migration is history: other databases already ran the old text and will never run the new one. Restore the file (git restore), then put the change in a new migration.',
  ];
}

function migrateUp(w, ctx, db, name, count) {
  const bad = validateLines(w, db);
  if (bad) {
    say(w, bad.join('\n'), 'err');
    return false;
  }
  const pending = w.files.filter((f) => !appliedIn(db, f.version)).sort((a, b) => a.version.localeCompare(b.version));
  if (!pending.length) {
    say(w, 'no change');
    return false;
  }
  let changed = false;
  for (const f of pending.slice(0, count || pending.length)) {
    try {
      const before = Q.signature(db);
      const beforeCat = { tables: clone(db.tables), indexes: clone(db.indexes) };
      const out = runFile(db, f.up);
      db.tables = out.tables;
      db.indexes = out.indexes;
      db.applied.push({ version: f.version, name: f.name, checksum: checksum(f.up), up: f.up, beforeSig: before, before: beforeCat });
      db.version = f.version;
      say(w, `${versionNumber(f.version)}/u ${f.name} (${(4 + (checksum(f.up).charCodeAt(0) % 9) + 0.3).toFixed(1)}ms)`);
      changed = true;
      if (name === 'prod') w.breakCause = 'schema';
    } catch (e) {
      if (!(e instanceof Q.SqlError)) throw e;
      say(w, `error: migration failed: ${e.message} in line 0: ${e.stmt || ''} (details: ${f.version}_${f.name}.up.sql)`, 'err');
      say(w, 'The file ran in one transaction, so nothing from it was applied.', 'note');
      break;
    }
  }
  return changed;
}

function migrateDown(w, ctx, db, name, count) {
  if (!count) {
    say(w, 'error: down needs a count: migrate down 1 reverses only the latest migration', 'err');
    return false;
  }
  let changed = false;
  for (let i = 0; i < count; i += 1) {
    const rec = db.applied[db.applied.length - 1];
    if (!rec || rec.version <= w.baseline) {
      say(w, `error: this exercise keeps ${w.files[0].version}-${w.baseline} in place; there is nothing newer to reverse`, 'err');
      break;
    }
    const f = fileOf(w, rec.version);
    if (!f) {
      say(w, `error: no migration file for applied version ${rec.version}`, 'err');
      break;
    }
    try {
      const out = runFile(db, f.down);
      db.tables = out.tables;
      db.indexes = out.indexes;
      db.applied.pop();
      const last = db.applied[db.applied.length - 1];
      db.version = last ? last.version : null;
      say(w, `${versionNumber(f.version)}/d ${f.name} (${(3 + (checksum(f.down).charCodeAt(0) % 7) + 0.4).toFixed(1)}ms)`);
      changed = true;
      if (name === 'prod') w.breakCause = 'schema';
      if (/drop\s+(column|table)/i.test(rec.up || '')) say(w, 'NOTICE: the down put the structure back, but the dropped data is gone. A down restores shape, not rows.', 'note');
      if (Q.signature(db) !== rec.beforeSig) {
        const version = f.version;
        const before = rec.before;
        openEvent(
          w,
          ctx,
          'broken-down',
          `${f.version}_${f.name}.down.sql left the schema different from before the up`,
          () => !fileOf(w, version) || (roundTrips(fileOf(w, version), before) && !drifted(w, name)),
          { key: `down:${version}:${name}` },
        );
      }
    } catch (e) {
      if (!(e instanceof Q.SqlError)) throw e;
      say(w, `error: migration failed: ${e.message} in line 0: ${e.stmt || ''} (details: ${f.version}_${f.name}.down.sql)`, 'err');
      break;
    }
  }
  return changed;
}

function migrateStatus(w, db) {
  const rows = w.files.map((f) => {
    const rec = db.applied.find((a) => a.version === f.version);
    const state = !rec ? 'pending' : rec.checksum !== checksum(f.up) ? 'applied, FILE CHANGED' : 'applied';
    return [f.version, f.name, state];
  });
  say(w, Q.table(['version', 'name', 'status'], rows).join('\n'));
}

function nextVersion(w) {
  const max = Math.max(...w.files.map((f) => versionNumber(f.version)));
  return String(max + 1).padStart(4, '0');
}

function migrateCommand(w, ctx, words) {
  const { flags, rest } = parseFlags(words);
  const [verb, ...args] = rest;
  const name = flags.database || w.conn;
  const db = w.dbs[name];
  if (!db) {
    say(w, `error: cannot reach database "${flags.database}" (try prod or staging)`, 'err');
    return false;
  }
  switch (verb) {
    case 'up':
      return migrateUp(w, ctx, db, name, args[0] ? Number(args[0]) : 0);
    case 'down':
      return migrateDown(w, ctx, db, name, args[0] ? Number(args[0]) : 0);
    case 'version':
      say(w, db.version ? String(versionNumber(db.version)) : 'no migration');
      return false;
    case 'status':
      migrateStatus(w, db);
      return false;
    case 'validate': {
      const bad = validateLines(w, db);
      say(w, bad ? bad.join('\n') : 'Successfully validated: every applied migration matches its file', bad ? 'err' : 'out');
      return false;
    }
    case 'create': {
      const nm = args.filter((a) => !a.startsWith('-')).pop();
      if (!nm || !/^[a-z0-9_]+$/.test(nm)) {
        say(w, 'error: usage: migrate create [-ext sql] [-seq] NAME   (lower_snake_case)', 'err');
        return false;
      }
      const version = nextVersion(w);
      w.files.push({ version, name: nm, up: `-- ${nm}: up\n`, down: `-- ${nm}: down\n`, committedUp: null, committedDown: null, created: true });
      say(w, `db/migrations/${version}_${nm}.up.sql\ndb/migrations/${version}_${nm}.down.sql`);
      return true;
    }
    default:
      say(w, 'usage: migrate [-database prod|staging] up [N] | down N | version | status | validate | create NAME', 'err');
      return false;
  }
}

function deployCommand(w, ctx, words) {
  const want = words[0];
  const info = w.apps[want];
  if (!info || !info.available) {
    const list = Object.keys(w.apps).filter((v) => w.apps[v].available).join(', ');
    say(w, `error: no image shop-app:${want || ''} (available: ${list})`, 'err');
    return false;
  }
  if (w.app === want) {
    say(w, `deployment "shop-app" is already running ${want}`);
    return false;
  }
  w.app = want;
  w.breakCause = 'deploy';
  say(w, `deployment "shop-app" rolled out ${want}`);
  const missing = missingNeeds(w);
  if (missing.length) say(w, `shop-app ${want}: starting... failing readiness: column ${missing[0]} does not exist`, 'err');
  else say(w, `shop-app ${want}: ready, 3/3 pods healthy`);
  return true;
}

function gitCommand(w, words) {
  if (words[0] !== 'restore' || !words[1]) {
    say(w, 'usage: git restore FILE   (file names look like 0003_create_orders.up.sql)', 'err');
    return false;
  }
  const m = /^(?:.*\/)?(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/.exec(words[1]);
  const f = m && w.files.find((x) => x.version === m[1] && x.name === m[2]);
  if (!f) {
    say(w, `error: pathspec '${words[1]}' did not match any file`, 'err');
    return false;
  }
  const key = m[3] === 'up' ? 'up' : 'down';
  const committed = key === 'up' ? f.committedUp : f.committedDown;
  if (committed === null || f[key] === committed) {
    say(w, 'nothing to restore: the file matches the last commit');
    return false;
  }
  f[key] = committed;
  say(w, `Updated 1 path from the index: ${words[1]}`);
  return true;
}

// ---------------------------------------------------------------- commands

function dispatch(w, ctx, text) {
  const words = text.split(/\s+/);
  const head = words[0].toLowerCase();
  if (text.startsWith('\\')) {
    metaCommand(w, text);
    return false;
  }
  if (w.mode === 'migrations') {
    if (head === 'migrate') return migrateCommand(w, ctx, words.slice(1));
    if (head === 'deploy') return deployCommand(w, ctx, words.slice(1));
    if (head === 'git') return gitCommand(w, words.slice(1));
  }
  if (head === 'help' || head === '?') {
    say(w, w.mode === 'migrations' ? HELP_MIGRATIONS : HELP_TUNING);
    return false;
  }
  return runSql(w, ctx, text);
}

// Runs one line from the prompt. Returns true (a scored move that changed something), 'free' (valid
// but read-only) or false (the command failed).
export function runLine(w, ctx, line) {
  const text = String(line || '').trim();
  if (!text) return false;
  say(w, `${prompt(w)} ${text}`, 'cmd');
  w.hadError = false;
  const changed = dispatch(w, ctx, text);
  if (changed) return true;
  return w.hadError ? false : 'free';
}

// Saving a migration file in the editor.
export function saveFile(w, name, kind, text) {
  const f = fileOf(w, name);
  if (!f || !['up', 'down'].includes(kind) || typeof text !== 'string' || f[kind] === text) return false;
  f[kind] = text;
  return true;
}

// Deploys the player's last SELECT as the app's query (the N+1 fix).
export function swapQuery(w, ctx, id) {
  const q = w.queries.find((x) => x.id === id);
  if (!q || !q.swap || !q.each) return false;
  const last = w.lastSelect;
  if (!last) {
    say(w, 'Nothing to deploy yet: run the SELECT you want the app to use first.', 'err');
    return false;
  }
  const tables = new Set(last.bound.rels.map((r) => r.table));
  const hasJoin = last.bound.edges.some((e) => q.swap.joins.some(([a, b]) => (`${e.a.table}.${e.a.col}` === a && `${e.b.table}.${e.b.col}` === b) || (`${e.a.table}.${e.a.col}` === b && `${e.b.table}.${e.b.col}` === a)));
  const filters = last.bound.conds.some((c) => `${c.table}.${c.col}` === q.swap.filter && c.op === '=');
  if (q.swap.tables.some((t) => !tables.has(t)) || !hasJoin || !filters) {
    say(w, `That statement does not replace the loop: it must join ${q.swap.tables.join(' and ')} (${q.swap.joins.map((j) => j.join(' = ')).join(', ')}) and filter on ${q.swap.filter}.`, 'err');
    return false;
  }
  q.ast = last.ast;
  q.sql = last.text;
  q.each = null;
  q.eachAst = null;
  say(w, `Deployed: ${q.name} now runs your statement once per request instead of looping.`, 'note');
  return true;
}

// ---------------------------------------------------------------- the day clock

function applyGrowth(w, g) {
  const db = shopDb(w);
  const names = g.table === '*' ? Object.keys(db.tables) : [g.table];
  for (const n of names) db.tables[n].rows = Math.round(db.tables[n].rows * g.factor);
}

function resetStaging(w) {
  const copy = clone(w.dbs.prod);
  w.dbs.staging = copy;
}

function announceRelease(w, ctx, id) {
  const r = w.releases.find((x) => x.id === id);
  if (!r || r.status !== 'waiting') return;
  r.status = 'open';
  for (const f of r.addFiles || []) w.files.push({ ...f, committedUp: f.up, committedDown: f.down });
  for (const v of r.apps || []) w.apps[v].available = true;
  const done = () => releaseDone(w, r);
  openEvent(w, ctx, r.event, r.detail, done, { key: `release:${r.id}` });
}

function releaseDone(w, r) {
  if (r.status === 'cancelled') return true;
  const prod = w.dbs.prod;
  if (r.version && !appliedIn(prod, r.version)) return false;
  if (r.column) {
    const [t, c] = r.column.split('.');
    if (!prod.tables[t].cols[c]) return false;
  }
  if (r.clean && (modifiedFiles(w, prod).length || drifted(w, 'prod'))) return false;
  return rank(w, w.app) >= rank(w, r.app);
}

const rank = (w, v) => Object.keys(w.apps).indexOf(v);

function badDeploy(w, ctx, item) {
  const r2 = w.releases.find((r) => r.id === 'r2');
  const prod = w.dbs.prod;
  const shipped = appliedIn(prod, r2.version) || w.app === r2.app;
  const pull = () => {
    r2.status = 'cancelled';
    w.apps[r2.app].available = false;
    w.files = w.files.filter((f) => f.version !== r2.version);
    ctx.log(`The team reverts the release 2 commit: ${r2.version} and app ${r2.app} are gone from main.`, { kind: 'good' });
  };
  if (!shipped) {
    ctx.fire('bad-deploy', 'caught before it shipped');
    pull();
    ctx.resolve('bad-deploy');
    return;
  }
  openEvent(w, ctx, 'bad-deploy', item.detail, () => w.app !== r2.app && !appliedIn(w.dbs.prod, r2.version) && !drifted(w, 'prod'), {
    onDone: pull,
  });
}

function editApplied(w, ctx, item) {
  const f = fileOf(w, item.version);
  if (f) f.up = f.up.replace(item.find, item.replace);
}

function burn(w, ctx) {
  const lines = [];
  if (w.mode === 'tuning') {
    for (const q of slowQueries(w)) {
      const e = evalQuery(w, q);
      lines.push([q.burn, `${q.name} took ${e.requestMs.toFixed(1)} ms (budget ${e.budget} ms)`]);
    }
    const m = metrics(w);
    if (m.writeOver) lines.push([6, `write latency ${m.writeMs.toFixed(2)} ms is over the ${w.writeBudgetMs} ms budget`]);
    if (m.storageOver) lines.push([5, `storage ${Math.round(m.storageMb)} MB is over the ${w.storageBudgetMb} MB budget`]);
  } else {
    if (missingNeeds(w).length) lines.push([15, `production errored all day: the app needs ${missingNeeds(w).join(', ')}`]);
    if (drifted(w, 'prod')) lines.push([5, 'production schema no longer matches its migrations']);
    for (const r of w.releases) if (r.status === 'open' && !releaseDone(w, r)) lines.push([3, `release "${r.title}" is still waiting to ship`]);
  }
  for (const [n, why] of lines) {
    hurt(w, n);
    ctx.log(`Overnight: ${why} (-${n} ${w.healthLabel.toLowerCase()}).`, { kind: 'warn' });
  }
}

export function tick(w, ctx) {
  const sc = ctx.scenario;
  w.days += 1;
  burn(w, ctx);
  if (w.mode === 'tuning') {
    for (const q of visibleQueries(w)) {
      const e = evalQuery(w, q);
      for (const name of new Set(e.indexes)) {
        const ix = shopDb(w).indexes.find((x) => x.name === name);
        if (ix) ix.scans = (ix.scans || 0) + q.perDay;
      }
    }
    if (w.dailyGrowth) applyGrowth(w, { table: '*', factor: 1 + w.dailyGrowth });
  }
  for (const item of sc.schedule || []) {
    if (item.tick !== w.days) continue;
    switch (item.kind) {
      case 'grow':
        applyGrowth(w, item);
        ctx.fire(item.event, item.detail);
        ctx.resolve(item.event);
        break;
      case 'launch': {
        const q = w.queries.find((x) => x.id === item.query);
        q.visible = true;
        ctx.fire(item.event, item.detail);
        ctx.resolve(item.event);
        break;
      }
      case 'decoy': {
        const q = w.queries.find((x) => x.id === item.query);
        q.visible = true;
        const sig = q.signature;
        openEvent(w, ctx, item.event, q.name, () => w.explained.has(sig) && !shopDb(w).indexes.some((ix) => ix.table === 'orders' && ix.cols[0] === 'status'), { key: `decoy:${q.id}` });
        break;
      }
      case 'release':
        announceRelease(w, ctx, item.release);
        break;
      case 'bad-deploy':
        badDeploy(w, ctx, item);
        break;
      case 'edit-applied':
        editApplied(w, ctx, item);
        announceRelease(w, ctx, item.release);
        break;
      default:
        throw new Error(`database sim: no handler for schedule item kind "${item.kind}"`);
    }
  }
  if (w.mode === 'migrations') resetStaging(w);
  reconcile(w, ctx);
}

export function start(w, ctx) {
  for (const q of w.queries) {
    if (q.decoy) {
      const t = Q.splitStatements(q.sql)[0];
      const ast = Q.parseStatement(t.toks, t.text);
      q.signature = signatureOf(Q.bindSelect(shopDb(w), ast));
    }
  }
  for (const id of ctx.scenario.intro || []) announceRelease(w, ctx, id);
  reconcile(w, ctx);
}

function allClear(w) {
  if (w.mode === 'tuning') {
    const m = metrics(w);
    return slowQueries(w).length === 0 && !m.writeOver && !m.storageOver;
  }
  return !w.appBroken && !drifted(w, 'prod') && w.releases.every((r) => r.status === 'waiting' ? false : releaseDone(w, r));
}

export const isWon = (w) => w.days >= w.winTicks && w.health >= w.minHealth && !w.open.length && allClear(w);
export const isLost = (w) => w.health < w.minHealth;

// ---------------------------------------------------------------- views for the UI

export function describeApp(w) {
  return { version: w.app, needs: w.apps[w.app].needs, note: w.apps[w.app].note, missing: missingNeeds(w) };
}

export function releaseList(w) {
  return w.releases
    .filter((r) => r.status !== 'waiting')
    .map((r) => ({ id: r.id, title: r.title, state: r.status === 'cancelled' ? 'pulled' : releaseDone(w, r) ? 'shipped' : 'waiting to ship' }));
}

export function migrationRows(w) {
  return w.files.map((f) => {
    const mark = (db) => {
      const rec = db.applied.find((a) => a.version === f.version);
      return !rec ? 'pending' : rec.checksum !== checksum(f.up) ? 'changed' : 'applied';
    };
    return { version: f.version, name: f.name, staging: mark(w.dbs.staging), prod: mark(w.dbs.prod), dirty: f.committedUp !== null && (f.up !== f.committedUp || f.down !== f.committedDown) };
  });
}

export function schemaLines(w) {
  const db = curDb(w);
  return Object.keys(db.tables).flatMap((t) => [...Q.describeTable(db, t), '']);
}
