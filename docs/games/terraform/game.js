// "Drift Detective": keep config, state and the real world in agreement using a terraform prompt.
// The simulation is in sim.js (DOM-free); this file is the three panes, the terminal and the
// registerGame wiring. The game is turn-based: the day only advances when you press Next day.
import { registerGame } from '../shared/engine.js';
import { el } from '../shared/ui.js';
import {
  afterMove,
  createWorld,
  describeValue,
  editTargets,
  isLost as simIsLost,
  isWon as simIsWon,
  runCommand,
  setAttr as simSetAttr,
  setVar as simSetVar,
  tick as simTick,
} from './sim.js';

const QUICK = ['terraform init', 'terraform plan', 'terraform apply', 'yes', 'terraform state list', 'terraform workspace list'];

// ---------------------------------------------------------------- panes

function configText(w) {
  const lines = [];
  if (w.config.backend) lines.push('terraform {', '  backend "s3" {', '    bucket = "acme-tfstate"', '  }', '}', '');
  for (const [name, value] of Object.entries(w.config.vars)) lines.push(`variable "${name}" {`, `  default = ${JSON.stringify(value)}`, '}', '');
  for (const [addr, res] of Object.entries(w.config.resources)) {
    const [type, name] = addr.split('.');
    lines.push(`resource "${type}" "${name}" {`);
    const width = Math.max(...Object.keys(res.attrs).map((k) => k.length));
    for (const [k, v] of Object.entries(res.attrs)) lines.push(`  ${k.padEnd(width)} = ${describeValue(v)}`);
    lines.push('}', '');
  }
  return lines.join('\n').trimEnd();
}

function attrLines(attrs) {
  return Object.entries(attrs).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
}

function statePane(w) {
  const entries = Object.entries(w.envs[w.workspace].state);
  if (!entries.length) return [el('p', { class: 'tf-empty', role: 'listitem', text: 'Empty. Terraform manages nothing in this workspace yet.' })];
  return entries.map(([addr, s]) =>
    el('div', { class: 'tf-item', role: 'listitem' }, el('strong', { class: 'tf-name', text: addr }), el('span', { class: 'tf-id', text: `id ${s.id}` }), el('pre', { class: 'tf-attrs', text: attrLines(s.attrs).join('\n') })),
  );
}

function realPane(w) {
  const env = w.envs[w.workspace];
  const managed = new Set(Object.values(env.state).map((s) => s.id));
  const items = Object.entries(env.real);
  if (!items.length) return [el('p', { class: 'tf-empty', role: 'listitem', text: 'Nothing exists in this workspace yet.' })];
  return items.map(([id, r]) =>
    el(
      'div',
      { class: 'tf-item', role: 'listitem' },
      el('strong', { class: 'tf-name', text: `${r.type} ${id}` }),
      managed.has(id) ? null : el('span', { class: 'tf-tag', text: 'not in state' }),
      el('pre', { class: 'tf-attrs', text: attrLines(r.attrs).join('\n') }),
    ),
  );
}

function statusStrip(w) {
  const lock = w.lock ? `held by ${w.lock.who} (${w.lock.op})` : 'none';
  const store = w.config.backend ? (w.stateStore === 'remote' ? 'remote (s3)' : 'local file, backend block not applied') : 'local file';
  const item = (label, value, cls = '') => el('span', { class: `tf-fact ${cls}` }, el('span', { class: 'tf-fact-label', text: label }), el('strong', { text: value }));
  return [
    item('Workspace', w.workspace, 'tf-ws'),
    item('State', store),
    item('Lock', lock, w.lock ? 'tf-lock' : ''),
    item('CI', w.ci),
    item('Init', w.initialized ? 'done' : 'needed'),
  ];
}

// ---------------------------------------------------------------- config editor

function editorSignature(w) {
  return JSON.stringify(editTargets(w).map((t) => t.id));
}

function syncEditor(state) {
  const { select, input } = state.dom.editor;
  const sig = editorSignature(state);
  if (state.editorSig === sig) return;
  state.editorSig = sig;
  const targets = editTargets(state);
  const previous = select.value;
  select.replaceChildren(...targets.map((t) => el('option', { value: t.id, text: t.label })));
  select.value = targets.some((t) => t.id === previous) ? previous : targets[0]?.id;
  fillInput(state);
}

function fillInput(state) {
  const { select, input } = state.dom.editor;
  const target = editTargets(state).find((t) => t.id === select.value);
  input.value = target ? target.value : '';
}

function saveEdit(state, ctx) {
  const { select, input } = state.dom.editor;
  const id = select.value;
  if (id.startsWith('var.')) ctx.act('setVar', id.slice(4), input.value);
  else {
    const at = id.lastIndexOf('.');
    ctx.act('setAttr', id.slice(0, at), id.slice(at + 1), input.value);
  }
}

// ---------------------------------------------------------------- terminal

function termLines(w) {
  return w.term.map((l) => el('span', { class: `tf-line tf-line-${l.kind}`, text: `${l.text}\n` }));
}

function submit(state, ctx, line) {
  const text = line.trim();
  if (!text) return;
  if (state.history[state.history.length - 1] !== text) state.history.push(text);
  state.historyAt = state.history.length;
  ctx.act('terraform', text);
}

// ---------------------------------------------------------------- render

function render(state, ctx) {
  const d = state.dom;
  d.status.replaceChildren(...statusStrip(state));
  d.config.textContent = configText(state);
  d.state.replaceChildren(...statePane(state));
  d.real.replaceChildren(...realPane(state));
  d.stateHead.textContent = `State (${state.stateStore === 'remote' ? 'remote' : 'terraform.tfstate'})`;
  d.realHead.textContent = `Real infrastructure (workspace ${state.workspace})`;
  syncEditor(state);
  const atBottom = d.term.scrollHeight - d.term.scrollTop - d.term.clientHeight < 40;
  d.term.replaceChildren(...(state.term.length ? termLines(state) : [el('span', { class: 'tf-line tf-line-out', text: 'Type a command below, for example: terraform init\n' })]));
  if (atBottom || state.stickBottom) d.term.scrollTop = d.term.scrollHeight;
  state.stickBottom = false;
  const over = ctx.over;
  d.input.disabled = over;
  d.run.disabled = over;
  d.editor.save.disabled = over;
  d.editor.select.disabled = over;
  d.editor.input.disabled = over;
  for (const b of d.quick) b.disabled = over || (b.dataset.cmd === 'yes' && !state.pending);
  d.pendingNote.hidden = !state.pending;
}

// ---------------------------------------------------------------- the game

registerGame({
  id: 'terraform',
  styles: 'game.css',

  init(state, ctx) {
    Object.assign(state, createWorld(ctx.scenario));
    state.history = [];
    state.historyAt = 0;
    state.editorSig = null;
    state.stickBottom = true;

    const status = el('div', { class: 'tf-status', role: 'status', 'aria-label': 'Workspace, state, lock and CI' });
    const config = el('pre', { class: 'tf-code', tabindex: 0, 'aria-label': 'main.tf' });
    const stateList = el('div', { class: 'tf-list', role: 'list', 'aria-label': 'Resources in state' });
    const realList = el('div', { class: 'tf-list', role: 'list', 'aria-label': 'Real infrastructure' });
    const stateHead = el('h4', { class: 'tf-h' });
    const realHead = el('h4', { class: 'tf-h' });

    const select = el('select', { class: 'tf-select', 'aria-label': 'Config value to edit' });
    const editInput = el('input', { class: 'tf-input', type: 'text', 'aria-label': 'New value', autocomplete: 'off', spellcheck: 'false' });
    const save = el('button', { class: 'tf-btn', type: 'button', text: 'Save config' });
    select.addEventListener('change', () => fillInput(state));
    save.addEventListener('click', () => saveEdit(state, ctx));
    editInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveEdit(state, ctx);
      }
    });
    const editor = el('div', { class: 'tf-editor' }, el('span', { class: 'tf-fact-label', text: 'Edit main.tf' }), select, editInput, save);

    const term = el('pre', { class: 'tf-term', tabindex: 0, role: 'log', 'aria-label': 'Terminal output' });
    const input = el('input', { class: 'tf-input tf-cmd', type: 'text', 'aria-label': 'Terminal command', placeholder: 'terraform plan', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const run = el('button', { class: 'tf-btn', type: 'submit', text: 'Run' });
    const form = el('form', { class: 'tf-prompt' }, el('span', { class: 'tf-ps1', 'aria-hidden': 'true', text: '$' }), input, run);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const line = input.value;
      input.value = '';
      state.stickBottom = true;
      submit(state, ctx, line);
      input.focus();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && state.historyAt > 0) {
        e.preventDefault();
        state.historyAt -= 1;
        input.value = state.history[state.historyAt];
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.historyAt = Math.min(state.history.length, state.historyAt + 1);
        input.value = state.history[state.historyAt] || '';
      }
    });
    const quick = QUICK.map((cmd) => {
      const b = el('button', { class: 'tf-btn tf-quick', type: 'button', 'data-cmd': cmd, text: cmd.replace('terraform ', '') });
      b.addEventListener('click', () => {
        state.stickBottom = true;
        submit(state, ctx, cmd);
        input.focus();
      });
      return b;
    });
    const pendingNote = el('p', { class: 'tf-pending', text: 'An apply is waiting for you to type yes. Any other command cancels it.', hidden: true });

    const root = el(
      'div',
      { class: 'tf' },
      status,
      el(
        'div',
        { class: 'tf-cols' },
        el('section', { class: 'tf-panel' }, el('h4', { class: 'tf-h', text: 'Config (main.tf)' }), config, editor),
        el('section', { class: 'tf-panel' }, stateHead, stateList),
        el('section', { class: 'tf-panel' }, realHead, realList),
      ),
      el('section', { class: 'tf-panel' }, el('h4', { class: 'tf-h', text: 'Terminal' }), term, pendingNote, form, el('div', { class: 'tf-quicks' }, ...quick)),
    );
    state.dom = { root, status, config, state: stateList, real: realList, stateHead, realHead, term, input, run, quick, pendingNote, editor: { select, input: editInput, save } };
    ctx.ui.board.append(root);
    ctx.log('Run commands in the terminal. Reading a plan is free; every change costs a move. Next day (d) ends the day: anything still out of sync overnight costs trust.');
  },

  tick: (state, ctx) => simTick(state, ctx),

  actions: {
    nextDay: {
      label: 'Next day',
      key: 'd',
      run(state, ctx) {
        ctx.step();
        return 'free';
      },
    },
    terraform: {
      hidden: true,
      run(state, ctx, line) {
        const result = runCommand(state, ctx, line);
        afterMove(state, ctx);
        render(state, ctx); // the engine does not re-render after a read-only or failed command (false)
        return result;
      },
    },
    setVar: {
      hidden: true,
      run(state, ctx, name, value) {
        if (!simSetVar(state, name, value)) return false;
        afterMove(state, ctx);
        return true;
      },
    },
    setAttr: {
      hidden: true,
      run(state, ctx, addr, attr, value) {
        if (!simSetAttr(state, addr, attr, value)) return false;
        afterMove(state, ctx);
        return true;
      },
    },
  },

  isWon: (state) => simIsWon(state),
  isLost: (state) => simIsLost(state),
  render,
});
