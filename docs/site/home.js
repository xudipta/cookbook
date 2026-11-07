// Home page: the story board and the practice board (both built from docs/games/games.json), the
// topic cards' story and practice links, and the theme toggle.
import { bestScore, completedLevels, resetProgress, starsEarned, storyChaptersDone } from '../games/shared/progress.js';
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
  const done = completedLevels(game.id).length;
  const progress = el(
    'div',
    { class: 'tile-progress' },
    el('span', { class: 'pips', 'aria-hidden': 'true' }, Array.from({ length: game.levels }, (_, i) => el('i', { 'data-done': String(i < done) }))),
    el('span', { text: `${done} of ${game.levels} levels done` }),
    // Stars are par-based: three per level for finishing in the scripted solution's moves.
    done ? el('span', { class: 'tile-stars', 'aria-label': `${starsEarned(game.id)} of ${game.levels * 3} stars`, text: `★ ${starsEarned(game.id)}/${game.levels * 3}` }) : null,
  );
  return el(
    'a',
    { class: 'tile live', href: `docs/games/${game.id}/` },
    top,
    el('p', { text: game.blurb }),
    el('ul', { class: 'chips' }, game.chips.map((c) => el('li', { text: c }))),
    progress,
    el('div', { class: 'tile-foot' }, el('span', { text: game.facts.join(' · ') }), el('span', {}, 'Best ', el('b', { text: best || '—' }))),
  );
}

let games = [];


// The recommended order is data (games.json: "path", and each topic's "after"). With storage blocked every
// story reads as not started, so the page degrades to "start with the first story on the path".
let order = [];
const storyOf = (id) => games.find((g) => g.id === id);
const liveStory = (g) => g && g.story.status === 'live';
const chaptersDone = (g) => Math.min(storyChaptersDone(g.id), g.story.chapters);
const finished = (g) => chaptersDone(g) >= g.story.chapters;

// What to do next: the story you are part-way through, else the first unfinished story on the path.
function nextUp() {
  const stories = order.map(storyOf).filter(liveStory);
  const started = stories.find((g) => chaptersDone(g) > 0 && !finished(g));
  const fresh = stories.find((g) => chaptersDone(g) === 0);
  const anyDone = stories.some((g) => chaptersDone(g) > 0);
  const game = started || fresh;
  if (!game) return { kind: 'done', game: stories[0] };
  const step = order.indexOf(game.id) + 1;
  if (started) return { kind: 'continue', game, step, text: `Continue: ${game.story.title}`, note: `${game.short}, chapter ${chaptersDone(game) + 1} of ${game.story.chapters}` };
  if (anyDone) return { kind: 'next', game, step, text: `Next: ${game.story.title}`, note: `${game.short}, step ${step} of ${order.length} on the path` };
  return { kind: 'start', game, step, text: `Start with ${game.story.title}`, note: `${game.short}, step ${step} of ${order.length} on the path` };
}

// The hero's one obvious next action.
function renderContinue() {
  const button = document.getElementById('continue');
  const note = document.getElementById('continue-note');
  if (!button || !order.length) return;
  const next = nextUp();
  if (next.kind === 'done') {
    button.textContent = 'Practise with the real commands';
    button.setAttribute('href', '#board');
    if (note) note.textContent = 'You have finished every story.';
    return;
  }
  button.textContent = next.text;
  button.setAttribute('href', next.game.story.path);
  if (note) note.textContent = next.note;
}

// The path as a strip: every topic in the recommended order, finished ones ticked, the next one marked.
function renderPath() {
  const root = document.getElementById('path');
  if (!root || !order.length) return;
  const current = nextUp();
  root.replaceChildren(...order.map((id, i) => {
    const g = storyOf(id);
    const live = liveStory(g);
    const state = live && finished(g) ? 'done' : current.game && current.game.id === id && current.kind !== 'done' ? 'now' : 'todo';
    const label = `${g.short}${state === 'done' ? ', finished' : state === 'now' ? ', next' : ''}`;
    const inner = [el('span', { class: 'path-n', 'aria-hidden': 'true', text: state === 'done' ? '✓' : String(i + 1) }), el('span', { class: 'path-name', text: g.short })];
    return el('li', { class: 'path-step', 'data-state': state }, live ? el('a', { href: g.story.path, 'aria-label': label, 'aria-current': state === 'now' ? 'step' : false }, inner) : el('span', {}, inner));
  }));
}

// A story tile: the story is the front door to a topic. A planned story shows what it will be and where to follow it.
function storyTile(game) {
  const story = game.story;
  const mark = el('span', { class: 'mark', style: `--c: var(--h-${game.hue})`, 'aria-hidden': 'true', text: game.code });
  const names = el('div', { class: 'names' }, el('h3', { text: story.title }), el('div', { class: 'topic', text: `${game.topic} · ${story.metaphor}` }));
  if (story.status !== 'live') {
    return el(
      'article',
      { class: 'story-tile planned' },
      el('div', { class: 'tile-top' }, mark, names, el('span', { class: 'status', text: 'Coming' })),
      el('p', { text: `A story for ${game.topic} is planned.` }),
      el('div', { class: 'tile-foot' }, el('span', { text: 'Follow progress' }), el('a', { href: `${GITHUB_ISSUES}${story.issue}`, text: `Issue #${story.issue}` })),
    );
  }
  const done = Math.min(storyChaptersDone(game.id), story.chapters);
  const step = order.indexOf(game.id) + 1;
  const after = (game.after || []).map((id) => storyOf(id)?.short).filter(Boolean);
  const label = done === 0 ? 'Start the story' : done < story.chapters ? 'Continue the story' : 'Play it again';
  return el(
    'article',
    { class: 'story-tile live' },
    el('div', { class: 'tile-top' }, mark, names, el('span', { class: 'status', text: 'Playable' })),
    step ? el('p', { class: 'story-step', text: `Step ${step} of ${order.length}${after.length ? ` · best after ${after.join(' and ')}` : ''}` }) : null,
    el('p', { text: story.blurb }),
    el('ul', { class: 'chips' }, story.learns.map((c) => el('li', { text: c }))),
    el('div', { class: 'tile-progress' },
      el('span', { class: 'pips', 'aria-hidden': 'true' }, Array.from({ length: story.chapters }, (_, i) => el('i', { 'data-done': String(i < done) }))),
      el('span', { text: `${done} of ${story.chapters} chapters` })),
    el('a', { class: 'btn primary', href: story.path, text: label }),
  );
}

// Each topic card in the notes section ends with its story and its practice game.
function topicLinks(game) {
  const links = [];
  if (game.story.status === 'live') links.push(el('a', { class: 'topic-story', href: game.story.path, text: 'Start the story' }));
  else links.push(el('span', { class: 'topic-soon', text: 'Story: coming' }));
  if (game.status === 'live') links.push(el('a', { href: `docs/games/${game.id}/`, text: 'Practice game' }));
  return el('p', { class: 'topic-foot' }, links);
}

async function board() {
  const root = document.getElementById('tiles');
  const storyRoot = document.getElementById('story-tiles');
  try {
    const res = await fetch(new URL('../games/games.json', import.meta.url));
    if (!res.ok) throw new Error(`games.json: HTTP ${res.status}`);
    const manifest = await res.json();
    games = manifest.games;
    order = (manifest.path || []).filter((id) => storyOf(id));
    // Stories follow the path; anything not on it (and planned stories) comes after.
    const rank = (g) => (order.includes(g.id) ? order.indexOf(g.id) : order.length) + (g.story.status === 'live' ? 0 : 100);
    const ordered = [...games].sort((a, b) => rank(a) - rank(b));
    renderContinue();
    renderPath();
    storyRoot.replaceChildren(...ordered.map(storyTile));
    root.replaceChildren(...games.map(tile));
    document.querySelectorAll('.note-topic[data-topic]').forEach((card) => {
      const game = games.find((g) => g.id === card.dataset.topic);
      card.querySelector('.topic-foot')?.remove();
      if (game) card.append(topicLinks(game));
    });
    const live = games.filter((g) => g.status === 'live');
    const stories = games.filter((g) => g.story.status === 'live');
    const set = (name, value) => document.querySelectorAll(`[data-stat="${name}"]`).forEach((n) => (n.textContent = value));
    set('stories-live', stories.length);
    set('stories-planned', games.length - stories.length);
    const planned = document.getElementById('planned-fact');
    if (planned) planned.hidden = games.length - stories.length === 0;
    set('live', live.length);
    set('levels', live.reduce((sum, g) => sum + g.levels, 0));
    set('live-word', WORDS[live.length] || String(live.length));
  } catch (err) {
    const note = el('p', {}, 'The boards could not load. The stories and games are listed on the ', el('a', { href: 'docs/games/', text: 'Play page' }), '.');
    root.replaceChildren(note);
    storyRoot.replaceChildren(el('p', {}, 'The stories could not load. Start with ', el('a', { href: 'docs/stories/kubernetes/', text: 'the Kubernetes story' }), '.'));
    console.error(err);
  }
}

// "Reset saved progress" asks twice: the first click arms it, the second (within 5s) clears every game and story.
const resetBtn = document.getElementById('reset-progress');
let armed = null;
resetBtn.addEventListener('click', () => {
  if (!armed) {
    resetBtn.textContent = 'Click again to erase scores, completed levels and story progress';
    armed = setTimeout(() => {
      armed = null;
      resetBtn.textContent = 'Reset saved progress';
    }, 5000);
    return;
  }
  clearTimeout(armed);
  armed = null;
  resetProgress(games.map((g) => g.id));
  resetBtn.textContent = 'Progress erased';
  board();
});

initTheme(document.getElementById('theme'));
board();
