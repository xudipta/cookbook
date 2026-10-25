// A small `docker build` simulator for the "Layer Cake" game. Pure logic, no DOM.
//
// It models what topics/docker/notes/01 and 02 teach and nothing that contradicts them:
//   * a layer is reused only if its instruction, everything before it and its input files are
//     unchanged; otherwise it and every later layer rebuild;
//   * COPY inputs are the context files that survive .dockerignore; RUN inputs are just its text;
//   * a multi-stage build ships only the last stage;
//   * deleting files in a later layer doesn't shrink an earlier one;
//   * a base-image bump or an empty CI cache rebuilds everything.
// A "card" is one Dockerfile line (or the .dockerignore file, or a build flag) from scenarios.json.

const NON_INSTRUCTION = new Set(['file', 'flag']);
const CONTEXT_MB_PER_SECOND = 120;

// ---------------------------------------------------------------- world

export function createWorld(sc) {
  const cards = new Map(sc.cards.map((c) => [c.id, c]));
  for (const id of sc.dockerfile) if (!cards.has(id)) throw new Error(`level ${sc.id}: unknown card "${id}"`);
  return {
    cards,
    images: sc.images,
    order: [...sc.dockerfile],
    versions: Object.fromEntries(Object.keys(sc.context.files).map((f) => [f, 1])),
    digest: {},
    cache: new Set(),
    pulled: new Set(),
    forceCold: false,
    last: null,
    pending: null,
    open: [],
    okBuilds: 0,
    builds: 0,
    goal: sc.goal,
    winTicks: sc.winTicks,
    minHealth: sc.minHealth,
    log: [],
  };
}

export const trayIds = (w) => [...w.cards.keys()].filter((id) => !w.order.includes(id));

// ---------------------------------------------------------------- arranging cards (free actions)

export function arrange(w, ids) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some((id) => !w.cards.has(id))) return false;
  w.order = [...ids];
  return true;
}

export function moveCard(w, id, to) {
  if (!w.cards.has(id)) return false;
  const rest = w.order.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, Number.isInteger(to) ? to : rest.length));
  rest.splice(at, 0, id);
  w.order = rest;
  return true;
}

export function removeCard(w, id) {
  if (!w.order.includes(id)) return false;
  w.order = w.order.filter((x) => x !== id);
  return true;
}

// ---------------------------------------------------------------- the build

// Small, stable string hash (cyrb53) so cache keys stay short.
function hash(...parts) {
  const str = parts.join('\u0001');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const hasPath = (fs, p) => fs.has(p) || [...fs].some((e) => e.startsWith(`${p}/`));
const join = (dir, p) => (p.startsWith('/') ? p : `${dir.replace(/\/$/, '')}/${p.replace(/^\.\/?/, '')}`).replace(/\/$/, '') || '/';
const fmt = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

function fail(res, id, short, lines) {
  res.ok = false;
  res.error = { id, short };
  res.lines.push(...lines);
  return res;
}

export function simulateBuild(w, sc) {
  const res = { ok: true, error: null, layers: [], lines: [], seconds: 0, size: 0, runs: false, runsWhy: '', fs: new Set(), flags: {} };
  const files = sc.context.files;
  const arranged = w.order.map((id) => w.cards.get(id));
  const inst = arranged.filter((c) => !NON_INSTRUCTION.has(c.kind));
  const ignoreCard = arranged.find((c) => c.kind === 'file');
  const ignored = new Set(ignoreCard ? ignoreCard.ignores : []);
  const cacheFlag = arranged.some((c) => c.kind === 'flag');

  if (w.forceCold && !cacheFlag) {
    w.cache.clear();
    w.pulled.clear();
  }
  w.forceCold = false;

  const ctxFiles = Object.keys(files).filter((f) => !ignored.has(f));
  const ctxMB = ctxFiles.reduce((sum, f) => sum + files[f], 0);
  res.flags.ctxMB = ctxMB;
  res.flags.leaksEnv = false;

  let step = 1;
  res.lines.push(`#${step++} [internal] load build definition from Dockerfile`);
  res.lines.push(`#${step++} [internal] load .dockerignore${ignoreCard ? ` (ignoring ${[...ignored].join(', ')})` : ' (none found)'}`);

  if (!inst.length) return fail(res, 'err-no-from', 'empty Dockerfile', ['ERROR: failed to solve: the Dockerfile is empty']);
  if (inst[0].kind !== 'from') {
    return fail(res, 'err-no-from', `line 1 is ${inst[0].text.split(' ')[0]}, not FROM`, [
      'ERROR: failed to solve: dockerfile parse error on line 1: no build stage in current context',
    ]);
  }

  const ctxSeconds = ctxMB / CONTEXT_MB_PER_SECOND;
  res.lines.push(`#${step} [internal] load build context`, `#${step} transferring context: ${fmt(ctxMB)}MB ${ctxSeconds.toFixed(1)}s done`);
  step += 1;

  // Count instructions per stage so labels read like BuildKit's "[build 3/6]".
  const stageSizes = [];
  inst.forEach((c) => {
    if (c.kind === 'from') stageSizes.push(0);
    stageSizes[stageSizes.length - 1] += 1;
  });
  const multi = stageSizes.length > 1;

  const stages = [];
  let cur = null;
  let positionInStage = 0;

  const label = () => {
    const name = cur.name || (multi ? `stage-${stages.length - 1}` : '');
    return `[${name ? `${name} ` : ''}${positionInStage}/${stageSizes[stages.length - 1]}]`;
  };

  for (const c of inst) {
    if (c.kind === 'from') {
      const image = w.images[c.image];
      if (!image) {
        res.lines.push(`#${step++} [internal] load metadata for docker.io/library/${c.image}`);
        return fail(res, 'err-bad-tag', `${c.image} does not exist`, [
          `ERROR: failed to solve: ${c.image}: failed to resolve source metadata for docker.io/library/${c.image}: docker.io/library/${c.image}: not found`,
        ]);
      }
      cur = {
        name: c.as || null,
        key: hash('FROM', c.image, w.digest[c.image] || 0),
        fs: new Set(image.paths || []),
        size: image.size,
        hasCmd: Boolean(image.defaultCmd),
        user: null,
        workdir: '/',
        cmdNeeds: [],
      };
      stages.push(cur);
      positionInStage = 1;
      const pullKey = `${c.image}@${w.digest[c.image] || 0}`;
      const cached = w.pulled.has(pullKey);
      const time = cached ? 0 : image.pull;
      w.pulled.add(pullKey);
      res.seconds += time;
      res.layers.push({ stage: stages.length - 1, label: label(), text: c.text, status: cached ? 'CACHED' : 'BUILT', time, size: image.size });
      res.lines.push(`#${step} ${label()} FROM docker.io/library/${c.image}`, cached ? `#${step} CACHED` : `#${step} ${fmt(time)}s`);
      step += 1;
      continue;
    }

    positionInStage += 1;
    let size = 0;
    let time = c.time || 0;
    let inputs = [];
    let error = null;

    switch (c.kind) {
      case 'workdir':
        cur.workdir = c.path;
        cur.fs.add(c.path);
        time = 0.1;
        break;
      case 'copy': {
        if (c.fromStage) {
          const src = stages.find((s) => s.name === c.fromStage);
          if (!src) {
            error = { id: 'err-bad-stage', short: `no stage named ${c.fromStage}`, message: `ERROR: failed to solve: invalid from flag value ${c.fromStage}: pull access denied for ${c.fromStage}, repository does not exist or may require authorization` };
            break;
          }
          const moved = [...src.fs].filter((e) => c.paths.some((p) => e === p || e.startsWith(`${p}/`)));
          if (!moved.length) {
            error = { id: 'err-missing-input', short: `${c.paths[0]} is not in stage ${c.fromStage}`, message: `ERROR: failed to solve: failed to compute cache key: "${c.paths[0]}" not found: not found` };
            break;
          }
          for (const e of moved) cur.fs.add(e.replace(c.paths.find((p) => e === p || e.startsWith(`${p}/`)), c.dest));
          cur.fs.add(c.dest);
          size = c.size ?? 0;
          inputs = [`stage:${src.key}`];
          time = 0.3;
          break;
        }
        const dir = join(cur.workdir, c.dest);
        const names = c.files === '*' ? ctxFiles : c.files.filter((f) => !ignored.has(f));
        const missing = c.files === '*' ? [] : c.files.filter((f) => !(f in files));
        if (missing.length) {
          error = { id: 'err-missing-input', short: `${missing[0]} is not in the build context`, message: `ERROR: failed to solve: failed to compute cache key: "/${missing[0]}" not found: not found` };
          break;
        }
        if (c.files !== '*' && names.length < c.files.length) {
          const gone = c.files.find((f) => ignored.has(f));
          error = { id: 'err-missing-input', short: `${gone} is excluded by .dockerignore`, message: `ERROR: failed to solve: failed to compute cache key: "/${gone}" not found: not found` };
          break;
        }
        for (const f of names) {
          cur.fs.add(c.destFile ? dir : `${dir}/${f}`);
          size += files[f];
        }
        inputs = names.map((f) => `${f}:${w.versions[f]}`);
        time = 0.1 + size / 400;
        break;
      }
      case 'run': {
        const lacking = (c.requires || []).find((p) => !hasPath(cur.fs, p));
        if (lacking) {
          error = {
            id: 'err-missing-input',
            short: `${c.text} could not find ${lacking}`,
            message: `ERROR: failed to solve: process "/bin/sh -c ${c.text.replace(/^RUN /, '')}" did not complete successfully: exit code: 1\n${(c.errors && c.errors[lacking]) || c.error || `error: ${lacking}: no such file or directory`}`,
          };
          break;
        }
        size = c.size || 0;
        for (const p of c.produces || []) cur.fs.add(p);
        for (const p of c.removes || []) for (const e of [...cur.fs]) if (e === p || e.startsWith(`${p}/`)) cur.fs.delete(e);
        break;
      }
      case 'user':
        cur.user = c.user;
        time = 0;
        break;
      case 'cmd':
        cur.hasCmd = true;
        cur.cmdNeeds = c.requires || [];
        time = 0;
        break;
      default: // env, expose, healthcheck, arg
        time = 0;
    }

    const key = error ? null : hash(cur.key, c.text, inputs.join(','));
    const cached = key && w.cache.has(key);
    if (error) {
      res.layers.push({ stage: stages.length - 1, label: label(), text: c.text, status: 'ERROR', time: 0, size: 0 });
      res.lines.push(`#${step} ${label()} ${c.text}`, `#${step} ERROR`, error.message);
      res.ok = false;
      res.error = { id: error.id, short: error.short };
      return res;
    }
    if (!cached) res.seconds += time;
    w.cache.add(key);
    cur.key = key;
    cur.size += size;
    res.layers.push({ stage: stages.length - 1, label: label(), text: c.text, status: cached ? 'CACHED' : 'BUILT', time: cached ? 0 : time, size });
    res.lines.push(`#${step} ${label()} ${c.text}`, cached ? `#${step} CACHED` : `#${step} ${fmt(time)}s`);
    step += 1;
  }

  res.seconds += ctxSeconds;
  res.lines.push(`=> exporting to image: ${fmt(cur.size)}MB   (built in ${fmt(res.seconds)}s)`);

  // What the final image looks like, and whether a container made from it would start.
  const last = stages[stages.length - 1];
  res.size = last.size;
  res.fs = last.fs;
  res.flags.aptCache = hasPath(last.fs, '/var/lib/apt/lists');
  res.flags.nonRoot = Boolean(last.user);
  res.flags.leaksEnv = [...last.fs].some((e) => e.endsWith('/.env'));
  const goal = w.goal || {};
  const missingRun = last.cmdNeeds.find((p) => !hasPath(last.fs, p));
  const missingGoal = (goal.requirePaths || []).find((p) => !hasPath(last.fs, p));
  if (!last.hasCmd) res.runsWhy = 'no CMD: the container has nothing to run';
  else if (last.user && !hasPath(last.fs, `/home/${last.user}`)) res.runsWhy = `unable to find user ${last.user}: no matching entries in passwd file`;
  else if (missingRun) res.runsWhy = `the container starts but ${missingRun} is not in the image`;
  else if (missingGoal) res.runsWhy = `the final image must contain ${missingGoal}${goal.requireWhy ? ` (${goal.requireWhy})` : ''}`;
  else res.runsWhy = '';
  res.runs = !res.runsWhy;
  return res;
}

// ---------------------------------------------------------------- the turn (one successful build)

const DIAGNOSTICS = [
  { id: 'bloat', test: (r, w) => w.goal.maxSize && r.size > w.goal.maxSize, detail: (r, w) => `${fmt(r.size)}MB, target ${w.goal.maxSize}MB` },
  { id: 'no-start', test: (r) => !r.runs, detail: (r) => r.runsWhy },
  { id: 'secret-leak', test: (r) => r.flags.leaksEnv, detail: () => '.env is inside the image' },
  { id: 'ctx-bloat', test: (r) => r.flags.ctxMB > 50, detail: (r) => `${fmt(r.flags.ctxMB)}MB build context` },
  { id: 'apt-cache', test: (r) => r.flags.aptCache, detail: () => '/var/lib/apt/lists left in the image' },
  { id: 'root-user', test: (r, w) => w.goal.nonRoot && !r.flags.nonRoot, detail: () => 'no USER instruction' },
];

function fire(w, ctx, id, kind, detail) {
  if (w.open.some((e) => e.id === id)) return;
  ctx.fire(id, detail);
  w.open.push({ id, kind });
}

function resolveOpen(w, ctx, predicate) {
  w.open = w.open.filter((e) => {
    if (!predicate(e)) return true;
    ctx.resolve(e.id);
    return false;
  });
}

// Run `docker build` for the current arrangement. A failed build costs health but is not a turn.
export function runBuild(w, ctx) {
  const sc = ctx.scenario;
  const res = simulateBuild(w, sc);
  w.builds += 1;
  w.last = res;
  if (!res.ok) {
    w.health = Math.max(0, w.health - sc.failPenalty);
    fire(w, ctx, res.error.id, 'err', res.error.short);
    return res;
  }
  w.pending = res;
  ctx.step();
  return res;
}

// Called by the engine for every successful build.
export function tick(w, ctx) {
  const sc = ctx.scenario;
  const res = w.pending;
  w.pending = null;
  w.okBuilds += 1;
  if (ctx.ticks > (sc.freeBuilds ?? 1)) w.health = Math.max(0, w.health - res.seconds * sc.drainRate);

  const rebuilt = res.layers.filter((l) => l.status === 'BUILT' && l.time >= 0.05).length;
  ctx.log(`Build ${ctx.ticks}: ${rebuilt} of ${res.layers.length} layers rebuilt in ${fmt(res.seconds)}s, image ${fmt(res.size)}MB.`, {
    kind: res.seconds <= (sc.goodBuildSeconds ?? 12) ? 'good' : 'info',
  });

  // A successful build resolves earlier errors and "a teammate changed something" events.
  resolveOpen(w, ctx, (e) => e.kind === 'err' || e.kind === 'dev');
  for (const d of DIAGNOSTICS) {
    const problem = d.test(res, w);
    if (problem) fire(w, ctx, d.id, 'diag', d.detail(res, w));
    else resolveOpen(w, ctx, (e) => e.id === d.id);
  }

  for (const item of sc.schedule || []) {
    if (item.tick !== ctx.ticks) continue;
    switch (item.event) {
      case 'dev-edit-src':
        for (const f of item.files || ['src']) w.versions[f] += 1;
        fire(w, ctx, 'dev-edit-src', 'dev', (item.files || ['src']).join(', '));
        break;
      case 'dev-add-dep':
        for (const f of item.files || ['package.json', 'package-lock.json']) w.versions[f] += 1;
        fire(w, ctx, 'dev-add-dep', 'dev', (item.files || ['package.json']).join(', '));
        break;
      case 'base-bump':
        for (const image of Object.keys(w.images)) w.digest[image] = (w.digest[image] || 0) + 1;
        fire(w, ctx, 'base-bump', 'dev', 'new base layers upstream');
        break;
      case 'cold-runner':
        w.forceCold = true;
        fire(w, ctx, 'cold-runner', 'dev', 'empty cache');
        break;
      default:
        throw new Error(`docker sim: no handler for event "${item.event}"`);
    }
  }
}

export function goalMet(w) {
  const r = w.last;
  if (!r || !r.ok) return false;
  const g = w.goal;
  if (g.runs !== false && !r.runs) return false;
  if (g.maxSize && r.size > g.maxSize) return false;
  if (g.noSecrets && r.flags.leaksEnv) return false;
  if (g.nonRoot && !r.flags.nonRoot) return false;
  return true;
}

export const isWon = (w) => w.okBuilds >= w.winTicks && goalMet(w);
export const isLost = (w) => w.health < w.minHealth;
