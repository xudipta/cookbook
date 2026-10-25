// Demo game: proves the shared-shell contract end to end. Everything topic-specific lives here;
// levels, chaos events and the scripted solution live in scenarios.json.
import { registerGame } from '../shared/engine.js';
import { el } from '../shared/ui.js';

const NEED = 3; // pods that must be serving to carry the traffic
const MAX = 8;

const serving = (state) => state.pods.filter((p) => p.status === 'running').length;
const availability = (state) => Math.min(100, (serving(state) / NEED) * 100);

function newPod(state, status, cause) {
  return { id: state.nextId++, status, deadFor: 0, cause: cause || null };
}

function killRandom(state, ctx, count, cause) {
  const killed = [];
  for (let i = 0; i < count; i++) {
    const running = state.pods.filter((p) => p.status === 'running');
    if (!running.length) break;
    const pod = running[Math.floor(ctx.rng() * running.length)];
    pod.status = 'dead';
    pod.deadFor = 0;
    pod.cause = cause;
    killed.push(pod.id);
  }
  if (killed.length) ctx.fire(cause, `pod ${killed.join(' and ')}`);
}

registerGame({
  id: 'demo',
  styles: 'game.css',

  init(state, ctx) {
    state.winTicks = ctx.scenario.winTicks;
    state.minHealth = ctx.scenario.minHealth;
    state.nextId = 1;
    state.survived = 0;
    state.pods = Array.from({ length: NEED }, () => newPod(state, 'running'));
    ctx.log(`Service needs ${NEED} serving pods. Survive ${state.winTicks} ticks without burning your error budget.`);
  },

  tick(state, ctx) {
    // The Deployment's ReplicaSet replaces a dead pod: one tick dead, one tick starting.
    const recovered = new Set();
    for (const pod of state.pods) {
      if (pod.status === 'starting') {
        pod.status = 'running';
        if (pod.cause) recovered.add(pod.cause);
      } else if (pod.status === 'dead') {
        pod.deadFor += 1;
        if (pod.deadFor >= 1) pod.status = 'starting';
      }
    }
    for (const cause of recovered) {
      if (!state.pods.some((p) => p.cause === cause && p.status !== 'running')) {
        ctx.resolve(cause);
        for (const p of state.pods) if (p.cause === cause) p.cause = null;
      }
    }

    // Chaos. Always draw once per tick so a seed replays identically whatever the player does.
    const roll = ctx.rng();
    if (ctx.ticks === ctx.scenario.nodeDownTick) killRandom(state, ctx, 2, 'node-down');
    else if (roll < ctx.scenario.killChance) killRandom(state, ctx, 1, 'pod-killed');

    // Unavailability burns the error budget; every spare replica costs a little.
    const spare = Math.max(0, state.pods.length - NEED);
    state.health = Math.max(0, state.health - (100 - availability(state)) * 0.25 - spare * 0.2);
    state.survived += 1;
  },

  actions: {
    addReplica: {
      label: 'Add replica',
      key: 'a',
      run(state, ctx) {
        if (state.pods.length >= MAX) {
          ctx.log(`Already at ${MAX} replicas.`, { kind: 'warn' });
          return false;
        }
        const pod = newPod(state, 'starting');
        state.pods.push(pod);
        ctx.log(`Scaled up to ${state.pods.length} replicas (pod ${pod.id} starting).`);
      },
    },
    removeReplica: {
      label: 'Remove replica',
      key: 'd',
      run(state, ctx) {
        if (state.pods.length <= 1) return false;
        const index = state.pods.findLastIndex((p) => p.status !== 'running');
        state.pods.splice(index === -1 ? state.pods.length - 1 : index, 1);
        ctx.log(`Scaled down to ${state.pods.length} replicas.`);
      },
    },
  },

  isWon: (state) => state.survived >= state.winTicks && state.health >= state.minHealth,
  isLost: (state) => state.health < state.minHealth,

  render(state, ctx) {
    const label = { running: 'Running', starting: 'Starting', dead: 'Dead' };
    const grid = el('div', { class: 'demo-pods', role: 'list' });
    for (const pod of state.pods) {
      grid.append(
        el(
          'div',
          { class: `demo-pod demo-pod-${pod.status}`, role: 'listitem' },
          el('strong', { text: `Pod ${pod.id}` }),
          el('span', { text: label[pod.status] }),
        ),
      );
    }
    ctx.ui.board.replaceChildren(
      el('p', { class: 'demo-summary', text: `Serving ${serving(state)} of ${NEED} needed pods — ${Math.round(availability(state))}% available — ${state.pods.length} replicas` }),
      grid,
    );
  },
});
