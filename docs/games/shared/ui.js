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

export function createUI(container, { def, scenario, levels, siteRoot, handlers, meta }) {
  container.replaceChildren();
  container.classList.add('cg');
  container.tabIndex = 0;
  container.setAttribute('aria-label', `${scenario.title || def.id} game`);

  // The topic strip: which topic this game belongs to, and the way back to its notes.
  const head = meta
    ? el(
        'div',
        { class: 'cg-head' },
        el('span', { class: 'cg-mark', style: `--c: var(--h-${meta.hue})`, 'aria-hidden': 'true', text: meta.code }),
        el('span', { class: 'cg-topic', text: meta.topic }),
        el('a', { class: 'cg-notes', href: new URL(meta.notes, siteRoot).href, text: 'Read the notes' }),
      )
    : null;

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

  if (scenario.manual) pauseBtn.hidden = true; // nothing runs on a clock, so there is nothing to pause
  const hud = el(
    'div',
    { class: 'cg-hud' },
    el('div', { class: 'cg-meter-wrap' }, el('span', { class: 'cg-label', text: scenario.healthLabel || 'Health' }), meter, meterValue),
    tickEl,
    scoreEl,
    statusEl,
    el('div', { class: 'cg-controls' }, pauseBtn, restartBtn),
  );

  // Level picker (only when scenarios.json defines `levels`).
  const levelBar = levels ? el('div', { class: 'cg-levels', role: 'group', 'aria-label': 'Level' }) : null;
  const blurb = el('p', { class: 'cg-blurb' });
  // On a phone the level goal folds away so the board stays near the top of the screen.
  const goalToggle = el('button', { class: 'cg-goal-toggle', type: 'button', 'aria-expanded': 'true' });
  const blurbBox = el('div', { class: 'cg-goal' }, goalToggle, blurb);
  const showGoal = (open) => {
    blurb.hidden = !open;
    goalToggle.setAttribute('aria-expanded', String(open));
    goalToggle.textContent = `${open ? '▾' : '▸'} Level goal`;
  };
  goalToggle.addEventListener('click', () => showGoal(blurb.hidden));
  const levelButtons = new Map();
  for (const lvl of levels || []) {
    const btn = el('button', { class: 'cg-btn cg-btn-level', type: 'button', 'data-level': lvl.id, text: lvl.title });
    btn.addEventListener('click', () => handlers.setLevel(lvl.id));
    levelButtons.set(lvl.id, btn);
    levelBar.append(btn);
  }

  const actionsBar = el('div', { class: 'cg-actions', role: 'group', 'aria-label': 'Actions' });
  for (const [name, action] of Object.entries(def.actions)) {
    // `hidden: true` actions have no button (a game drives them from its own UI, e.g. a prompt).
    if (typeof action === 'object' && action.hidden) continue;
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
    ...[
      head,
      levelBar,
      blurbBox,
      hud,
      actionsBar,
      el('div', { class: `cg-main${scenario.stacked ? ' cg-main-stacked' : ''}` }, board, el('div', { class: 'cg-side' }, el('h3', { class: 'cg-h', text: 'Event log' }), logList)),
      resultSlot,
    ].filter(Boolean),
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

    setHud({ ticks, winTicks, tickLabel = 'Tick', health, score, status, paused }) {
      tickEl.textContent = winTicks ? `${tickLabel} ${ticks} / ${winTicks}` : `${tickLabel} ${ticks}`;
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

    setLevel(level) {
      for (const [id, btn] of levelButtons) btn.setAttribute('aria-pressed', String(Boolean(level) && id === level.id));
      blurb.textContent = (level && level.blurb) || '';
      blurbBox.hidden = !blurb.textContent;
      showGoal(matchMedia('(min-width: 700px)').matches);
    },

    clearLog() {
      logList.replaceChildren();
    },

    showResult({ status, score, best, ticks, actionsUsed, avgResolve, events, nextLevel }) {
      const won = status === 'won';
      const list = el('ul', { class: 'cg-result-events cg-list' });
      for (const e of events) {
        const item = el('li', {}, el('strong', { text: e.title }), el('span', { text: ` — ${e.fix}` }));
        if (e.learn) item.append(' ', learnLink(e.learn, siteRoot));
        list.append(item);
      }
      const next =
        won && nextLevel ? el('button', { class: 'cg-btn cg-btn-primary', type: 'button', 'data-cg': 'next', text: `Next level: ${nextLevel.title}` }) : null;
      if (next) next.addEventListener('click', () => handlers.setLevel(nextLevel.id));
      const again = el('button', { class: `cg-btn${next ? '' : ' cg-btn-primary'}`, type: 'button', 'data-cg': 'again', text: 'Play again' });
      again.addEventListener('click', () => handlers.restart());
      const notes = meta ? el('a', { class: 'cg-btn', 'data-cg': 'notes', href: new URL(meta.notes, siteRoot).href, text: 'Read the notes' }) : null;
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
          el('div', { class: 'cg-result-actions' }, next, again, notes),
        ),
      );
      (next || again).focus({ preventScroll: true });
    },

    clearResult() {
      resultSlot.replaceChildren();
    },
  };
}
