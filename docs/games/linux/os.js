// The in-memory Linux box behind "Night Shift": a filesystem, a process table, systemd units, a disk,
// a journal and sockets. Pure data and helpers, no DOM, so it runs in Node. shell.js interprets
// commands against it and sim.js adds the incidents; hooks (`w.hooks`) let this layer report a
// blast-radius event without knowing about the game rules.
//
// What it models is what topics/linux/notes teach: ls -l permission triplets, kill signals, df/du
// (and the open-file gotcha: deleting a file a process still holds frees nothing), systemd units
// (daemon-reload, Restart=on-failure crash loops, journalctl) and ss/curl.

const UNITS = { k: 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- numbers and dates

export function parseSize(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)([kKMGT]?)$/.exec(String(v).trim());
  if (!m) return NaN;
  return Math.round(Number(m[1]) * (m[2] ? UNITS[m[2]] : 1));
}

// GNU `-h` sizes: powers of 1024, rounded up, one decimal below 10.
export function human(bytes) {
  if (bytes < 1024) return String(bytes);
  const suffix = ['K', 'M', 'G', 'T'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < suffix.length - 1) {
    v /= 1024;
    i += 1;
  }
  const tenth = Math.ceil(v * 10) / 10;
  return (tenth < 10 ? tenth.toFixed(1) : String(Math.ceil(v))) + suffix[i];
}

export function fmtLs(ms, now) {
  const d = new Date(ms);
  const old = now - ms > 182 * 86400000 || ms > now;
  const day = String(d.getUTCDate()).padStart(2);
  return old ? `${MON[d.getUTCMonth()]} ${day}  ${d.getUTCFullYear()}` : `${MON[d.getUTCMonth()]} ${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

export const fmtJournal = (ms) => {
  const d = new Date(ms);
  return `${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
};

export const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
};

export const fmtSince = (ms) => {
  const d = new Date(ms);
  return `${DOW[d.getUTCDay()]} ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
};

export const fmtHttpDate = (ms) => {
  const d = new Date(ms);
  return `${DOW[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT`;
};

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}min ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ${h % 24}h ago`;
}

const startCol = (ms, now) => {
  const a = new Date(ms);
  const b = new Date(now);
  const sameDay = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  return sameDay ? `${p2(a.getUTCHours())}:${p2(a.getUTCMinutes())}` : `${MON[a.getUTCMonth()]}${p2(a.getUTCDate())}`;
};

// ---------------------------------------------------------------- paths

export const dirname = (p) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')));
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

export function resolvePath(w, p) {
  let path = p;
  if (p === '~' || p.startsWith('~/')) path = w.env.HOME + p.slice(1);
  else if (!p.startsWith('/')) path = `${w.cwd}/${p}`;
  const out = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

const sortKey = (p) => basename(p).replace(/^\./, '').toLowerCase();
export const collate = (a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : a < b ? -1 : a > b ? 1 : 0);

export function sortPaths(paths) {
  const segs = (p) => p.split('/').map((s) => s.replace(/^\./, '').toLowerCase());
  return [...paths].sort((a, b) => {
    const x = segs(a);
    const y = segs(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === undefined) return -1;
      if (y[i] === undefined) return 1;
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return 0;
  });
}

// ---------------------------------------------------------------- filesystem

export const exists = (w, p) => p in w.fs;
export const isDir = (w, p) => w.fs[p]?.t === 'd';

export const children = (w, dir) => {
  const prefix = dir === '/' ? '/' : `${dir}/`;
  return Object.keys(w.fs)
    .filter((k) => k !== dir && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
    .sort(collate);
};

export const descendants = (w, dir) => {
  const prefix = dir === '/' ? '/' : `${dir}/`;
  return sortPaths(Object.keys(w.fs).filter((k) => k !== dir && k.startsWith(prefix)));
};

export const fileLines = (n) => n.lines || [];

export function sizeOf(n) {
  if (n.t === 'd') return 4096;
  if (n.size !== undefined) return n.size;
  return n.lines.length ? n.lines.join('\n').length + 1 : 0;
}

// Disk usage as `du` reports it: whole 4K blocks per file and directory.
const blocks = (n) => Math.max(4096, Math.ceil(sizeOf(n) / 4096) * 4096);

export function treeSize(w, path, onDisk = false) {
  const one = onDisk ? blocks : sizeOf;
  let total = one(w.fs[path]);
  for (const k of descendants(w, path)) total += one(w.fs[k]);
  return total;
}

export function mkdirp(w, abs, spec = {}) {
  const parts = abs.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += `/${part}`;
    if (!w.fs[cur]) w.fs[cur] = { t: 'd', mode: 0o755, o: spec.o ?? 'root', g: spec.g ?? spec.o ?? 'root', mt: w.nowMs - 30 * 86400000 };
  }
}

export function addFile(w, path, spec = {}) {
  mkdirp(w, dirname(path));
  w.fs[path] = {
    t: 'f',
    mode: parseInt(spec.m ?? '644', 8),
    o: spec.o ?? 'root',
    g: spec.g ?? spec.o ?? 'root',
    mt: w.nowMs - (spec.ago ?? 7) * 86400000,
    lines: spec.lines ? [...spec.lines] : [],
    size: spec.size !== undefined ? parseSize(spec.size) : undefined,
    run: spec.run,
    crit: Boolean(spec.crit),
    held: [],
  };
  return w.fs[path];
}

export const fileText = (w, path) => (w.fs[path] ? fileLines(w.fs[path]).join('\n') : '');

export function modeString(n) {
  const bits = ['r', 'w', 'x'];
  let s = n.t === 'd' ? 'd' : '-';
  for (let i = 8; i >= 0; i--) s += n.mode & (1 << i) ? bits[(8 - i) % 3] : '-';
  if (n.mode & 0o1000) s = `${s.slice(0, 9)}${s[9] === 'x' ? 't' : 'T'}`;
  return s;
}

export const userGroups = (w, user) => w.users[user]?.groups || [user];

// Can `user` use permission `bit` (4 read, 2 write, 1 execute) on this node?
export function can(w, n, user, bit) {
  if (user === 'root') return bit !== 1 || n.t === 'd' || (n.mode & 0o111) !== 0;
  if (n.o === user) return Boolean(n.mode & (bit << 6));
  if (userGroups(w, user).includes(n.g)) return Boolean(n.mode & (bit << 3));
  return Boolean(n.mode & bit);
}

// ---------------------------------------------------------------- disk

export function diskUsed(w) {
  let used = w.disk.base;
  for (const k in w.fs) used += sizeOf(w.fs[k]);
  for (const d of w.deleted) used += d.size;
  return Math.min(used, w.disk.size);
}

export const diskAvail = (w) => Math.max(0, w.disk.size - diskUsed(w));
export const diskPct = (w) => Math.ceil((100 * diskUsed(w)) / w.disk.size);
export const diskFull = (w) => diskAvail(w) < 64 * 1024 * 1024;

// Space held by deleted-but-still-open files comes back once every holder has exited.
export function releaseDeleted(w) {
  w.deleted = w.deleted.filter((d) => d.holders.some((pid) => w.procs.some((p) => p.pid === pid)));
}

// ---------------------------------------------------------------- processes

export function spawn(w, spec) {
  const p = {
    pid: spec.pid ?? w.nextPid,
    ppid: spec.ppid ?? 1,
    user: spec.user ?? 'root',
    cpu: spec.cpu ?? 0,
    mem: spec.mem ?? 0.1,
    vsz: spec.vsz ?? 12000,
    rss: spec.rss ?? 3000,
    tty: spec.tty ?? '?',
    stat: spec.stat ?? 'S',
    startMs: spec.startMs ?? w.nowMs - (spec.agoDays ?? 20) * 86400000,
    time: spec.time ?? '0:00',
    cmd: spec.cmd,
    unit: spec.unit,
    term: spec.term ?? 'exit',
    cleanup: spec.cleanup,
    load: spec.load,
    holds: spec.holds ?? [],
    listen: spec.listen,
    http: spec.http,
    critical: Boolean(spec.critical),
    termSent: false,
    fd: spec.fd,
  };
  if (p.pid >= w.nextPid) w.nextPid = p.pid + 1;
  w.procs.push(p);
  for (const path of p.holds) {
    const n = w.fs[path] || addFile(w, path, { o: p.user, ago: 0 });
    n.held = [p.pid];
  }
  return p;
}

export const findProc = (w, pid) => w.procs.find((p) => p.pid === pid);

// Remove a process (and its children). `how` is 'term', 'kill' or 'stop'; the unit it belonged to
// reacts according to its Restart= policy.
export function procExit(w, p, how = 'term') {
  const gone = [p, ...w.procs.filter((c) => c.ppid === p.pid && c.pid !== p.pid)];
  w.procs = w.procs.filter((x) => !gone.includes(x));
  releaseDeleted(w);
  if (!p.unit) return;
  const u = w.units[p.unit];
  if (!u || u.pid !== p.pid) return;
  u.pid = null;
  u.sinceMs = w.nowMs;
  if (how === 'stop') {
    u.active = 'inactive';
    u.sub = 'dead';
    u.result = null;
    u.code = null;
    return;
  }
  const policy = u.loaded.restart;
  const again = policy === 'always' || (policy === 'on-failure' && how === 'kill');
  const sig = how === 'kill' ? '9/KILL' : '15/TERM';
  jlog(w, u.name, 'systemd', `${u.name}.service: Main process exited, code=${how === 'kill' ? 'killed' : 'exited'}, status=${sig}`, 1);
  if (again) {
    u.active = 'activating';
    u.sub = 'auto-restart';
    u.result = 'signal';
    u.code = sig;
    jlog(w, u.name, 'systemd', `${u.name}.service: Scheduled restart job, restart counter is at ${u.restarts + 1}.`, 1);
  } else {
    u.active = how === 'kill' ? 'failed' : 'inactive';
    u.sub = how === 'kill' ? 'failed' : 'dead';
    u.result = how === 'kill' ? 'signal' : null;
    u.code = how === 'kill' ? sig : null;
  }
}

export function loadAverageTarget(w) {
  let load = w.load.base;
  for (const p of w.procs) load += p.load ?? p.cpu / 100;
  return Math.round(load * 100) / 100;
}

// ---------------------------------------------------------------- journal

export function jlog(w, unit, ident, msg, pid) {
  const list = (w.journal[unit] ||= []);
  list.push({ ms: w.nowMs, ident, pid, msg });
  if (list.length > 400) list.shift();
}

export const journalLine = (w, e) => `${fmtJournal(e.ms)} ${w.host} ${e.ident}${e.pid ? `[${e.pid}]` : ''}: ${e.msg}`;

// ---------------------------------------------------------------- config files and systemd units

// `key = value` or `key: value`; comments and blank lines ignored.
export function readConf(w, path) {
  const out = {};
  for (const line of fileLines(w.fs[path] || { lines: [] })) {
    const m = /^\s*([A-Za-z_][\w.-]*)\s*[:=]\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

export function parseUnitFile(lines) {
  const o = {};
  for (const l of lines) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(l);
    if (m) o[m[1]] = m[2];
  }
  return { desc: o.Description || '', exec: o.ExecStart || '', restart: o.Restart || 'no', user: o.User || 'root' };
}

export function snapshotUnit(w, u) {
  u.loadedText = fileText(w, u.file);
  u.loaded = parseUnitFile(fileLines(w.fs[u.file] || { lines: [] }));
}

export const unitChangedOnDisk = (w, u) => fileText(w, u.file) !== u.loadedText;

const confArg = (cmd) => {
  const t = cmd.split(/\s+/);
  for (let i = 0; i < t.length; i++) {
    if ((t[i] === '--config' || t[i] === '-c') && t[i + 1]) return t[i + 1];
    if (t[i].startsWith('--config=')) return t[i].slice(9);
  }
  return null;
};

export function createUnit(w, name, spec) {
  const file = spec.file || `/etc/systemd/system/${name}.service`;
  if (spec.unitFile) addFile(w, file, { lines: spec.unitFile, ago: spec.fileAgo ?? 20 });
  const u = {
    name,
    file,
    enabled: spec.enabled !== false,
    active: 'inactive',
    sub: 'dead',
    result: null,
    code: null,
    pid: null,
    sinceMs: w.nowMs - 86400000 * 3,
    restarts: spec.restarts ?? 0,
    proc: spec.proc || {},
    confs: spec.confs || [],
    checks: spec.checks || {},
    reloadable: Boolean(spec.reloadable),
    fixedPid: spec.proc?.pid ?? null,
    fixedKids: true,
    running: {},
    desc: spec.desc,
  };
  w.units[name] = u;
  snapshotUnit(w, u);
  if (spec.journal) for (const [m, ident, msg, pid] of spec.journal) w.journal[name] = [...(w.journal[name] || []), { ms: w.nowMs - m * 60000, ident, pid, msg }];
  return u;
}

// Try to start a unit the way systemd would, using the *loaded* unit (not the file on disk).
// Returns { ok, job } where job is true for failures `systemctl start` reports itself (203/EXEC).
export function startUnit(w, u, { quiet = false } = {}) {
  const exec = u.loaded.exec;
  const tokens = exec.split(/\s+/).filter(Boolean);
  const bin = tokens[0];
  const fail = (code, lines, job) => {
    u.restarts += quiet ? 0 : 1;
    const lastPid = (u.lastPid = w.nextPid++);
    u.result = 'exit-code';
    u.code = code;
    u.sinceMs = w.nowMs;
    const restart = u.loaded.restart;
    if (restart === 'on-failure' || restart === 'always') {
      u.active = 'activating';
      u.sub = 'auto-restart';
    } else {
      u.active = 'failed';
      u.sub = 'failed';
    }
    for (const [ident, msg] of lines) jlog(w, u.name, ident, msg, ident === 'systemd' ? 1 : lastPid);
    jlog(w, u.name, 'systemd', `${u.name}.service: Failed with result 'exit-code'.`, 1);
    if (u.active === 'activating') jlog(w, u.name, 'systemd', `${u.name}.service: Scheduled restart job, restart counter is at ${u.restarts}.`, 1);
    return { ok: false, job };
  };
  const bn = w.fs[bin];
  if (!bn) return fail('203/EXEC', [['systemd', `${u.name}.service: Failed to execute ${bin}: No such file or directory`], ['systemd', `${u.name}.service: Failed at step EXEC spawning ${bin}: No such file or directory`]], true);
  if (!can(w, bn, u.loaded.user, 1)) return fail('203/EXEC', [['systemd', `${u.name}.service: Failed to execute ${bin}: Permission denied`], ['systemd', `${u.name}.service: Failed at step EXEC spawning ${bin}: Permission denied`]], true);

  const conf = confArg(exec);
  if (conf && !w.fs[conf]) return fail('1/FAILURE', [[u.name, `fatal: cannot open config ${conf}: no such file or directory`], ['systemd', `${u.name}.service: Main process exited, code=exited, status=1/FAILURE`]]);
  for (const dir of u.checks.writes || []) {
    const dn = w.fs[dir];
    if (!dn || !can(w, dn, u.loaded.user, 2)) return fail('1/FAILURE', [[u.name, `fatal: cannot write to ${dir}: permission denied`], ['systemd', `${u.name}.service: Main process exited, code=exited, status=1/FAILURE`]]);
  }
  let listen = u.proc.listen || null;
  if (listen === 'conf' && conf) {
    const c = readConf(w, conf);
    listen = { addr: c.bind || c.listen_addr || '0.0.0.0', port: Number(c.port || c.listen_port || 0) };
  }
  if (listen && w.procs.some((p) => p.listen && p.listen.port === listen.port && p.unit !== u.name && (p.listen.addr === listen.addr || p.listen.addr === '0.0.0.0'))) {
    return fail('1/FAILURE', [[u.name, `fatal: listen ${listen.addr}:${listen.port}: address already in use`], ['systemd', `${u.name}.service: Main process exited, code=exited, status=1/FAILURE`]]);
  }

  const main = spawn(w, { ...u.proc, user: u.loaded.user, cmd: u.proc.cmd ?? exec, unit: u.name, listen: listen || undefined, startMs: w.nowMs, time: '0:00', agoDays: undefined, ppid: 1, pid: u.fixedPid ?? undefined });
  u.fixedPid = null;
  for (const extra of u.proc.children || []) spawn(w, { ...extra, user: extra.user ?? u.loaded.user, ppid: main.pid, unit: undefined, startMs: w.nowMs, pid: u.fixedKids ? extra.pid : undefined });
  u.fixedKids = false;
  u.pid = main.pid;
  u.active = 'active';
  u.sub = 'running';
  u.result = null;
  u.code = null;
  u.sinceMs = w.nowMs - 2000;
  u.running = Object.fromEntries(u.confs.map((c) => [c, fileText(w, c)]));
  jlog(w, u.name, 'systemd', `Started ${u.desc || u.name}.`, 1);
  return { ok: true };
}

export function stopUnit(w, u) {
  for (const p of [...w.procs].filter((x) => x.unit === u.name)) procExit(w, p, 'stop');
  u.active = 'inactive';
  u.sub = 'dead';
  u.result = null;
  u.code = null;
  u.sinceMs = w.nowMs;
  jlog(w, u.name, 'systemd', `Stopped ${u.desc || u.name}.`, 1);
}

// One minute passes: units that are waiting to restart try again.
export function retryUnits(w) {
  for (const u of Object.values(w.units)) {
    if (u.active !== 'activating') continue;
    startUnit(w, u);
  }
}

// ---------------------------------------------------------------- sockets

export function listeners(w) {
  return w.procs
    .filter((p) => p.listen)
    .map((p) => ({ proc: p, addr: p.listen.addr, port: p.listen.port, proto: p.listen.proto || 'tcp' }))
    .sort((a, b) => a.port - b.port);
}
