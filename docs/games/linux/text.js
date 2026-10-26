// The text tools of "Night Shift": grep-style regexes, a sed subset and a small awk. Pure functions over
// arrays of lines, no DOM and no filesystem. They follow GNU behaviour for the forms the notes use
// (topics/linux/notes/02-text-processing.md): sed 's///g', -n 'N,Mp', '/re/d', 'Ni text'; awk '{print $1}',
// -F:, 'cond {print}', '{sum += $2} END {print sum}'.

const POSIX = { digit: '0-9', alpha: 'A-Za-z', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f' };

// Convert a grep/sed pattern (POSIX basic or extended) to a JS RegExp. Throws Error with a grep-like message.
export function toRegex(pat, { ere = false, fixed = false, i = false, g = false } = {}) {
  let src = '';
  if (fixed) src = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  else {
    const special = '|+?(){}';
    for (let k = 0; k < pat.length; k++) {
      const c = pat[k];
      if (c === '\\' && k + 1 < pat.length) {
        const d = pat[++k];
        if (!ere && special.includes(d)) src += d;
        else if (d === '<' || d === '>') src += '\\b';
        else src += `\\${d}`;
      } else if (!ere && special.includes(c)) src += `\\${c}`;
      else if (c === '[') {
        let j = k + 1;
        if (pat[j] === '^') j += 1;
        if (pat[j] === ']') j += 1;
        while (j < pat.length && pat[j] !== ']') {
          if (pat[j] === '[' && pat[j + 1] === ':') j = pat.indexOf(':]', j) + 1 || pat.length;
          j += 1;
        }
        if (j >= pat.length) throw new Error('Unmatched [, [^, [:, [., or [=');
        const body = pat.slice(k + 1, j).replace(/\[:(\w+):\]/g, (_, name) => POSIX[name] ?? '').replace(/\\/g, '\\\\');
        src += `[${body}]`;
        k = j;
      } else src += c;
    }
  }
  try {
    return new RegExp(src, (i ? 'i' : '') + (g ? 'g' : ''));
  } catch {
    throw new Error('Invalid regular expression');
  }
}

// ---------------------------------------------------------------- sed

function parseAddress(s, at, ere) {
  let k = at;
  if (/\d/.test(s[k] || '')) {
    let n = '';
    while (/\d/.test(s[k] || '')) n += s[k++];
    return { addr: { line: Number(n) }, at: k };
  }
  if (s[k] === '$') return { addr: { last: true }, at: k + 1 };
  if (s[k] === '/') {
    let re = '';
    k += 1;
    while (k < s.length && s[k] !== '/') {
      if (s[k] === '\\' && s[k + 1] === '/') {
        re += '/';
        k += 2;
      } else re += s[k++];
    }
    if (k >= s.length) throw new Error('unterminated address regex');
    return { addr: { re: toRegex(re, { ere }) }, at: k + 1 };
  }
  return { addr: null, at };
}

function readDelimited(s, at, delim) {
  let out = '';
  let k = at;
  while (k < s.length && s[k] !== delim) {
    if (s[k] === '\\' && k + 1 < s.length) {
      out += s[k + 1] === delim ? delim : `\\${s[k + 1]}`;
      k += 2;
    } else out += s[k++];
  }
  if (k >= s.length) throw new Error('unterminated `s\' command');
  return { text: out, at: k + 1 };
}

export function parseSed(script, ere = false) {
  const cmds = [];
  let k = 0;
  while (k < script.length) {
    while (k < script.length && /[\s;]/.test(script[k])) k += 1;
    if (k >= script.length) break;
    const first = parseAddress(script, k, ere);
    k = first.at;
    const cmd = { a1: first.addr, a2: null, neg: false };
    if (first.addr && script[k] === ',') {
      const second = parseAddress(script, k + 1, ere);
      if (!second.addr) throw new Error('unexpected `,\'');
      cmd.a2 = second.addr;
      k = second.at;
    }
    while (script[k] === ' ') k += 1;
    if (script[k] === '!') {
      cmd.neg = true;
      k += 1;
    }
    const c = script[k++];
    if (!c) throw new Error('missing command');
    cmd.c = c;
    if (c === 's') {
      const delim = script[k++];
      const re = readDelimited(script, k, delim);
      const rep = readDelimited(script, re.at, delim);
      k = rep.at;
      let flags = '';
      while (k < script.length && /[gpiI0-9]/.test(script[k])) flags += script[k++];
      cmd.re = toRegex(re.text, { ere, i: /[iI]/.test(flags), g: true });
      cmd.rep = rep.text;
      cmd.global = flags.includes('g');
      cmd.print = flags.includes('p');
      const nth = /\d+/.exec(flags);
      cmd.nth = nth ? Number(nth[0]) : 0;
    } else if (c === 'i' || c === 'a' || c === 'c') {
      let text = script.slice(k).replace(/^\\?\n?\s*/, '');
      const nl = text.indexOf('\n');
      if (nl >= 0) {
        k += script.slice(k).indexOf('\n') + 1;
        text = text.slice(0, nl);
      } else k = script.length;
      cmd.text = text;
    } else if (!'pdq='.includes(c)) throw new Error(`unknown command: \`${c}'`);
    cmds.push(cmd);
  }
  return cmds;
}

function expandReplacement(rep, m) {
  let out = '';
  for (let k = 0; k < rep.length; k++) {
    const c = rep[k];
    if (c === '\\' && k + 1 < rep.length) {
      const d = rep[++k];
      if (/\d/.test(d)) out += m[Number(d)] ?? '';
      else if (d === 'n') out += '\n';
      else if (d === 't') out += '\t';
      else out += d;
    } else if (c === '&') out += m[0];
    else out += c;
  }
  return out;
}

function substitute(cmd, line) {
  let count = 0;
  let changed = false;
  const out = line.replace(cmd.re, (...args) => {
    const groupsEnd = args.findIndex((a) => typeof a === 'number');
    const m = args.slice(0, groupsEnd);
    count += 1;
    const take = cmd.nth ? (cmd.global ? count >= cmd.nth : count === cmd.nth) : cmd.global || count === 1;
    if (!take) return m[0];
    changed = true;
    return expandReplacement(cmd.rep, m);
  });
  return { out, changed };
}

// Run sed commands over lines. Returns the output lines.
export function sedRun(cmds, lines, { quiet = false } = {}) {
  const out = [];
  const active = new Map();
  const matches = (addr, line, no) => (addr.line !== undefined ? no === addr.line : addr.last ? no === lines.length : addr.re.test(line));
  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx];
    const no = idx + 1;
    let del = false;
    let quit = false;
    const after = [];
    for (let ci = 0; ci < cmds.length && !del; ci++) {
      const cmd = cmds[ci];
      let hit;
      if (!cmd.a1) hit = true;
      else if (!cmd.a2) hit = matches(cmd.a1, line, no);
      else if (active.get(ci)) {
        hit = true;
        if (matches(cmd.a2, line, no) || (cmd.a2.line !== undefined && no >= cmd.a2.line)) active.set(ci, false);
      } else if (matches(cmd.a1, line, no)) {
        hit = true;
        if (!(cmd.a2.line !== undefined && cmd.a2.line <= no)) active.set(ci, true);
      } else hit = false;
      if (cmd.neg) hit = !hit;
      if (!hit) continue;
      switch (cmd.c) {
        case 'p':
          out.push(line);
          break;
        case 'd':
          del = true;
          break;
        case 's': {
          const r = substitute(cmd, line);
          if (r.changed) {
            line = r.out;
            if (cmd.print) out.push(line);
          }
          break;
        }
        case 'i':
          out.push(cmd.text);
          break;
        case 'a':
          after.push(cmd.text);
          break;
        case 'c':
          out.push(cmd.text);
          del = true;
          break;
        case 'q':
          quit = true;
          break;
        case '=':
          out.push(String(no));
          break;
        default:
      }
    }
    if (!del && !quiet) out.push(line);
    out.push(...after);
    if (quit) break;
  }
  return out;
}

// ---------------------------------------------------------------- awk

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6))));
const num = (v) => {
  if (typeof v === 'number') return v;
  const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(String(v));
  return m ? Number(m[0]) : 0;
};
const str = (v) => (typeof v === 'number' ? fmtNum(v) : String(v ?? ''));
const truthy = (v) => (typeof v === 'number' ? v !== 0 : v !== '');
const isNumLike = (v) => typeof v === 'number' || /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(String(v));

function lexAwk(src) {
  const toks = [];
  let k = 0;
  while (k < src.length) {
    const c = src[k];
    if (/\s/.test(c)) {
      k += 1;
      continue;
    }
    let m;
    if ((m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(k)))) {
      toks.push({ t: 'num', v: Number(m[0]) });
      k += m[0].length;
    } else if (c === '"') {
      let s = '';
      k += 1;
      while (k < src.length && src[k] !== '"') {
        if (src[k] === '\\' && k + 1 < src.length) {
          const d = src[++k];
          s += d === 'n' ? '\n' : d === 't' ? '\t' : d;
          k += 1;
        } else s += src[k++];
      }
      if (k >= src.length) throw new Error('non-terminated string');
      k += 1;
      toks.push({ t: 'str', v: s });
    } else if (c === '/' && !(toks.length && ['num', 'id', 'field', ')', ']'].includes(toks[toks.length - 1].t))) {
      let s = '';
      k += 1;
      while (k < src.length && src[k] !== '/') {
        if (src[k] === '\\' && src[k + 1] === '/') {
          s += '/';
          k += 2;
        } else s += src[k++];
      }
      if (k >= src.length) throw new Error('non-terminated regular expression');
      k += 1;
      toks.push({ t: 're', v: s });
    } else if ((m = /^\$/.exec(src.slice(k)))) {
      toks.push({ t: 'field' });
      k += 1;
    } else if ((m = /^[A-Za-z_]\w*/.exec(src.slice(k)))) {
      toks.push({ t: 'id', v: m[0] });
      k += m[0].length;
    } else if ((m = /^(\+\+|--|\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||!~)/.exec(src.slice(k)))) {
      toks.push({ t: m[0] });
      k += m[0].length;
    } else {
      toks.push({ t: c });
      k += 1;
    }
  }
  return toks;
}

class AwkParser {
  constructor(toks) {
    this.toks = toks;
    this.k = 0;
  }

  peek() {
    return this.toks[this.k];
  }

  next() {
    return this.toks[this.k++];
  }

  eat(t) {
    if (this.peek()?.t === t) return this.next();
    return null;
  }

  expect(t) {
    if (!this.eat(t)) throw new Error(`syntax error: expected ${t}`);
  }

  expr() {
    return this.assign();
  }

  assign() {
    const left = this.or();
    const t = this.peek()?.t;
    if (['=', '+=', '-=', '*=', '/='].includes(t) && ['var', 'index', 'field'].includes(left.k)) {
      this.next();
      return { k: 'assign', op: t, left, right: this.assign() };
    }
    return left;
  }

  or() {
    let l = this.and();
    while (this.eat('||')) l = { k: 'or', l, r: this.and() };
    return l;
  }

  and() {
    let l = this.match();
    while (this.eat('&&')) l = { k: 'and', l, r: this.match() };
    return l;
  }

  match() {
    let l = this.cmp();
    for (;;) {
      if (this.eat('~')) l = { k: 'match', l, r: this.cmp(), neg: false };
      else if (this.eat('!~')) l = { k: 'match', l, r: this.cmp(), neg: true };
      else return l;
    }
  }

  cmp() {
    const l = this.add();
    const t = this.peek()?.t;
    if (['==', '!=', '<', '>', '<=', '>='].includes(t)) {
      this.next();
      return { k: 'cmp', op: t, l, r: this.add() };
    }
    return l;
  }

  add() {
    let l = this.mul();
    for (;;) {
      const t = this.peek()?.t;
      if (t === '+' || t === '-') {
        this.next();
        l = { k: 'bin', op: t, l, r: this.mul() };
      } else return l;
    }
  }

  mul() {
    let l = this.unary();
    for (;;) {
      const t = this.peek()?.t;
      if (t === '*' || t === '/' || t === '%') {
        this.next();
        l = { k: 'bin', op: t, l, r: this.unary() };
      } else return l;
    }
  }

  unary() {
    if (this.eat('!')) return { k: 'not', e: this.unary() };
    if (this.eat('-')) return { k: 'neg', e: this.unary() };
    return this.postfix();
  }

  postfix() {
    const e = this.primary();
    if (['var', 'index', 'field'].includes(e.k)) {
      if (this.eat('++')) return { k: 'incr', e, by: 1 };
      if (this.eat('--')) return { k: 'incr', e, by: -1 };
    }
    return e;
  }

  primary() {
    const t = this.next();
    if (!t) throw new Error('syntax error: unexpected end of program');
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 're') return { k: 're', v: new RegExp(t.v) };
    if (t.t === 'field') {
      if (this.peek()?.t === '(') {
        this.next();
        const e = this.expr();
        this.expect(')');
        return { k: 'field', e };
      }
      return { k: 'field', e: this.primary() };
    }
    if (t.t === '(') {
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (t.t === 'id') {
      if (this.peek()?.t === '[') {
        this.next();
        const key = this.expr();
        this.expect(']');
        return { k: 'index', name: t.v, key };
      }
      return { k: 'var', name: t.v };
    }
    throw new Error(`syntax error at ${t.t}`);
  }

  // Statements inside { ... }.
  block() {
    const stmts = [];
    while (this.peek() && this.peek().t !== '}') {
      if (this.eat(';')) continue;
      stmts.push(this.stmt());
    }
    return stmts;
  }

  stmt() {
    const t = this.peek();
    if (t.t === 'id' && t.v === 'print') {
      this.next();
      const args = [];
      if (this.peek() && ![';', '}'].includes(this.peek().t)) {
        args.push(this.expr());
        while (this.eat(',')) args.push(this.expr());
      }
      return { k: 'print', args };
    }
    if (t.t === 'id' && t.v === 'for') {
      this.next();
      this.expect('(');
      const v = this.next();
      const inTok = this.next();
      if (inTok?.v !== 'in') throw new Error('syntax error: only for (k in array) is supported');
      const arr = this.next();
      this.expect(')');
      return { k: 'forin', v: v.v, arr: arr.v, body: this.stmt() };
    }
    if (t.t === 'id' && t.v === 'if') {
      this.next();
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      return { k: 'if', cond, then: this.stmt() };
    }
    if (t.t === '{') {
      this.next();
      const body = this.block();
      this.expect('}');
      return { k: 'seq', body };
    }
    return { k: 'expr', e: this.expr() };
  }
}

export function parseAwk(src) {
  const toks = lexAwk(src);
  const p = new AwkParser(toks);
  const rules = [];
  while (p.peek()) {
    if (p.eat(';')) continue;
    const rule = { kind: 'main', pat: null, body: null };
    const t = p.peek();
    if (t.t === 'id' && (t.v === 'BEGIN' || t.v === 'END')) {
      p.next();
      rule.kind = t.v.toLowerCase();
    } else if (t.t !== '{') rule.pat = p.expr();
    if (p.eat('{')) {
      rule.body = p.block();
      p.expect('}');
    } else if (rule.kind !== 'main') throw new Error(`syntax error: ${rule.kind.toUpperCase()} needs an action`);
    rules.push(rule);
  }
  return rules;
}

export function awkRun(rules, lines, { fs = null } = {}) {
  const vars = { NR: 0, NF: 0 };
  const arrays = {};
  const out = [];
  let rec = [];
  const split = (line) => {
    if (fs === null || fs === ' ') return line.trim() === '' ? [] : line.trim().split(/\s+/);
    return fs.length === 1 ? line.split(fs) : line.split(new RegExp(fs));
  };
  const field = (n) => (n === 0 ? rec.line : rec[n - 1] ?? '');
  const lookup = (k) => (arrays[k.name] ||= {});
  const ev = (n) => {
    switch (n.k) {
      case 'lit':
        return n.v;
      case 're':
        return n.v.test(rec.line ?? '') ? 1 : 0;
      case 'var':
        return n.name in vars ? vars[n.name] : '';
      case 'field':
        return field(Math.trunc(num(ev(n.e))));
      case 'index':
        return lookup(n)[str(ev(n.key))] ?? '';
      case 'assign': {
        const r = ev(n.right);
        const cur = n.op === '=' ? 0 : num(ev(n.left));
        const val = n.op === '=' ? r : n.op === '+=' ? cur + num(r) : n.op === '-=' ? cur - num(r) : n.op === '*=' ? cur * num(r) : cur / num(r);
        store(n.left, val);
        return val;
      }
      case 'incr': {
        const cur = num(ev(n.e));
        store(n.e, cur + n.by);
        return cur;
      }
      case 'bin': {
        const a = num(ev(n.l));
        const b = num(ev(n.r));
        return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a % b;
      }
      case 'neg':
        return -num(ev(n.e));
      case 'not':
        return truthy(ev(n.e)) ? 0 : 1;
      case 'and':
        return truthy(ev(n.l)) && truthy(ev(n.r)) ? 1 : 0;
      case 'or':
        return truthy(ev(n.l)) || truthy(ev(n.r)) ? 1 : 0;
      case 'match': {
        const re = n.r.k === 're' ? n.r.v : new RegExp(str(ev(n.r)));
        const hit = re.test(str(ev(n.l)));
        return hit !== n.neg ? 1 : 0;
      }
      case 'cmp': {
        const a = ev(n.l);
        const b = ev(n.r);
        const numeric = isNumLike(a) && isNumLike(b);
        const x = numeric ? num(a) : str(a);
        const y = numeric ? num(b) : str(b);
        const r = n.op === '==' ? x === y : n.op === '!=' ? x !== y : n.op === '<' ? x < y : n.op === '>' ? x > y : n.op === '<=' ? x <= y : x >= y;
        return r ? 1 : 0;
      }
      default:
        throw new Error('unsupported expression');
    }
  };
  const store = (target, val) => {
    if (target.k === 'var') vars[target.name] = val;
    else if (target.k === 'index') lookup(target)[str(ev(target.key))] = val;
    else if (target.k === 'field') {
      const i = Math.trunc(num(ev(target.e)));
      if (i === 0) {
        rec.line = str(val);
        rec.splice(0, rec.length, ...split(rec.line));
      } else {
        while (rec.length < i) rec.push('');
        rec[i - 1] = str(val);
        rec.line = rec.join(' ');
        vars.NF = rec.length;
      }
    }
  };
  const run = (s) => {
    switch (s.k) {
      case 'print':
        out.push(s.args.length ? s.args.map((a) => str(ev(a))).join(' ') : rec.line ?? '');
        break;
      case 'expr':
        ev(s.e);
        break;
      case 'seq':
        s.body.forEach(run);
        break;
      case 'if':
        if (truthy(ev(s.cond))) run(s.then);
        break;
      case 'forin':
        for (const key of Object.keys(arrays[s.arr] || {})) {
          vars[s.v] = key;
          run(s.body);
        }
        break;
      default:
    }
  };
  const doBody = (rule) => (rule.body ? rule.body.forEach(run) : out.push(rec.line));
  rec = Object.assign([], { line: '' });
  for (const r of rules) if (r.kind === 'begin') r.body.forEach(run);
  for (const line of lines) {
    vars.NR += 1;
    rec = Object.assign(split(line), { line });
    vars.NF = rec.length;
    // NF is read through a variable, so keep it in step with the record.
    for (const r of rules) {
      if (r.kind !== 'main') continue;
      if (r.pat && !truthy(ev(r.pat))) continue;
      doBody(r);
    }
  }
  for (const r of rules) if (r.kind === 'end') r.body.forEach(run);
  return out;
}

// ---------------------------------------------------------------- sort

const humanVal = (s) => {
  const m = /^\s*([\d.]+)([KMGT]?)/i.exec(s);
  if (!m) return 0;
  return Number(m[1]) * { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()];
};

export function sortLines(lines, { n = false, r = false, h = false, u = false, key = null, sep = null, f = false } = {}) {
  const field = (line) => {
    if (!key) return line;
    const parts = sep ? line.split(sep) : line.trim().split(/\s+/);
    return parts[key - 1] ?? '';
  };
  const cmpKey = (a, b) => {
    const x = field(a);
    const y = field(b);
    if (n) return num(x) - num(y);
    if (h) return humanVal(x) - humanVal(y);
    const cx = f ? x.toLowerCase() : x;
    const cy = f ? y.toLowerCase() : y;
    return cx.localeCompare(cy);
  };
  const out = [...lines].sort((a, b) => {
    const c = cmpKey(a, b);
    if (c !== 0) return r ? -c : c;
    const last = a < b ? -1 : a > b ? 1 : 0;
    return r ? -last : last;
  });
  return u ? out.filter((l, i) => i === 0 || cmpKey(out[i - 1], l) !== 0) : out;
}
