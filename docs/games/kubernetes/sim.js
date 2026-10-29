// A deliberately small Kubernetes cluster simulator for the "Chaos Monkey Cluster" game.
// Pure logic, no DOM: game.js draws it, and the same module can be driven from Node.
//
// It models just enough to make the notes' claims observable, and nothing that contradicts them:
//   * a Deployment owns pods and rolls out template changes with the default RollingUpdate
//     settings (25% max unavailable, 25% max surge); a bare Pod owns nothing and never comes back;
//   * the scheduler places a pod only where its memory *request* still fits; limits are a cap;
//   * a container over its memory limit is OOMKilled; a Service routes only to Ready pods whose
//     labels match its selector; without a readiness probe a container counts as ready as soon as
//     it starts, even while the app is still warming up.

// `mem` is what the app really uses (Mi); a container whose limit is below it gets OOMKilled.
export const IMAGES = {
  'web:1.0': { runsAsRoot: true, mem: 250 },
  'web:1.1': { runsAsRoot: true, mem: 450 }, // a heavier release
  'web:1.1-nonroot': { runsAsRoot: false, mem: 450 },
  'web:1.2': { runsAsRoot: true, mem: 250 },
  'web:1.0-nonroot': { runsAsRoot: false, mem: 250 },
  'batch:1.0': { runsAsRoot: true, mem: 100 },
};

const WARMUP = 3; // ticks from scheduling to ready: creating, then two of warming up
const SELECTOR = 'web'; // web-svc selects pods labelled app=web
const HASHES = ['5f6c9', '7d4b8', '6c8f5', '9a1e3', '4b7d2', '8e3a6', '3c9d1', '2a5e7'];
const SUFFIXES = ['x7k2m', 'p9d4q', 'm3v8t', 'c5z1r', 'h6b0w', 'n2j7y', 'q8f3s', 't4g9a', 'w1l5e', 'z0u6d', 'k8r3v', 'b2n7c'];
const PHASE_FAILURES = new Set(['ImagePullBackOff', 'CreateContainerConfigError', 'OOMKilled', 'CrashLoopBackOff']);

// ---------------------------------------------------------------- world

// `variant` is { seed } for a non-standard version of the level: the pods get different names, so a player who
// remembers the standard run cannot paste its commands, and the chaos monkey (its rolls come from the seed) strikes
// at other times and at other pods.
export function createWorld(sc, variant = null) {
  const w = {
    nameShift: variant ? variant.seed : 0,
    nodes: Array.from({ length: sc.nodes }, (_, i) => ({ name: `node-${i + 1}`, capacity: sc.nodeCapacity })),
    needed: sc.needed,
    configKeys: ['mode'],
    revSeq: 0,
    podSeq: 0,
    pods: [],
    deploys: {},
    k8sEvents: [],
    open: [],
    mutations: 0,
    traffic: { ok: 100, failed: 0, endpoints: 0 },
    survived: 0,
    winTicks: sc.winTicks,
    minHealth: sc.minHealth,
  };
  w.deploys.web = makeDeploy(w, 'web', sc.web.replicas, {
    image: 'web:1.0',
    app: 'web',
    request: sc.web.request,
    limit: sc.web.limit,
    readiness: sc.web.readiness,
    envKey: 'mode',
    nonRoot: false,
  });
  w.deploys.batch = makeDeploy(w, 'batch', 0, {
    image: 'batch:1.0',
    app: 'batch',
    request: sc.batchRequest,
    limit: sc.batchRequest + 100,
    readiness: false,
    envKey: 'mode',
    nonRoot: false,
  });
  // Start from a settled cluster: pods already placed and Running.
  for (let i = 0; i < sc.web.replicas; i++) startSettled(w, spawn(w, w.deploys.web, 0));
  if (sc.barePod) {
    const bare = spawn(w, null, 0, { ...w.deploys.web.template, rev: ++w.revSeq }, 'legacy-web');
    startSettled(w, bare);
  }
  return w;
}

function makeDeploy(w, name, replicas, template) {
  return { name, replicas, template: { ...template, rev: ++w.revSeq }, history: [] };
}

function startSettled(w, pod) {
  place(w, pod);
  pod.phase = 'Running';
  pod.age = WARMUP;
}

const hashFor = (w, rev) => HASHES[(rev + w.nameShift) % HASHES.length];

function spawn(w, deploy, tick, template, fixedName) {
  const n = w.podSeq++;
  const tpl = template || deploy.template;
  const pod = {
    id: n + 1,
    name: fixedName || `${deploy.name}-${hashFor(w, tpl.rev)}-${SUFFIXES[(n + w.nameShift) % SUFFIXES.length]}`,
    deploy: deploy ? deploy.name : null,
    template: tpl,
    node: null,
    ip: null,
    phase: 'Pending',
    age: 0,
    restarts: 0,
    terminating: false,
    termAge: 0,
    born: tick,
  };
  w.pods.push(pod);
  return pod;
}

// ---------------------------------------------------------------- scheduler

export function nodeUsed(w, nodeName) {
  return w.pods.filter((p) => p.node === nodeName).reduce((sum, p) => sum + p.template.request, 0);
}

function place(w, pod) {
  let best = null;
  let bestFree = -1;
  w.nodes.forEach((node, index) => {
    const free = node.capacity - nodeUsed(w, node.name);
    if (free >= pod.template.request && free > bestFree) {
      best = { node, index };
      bestFree = free;
    }
  });
  if (!best) return false;
  pod.node = best.node.name;
  pod.ip = `10.244.${best.index}.${pod.id}`;
  return true;
}

// ---------------------------------------------------------------- pod lifecycle

function failureOf(w, pod) {
  const t = pod.template;
  const image = IMAGES[t.image];
  if (!image) {
    return { phase: 'ImagePullBackOff', reason: `Failed to pull image "${t.image}": manifest unknown`, event: ['Failed', `Failed to pull image "${t.image}": rpc error: manifest unknown`] };
  }
  if (t.nonRoot && image.runsAsRoot) {
    return {
      phase: 'CreateContainerConfigError',
      reason: `container has runAsNonRoot and image will run as root (pod: "${pod.name}", container: web)`,
      event: ['Failed', 'Error: container has runAsNonRoot and image will run as root'],
    };
  }
  if (!w.configKeys.includes(t.envKey)) {
    return {
      phase: 'CreateContainerConfigError',
      reason: `couldn't find key ${t.envKey} in ConfigMap default/web-config`,
      event: ['Failed', `Error: couldn't find key ${t.envKey} in ConfigMap default/web-config`],
    };
  }
  if (t.limit < image.mem) {
    return { phase: 'OOMKilled', reason: 'OOMKilled', oom: true, event: ['OOMKilling', `Memory limit ${t.limit}Mi exceeded; container killed (exit code 137)`] };
  }
  return null;
}

function note(w, tick, type, reason, object, message) {
  const last = w.k8sEvents[w.k8sEvents.length - 1];
  if (last && last.object === object && last.reason === reason && last.message === message) {
    last.count += 1;
    last.tick = tick;
    return;
  }
  w.k8sEvents.push({ tick, type, reason, object, message, count: 1 });
  if (w.k8sEvents.length > 80) w.k8sEvents.shift();
}

function stepPod(w, pod, tick) {
  if (pod.terminating) return;
  if (pod.phase === 'Pending') {
    if (place(w, pod)) {
      pod.phase = 'Starting';
      pod.age = 0;
      note(w, tick, 'Normal', 'Scheduled', `pod/${pod.name}`, `Successfully assigned default/${pod.name} to ${pod.node}`);
    } else {
      note(w, tick, 'Warning', 'FailedScheduling', `pod/${pod.name}`, `0/${w.nodes.length} nodes are available: ${w.nodes.length} Insufficient memory.`);
    }
    return;
  }
  const failure = failureOf(w, pod);
  if (failure) {
    const first = !PHASE_FAILURES.has(pod.phase);
    if (failure.oom) {
      pod.phase = first ? 'OOMKilled' : 'CrashLoopBackOff';
      pod.restarts += 1;
      pod.lastReason = 'OOMKilled';
    } else {
      pod.phase = failure.phase;
    }
    pod.reason = failure.reason;
    if (first) note(w, tick, 'Warning', failure.event[0], `pod/${pod.name}`, failure.event[1]);
    return;
  }
  if (PHASE_FAILURES.has(pod.phase)) {
    pod.phase = 'Starting'; // the cause is gone (e.g. limit raised): the container restarts
    pod.age = 0;
    return;
  }
  if (pod.phase === 'Starting') {
    pod.age += 1;
    if (pod.age >= WARMUP) pod.phase = 'Running';
  }
}

function terminate(w, pod) {
  pod.terminating = true;
  pod.termAge = 0;
  pod.phase = 'Terminating';
}

// ---------------------------------------------------------------- controllers

function reconcile(w, d, tick) {
  const owned = w.pods.filter((p) => p.deploy === d.name && !p.terminating);
  const current = owned.filter((p) => p.template.rev === d.template.rev);
  const old = owned.filter((p) => p.template.rev !== d.template.rev);
  const surge = Math.max(1, Math.ceil(d.replicas * 0.25));
  const maxUnavailable = Math.floor(d.replicas * 0.25);
  const readyCount = () => w.pods.filter((p) => p.deploy === d.name && !p.terminating && p.phase === 'Running').length;
  const rank = (p) => (p.phase === 'Running' ? 1 : 0);

  // Scale down: stop every excess pod at once, not-ready and old ones first.
  const excess = owned.length - (d.replicas + (old.length ? surge : 0));
  if (excess > 0) {
    const victims = [...owned].sort((a, b) => rank(a) - rank(b) || a.template.rev - b.template.rev).slice(0, excess);
    for (const victim of victims) terminate(w, victim);
    return;
  }
  // Create pods of the current template, within the surge allowance.
  if (current.length < d.replicas && owned.length < d.replicas + surge) {
    spawn(w, d, tick);
  }
  // Retire an old pod: not-ready ones any time, ready ones only while availability stays within maxUnavailable.
  const stale = w.pods.filter((p) => p.deploy === d.name && !p.terminating && p.template.rev !== d.template.rev);
  if (stale.length) {
    const unready = stale.find((p) => p.phase !== 'Running');
    if (unready) terminate(w, unready);
    else if (readyCount() - 1 >= d.replicas - maxUnavailable) terminate(w, stale[0]);
  }
}

// ---------------------------------------------------------------- traffic

export function endpoints(w) {
  return w.pods.filter(
    (p) => !p.terminating && p.template.app === SELECTOR && (p.phase === 'Running' || (p.phase === 'Starting' && p.age >= 1 && !p.template.readiness)),
  );
}

function measureTraffic(w) {
  const eps = endpoints(w);
  let ok = 0;
  if (eps.length) {
    const share = 100 / eps.length;
    const cap = 100 / w.needed;
    for (const p of eps) if (p.phase === 'Running') ok += Math.min(share, cap);
  }
  w.traffic = { ok, failed: 100 - ok, endpoints: eps.length };
}

// ---------------------------------------------------------------- template changes

export function setTemplate(w, d, changes, tick) {
  const next = { ...d.template, ...changes, rev: ++w.revSeq };
  d.history.push(d.template);
  if (d.history.length > 6) d.history.shift();
  d.template = next;
  note(w, tick, 'Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled up replica set ${d.name}-${hashFor(w, next.rev)} to ${Math.min(1, d.replicas)}`);
  return next;
}

// ---------------------------------------------------------------- chaos events

function webPods(w) {
  return w.pods.filter((p) => p.deploy === 'web' && !p.terminating);
}

export function servingCount(w) {
  return w.pods.filter((p) => !p.terminating && p.template.app === SELECTOR && p.phase === 'Running').length;
}

function fire(w, ctx, id, detail) {
  ctx.fire(id, detail);
  w.open.push({ id, tick: ctx.ticks, mutations: w.mutations });
}

function killPod(w, pod, tick) {
  w.pods = w.pods.filter((p) => p !== pod);
  note(w, tick, 'Warning', 'Killing', `pod/${pod.name}`, 'Stopping container web');
}

function applyEvent(w, ctx, item) {
  const web = w.deploys.web;
  const t = ctx.ticks;
  switch (item.event) {
    case 'pod-killed': {
      const running = webPods(w).filter((p) => p.phase === 'Running');
      if (!running.length) return;
      const pod = running[Math.floor(ctx.rng() * running.length)];
      killPod(w, pod, t);
      fire(w, ctx, 'pod-killed', pod.name);
      return;
    }
    case 'bare-pod-killed': {
      const bare = w.pods.find((p) => p.name === 'legacy-web');
      if (!bare) return;
      killPod(w, bare, t);
      fire(w, ctx, 'bare-pod-killed', 'legacy-web');
      return;
    }
    case 'bad-image':
      setTemplate(w, web, { image: item.image || 'web:1.1-bad' }, t);
      fire(w, ctx, 'bad-image', item.image || 'web:1.1-bad');
      return;
    case 'label-typo':
      setTemplate(w, web, { app: 'wbe' }, t);
      fire(w, ctx, 'label-typo', 'app=wbe');
      return;
    case 'config-key':
      setTemplate(w, web, { envKey: 'mdoe' }, t);
      fire(w, ctx, 'config-key', 'configMapKeyRef key mdoe');
      return;
    case 'oom': {
      const image = item.image || 'web:1.1';
      setTemplate(w, web, { image }, t);
      fire(w, ctx, 'oom', `${image} uses ~${IMAGES[image].mem}Mi`);
      return;
    }
    case 'no-readiness':
      setTemplate(w, web, { image: 'web:1.2', readiness: false }, t);
      fire(w, ctx, 'no-readiness', 'web:1.2');
      return;
    case 'nonroot':
      setTemplate(w, web, { nonRoot: true }, t);
      fire(w, ctx, 'nonroot', 'runAsNonRoot: true');
      return;
    case 'node-pressure': {
      const batch = w.deploys.batch;
      batch.replicas = item.replicas || 3;
      for (let i = 0; i < batch.replicas; i++) spawn(w, batch, t);
      const running = webPods(w).filter((p) => p.phase === 'Running');
      const victim = running.find((p) => p.node === item.evictFrom) || running[running.length - 1];
      if (victim) killPod(w, victim, t);
      fire(w, ctx, 'node-pressure', `batch scaled to ${batch.replicas}, ${victim ? `evicted ${victim.name}` : 'no web pod evicted'}`);
      return;
    }
    default:
      throw new Error(`sim: no handler for event "${item.event}"`);
  }
}

// An event is "solved" once the fault is gone and the Deployment has settled again.
function settled(w) {
  const web = w.deploys.web;
  const pods = webPods(w);
  return pods.length === web.replicas && pods.every((p) => p.template.rev === web.template.rev && p.phase === 'Running');
}

const FAULT_GONE = {
  'pod-killed': () => true,
  'bare-pod-killed': (w) => servingCount(w) >= w.needed,
  'bad-image': (w) => Boolean(IMAGES[w.deploys.web.template.image]),
  'label-typo': (w) => w.deploys.web.template.app === 'web',
  'config-key': (w) => w.configKeys.includes(w.deploys.web.template.envKey),
  oom: (w) => w.deploys.web.template.limit >= (IMAGES[w.deploys.web.template.image]?.mem ?? 0),
  'no-readiness': (w) => w.deploys.web.template.readiness,
  nonroot: (w) => !(w.deploys.web.template.nonRoot && IMAGES[w.deploys.web.template.image]?.runsAsRoot),
  'node-pressure': (w) => !w.pods.some((p) => p.deploy === 'web' && p.phase === 'Pending'),
};

function resolveEvents(w, ctx) {
  w.open = w.open.filter((entry) => {
    const fixed = FAULT_GONE[entry.id](w) && (entry.id === 'bare-pod-killed' ? true : settled(w));
    if (!fixed) return true;
    if (entry.id === 'pod-killed' && w.mutations === entry.mutations) ctx.log('Self-healed: the ReplicaSet replaced it. No action needed.', { kind: 'good' });
    ctx.resolve(entry.id);
    return false;
  });
}

// ---------------------------------------------------------------- the tick

export function tick(w, ctx) {
  const sc = ctx.scenario;
  const t = ctx.ticks;

  // Terminating pods disappear (and free their node) one tick after they were told to stop.
  w.pods = w.pods.filter((p) => !(p.terminating && p.termAge >= 1));
  for (const p of w.pods) if (p.terminating) p.termAge += 1;

  // Chaos: scheduled events, then the background chaos monkey. Always draw both random numbers so a
  // seed replays identically whatever the player does.
  const roll = ctx.rng();
  const pick = ctx.rng();
  for (const item of sc.schedule || []) {
    if (item.tick !== t) continue;
    applyEvent(w, ctx, item);
    if (sc.eventHints && item.hint) ctx.log(`Hint: ${item.hint}`, { kind: 'hint' });
  }
  if (sc.killChance && roll < sc.killChance) {
    const running = webPods(w).filter((p) => p.phase === 'Running' && p.deploy === 'web');
    if (running.length) {
      const pod = running[Math.floor(pick * running.length)];
      killPod(w, pod, t);
      fire(w, ctx, 'pod-killed', pod.name);
    }
  }

  for (const d of Object.values(w.deploys)) reconcile(w, d, t);
  for (const p of [...w.pods]) stepPod(w, p, t);

  measureTraffic(w);
  w.health = Math.max(0, w.health - w.traffic.failed * sc.drainRate);
  w.survived = (w.survived || 0) + 1;
  resolveEvents(w, ctx);
  if (w.survived === sc.winTicks && w.open.length) {
    ctx.log('The timer is up, but problems are still open. Fix them to finish.', { kind: 'warn' });
  }
}

// You win by surviving the timer *and* leaving the cluster healthy: unresolved problems extend the game.
export const isWon = (w) => w.survived >= w.winTicks && w.health >= w.minHealth && w.open.length === 0;
export const isLost = (w) => w.health < w.minHealth;

// ---------------------------------------------------------------- player-facing mutations
// Everything kubectl (or the edit form) can change goes through these, so the player and the chaos
// events obey the same rules.

export function scaleDeploy(w, d, n, tick) {
  if (n === d.replicas) return false;
  d.replicas = n;
  note(w, tick, 'Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled replica set ${d.name}-${hashFor(w, d.template.rev)} to ${n}`);
  return true;
}

// `kubectl rollout undo` swaps back to the previous revision; running it again swaps forward again.
export function undoRollout(w, d, tick) {
  const prev = d.history.pop();
  if (!prev) return false;
  d.history.push(d.template);
  d.template = prev;
  note(w, tick, 'Normal', 'DeploymentRollback', `deployment/${d.name}`, `Rolled back deployment "${d.name}" to revision of replica set ${d.name}-${hashFor(w, prev.rev)}`);
  return true;
}

export function deletePod(w, pod, tick) {
  note(w, tick, 'Normal', 'Killing', `pod/${pod.name}`, 'Stopping container web');
  if (pod.deploy) terminate(w, pod);
  else w.pods = w.pods.filter((p) => p !== pod); // a bare pod has no controller: it is simply gone
}

// Apply edited fields to a Deployment's pod template. Returns { error } or { changed }.
export function editTemplate(w, d, fields, tick) {
  const next = {};
  if (fields.image !== undefined) next.image = String(fields.image).trim();
  if (fields.app !== undefined) next.app = String(fields.app).trim();
  if (fields.envKey !== undefined) next.envKey = String(fields.envKey).trim();
  if (fields.readiness !== undefined) next.readiness = Boolean(fields.readiness);
  if (fields.nonRoot !== undefined) next.nonRoot = Boolean(fields.nonRoot);
  for (const key of ['request', 'limit']) {
    if (fields[key] === undefined) continue;
    const n = Number(fields[key]);
    if (!Number.isInteger(n) || n < 50 || n > 2000) return { error: `${key}: must be a whole number of Mi between 50 and 2000` };
    next[key] = n;
  }
  for (const key of ['image', 'app', 'envKey']) if (key in next && !next[key]) return { error: `${key} must not be empty` };
  const merged = { ...d.template, ...next };
  if (merged.request > merged.limit) {
    return { error: `spec.template.spec.containers[0].resources.requests: Invalid value: "${merged.request}Mi": must be less than or equal to memory limit of ${merged.limit}Mi` };
  }
  const changed = Object.keys(next).some((k) => next[k] !== d.template[k]);
  if (changed) setTemplate(w, d, next, tick);
  return { changed };
}

// ---------------------------------------------------------------- read-only views for kubectl/UI

export function podStatus(w, pod) {
  if (pod.terminating) return { ready: '0/1', status: 'Terminating' };
  if (pod.phase === 'Pending') return { ready: '0/1', status: 'Pending' };
  if (pod.phase === 'Starting') {
    if (pod.age === 0) return { ready: '0/1', status: 'ContainerCreating' };
    return { ready: pod.template.readiness ? '0/1' : '1/1', status: 'Running' };
  }
  if (pod.phase === 'Running') return { ready: '1/1', status: 'Running' };
  return { ready: '0/1', status: pod.phase };
}

export const webDeploy = (w) => w.deploys.web;
