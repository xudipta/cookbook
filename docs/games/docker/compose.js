// A small `docker compose` model for the sixth Layer Cake level. Pure logic, no DOM.
//
// It models what topics/docker/notes/03-compose-and-networking.md teaches and nothing that contradicts it:
//   * services in a project share one default network and reach each other by service name, so an api
//     that connects to localhost reaches itself, not the database;
//   * depends_on orders container start, not readiness: a healthcheck plus `condition: service_healthy`
//     makes a dependent service wait for the database to accept connections;
//   * a named volume must be declared at the top level, survives `down` (without -v) and is the right
//     home for database data; a bind mount survives too but ties the stack to one host path; data in the
//     container's writable layer is gone when the container is removed;
//   * publish a port to the host only when something outside Docker needs it.
// The stack is described by one choice per "slot" (a line of compose.yaml that can be written several ways);
// the slots, their options and what each option sets live in scenarios.json.

import { scorePrediction } from './sim.js';

const fmt = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

// ---------------------------------------------------------------- world

export function createComposeWorld(sc) {
  const slots = sc.compose.slots;
  const choices = Object.fromEntries(slots.map((s) => [s.id, s.initial]));
  return {
    mode: 'compose',
    slots,
    choices,
    project: sc.compose.project || 'app',
    seededRows: sc.compose.rows || 3,
    health: 100,
    log: [],
    open: [],
    upOk: false, // the stack has come up cleanly at least once with this wiring
    running: false,
    rows: null, // rows the database holds right now (null until the api first seeds it)
    recreated: false,
    dataKept: false,
    lastAction: null,
    last: null,
    ups: 0,
    predictedFor: null,
    verdict: null,
    predictions: { right: 0, total: 0 },
    winTicks: sc.winTicks,
    minHealth: sc.minHealth,
  };
}

export function choose(w, slotId, optionId) {
  const slot = w.slots.find((s) => s.id === slotId);
  if (!slot || !slot.options.some((o) => o.id === optionId) || w.choices[slotId] === optionId) return false;
  w.choices[slotId] = optionId;
  // Changing the wiring means starting over: nothing is running, and the database is empty again.
  w.rows = null;
  w.upOk = false;
  w.running = false;
  w.recreated = false;
  w.dataKept = false;
  w.last = null;
  return true;
}

// The flags every option sets, merged in slot order.
export function settings(w) {
  const out = {};
  for (const slot of w.slots) {
    const opt = slot.options.find((o) => o.id === w.choices[slot.id]);
    Object.assign(out, opt.set || {});
  }
  return out;
}

// The compose.yaml the current choices describe.
export function composeYaml(w, sc) {
  const lines = ['services:'];
  const byService = new Map();
  for (const slot of w.slots) {
    if (!slot.service) continue;
    const opt = slot.options.find((o) => o.id === w.choices[slot.id]);
    if (!opt.yaml) continue;
    if (!byService.has(slot.service)) byService.set(slot.service, []);
    byService.get(slot.service).push(...opt.yaml.split('\n'));
  }
  for (const [name, fixed] of Object.entries(sc.compose.services)) {
    lines.push(`  ${name}:`, ...fixed.map((l) => `    ${l}`), ...(byService.get(name) || []).map((l) => `    ${l}`));
  }
  for (const slot of w.slots) {
    if (slot.service) continue;
    const opt = slot.options.find((o) => o.id === w.choices[slot.id]);
    if (opt.yaml) lines.push('', ...opt.yaml.split('\n'));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- running it

function fail(res, id, short, lines) {
  res.ok = false;
  res.error = { id, short };
  res.lines.push(...lines);
  return res;
}

// `docker compose up -d`, then the logs of the services that came up.
export function simulateUp(w) {
  const s = settings(w);
  const p = w.project;
  const res = { ok: true, error: null, lines: [`$ docker compose up -d`], flags: {} };

  if (s.dbVolume === 'named' && !s.volumeDeclared) {
    return fail(res, 'cmp-undefined-volume', 'service "db" refers to an undeclared volume', [
      'service "db" refers to undefined volume db-data: invalid compose project',
    ]);
  }
  res.lines.push(` ✔ Network ${p}_default  Created`);
  if (s.dbVolume === 'named') res.lines.push(` ✔ Volume "${p}_db-data"  Created`);

  if (s.waitHealthy && !s.healthcheck) {
    return fail(res, 'cmp-no-healthcheck', 'api waits for a healthy db, but db has no healthcheck', [
      `dependency failed to start: container ${p}-db-1 has no healthcheck configured`,
    ]);
  }

  res.lines.push(` ✔ Container ${p}-db-1  Started`);
  if (s.waitHealthy) res.lines.push(` ✔ Container ${p}-db-1  Healthy`);
  res.lines.push(` ✔ Container ${p}-api-1  Started`);

  if (s.dbHost !== 'db') {
    return fail(res, 'cmp-localhost', `api connects to ${s.dbHost}, which is the api container itself`, [
      `api-1  | Error: connect ECONNREFUSED 127.0.0.1:5432`,
      `api-1 exited with code 1`,
    ]);
  }
  if (!s.waitHealthy) {
    return fail(res, 'cmp-db-not-ready', 'api started before the database accepted connections', [
      `api-1  | Error: connect ECONNREFUSED 172.19.0.2:5432 (db: the database system is starting up)`,
      `api-1 exited with code 1`,
    ]);
  }

  res.lines.push(` ✔ Container ${p}-web-1  Started`);
  res.lines.push(`api-1  | connected to db:5432`);
  res.flags = {
    dbPortPublished: Boolean(s.dbPort),
    webReachable: Boolean(s.webPort),
    bindMount: s.dbVolume === 'bind',
    noVolume: s.dbVolume === 'none',
  };
  return res;
}

export function runUp(w, ctx) {
  const sc = ctx.scenario;
  const res = simulateUp(w);
  w.ups += 1;
  w.last = res;
  if (!res.ok) {
    w.health = Math.max(0, w.health - sc.failPenalty);
    w.running = false;
    fire(w, ctx, res.error.id, res.error.short);
    return res;
  }
  w.running = true;
  w.upOk = true;
  w.lastAction = 'up';
  if (w.rows === null) {
    w.rows = w.seededRows;
    res.lines.push(`api-1  | seeded ${w.rows} orders`);
  }
  // A clean start resolves the startup errors.
  resolveOpen(w, ctx, (e) => e.startsWith('cmp-') && STARTUP_ERRORS.has(e));
  diagnose(w, ctx, res);
  w.health = Math.max(0, w.health - sc.runCost);
  ctx.step();
  return res;
}

// `docker compose down` then `docker compose up -d`: does the data survive?
export function runRecreate(w, ctx) {
  const sc = ctx.scenario;
  if (!w.running) {
    w.last = { ok: false, error: null, lines: ['$ docker compose down', 'nothing is running: press Up first'], flags: {} };
    return null;
  }
  const s = settings(w);
  const p = w.project;
  const lines = [`$ docker compose down`, ` ✔ Container ${p}-web-1  Removed`, ` ✔ Container ${p}-api-1  Removed`, ` ✔ Container ${p}-db-1  Removed`, `$ docker compose up -d`];
  const kept = s.dbVolume !== 'none';
  if (!kept) w.rows = 0;
  lines.push(` ✔ Container ${p}-db-1  Started`, ` ✔ Container ${p}-api-1  Started`, ` ✔ Container ${p}-web-1  Started`);
  lines.push(kept ? `api-1  | orders: ${w.rows} rows` : `api-1  | orders: 0 rows (was ${w.seededRows})`);
  w.recreated = true;
  w.lastAction = 'recreate';
  w.dataKept = kept;
  w.last = { ok: true, error: null, lines, flags: w.last ? w.last.flags : {} };
  if (!kept) {
    fire(w, ctx, 'cmp-data-lost', `${w.seededRows} orders gone after down and up`);
    w.health = Math.max(0, w.health - sc.failPenalty);
  } else {
    resolveOpen(w, ctx, (e) => e === 'cmp-data-lost');
  }
  w.health = Math.max(0, w.health - sc.runCost);
  ctx.step();
  return w.last;
}

// ---------------------------------------------------------------- predict before you act

const yesNo = (truth) => [{ text: 'Yes' }, { text: 'No' }].map((l, i) => ({ ...l, truth: i === 0 ? truth : !truth }));

// The question to answer before the next Up or Recreate, or null: will the stack come up with this wiring, and (once
// it is up) will the database data survive `down` and `up`?
export function askCompose(w) {
  const sig = JSON.stringify(w.choices);
  if (w.ups === 0) {
    const res = simulateUp(w);
    const layers = yesNo(res.ok);
    return {
      kind: 'choose',
      sig: `up|${sig}`,
      intro: 'Read the compose.yaml you wrote. When you press Up, will the stack start and api connect to db?',
      layers,
      truth: layers.map((l) => l.truth),
      why: res.ok ? 'every service starts and api reaches db' : res.error.short,
    };
  }
  if (w.running && !w.recreated) {
    const kept = settings(w).dbVolume !== 'none';
    const layers = yesNo(kept);
    return {
      kind: 'choose',
      sig: `down|${sig}`,
      intro: 'You are about to run docker compose down and then up again. Will the database data survive?',
      layers,
      truth: layers.map((l) => l.truth),
      why: kept ? 'the data is in a volume, and down removes containers, not volumes' : 'the data lives in the container, and down removes the container',
    };
  }
  return null;
}

export const needsPrediction = (w) => {
  const q = askCompose(w);
  return Boolean(q) && w.predictedFor !== q.sig;
};

export const predictCompose = (w, ctx, answer) => scorePrediction(w, ctx, askCompose(w), answer);

// ---------------------------------------------------------------- events

const STARTUP_ERRORS = new Set(['cmp-undefined-volume', 'cmp-no-healthcheck', 'cmp-localhost', 'cmp-db-not-ready']);

function fire(w, ctx, id, detail) {
  if (w.open.includes(id)) return;
  ctx.fire(id, detail);
  w.open.push(id);
}

function resolveOpen(w, ctx, predicate) {
  w.open = w.open.filter((id) => {
    if (!predicate(id)) return true;
    ctx.resolve(id);
    return false;
  });
}

// Problems that do not stop the stack from starting but are still wrong.
function diagnose(w, ctx, res) {
  const f = res.flags;
  const checks = [
    ['cmp-published-db', f.dbPortPublished, 'db publishes 5432 to the host, and only api needs it'],
    ['cmp-no-web-port', !f.webReachable, 'web publishes no port, so nothing outside Docker can reach it'],
    ['cmp-bind-mount', f.bindMount, 'db data lives in ./pgdata on this machine'],
  ];
  for (const [id, bad, detail] of checks) {
    if (bad) fire(w, ctx, id, detail);
    else resolveOpen(w, ctx, (e) => e === id);
  }
}

// Called by the engine for every successful `up` and recreate.
export function tick(w, ctx) {
  if (w.lastAction === 'recreate') {
    ctx.log(w.dataKept ? `Recreated the stack: the ${w.rows} orders are still there.` : 'Recreated the stack: the orders are gone.', { kind: w.dataKept ? 'good' : 'info' });
  } else {
    ctx.log('The stack is up and api is connected to db.', { kind: 'good' });
  }
}

// ---------------------------------------------------------------- goals

export function goals(w) {
  const s = settings(w);
  const f = (w.last && w.last.flags) || {};
  return [
    { ok: w.upOk, text: 'The stack comes up and api connects to db' },
    { ok: s.dbHost === 'db' && w.upOk, text: 'api reaches db by its service name' },
    { ok: s.waitHealthy && s.healthcheck && w.upOk, text: 'api waits for db to be healthy' },
    { ok: w.recreated && w.dataKept, text: w.recreated && !w.dataKept ? 'Data lost on down and up' : 'Data survives down and up' },
    { ok: s.dbVolume === 'named' && w.upOk, text: 'Database data is in a named volume' },
    { ok: w.upOk && !f.dbPortPublished, text: 'db is not published to the host' },
    { ok: w.upOk && f.webReachable, text: 'web is published on 8080' },
  ];
}

export const goalMet = (w) => goals(w).every((g) => g.ok);
export const isWon = (w) => goalMet(w) && !w.open.length && w.health >= w.minHealth;
export const isLost = (w) => w.health < w.minHealth;
