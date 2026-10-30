// The "predict before you build" panel, shared by the Dockerfile levels and the Compose level: the question as
// toggles, then, once answered, the verdict with the reason for each answer.
import { el } from '../shared/ui.js';
import { askCompose } from './compose.js';
import { PREDICT_COST, askQuestion } from './sim.js';

// `rebuild` questions take any number of layers; `fails` (which line breaks) and `choose` (Yes or No) take one answer.
const isSingle = (kind) => kind !== 'rebuild';

const questionFor = (state, ctx) => (state.mode === 'compose' ? askCompose(state) : askQuestion(state, ctx.scenario));

// The question (when there is one) as toggles, then, once answered, the verdict with the reason for each layer.
export function renderPredict(state, ctx) {
  const d = state.dom;
  const q = questionFor(state, ctx);
  const answered = q && state.predictedFor === q.sig;
  const box = d.predict;
  if (!q && !state.verdict) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (q && !answered) {
    state.draft = state.draft && state.draft.sig === q.sig ? state.draft : { sig: q.sig, picked: new Set() };
    const rows = q.layers.map((layer, i) => {
      const on = state.draft.picked.has(i);
      const b = el('button', { class: 'dk-pick', type: 'button', 'aria-pressed': String(on), 'data-i': i }, el('code', { text: layer.text }), el('span', { class: 'dk-pick-state', text: q.kind === 'rebuild' ? (on ? 'rebuilds' : 'cached') : on ? (q.kind === 'fails' ? 'fails here' : 'my answer') : '' }));
      b.disabled = ctx.over;
      b.addEventListener('click', () => {
        if (isSingle(q.kind)) state.draft.picked = new Set(on ? [] : [i]);
        else if (on) state.draft.picked.delete(i);
        else state.draft.picked.add(i);
        renderPredict(state, ctx);
      });
      return b;
    });
    const lock = el('button', { class: 'cg-btn cg-btn-primary dk-lock', type: 'button', text: 'Lock in my prediction' });
    lock.disabled = ctx.over || (isSingle(q.kind) && !state.draft.picked.size);
    lock.addEventListener('click', () => ctx.act('predict', [...state.draft.picked].sort((a, b) => a - b)));
    box.replaceChildren(
      el('h4', { class: 'dk-h', text: 'Predict before you build' }),
      el('p', { class: 'dk-hint', text: q.intro }),
      el('div', { class: 'dk-picks', role: 'group', 'aria-label': 'Layers' }, ...rows),
      lock,
      el('p', { class: 'dk-hint', text: `Each layer you get wrong costs ${PREDICT_COST}% of the build budget. Build unlocks once you have answered.` }),
    );
    return;
  }
  const v = state.verdict;
  const rows = v.layers.map((layer, i) => {
    const truth = v.truth[i];
    const guessed = v.picked.includes(i);
    const right = guessed === truth;
    const what = v.kind === 'fails' ? (truth ? 'fails here' : 'runs') : v.kind === 'choose' ? (truth ? 'the right answer' : 'not the answer') : truth ? 'rebuilds' : 'cached';
    const why = isSingle(v.kind) ? (truth ? v.why : '') : v.whys[i] || '';
    return el('div', { class: `dk-verdict dk-verdict-${right ? 'right' : 'wrong'}`, role: 'listitem' }, el('span', { class: 'dk-badge', text: right ? 'right' : 'wrong' }), el('code', { class: 'dk-ltext', text: layer.text }), el('span', { class: 'dk-why', text: `${what}${why ? `: ${why}` : ''}` }));
  });
  box.replaceChildren(
    el('h4', { class: 'dk-h', text: v.wrong ? `Prediction: ${v.total - v.wrong} of ${v.total} right` : 'Prediction: all right' }),
    el('div', { role: 'list', 'aria-label': 'What really happens' }, ...rows),
    v.cost ? el('p', { class: 'dk-hint', text: `That cost ${v.cost}% of the build budget.` }) : null,
  );
}

