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

const HINT_LABELS = ['Where to look', 'What is wrong', 'What to do'];
const REPO_TREE = 'https://github.com/xudipta/cookbook/tree/main/';
const MAX_TIMELINE = 40;
const starText = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);

// Copy a block of commands. Clipboard access can be blocked (an insecure page, a locked-down browser): then the text is
// selected instead, so the player can copy it with the keyboard or a long press.
async function copyBlock(text, node) {
  try {
    await navigator.clipboard.writeText(text);
    return 'Copied';
  } catch {
    // fall through to selecting
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    if (document.execCommand('copy')) return 'Copied';
  } catch {
    // fall through
  }
  return 'Selected: copy it with your keyboard, or press and hold';
}

// What the player did next to the efficient path, the lessons, and the real commands.
function debriefView({ timeline, timed, tickLabel, path, lessons, tryIt, lossRule }) {
  const wide = matchMedia('(min-width: 700px)').matches;
  const section = (title, open, ...kids) => {
    const d = el('details', { class: 'cg-debrief-part' }, el('summary', { text: title }), ...kids);
    d.open = open;
    return d;
  };
  const parts = [];

  if (lossRule) parts.push(el('p', { class: 'cg-rule-broken' }, el('strong', { text: 'Rule broken: ' }), lossRule));
  if (lessons.length) {
    parts.push(el('div', { class: 'cg-lessons' }, el('h4', { class: 'cg-h', text: lessons.length === 1 ? 'The lesson' : 'The lessons' }), el('ul', { class: 'cg-list' }, lessons.map((l) => el('li', { text: l })))));
  }

  // The player's run: incidents and moves in order, repeated moves folded into one line.
  const rows = [];
  for (const item of timeline) {
    const last = rows[rows.length - 1];
    if (last && item.kind === last.kind && last.text === item.text) last.count += 1;
    else rows.push({ ...item, count: 1 });
  }
  const shown = rows.slice(0, MAX_TIMELINE);
  const when = (item) => (timed ? `${tickLabel} ${item.at}` : '');
  const timelineItems = shown.map((item) =>
    el(
      'li',
      { class: `cg-tl cg-tl-${item.kind}` },
      el('span', { class: 'cg-tl-when', text: when(item) }),
      item.kind === 'event'
        ? el('span', { class: 'cg-tl-text' }, el('strong', { text: 'Incident: ' }), item.text, item.count > 1 ? ` ×${item.count}` : '', item.fixedAt === null ? ' (still open)' : item.fixedAt === undefined ? '' : ` (fixed at ${tickLabel.toLowerCase()} ${item.fixedAt})`)
        : el('span', { class: 'cg-tl-text' }, el('code', { text: item.text }), item.count > 1 ? ` ×${item.count}` : item.counted ? '' : ' (free)'),
    ),
  );
  if (rows.length > shown.length) timelineItems.push(el('li', { class: 'cg-tl', text: `…and ${rows.length - shown.length} more` }));
  parts.push(section('What you did, and what happened', wide, el('ol', { class: 'cg-timeline cg-list' }, timelineItems)));

  if (path.length) {
    parts.push(
      section(`The efficient path (${path.length} move${path.length === 1 ? '' : 's'})`, false, el('ol', { class: 'cg-path cg-list' }, path.map((step) => el('li', {}, el('code', { text: step }))))),
    );
  }

  if (tryIt) {
    const code = el('code', { text: tryIt.commands });
    const block = el('pre', { class: 'cg-commands', tabindex: 0, 'aria-label': 'Commands to try for real' }, code);
    const note = el('span', { class: 'cg-copy-note', role: 'status', 'aria-live': 'polite' });
    const copy = el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'copy', text: 'Copy commands' });
    copy.addEventListener('click', async () => {
      note.textContent = await copyBlock(tryIt.commands, block);
    });
    parts.push(
      section(
        'Try it for real',
        false,
        el('p', { class: 'cg-needs', text: `Needs: ${tryIt.needs}` }),
        block,
        el('div', { class: 'cg-copy-row' }, copy, note),
        el('p', {}, el('a', { href: `${REPO_TREE}${tryIt.example}`, 'data-cg': 'example', text: 'The runnable example in the repo' })),
      ),
    );
  }
  return el('div', { class: 'cg-debrief' }, ...parts);
}

// "★★☆  Par 4 moves, you used 5. Three stars need 4 moves, two need 6." The text carries the meaning; the stars decorate it.
function starLine(stars, par, used) {
  const move = (n) => `${n} move${n === 1 ? '' : 's'}`;
  return el(
    'p',
    { class: 'cg-stars-line' },
    el('span', { class: 'cg-stars', 'aria-hidden': 'true', text: starText(stars) }),
    el('span', { class: 'cg-stars-text', text: `${stars} of 3 stars. Par is ${move(par)} and you used ${used}. Three stars need ${move(par)} or fewer, two need ${move(Math.ceil(par * 1.5))}.` }),
  );
}
const COACH_KEY = 'cookbook-game-coach';

// Storage can be blocked (private windows, site data off): the guided start then just shows each visit.
function coachSeen(id) {
  try {
    return Boolean(JSON.parse(localStorage.getItem(COACH_KEY) || '{}')[id]);
  } catch {
    return false;
  }
}
function rememberCoach(id) {
  try {
    const seen = JSON.parse(localStorage.getItem(COACH_KEY) || '{}');
    seen[id] = true;
    localStorage.setItem(COACH_KEY, JSON.stringify(seen));
  } catch {
    // Nothing to do: the guide shows again next time.
  }
}

export function createUI(container, { def, scenario, levels, siteRoot, handlers, meta, hintCost }) {
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
  const movesEl = el('span', { class: 'cg-stat', 'data-stat': 'moves' });
  const bestEl = el('span', { class: 'cg-stat', 'data-stat': 'best' });
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
  const hintBtn = el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'hint', title: 'Shortcut: ?' });
  pauseBtn.addEventListener('click', () => handlers.togglePause());
  restartBtn.addEventListener('click', () => handlers.restart());
  hintBtn.addEventListener('click', () => handlers.hint());

  if (scenario.manual) pauseBtn.hidden = true; // nothing runs on a clock, so there is nothing to pause
  const hud = el(
    'div',
    { class: 'cg-hud' },
    el('div', { class: 'cg-meter-wrap' }, el('span', { class: 'cg-label', text: scenario.healthLabel || 'Health' }), meter, meterValue),
    tickEl,
    movesEl,
    scoreEl,
    bestEl,
    statusEl,
    el('div', { class: 'cg-controls' }, pauseBtn, restartBtn, hintBtn),
  );

  // Level picker (only when scenarios.json defines `levels`).
  const levelBar = levels ? el('div', { class: 'cg-levels', role: 'group', 'aria-label': 'Level' }) : null;
  const blurb = el('p', { class: 'cg-blurb' });
  // On a phone the level goal folds away so the board stays near the top of the screen.
  const goalToggle = el('button', { class: 'cg-goal-toggle', type: 'button', 'aria-expanded': 'true' });
  const guideBtn = el('button', { class: 'cg-guide', type: 'button', 'data-cg': 'guide', text: 'Guide' });
  // Revealed hints stay on screen (the log folds away on a phone); each is announced as it appears.
  const hintList = el('ol', { class: 'cg-hints cg-list' });
  const hintBox = el('div', { class: 'cg-hints-box', hidden: true, role: 'status', 'aria-label': 'Hints' }, hintList);
  const blurbBox = el('div', { class: 'cg-goal' }, el('div', { class: 'cg-goal-row' }, goalToggle, guideBtn), blurb, hintBox);
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
  const actionButtons = new Map(); // name -> { setLabel, label }: a level may relabel an action (`actionLabels`)
  for (const [name, action] of Object.entries(def.actions)) {
    // `hidden: true` actions have no button (a game drives them from its own UI, e.g. a prompt).
    if (typeof action === 'object' && action.hidden) continue;
    const label = (typeof action === 'object' && action.label) || name;
    const key = typeof action === 'object' ? action.key : undefined;
    const btn = el('button', { class: 'cg-btn cg-btn-action', type: 'button', 'data-action': name, title: key ? `Shortcut: ${key}` : undefined });
    const setLabel = (text) => {
      btn.replaceChildren(text, ...(key ? [el('kbd', { text: key })] : []));
    };
    setLabel(label);
    actionButtons.set(name, { setLabel, label });
    btn.addEventListener('click', () => handlers.act(name));
    actionsBar.append(btn);
  }

  // On a phone the actions, a one-line status and the latest event are pinned to the bottom of the screen
  // (the "dock", see shell.css); on a wide screen the dock is invisible and the action bar sits where it always did.
  const dockFill = el('div', { class: 'cg-meter-fill' });
  const dockStatus = el('span', { class: 'cg-dock-status', 'aria-hidden': 'true' }); // the HUD above is the accessible version
  const latestText = el('span', { class: 'cg-latest-text', text: 'No events yet' });
  const latestToggle = el('span', { class: 'cg-latest-toggle', 'aria-hidden': 'true', text: 'Log ▾' });
  const latest = el('button', { class: 'cg-latest', type: 'button', 'aria-expanded': 'false' }, latestText, latestToggle);
  const dock = el(
    'div',
    { class: 'cg-dock', role: 'group', 'aria-label': 'Controls and status' },
    el('div', { class: 'cg-dock-meter', 'aria-hidden': 'true' }, dockFill),
    el('div', { class: 'cg-dock-row' }, actionsBar, dockStatus),
    latest,
  );

  const board = el('div', { class: 'cg-board', role: 'region', 'aria-label': 'Game board' });
  // role="log" on a wrapper (not on the list, which would hide its list items); the list itself is
  // focusable so a long log can be scrolled with the keyboard.
  const logList = el('ol', { class: 'cg-log cg-list', tabindex: 0, 'aria-label': 'Event log entries' });
  const logRegion = el('div', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Event log' }, logList);
  const resultSlot = el('div', { class: 'cg-result-slot' });

  const side = el('div', { class: 'cg-side' }, el('h3', { class: 'cg-h', text: 'Event log' }), logRegion);
  latest.addEventListener('click', () => {
    const open = side.dataset.open !== 'true';
    side.dataset.open = String(open);
    latest.setAttribute('aria-expanded', String(open));
    latestToggle.textContent = open ? 'Log ▴' : 'Log ▾';
    if (open) side.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // The guided start: a few inline steps that each light up one part of the page. It is data-driven
  // (`coach: { board, actions, firstMove }` in scenarios.json), skippable, remembered per game in
  // localStorage, and can be replayed with the Guide button.
  const coachData = scenario.coach || {};
  const coachSteps = [
    { target: board, title: 'The board', text: coachData.board || 'This is what you are keeping healthy. It changes as you act and as time passes.' },
    { target: actionsBar, title: 'Your moves', text: coachData.actions || 'Each button is a move. Most cost a few points, so look before you press.' },
    { target: latest, title: 'The log', text: 'Events land here with the fix and a link to the notes. On a phone, tap the latest line to open the whole log.' },
    { target: hintBtn, title: 'A good first move', text: `${coachData.firstMove || 'Read the level goal, then look at the board.'} Stuck? Hint reveals a clue and costs ${hintCost} points.` },
  ];
  const coachTitle = el('h3', { class: 'cg-coach-title' });
  const coachText = el('p', { class: 'cg-coach-text' });
  const coachCount = el('span', { class: 'cg-coach-count' });
  const coachNext = el('button', { class: 'cg-btn cg-btn-primary', type: 'button', 'data-cg': 'coach-next' });
  const coachSkip = el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'coach-skip', text: 'Skip guide' });
  const coach = el(
    'section',
    { class: 'cg-coach', hidden: true, 'aria-label': 'Guided start', 'aria-live': 'polite' },
    el('div', { class: 'cg-coach-head' }, coachTitle, coachCount),
    coachText,
    el('div', { class: 'cg-coach-actions' }, coachNext, coachSkip),
  );
  let coachAt = 0;
  const lit = () => container.querySelectorAll('.cg-coach-on');
  const coachStop = (remember) => {
    coach.hidden = true;
    for (const node of lit()) node.classList.remove('cg-coach-on');
    if (remember) rememberCoach(def.id);
  };
  const coachShow = (i) => {
    coachAt = i;
    const step = coachSteps[i];
    for (const node of lit()) node.classList.remove('cg-coach-on');
    step.target.classList.add('cg-coach-on');
    coachTitle.textContent = step.title;
    coachText.textContent = step.text;
    coachCount.textContent = `${i + 1} of ${coachSteps.length}`;
    coachNext.textContent = i === coachSteps.length - 1 ? 'Got it' : 'Next';
    coach.hidden = false;
    step.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  coachNext.addEventListener('click', () => (coachAt === coachSteps.length - 1 ? coachStop(true) : coachShow(coachAt + 1)));
  coachSkip.addEventListener('click', () => coachStop(true));
  guideBtn.addEventListener('click', () => coachShow(0));

  container.append(
    ...[
      head,
      levelBar,
      blurbBox,
      coach,
      hud,
      dock,
      el('div', { class: `cg-main${scenario.stacked ? ' cg-main-stacked' : ''}` }, board, side),
      resultSlot,
    ].filter(Boolean),
  );

  return {
    board,

    log(text, { kind = 'info' } = {}) {
      const li = el('li', { class: `cg-log-item cg-log-${kind}` });
      li.append(el('span', { class: 'cg-log-text', text }));
      logList.prepend(li);
      latestText.textContent = text;
      latest.dataset.kind = kind;
      return li;
    },

    attachLearn(li, fix, learn) {
      if (fix) li.append(el('span', { class: 'cg-log-fix', text: fix }));
      if (learn) li.append(learnLink(learn, siteRoot));
    },

    setHud({ ticks, winTicks, tickLabel = 'Tick', health, score, best = 0, status, paused, moves = 0, par }) {
      tickEl.textContent = winTicks ? `${tickLabel} ${ticks} / ${winTicks}` : `${tickLabel} ${ticks}`;
      scoreEl.textContent = `Score ${score}`;
      movesEl.textContent = par === undefined ? `Moves ${moves}` : `Moves ${moves} / par ${par}`;
      movesEl.dataset.over = String(par !== undefined && moves > par);
      bestEl.textContent = best ? `Best ${best}` : '';
      bestEl.hidden = !best;
      const pct = Math.max(0, Math.min(100, Math.round(health)));
      barFill.style.width = `${pct}%`;
      barFill.dataset.level = pct >= 70 ? 'ok' : pct >= 40 ? 'warn' : 'bad';
      meter.setAttribute('aria-valuenow', String(pct));
      meterValue.textContent = `${pct}%`;
      dockFill.style.width = `${pct}%`;
      dockFill.dataset.level = barFill.dataset.level;
      statusEl.textContent = status === 'playing' ? (paused ? 'Paused' : 'Playing') : status === 'won' ? 'You won' : 'You lost';
      dockStatus.textContent = `${pct}% · ${tickEl.textContent} · ${score}${status === 'playing' ? '' : ` · ${statusEl.textContent}`}`;
      statusEl.dataset.status = status;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.disabled = status !== 'playing';
      for (const btn of actionsBar.querySelectorAll('button')) btn.disabled = status !== 'playing' || paused;
    },

    setLevel(level) {
      for (const [id, btn] of levelButtons) btn.setAttribute('aria-pressed', String(Boolean(level) && id === level.id));
      for (const [name, a] of actionButtons) a.setLabel((level && level.actionLabels && level.actionLabels[name]) || a.label);
      blurb.textContent = (level && level.blurb) || '';
      goalToggle.hidden = !blurb.textContent; // the box stays: it also holds the Guide button and the hints
      showGoal(matchMedia('(min-width: 700px)').matches);
    },

    // Mark the levels already won in this browser, with their stars (text, not colour alone).
    setProgress(stars) {
      for (const [id, btn] of levelButtons) {
        const title = levels.find((l) => l.id === id).title;
        const n = stars[id] || 0;
        btn.dataset.done = String(n > 0);
        btn.dataset.stars = String(n);
        btn.textContent = n ? `${title} ${starText(n)}` : title;
        btn.setAttribute('aria-label', n ? `${title}, completed, ${n} of 3 stars` : title);
      }
    },

    // Hint button: how many rungs are left, and the cost, in the label and for screen readers.
    setHints({ used, total, playing }) {
      const left = total - used;
      hintBtn.hidden = total === 0;
      hintBtn.textContent = left > 0 ? `Hint −${hintCost}` : 'No more hints';
      hintBtn.setAttribute('aria-label', left > 0 ? `Hint, costs ${hintCost} points, ${left} of ${total} left` : 'No more hints');
      hintBtn.disabled = !playing || left <= 0;
    },

    showHint(text, n, total) {
      const label = total === HINT_LABELS.length ? HINT_LABELS[n - 1] : `Hint ${n}`;
      hintList.append(el('li', { class: 'cg-hint' }, el('strong', { text: `${label}: ` }), text));
      hintBox.hidden = false;
      showGoal(true);
      latestText.textContent = `Hint ${n} of ${total}: ${text}`;
    },

    clearHints() {
      hintList.replaceChildren();
      hintBox.hidden = true;
    },

    // Starts the guided start. `onlyIfNew` skips it for a player who has seen it on this browser.
    startCoach({ onlyIfNew = true } = {}) {
      if (!onlyIfNew || !coachSeen(def.id)) coachShow(0);
    },

    clearLog() {
      logList.replaceChildren();
      latestText.textContent = 'No events yet';
      delete latest.dataset.kind;
    },

    showResult({ status, score, best, ticks, actionsUsed, hintsUsed = 0, stars = 0, par, version, debrief, avgResolve, events, nextLevel }) {
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
      // A level with a seeded variant offers the next version (and the way back to the standard one).
      const other = version ? el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'version', text: 'Try a different version' }) : null;
      if (other) other.addEventListener('click', () => handlers.nextVersion());
      const standard = version && !version.standard ? el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'standard', text: 'Standard version' }) : null;
      if (standard) standard.addEventListener('click', () => handlers.standardVersion());
      // After a loss: start again with the first hint already open.
      const retry = !won ? el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'retry-hint', text: 'Retry with a hint' }) : null;
      if (retry) retry.addEventListener('click', () => handlers.retryWithHint());
      const notes = meta ? el('a', { class: 'cg-btn', 'data-cg': 'notes', href: new URL(meta.notes, siteRoot).href, text: 'Read the notes' }) : null;
      const facts = [`Score ${score}`, `Best ${best}`, `${ticks} ticks`, `${actionsUsed} actions`];
      if (version && !version.standard) facts.push(`version ${version.seed}`);
      if (hintsUsed) facts.push(`${hintsUsed} hint${hintsUsed === 1 ? '' : 's'} (−${hintsUsed * hintCost})`);
      if (avgResolve !== null) facts.push(`avg ${avgResolve.toFixed(1)} ticks to resolve an event`);
      resultSlot.replaceChildren(
        el(
          'section',
          { class: `cg-result cg-result-${status}`, 'aria-label': 'Result' },
          el('h3', { class: 'cg-h', text: won ? 'You kept it running' : 'It fell over' }),
          won && par !== undefined ? starLine(stars, par, actionsUsed) : null,
          el('p', { class: 'cg-result-facts', text: facts.join(' · ') }),
          events.length ? el('p', { text: 'What happened, and where to read more:' }) : null,
          list,
          debrief ? debriefView(debrief) : null,
          el('div', { class: 'cg-result-actions' }, next, again, retry, other, standard, notes),
        ),
      );
      (next || again).focus({ preventScroll: true });
    },

    clearResult() {
      resultSlot.replaceChildren();
    },
  };
}
