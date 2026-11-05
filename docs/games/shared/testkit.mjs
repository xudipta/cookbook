// Helpers for the simulator unit tests (node:test, no dependencies). Run them with `make unit` or
// `node --test docs/games`. The simulators are pure modules, so the tests drive them directly: no browser,
// no DOM, and the whole suite runs in a couple of seconds.
import fs from 'node:fs';

const HERE = new URL('..', import.meta.url);

// A game's scenarios.json, merged the way the games do it: the shared header plus one level.
export function scenario(game, levelId) {
  const data = JSON.parse(fs.readFileSync(new URL(`${game}/scenarios.json`, HERE), 'utf8'));
  const { levels, ...rest } = data;
  const level = levelId === undefined ? levels[0] : levels.find((l) => l.id === levelId);
  if (!level) throw new Error(`${game}: no level "${levelId}" (have ${levels.map((l) => l.id).join(', ')})`);
  return { sc: { ...rest, ...level }, levels, data };
}

// The stub the games pass to a simulator: step() advances the clock by one tick through the given tick().
export function stubCtx(sc, tickFn, getWorld) {
  const events = [];
  const ctx = {
    ticks: 0,
    scenario: sc,
    events,
    rng: () => 0.5,
    fire: (e) => events.push(e),
    resolve() {},
    log() {},
    step() {
      ctx.ticks += 1;
      tickFn(getWorld(), ctx);
    },
  };
  return ctx;
}

// The lines a command printed, without the echoed prompt line.
export const printed = (term, from) => term.slice(from + 1).map((l) => l.text).join('\n');
