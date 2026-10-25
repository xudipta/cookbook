// DOM for the shared game shell: HUD, board mount point, action buttons, event log and the
// end-of-game result panel. Everything is built with createElement/textContent (no innerHTML).
import { learnLink } from './learn.js';

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat()) if (kid) node.append(kid);
  return node;
}

export function createUI(container, { def, scenario, siteRoot, handlers }) {
  container.replaceChildren();
  container.classList.add('cg');
  container.tabIndex = 0;
  container.setAttribute('aria-label', `${scenario.title || def.id} game`);

  const tickEl = el('span', { class: 'cg-stat', 'data-stat': 'tick' });
  const scoreEl = el('span', { class: 'cg-stat', 'data-stat': 'score' });
  const statusEl = el('span', { class: 'cg-stat cg-status', 'data-stat': 'status', role: 'status' });
  const barFill = el('div', { class: 'cg-meter-fill' });
  const meter = el(
    'div',
    {
      class: 'cg-meter',
      role: 'progressbar',
      'aria-label': scenario.healthLabel || 'Health',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': 100,
    },
    barFill,
  );
  const meterValue = el('span', { class: 'cg-meter-value' });
  const pauseBtn = el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'pause', text: 'Pause' });
  const restartBtn = el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'restart', text: 'Restart' });
  pauseBtn.addEventListener('click', () => handlers.togglePause());
  restartBtn.addEventListener('click', () => handlers.restart());

  const hud = el(
    'div',
    { class: 'cg-hud' },
    el('div', { class: 'cg-meter-wrap' }, el('span', { class: 'cg-label', text: scenario.healthLabel || 'Health' }), meter, meterValue),
    tickEl,
    scoreEl,
    statusEl,
    el('div', { class: 'cg-controls' }, pauseBtn, restartBtn),
  );

  const actionsBar = el('div', { class: 'cg-actions', role: 'group', 'aria-label': 'Actions' });
  for (const [name, action] of Object.entries(def.actions)) {
    const label = (typeof action === 'object' && action.label) || name;
    const key = typeof action === 'object' ? action.key : undefined;
    const btn = el('button', { class: 'cg-btn cg-btn-action', type: 'button', 'data-action': name, title: key ? `Shortcut: ${key}` : undefined });
    btn.append(label);
    if (key) btn.append(el('kbd', { text: key }));
    btn.addEventListener('click', () => handlers.act(name));
    actionsBar.append(btn);
  }

  const board = el('div', { class: 'cg-board', role: 'region', 'aria-label': 'Game board' });
  const logList = el('ol', { class: 'cg-log cg-list', role: 'log', 'aria-live': 'polite', 'aria-label': 'Event log' });
  const resultSlot = el('div', { class: 'cg-result-slot' });

  container.append(
    hud,
    actionsBar,
    el('div', { class: 'cg-main' }, board, el('div', { class: 'cg-side' }, el('h3', { class: 'cg-h', text: 'Event log' }), logList)),
    resultSlot,
  );

  return {
    board,

    log(text, { kind = 'info' } = {}) {
      const li = el('li', { class: `cg-log-item cg-log-${kind}` });
      li.append(el('span', { class: 'cg-log-text', text }));
      logList.prepend(li);
      return li;
    },

    attachLearn(li, fix, learn) {
      if (fix) li.append(el('span', { class: 'cg-log-fix', text: fix }));
      if (learn) li.append(learnLink(learn, siteRoot));
    },

    setHud({ ticks, winTicks, health, score, status, paused }) {
      tickEl.textContent = winTicks ? `Tick ${ticks} / ${winTicks}` : `Tick ${ticks}`;
      scoreEl.textContent = `Score ${score}`;
      const pct = Math.max(0, Math.min(100, Math.round(health)));
      barFill.style.width = `${pct}%`;
      barFill.dataset.level = pct >= 70 ? 'ok' : pct >= 40 ? 'warn' : 'bad';
      meter.setAttribute('aria-valuenow', String(pct));
      meterValue.textContent = `${pct}%`;
      statusEl.textContent = status === 'playing' ? (paused ? 'Paused' : 'Playing') : status === 'won' ? 'You won' : 'You lost';
      statusEl.dataset.status = status;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.disabled = status !== 'playing';
      for (const btn of actionsBar.querySelectorAll('button')) btn.disabled = status !== 'playing' || paused;
    },

    clearLog() {
      logList.replaceChildren();
    },

    showResult({ status, score, best, ticks, actionsUsed, avgResolve, events }) {
      const won = status === 'won';
      const list = el('ul', { class: 'cg-result-events cg-list' });
      for (const e of events) {
        const item = el('li', {}, el('strong', { text: e.title }), el('span', { text: ` — ${e.fix}` }));
        if (e.learn) item.append(' ', learnLink(e.learn, siteRoot));
        list.append(item);
      }
      const again = el('button', { class: 'cg-btn cg-btn-primary', type: 'button', text: 'Play again' });
      again.addEventListener('click', () => handlers.restart());
      const facts = [`Score ${score}`, `Best ${best}`, `${ticks} ticks`, `${actionsUsed} actions`];
      if (avgResolve !== null) facts.push(`avg ${avgResolve.toFixed(1)} ticks to resolve an event`);
      resultSlot.replaceChildren(
        el(
          'section',
          { class: `cg-result cg-result-${status}`, 'aria-label': 'Result' },
          el('h3', { class: 'cg-h', text: won ? 'You kept it running' : 'It fell over' }),
          el('p', { class: 'cg-result-facts', text: facts.join(' · ') }),
          events.length ? el('p', { text: 'What happened, and where to read more:' }) : null,
          list,
          again,
        ),
      );
      again.focus({ preventScroll: true });
    },

    clearResult() {
      resultSlot.replaceChildren();
    },
  };
}
