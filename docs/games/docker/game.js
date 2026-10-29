// "Layer Cake": arrange Dockerfile cards, press Build, and watch which layers the cache reuses.
// The simulation is in sim.js (DOM-free); this file is the cards, the layer view and the registerGame
// wiring. The game is turn-based: nothing happens until you press Build.
import { registerGame } from '../shared/engine.js';
import { el } from '../shared/ui.js';
import * as compose from './compose.js';
import { initCompose, renderCompose } from './compose-ui.js';
import {
  createWorld,
  isLost as simIsLost,
  isWon as simIsWon,
  moveCard,
  removeCard,
  arrange,
  runBuild,
  tick as simTick,
  trayIds,
} from './sim.js';

const fmtMB = (n) => `${n >= 10 ? Math.round(n) : n.toFixed(1)} MB`;
const fmtS = (n) => `${n >= 10 ? Math.round(n) : n.toFixed(1)}s`;

// ---------------------------------------------------------------- cards

function cardTag(card) {
  return card.kind === 'file' ? 'file' : card.kind === 'flag' ? 'build flag' : null;
}

function cardEl(state, ctx, id, where) {
  const card = state.cards.get(id);
  const inDeck = where === 'deck';
  const index = state.order.indexOf(id);
  const over = ctx.over;
  const tag = cardTag(card);
  const op = (name, label, extra = {}) => {
    const btn = el('button', { class: 'dk-btn', type: 'button', 'data-id': id, 'data-op': name, 'aria-label': `${label}: ${card.text}`, text: label, ...extra });
    if (over || extra.disabled) btn.disabled = true;
    btn.addEventListener('click', () => {
      state.focus = { id, op: name };
      if (name === 'up') ctx.act('moveCard', id, index - 1);
      else if (name === 'down') ctx.act('moveCard', id, index + 1);
      else if (name === 'remove') ctx.act('removeCard', id);
      else if (name === 'add') ctx.act('moveCard', id, state.order.length);
    });
    return btn;
  };
  const node = el(
    'div',
    { class: `dk-card dk-card-${card.kind}${card.kind === 'from' && index > 0 ? ' dk-stage-break' : ''}`, role: 'listitem', draggable: over ? null : 'true', 'data-id': id },
    tag ? el('span', { class: 'dk-tag', text: tag }) : null,
    el('code', { class: 'dk-text', text: card.text }),
    el(
      'span',
      { class: 'dk-ops' },
      ...(inDeck
        ? [op('up', 'Up', { disabled: index === 0 }), op('down', 'Down', { disabled: index === state.order.length - 1 }), op('remove', 'Remove')]
        : [op('add', 'Add')]),
    ),
  );
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  });
  return node;
}

// Where in the deck a drop at clientY would land.
function dropIndex(deck, clientY) {
  const cards = [...deck.querySelectorAll('.dk-card')];
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return cards.length;
}

function wireDropZones(state, ctx) {
  const { deck, tray } = state.dom;
  deck.addEventListener('dragover', (e) => {
    e.preventDefault();
    deck.classList.add('dk-over');
  });
  deck.addEventListener('dragleave', () => deck.classList.remove('dk-over'));
  deck.addEventListener('drop', (e) => {
    e.preventDefault();
    deck.classList.remove('dk-over');
    const id = e.dataTransfer.getData('text/plain');
    if (state.cards.has(id)) ctx.act('moveCard', id, dropIndex(deck, e.clientY));
  });
  tray.addEventListener('dragover', (e) => e.preventDefault());
  tray.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (state.order.includes(id)) ctx.act('removeCard', id);
  });
}

// ---------------------------------------------------------------- panels

function layerRows(state) {
  const last = state.last;
  if (!last) return [el('p', { class: 'dk-empty', role: 'listitem', text: 'Press Build to see which layers are cached and which rebuild.' })];
  const rows = [];
  if (!last.ok) rows.push(el('div', { class: 'dk-layer dk-layer-error', role: 'listitem' }, el('span', { class: 'dk-badge', text: 'failed' }), el('span', { class: 'dk-ltext', text: `Build failed: ${last.error.short}. Read the output below.` })));
  let stage = -1;
  for (const l of last.layers) {
    if (l.stage !== stage) {
      stage = l.stage;
      if (last.layers.some((x) => x.stage !== 0)) rows.push(el('div', { class: 'dk-stage', text: `Stage ${stage + 1}${stage === Math.max(...last.layers.map((x) => x.stage)) ? ' (ships)' : ''}` }));
    }
    rows.push(
      el(
        'div',
        { class: `dk-layer dk-layer-${l.status.toLowerCase()}`, role: 'listitem' },
        el('span', { class: 'dk-badge', text: l.status === 'BUILT' ? (l.time >= 0.05 ? `built ${fmtS(l.time)}` : 'config') : l.status === 'CACHED' ? 'cached' : 'error' }),
        el('code', { class: 'dk-ltext', text: `${l.label} ${l.text}` }),
        l.size ? el('span', { class: 'dk-lsize', text: `+${fmtMB(l.size)}` }) : null,
      ),
    );
  }
  return rows;
}

function goalItems(state) {
  const g = state.goal;
  const r = state.last;
  const items = [{ ok: Boolean(r && r.ok), text: 'The build succeeds' }];
  if (g.runs !== false) items.push({ ok: Boolean(r && r.ok && r.runs), text: r && r.ok && !r.runs ? `The container starts: ${r.runsWhy}` : 'The container would start' });
  if (g.maxSize) items.push({ ok: Boolean(r && r.ok && r.size <= g.maxSize), text: `Image is at most ${g.maxSize} MB${r && r.ok ? ` (now ${fmtMB(r.size)})` : ''}` });
  if (g.noSecrets) items.push({ ok: Boolean(r && r.ok && !r.flags.leaksEnv), text: 'No secrets (.env) in the image' });
  if (g.nonRoot) items.push({ ok: Boolean(r && r.ok && r.flags.nonRoot), text: 'Runs as a non-root user' });
  items.push({ ok: state.okBuilds >= state.winTicks, text: `Successful builds: ${state.okBuilds} of ${state.winTicks}` });
  return items;
}

// ---------------------------------------------------------------- render

function render(state, ctx) {
  if (state.mode === 'compose') return renderCompose(state, ctx);
  const d = state.dom;
  d.deck.replaceChildren(...state.order.map((id) => cardEl(state, ctx, id, 'deck')));
  if (!state.order.length) d.deck.append(el('p', { class: 'dk-empty', role: 'listitem', text: 'Empty. Add cards from the tray below.' }));
  const free = trayIds(state);
  d.tray.replaceChildren(...(free.length ? free.map((id) => cardEl(state, ctx, id, 'tray')) : [el('p', { class: 'dk-empty', role: 'listitem', text: 'Every card is in the Dockerfile.' })]));
  d.layers.replaceChildren(...layerRows(state));
  d.goals.replaceChildren(
    ...goalItems(state).map((g) => el('div', { class: `dk-goal dk-goal-${g.ok ? 'ok' : 'todo'}`, role: 'listitem' }, el('span', { class: 'dk-goal-mark', text: g.ok ? 'done' : 'todo' }), el('span', { text: g.text }))),
  );
  const r = state.last;
  d.stats.textContent = r && r.ok ? `Last build ${fmtS(r.seconds)} · image ${fmtMB(r.size)} · ${r.runs ? 'container starts' : 'container would not start'}` : r ? 'Last build failed.' : 'No build yet.';
  d.log.textContent = r ? r.lines.join('\n') : 'The build log appears here, in the format docker build prints it.';

  if (state.focus) {
    const { id, op } = state.focus;
    const find = (o) => d.root.querySelector(`button[data-id="${id}"][data-op="${o}"]:not(:disabled)`);
    (find(op) || find('up') || find('down') || find('remove') || find('add'))?.focus();
    state.focus = null;
  }
}

// ---------------------------------------------------------------- the game

registerGame({
  id: 'docker',
  styles: 'game.css',

  init(state, ctx) {
    // The Compose level has its own model and board (compose.js, compose-ui.js).
    if (ctx.scenario.mode === 'compose') {
      Object.assign(state, compose.createComposeWorld(ctx.scenario));
      return initCompose(state, ctx);
    }
    Object.assign(state, createWorld(ctx.scenario));
    state.focus = null;
    const deck = el('div', { class: 'dk-deck', role: 'list', 'aria-label': 'Dockerfile, top to bottom' });
    const tray = el('div', { class: 'dk-tray', role: 'list', 'aria-label': 'Cards not in the Dockerfile' });
    const layers = el('div', { class: 'dk-layers', role: 'list', 'aria-label': 'Layers from the last build' });
    const goals = el('div', { class: 'dk-goals', role: 'list', 'aria-label': 'Goals' });
    const stats = el('p', { class: 'dk-stats', role: 'status' });
    const log = el('pre', { class: 'dk-log', tabindex: 0, role: 'log', 'aria-label': 'Build output' });
    const root = el(
      'div',
      { class: 'dk' },
      el(
        'div',
        { class: 'dk-cols' },
        el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'Dockerfile (top runs first)' }), deck, el('p', { class: 'dk-hint', text: 'Drag cards, or use Up / Down / Remove.' })),
        el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'Last build' }), layers, stats),
      ),
      el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'Card tray' }), tray),
      el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'Goals' }), goals),
      el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'Build output' }), log),
    );
    state.dom = { root, deck, tray, layers, goals, stats, log };
    wireDropZones(state, ctx);
    ctx.ui.board.append(root);
    ctx.log('Arrange the Dockerfile, then press Build. The first build is free; later ones cost budget in proportion to the layers that rebuild.');
  },

  // How a move reads in the debrief and in the efficient path.
  describeMove(name, args) {
    if (name === 'arrange') return `Arrange the Dockerfile: ${args[0].join(' → ')}`;
    if (name === 'choose') return `Choose ${args[0]} = ${args[1]}`;
    if (name === 'recreate') return 'Recreate the stack (down, then up)';
    return undefined;
  },

  tick: (state, ctx) => (state.mode === 'compose' ? compose.tick(state, ctx) : simTick(state, ctx)),

  actions: {
    build: {
      label: 'Build',
      key: 'b',
      run(state, ctx) {
        // In the Compose level this button is "Up": docker compose up -d.
        if (state.mode === 'compose') compose.runUp(state, ctx);
        else state.last = runBuild(state, ctx);
      },
    },
    choose: { hidden: true, run: (state, ctx, slot, option) => (compose.choose(state, slot, option) ? 'free' : false) },
    recreate: {
      hidden: true,
      run(state, ctx) {
        if (compose.runRecreate(state, ctx)) return undefined;
        renderCompose(state, ctx); // the engine does not re-render after `false`
        return false;
      },
    },
    moveCard: { hidden: true, run: (state, ctx, id, to) => (moveCard(state, id, to) ? 'free' : false) },
    removeCard: { hidden: true, run: (state, ctx, id) => (removeCard(state, id) ? 'free' : false) },
    arrange: { hidden: true, run: (state, ctx, ids) => (arrange(state, ids) ? 'free' : false) },
  },

  isWon: (state) => (state.mode === 'compose' ? compose.isWon(state) : simIsWon(state)),
  isLost: (state) => (state.mode === 'compose' ? compose.isLost(state) : simIsLost(state)),
  render,
});

