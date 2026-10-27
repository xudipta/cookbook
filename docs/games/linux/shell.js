// The shell of "Night Shift": a parser (quotes, $?, $(...), globs, pipes, redirection, && || ;) and a
// whitelisted subset of GNU/Linux commands implemented in JS against os.js. There is no real shell and no
// network: unsupported commands answer "not in this sim" with a pointer to the note that covers them.
//
// A command returns its exit code and writes into io.out / io.err (arrays of lines). Anything that
// changes the machine goes through changed(w) so the game can tell a move from a look. Each mutating
// command also calls w.hooks.mutate(target) first, which is how the game notices an action taken before
// looking (the "troubleshooting order" in notes/03).
import {
  addFile, ago, basename, can, children, collate, descendants, diskAvail, diskFull, diskPct, diskUsed, dirname, exists, fileLines, fileText, fmtDate, fmtHttpDate, fmtLs, fmtSince, human, isDir, journalLine,
  listeners, mkdirp, modeString, parseSize, procExit, resolvePath, sizeOf, snapshotUnit, startUnit, stopUnit, treeSize, unitChangedOnDisk,
} from './os.js';
import { awkRun, parseAwk, parseSed, sedRun, sortLines, toRegex } from './text.js';

const NOTES = {
  perms: { note: 'topics/linux/notes/01-shell-fundamentals.md', section: 'Permissions' },
  procs: { note: 'topics/linux/notes/01-shell-fundamentals.md', section: 'Processes' },
  pipes: { note: 'topics/linux/notes/01-shell-fundamentals.md', section: 'Pipes, redirection, and exit codes' },
  sed: { note: 'topics/linux/notes/02-text-processing.md', section: 'sed — stream edit' },
  find: { note: 'topics/linux/notes/02-text-processing.md', section: 'find — locate files, act on them' },
  net: { note: 'topics/linux/notes/03-systemd-and-networking.md', section: 'Networking' },
  disk: { note: 'topics/linux/notes/03-systemd-and-networking.md', section: 'Disk and resource usage' },
  order: { note: 'topics/linux/notes/03-systemd-and-networking.md', section: 'Quick troubleshooting order' },
};

// Real commands this sim does not run, and the note that covers the idea.
const ELSEWHERE = {
  netstat: ['The notes use ss for this.', NOTES.net],
  ifconfig: ['The notes use ip addr for this.', NOTES.net],
  ip: ['Interfaces and routes are covered in the notes.', NOTES.net],
  dig: ['DNS lookups are covered in the notes.', NOTES.net],
  nslookup: ['DNS lookups are covered in the notes (dig).', NOTES.net],
  htop: ['top shows the same table here.', NOTES.procs],
  jobs: ['Job control is covered in the notes.', NOTES.procs],
  fg: ['Job control is covered in the notes.', NOTES.procs],
  bg: ['Job control is covered in the notes.', NOTES.procs],
  nohup: ['Keeping a command running after logout is covered in the notes.', NOTES.procs],
  lsof: ['Open files are covered in the disk notes: a deleted file a process still holds keeps its space.', NOTES.disk],
  vi: ['No editor here: change a file with sed -i, or write it with echo ... > file.', NOTES.sed],
  vim: ['No editor here: change a file with sed -i, or write it with echo ... > file.', NOTES.sed],
  nano: ['No editor here: change a file with sed -i, or write it with echo ... > file.', NOTES.sed],
  emacs: ['No editor here: change a file with sed -i, or write it with echo ... > file.', NOTES.sed],
  tar: ['Archiving is not simulated.', null],
  gzip: ['Compression is not simulated.', null],
  crontab: ['Look at the cron entry with cat /etc/cron.d/<name> instead.', null],
  ssh: ['You are already on the box.', null],
  scp: ['You are already on the box.', null],
  git: ['Not simulated.', null],
  docker: ['Not simulated.', null],
  apt: ['Packages are not simulated.', null],
  'apt-get': ['Packages are not simulated.', null],
  yum: ['Packages are not simulated.', null],
  man: ['No manual pages here. Type help for the commands this sim runs.', null],
  history: ['Use the up arrow to repeat a command.', null],
  tee: ['Use > or >> to write a file.', NOTES.pipes],
  stat: ['Use ls -l for the mode and owner.', NOTES.perms],
  file: ['Not simulated.', null],
  which: ['Not simulated.', null],
  uname: ['Not simulated.', null],
  vmstat: ['Use top and df -h for load and disk.', NOTES.disk],
  iostat: ['Use top and df -h for load and disk.', NOTES.disk],
  reboot: ['Rebooting would not fix this: find the cause first.', NOTES.order],
  shutdown: ['Rebooting would not fix this: find the cause first.', NOTES.order],
  wget: ['Use curl to check a service from here.', NOTES.net],
  ping: ['No network in this sim: use ss and curl to check a service.', NOTES.net],
  nc: ['No network in this sim: use ss and curl to check a service.', NOTES.net],
  telnet: ['No network in this sim: use ss and curl to check a service.', NOTES.net],
};

export const COMMAND_NAMES = [
  'awk', 'bash', 'cat', 'cd', 'chmod', 'chown', 'cp', 'curl', 'cut', 'date', 'df', 'du', 'echo', 'find', 'free', 'grep', 'head', 'help', 'hostname', 'id', 'journalctl', 'kill', 'less', 'ls',
  'mkdir', 'mv', 'nproc', 'pgrep', 'pkill', 'ps', 'pwd', 'rm', 'sed', 'sh', 'sort', 'ss', 'systemctl', 'tail', 'top', 'touch', 'truncate', 'uniq', 'uptime', 'wc', 'whoami', 'xargs', 'clear',
];

const PROTECTED = new Set(['/', '/etc', '/var', '/usr', '/bin', '/sbin', '/lib', '/boot', '/home', '/opt', '/srv', '/root', '/var/log', '/var/lib', '/dev', '/proc', '/sys', '/opt/web', '/home/ops']);

const SIGNALS = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, TERM: 15, STOP: 19, CONT: 18 };

// ---------------------------------------------------------------- terminal output

const say = (w, kind, text, link) => w.term.push(link ? { kind, text, link } : { kind, text });
const changed = (w) => {
  w.moved = true;
};
const looked = (w, tag) => w.seen.add(tag);

// ---------------------------------------------------------------- lexer and parser

class ShellError extends Error {}

function lex(line) {
  const toks = [];
  const n = line.length;
  let i = 0;
  const isWs = (c) => c === ' ' || c === '\t';
  while (i < n) {
    if (isWs(line[i])) {
      i += 1;
      continue;
    }
    const op = /^(2>&1|2>>|&>>|&>|2>|>>|>|<|\|\||\||&&|;|&)/.exec(line.slice(i));
    if (op) {
      toks.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    const segs = [];
    let cur = '';
    const flush = () => {
      if (cur) segs.push({ s: cur, q: 'n' });
      cur = '';
    };
    while (i < n && !isWs(line[i]) && !'|;<>&'.includes(line[i])) {
      const c = line[i];
      if (c === "'") {
        flush();
        const end = line.indexOf("'", i + 1);
        if (end < 0) throw new ShellError("unexpected EOF while looking for matching `''");
        segs.push({ s: line.slice(i + 1, end), q: 's' });
        i = end + 1;
      } else if (c === '"') {
        flush();
        let j = i + 1;
        let depth = 0;
        while (j < n && (line[j] !== '"' || depth > 0)) {
          if (line[j] === '\\') j += 1;
          else if (line[j] === '$' && line[j + 1] === '(') {
            depth += 1;
            j += 1;
          } else if (line[j] === ')' && depth > 0) depth -= 1;
          j += 1;
        }
        if (j >= n) throw new ShellError('unexpected EOF while looking for matching `"\'');
        segs.push({ s: line.slice(i + 1, j), q: 'd' });
        i = j + 1;
      } else if (c === '\\' && i + 1 < n) {
        flush();
        segs.push({ s: line[i + 1], q: 's' });
        i += 2;
      } else if (c === '$' && line[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
          if (line[j] === '(') depth += 1;
          else if (line[j] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        if (j >= n) throw new ShellError("unexpected EOF while looking for matching `)'");
        cur += line.slice(i, j + 1);
        i = j + 1;
      } else {
        cur += c;
        i += 1;
      }
    }
    flush();
    toks.push({ t: 'w', segs });
  }
  return toks;
}

function parse(toks) {
  const list = [];
  let pipe = [];
  let cmd = { words: [], redirs: [] };
  let op = ';';
  const endCmd = (tok) => {
    if (!cmd.words.length && !cmd.redirs.length) throw new ShellError(`syntax error near unexpected token \`${tok}'`);
    pipe.push(cmd);
    cmd = { words: [], redirs: [] };
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'w') cmd.words.push(t.segs);
    else if (['>', '>>', '<', '2>', '2>>', '&>', '&>>'].includes(t.v)) {
      const target = toks[k + 1];
      if (!target || target.t !== 'w') throw new ShellError("syntax error near unexpected token `newline'");
      cmd.redirs.push({ op: t.v, target: target.segs });
      k += 1;
    } else if (t.v === '2>&1') cmd.redirs.push({ op: '2>&1' });
    else if (t.v === '|') endCmd('|');
    else if (t.v === '&') throw new ShellError('background jobs (&) are not in this sim');
    else {
      // ; && ||
      if (!cmd.words.length && !cmd.redirs.length && !pipe.length) {
        if (t.v === ';' && !list.length) throw new ShellError("syntax error near unexpected token `;'");
        throw new ShellError(`syntax error near unexpected token \`${t.v}'`);
      }
      endCmd(t.v);
      list.push({ pipe, op });
      pipe = [];
      op = t.v;
    }
  }
  if (cmd.words.length || cmd.redirs.length) pipe.push(cmd);
  else if (pipe.length) throw new ShellError("syntax error near unexpected token `newline'");
  if (pipe.length) list.push({ pipe, op });
  return list;
}

// ---------------------------------------------------------------- expansion

function expandVars(w, text, run, dq) {
  let out = '';
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (dq && c === '\\' && k + 1 < text.length && '$"\\`'.includes(text[k + 1])) {
      out += text[k + 1];
      k += 1;
    } else if (c === '$' && text[k + 1] === '(') {
      let depth = 0;
      let j = k + 1;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out += run(text.slice(k + 2, j)).replace(/\n+$/, '');
      k = j;
    } else if (c === '$') {
      const m = /^(\?|\$|#|0|\w+|\{\w+\})/.exec(text.slice(k + 1));
      if (!m) out += c;
      else {
        const name = m[1].replace(/[{}]/g, '');
        out += name === '?' ? String(w.lastCode) : name === '$' ? '4242' : name === '#' ? '0' : name === '0' ? 'bash' : (w.env[name] ?? '');
        k += m[1].length;
      }
    } else out += c;
  }
  return out;
}

function globRe(pat) {
  let re = '^';
  for (let k = 0; k < pat.length; k++) {
    const c = pat[k];
    if (c === '\\' && k + 1 < pat.length) re += pat[++k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const j = pat.indexOf(']', k + 2);
      if (j < 0) re += '\\[';
      else {
        re += `[${pat.slice(k + 1, j).replace(/^!/, '^')}]`;
        k = j;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`);
}

export const hasGlob = (pat) => /(^|[^\\])[*?[]/.test(pat);
const unescape = (pat) => pat.replace(/\\(.)/g, '$1');

function globExpand(w, pattern) {
  const abs = pattern.startsWith('/');
  const parts = pattern.split('/').filter((p, i) => p !== '' || i === 0);
  let cur = [abs ? '/' : ''];
  const segs = abs ? parts.slice(1) : parts;
  for (const seg of segs) {
    const next = [];
    for (const base of cur) {
      const dir = base === '' ? w.cwd : base;
      if (!hasGlob(seg)) {
        const name = unescape(seg);
        const joined = base === '' ? name : base === '/' ? `/${name}` : `${base}/${name}`;
        if (exists(w, resolvePath(w, joined)) || seg === '.' || seg === '..') next.push(joined);
        continue;
      }
      const re = globRe(seg);
      if (!isDir(w, resolvePath(w, dir))) continue;
      for (const child of children(w, resolvePath(w, dir))) {
        const name = basename(child);
        if (name.startsWith('.') && !seg.startsWith('.')) continue;
        if (re.test(name)) next.push(base === '' ? name : base === '/' ? `/${name}` : `${base}/${name}`);
      }
    }
    cur = next;
    if (!cur.length) break;
  }
  return cur.length ? cur.sort(collate) : [unescape(pattern)];
}

function expandWord(w, segs, run) {
  let text = '';
  let glob = '';
  let splittable = false;
  segs.forEach((seg, idx) => {
    if (seg.q === 's') {
      text += seg.s;
      glob += seg.s.replace(/[*?[\]\\]/g, '\\$&');
    } else if (seg.q === 'd') {
      const v = expandVars(w, seg.s, run, true);
      text += v;
      glob += v.replace(/[*?[\]\\]/g, '\\$&');
    } else {
      let s = seg.s;
      if (idx === 0 && (s === '~' || s.startsWith('~/'))) s = w.env.HOME + s.slice(1);
      const v = expandVars(w, s, run, false);
      if (/\$/.test(seg.s)) splittable = true;
      text += v;
      glob += v;
    }
  });
  if (splittable && segs.length === 1) {
    return text
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((t) => (hasGlob(t) ? globExpand(w, t) : [t]));
  }
  if (segs.some((s) => s.q === 'n') && hasGlob(glob)) return globExpand(w, glob);
  return [text];
}

// ---------------------------------------------------------------- option parsing

function getopt(args, withArg = '') {
  const r = { f: {}, v: {}, long: {}, rest: [], num: null };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      r.rest.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) r.long[a.slice(2, eq)] = a.slice(eq + 1);
      else r.long[a.slice(2)] = true;
    } else if (/^-\d+$/.test(a)) r.num = Number(a.slice(1));
    else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (withArg.includes(c)) {
          const val = a.slice(j + 1) || args[++k];
          r.v[c] = [...(r.v[c] || []), val];
          break;
        }
        r.f[c] = true;
      }
    } else r.rest.push(a);
  }
  return r;
}

const usage = (io, cmd, why) => {
  io.err.push(why ? `${cmd}: ${why}` : `${cmd}: missing operand`);
  io.err.push(`Try '${cmd} --help' for more information.`);
  return 1;
};

// Read files (or stdin) as lines; records that the file was looked at.
function readSources(w, io, cmd, files) {
  if (!files.length) return { srcs: [{ name: null, lines: io.in ?? [] }], code: 0 };
  const srcs = [];
  let code = 0;
  for (const f of files) {
    if (f === '-') {
      srcs.push({ name: '-', lines: io.in ?? [] });
      continue;
    }
    const abs = resolvePath(w, f);
    const n = w.fs[abs];
    if (!n) {
      io.err.push(`${cmd}: ${f}: No such file or directory`);
      code = 1;
    } else if (n.t === 'd') {
      io.err.push(`${cmd}: ${f}: Is a directory`);
      code = 1;
    } else {
      looked(w, `read:${abs}`);
      srcs.push({ name: f, lines: fileLines(n), abs });
    }
  }
  return { srcs, code };
}

// ---------------------------------------------------------------- write helpers

function writable(w, io, cmd, abs, shown) {
  const dir = w.fs[dirname(abs)];
  if (!dir || dir.t !== 'd') {
    io.err.push(`${cmd}: ${shown}: No such file or directory`);
    return false;
  }
  if (w.fs[abs]?.t === 'd') {
    io.err.push(`${cmd}: ${shown}: Is a directory`);
    return false;
  }
  return true;
}

function writeFile(w, io, cmd, shown, lines, append) {
  const abs = resolvePath(w, shown);
  if (abs === '/dev/null') return true;
  if (!writable(w, io, cmd, abs, shown)) return false;
  if (lines.length && diskFull(w)) {
    io.err.push(`${cmd}: write error: No space left on device`);
    return false;
  }
  w.hooks.mutate(abs);
  let n = w.fs[abs];
  if (!n) n = addFile(w, abs, { o: w.user, ago: 0 });
  n.mt = w.nowMs;
  n.size = undefined;
  n.lines = append ? [...fileLines(n), ...lines] : [...lines];
  changed(w);
  return true;
}

// ---------------------------------------------------------------- the commands

function cmdLs(w, io, args) {
  const o = getopt(args);
  const long = o.f.l;
  const showAll = o.f.a;
  const hum = o.f.h;
  const targets = o.rest.length ? o.rest : ['.'];
  let code = 0;
  const order = (list) => {
    let out = [...list];
    if (o.f.t) out.sort((a, b) => w.fs[b].mt - w.fs[a].mt);
    else if (o.f.S) out.sort((a, b) => sizeOf(w.fs[b]) - sizeOf(w.fs[a]));
    if (o.f.r) out.reverse();
    return out;
  };
  const longLines = (paths, names) => {
    const rows = paths.map((p, i) => {
      const n = w.fs[p];
      const links = n.t === 'd' ? children(w, p).filter((c) => isDir(w, c)).length + 2 : 1;
      return [modeString(n), String(links), n.o, n.g, hum ? human(sizeOf(n)) : String(sizeOf(n)), fmtLs(n.mt, w.nowMs), names[i]];
    });
    const width = (c) => Math.max(...rows.map((r) => r[c].length));
    const [lw, ow, gw, sw] = [1, 2, 3, 4].map(width);
    return rows.map((r) => `${r[0]} ${r[1].padStart(lw)} ${r[2].padEnd(ow)} ${r[3].padEnd(gw)} ${r[4].padStart(sw)} ${r[5]} ${r[6]}`);
  };
  // Short format: one per line in a pipe, otherwise packed into 80-column column-major rows.
  const shortLines = (names) => {
    if (o.f['1'] || io.piped) return names;
    const wide = Math.max(...names.map((s) => s.length), 0) + 2;
    const cols = Math.max(1, Math.floor(80 / wide));
    const rows = Math.ceil(names.length / cols);
    const out = [];
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const i = c * rows + r;
        if (names[i] !== undefined) line += i + rows >= names.length ? names[i] : names[i].padEnd(wide);
      }
      out.push(line.trimEnd());
    }
    return out;
  };
  const files = [];
  const dirs = [];
  for (const t of targets) {
    const abs = resolvePath(w, t);
    if (!exists(w, abs)) {
      io.err.push(`ls: cannot access '${t}': No such file or directory`);
      code = 2;
    } else if (isDir(w, abs) && !o.f.d) dirs.push([t, abs]);
    else files.push([t, abs]);
  }
  if (long) {
    for (const [, abs] of [...files, ...dirs]) {
      looked(w, `ls:${abs}`);
      for (const c of isDir(w, abs) ? children(w, abs) : []) looked(w, `ls:${c}`);
    }
  }
  let printed = false;
  if (files.length) {
    const sorted = order(files.map(([, abs]) => abs));
    const names = sorted.map((abs) => files.find(([, a]) => a === abs)[0]);
    io.out.push(...(long ? longLines(sorted, names) : shortLines(names)));
    printed = true;
  }
  for (const [shown, abs] of dirs) {
    if (printed) io.out.push('');
    if (targets.length > 1) io.out.push(`${shown}:`);
    let list = order(children(w, abs).filter((p) => showAll || !basename(p).startsWith('.')));
    let names = list.map(basename);
    if (showAll) {
      list = [abs, dirname(abs), ...list];
      names = ['.', '..', ...names];
    }
    if (long) {
      const blocks = list.reduce((sum, p) => sum + Math.max(4, Math.ceil(sizeOf(w.fs[p]) / 4096) * 4), 0);
      io.out.push(`total ${hum ? human(blocks * 1024) : blocks}`, ...longLines(list, names));
    } else io.out.push(...shortLines(names));
    printed = true;
  }
  return code;
}

function cmdCat(w, io, args, cmd = 'cat') {
  const o = getopt(args);
  const { srcs, code } = readSources(w, io, cmd, o.rest);
  let n = 0;
  for (const s of srcs) for (const l of s.lines) io.out.push(o.f.n ? `${String(++n).padStart(6)}\t${l}` : l);
  return code;
}

function cmdHeadTail(w, io, args, cmd) {
  const o = getopt(args, 'nc');
  if (o.f.f || o.long.follow) {
    io.err.push(`${cmd}: -f would wait for new lines forever; this sim shows a snapshot. Use ${cmd} -n 20, or journalctl -u NAME -n 20.`);
    return 1;
  }
  const count = o.v.n ? Number(o.v.n[0].replace(/^\+/, '')) : o.num ?? 10;
  if (Number.isNaN(count)) return usage(io, cmd, `invalid number of lines: '${o.v.n[0]}'`);
  const { srcs, code } = readSources(w, io, cmd, o.rest);
  const plus = o.v.n && o.v.n[0].startsWith('+');
  srcs.forEach((s, i) => {
    if (srcs.length > 1) io.out.push(...(i ? [''] : []), `==> ${s.name} <==`);
    const lines = cmd === 'head' ? s.lines.slice(0, count) : plus ? s.lines.slice(count - 1) : count === 0 ? [] : s.lines.slice(-count);
    io.out.push(...lines);
  });
  return code;
}

function grepFiles(w, io, root, recursive) {
  if (!recursive) return [root];
  const abs = resolvePath(w, root);
  if (!isDir(w, abs)) return [root];
  return descendants(w, abs)
    .filter((p) => w.fs[p].t === 'f')
    .map((p) => (root === '.' ? `./${p.slice(abs.length + 1)}` : root.startsWith('/') ? p : `${root}${root.endsWith('/') ? '' : '/'}${p.slice(abs.length + 1)}`));
}

function cmdGrep(w, io, args) {
  const o = getopt(args, 'eAB' + 'C' + 'm');
  const pats = o.v.e || (o.rest.length ? [o.rest.shift()] : null);
  if (!pats) return usage(io, 'grep', 'Usage: grep [OPTION]... PATTERNS [FILE]...');
  let re;
  try {
    const rs = pats.map((p) => toRegex(p, { ere: o.f.E, fixed: o.f.F, i: o.f.i }));
    re = rs.length === 1 ? rs[0] : { test: (s) => rs.some((r) => r.test(s)) };
    if (o.f.w) re = { test: (s) => pats.some((p) => toRegex(`\\b${o.f.F ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p}\\b`, { ere: true, i: o.f.i }).test(s)) };
    if (o.f.x) re = { test: (s) => pats.some((p) => toRegex(`^(${o.f.F ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p})$`, { ere: true, i: o.f.i }).test(s)) };
  } catch (e) {
    io.err.push(`grep: ${e.message}`);
    return 2;
  }
  const recursive = o.f.r || o.f.R;
  let files = o.rest;
  if (recursive && !files.length) files = ['.'];
  files = files.flatMap((f) => grepFiles(w, io, f, recursive));
  const { srcs, code } = readSources(w, io, 'grep', files);
  const prefix = srcs.length > 1 && !o.f.h;
  let any = false;
  const stdinOnly = !files.length;
  void stdinOnly;
  for (const s of srcs) {
    let hits = 0;
    s.lines.forEach((line, i) => {
      if (re.test(line) === Boolean(o.f.v)) return;
      hits += 1;
      any = true;
      if (o.f.c || o.f.l || o.f.q) return;
      const lead = `${prefix ? `${s.name}:` : ''}${o.f.n ? `${i + 1}:` : ''}`;
      io.out.push(`${lead}${line}`);
    });
    if (o.f.c) io.out.push(`${prefix ? `${s.name}:` : ''}${hits}`);
    if (o.f.l && hits) io.out.push(s.name ?? '(standard input)');
  }
  if (o.f.q) io.out.length = 0;
  return code ? 2 : any ? 0 : 1;
}

function cmdSed(w, io, args) {
  const o = getopt(args, 'e');
  const inPlace = Boolean(o.f.i) || 'in-place' in o.long;
  const script = o.v.e ? o.v.e.join('\n') : o.rest.shift();
  if (script === undefined) return usage(io, 'sed', 'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...');
  let cmds;
  try {
    cmds = parseSed(script, o.f.E || o.f.r);
  } catch (e) {
    io.err.push(`sed: -e expression #1, char ${script.length}: ${e.message}`);
    return 1;
  }
  if (inPlace) {
    if (!o.rest.length) {
      io.err.push('sed: no input files');
      return 1;
    }
    let code = 0;
    for (const f of o.rest) {
      const abs = resolvePath(w, f);
      const n = w.fs[abs];
      if (!n || n.t !== 'f') {
        io.err.push(`sed: can't read ${f}: No such file or directory`);
        code = 2;
        continue;
      }
      looked(w, `read:${abs}`);
      const out = sedRun(cmds, fileLines(n), { quiet: Boolean(o.f.n) });
      if (out.join('\n') === fileLines(n).join('\n')) continue;
      if (diskFull(w)) {
        io.err.push(`sed: couldn't open temporary file ${dirname(f) === '.' ? '.' : dirname(f)}/sedX9w2kL: No space left on device`);
        code = 4;
        continue;
      }
      w.hooks.mutate(abs);
      n.lines = out;
      n.size = undefined;
      n.mt = w.nowMs;
      changed(w);
    }
    return code;
  }
  const { srcs, code } = readSources(w, io, 'sed', o.rest);
  for (const s of srcs) io.out.push(...sedRun(cmds, s.lines, { quiet: Boolean(o.f.n) }));
  return code;
}

function cmdAwk(w, io, args) {
  const o = getopt(args, 'F');
  const prog = o.rest.shift();
  if (prog === undefined) {
    io.err.push('usage: awk [-F fs][ -v var=value][prog | -f progfile][file ...]');
    return 2;
  }
  let rules;
  try {
    rules = parseAwk(prog);
  } catch (e) {
    io.err.push(`awk: ${e.message}`);
    return 2;
  }
  const { srcs, code } = readSources(w, io, 'awk', o.rest);
  const lines = srcs.flatMap((s) => s.lines);
  let fs = o.v.F ? o.v.F[0] : null;
  if (fs === '\\t') fs = '\t';
  try {
    io.out.push(...awkRun(rules, lines, { fs }));
  } catch (e) {
    io.err.push(`awk: ${e.message}`);
    return 2;
  }
  return code;
}

function cmdSort(w, io, args) {
  const o = getopt(args, 'kt');
  const { srcs, code } = readSources(w, io, 'sort', o.rest);
  const key = o.v.k ? Number(String(o.v.k[0]).split(/[,.]/)[0]) : null;
  io.out.push(...sortLines(srcs.flatMap((s) => s.lines), { n: o.f.n, r: o.f.r, h: o.f.h, u: o.f.u, f: o.f.f, key, sep: o.v.t ? o.v.t[0] : null }));
  return code;
}

function cmdUniq(w, io, args) {
  const o = getopt(args);
  const { srcs, code } = readSources(w, io, 'uniq', o.rest);
  const groups = [];
  for (const l of srcs.flatMap((s) => s.lines)) {
    if (groups.length && groups[groups.length - 1].line === l) groups[groups.length - 1].n += 1;
    else groups.push({ line: l, n: 1 });
  }
  for (const g of groups) {
    if (o.f.d && g.n < 2) continue;
    io.out.push(o.f.c ? `${String(g.n).padStart(7)} ${g.line}` : g.line);
  }
  return code;
}

function cmdWc(w, io, args) {
  const o = getopt(args);
  const { srcs, code } = readSources(w, io, 'wc', o.rest);
  const counts = srcs.map((s) => ({ name: s.name, l: s.lines.length, w: s.lines.join(' ').split(/\s+/).filter(Boolean).length, c: s.lines.join('\n').length + (s.lines.length ? 1 : 0) }));
  if (srcs.length > 1) counts.push({ name: 'total', l: counts.reduce((a, c) => a + c.l, 0), w: counts.reduce((a, c) => a + c.w, 0), c: counts.reduce((a, c) => a + c.c, 0) });
  const cols = [];
  if (o.f.l) cols.push('l');
  if (o.f.w) cols.push('w');
  if (o.f.c) cols.push('c');
  const use = cols.length ? cols : ['l', 'w', 'c'];
  const width = use.length > 1 || counts.length > 1 ? Math.max(...counts.flatMap((c) => use.map((u) => String(c[u]).length))) : 0;
  for (const c of counts) io.out.push([...use.map((u) => String(c[u]).padStart(width)), c.name].filter((x) => x !== null && x !== undefined).join(' '));
  return code;
}

function cmdCut(w, io, args) {
  const o = getopt(args, 'dfc');
  if (!o.v.f) return usage(io, 'cut', 'you must specify a list of bytes, characters, or fields');
  const d = o.v.d ? o.v.d[0] : '\t';
  const idx = o.v.f[0].split(',').flatMap((p) => {
    const m = /^(\d+)-(\d*)$/.exec(p);
    if (!m) return [Number(p)];
    const hi = m[2] ? Number(m[2]) : 99;
    return Array.from({ length: hi - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
  });
  const { srcs, code } = readSources(w, io, 'cut', o.rest);
  for (const l of srcs.flatMap((s) => s.lines)) io.out.push(l.split(d).filter((_, i) => idx.includes(i + 1)).join(d));
  return code;
}

function cmdEcho(w, io, args) {
  let nl = true;
  let esc = false;
  const rest = [...args];
  while (rest[0] && /^-[neE]+$/.test(rest[0])) {
    const f = rest.shift();
    if (f.includes('n')) nl = false;
    if (f.includes('e')) esc = true;
  }
  let text = rest.join(' ');
  if (esc) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  void nl;
  io.out.push(...text.split('\n'));
  return 0;
}

function cmdCd(w, io, args) {
  const target = args[0] ?? w.env.HOME;
  const abs = resolvePath(w, target === '-' ? w.env.OLDPWD || w.cwd : target);
  if (!exists(w, abs)) io.err.push(`bash: cd: ${target}: No such file or directory`);
  else if (!isDir(w, abs)) io.err.push(`bash: cd: ${target}: Not a directory`);
  else {
    w.env.OLDPWD = w.cwd;
    w.cwd = abs;
    return 0;
  }
  return 1;
}

// ---- find

function parseSizeTest(spec) {
  const m = /^([+-]?)(\d+)([cwbkMG]?)$/.exec(spec);
  if (!m) return null;
  const unit = { c: 1, w: 2, b: 512, k: 1024, M: 1024 ** 2, G: 1024 ** 3, '': 512 }[m[3]];
  return { cmp: m[1], n: Number(m[2]), unit };
}

function cmdFind(w, io, args, run) {
  const paths = [];
  let k = 0;
  while (k < args.length && !args[k].startsWith('-') && args[k] !== '(' && args[k] !== '!') paths.push(args[k++]);
  if (!paths.length) paths.push('.');
  const tests = [];
  const actions = [];
  let maxdepth = Infinity;
  let mindepth = 0;
  for (; k < args.length; k++) {
    const a = args[k];
    const val = () => {
      if (k + 1 >= args.length) throw new Error(`missing argument to \`${a}'`);
      return args[++k];
    };
    switch (a) {
      case '-name':
      case '-iname': {
        const re = globRe(val());
        const ci = a === '-iname';
        tests.push((p) => (ci ? new RegExp(re.source, 'i') : re).test(basename(p.rel)));
        break;
      }
      case '-type': {
        const t = val();
        tests.push((p) => (t === 'f' ? p.n.t === 'f' : t === 'd' ? p.n.t === 'd' : false));
        break;
      }
      case '-size': {
        const t = parseSizeTest(val());
        if (!t) throw new Error('invalid argument to -size');
        tests.push((p) => {
          const units = Math.ceil(sizeOf(p.n) / t.unit);
          return t.cmp === '+' ? units > t.n : t.cmp === '-' ? units < t.n : units === t.n;
        });
        break;
      }
      case '-mtime': {
        const spec = val();
        const m = /^([+-]?)(\d+)$/.exec(spec);
        if (!m) throw new Error(`invalid argument \`${spec}' to \`-mtime'`);
        tests.push((p) => {
          const days = Math.floor((w.nowMs - p.n.mt) / 86400000);
          return m[1] === '+' ? days > Number(m[2]) : m[1] === '-' ? days < Number(m[2]) : days === Number(m[2]);
        });
        break;
      }
      case '-maxdepth':
        maxdepth = Number(val());
        break;
      case '-mindepth':
        mindepth = Number(val());
        break;
      case '-print':
        actions.push({ k: 'print' });
        break;
      case '-print0':
        actions.push({ k: 'print' });
        break;
      case '-delete':
        actions.push({ k: 'delete' });
        break;
      case '-exec': {
        const cmd = [];
        while (k + 1 < args.length && args[k + 1] !== ';' && args[k + 1] !== '+') cmd.push(args[++k]);
        k += 1;
        actions.push({ k: 'exec', cmd });
        break;
      }
      default:
        throw new Error(`unknown predicate \`${a}'`);
    }
  }
  const results = [];
  let code = 0;
  for (const root of paths) {
    const abs = resolvePath(w, root);
    if (!exists(w, abs)) {
      io.err.push(`find: '${root}': No such file or directory`);
      code = 1;
      continue;
    }
    const all = [abs, ...(isDir(w, abs) ? descendants(w, abs) : [])];
    for (const p of all) {
      const depth = p === abs ? 0 : p.slice(abs.length).split('/').length - 1;
      if (depth > maxdepth || depth < mindepth) continue;
      const shown = p === abs ? root : `${root.replace(/\/$/, '')}${p.slice(abs.length === 1 ? 0 : abs.length)}`.replace(/^\/\//, '/');
      const rel = p === abs ? root : p;
      const item = { abs: p, shown, rel, n: w.fs[p] };
      if (tests.every((t) => t(item))) results.push(item);
    }
  }
  for (const r of results) {
    if (!actions.length) io.out.push(r.shown);
    for (const act of actions) {
      if (act.k === 'print') io.out.push(r.shown);
      else if (act.k === 'delete') removePath(w, io, 'find', r.shown, r.abs, { recursive: true, force: true, quietProtect: true });
      else if (act.k === 'exec') {
        const cmd = act.cmd.map((c) => c.replace(/\{\}/g, r.shown));
        const sub = { in: null, out: [], err: [] };
        const c = run(cmd[0], cmd.slice(1), sub);
        io.out.push(...sub.out);
        io.err.push(...sub.err);
        if (c) code = c;
      }
    }
  }
  if (results.length) looked(w, 'find');
  looked(w, 'find');
  return code;
}

// ---- du, df, free

function cmdDu(w, io, args) {
  const o = getopt(args, 'd');
  let limit = Infinity;
  if (o.long['max-depth'] !== undefined) limit = Number(o.long['max-depth']);
  if (o.v.d) limit = Number(o.v.d[0]);
  const fmt = (b) => (o.f.h ? human(b) : String(Math.ceil(b / 1024)));
  const targets = o.rest.length ? o.rest : ['.'];
  let code = 0;
  looked(w, 'du');
  for (const t of targets) {
    const abs = resolvePath(w, t);
    if (!exists(w, abs)) {
      io.err.push(`du: cannot access '${t}': No such file or directory`);
      code = 1;
      continue;
    }
    if (!isDir(w, abs) || o.f.s) {
      io.out.push(`${fmt(treeSize(w, abs, true))}\t${t}`);
      continue;
    }
    // Post-order: a directory is listed after the directories inside it.
    const walk = (dir, depth) => {
      for (const c of children(w, dir)) if (isDir(w, c)) walk(c, depth + 1);
      if (depth <= limit) io.out.push(`${fmt(treeSize(w, dir, true))}\t${dir === abs ? t : `${t.replace(/\/$/, '')}${dir.slice(abs === '/' ? 0 : abs.length)}`}`);
    };
    walk(abs, 0);
  }
  return code;
}

function cmdDf(w, io, args) {
  const o = getopt(args);
  looked(w, 'df');
  const rows = [];
  const used = diskUsed(w);
  const size = w.disk.size;
  const avail = diskAvail(w);
  const pct = diskPct(w);
  const fmt = (b) => (o.f.h ? human(b) : String(Math.ceil(b / 1024)));
  rows.push([w.disk.dev, fmt(size), fmt(used), fmt(avail), `${pct}%`, '/']);
  for (const e of w.disk.extra || []) rows.push([e.fs, e.size, e.used, e.avail, e.pct, e.mount]);
  const head = ['Filesystem', o.f.h ? 'Size' : '1K-blocks', 'Used', o.f.h ? 'Avail' : 'Available', 'Use%', 'Mounted on'];
  const all = [head, ...rows];
  const mins = [14, 5, 5, 5, 4];
  const wd = [0, 1, 2, 3, 4].map((c) => Math.max(mins[c], ...all.map((r) => r[c].length)));
  for (const r of all) io.out.push(`${r[0].padEnd(wd[0])} ${[1, 2, 3, 4].map((c) => r[c].padStart(wd[c])).join(' ')} ${r[5]}`);
  return 0;
}

function cmdFree(w, io, args) {
  const o = getopt(args);
  io.out.push(...(o.f.h ? w.freeText : w.freeTextKb));
  return 0;
}

function cmdUptime(w, io) {
  looked(w, 'uptime');
  const d = new Date(w.nowMs);
  const hh = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
  const [a, b, c] = w.load.avg.map((x) => x.toFixed(2));
  io.out.push(` ${hh} up ${w.uptime},  1 user,  load average: ${a}, ${b}, ${c}`);
  return 0;
}

// ---- processes

const procName = (p) => basename(p.cmd.split(/\s+/)[0]).replace(/:$/, '').slice(0, 15);

function psRows(w) {
  const extra = (w.pipelineCmds || []).map((c, i) => ({ pid: w.nextPid + 40 + i, ppid: 2201, user: w.user, cpu: 0, mem: 0, vsz: 8120, rss: 1020, tty: 'pts/0', stat: 'R+', startMs: w.nowMs, time: '0:00', cmd: c }));
  const self = { pid: w.nextPid + 39, ppid: 2201, user: w.user, cpu: 0, mem: 0, vsz: 8120, rss: 1020, tty: 'pts/0', stat: 'R+', startMs: w.nowMs, time: '0:00', cmd: 'ps aux' };
  return [...w.procs, self, ...extra];
}

function cmdPs(w, io, args) {
  looked(w, 'ps');
  const o = getopt(args, 'o');
  // BSD style options (ps aux) have no dash.
  for (const word of [...o.rest]) {
    if (/^[auxf]+$/.test(word)) {
      for (const c of word) o.f[c] = true;
      o.rest.splice(o.rest.indexOf(word), 1);
    }
  }
  let list = psRows(w);
  const sort = o.long.sort;
  if (sort) {
    const desc = String(sort).startsWith('-');
    const key = String(sort).replace(/^[-+]/, '');
    const get = key === '%cpu' || key === 'pcpu' ? (p) => p.cpu : key === '%mem' || key === 'pmem' ? (p) => p.mem : key === 'rss' ? (p) => p.rss : key === 'pid' ? (p) => p.pid : null;
    if (!get) {
      io.err.push(`error: unknown sort key '${key}'`);
      return 1;
    }
    list = [...list].sort((a, b) => (desc ? get(b) - get(a) : get(a) - get(b)) || a.pid - b.pid);
  } else list = [...list].sort((a, b) => a.pid - b.pid);
  if (o.f.e && o.f.f) {
    io.out.push('UID          PID    PPID  C STIME TTY          TIME CMD');
    for (const p of list) {
      const [m, sec] = p.time.split(':');
      io.out.push(`${p.user.slice(0, 8).padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)} ${String(Math.round(p.cpu / 10)).padStart(2)} ${startColShort(p, w)} ${p.tty.padEnd(8)} 00:${m.padStart(2, '0')}:${sec} ${p.cmd}`);
    }
    return 0;
  }
  if (o.f.a && o.f.u && o.f.x) {
    // ps aux
  } else if (o.f.a || o.f.u || o.f.x) {
    // ps ax / ps u ... all shown as aux
  } else if (!o.f.e) {
    io.out.push('    PID TTY          TIME CMD');
    for (const p of list.filter((x) => x.tty !== '?')) io.out.push(`${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} 00:00:00 ${basename(p.cmd.split(/\s+/)[0])}`);
    return 0;
  }
  io.out.push('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND');
  for (const p of list) {
    const start = startColLong(p, w);
    io.out.push(`${p.user.slice(0, 8).padEnd(8)} ${String(p.pid).padStart(7)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${String(p.vsz).padStart(6)} ${String(p.rss).padStart(5)} ${p.tty.padEnd(8)} ${p.stat.padEnd(4)} ${start.padEnd(5)} ${p.time.padStart(6)} ${p.cmd}`);
  }
  return 0;
}

function startColLong(p, w) {
  const a = new Date(p.startMs);
  const b = new Date(w.nowMs);
  const same = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][a.getUTCMonth()];
  return same ? `${String(a.getUTCHours()).padStart(2, '0')}:${String(a.getUTCMinutes()).padStart(2, '0')}` : `${mon}${String(a.getUTCDate()).padStart(2, '0')}`;
}
const startColShort = (p, w) => startColLong(p, w).padEnd(5);

function cmdTop(w, io) {
  looked(w, 'top');
  looked(w, 'ps');
  const d = new Date(w.nowMs);
  const hh = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
  const [a, b, c] = w.load.avg.map((x) => x.toFixed(2));
  const total = w.procs.length + 60;
  const running = w.procs.filter((p) => p.cpu > 50).length + 1;
  const cpu = Math.min(99.5, w.procs.reduce((s, p) => s + p.cpu, 0) / w.cores);
  const us = Math.max(0.5, cpu * 0.97);
  io.out.push(`top - ${hh} up ${w.uptime},  1 user,  load average: ${a}, ${b}, ${c}`);
  io.out.push(`Tasks: ${String(total).padStart(3)} total, ${String(running).padStart(3)} running, ${String(total - running).padStart(3)} sleeping,   0 stopped,   0 zombie`);
  io.out.push(`%Cpu(s): ${us.toFixed(1).padStart(4)} us, ${(cpu * 0.03).toFixed(1).padStart(4)} sy,  0.0 ni, ${Math.max(0, 100 - cpu).toFixed(1).padStart(4)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st`);
  io.out.push(...w.topMem);
  io.out.push('');
  io.out.push('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');
  const rows = [...w.procs].sort((x, y) => y.cpu - x.cpu || x.pid - y.pid).slice(0, 12);
  for (const p of rows) {
    const [m, s] = p.time.split(':');
    const timePlus = `${m}:${String(s).padStart(2, '0')}.00`;
    io.out.push(`${String(p.pid).padStart(7)} ${p.user.slice(0, 8).padEnd(9)} 20   0 ${String(p.vsz).padStart(7)} ${String(p.rss).padStart(6)} ${String(Math.round(p.rss * 0.3)).padStart(6)} ${p.cpu > 50 ? 'R' : 'S'} ${p.cpu.toFixed(1).padStart(5)} ${p.mem.toFixed(1).padStart(5)} ${timePlus.padStart(9)} ${procName(p)}`);
  }
  return 0;
}

function matchProcs(w, pattern, full) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    return [];
  }
  return w.procs.filter((p) => re.test(full ? p.cmd : procName(p)));
}

function cmdPgrep(w, io, args) {
  const o = getopt(args);
  looked(w, 'ps');
  const pat = o.rest[0];
  if (!pat) return usage(io, 'pgrep', 'no matching criteria specified');
  const hits = matchProcs(w, pat, o.f.f);
  for (const p of hits) io.out.push(o.f.l ? `${p.pid} ${procName(p)}` : String(p.pid));
  return hits.length ? 0 : 1;
}

function signalNumber(token) {
  if (/^\d+$/.test(token)) return Number(token);
  const name = token.replace(/^SIG/, '').toUpperCase();
  return SIGNALS[name] ?? null;
}

function sendSignal(w, io, p, sig, label) {
  if (p.pid === 1) {
    if (sig === 9) {
      w.hooks.fatal('killed-init', `kill -${sig} 1`);
      return 0;
    }
    return 0;
  }
  w.hooks.mutate(`pid:${p.pid}`);
  if (sig === 0) return 0;
  if (p.term === 'ignore' && sig !== 9 && sig !== 19) {
    p.termSent = true;
    changed(w);
    return 0;
  }
  if (sig === 19 || sig === 18) return 0;
  if (sig === 9 && p.cleanup && !p.termSent) w.hooks.penalize('kill-9-first', 4, `${label} (${p.cleanup})`);
  if (sig !== 9) p.termSent = true;
  const how = sig === 9 ? 'kill' : 'term';
  const wasUnit = p.unit;
  procExit(w, p, how);
  changed(w);
  w.hooks.killed(p, wasUnit, how);
  return 0;
}

function cmdKill(w, io, args) {
  let sig = 15;
  const rest = [];
  if (args[0] === '-l') {
    io.out.push(...Object.entries(SIGNALS).map(([n, v]) => `${String(v).padStart(2)}) SIG${n}`));
    return 0;
  }
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-s' || a === '-n') {
      const s = signalNumber(args[++k] ?? '');
      if (s === null) {
        io.err.push(`bash: kill: ${args[k]}: invalid signal specification`);
        return 1;
      }
      sig = s;
    } else if (/^-[A-Za-z0-9]+$/.test(a) && !rest.length) {
      const s = signalNumber(a.slice(1));
      if (s === null) {
        io.err.push(`bash: kill: ${a.slice(1)}: invalid signal specification`);
        return 1;
      }
      sig = s;
    } else rest.push(a);
  }
  if (!rest.length) {
    io.err.push('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]');
    return 2;
  }
  let code = 0;
  for (const t of rest) {
    const pid = Number(t);
    if (!Number.isInteger(pid)) {
      io.err.push(`bash: kill: ${t}: arguments must be process or job IDs`);
      code = 1;
      continue;
    }
    const p = w.procs.find((x) => x.pid === pid);
    if (!p) {
      io.err.push(`bash: kill: (${pid}) - No such process`);
      code = 1;
      continue;
    }
    sendSignal(w, io, p, sig, procName(p));
  }
  return code;
}

function cmdPkill(w, io, args) {
  const o = getopt(args);
  const rest = [...o.rest];
  let sig = 15;
  const flagSig = args.find((a) => /^-(\d+|[A-Z]+)$/.test(a));
  if (flagSig) sig = signalNumber(flagSig.slice(1)) ?? 15;
  const pat = rest.find((a) => !/^-/.test(a));
  if (!pat) return usage(io, 'pkill', 'no matching criteria specified');
  const hits = matchProcs(w, pat, o.f.f);
  for (const p of hits) sendSignal(w, io, p, sig, procName(p));
  return hits.length ? 0 : 1;
}

// ---- permissions

function newMode(cur, spec, isDirNode) {
  if (/^[0-7]{3,4}$/.test(spec)) return parseInt(spec, 8) & 0o7777;
  let mode = cur;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
    if (!m) return null;
    const who = m[1] || 'a';
    let bits = 0;
    for (const c of m[3]) bits |= c === 'r' ? 4 : c === 'w' ? 2 : c === 'x' ? 1 : c === 'X' ? (isDirNode || cur & 0o111 ? 1 : 0) : 0;
    let mask = 0;
    for (const u of who === 'a' ? 'ugo' : who) mask |= bits << (u === 'u' ? 6 : u === 'g' ? 3 : 0);
    let clearMask = 0;
    for (const u of who === 'a' ? 'ugo' : who) clearMask |= 7 << (u === 'u' ? 6 : u === 'g' ? 3 : 0);
    if (m[2] === '+') mode |= mask;
    else if (m[2] === '-') mode &= ~mask;
    else mode = (mode & ~clearMask) | mask;
  }
  return mode & 0o7777;
}

function cmdChmod(w, io, args) {
  const rest = [];
  let recursive = false;
  for (const a of args) {
    if (a === '-R' || a === '--recursive') recursive = true;
    else rest.push(a);
  }
  if (rest.length < 2) return usage(io, 'chmod', rest.length ? `missing operand after '${rest[0]}'` : 'missing operand');
  const [spec, ...files] = rest;
  if (newMode(0, spec, false) === null) {
    io.err.push(`chmod: invalid mode: '${spec}'`);
    io.err.push("Try 'chmod --help' for more information.");
    return 1;
  }
  let code = 0;
  for (const f of files) {
    const abs = resolvePath(w, f);
    if (!exists(w, abs)) {
      io.err.push(`chmod: cannot access '${f}': No such file or directory`);
      code = 1;
      continue;
    }
    for (const p of recursive ? [abs, ...descendants(w, abs)] : [abs]) {
      const n = w.fs[p];
      const mode = newMode(n.mode, spec, n.t === 'd');
      if (mode === n.mode) continue;
      w.hooks.mutate(p);
      n.mode = mode;
      changed(w);
      w.hooks.modeChanged(p, mode);
    }
  }
  return code;
}

function cmdChown(w, io, args) {
  const o = getopt(args);
  if (o.rest.length < 2) return usage(io, 'chown', o.rest.length ? `missing operand after '${o.rest[0]}'` : 'missing operand');
  const [spec, ...files] = o.rest;
  const m = /^([^:.]*)(?:[:.](.*))?$/.exec(spec);
  const user = m[1] || null;
  const group = m[2] || null;
  if (user && !w.users[user]) {
    io.err.push(`chown: invalid user: '${spec}'`);
    return 1;
  }
  if (group && !Object.values(w.users).some((u) => u.groups.includes(group)) && !w.users[group]) {
    io.err.push(`chown: invalid group: '${spec}'`);
    return 1;
  }
  let code = 0;
  for (const f of files) {
    const abs = resolvePath(w, f);
    if (!exists(w, abs)) {
      io.err.push(`chown: cannot access '${f}': No such file or directory`);
      code = 1;
      continue;
    }
    for (const p of o.f.R ? [abs, ...descendants(w, abs)] : [abs]) {
      const n = w.fs[p];
      const newOwner = user ?? n.o;
      const newGroup = group ?? (spec.includes(':') && !group ? w.users[user]?.groups[0] ?? n.g : n.g);
      if (newOwner === n.o && newGroup === n.g) continue;
      w.hooks.mutate(p);
      n.o = newOwner;
      n.g = newGroup;
      changed(w);
    }
  }
  return code;
}

// ---- files

function removePath(w, io, cmd, shown, abs, { recursive, force, quietProtect }) {
  const n = w.fs[abs];
  if (!n) {
    if (!force) io.err.push(`${cmd}: cannot remove '${shown}': No such file or directory`);
    return force ? 0 : 1;
  }
  if (abs === '/') {
    io.err.push(`${cmd}: it is dangerous to operate recursively on '/'`);
    io.err.push(`${cmd}: use --no-preserve-root to override this failsafe`);
    return 1;
  }
  if (n.t === 'd' && !recursive) {
    io.err.push(`${cmd}: cannot remove '${shown}': Is a directory`);
    return 1;
  }
  const doomed = [abs, ...(n.t === 'd' ? descendants(w, abs) : [])];
  if ((n.t === 'd' && (PROTECTED.has(abs) || descendants(w, abs).some((p) => w.fs[p].crit))) || doomed.some((p) => w.fs[p].crit)) {
    void quietProtect;
    w.hooks.fatal('rm-wrong', `${cmd} ${shown}`);
    return 0;
  }
  w.hooks.mutate(abs);
  for (const p of doomed.reverse()) {
    const node = w.fs[p];
    const holders = (node.held || []).filter((pid) => w.procs.some((x) => x.pid === pid));
    if (node.t === 'f' && holders.length) {
      w.deleted.push({ path: p, size: sizeOf(node), holders });
      w.hooks.deletedOpen(p, holders);
    }
    delete w.fs[p];
  }
  changed(w);
  return 0;
}

function cmdRm(w, io, args) {
  const o = getopt(args);
  const recursive = Boolean(o.f.r || o.f.R || o.long.recursive);
  if (!o.rest.length) {
    io.err.push('rm: missing operand');
    io.err.push("Try 'rm --help' for more information.");
    return 1;
  }
  let code = 0;
  for (const f of o.rest) {
    const abs = resolvePath(w, f);
    code = removePath(w, io, 'rm', f, abs, { recursive, force: Boolean(o.f.f) }) || code;
    if (w.dead) break;
  }
  return code;
}

function cmdTruncate(w, io, args) {
  const o = getopt(args, 's');
  if (!o.v.s) return usage(io, 'truncate', 'you must specify either \'--size\' or \'--reference\'');
  const size = parseSize(o.v.s[0]);
  if (Number.isNaN(size)) {
    io.err.push(`truncate: Invalid number: '${o.v.s[0]}'`);
    return 1;
  }
  if (!o.rest.length) return usage(io, 'truncate', 'missing file operand');
  let code = 0;
  for (const f of o.rest) {
    const abs = resolvePath(w, f);
    let n = w.fs[abs];
    if (n?.t === 'd') {
      io.err.push(`truncate: cannot open '${f}' for writing: Is a directory`);
      code = 1;
      continue;
    }
    if (!n && !writable(w, io, 'truncate', abs, f)) {
      code = 1;
      continue;
    }
    w.hooks.mutate(abs);
    if (!n) n = addFile(w, abs, { o: w.user, ago: 0 });
    if (sizeOf(n) === size) continue;
    n.size = size;
    if (size === 0) n.lines = [];
    n.mt = w.nowMs;
    changed(w);
  }
  return code;
}

function destFor(w, src, dest) {
  const abs = resolvePath(w, dest);
  return isDir(w, abs) ? `${abs === '/' ? '' : abs}/${basename(src)}` : abs;
}

function cmdCpMv(w, io, args, cmd) {
  const o = getopt(args);
  if (o.rest.length < 2) return usage(io, cmd, o.rest.length ? `missing destination file operand after '${o.rest[0]}'` : 'missing file operand');
  const dest = o.rest[o.rest.length - 1];
  const srcs = o.rest.slice(0, -1);
  let code = 0;
  for (const s of srcs) {
    const sabs = resolvePath(w, s);
    const n = w.fs[sabs];
    if (!n) {
      io.err.push(`${cmd}: cannot stat '${s}': No such file or directory`);
      code = 1;
      continue;
    }
    if (n.t === 'd' && cmd === 'cp' && !(o.f.r || o.f.R || o.f.a)) {
      io.err.push(`cp: -r not specified; omitting directory '${s}'`);
      code = 1;
      continue;
    }
    const dabs = destFor(w, sabs, dest);
    if (!isDir(w, dirname(dabs))) {
      io.err.push(`${cmd}: cannot create regular file '${dest}': No such file or directory`);
      code = 1;
      continue;
    }
    if (cmd === 'cp' && diskFull(w)) {
      io.err.push(`cp: error writing '${dest}': No space left on device`);
      code = 1;
      continue;
    }
    w.hooks.mutate(dabs);
    const moved = [sabs, ...(n.t === 'd' ? descendants(w, sabs) : [])];
    for (const p of moved) {
      const target = dabs + p.slice(sabs.length);
      const node = w.fs[p];
      w.fs[target] = cmd === 'cp' ? { ...node, lines: [...fileLines(node)], held: [], mt: w.nowMs, o: w.user === 'root' ? node.o : node.o } : node;
      if (cmd === 'mv') delete w.fs[p];
    }
    changed(w);
  }
  return code;
}

function cmdMkdir(w, io, args) {
  const o = getopt(args);
  if (!o.rest.length) return usage(io, 'mkdir', 'missing operand');
  let code = 0;
  for (const d of o.rest) {
    const abs = resolvePath(w, d);
    if (exists(w, abs)) {
      if (!o.f.p) {
        io.err.push(`mkdir: cannot create directory '${d}': File exists`);
        code = 1;
      }
      continue;
    }
    if (!o.f.p && !isDir(w, dirname(abs))) {
      io.err.push(`mkdir: cannot create directory '${d}': No such file or directory`);
      code = 1;
      continue;
    }
    w.hooks.mutate(abs);
    mkdirp(w, abs, { o: w.user });
    changed(w);
  }
  return code;
}

function cmdTouch(w, io, args) {
  if (!args.length) return usage(io, 'touch', 'missing file operand');
  let code = 0;
  for (const f of args) {
    const abs = resolvePath(w, f);
    if (!exists(w, abs)) {
      if (!writable(w, io, 'touch', abs, f)) {
        code = 1;
        continue;
      }
      w.hooks.mutate(abs);
      addFile(w, abs, { o: w.user, ago: 0 });
    } else w.fs[abs].mt = w.nowMs;
    changed(w);
  }
  return code;
}

// ---- systemd

const unitName = (s) => s.replace(/\.service$/, '');

function statusText(w, u) {
  const lines = [];
  const bullet = u.active === 'failed' ? '×' : u.active === 'inactive' ? '○' : '●';
  lines.push(`${bullet} ${u.name}.service${u.desc ? ` - ${u.desc}` : ''}`);
  const enabled = u.enabled ? 'enabled' : 'disabled';
  lines.push(`     Loaded: loaded (${u.file}; ${enabled}; preset: enabled)`);
  const since = fmtSince(u.sinceMs);
  const when = ago(w.nowMs - u.sinceMs);
  if (u.active === 'active') lines.push(`     Active: active (running) since ${since}; ${when}`);
  else if (u.active === 'activating') lines.push(`     Active: activating (auto-restart) (Result: ${u.result === 'signal' ? 'signal' : 'exit-code'}) since ${since}; ${when}`);
  else if (u.active === 'failed') lines.push(`     Active: failed (Result: ${u.result === 'signal' ? 'signal' : 'exit-code'}) since ${since}; ${when}`);
  else lines.push(`     Active: inactive (dead) since ${since}; ${when}`);
  const lastPid = u.lastPid || u.pid;
  if (u.active === 'activating' || u.active === 'failed') {
    const reason = u.code && /^\d+\/(KILL|TERM)$/.test(u.code) ? `code=${u.code.endsWith('KILL') ? 'killed' : 'exited'}, status=${u.code}` : `code=exited, status=${u.code || '1/FAILURE'}`;
    if (u.result !== 'signal') lines.push(`    Process: ${lastPid} ExecStart=${u.loaded.exec} (${reason})`);
    lines.push(`   Main PID: ${lastPid} (${reason})`);
    lines.push('        CPU: 12ms');
  } else if (u.active === 'active') {
    const p = w.procs.find((x) => x.pid === u.pid);
    lines.push(`   Main PID: ${u.pid} (${p ? procName(p) : u.name})`);
    lines.push(`      Tasks: ${1 + w.procs.filter((x) => x.ppid === u.pid).length} (limit: 4543)`);
    lines.push(`     Memory: ${human((p?.rss ?? 4000) * 1024)}`);
    lines.push('        CPU: 1.203s');
    lines.push(`     CGroup: /system.slice/${u.name}.service`);
    lines.push(`             └─${u.pid} ${u.loaded.exec}`);
  }
  lines.push('');
  const entries = (w.journal[u.name] || []).slice(-10);
  for (const e of entries) lines.push(journalLine(w, e));
  if (unitChangedOnDisk(w, u)) {
    lines.push('');
    lines.push(`Warning: The unit file, source configuration file or drop-ins of ${u.name}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`);
  }
  return lines;
}

function cmdSystemctl(w, io, args) {
  const o = getopt(args, 'n');
  const [sub, ...names] = o.rest;
  if (!sub) {
    io.out.push('UNIT                LOAD   ACTIVE SUB     DESCRIPTION');
    for (const u of Object.values(w.units)) io.out.push(`${`${u.name}.service`.padEnd(19)} loaded ${u.active.padEnd(6)} ${u.sub.padEnd(7)} ${u.desc || ''}`);
    return 0;
  }
  if (sub === 'daemon-reload') {
    w.hooks.mutate('daemon-reload');
    for (const u of Object.values(w.units)) snapshotUnit(w, u);
    changed(w);
    return 0;
  }
  if (!['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'is-active', 'is-enabled', 'try-restart'].includes(sub)) {
    io.err.push(`Unknown command verb ${sub}.`);
    return 1;
  }
  if (!names.length) {
    io.err.push(sub === 'status' ? 'No unit specified; this sim shows one unit at a time.' : `Too few arguments.`);
    return 1;
  }
  let code = 0;
  for (const raw of names) {
    const name = unitName(raw);
    const u = w.units[name];
    if (!u) {
      io.err.push(sub === 'status' || sub.startsWith('is-') ? `Unit ${name}.service could not be found.` : `Failed to ${sub} ${name}.service: Unit ${name}.service not found.`);
      code = sub === 'status' ? 4 : sub.startsWith('is-') ? 4 : 5;
      continue;
    }
    switch (sub) {
      case 'status':
        looked(w, `status:${name}`);
        io.out.push(...statusText(w, u));
        if (u.active !== 'active') code = u.active === 'inactive' || u.active === 'failed' ? 3 : 3;
        break;
      case 'is-active':
        io.out.push(u.active === 'active' ? 'active' : u.active === 'activating' ? 'activating' : u.active);
        code = u.active === 'active' ? 0 : 3;
        break;
      case 'is-enabled':
        io.out.push(u.enabled ? 'enabled' : 'disabled');
        code = u.enabled ? 0 : 1;
        break;
      case 'enable':
      case 'disable':
        w.hooks.mutate(name);
        if (u.enabled !== (sub === 'enable')) {
          u.enabled = sub === 'enable';
          io.err.push(sub === 'enable' ? `Created symlink /etc/systemd/system/multi-user.target.wants/${name}.service → ${u.file}.` : `Removed /etc/systemd/system/multi-user.target.wants/${name}.service.`);
          changed(w);
        }
        if (o.long.now) {
          if (sub === 'enable' && u.active !== 'active') startUnit(w, u);
          if (sub === 'disable' && u.active === 'active') stopUnit(w, u);
          changed(w);
        }
        break;
      case 'stop':
        w.hooks.mutate(name);
        if (u.active !== 'inactive') {
          const wasActive = u.active === 'active';
          stopUnit(w, u);
          w.hooks.stopped(u, wasActive);
        }
        changed(w);
        break;
      case 'start':
      case 'restart':
      case 'try-restart': {
        w.hooks.mutate(name);
        if (sub === 'start' && u.active === 'active') break;
        if (sub === 'try-restart' && u.active !== 'active') break;
        if (unitChangedOnDisk(w, u)) io.err.push(`Warning: The unit file, source configuration file or drop-ins of ${name}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`);
        if (u.pid) stopUnit(w, u);
        const r = startUnit(w, u);
        changed(w);
        if (!r.ok && r.job) {
          io.err.push(`Job for ${name}.service failed because the control process exited with error code.`);
          io.err.push(`See "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`);
          code = 1;
        }
        break;
      }
      case 'reload':
        w.hooks.mutate(name);
        if (u.active !== 'active') {
          io.err.push(`Failed to reload ${name}.service: Unit ${name}.service is not active.`);
          code = 1;
        } else if (!u.reloadable) {
          io.err.push(`Failed to reload ${name}.service: Job type reload is not applicable for unit ${name}.service.`);
          code = 1;
        } else {
          u.running = Object.fromEntries(u.confs.map((c) => [c, fileText(w, c)]));
          w.hooks.reloaded(u);
          changed(w);
        }
        break;
      default:
    }
  }
  return code;
}

function cmdJournalctl(w, io, args) {
  const o = getopt(args, 'unp');
  if (o.f.f || o.long.follow) {
    io.err.push('journalctl: -f would follow the log forever; this sim shows a snapshot. Use -n 50.');
    return 1;
  }
  const units = (o.v.u || []).map(unitName);
  for (const u of units) {
    if (!w.units[u]) {
      io.out.push('-- No entries --');
      return 0;
    }
    looked(w, `journal:${u}`);
  }
  looked(w, 'journal');
  const n = o.v.n ? Number(o.v.n[0]) : o.num ?? 50;
  let entries;
  if (units.length) entries = units.flatMap((u) => w.journal[u] || []);
  else entries = Object.values(w.journal).flat();
  entries = [...entries].sort((a, b) => a.ms - b.ms);
  if (o.v.p && o.v.p[0] === 'err') entries = entries.filter((e) => /fatal|fail|error|denied/i.test(e.msg));
  if (!entries.length) io.out.push('-- No entries --');
  else io.out.push(...entries.slice(-n).map((e) => journalLine(w, e)));
  return 0;
}

// ---- networking

function cmdSs(w, io, args) {
  looked(w, 'ss');
  const o = getopt(args);
  const wantT = o.f.t || (!o.f.u && !o.f.t);
  const wantU = o.f.u || (!o.f.u && !o.f.t);
  const showNetid = Boolean(o.f.u);
  const rows = [];
  for (const l of listeners(w)) {
    if ((l.proto === 'tcp' && !wantT) || (l.proto === 'udp' && !wantU)) continue;
    const addr = `${l.addr === '::' ? '[::]' : l.addr}:${l.port}`;
    const proc = o.f.p ? `users:(("${procName(l.proc)}",pid=${l.proc.pid},fd=${l.proc.fd || 6}))` : '';
    rows.push({ netid: l.proto, state: l.proto === 'udp' ? 'UNCONN' : 'LISTEN', q: '0', sq: l.proto === 'udp' ? '0' : l.port === 22 ? '128' : '511', local: addr, peer: l.proto === 'udp' ? '0.0.0.0:*' : '0.0.0.0:*', proc });
  }
  const maxOf = (f, min) => Math.max(min, ...rows.map((r) => r[f].length));
  const lw = maxOf('local', 18) + 3;
  const pw = maxOf('peer', 17) + 3;
  const head = `${showNetid ? 'Netid  ' : ''}${'State'.padEnd(9)}${'Recv-Q'.padEnd(9)}${'Send-Q'.padEnd(8)}${'Local Address:Port'.padStart(lw)}${'Peer Address:Port'.padStart(pw)}${o.f.p ? '  Process' : ''}`;
  io.out.push(head);
  for (const r of rows) io.out.push(`${showNetid ? r.netid.padEnd(7) : ''}${r.state.padEnd(9)}${r.q.padEnd(9)}${r.sq.padEnd(8)}${r.local.padStart(lw)}${r.peer.padStart(pw)}${o.f.p ? `  ${r.proc}` : ''}`);
  return 0;
}

const STATUS_TEXT = { 200: 'OK', 301: 'Moved Permanently', 302: 'Found', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

function cmdCurl(w, io, args) {
  looked(w, 'curl');
  const o = getopt(args, 'oXH');
  const url = o.rest[0];
  if (!url) {
    io.err.push("curl: try 'curl --help' or 'curl --manual' for more information");
    return 2;
  }
  const m = /^(?:(https?):\/\/)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!m) {
    io.err.push(`curl: (3) URL rejected: Malformed input to a URL function`);
    return 3;
  }
  const scheme = m[1] || 'http';
  const host = m[2];
  const port = Number(m[3] || (scheme === 'https' ? 443 : 80));
  const path = m[4] || '/';
  const silent = o.f.s && !o.f.S;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  const mine = host === w.ip || host === w.host;
  if (!local && !mine && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (!silent) io.err.push(`curl: (6) Could not resolve host: ${host}`);
    return 6;
  }
  const target = host === 'localhost' ? '127.0.0.1' : host;
  const hit = listeners(w).find((l) => l.proto === 'tcp' && l.port === port && (l.addr === '0.0.0.0' || l.addr === '::' || l.addr === target));
  if (o.f.v) {
    io.err.push(`*   Trying ${target}:${port}...`);
  }
  if (!hit || !hit.proc.http || (!local && !mine)) {
    if (o.f.v) io.err.push(`* connect to ${target} port ${port} from 0.0.0.0 port 53012 failed: Connection refused`);
    if (!silent) io.err.push(`curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`);
    return 7;
  }
  const http = hit.proc.http;
  const status = http.status ?? 200;
  const head = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] || ''}`.trimEnd(), `Server: ${http.server || 'nginx/1.24.0'}`, `Date: ${fmtHttpDate(w.nowMs)}`, 'Content-Type: text/html', `Content-Length: ${(http.body || '').length}`, 'Connection: keep-alive'];
  if (o.f.v) {
    io.err.push(`* Connected to ${host} (${target}) port ${port}`, `> ${o.f.I ? 'HEAD' : 'GET'} ${path} HTTP/1.1`, `> Host: ${host}${m[3] ? `:${m[3]}` : ''}`, '> User-Agent: curl/8.5.0', '> Accept: */*', '>');
    io.err.push(...head.map((h) => `< ${h}`), '<');
  }
  if (o.f.I || o.f.i) io.out.push(...head, '');
  if (!o.f.I) io.out.push(...(http.body ? http.body.split('\n') : []));
  return o.f.f && status >= 400 ? 22 : 0;
}

// ---- small ones

function cmdDate(w, io) {
  io.out.push(fmtDate(w.nowMs));
  return 0;
}

function cmdId(w, io) {
  const u = w.users[w.user];
  io.out.push(`uid=${u.uid}(${w.user}) gid=${u.uid}(${u.groups[0]}) groups=${u.groups.map((g, i) => `${i === 0 ? u.uid : 27}(${g})`).join(',')}`);
  return 0;
}

function cmdHelp(w, io) {
  io.out.push(
    'Night Shift runs a small set of real commands against a simulated server.',
    '',
    'Look (free):  ls -l  cat  head  tail  grep  sed -n  awk  sort  uniq -c  wc -l  find  du -sh  df -h',
    '              ps aux  top  uptime  free -h  ss -tlnp  curl -I  systemctl status  journalctl -u',
    'Change (a move, and a minute passes):  chmod  chown  kill  pkill  rm  truncate  cp  mv  mkdir',
    '              sed -i  echo ... > file  systemctl start|stop|restart|reload|enable|daemon-reload',
    'Shell:        | pipes   > >> redirection   && || ;   $?   $(...)   globs   cd  pwd',
    'Scripts:      ./script.sh  bash script.sh',
    '',
    'Reading never costs a move. Do not guess: follow the order in the notes (status, logs, resources, network).',
  );
  return 0;
}

// ---- scripts

export function scriptHardened(lines) {
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^set\s+-[a-zA-Z]*e/.test(t)) return true;
    return false;
  }
  return false;
}

function runScript(w, io, path, args) {
  const n = w.fs[path];
  const run = n.run || {};
  if (run.kind === 'backup') {
    const src = args[0] ?? run.defaultSrc;
    const dest = args[1] ?? run.defaultDest;
    const hard = scriptHardened(fileLines(n));
    const stamp = new Date(w.nowMs).toISOString().slice(0, 10).replace(/-/g, '');
    const archive = `${dest}/${run.name || 'data'}-${stamp}.tar.gz`;
    const srcAbs = resolvePath(w, src);
    if (!isDir(w, srcAbs)) {
      io.err.push(`tar: ${src}: Cannot open: No such file or directory`, 'tar: Error is not recoverable: exiting now');
      if (hard) return 2;
      if (isDir(w, resolvePath(w, dest))) {
        const a = addFile(w, resolvePath(w, archive), { o: 'root', ago: 0, size: 45 });
        a.mt = w.nowMs;
      }
      io.out.push(`backup ok: ${archive}`);
      changed(w);
      return 0;
    }
    const a = addFile(w, resolvePath(w, archive), { o: 'root', ago: 0, size: Math.max(1024, Math.round(treeSize(w, srcAbs) * 0.55)) });
    a.mt = w.nowMs;
    io.out.push(`backup ok: ${archive}`);
    changed(w);
    return 0;
  }
  if (run.kind === 'print') {
    io.out.push(...(run.out || []));
    return run.code ?? 0;
  }
  return 0;
}

function execPath(w, io, shown, args, viaShell) {
  const abs = resolvePath(w, shown);
  const n = w.fs[abs];
  if (!n) {
    io.err.push(`bash: ${shown}: No such file or directory`);
    return 127;
  }
  if (n.t === 'd') {
    io.err.push(`bash: ${shown}: Is a directory`);
    return 126;
  }
  if (viaShell) {
    if (!can(w, n, w.user, 4)) {
      io.err.push(`${viaShell}: ${shown}: Permission denied`);
      return 126;
    }
    looked(w, `read:${abs}`);
  } else if (!can(w, n, w.user, 1)) {
    io.err.push(`bash: ${shown}: Permission denied`);
    return 126;
  }
  return runScript(w, io, abs, args);
}

// ---------------------------------------------------------------- dispatcher

const SIMPLE = {
  ls: cmdLs,
  cat: (w, io, a) => cmdCat(w, io, a, 'cat'),
  less: (w, io, a) => cmdCat(w, io, a, 'less'),
  head: (w, io, a) => cmdHeadTail(w, io, a, 'head'),
  tail: (w, io, a) => cmdHeadTail(w, io, a, 'tail'),
  grep: cmdGrep,
  egrep: (w, io, a) => cmdGrep(w, io, ['-E', ...a]),
  sed: cmdSed,
  awk: cmdAwk,
  sort: cmdSort,
  uniq: cmdUniq,
  wc: cmdWc,
  cut: cmdCut,
  echo: cmdEcho,
  cd: cmdCd,
  du: cmdDu,
  df: cmdDf,
  free: cmdFree,
  uptime: cmdUptime,
  ps: cmdPs,
  top: cmdTop,
  pgrep: cmdPgrep,
  kill: cmdKill,
  pkill: cmdPkill,
  chmod: cmdChmod,
  chown: cmdChown,
  rm: cmdRm,
  truncate: cmdTruncate,
  cp: (w, io, a) => cmdCpMv(w, io, a, 'cp'),
  mv: (w, io, a) => cmdCpMv(w, io, a, 'mv'),
  mkdir: cmdMkdir,
  touch: cmdTouch,
  systemctl: cmdSystemctl,
  journalctl: cmdJournalctl,
  ss: cmdSs,
  curl: cmdCurl,
  date: cmdDate,
  id: cmdId,
  help: cmdHelp,
  pwd: (w, io) => {
    io.out.push(w.cwd);
    return 0;
  },
  whoami: (w, io) => {
    io.out.push(w.user);
    return 0;
  },
  hostname: (w, io) => {
    io.out.push(w.host);
    return 0;
  },
  nproc: (w, io) => {
    io.out.push(String(w.cores));
    return 0;
  },
  true: () => 0,
  false: () => 1,
  ':': () => 0,
  export: (w, io, a) => {
    for (const x of a) {
      const m = /^(\w+)=(.*)$/.exec(x);
      if (m) w.env[m[1]] = m[2];
    }
    return 0;
  },
  exit: (w, io) => {
    io.out.push('logout: there is nowhere to go, the shift ends when the pager is quiet.');
    return 0;
  },
};

function dispatch(w, name, args, io, depth = 0) {
  if (depth > 4) {
    io.err.push('bash: too much recursion');
    return 1;
  }
  const run = (n, a, sub) => dispatch(w, n, a, sub, depth + 1);
  if (name === 'sudo') {
    const rest = [...args];
    while (rest[0] && rest[0].startsWith('-')) rest.shift();
    if (!rest.length) {
      io.err.push('usage: sudo command');
      return 1;
    }
    return dispatch(w, rest[0], rest.slice(1), io, depth + 1);
  }
  if (name === 'xargs') {
    const o = getopt(args, 'nI');
    if (!o.rest.length) o.rest.push('echo');
    const tokens = (io.in ?? []).flatMap((l) => l.split(/\s+/)).filter(Boolean);
    const [cmd, ...fixed] = o.rest;
    const sub = { in: null, out: [], err: [] };
    const code = tokens.length || o.f.r ? run(cmd, [...fixed, ...tokens], sub) : 0;
    io.out.push(...sub.out);
    io.err.push(...sub.err);
    return code;
  }
  if (name === 'find') {
    try {
      return cmdFind(w, io, args, run);
    } catch (e) {
      io.err.push(`find: ${e.message}`);
      return 1;
    }
  }
  if (name === 'bash' || name === 'sh') {
    const o = args.indexOf('-c');
    if (o >= 0) {
      const text = args[o + 1] ?? '';
      const out = captureLine(w, text);
      io.out.push(...out);
      return w.lastCode;
    }
    const file = args.find((a) => !a.startsWith('-'));
    if (!file) return 0;
    return execPath(w, io, file, args.slice(args.indexOf(file) + 1), name);
  }
  if (name.includes('/')) return execPath(w, io, name, args, null);
  const fn = SIMPLE[name];
  if (fn) return fn(w, io, args);
  if (ELSEWHERE[name]) {
    const [why, link] = ELSEWHERE[name];
    w.term.push({ kind: 'hint', text: `${name}: not in this sim. ${why}`, link: link || undefined });
    return 127;
  }
  io.err.push(`bash: ${name}: command not found`);
  return 127;
}

// ---------------------------------------------------------------- running a line

function captureLine(w, text) {
  const cap = [];
  execList(w, parse(lex(text)), cap);
  return cap;
}

function flushErr(w, lines) {
  for (const l of lines) say(w, 'err', l);
}

function runPipeline(w, pipe, capture) {
  let stdin = null;
  let code = 0;
  const run = (text) => captureLine(w, text).join('\n');
  const saved = w.pipelineCmds;
  w.pipelineCmds = pipe.length > 1 ? pipe.map((c) => c.words.map((s) => s.map((x) => x.s).join('')).join(' ')) : [];
  pipe.forEach((cmd, idx) => {
    const last = idx === pipe.length - 1;
    const io = { in: stdin, out: [], err: [], piped: !last };
    let words = cmd.words.flatMap((segs) => expandWord(w, segs, run));
    // Plain assignments: FOO=bar
    while (words.length && /^[A-Za-z_]\w*=/.test(words[0]) && cmd.words.length) {
      const m = /^([A-Za-z_]\w*)=(.*)$/.exec(words.shift());
      w.env[m[1]] = m[2];
    }
    let outTarget = null;
    let errTarget = null;
    let errToOut = false;
    for (const r of cmd.redirs) {
      if (r.op === '2>&1') errToOut = true;
      else {
        const target = r.target ? expandWord(w, r.target, run)[0] : '';
        if (r.op === '<') {
          const abs = resolvePath(w, target);
          const n = w.fs[abs];
          if (!n || n.t !== 'f') {
            io.err.push(`bash: ${target}: No such file or directory`);
          } else {
            looked(w, `read:${abs}`);
            io.in = fileLines(n);
          }
        } else if (r.op === '2>' || r.op === '2>>') errTarget = { path: target, append: r.op === '2>>' };
        else if (r.op === '&>' || r.op === '&>>') {
          outTarget = { path: target, append: r.op === '&>>' };
          errToOut = true;
        } else outTarget = { path: target, append: r.op === '>>' };
      }
    }
    let c = 0;
    if (io.err.length) c = 1;
    else if (words.length) c = dispatch(w, words[0], words.slice(1), io);
    // Output not caught by a redirect.
    if (errToOut && !errTarget) io.out.push(...io.err.splice(0));
    if (outTarget) {
      const ok = writeFile(w, { err: io.err }, 'bash', outTarget.path, io.out, outTarget.append);
      if (!ok) c = 1;
      io.out = [];
    }
    if (errTarget) {
      writeFile(w, { err: [] }, 'bash', errTarget.path, io.err, errTarget.append);
      io.err = [];
    }
    flushErr(w, io.err);
    if (last) {
      if (capture) capture.push(...io.out);
      else for (const l of io.out) say(w, 'out', l);
      code = c;
    } else stdin = io.out;
  });
  w.pipelineCmds = saved;
  return code;
}

function execList(w, list, capture) {
  for (const item of list) {
    if (item.op === '&&' && w.lastCode !== 0) continue;
    if (item.op === '||' && w.lastCode === 0) continue;
    w.lastCode = runPipeline(w, item.pipe, capture);
    if (w.dead) return;
  }
}

// Run one command line. Returns { moved, ok } and appends the output to w.term.
export function runLine(w, line) {
  w.moved = false;
  const text = line.trim();
  say(w, 'cmd', `${w.prompt()} ${text}`);
  if (w.term.length > 600) w.term.splice(0, w.term.length - 500);
  if (text === 'clear') {
    w.term = [];
    return { moved: false, ok: true };
  }
  try {
    execList(w, parse(lex(text)), null);
  } catch (e) {
    if (e instanceof ShellError) {
      say(w, 'err', `bash: ${e.message}`);
      w.lastCode = 2;
    } else throw e;
  }
  return { moved: w.moved, ok: w.lastCode === 0 };
}

// ---------------------------------------------------------------- tab completion

export function complete(w, line) {
  const m = /(^|\s)([^\s]*)$/.exec(line);
  const word = m ? m[2] : '';
  const before = line.slice(0, line.length - word.length);
  const first = before.trim() === '' || /(\||&&|\|\||;)\s*$/.test(before);
  let candidates = [];
  if (first && !word.includes('/')) candidates = COMMAND_NAMES.filter((c) => c.startsWith(word));
  else {
    const words = before.trim().split(/\s+/);
    const cmd = words[0];
    if (cmd === 'systemctl' && words.length === 1) candidates = ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'daemon-reload', 'is-active'].filter((c) => c.startsWith(word));
    else if ((cmd === 'systemctl' && words.length >= 2) || words[words.length - 1] === '-u') candidates = Object.keys(w.units).filter((c) => c.startsWith(word));
    else {
      const slash = word.lastIndexOf('/');
      const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
      const dir = resolvePath(w, dirPart || '.');
      const stem = word.slice(slash + 1);
      if (isDir(w, dir)) {
        candidates = children(w, dir)
          .map((p) => basename(p) + (isDir(w, p) ? '/' : ''))
          .filter((n) => n.startsWith(stem) && (stem.startsWith('.') || !n.startsWith('.')))
          .map((n) => dirPart + n);
      }
    }
  }
  if (!candidates.length) return { line, options: [] };
  let prefix = candidates[0];
  for (const c of candidates) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const done = candidates.length === 1 && !prefix.endsWith('/');
  return { line: `${before}${prefix}${done ? ' ' : ''}`, options: candidates.length > 1 ? candidates : [] };
}

export { NOTES };
