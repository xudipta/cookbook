// "Night Shift": a pager goes off and you fix a simulated Linux server with real shell commands. The rules
// live in sim.js (DOM-free), the machine in os.js and the shell in shell.js; this file is the pager, the status
// strip, the terminal and the registerGame wiring. Turn-based: reading is free, a command that changes
// something costs a move and a minute.
import { registerGame } from '../shared/engine.js';
import { learnUrl } from '../shared/learn.js';
import { createPrompt } from '../shared/prompt.js';
import { el } from '../shared/ui.js';
import { complete, createWorld, isLost as simIsLost, isWon as simIsWon, nextWords, run, start, status, tick as simTick } from './sim.js';

const SITE_ROOT = new URL('../../../', import.meta.url);

// Commands worth one click: the free "look" commands of the troubleshooting order.
const UNIT_STATE = {
  active: ['●', 'running'],
  activating: ['▲', 'restarting'],
  failed: ['✕', 'failed'],
  inactive: ['○', 'stopped'],
};

// ---------------------------------------------------------------- panes

function clock(w) {
  const d = new Date(w.nowMs);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function pagerItems(w) {
  const pages = w.pager;
  if (!pages.length) return [el('p', { class: 'lx-empty', role: 'listitem', text: 'No pages yet.' })];
  return [...pages].reverse().map((p) =>
    el(
      'div',
      { class: 'lx-page', role: 'listitem', 'data-state': p.state },
      el('span', { class: 'lx-page-state', text: p.state === 'open' ? '▲ Paging' : '✓ Cleared' }),
      el('span', { class: 'lx-page-text', text: p.text }),
    ),
  );
}

function statusItems(w) {
  const s = status(w);
  const fact = (label, value, level) =>
    el('div', { class: 'lx-fact', role: 'listitem', 'data-level': level || undefined }, el('span', { class: 'lx-fact-label', text: label }), el('strong', { text: value }));
  const disk = s.diskPct >= 100 ? 'bad' : s.diskPct >= 90 ? 'warn' : 'ok';
  const load = s.load >= w.cores * 2 ? 'bad' : s.load >= w.cores ? 'warn' : 'ok';
  const items = [fact('Clock', clock(w)), fact('Disk /', `${s.diskPct}%${s.diskPct >= 100 ? ' full' : ''}`, disk), fact('Load', s.load.toFixed(1), load)];
  for (const u of s.units) {
    const [glyph, word] = UNIT_STATE[u.active] || ['?', u.active];
    items.push(fact(u.name, `${glyph} ${word}`, u.active === 'active' ? 'ok' : 'bad'));
  }
  return items;
}

function termNode(line) {
  const span = el('span', { class: `lx-line lx-line-${line.kind}` });
  span.append(line.text);
  if (line.link) {
    span.append(' ', el('a', { class: 'lx-link', href: learnUrl(line.link, SITE_ROOT), text: `Read: ${line.link.section}` }));
  }
  span.append('\n');
  return span;
}

// ---------------------------------------------------------------- render

function render(state, ctx) {
  const d = state.dom;
  d.pager.replaceChildren(...pagerItems(state));
  d.status.replaceChildren(...statusItems(state));
  d.cmd.ps1.textContent = state.prompt();
  // The terminal only appends: redraw it fully when the buffer was cleared or trimmed.
  if (state.term.length < state.drawn || state.term.length > 500) {
    d.term.replaceChildren();
    state.drawn = 0;
  }
  if (!state.term.length) {
    if (!d.term.firstChild) d.term.append(el('span', { class: 'lx-line lx-line-out', text: 'Type a command below. Try: cat ~/README\n' }));
  } else {
    if (!state.drawn) d.term.replaceChildren();
    const fresh = state.term.slice(state.drawn);
    if (fresh.length) {
      d.term.append(...fresh.map(termNode));
      state.drawn = state.term.length;
      d.term.scrollTop = d.term.scrollHeight;
    }
  }
  const over = ctx.over;
  d.cmd.setDisabled(over);
}

// ---------------------------------------------------------------- the game

registerGame({
  id: 'linux',
  styles: 'game.css',

  init(state, ctx) {
    createWorld(ctx.scenario, state);
    state.drawn = 0;

    const pager = el('div', { class: 'lx-list', role: 'list', 'aria-label': 'Pager messages', tabindex: 0 });
    const statusList = el('div', { class: 'lx-facts', role: 'list', 'aria-label': 'Server status' });
    const term = el('pre', { class: 'lx-term', tabindex: 0, role: 'log', 'aria-label': 'Terminal output' });
    const cmd = createPrompt({
      ps1: state.prompt(),
      label: 'Terminal command',
      placeholder: 'ls -l /opt',
      enterkeyhint: 'send',
      cls: { form: 'lx-prompt', ps1: 'lx-ps1', input: 'lx-input', run: 'lx-btn', chips: 'lx-quicks', chip: 'lx-btn lx-quick' },
      next: (words, line) => nextWords(state, words, line),
      onSubmit: (line) => {
        const text = line.trim();
        if (text) ctx.act('sh', text);
      },
      // Tab completes. When there is nothing to complete it falls through, so the keyboard is never trapped.
      onKeydown: (e, input) => {
        if (e.key !== 'Tab' || e.shiftKey || !input.value.trim()) return false;
        const { line, options } = complete(state, input.value);
        if (line === input.value && !options.length) return false;
        e.preventDefault();
        input.value = line;
        if (options.length) {
          state.term.push({ kind: 'cmd', text: `${state.prompt()} ${input.value}` }, { kind: 'out', text: options.map((o) => o.replace(/.*\/(?=.)/, '')).join('  ') });
          render(state, ctx);
        }
        return true;
      },
    });

    const root = el(
      'div',
      { class: 'lx' },
      el(
        'div',
        { class: 'lx-top' },
        el('section', { class: 'lx-panel' }, el('h4', { class: 'lx-h', text: 'Pager' }), pager),
        el('section', { class: 'lx-panel' }, el('h4', { class: 'lx-h', text: 'Server' }), statusList),
      ),
      el('section', { class: 'lx-panel' }, el('h4', { class: 'lx-h', text: 'Terminal' }), term, cmd.form, cmd.tray),
    );
    state.dom = { root, pager, status: statusList, term, cmd };
    ctx.ui.board.append(root);
    ctx.log('Reading is free: ls, cat, grep, ps, df, systemctl status. A command that changes something costs a move and a minute, and every open incident costs service health.');
    start(state, ctx);
    render(state, ctx);
  },

  tick: (state, ctx) => simTick(state, ctx),

  actions: {
    wait: {
      label: 'Wait a minute',
      key: 'w',
      run(state, ctx) {
        ctx.step();
        return 'free';
      },
    },
    sh: {
      hidden: true,
      run(state, ctx, line) {
        const result = run(state, ctx, line);
        if (result === true) ctx.step(); // a command that changed the machine: one minute passes
        return result === true ? true : result;
      },
    },
  },

  isWon: (state) => simIsWon(state),
  isLost: (state) => simIsLost(state),
  render,
});
