// "Pipeline Panic": build a GitHub Actions workflow out of cards (Pipeline Tycoon), then pick a
// deployment strategy for each release (Deploy Day). The simulation is in sim.js (DOM-free); this
// file is the two boards and the registerGame wiring. Both modes are turn-based.
import { registerGame } from '../shared/engine.js';
import { el } from '../shared/ui.js';
import {
  applyAction,
  currentRelease,
  goals,
  incoming,
  isLost as simIsLost,
  isWon as simIsWon,
  newShare,
  pipelineStats,
  previewText,
  securityScore,
  startDeploy,
  tick as simTick,
  tileStates,
  createWorld,
  fmtMin,
} from './sim.js';

const STAGES = ['dev', 'staging', 'prod'];
const STRATEGIES = [
  ['rolling', 'Rolling'],
  ['bluegreen', 'Blue-green'],
  ['canary', 'Canary'],
];

// ---------------------------------------------------------------- shared pieces

function goalRows(w) {
  return goals(w).map((g) => el('div', { class: `cp-goal cp-goal-${g.ok ? 'ok' : 'todo'}`, role: 'listitem' }, el('span', { class: 'cp-goal-mark', text: g.ok ? 'done' : 'todo' }), el('span', { text: g.text })));
}

function termLines(w) {
  return w.out.map((l) => el('span', { class: `cp-line cp-line-${l.kind}`, text: `${l.text}\n` }));
}

// Re-render replaces the buttons, so remember which one had focus and give it back.
function withFocus(root, draw) {
  const active = document.activeElement;
  const key = active && root.contains(active) ? active.dataset.k : null;
  draw();
  if (key) root.querySelector(`[data-k="${CSS.escape(key)}"]:not(:disabled)`)?.focus({ preventScroll: true });
}

function scrollEnd(node, stick) {
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  if (stick || atBottom) node.scrollTop = node.scrollHeight;
}

// ---------------------------------------------------------------- Pipeline Tycoon

function cardRow(state, ctx, id, placed) {
  const card = state.cards.get(id);
  const btn = el('button', { class: 'cp-btn', type: 'button', 'data-k': `card:${id}`, 'aria-label': `${placed ? 'Remove' : 'Add'}: ${card.label}`, text: placed ? 'Remove' : 'Add' });
  if (ctx.over) btn.disabled = true;
  btn.addEventListener('click', () => ctx.act(placed ? 'remove' : 'place', id));
  return el('div', { class: `cp-card${placed ? ' cp-card-on' : ''}`, role: 'listitem' }, el('code', { class: 'cp-card-label', text: card.label }), el('span', { class: 'cp-card-tip', text: card.tip }), btn);
}

function renderPipeline(state, ctx) {
  const d = state.dom;
  const w = state;
  const next = incoming(w, ctx);
  d.next.textContent = ctx.over ? 'The run is over.' : next ? `Next event: ${next}` : 'No more events this month.';
  d.goals.replaceChildren(...goalRows(w));
  const s = pipelineStats(w);
  const sec = securityScore(w);
  const facts = [`Runner minutes ${fmtMin(s.minutes)} of ${w.budget}`, s.median === null ? 'Median feedback: no run yet' : `Median PR feedback ${fmtMin(Math.round(s.median * 10) / 10)} min`];
  if (w.goal.minSecurity) facts.push(`Security ${sec.score} of 100`);
  if (s.efficiency !== null) facts.push(`${s.efficiency} PRs merged per 100 min`);
  d.facts.textContent = facts.join(' · ');
  d.secNotes.textContent = w.goal.minSecurity && sec.notes.length ? `Security: ${sec.notes.join('; ')}.` : '';
  d.secNotes.hidden = !d.secNotes.textContent;

  const onIds = w.tray.filter((id) => w.placed.includes(id));
  const offIds = w.tray.filter((id) => !w.placed.includes(id));
  d.on.replaceChildren(...(onIds.length ? onIds.map((id) => cardRow(w, ctx, id, true)) : [el('p', { class: 'cp-empty', role: 'listitem', text: 'No cards: the workflow has no triggers and never runs.' })]));
  d.off.replaceChildren(...(offIds.length ? offIds.map((id) => cardRow(w, ctx, id, false)) : [el('p', { class: 'cp-empty', role: 'listitem', text: 'Every card is in the workflow.' })]));
  d.onHead.textContent = `In the workflow (${onIds.length})`;
  d.offHead.textContent = `Card tray (${offIds.length})`;

  d.yaml.textContent = previewText(w);
  d.term.replaceChildren(...(w.out.length ? termLines(w) : [el('span', { class: 'cp-line cp-line-dim', text: 'Run the next event to see what the workflow does with it.\n' })]));
  scrollEnd(d.term, d.stick);
  d.stick = false;
}

function initPipeline(state, ctx) {
  const next = el('p', { class: 'cp-next', role: 'status' });
  const goalsEl = el('div', { class: 'cp-goals', role: 'list', 'aria-label': 'Goals' });
  const facts = el('p', { class: 'cp-facts' });
  const secNotes = el('p', { class: 'cp-facts', hidden: true });
  const onHead = el('h3', { class: 'cp-h' });
  const offHead = el('h3', { class: 'cp-h' });
  const on = el('div', { class: 'cp-cards', role: 'list', 'aria-label': 'Cards in the workflow' });
  const off = el('div', { class: 'cp-cards', role: 'list', 'aria-label': 'Cards in the tray' });
  const yaml = el('pre', { class: 'cp-code', tabindex: 0, role: 'region', 'aria-label': 'Generated workflow YAML' });
  const term = el('pre', { class: 'cp-term', tabindex: 0, role: 'log', 'aria-label': 'Workflow run output' });
  const root = el(
    'div',
    { class: 'cp' },
    el('section', { class: 'cp-panel' }, el('h3', { class: 'cp-h', text: 'This month' }), next, facts, secNotes, goalsEl),
    el(
      'div',
      { class: 'cp-cols' },
      el('section', { class: 'cp-panel' }, onHead, on, offHead, off),
      el('section', { class: 'cp-panel' }, el('h3', { class: 'cp-h', text: 'Workflow YAML (live preview)' }), yaml),
    ),
    el('section', { class: 'cp-panel' }, el('h3', { class: 'cp-h', text: 'Actions run output' }), term),
  );
  state.dom = { root, next, goals: goalsEl, facts, secNotes, on, off, onHead, offHead, yaml, term, stick: true };
  ctx.ui.board.append(root);
  ctx.log('Add or remove cards: the YAML preview is the real workflow. Run next event to push the next PR through it. The next event is shown first.');
}

// ---------------------------------------------------------------- Deploy Day

function deployButton(ctx, key, label, act, args = [], extra = {}) {
  const btn = el('button', { class: `cp-btn${extra.primary ? ' cp-btn-primary' : ''}`, type: 'button', 'data-k': key, text: label });
  if (ctx.over) btn.disabled = true;
  btn.addEventListener('click', () => ctx.act(act, ...args));
  return btn;
}

function laneEl(w) {
  const rel = currentRelease(w);
  const at = rel ? STAGES.indexOf(w.stage) : -1;
  const boxes = STAGES.map((name, i) => {
    const here = i === at;
    let note = '';
    if (name === 'staging' && here && w.soak) note = w.soak === 'running' ? 'soak running' : w.soak === 'pass' ? 'tests passed' : 'tests FAILED';
    if (name === 'prod' && here && w.rollout) note = w.rollout.kind;
    return el('div', { class: `cd-env${here ? ' cd-env-here' : ''}`, role: 'listitem', 'aria-current': here ? 'step' : null }, el('strong', { text: name }), el('span', { class: 'cd-env-note', text: here ? (note ? `here: ${note}` : 'here') : i < at ? 'passed' : 'waiting' }));
  });
  const out = [];
  boxes.forEach((b, i) => {
    out.push(b);
    if (i < boxes.length - 1) out.push(el('span', { class: 'cd-arrow', 'aria-hidden': 'true', text: i === 1 ? '→ gate →' : '→' }));
  });
  return out;
}

function controls(w, ctx) {
  const rel = currentRelease(w);
  const out = [];
  const add = (...b) => out.push(...b);
  if (w.drift) add(deployButton(ctx, 'commit', 'Commit the hot-fix to git', 'commit', [], { primary: true }));
  if (!rel) return out;
  const strategies = (prefix) => STRATEGIES.map(([k, label]) => deployButton(ctx, `deploy:${k}`, `${prefix}${label}`, 'deploy', [k]));
  if (rel.migration === 'breaking' && !w.expanded && !w.rollout) add(deployButton(ctx, 'expand', 'Ship the migration alone first (expand)', 'expand'));
  if (w.stage === 'dev') {
    add(deployButton(ctx, 'promote', 'Promote to staging', 'promote', [], { primary: true }), deployButton(ctx, 'reject', 'Reject release', 'reject'));
    add(...strategies('Skip staging: '));
  } else if (w.stage === 'staging') {
    add(deployButton(ctx, 'reject', 'Reject release', 'reject'));
    if (w.soak !== 'running') add(...strategies('Approve and deploy: '));
  } else if (w.rollout) {
    const r = w.rollout;
    if (r.kind === 'bluegreen' && r.built && !r.live) add(deployButton(ctx, 'cutover', 'Cut over all traffic to green', 'cutover', [], { primary: true }));
    if (r.kind === 'canary' && r.pct < 100) add(deployButton(ctx, 'widen', `Widen the canary to ${[25, 50, 100][r.step]}%`, 'widen'));
    if (w.contracted) add(deployButton(ctx, 'rollForward', 'Roll forward with a fix', 'rollForward'));
    const back = r.kind === 'rolling' ? 'Roll back (undo the rollout)' : r.kind === 'bluegreen' ? (r.live ? 'Switch traffic back to blue' : 'Tear down green') : 'Abort the canary';
    add(deployButton(ctx, 'rollback', back, 'rollback'));
  }
  return out;
}

function graphBars(w) {
  const h50 = (v) => `${Math.max(3, Math.min(100, (v / 0.5) * 100))}%`;
  return w.history.map((h) => {
    const pct = (v) => (v === null ? 'none' : `${Math.round(v * 100)}%`);
    return el(
      'span',
      { class: 'cd-pair', title: `minute ${h.min}: all traffic ${pct(h.all)}, new version ${pct(h.fresh)}` },
      el('span', { class: `cd-bar${h.all >= 0.05 ? ' cd-bar-bad' : ''}`, style: `height:${h50(h.all)}` }),
      h.fresh === null ? el('span', { class: 'cd-bar cd-bar-none' }) : el('span', { class: `cd-bar cd-bar-new${h.fresh >= 0.05 ? ' cd-bar-bad' : ''}`, style: `height:${h50(h.fresh)}` }),
    );
  });
}

function readout(w) {
  const h = w.history[w.history.length - 1];
  if (!h) return 'No traffic measured yet. Wait a minute to see the first data point.';
  const pct = (v) => (v === null ? 'none' : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);
  return `Error rate now: all traffic ${pct(h.all)} · new version ${pct(h.fresh)} · old version ${pct(h.stable)}`;
}

function renderDeploy(state, ctx) {
  const d = state.dom;
  const w = state;
  const rel = currentRelease(w);
  d.relHead.textContent = rel ? `Release ${rel.version}: ${rel.title}` : 'No release waiting';
  d.notes.replaceChildren(...(rel ? rel.notes.map((n) => el('div', { class: 'cd-note', role: 'listitem', text: n })) : [el('p', { class: 'cp-empty', role: 'listitem', text: 'Every release is settled.' })]));
  d.lane.replaceChildren(...laneEl(w));
  d.queue.textContent = rel ? `Release ${w.idx + 1} of ${w.releases.length}${w.releases.length - w.idx - 1 ? `, ${w.releases.length - w.idx - 1} more waiting` : ''}. Settled: ${w.settled.map((s) => `${s.version} ${s.outcome}`).join(', ') || 'none yet'}.` : `Settled: ${w.settled.map((s) => `${s.version} ${s.outcome}`).join(', ')}.`;
  d.drift.textContent = w.drift ? 'Prod differs from git: 4 pods run a hand-patched image.' : '';
  d.drift.hidden = !w.drift;

  withFocus(d.root, () => d.controls.replaceChildren(...controls(w, ctx)));

  const states = tileStates(w);
  d.fleet.replaceChildren(...states.map((s, i) => el('div', { class: `cd-tile cd-tile-${s}`, role: 'listitem', 'aria-label': `Pod ${i + 1}: ${s === 'new' ? 'new version' : 'old version'}` }, el('span', { 'aria-hidden': 'true', text: s === 'new' ? 'new' : 'old' }))));
  const share = Math.round(newShare(w) * 100);
  const r = w.rollout;
  d.fleetNote.textContent = r ? `${share}% of traffic is on the new version.${r.kind === 'bluegreen' ? ` Green is ${r.live ? 'live' : r.built ? 'ready, taking no user traffic' : 'being built'}.` : ''}` : 'All traffic is on the old version.';

  d.bars.replaceChildren(...graphBars(w));
  const last = w.history.slice(-5).map((h) => `${Math.round(h.all * 100)}%`).join(', ');
  d.graph.setAttribute('aria-label', `Error rate per minute, newest last: ${last || 'no data yet'}. Alert line at 5%.`);
  d.read.textContent = readout(w);
  d.users.textContent = `Failed requests: ${w.failedRelease} for this release, ${w.failedTotal} today (the day's budget is ${w.failScale}).`;

  d.goals.replaceChildren(...goalRows(w));
  d.term.replaceChildren(...(w.out.length ? termLines(w) : [el('span', { class: 'cp-line cp-line-dim', text: 'The console shows what each move runs.\n' })]));
  scrollEnd(d.term, d.stick);
  d.stick = false;
}

function initDeploy(state, ctx) {
  const relHead = el('h3', { class: 'cp-h' });
  const notes = el('div', { class: 'cd-notes', role: 'list', 'aria-label': 'Release notes' });
  const lane = el('div', { class: 'cd-lane', role: 'list', 'aria-label': 'Environments' });
  const queue = el('p', { class: 'cp-facts' });
  const drift = el('p', { class: 'cp-next', role: 'status', hidden: true });
  const controlsEl = el('div', { class: 'cd-controls', role: 'group', 'aria-label': 'Release controls' });
  const fleet = el('div', { class: 'cd-fleet', role: 'list', 'aria-label': 'Production pods' });
  const fleetNote = el('p', { class: 'cp-facts' });
  const bars = el('div', { class: 'cd-bars', 'aria-hidden': 'true' });
  const graph = el('div', { class: 'cd-graph', role: 'img' }, bars, el('span', { class: 'cd-alert-line', 'aria-hidden': 'true', text: 'alert 5%' }));
  const legend = el('p', { class: 'cp-facts', text: 'Per minute: solid bar = all traffic, hatched bar = the new version only. Dashed line = 5% alert.' });
  const read = el('p', { class: 'cp-facts', role: 'status' });
  const users = el('p', { class: 'cp-facts' });
  const goalsEl = el('div', { class: 'cp-goals', role: 'list', 'aria-label': 'Goals' });
  const term = el('pre', { class: 'cp-term', tabindex: 0, role: 'log', 'aria-label': 'Release console' });
  const root = el(
    'div',
    { class: 'cp' },
    el('section', { class: 'cp-panel' }, relHead, notes, el('div', { class: 'cd-lane-wrap' }, lane), queue, drift),
    el('section', { class: 'cp-panel' }, el('h3', { class: 'cp-h', text: 'Your move' }), controlsEl, el('p', { class: 'cp-hint', text: 'Wait a minute (w) lets time pass: rollouts advance and the graph gets a new point.' })),
    el(
      'div',
      { class: 'cp-cols' },
      el('section', { class: 'cp-panel' }, el('h3', { class: 'cp-h', text: 'Production fleet (20 pods, 5% each)' }), fleet, fleetNote),
      el('section', { class: 'cp-panel' }, el('h3', { class: 'cp-h', text: 'Error rate per minute' }), graph, legend, read, users),
    ),
    el('section', { class: 'cp-panel' }, el('h3', { class: 'cp-h', text: 'Goals' }), goalsEl),
    el('section', { class: 'cp-panel' }, el('h3', { class: 'cp-h', text: 'Release console' }), term),
  );
  state.dom = { root, relHead, notes, lane, queue, drift, controls: controlsEl, fleet, fleetNote, bars, graph, read, users, goals: goalsEl, term, stick: true };
  ctx.ui.board.append(root);
  startDeploy(state, ctx);
  ctx.log('Promote a release through staging, then choose how it reaches prod. Wait a minute to let time pass, and watch the error rate.');
}

// ---------------------------------------------------------------- render and the game

function render(state, ctx) {
  const root = ctx.ui.board.closest('.cg');
  const pipeline = state.mode === 'pipeline';
  // The shell shows a button per visible action; each level uses only one of these two.
  const runBtn = root.querySelector('[data-action="runNext"]');
  const waitBtn = root.querySelector('[data-action="wait"]');
  if (runBtn) runBtn.hidden = !pipeline;
  if (waitBtn) waitBtn.hidden = pipeline;
  if (pipeline) withFocus(state.dom.root, () => renderPipeline(state, ctx));
  else renderDeploy(state, ctx);
}

// Every move goes through applyAction (sim.js). A rejected move is not re-rendered by the engine, so it renders itself.
const move = (name) => (state, ctx, ...args) => {
  const result = applyAction(state, ctx, name, ...args);
  if (result === false) render(state, ctx);
  else if (name === 'runNext' || name === 'wait') state.dom.stick = true;
  return result;
};

registerGame({
  id: 'cicd',
  styles: 'game.css',

  init(state, ctx) {
    Object.assign(state, createWorld(ctx.scenario));
    if (state.mode === 'pipeline') initPipeline(state, ctx);
    else initDeploy(state, ctx);
  },

  tick: (state, ctx) => simTick(state, ctx),

  actions: {
    runNext: { label: 'Run next event', key: 'e', run: move('runNext') },
    wait: { label: 'Wait a minute', key: 'w', run: move('wait') },
    place: { hidden: true, run: move('place') },
    remove: { hidden: true, run: move('remove') },
    promote: { hidden: true, run: move('promote') },
    reject: { hidden: true, run: move('reject') },
    expand: { hidden: true, run: move('expand') },
    commit: { hidden: true, run: move('commit') },
    deploy: { hidden: true, run: move('deploy') },
    cutover: { hidden: true, run: move('cutover') },
    widen: { hidden: true, run: move('widen') },
    rollback: { hidden: true, run: move('rollback') },
    rollForward: { hidden: true, run: move('rollForward') },
  },

  isWon: (state) => simIsWon(state),
  isLost: (state) => simIsLost(state),
  render,
});

