// "Night Shift": the rules on top of the simulated server (os.js) and its shell (shell.js). Pure logic, no DOM,
// importable from Node.
//
// Time is turn-based. Reading is free: ls, cat, grep, ps, df, systemctl status... never cost a move and never
// advance the clock. A command line that changes the machine (chmod, kill, rm, sed -i, systemctl restart, a
// redirect that writes a file) is one move and one minute: the pager keeps ringing, every open incident costs
// service health each minute, and new incidents arrive on the level's schedule.
//
// Incidents are state, not scripts: each one is a condition on the machine ("deploy.sh is executable by the
// deploy user", "no process 2291", "the disk is under 90%"). Any fix that makes the condition true clears it, and
// a fix that does not (deleting a log a process still has open) leaves it open. Blast-radius mistakes (killing PID
// 1, rm -rf of a system directory) end the level; smaller ones cost health and link to the note that explains them.
import {
  addFile, basename, can, createUnit, diskPct, dirname, fileLines, isDir, loadAverageTarget, mkdirp, parseSize, resolvePath, retryUnits, spawn, startUnit, stopUnit,
} from './os.js';
import { complete as completeLine, runLine, scriptHardened } from './shell.js';

const FREE_H = [
  '               total        used        free      shared  buff/cache   available',
  'Mem:           3.8Gi       1.8Gi       412Mi        24Mi       1.6Gi       1.8Gi',
  'Swap:             0B          0B          0B',
];
const FREE_KB = [
  '               total        used        free      shared  buff/cache   available',
  'Mem:         4018372     1874512      421888       24576     1721972     1884160',
  'Swap:              0           0           0',
];
const TOP_MEM = ['MiB Mem :   3924.1 total,    412.0 free,   1830.5 used,   1681.6 buff/cache', 'MiB Swap:      0.0 total,      0.0 free,      0.0 used.   1840.2 avail Mem'];

const clone = (o) => JSON.parse(JSON.stringify(o));

function prng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- generated files

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');

// An nginx "combined" access log: one noisy-but-healthy client, one client that causes most of the 500s, and
// background traffic with a couple of stray errors. No byte count contains "500", so `grep 500` only finds
// real 500s (and the status column is field 9, as in the real format).
function genAccessLog(g, nowMs) {
  const rnd = prng(g.seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const agents = ['Mozilla/5.0 (X11; Linux x86_64) Firefox/118.0', 'Mozilla/5.0 (Macintosh) Safari/605.1.15', 'curl/8.4.0', 'python-requests/2.31.0'];
  const pages = ['/', '/api/items', '/api/items/42', '/api/login', '/static/app.js', '/favicon.ico', '/api/cart'];
  const start = nowMs - g.spanMin * 60000;
  const size = () => {
    for (;;) {
      const n = 180 + Math.floor(rnd() * 9000);
      if (!String(n).includes('500')) return n;
    }
  };
  const lines = [];
  const strays = new Set([Math.floor(g.lines * 0.31), Math.floor(g.lines * 0.74)]);
  for (let i = 0; i < g.lines; i++) {
    const d = new Date(start + (i * g.spanMin * 60000) / g.lines);
    const stamp = `${p2(d.getUTCDate())}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
    const roll = rnd();
    let ip;
    let req;
    let status;
    let ua;
    let bytes;
    if (roll < 0.27) {
      ip = g.busy;
      req = 'GET /healthz HTTP/1.1';
      status = 200;
      ua = 'kube-probe/1.28';
      bytes = 2;
    } else if (roll < 0.5) {
      ip = g.bad;
      req = `GET /api/export?batch=${100 + Math.floor(rnd() * 800)} HTTP/1.1`;
      status = rnd() < 0.85 ? 500 : 200;
      ua = 'batch-sync/2.3';
      bytes = status === 500 ? 177 : size();
    } else {
      ip = pick(g.clients);
      req = `GET ${pick(pages)} HTTP/1.1`;
      status = rnd() < 0.9 ? 200 : pick([304, 404]);
      ua = pick(agents);
      bytes = size();
    }
    if (strays.has(i)) {
      ip = pick(g.clients);
      req = 'POST /api/login HTTP/1.1';
      status = 500;
      bytes = 177;
    }
    lines.push(`${ip} - - [${stamp}] "${req}" ${status} ${bytes} "-" "${ua}"`);
  }
  return lines;
}

// ---------------------------------------------------------------- world

const merge = (a = {}, b = {}) => ({ ...a, ...b });

export function createWorld(sc, into = {}) {
  const base = sc.base || {};
  const level = sc.world || {};
  const machine = merge(base.machine, level.machine);
  const nowMs = Date.parse(machine.clock);
  const w = Object.assign(into, {
    host: machine.host,
    user: machine.user,
    ip: machine.ip,
    cwd: machine.cwd,
    env: { HOME: `/home/${machine.user}`, USER: machine.user, SHELL: '/bin/bash', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    lastCode: 0,
    nowMs,
    minute: 0,
    fs: { '/': { t: 'd', mode: 0o755, o: 'root', g: 'root', mt: nowMs - 90 * 86400000 } },
    procs: [],
    nextPid: machine.nextPid ?? 4100,
    units: {},
    journal: {},
    users: merge(base.users, level.users),
    deleted: [],
    disk: { ...machine.disk, size: parseSize(machine.disk.size), base: parseSize(machine.disk.base) },
    load: { base: machine.loadBase ?? 0.3, avg: [0, 0, 0] },
    cores: machine.cores ?? 4,
    uptime: machine.uptime,
    freeText: FREE_H,
    freeTextKb: FREE_KB,
    topMem: TOP_MEM,
    health: 100,
    minHealth: sc.minHealth ?? 40,
    winTicks: sc.winTicks,
    seen: new Set(),
    open: [],
    pending: clone(sc.schedule || []),
    startWith: clone(sc.startWith || []),
    pager: [],
    term: [],
    dead: null,
    moved: false,
    penalized: new Set(),
    pipelineCmds: [],
    ctx: null,
    seq: 0,
  });
  w.prompt = () => {
    const home = w.env.HOME;
    const where = w.cwd === home ? '~' : w.cwd.startsWith(`${home}/`) ? `~${w.cwd.slice(home.length)}` : w.cwd;
    return `${w.user}@${w.host}:${where}$`;
  };
  const dirs = merge(base.dirs, level.dirs);
  for (const [path, spec] of Object.entries(dirs)) {
    mkdirp(w, path, { o: spec.o, g: spec.g });
    const n = w.fs[path];
    if (spec.m) n.mode = parseInt(spec.m, 8);
    n.o = spec.o ?? n.o;
    n.g = spec.g ?? spec.o ?? n.g;
  }
  const files = merge(base.fs, level.fs);
  for (const [path, spec] of Object.entries(files)) {
    const s = { ...spec };
    if (s.gen?.kind === 'access') s.lines = genAccessLog(s.gen, nowMs);
    addFile(w, path, s);
  }
  for (const spec of [...(base.procs || []), ...(level.procs || [])]) spawn(w, spec);
  const units = merge(base.units, level.units);
  for (const [name, spec] of Object.entries(units)) {
    const u = createUnit(w, name, spec);
    if (spec.state !== 'inactive') {
      startUnit(w, u, { quiet: true });
      if (u.active === 'active') {
        u.sinceMs = nowMs - (spec.upMin ?? 4000) * 60000;
        const p = w.procs.find((x) => x.pid === u.pid);
        if (p) {
          p.startMs = u.sinceMs;
          p.time = spec.proc?.time ?? p.time;
        }
      }
    }
  }
  const t = loadAverageTarget(w);
  w.load.avg = [t, t, t].map((x, i) => Math.round(x * [1, 0.97, 0.95][i] * 100) / 100);
  w.hooks = makeHooks(w);
  return w;
}

// ---------------------------------------------------------------- hooks the shell calls

function matches(targets, target) {
  return targets.some((t) => t === target || target.startsWith(`${t}/`) || t.startsWith(`${target}/`));
}

function penalize(w, id, hp, detail) {
  const key = `${id}:${detail}`;
  if (w.penalized.has(key) || !w.ctx) return;
  w.penalized.add(key);
  w.ctx.fire(id, detail);
  w.ctx.resolve(id);
  w.health = Math.max(0, w.health - hp);
  w.ctx.log(`-${hp} service health`, { kind: 'warn' });
}

function openLasting(w, id, detail, inc) {
  w.ctx.fire(id, detail);
  w.open.push({ id: `${id}#${w.seq++}`, event: id, cost: 1, targets: [], needs: [], label: detail, ...inc });
}

function makeHooks(w) {
  return {
    // Called before anything changes: was the player looking first?
    mutate(target) {
      for (const inc of w.open) {
        if (inc.blind || !inc.needs.length || !inc.targets.length) continue;
        if (!matches(inc.targets, target)) continue;
        if (inc.needs.some((tag) => w.seen.has(tag))) continue;
        inc.blind = true;
        penalize(w, 'blind-fix', 4, inc.event);
      }
    },
    penalize: (id, hp, detail) => penalize(w, id, hp, detail),
    fatal(id, detail) {
      if (w.dead) return;
      w.dead = id;
      w.health = 0;
      w.ctx.fire(id, detail);
      w.ctx.resolve(id);
    },
    modeChanged(path, mode) {
      if (mode & 0o002 && w.fs[path]?.t === 'f') penalize(w, 'wide-open-perms', 4, path);
    },
    deletedOpen(path) {
      openLasting(w, 'deleted-open-file', path, { cond: () => !w.deleted.some((d) => d.path === path), cost: 1, label: `${path} (deleted, still open)` });
    },
    killed(p, unitName) {
      if (unitName) collateral(w, unitName);
      else if (p.critical) penalize(w, 'killed-service', 6, basename(p.cmd.split(/\s+/)[0]).replace(/:$/, ''));
    },
    stopped(u, wasActive) {
      if (wasActive) collateral(w, u.name);
    },
    reloaded() {},
  };
}

// A healthy service went down because of something the player did: a penalty, and an incident (a page of its own)
// that clears when the service is running again. The event was already shown and explained by penalize().
function collateral(w, name) {
  const u = w.units[name];
  if (!u || w.open.some((i) => i.targets.includes(name) || i.unit === name)) return;
  penalize(w, 'killed-service', 6, name);
  pushFollowUp(w, 'killed-service', `${name} is down`, `monitor: ${name}.service is not running`, () => w.units[name].active === 'active', { unit: name, cost: 3 });
}

function pushFollowUp(w, event, label, page, cond, extra = {}) {
  const inc = { id: `${event}#${w.seq++}`, event, label, cond, cost: 2, targets: [], needs: [], ...extra };
  w.open.push(inc);
  w.pager.push({ id: inc.id, text: page, min: w.minute, state: 'open' });
}

// ---------------------------------------------------------------- incidents

const hasDeny = (w, unit, conf, ip) => (w.units[unit]?.running[conf] || '').split('\n').some((l) => l.trim() === `deny ${ip};`);

function setConf(w, path, kv) {
  const n = w.fs[path];
  const lines = [...fileLines(n)];
  for (const [k, v] of Object.entries(kv)) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*[:=]`).test(l));
    if (at >= 0) lines[at] = `${k} = ${v}`;
    else lines.push(`${k} = ${v}`);
  }
  n.lines = lines;
  n.mt = w.nowMs;
}

function spawnHog(w, it) {
  const s = it.spawn;
  spawn(w, { ...s, stat: s.stat ?? 'R', startMs: w.nowMs - 3 * 60000, time: s.time ?? '41:07' });
  const t = loadAverageTarget(w);
  w.load.avg = [t * 0.95, t * 0.7, t * 0.35];
  return {
    label: `${s.cmd.split(' ')[0].split('/').pop()} (PID ${s.pid}) is pinning the CPU`,
    detail: `load ${t.toFixed(1)}`,
    targets: [`pid:${s.pid}`],
    needs: ['ps', 'top'],
    cond: () => !w.procs.some((p) => p.pid === s.pid),
    cost: it.cost ?? 3,
  };
}

const KINDS = {
  'perm-denied': (w, it) => ({
    label: `${basename(it.path)} cannot be executed by ${it.user}`,
    detail: it.path,
    targets: [it.path],
    needs: [`ls:${it.path}`],
    cond: () => Boolean(w.fs[it.path]) && can(w, w.fs[it.path], it.user, 1),
    cost: it.cost ?? 2,
  }),
  runaway: spawnHog,
  'hung-process': spawnHog,
  'disk-full': (w, it) => {
    const n = w.fs[it.path];
    n.size = parseSize(it.size);
    if (!it.keepMtime) n.mt = w.nowMs - 60000;
    return {
      label: `${it.mount || '/'} is full`,
      detail: `${it.mount || '/'} at ${diskPct(w)}%`,
      targets: it.targets || [dirname(it.path)],
      needs: ['df', 'du', 'find'],
      cond: () => diskPct(w) <= 90,
      cost: it.cost ?? 3,
    };
  },
  'needle-500s': (w, it) => ({
    label: `500s from ${it.ip}`,
    detail: it.log,
    targets: [it.conf, dirname(it.conf), it.unit],
    needs: [`read:${it.log}`],
    unit: it.unit,
    cond: () => hasDeny(w, it.unit, it.conf, it.ip),
    // Blocking a healthy client is its own incident.
    check() {
      for (const ip of it.legit || []) {
        if (!hasDeny(w, it.unit, it.conf, ip) || w.penalized.has(`blocked-healthy:${ip}`)) continue;
        penalize(w, 'blocked-healthy', 8, ip);
        pushFollowUp(w, 'blocked-healthy', `${ip} is blocked`, `monitor: health checks from ${ip} are failing`, () => !hasDeny(w, it.unit, it.conf, ip), { targets: [it.conf, it.unit], unit: it.unit, cost: 2 });
      }
    },
  }),
  'crash-loop': (w, it) => ({
    label: `${it.unit}.service keeps restarting`,
    detail: `${it.unit}.service`,
    targets: [it.unit, ...(it.targets || [])],
    needs: [`status:${it.unit}`, `journal:${it.unit}`],
    unit: it.unit,
    cond: () => w.units[it.unit].active === 'active',
    cost: it.cost ?? 3,
  }),
  'unit-perm': (w, it) => {
    const dn = w.fs[it.dir];
    dn.o = 'root';
    dn.g = 'root';
    dn.mode = 0o755;
    dn.mt = w.nowMs;
    const u = w.units[it.unit];
    if (u.pid) stopUnit(w, u);
    startUnit(w, u);
    return {
      label: `${it.unit}.service keeps restarting`,
      detail: `${it.unit}.service`,
      targets: [it.unit, it.dir, ...(it.targets || [])],
      needs: [`status:${it.unit}`, `journal:${it.unit}`],
      unit: it.unit,
      cond: () => w.units[it.unit].active === 'active',
      cost: it.cost ?? 3,
    };
  },
  'nothing-listening': (w, it) => {
    setConf(w, it.conf, it.set);
    const u = w.units[it.unit];
    if (u.pid) stopUnit(w, u);
    startUnit(w, u);
    const owned = () => w.procs.some((p) => p.unit === it.unit && p.listen && p.listen.port === it.port && ['0.0.0.0', '::'].includes(p.listen.addr));
    return {
      label: `nothing answers on port ${it.port}`,
      detail: `${it.unit}: port ${it.port}`,
      targets: [it.unit, it.conf, dirname(it.conf)],
      needs: ['ss', 'curl'],
      unit: it.unit,
      cond: owned,
      cost: it.cost ?? 3,
    };
  },
  'backup-lies': (w, it) => {
    const srcOf = () => {
      const line = fileLines(w.fs[it.cron] || { lines: [] }).find((l) => l.includes(it.script));
      if (!line) return null;
      const after = line.slice(line.indexOf(it.script) + it.script.length).trim().split(/\s+/)[0];
      return after || null;
    };
    return {
      label: 'backups are empty and the job says it worked',
      detail: it.script,
      targets: [it.script, it.cron, dirname(it.script)],
      needs: [`read:${it.script}`, `read:${it.cron}`],
      cond: () => Boolean(w.fs[it.script]) && scriptHardened(fileLines(w.fs[it.script])) && srcOf() !== null && isDir(w, resolvePath(w, srcOf())),
      cost: it.cost ?? 1,
    };
  },
};

// A pager message for each incident: the schedule item says what it reads.
function activate(w, item) {
  const kind = KINDS[item.event];
  if (!kind) throw new Error(`night shift sim: no handler for event "${item.event}"`);
  const inc = kind(w, item);
  inc.event = item.event;
  inc.id = `${item.event}#${w.seq++}`;
  inc.targets ||= [];
  inc.needs ||= [];
  inc.cost ??= 2;
  w.ctx.fire(item.event, inc.detail);
  w.open.push(inc);
  w.pager.push({ id: inc.id, text: item.pager, min: w.minute, state: 'open' });
}

export function start(w, ctx) {
  w.ctx = ctx;
  for (const item of w.startWith || []) activate(w, item);
}

export function reconcile(w) {
  const ctx = w.ctx;
  for (const inc of [...w.open]) inc.check?.();
  const still = [];
  for (const inc of w.open) {
    if (inc.cond(w)) {
      ctx.resolve(inc.event);
      ctx.log(`Cleared: ${inc.label}.`, { kind: 'good' });
      const page = w.pager.find((p) => p.id === inc.id);
      if (page) page.state = 'cleared';
    } else still.push(inc);
  }
  w.open = still;
}

// ---------------------------------------------------------------- running a command

// Returns false for an empty line, 'free' for a look (or a command that changed nothing) and true for a move
// (which the caller turns into a minute with ctx.step()).
export function run(w, ctx, line) {
  const text = String(line || '').trim();
  if (!text) return false;
  w.ctx = ctx;
  const { moved } = runLine(w, text);
  reconcile(w);
  return moved ? true : 'free';
}

export function complete(w, line) {
  return completeLine(w, line);
}

// ---------------------------------------------------------------- the clock

export function tick(w, ctx) {
  w.ctx = ctx;
  w.minute += 1;
  w.nowMs += 60000;

  // Open incidents cost service health every minute they stay open.
  let drain = 0;
  for (const inc of w.open) drain += inc.cost;
  if (drain) {
    w.health = Math.max(0, w.health - drain);
    ctx.log(`${w.open.length} incident${w.open.length > 1 ? 's' : ''} open: -${drain} service health.`, { kind: 'warn' });
  }

  retryUnits(w);
  const t = loadAverageTarget(w);
  w.load.avg = [w.load.avg[0] + (t - w.load.avg[0]) * 0.7, w.load.avg[1] + (t - w.load.avg[1]) * 0.25, w.load.avg[2] + (t - w.load.avg[2]) * 0.08];

  const due = w.pending.filter((it) => it.tick === ctx.ticks);
  w.pending = w.pending.filter((it) => it.tick !== ctx.ticks);
  for (const item of due) activate(w, item);
  reconcile(w);
}

export const isWon = (w) => !w.dead && w.minute >= w.winTicks && !w.pending.length && !w.open.length && w.health >= w.minHealth;
export const isLost = (w) => Boolean(w.dead) || w.health < w.minHealth;

// ---------------------------------------------------------------- view helpers for the UI

export function status(w) {
  return {
    diskPct: diskPct(w),
    load: w.load.avg[0],
    units: Object.values(w.units).map((u) => ({ name: u.name, active: u.active, sub: u.sub })),
    pager: w.pager,
  };
}
