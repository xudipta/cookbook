// Shared engine for the cookbook games. A game module calls registerGame() with its
// definition; boot.js then calls mountGame() to run it on the page. See "Adding a game" in
// CONTRIBUTING.md for the contract.
import { createUI } from './ui.js';

const registry = new Map();
const SITE_ROOT = new URL('../../../', import.meta.url);
const BEST_KEY = 'cookbook-game-best:';

const REQUIRED = ['id', 'init', 'tick', 'actions', 'isWon', 'isLost'];

export function registerGame(def) {
  for (const key of REQUIRED) {
    if (def[key] === undefined) throw new Error(`registerGame: missing "${key}"`);
  }
  registry.set(def.id, def);
  return def;
}

// Small seeded PRNG so a run is reproducible from ?seed=N.
export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform scoring for every game: the topic's health meter (0-100) is worth up to 1000,
// every action costs 10, and winning adds 500.
export function computeScore({ health, actionsUsed, won }) {
  return Math.max(0, Math.round(health * 10) - actionsUsed * 10 + (won ? 500 : 0));
}

function readBest(id) {
  try {
    return Number(localStorage.getItem(BEST_KEY + id)) || 0;
  } catch {
    return 0;
  }
}

function writeBest(id, score) {
  try {
    localStorage.setItem(BEST_KEY + id, String(score));
  } catch {
    // Storage can be blocked (private windows, embedded previews); the game works without it.
  }
}

export async function mountGame(container, { id }) {
  const def = registry.get(id);
  if (!def) throw new Error(`No game registered for "${id}"`);

  const res = await fetch(new URL(`../${id}/scenarios.json`, import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json for "${id}": HTTP ${res.status}`);
  const base = await res.json();
  const events = new Map(base.events.map((e) => [e.id, e]));

  // The board entry (topic, notes folder) in docs/games/games.json; the shell works without it.
  let meta = null;
  try {
    const listing = await fetch(new URL('../games.json', import.meta.url));
    if (listing.ok) meta = (await listing.json()).games.find((g) => g.id === id) || null;
  } catch {
    // Offline or blocked: no topic strip, everything else still works.
  }

  // A scenario may define `levels: [{ id, title, ...overrides }]`. The selected level is merged over
  // the top-level fields (events always come from the top level), so every level can set its own
  // seed, winTicks, tickMs, schedule, solution and any game-specific setting.
  const levels = base.levels || null;
  const mergeLevel = (level) => {
    const { levels: _ignored, ...rest } = base;
    return level ? { ...rest, ...level } : rest;
  };
  const params = new URLSearchParams(location.search);
  let level = levels ? levels.find((l) => l.id === params.get('level')) || levels[0] : null;
  let scenario = mergeLevel(level);

  // A game can ship its own stylesheet next to game.js (`styles: 'game.css'`). Select it with
  // `.cg .your-class` so it outranks Material's typography rules.
  if (def.styles && !document.querySelector(`link[data-cg-styles="${id}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../${id}/${def.styles}`, import.meta.url).href;
    link.dataset.cgStyles = id;
    document.head.append(link);
  }

  const autoplay = params.get('autoplay') !== '0';
  const seedFor = () => (params.has('seed') ? Number(params.get('seed')) : scenario.seed);
  const tickMsFor = () => Number(params.get('tick')) || scenario.tickMs || 1000;

  const rt = {
    id,
    seed: seedFor(),
    level: level ? level.id : null,
    levels: levels ? levels.map((l) => l.id) : [],
    state: null,
    ticks: 0,
    actionsUsed: 0,
    status: 'playing',
    paused: false,
  };
  let rng;
  let fired;
  let timer = null;
  let ui;
  let ctx;

  const score = () =>
    computeScore({ health: rt.state.health, actionsUsed: rt.actionsUsed, won: rt.status === 'won' });

  function refresh() {
    def.render?.(rt.state, ctx);
    ui.setHud({
      ticks: rt.ticks,
      winTicks: scenario.winTicks,
      tickLabel: scenario.tickLabel || 'Tick',
      health: rt.state.health,
      score: score(),
      status: rt.status,
      paused: rt.paused,
    });
  }

  function finish(status) {
    rt.status = status;
    stopTimer();
    const best = Math.max(readBest(id), score());
    writeBest(id, best);
    const resolved = fired.filter((f) => f.resolvedAt !== null);
    const avgResolve = resolved.length
      ? resolved.reduce((sum, f) => sum + (f.resolvedAt - f.firedAt), 0) / resolved.length
      : null;
    const seen = new Set();
    const eventList = [];
    for (const f of fired) {
      if (seen.has(f.event.id)) continue;
      seen.add(f.event.id);
      eventList.push(f.event);
    }
    refresh();
    const at = levels ? levels.findIndex((l) => l.id === level.id) : -1;
    const nextLevel = at >= 0 && at < levels.length - 1 ? levels[at + 1] : null;
    ui.showResult({ status, score: score(), best, ticks: rt.ticks, actionsUsed: rt.actionsUsed, avgResolve, events: eventList, nextLevel });
  }

  function makeCtx() {
    return {
      rng: () => rng(),
      ui,
      get scenario() {
        return scenario;
      },
      get ticks() {
        return rt.ticks;
      },
      get paused() {
        return rt.paused;
      },
      // True once the game has been won or lost, so a game's own controls can disable themselves.
      get over() {
        return rt.status !== 'playing';
      },
      // Lets a game's own UI (a prompt, a form) go through the same pipeline as the action buttons.
      act: (name, ...args) => rt.act(name, ...args),
      step: (n = 1) => rt.step(n),
      log: (text, opts) => ui.log(text, opts),
      fire(eventId, detail) {
        const event = events.get(eventId);
        if (!event) throw new Error(`Unknown event "${eventId}" (add it to scenarios.json)`);
        const li = ui.log(`${event.title}${detail ? ` (${detail})` : ''}`, { kind: 'event' });
        fired.push({ event, firedAt: rt.ticks, resolvedAt: null, li });
      },
      resolve(eventId) {
        const entry = fired.find((f) => f.event.id === eventId && f.resolvedAt === null);
        if (!entry) return;
        entry.resolvedAt = rt.ticks;
        ui.attachLearn(entry.li, entry.event.fix, entry.event.learn);
      },
    };
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function startTimer() {
    stopTimer();
    // `manual: true` games are turn-based: time only advances when the game calls ctx.step().
    if (!autoplay || base.manual) return;
    timer = setInterval(() => {
      if (!container.isConnected) return stopTimer(); // navigated away (instant navigation)
      if (!rt.paused) rt.step();
    }, tickMsFor());
  }

  rt.step = (n = 1) => {
    for (let i = 0; i < n && rt.status === 'playing'; i++) {
      rt.ticks += 1;
      def.tick(rt.state, ctx);
      if (def.isLost(rt.state)) return finish('lost');
      if (def.isWon(rt.state)) return finish('won');
    }
    refresh();
  };

  rt.act = (name, ...args) => {
    if (rt.status !== 'playing' || rt.paused) return false;
    const action = def.actions[name];
    if (!action) throw new Error(`Unknown action "${name}"`);
    const run = typeof action === 'function' ? action : action.run;
    const result = run(rt.state, ctx, ...args);
    if (result === false) return false; // rejected, or a read-only command: not counted, not valid
    // 'free' means valid but not scored (e.g. rearranging cards).
    if (result !== 'free') rt.actionsUsed += 1;
    if (rt.status !== 'playing') return true; // the action itself ended the game (via ctx.step)
    if (def.isLost(rt.state)) finish('lost');
    else if (def.isWon(rt.state)) finish('won');
    else refresh();
    return true;
  };

  rt.togglePause = () => {
    if (rt.status !== 'playing') return;
    rt.paused = !rt.paused;
    refresh();
  };

  rt.setLevel = (levelId) => {
    const next = levels && levels.find((l) => l.id === levelId);
    if (!next) throw new Error(`Unknown level "${levelId}"`);
    level = next;
    scenario = mergeLevel(level);
    rt.level = level.id;
    rt.restart();
  };

  rt.restart = () => {
    stopTimer();
    rt.seed = seedFor();
    rng = mulberry32(rt.seed);
    fired = [];
    rt.ticks = 0;
    rt.actionsUsed = 0;
    rt.status = 'playing';
    rt.paused = false;
    rt.state = { health: 100 };
    ui.clearLog();
    ui.clearResult();
    ui.setLevel(level);
    ui.board.replaceChildren();
    def.init(rt.state, ctx);
    refresh();
    startTimer();
  };

  ui = createUI(container, {
    def,
    scenario: base,
    levels,
    siteRoot: SITE_ROOT,
    meta,
    handlers: {
      act: (name) => rt.act(name),
      setLevel: (levelId) => rt.setLevel(levelId),
      togglePause: () => rt.togglePause(),
      restart: () => rt.restart(),
    },
  });
  ctx = makeCtx();

  container.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    // Material binds keys such as p/n (prev/next page) and f/s (search) on the window, so a key the
    // game handles must not bubble up to it.
    const handled = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (key === 'p' && !base.manual) return handled(() => rt.togglePause());
    if (key === 'r') return handled(() => rt.restart());
    for (const [name, action] of Object.entries(def.actions)) {
      if (typeof action === 'object' && action.key && action.key.toLowerCase() === key) {
        return handled(() => rt.act(name));
      }
    }
  });

  rt.restart();
  window.cookbookGames = window.cookbookGames || {};
  window.cookbookGames[id] = rt;
  return rt;
}
