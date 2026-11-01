// Story mode shell. A topic is taught as a short story on a phone-sized stage: a stage on top (the
// topic's own picture), the story in a bottom sheet. Each chapter is a plain async script that awaits the
// player, so a new story is a topic stage plus chapter scripts and no change here.
//
//   import { mountStory } from '../shared/story.js';
//   export const start = (host) => mountStory(host, { id, title, characters, chapters, createStage, ... });
//
// A chapter is { title, hook, learn, play({ ui, sim }) }. `ui` is the script API:
//   say(who, text, button?)      a line of story and one button to go on
//   note(who, text)              a line of story with no button (the script moves on by itself)
//   choose(who, text, options)   large option buttons, resolves with the chosen value
//   pick(who, text, picker, hint) waits for the player to tap something on the stage (see below)
//   card({ maps, plain, cmd })   the "Now in real X" card: story word -> real word, one sentence, the command
//   watch(text)                  a status line while the stage runs; toast(text) a short hint; sleep(ms)
//   phase(name, quiet?)          marks what the player is doing (sets data-phase; quiet = no live announcements)
//   caption(text)                one line under the stage
// `text` may use **bold**. Nothing here needs a keyboard, and no story text is ever put in innerHTML.
//
// A stage is whatever createStage(app, ui) returns, and it must have reset() and stop(). `pick` expects a
// picker with `picking` (a callback slot) and `refresh()` so the stage can mark what is tappable.
//
// ?fast=1 shortens every wait (used by scripts/story_check.cjs).
import { readStory, recordChapter } from '../../games/shared/progress.js';

export const FAST = new URLSearchParams(location.search).has('fast');
export const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const ROOT = new URL('../../../', import.meta.url);
export const siteUrl = (path) => new URL(path, ROOT).href;
export const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 15) : ms));

export const h = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...kids.flat().filter((x) => x != null));
  return node;
};
// "plain **bold** plain" -> nodes, without ever using innerHTML on story text.
export const rich = (text) => text.split('**').map((part, i) => (i % 2 ? h('strong', { text: part }) : part));

/* ------------------------------------------------------------------------------------------ */
/* Stage components a topic can reuse                                                          */
/* ------------------------------------------------------------------------------------------ */

// A labelled - / + control. Returns { el, count, minus, plus, term }; the topic wires the clicks.
export function createStepper({ label, minusLabel, plusLabel, value = 3 }) {
  const count = h('b', { class: 'ks-stepbar-n', text: String(value) });
  const minus = h('button', { class: 'ks-step', type: 'button', 'aria-label': minusLabel, text: '−' });
  const plus = h('button', { class: 'ks-step', type: 'button', 'aria-label': plusLabel, text: '+' });
  const term = h('span', { class: 'ks-term', hidden: true });
  const el = h('div', { class: 'ks-stepbar', hidden: true }, h('span', { class: 'ks-stepbar-label', text: label }), h('span', { class: 'ks-stepper' }, minus, count, plus), term);
  return { el, count, minus, plus, term };
}

// A large on/off switch with a text label. The topic sets aria-checked and the text.
export function createSwitch({ text }) {
  return h('button', { class: 'ks-switch', type: 'button', role: 'switch', 'aria-checked': 'false', hidden: true },
    h('span', { class: 'ks-switch-track' }, h('span', { class: 'ks-switch-knob' })),
    h('span', { class: 'ks-switch-text', text }));
}

// A row of big numbers, for example [{ label: 'Served', cls: 'ks-hud-ok' }, { label: 'Lost', cls: 'ks-hud-bad' }].
export function createCounters(items) {
  const values = items.map(() => h('b', { text: '0' }));
  const el = h('div', { class: 'ks-hud', hidden: true }, items.map((it, i) => h('span', { class: it.cls }, `${it.label} `, values[i])));
  return { el, values };
}

// Sends a small marker from one element to another across the stage (skipped for fast runs and reduced
// motion), then calls done. The marker's look comes from the topic's CSS (.ks-flyer, .ks-flyer.bad).
export function flyTo(stage, from, to, { ms, bad = false, done }) {
  if (FAST || REDUCED || !to.animate || !to.isConnected) return done();
  const sr = stage.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const fly = h('span', { class: `ks-flyer${bad ? ' bad' : ''}`, 'aria-hidden': 'true' });
  fly.style.left = `${a.left + a.width / 2 - sr.left - 9}px`;
  fly.style.top = `${a.bottom - sr.top - 4}px`;
  stage.append(fly);
  const move = fly.animate([{ transform: 'translate(0,0)' }, { transform: `translate(${b.left + b.width / 2 - (a.left + a.width / 2)}px,${b.top + 18 - a.bottom}px)` }], { duration: ms, easing: 'ease-in' });
  move.onfinish = () => { fly.remove(); done(); };
}

/* ------------------------------------------------------------------------------------------ */
/* The app: header, stage, bottom sheet                                                        */
/* ------------------------------------------------------------------------------------------ */

function buildApp(config) {
  const dots = config.chapters.map((c, i) => h('li', {}, h('button', { class: 'ks-dot', type: 'button', 'aria-label': `Chapter ${i + 1}: ${c.title}`, 'data-chapter': i }, h('span', { text: String(i + 1) }))));
  const caption = h('p', { class: 'ks-caption' });
  const stage = h('div', { class: 'ks-stage', role: 'region', 'aria-label': config.stageLabel, tabindex: '0' }, caption);
  const sheet = h('section', { class: 'ks-sheet', 'aria-live': 'polite' });
  const toast = h('div', { class: 'ks-toast', role: 'status', hidden: true });
  const root = h('div', { class: 'ks', role: 'dialog', 'aria-modal': 'true', 'aria-label': config.title, 'data-story': config.id, 'data-phase': 'title' },
    h('div', { class: 'ks-top' },
      h('a', { class: 'ks-exit', href: config.exitHref, 'aria-label': config.exitLabel }, '‹'),
      h('div', { class: 'ks-title', text: config.title }),
      h('ol', { class: 'ks-dots', 'aria-label': 'Chapters' }, dots)),
    stage, toast, sheet);
  return { root, stage, caption, sheet, toast, dots: dots.map((d) => d.firstChild) };
}

function createUI(app, config) {
  const { chapters, characters } = config;
  const ui = { app, notebook: [], toastTimer: null, gen: 0 };
  // Resolves only if the story has not been restarted meanwhile.
  ui.sleep = (ms) => { const g = ui.gen; return new Promise((r) => setTimeout(() => g === ui.gen && r(), FAST ? Math.min(ms, 15) : ms)); };

  ui.phase = (name, quiet = false) => {
    app.root.dataset.phase = name;
    app.sheet.setAttribute('aria-live', quiet ? 'off' : 'polite');
  };
  ui.progress = (index, done) => {
    app.dots.forEach((d, i) => {
      d.classList.toggle('is-now', i === index);
      d.classList.toggle('is-done', Boolean(done[i]));
      d.toggleAttribute('aria-current', i === index);
    });
  };
  ui.caption = (text) => { app.caption.textContent = text || ''; };
  ui.toast = (text, ms = 3600) => {
    clearTimeout(ui.toastTimer);
    app.toast.replaceChildren(...rich(text));
    app.toast.hidden = false;
    ui.toastTimer = setTimeout(() => { app.toast.hidden = true; }, FAST ? 200 : ms);
  };
  const show = (tall, ...nodes) => {
    app.sheet.classList.toggle('is-tall', Boolean(tall));
    app.sheet.replaceChildren(...nodes);
    app.sheet.scrollTop = 0;
  };
  const speaker = (who) => {
    const p = characters[who];
    return h('div', { class: 'ks-who' }, h('span', { class: 'ks-avatar', style: `background:${p.color}`, 'aria-hidden': 'true', text: p.name[0] }), h('span', { class: 'ks-who-name', text: p.name }), h('span', { class: 'ks-who-role', text: p.role }));
  };
  const wait = (...buttons) => new Promise((resolve) => {
    const row = h('div', { class: 'ks-actions' });
    for (const b of buttons) {
      const btn = h('button', { class: `ks-btn ${b.alt ? 'alt' : ''}`.trim(), type: 'button', 'data-value': b.value ?? '', text: b.label });
      btn.addEventListener('click', () => resolve(b.value));
      row.append(btn);
    }
    app.sheet.append(row);
    (row.firstChild || app.sheet).focus?.({ preventScroll: true });
  });

  ui.say = async (who, text, button = 'Next') => {
    show(false, speaker(who), h('p', { class: 'ks-say' }, ...rich(text)));
    await wait({ label: button, value: true });
  };
  ui.note = (who, text) => show(false, speaker(who), h('p', { class: 'ks-say' }, ...rich(text)));
  ui.choose = async (who, text, options) => {
    show(false, speaker(who), h('p', { class: 'ks-say' }, ...rich(text)));
    return wait(...options.map((o) => ({ ...o, alt: true })));
  };
  ui.title = async (index) => {
    const c = chapters[index];
    ui.phase('title');
    show(true, h('p', { class: 'ks-kicker', text: `Chapter ${index + 1} of ${chapters.length}` }), h('h2', { class: 'ks-h', text: c.title }), h('p', { class: 'ks-say', text: c.hook }), h('p', { class: 'ks-learn' }, h('strong', { text: 'You will learn: ' }), c.learn));
    await wait({ label: index === 0 ? config.startLabel : config.nextChapterLabel, value: true });
    ui.phase('story');
  };
  // "Now in real X": the story word becomes the real word, with the real command.
  ui.card = async ({ maps, plain, cmd, note }) => {
    ui.notebook.push({ maps, plain, cmd, note });
    ui.phase('card');
    const rows = maps.map(([story, real]) => h('li', { class: 'ks-map' }, h('span', { class: 'ks-map-story', text: story }), h('span', { class: 'ks-map-arrow', 'aria-label': 'is called', text: '→' }), h('code', { class: 'ks-map-real', text: real })));
    show(true,
      h('p', { class: 'ks-kicker ks-kicker-real', text: config.cardKicker }),
      h('ul', { class: 'ks-maps' }, rows),
      h('p', { class: 'ks-say' }, ...rich(plain)),
      h('details', { class: 'ks-cmd' }, h('summary', { text: 'See the real command' }), h('pre', {}, h('code', { text: cmd }))));
    await wait({ label: 'Got it', value: true });
    ui.phase('story');
  };
  // Wait for the player to tap something on the stage: the picker gets `picking(item)` to call.
  ui.pick = (who, text, picker, hint) => new Promise((resolve) => {
    show(false, speaker(who), h('p', { class: 'ks-say' }, ...rich(text)), h('p', { class: 'ks-hint', text: hint }));
    ui.phase('pick');
    picker.picking = (item) => { picker.picking = null; picker.refresh(); ui.phase('story'); resolve(item); };
    picker.refresh();
  });
  ui.watch = (text) => show(false, h('p', { class: 'ks-say ks-watch' }, ...rich(text)));
  ui.end = (notebook) => {
    ui.phase('end');
    const rows = notebook.map((n) => h('li', { class: 'ks-end-item' },
      h('div', { class: 'ks-end-maps' }, n.maps.map(([k, r]) => h('span', { class: 'ks-end-map' }, k, ' → ', h('code', { text: r })))),
      h('p', { class: 'ks-end-plain' }, ...rich(n.plain))));
    show(true,
      h('p', { class: 'ks-kicker', text: config.endKicker }),
      h('h2', { class: 'ks-h', text: config.endTitle }),
      h('p', { class: 'ks-say', text: config.endIntro }),
      h('ul', { class: 'ks-end-list' }, rows),
      h('div', { class: 'ks-links' }, config.endLinks.map((l) => h('a', { class: 'ks-link', href: l.href, text: l.text }))),
      h('div', { class: 'ks-actions' }, h('button', { class: 'ks-btn alt', type: 'button', 'data-action': 'replay', text: 'Play the story again' })));
  };
  return ui;
}

/* ------------------------------------------------------------------------------------------ */
/* Mount                                                                                       */
/* ------------------------------------------------------------------------------------------ */

// config: { id, title, stageLabel, exitHref, exitLabel, characters, chapters, createStage(app, ui),
//           startLabel, nextChapterLabel, cardKicker, endKicker, endTitle, endIntro, endLinks }
export function mountStory(host, config) {
  const app = buildApp(config);
  const ui = createUI(app, config);
  const sim = config.createStage(app, ui);
  // Mounted on <body>, outside Material's typography, so no site styles leak into the stage.
  document.querySelectorAll('body > .ks').forEach((n) => n.remove());
  document.body.append(app.root);
  document.documentElement.classList.add('ks-on');
  if (window.document$) {
    window.document$.subscribe(() => {
      if (document.querySelector('#story[data-story]')) return;
      app.root.remove();
      document.documentElement.classList.remove('ks-on');
    });
  }

  const finished = readStory(config.id);
  let run = 0;
  async function play(from = 0) {
    const mine = ++run;
    ui.gen = mine;
    ui.notebook.length = 0;
    for (let i = from; i < config.chapters.length; i++) {
      if (mine !== run) return;
      ui.progress(i, config.chapters.map((_, n) => n < i || finished[n]));
      sim.stop();
      sim.reset();
      await ui.title(i);
      if (mine !== run) return;
      await config.chapters[i].play({ ui, sim });
      if (mine !== run) return;
      finished[i] = true;
      recordChapter(config.id, i);
    }
    if (mine !== run) return;
    sim.stop();
    ui.progress(-1, config.chapters.map(() => true));
    ui.end(ui.notebook);
  }
  app.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-action="replay"]')) play(0); });
  app.dots.forEach((d) => d.addEventListener('click', () => play(Number(d.dataset.chapter))));
  window.cookbookStory = { play };
  play(0);
}
