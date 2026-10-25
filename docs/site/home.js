// Home page: the board (built from docs/games/games.json), the hero teaser game and the theme toggle.
import { initTheme } from './theme.js';

const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid) node.append(kid);
  return node;
};

const GITHUB_ISSUES = 'https://github.com/xudipta/cookbook/issues/';
const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function bestScore(id) {
  try {
    return Number(localStorage.getItem(`cookbook-game-best:${id}`)) || 0;
  } catch {
    return 0;
  }
}

function tile(game) {
  const live = game.status === 'live';
  const top = el(
    'div',
    { class: 'tile-top' },
    el('span', { class: 'mark', style: `--c: var(--h-${game.hue})`, 'aria-hidden': 'true', text: game.code }),
    el('div', { class: 'names' }, el('h3', { text: game.title }), el('div', { class: 'topic', text: game.topic })),
    el('span', { class: 'status', text: live ? 'Playable' : 'Queued' }),
  );
  if (!live) {
    return el(
      'div',
      { class: 'tile queued' },
      top,
      el('p', { text: 'A game for this topic is planned.' }),
      el('div', { class: 'tile-foot' }, el('span', { text: 'Follow progress' }), el('a', { href: `${GITHUB_ISSUES}${game.issue}`, text: `Issue #${game.issue}` })),
    );
  }
  const best = bestScore(game.id);
  return el(
    'a',
    { class: 'tile live', href: `docs/games/${game.id}/` },
    top,
    el('p', { text: game.blurb }),
    el('ul', { class: 'chips' }, game.chips.map((c) => el('li', { text: c }))),
    el('div', { class: 'tile-foot' }, el('span', { text: game.facts.join(' · ') }), el('span', {}, 'Best ', el('b', { text: best || '—' }))),
  );
}

async function board() {
  const root = document.getElementById('tiles');
  try {
    const res = await fetch(new URL('../games/games.json', import.meta.url));
    if (!res.ok) throw new Error(`games.json: HTTP ${res.status}`);
    const { games } = await res.json();
    root.replaceChildren(...games.map(tile));
    const live = games.filter((g) => g.status === 'live');
    const set = (name, value) => document.querySelectorAll(`[data-stat="${name}"]`).forEach((n) => (n.textContent = value));
    set('live', live.length);
    set('levels', live.reduce((sum, g) => sum + g.levels, 0));
    set('live-word', WORDS[live.length] || String(live.length));
  } catch (err) {
    root.replaceChildren(el('p', {}, 'The board could not load. The games are listed on the ', el('a', { href: 'docs/games/', text: 'Play page' }), '.'));
    console.error(err);
  }
}

// ---------------------------------------------------------------- hero teaser: delete crashed pods before the deployment drops out

const N = 6;
const podsEl = document.getElementById('pods');
const term = document.getElementById('term');
const availEl = document.getElementById('avail');
const availText = document.getElementById('avail-text');
const scoreEl = document.getElementById('score');
let pods;
let lines;
let secs;
let over;
let crashTimer;
let clockTimer;

const healthy = () => pods.filter((p) => p.s === 'ok').length;

function say(text, dim) {
  lines.push({ text, dim });
  if (lines.length > 5) lines.shift();
  term.replaceChildren(...lines.map((l) => el('span', {}, l.dim ? el('span', { class: 'dim', text: l.dim }) : null, l.text, '\n')));
}

function score() {
  scoreEl.textContent = over ? `Outage after ${secs}s. Reset to try again.` : `Tap a crashed pod to delete it. Survived ${secs}s`;
}

function draw() {
  podsEl.replaceChildren(
    ...pods.map((p, i) => {
      const state = p.s === 'ok' ? 'Running' : p.s === 'crash' ? 'CrashLoop' : 'Pending';
      const b = el(
        'button',
        { class: 'pod', type: 'button', 'data-s': p.s, 'aria-label': `web-${i}: ${p.s === 'crash' ? 'CrashLoopBackOff, activate to delete' : state}` },
        el('span', { class: 'name', text: `web-${i}` }),
        el('span', { class: 'state', text: state }),
        p.s === 'crash' ? el('span', { class: 'hint', text: 'delete me' }) : null,
      );
      b.disabled = p.s !== 'crash' || over;
      b.addEventListener('click', () => remove(i));
      return b;
    }),
  );
  const pct = Math.round((healthy() / N) * 100);
  availEl.style.width = `${pct}%`;
  availEl.dataset.level = pct >= 70 ? 'ok' : pct >= 40 ? 'warn' : 'bad';
  availText.textContent = `${pct}%`;
  score();
}

function remove(i) {
  if (over || pods[i].s !== 'crash') return;
  pods[i].s = 'pending';
  say(`kubectl delete pod web-${i}`, '$ ');
  say(`pod "web-${i}" deleted`);
  draw();
  setTimeout(() => {
    if (!over && pods[i].s === 'pending') {
      pods[i].s = 'ok';
      say(`web-${i} Running`);
      draw();
    }
  }, 900);
}

function crashOne() {
  const ok = pods.flatMap((p, i) => (p.s === 'ok' ? [i] : []));
  if (!ok.length) return;
  const i = ok[Math.floor(Math.random() * ok.length)];
  pods[i].s = 'crash';
  say(`web-${i} Back-off restarting failed container`);
  if (healthy() <= 2) {
    over = true;
    say(`Only ${healthy()} of ${N} replicas left. The service is down.`);
  }
  draw();
}

function start() {
  clearInterval(crashTimer);
  clearInterval(clockTimer);
  pods = Array.from({ length: N }, () => ({ s: 'ok' }));
  pods[3].s = 'crash';
  lines = [];
  secs = 0;
  over = false;
  say('kubectl get pods', '$ ');
  say('web-3 CrashLoopBackOff, 5 of 6 Running');
  draw();
  crashTimer = setInterval(() => !over && crashOne(), 2200);
  clockTimer = setInterval(() => {
    if (!over) {
      secs += 1;
      score();
    }
  }, 1000);
}

initTheme(document.getElementById('theme'));
document.getElementById('reset').addEventListener('click', start);
start();
board();
