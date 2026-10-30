// The board for the Compose level of Layer Cake: one radio group per compose.yaml slot, the YAML those
// choices write, and the output of `docker compose up -d`. Built from divs and fieldsets (no lists).
import { el } from '../shared/ui.js';
import { askCompose, composeYaml, goals } from './compose.js';
import { renderPredict } from './predict-ui.js';

export function initCompose(state, ctx) {
  state.focus = null;
  const slotsEl = el('div', { class: 'dk-slots' });
  const yaml = el('pre', { class: 'dk-yaml', tabindex: 0, 'aria-label': 'compose.yaml' });
  const goalsEl = el('div', { class: 'dk-goals', role: 'list', 'aria-label': 'Goals' });
  const log = el('pre', { class: 'dk-log', tabindex: 0, role: 'log', 'aria-label': 'docker compose output' });
  const recreate = el('button', { class: 'dk-btn dk-btn-wide', type: 'button', text: 'Recreate: docker compose down, then up' });
  recreate.addEventListener('click', () => ctx.act('recreate'));
  const predictBox = el('section', { class: 'dk-panel dk-predict', 'aria-label': 'Prediction', hidden: true });
  const root = el(
    'div',
    { class: 'dk dk-cmp' },
    predictBox,
    el(
      'div',
      { class: 'dk-cols' },
      el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'Pick one line for each slot' }), slotsEl),
      el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'compose.yaml' }), yaml),
    ),
    el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'Goals' }), goalsEl),
    el('section', { class: 'dk-panel' }, el('h4', { class: 'dk-h', text: 'Output' }), el('p', { class: 'dk-hint', text: 'Up (b) starts the stack. Recreate checks that the data survives.' }), recreate, log),
  );
  state.dom = { root, slotsEl, yaml, goalsEl, log, recreate, predict: predictBox };
  state.draft = null;
  ctx.ui.board.append(root);
  ctx.log('Pick a line for each slot, then press Up. A failed Up costs budget, so read the output first. Changing the wiring means starting it again.');
}

function slotEl(state, ctx, slot) {
  const over = ctx.over;
  const group = el('fieldset', { class: 'dk-slot' }, el('legend', { class: 'dk-slot-name' }, el('strong', { text: slot.service || 'top level' }), ` · ${slot.label}`));
  for (const opt of slot.options) {
    const id = `cmp-${slot.id}-${opt.id}`;
    const input = el('input', { type: 'radio', name: `cmp-${slot.id}`, id, value: opt.id, disabled: over ? '' : null });
    input.checked = state.choices[slot.id] === opt.id;
    input.addEventListener('change', () => {
      state.focus = id;
      ctx.act('choose', slot.id, opt.id);
    });
    group.append(el('label', { class: 'dk-opt', for: id }, input, el('code', { text: opt.yaml ? opt.yaml.split('\n').map((l) => l.trim()).join(' ') : '(leave it out)' })));
  }
  return group;
}

export function renderCompose(state, ctx) {
  const d = state.dom;
  state.question = askCompose(state);
  d.slotsEl.replaceChildren(...state.slots.map((s) => slotEl(state, ctx, s)));
  d.yaml.textContent = composeYaml(state, ctx.scenario);
  d.goalsEl.replaceChildren(
    ...[...goals(state), ...(state.predictions.total ? [{ ok: state.predictions.right === state.predictions.total, text: `Predictions right: ${state.predictions.right} of ${state.predictions.total}` }] : [])].map((g) => el('div', { class: `dk-goal dk-goal-${g.ok ? 'ok' : 'todo'}`, role: 'listitem' }, el('span', { class: 'dk-goal-mark', text: g.ok ? 'done' : 'todo' }), el('span', { text: g.text }))),
  );
  d.log.textContent = state.last ? state.last.lines.join('\n') : 'The output of docker compose appears here.';
  d.recreate.disabled = ctx.over;
  renderPredict(state, ctx);
  if (state.focus) {
    document.getElementById(state.focus)?.focus();
    state.focus = null;
  }
}
