// "Skill Issue": author an Agent Skill and see whether a simulated agent would trigger it.
// The rules are in sim.js (DOM-free); this file is the board and the registerGame wiring. The game is
// turn-based: a request is served only when you press "Send next request".
import { registerGame } from '../shared/engine.js';
import { el } from '../shared/ui.js';
import {
  LAYERS,
  LAYER_LABEL,
  LOCATIONS,
  THRESHOLD,
  candidates,
  checkSkill,
  createWorld,
  evaluate,
  hintsFor,
  isLost as simIsLost,
  isWon as simIsWon,
  lintReport,
  place as simPlace,
  saveText as simSaveText,
  setDir as simSetDir,
  setLocation as simSetLocation,
  skillStatus,
  tick as simTick,
} from './sim.js';

const SEGMENTS = [
  ['base', 'Conversation'],
  ['meta', 'Skill names and descriptions'],
  ['body', 'Body of the chosen skill'],
  ['bundled', 'Bundled files opened'],
];

const OUTCOME_TITLE = {
  ok: 'Served',
  overflow: 'Window overflowed',
  missed: 'Never triggered',
  wrong: 'Wrong skill',
  'false-trigger': 'False trigger',
  'lint-rejected': 'Rejected by the gate',
  'not-discovered': 'Not discovered',
  stale: 'Stale script',
  incomplete: 'Script not mentioned',
  'no-procedure': 'No procedure in the body',
  blocked: 'Tool blocked',
  scope: 'Out of scope',
};

const pts = (n) => `${n} pt${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- panes

function loadsOf(w) {
  const next = w.requests[w.cursor];
  if (next) return { result: evaluate(w, next), label: 'If the next request arrived now' };
  return w.last ? { result: w.last, label: 'The last request loaded' } : null;
}

function contextPane(w, d) {
  const shown = loadsOf(w);
  const window = w.window;
  const loads = shown ? shown.result.loads : { base: w.base, meta: candidates(w).reduce((n, c) => n + c.fmTokens, 0), body: 0, bundled: 0 };
  const total = loads.base + loads.meta + loads.body + loads.bundled;
  const scale = Math.max(window, total);
  d.bar.replaceChildren(
    ...SEGMENTS.map(([key]) => el('span', { class: `sk-seg sk-seg-${key}`, style: `width:${((loads[key] / scale) * 100).toFixed(2)}%` })),
    el('span', { class: 'sk-limit', style: `left:${((window / scale) * 100).toFixed(2)}%`, 'aria-hidden': 'true' }),
  );
  const over = total > window;
  d.bar.setAttribute('aria-label', `Context window: ${total} of ${window} tokens${over ? ', over the limit' : ''}`);
  d.legend.replaceChildren(
    ...SEGMENTS.map(([key, label]) => el('span', { class: 'sk-leg' }, el('span', { class: `sk-swatch sk-seg-${key}`, 'aria-hidden': 'true' }), `${label} ${loads[key]}`)),
  );
  d.total.textContent = `${shown ? shown.label : 'Before any request'}: ${total} of ${window} tokens${over ? ` (over by ${total - window})` : ''}`;
  d.total.dataset.over = String(over);
}

function shelfPane(w) {
  const sk = skillStatus(w);
  const cards = candidates(w).map((c) => {
    const status = c.mine ? 'yours, installed' : 'installed';
    return el(
      'div',
      { class: 'sk-card', role: 'listitem', 'data-mine': String(c.mine) },
      el('strong', { class: 'sk-name', text: c.name }),
      el('span', { class: 'sk-chip', text: status }),
      el('span', { class: 'sk-tok', text: `always loaded: ${c.fmTokens} tokens` }),
      el('p', { class: 'sk-desc', text: c.description }),
    );
  });
  if (!sk.discoverable) {
    const why = sk.errors.length ? `rejected by the gate (${sk.errors.length} error${sk.errors.length > 1 ? 's' : ''})` : `not discovered: ${w.skill.location}/ is not scanned`;
    cards.unshift(
      el(
        'div',
        { class: 'sk-card sk-card-off', role: 'listitem', 'data-mine': 'true' },
        el('strong', { class: 'sk-name', text: w.skillName }),
        el('span', { class: 'sk-chip sk-chip-bad', text: `yours, ${why}` }),
        el('p', { class: 'sk-desc', text: 'The agent cannot see this skill.' }),
      ),
    );
  }
  return cards;
}

function requestPane(w) {
  return w.requests.map((req, i) => {
    const done = w.results[i];
    const next = i === w.cursor;
    let state = 'queued';
    let chip = 'Waiting';
    let detail;
    if (done) {
      state = done.ok ? 'ok' : 'fail';
      chip = done.ok ? 'Served' : OUTCOME_TITLE[done.outcome];
      detail = done.message;
    } else {
      const p = evaluate(w, req);
      state = next ? 'next' : 'queued';
      chip = next ? 'Next' : 'Waiting';
      const picked = p.pick ? `${p.pick} (${pts(p.scores.find((s) => s.name === p.pick).score)})` : `no skill (best ${pts(p.scores[0] ? p.scores[0].score : 0)})`;
      detail = `${p.ok ? 'On track' : 'Would fail'}: the agent would pick ${picked}${p.ok ? '' : `. ${p.message}`}`;
    }
    const wantText = req.want ? `Right skill: ${req.want}` : 'No skill needed';
    return el(
      'div',
      { class: 'sk-req', role: 'listitem', 'data-state': state },
      el('span', { class: 'sk-n', text: String(i + 1) }),
      el('span', { class: 'sk-req-text', text: `"${req.text}"` }),
      el('span', { class: 'sk-chip', text: chip }),
      el('span', { class: 'sk-want', text: wantText }),
      el('span', { class: 'sk-detail', text: detail }),
    );
  });
}

function agentPane(w) {
  const r = w.last;
  if (!r) {
    return [
      el('p', { class: 'sk-muted', text: 'Send a request to see what the agent sees and why it picks (or skips) a skill.' }),
      el('p', { class: 'sk-muted', text: `Simplified on purpose: the agent counts words shared with each description (2 points for a word in the "Use when" part, 1 elsewhere, ${THRESHOLD} to trigger). A real model is not this simple.` }),
    ];
  }
  const rows = r.scores.map((s) =>
    el(
      'div',
      { class: 'sk-score', role: 'listitem', 'data-pick': String(s.name === r.pick) },
      el('strong', { text: s.name }),
      el('span', { class: 'sk-pts', text: pts(s.score) }),
      el('span', { class: 'sk-matched', text: s.matches.length ? s.matches.map((m) => `${m.word} +${m.points}`).join(', ') : 'no shared words' }),
    ),
  );
  return [
    el('p', { class: 'sk-quote', text: `Request ${r.index + 1}: "${r.req.text}"` }),
    el('p', { class: 'sk-muted', text: 'The agent sees only each skill\'s name and description, and scores them:' }),
    el('div', { class: 'sk-scores', role: 'list', 'aria-label': 'Match scores' }, ...rows),
    el('p', { text: r.pick ? `It picks ${r.pick}, then loads ${r.loads.body} tokens of body${r.loads.bundled ? ` and ${r.loads.bundled} of bundled files` : ''}.` : `Nothing reaches ${THRESHOLD} points, so it answers without a skill.` }),
    el('p', { class: `sk-outcome sk-outcome-${r.ok ? 'ok' : 'bad'}`, text: `${r.ok ? 'Served' : OUTCOME_TITLE[r.outcome]}. ${r.message}` }),
  ];
}

function lintLines(state) {
  const sk = skillStatus(state);
  if (state.pane) return state.pane;
  const lines = lintReport(sk.path, sk.errors).map((text, i) => ({ kind: sk.errors.length ? (i ? 'err' : 'fail') : 'ok', text }));
  if (!sk.errors.length && !sk.located) lines.push({ kind: 'warn', text: `note: ${state.skill.location}/ is not a skills directory, so the agent will not look there` });
  return lines;
}

function layersPane(state, d) {
  for (const [id, row] of d.chunkRows) {
    for (const [layer, btn] of row) btn.setAttribute('aria-pressed', String(state.layers[id] === layer));
  }
  const sk = skillStatus(state);
  d.assembled.textContent = sk.text;
  d.files.replaceChildren(
    ...[['SKILL.md', `frontmatter ${sk.fmTokens} tokens, body ${sk.bodyTokens} tokens`], ...Object.entries(sk.bundled).map(([path, tokens]) => [path, `${tokens} tokens, only if a request needs it`])].map(([path, info]) =>
      el('div', { class: 'sk-file', role: 'listitem' }, el('code', { text: path }), el('span', { class: 'sk-muted', text: info })),
    ),
  );
}

function filePane(state, d) {
  const sk = skillStatus(state);
  d.path.textContent = sk.path;
  d.dirty.textContent = d.draft.value === state.skill.text ? 'Saved' : 'Unsaved changes (Save to apply them)';
  d.files.replaceChildren(
    ...[['SKILL.md', sk.description ? `frontmatter ${sk.fmTokens} tokens, body ${sk.bodyTokens} tokens` : 'frontmatter could not be read'], ...Object.entries(sk.bundled).map(([path, tokens]) => [path, `${tokens} tokens, only if the body points at it`])].map(([path, info]) =>
      el('div', { class: 'sk-file', role: 'listitem' }, el('code', { text: path }), el('span', { class: 'sk-muted', text: info })),
    ),
  );
  if (d.dir) {
    if (document.activeElement !== d.dir) d.dir.value = state.skill.dir;
    d.loc.value = state.skill.location;
  }
}

function render(state, ctx) {
  const d = state.dom;
  contextPane(state, d);
  d.queue.replaceChildren(...requestPane(state));
  d.agent.replaceChildren(...agentPane(state));
  d.shelf.replaceChildren(...shelfPane(state));
  if (state.mode === 'layers') layersPane(state, d);
  else filePane(state, d);
  const lines = lintLines(state);
  d.term.replaceChildren(...lines.map((l) => el('span', { class: `sk-line sk-line-${l.kind}`, text: `${l.text}\n` })));
  const over = ctx.over;
  for (const control of d.controls) control.disabled = over;
  if (d.draft) d.draft.disabled = over;
}

// ---------------------------------------------------------------- workbenches

function buildLayers(state, ctx, d) {
  d.chunkRows = new Map();
  const rows = state.chunks.map((c) => {
    const buttons = new Map();
    const group = el('div', { class: 'sk-layers', role: 'group', 'aria-label': `Where "${c.label}" lives` });
    for (const layer of LAYERS) {
      const b = el('button', { class: 'sk-btn', type: 'button', 'aria-pressed': 'false', text: LAYER_LABEL[layer] });
      b.addEventListener('click', () => ctx.act('place', c.id, layer));
      buttons.set(layer, b);
      group.append(b);
      d.controls.push(b);
    }
    d.chunkRows.set(c.id, buttons);
    return el(
      'div',
      { class: 'sk-chunk', role: 'listitem' },
      el('strong', { class: 'sk-name', text: c.label }),
      el('span', { class: 'sk-tok', text: `${c.tokens} tokens` }),
      el('span', { class: 'sk-use', text: c.use }),
      group,
    );
  });
  d.assembled = el('pre', { class: 'sk-code', tabindex: 0, 'aria-label': 'SKILL.md as it stands' });
  d.files = el('div', { class: 'sk-files', role: 'list', 'aria-label': 'Files in the skill folder' });
  return el(
    'section',
    { class: 'sk-panel sk-bench' },
    el('h4', { class: 'sk-h', text: 'Pieces of the skill: pick a layer for each' }),
    el('p', { class: 'sk-muted', text: 'Frontmatter is loaded for every request. The body loads when the skill is chosen. A bundled file loads only when a request needs it (the body gets a one-line pointer).' }),
    el('div', { class: 'sk-chunks', role: 'list', 'aria-label': 'Pieces of the release-notes skill' }, ...rows),
    el('h4', { class: 'sk-h', text: 'The skill as it stands' }),
    d.assembled,
    d.files,
  );
}

function buildFile(state, ctx, sc, d) {
  d.path = el('code', { class: 'sk-path' });
  d.dirty = el('span', { class: 'sk-muted', role: 'status' });
  d.draft = el('textarea', { class: 'sk-editor', rows: 16, spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'SKILL.md contents' });
  d.draft.value = state.skill.text;
  d.draft.addEventListener('input', () => {
    d.dirty.textContent = d.draft.value === state.skill.text ? 'Saved' : 'Unsaved changes (Save to apply them)';
  });
  const save = el('button', { class: 'sk-btn sk-btn-primary', type: 'button', text: 'Save' });
  const check = el('button', { class: 'sk-btn', type: 'button', text: 'Check (free)' });
  save.addEventListener('click', () => {
    if (!ctx.act('save', d.draft.value)) d.dirty.textContent = 'Nothing to save: the file is unchanged.';
  });
  check.addEventListener('click', () => {
    const errors = checkSkill(d.draft.value, state.skill.dir);
    const lines = lintReport(`${state.skill.dir}/SKILL.md (unsaved draft)`, errors).map((text, i) => ({ kind: errors.length ? (i ? 'err' : 'fail') : 'ok', text }));
    for (const h of hintsFor(d.draft.value)) lines.push({ kind: 'warn', text: `hint: ${h}` });
    state.pane = lines;
    render(state, ctx); // a free check does not go through the engine, so redraw by hand
  });
  d.controls.push(save, check);
  d.files = el('div', { class: 'sk-files', role: 'list', 'aria-label': 'Files in the skill folder' });

  const layout = [];
  if (sc.layout) {
    d.dir = el('input', { class: 'sk-input', type: 'text', 'aria-label': 'Folder name', autocomplete: 'off', spellcheck: 'false' });
    d.dir.value = state.skill.dir;
    const setDir = el('button', { class: 'sk-btn', type: 'button', text: 'Rename folder' });
    const rename = () => ctx.act('setDir', d.dir.value);
    setDir.addEventListener('click', rename);
    d.dir.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        rename();
      }
    });
    d.loc = el('select', { class: 'sk-input', 'aria-label': 'Where the skill folder lives' }, ...LOCATIONS.map((l) => el('option', { value: l, text: `${l}/` })));
    d.loc.addEventListener('change', () => {
      if (!ctx.act('setLocation', d.loc.value)) d.loc.value = state.skill.location;
    });
    d.controls.push(d.dir, setDir, d.loc);
    layout.push(
      el(
        'div',
        { class: 'sk-layout' },
        el('label', { class: 'sk-field' }, el('span', { class: 'sk-label', text: 'Folder name' }), d.dir),
        setDir,
        el('label', { class: 'sk-field' }, el('span', { class: 'sk-label', text: 'Lives in' }), d.loc),
      ),
    );
  }
  return el(
    'section',
    { class: 'sk-panel sk-bench' },
    el('h4', { class: 'sk-h', text: 'SKILL.md' }),
    el('p', { class: 'sk-pathline' }, 'Path: ', d.path),
    ...layout,
    d.draft,
    el('div', { class: 'sk-editor-bar' }, save, check, d.dirty),
    d.files,
  );
}

// ---------------------------------------------------------------- the game

registerGame({
  id: 'skills',
  styles: 'game.css',

  init(state, ctx) {
    const sc = ctx.scenario;
    Object.assign(state, createWorld(sc));
    state.pane = null;
    const d = { controls: [] };

    d.bar = el('div', { class: 'sk-bar', role: 'img' });
    d.legend = el('div', { class: 'sk-legend' });
    d.total = el('p', { class: 'sk-total', role: 'status' });
    d.queue = el('div', { class: 'sk-queue', role: 'list', 'aria-label': 'Request queue' });
    d.agent = el('div', { class: 'sk-agent', 'aria-live': 'polite' });
    d.shelf = el('div', { class: 'sk-shelf', role: 'list', 'aria-label': 'Skills on the shelf' });
    d.term = el('pre', { class: 'sk-term', tabindex: 0, role: 'log', 'aria-label': 'check_skill.py output' });

    const bench = state.mode === 'layers' ? buildLayers(state, ctx, d) : buildFile(state, ctx, sc, d);
    const gate = el('section', { class: 'sk-panel' }, el('h4', { class: 'sk-h', text: 'Lint gate: python scripts/check_skill.py' }), d.term);

    const root = el(
      'div',
      { class: 'sk' },
      el('section', { class: 'sk-panel sk-ctx' }, el('h4', { class: 'sk-h', text: 'Context window' }), d.bar, d.legend, d.total),
      el(
        'div',
        { class: 'sk-cols' },
        el('div', { class: 'sk-col' }, bench, gate),
        el(
          'div',
          { class: 'sk-col' },
          el('section', { class: 'sk-panel' }, el('h4', { class: 'sk-h', text: 'Request queue' }), d.queue),
          el('section', { class: 'sk-panel' }, el('h4', { class: 'sk-h', text: 'Agent reasoning' }), d.agent),
          el('section', { class: 'sk-panel' }, el('h4', { class: 'sk-h', text: 'Skills on the shelf' }), d.shelf),
        ),
      ),
    );
    state.dom = d;
    ctx.ui.board.append(root);
    ctx.log(
      state.mode === 'layers'
        ? 'Choose a layer for each piece, then send the requests one at a time (g). Every request must fit the window.'
        : 'Edit SKILL.md and Save. The queue shows what the agent would do right now; Send (g) serves the next request.',
    );
  },

  // How a move reads in the debrief and in the efficient path.
  describeMove(name, args) {
    if (name === 'place') return `Move ${args[0]} to ${args[1]}`;
    if (name === 'save') return 'Save SKILL.md';
    if (name === 'setDir') return `Name the folder ${args[0]}`;
    if (name === 'setLocation') return `Put it in ${args[0]}`;
    return undefined;
  },

  tick: (state, ctx) => simTick(state, ctx),

  actions: {
    send: {
      label: 'Send next request',
      key: 'g',
      run(state, ctx) {
        ctx.step();
        return 'free';
      },
    },
    place: {
      hidden: true,
      run(state, ctx, id, layer) {
        state.pane = null;
        return simPlace(state, id, layer);
      },
    },
    save: {
      hidden: true,
      run(state, ctx, text) {
        const saved = simSaveText(state, text);
        if (saved) state.pane = null;
        return saved;
      },
    },
    setDir: {
      hidden: true,
      run(state, ctx, name) {
        state.pane = null;
        return simSetDir(state, name);
      },
    },
    setLocation: {
      hidden: true,
      run(state, ctx, location) {
        state.pane = null;
        return simSetLocation(state, location);
      },
    },
  },

  isWon: (state) => simIsWon(state),
  isLost: (state) => simIsLost(state),
  render,
});
