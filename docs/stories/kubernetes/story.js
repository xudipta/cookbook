// Story mode, Kubernetes: "Night Shift at Pizza Palace".
//
// A topic is taught as a short story on a phone-sized stage. Each chapter is one idea:
//   1. the metaphor first (a kitchen), 2. you do something and watch it happen,
//   3. only then the real Kubernetes word and command ("Now in real Kubernetes").
//
// The kitchen is a tiny simulation (createKitchen) and each chapter is a plain async script that
// awaits the player: say(), choose(), pick(), card(). Nothing here needs a keyboard.
//
// ?fast=1 shortens every wait (used by scripts/story_check.cjs).

const FAST = new URLSearchParams(location.search).has('fast');
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const ROOT = new URL('../../../', import.meta.url);
const HUB = new URL('docs/games/', ROOT).href;
const NOTE = (name) => new URL(`topics/kubernetes/notes/${name}/`, ROOT).href;

const h = (tag, attrs = {}, ...kids) => {
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
const rich = (text) => text.split('**').map((part, i) => (i % 2 ? h('strong', { text: part }) : part));

const WHO = {
  maya: { name: 'Maya', role: 'Owner', color: '#6d28d9' },
  sam: { name: 'You', role: 'On call', color: '#0f5f2d' },
};
const COOK_NAMES = ['Rosa', 'Tony', 'Ben', 'Lia', 'Omar', 'Ana', 'Kai', 'Zoe', 'Raj', 'Mia', 'Eli', 'Noor'];
const POD_IDS = ['k3x9', 'p2m7', 'z8q1', 'a5d4', 'm7t2', 'r4w8', 'c9j6', 'h1n5', 'x6v3', 'b2y7', 'f8d2', 'q4s9'];

const COOK_SVG = `<svg viewBox="0 0 64 72" aria-hidden="true" focusable="false">
  <ellipse cx="32" cy="68" rx="20" ry="3.5" fill="rgba(0,0,0,.14)"/>
  <rect class="ks-body" x="12" y="38" width="40" height="28" rx="12"/>
  <rect x="23" y="44" width="18" height="15" rx="5" fill="#fff" opacity=".92"/>
  <circle class="ks-face" cx="32" cy="27" r="13"/>
  <path d="M18 23c-5-3-4-13 4-14 3-7 17-7 20 0 8 1 9 11 4 14z" fill="#fff" stroke="#d9cbb8" stroke-width="1"/>
  <rect x="19" y="19" width="26" height="6" rx="3" fill="#fff" stroke="#d9cbb8" stroke-width="1"/>
  <circle cx="27" cy="29" r="1.8" fill="#2b1a0e"/><circle cx="37" cy="29" r="1.8" fill="#2b1a0e"/>
  <path class="ks-m ks-m-ok" d="M27 34q5 4.5 10 0" fill="none" stroke="#2b1a0e" stroke-width="1.8" stroke-linecap="round"/>
  <path class="ks-m ks-m-bad" d="M26.5 36q2.8-3.4 5.5 0t5.5 0" fill="none" stroke="#2b1a0e" stroke-width="1.8" stroke-linecap="round"/>
  <path class="ks-m ks-m-wait" d="M28 35.5h8" fill="none" stroke="#2b1a0e" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;

const STATE_LABEL = { ready: 'Ready', starting: 'Starting', sick: 'Sick', pending: 'Pending' };

/* ------------------------------------------------------------------------------------------ */
/* The stage: header, kitchen board, bottom sheet                                              */
/* ------------------------------------------------------------------------------------------ */

function buildApp(chapters) {
  const dots = chapters.map((c, i) => h('li', {}, h('button', { class: 'ks-dot', type: 'button', 'aria-label': `Chapter ${i + 1}: ${c.title}`, 'data-chapter': i }, h('span', { text: String(i + 1) }))));
  const rotaCount = h('b', { class: 'ks-rota-n', text: '3' });
  const rotaMinus = h('button', { class: 'ks-step', type: 'button', 'aria-label': 'Send one cook home', text: '−' });
  const rotaPlus = h('button', { class: 'ks-step', type: 'button', 'aria-label': 'Hire one more cook', text: '+' });
  const rotaTerm = h('span', { class: 'ks-term', hidden: true });
  const rota = h('div', { class: 'ks-rota', hidden: true }, h('span', { class: 'ks-rota-label', text: 'Cooks on the rota' }), h('span', { class: 'ks-stepper' }, rotaMinus, rotaCount, rotaPlus), rotaTerm);
  const probe = h('button', { class: 'ks-switch', type: 'button', role: 'switch', 'aria-checked': 'false', hidden: true }, h('span', { class: 'ks-switch-track' }, h('span', { class: 'ks-switch-knob' })), h('span', { class: 'ks-switch-text', text: 'Ready check: off' }));
  const pips = h('span', { class: 'ks-pips', 'aria-hidden': 'true' });
  const waiting = h('span', { class: 'ks-waiting', text: 'No orders waiting' });
  const pass = h('div', { class: 'ks-pass' }, h('span', { class: 'ks-pass-label', text: 'The pass' }), pips, waiting);
  const kitchen = h('div', { class: 'ks-kitchen', role: 'group', 'aria-label': 'The kitchen' });
  const outside = h('div', { class: 'ks-outside', hidden: true }, h('span', { class: 'ks-outside-label', text: 'Waiting outside: no free station' }));
  const served = h('b', { text: '0' });
  const lost = h('b', { text: '0' });
  const hud = h('div', { class: 'ks-hud', hidden: true },
    h('span', { class: 'ks-hud-ok' }, 'Served ', served),
    h('span', { class: 'ks-hud-bad' }, 'Lost ', lost));
  const caption = h('p', { class: 'ks-caption' });
  const stage = h('div', { class: 'ks-stage', role: 'region', 'aria-label': 'The kitchen', tabindex: '0' }, rota, probe, pass, kitchen, outside, hud, caption);
  const sheet = h('section', { class: 'ks-sheet', 'aria-live': 'polite' });
  const toast = h('div', { class: 'ks-toast', role: 'status', hidden: true });
  const root = h('div', { class: 'ks', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Night Shift at Pizza Palace', 'data-phase': 'title' },
    h('div', { class: 'ks-top' },
      h('a', { class: 'ks-exit', href: HUB, 'aria-label': 'Back to the games' }, '‹'),
      h('div', { class: 'ks-title', text: 'Night Shift at Pizza Palace' }),
      h('ol', { class: 'ks-dots', 'aria-label': 'Chapters' }, dots)),
    stage, toast, sheet);
  return { root, stage, caption, kitchen, outside, pass, pips, waiting, hud, served, lost, rota, rotaCount, rotaMinus, rotaPlus, rotaTerm, probe, sheet, toast, dots: dots.map((d) => d.firstChild) };
}

function createUI(app, chapters) {
  const ui = { app, notebook: [], toastTimer: null, gen: 0 };
  // Resolves only if the story has not been restarted meanwhile.
  ui.sleep = (ms) => { const g = ui.gen; return new Promise((r) => setTimeout(() => g === ui.gen && r(), FAST ? Math.min(ms, 15) : ms)); };

  ui.phase = (name) => {
    app.root.dataset.phase = name;
    app.sheet.setAttribute('aria-live', name === 'rush' ? 'off' : 'polite');
  };
  ui.progress = (index, doneUpTo) => {
    app.dots.forEach((d, i) => {
      d.classList.toggle('is-now', i === index);
      d.classList.toggle('is-done', i < doneUpTo);
      d.toggleAttribute('aria-current', i === index);
    });
  };
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
    const p = WHO[who];
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

  // A line of story with one button to go on.
  ui.say = async (who, text, button = 'Next') => {
    show(false, speaker(who), h('p', { class: 'ks-say' }, ...rich(text)));
    await wait({ label: button, value: true });
  };
  // A line of story with no button: the player watches (the story script moves on by itself).
  ui.note = (who, text) => show(false, speaker(who), h('p', { class: 'ks-say' }, ...rich(text)));
  ui.choose = async (who, text, options) => {
    show(false, speaker(who), h('p', { class: 'ks-say' }, ...rich(text)));
    return wait(...options.map((o) => ({ ...o, alt: true })));
  };
  ui.title = async (index) => {
    const c = chapters[index];
    ui.phase('title');
    show(true, h('p', { class: 'ks-kicker', text: `Chapter ${index + 1} of ${chapters.length}` }), h('h2', { class: 'ks-h', text: c.title }), h('p', { class: 'ks-say', text: c.hook }), h('p', { class: 'ks-learn' }, h('strong', { text: 'You will learn: ' }), c.learn));
    await wait({ label: index === 0 ? 'Start the shift' : 'Start the chapter', value: true });
    ui.phase('story');
  };
  // "Now in real Kubernetes": the kitchen word becomes the real word, with the real command.
  ui.card = async ({ maps, plain, cmd, note }) => {
    ui.notebook.push({ maps, plain, cmd, note });
    ui.phase('card');
    const rows = maps.map(([kitchen, real]) => h('li', { class: 'ks-map' }, h('span', { class: 'ks-map-kitchen', text: kitchen }), h('span', { class: 'ks-map-arrow', 'aria-label': 'is called', text: '→' }), h('code', { class: 'ks-map-real', text: real })));
    show(true,
      h('p', { class: 'ks-kicker ks-kicker-k8s', text: 'Now in real Kubernetes' }),
      h('ul', { class: 'ks-maps' }, rows),
      h('p', { class: 'ks-say' }, ...rich(plain)),
      h('details', { class: 'ks-cmd' }, h('summary', { text: 'See the real command' }), h('pre', {}, h('code', { text: cmd }))));
    await wait({ label: 'Got it', value: true });
    ui.phase('story');
  };
  // Wait for the player to tap one of the cooks.
  ui.pick = (who, text, kitchen) => new Promise((resolve) => {
    show(false, speaker(who), h('p', { class: 'ks-say' }, ...rich(text)), h('p', { class: 'ks-hint', text: 'Tap a cook above.' }));
    ui.phase('pick');
    kitchen.picking = (cook) => { kitchen.picking = null; kitchen.refresh(); ui.phase('story'); resolve(cook); };
    kitchen.refresh();
  });
  // Show a live status line while the simulation runs.
  ui.watch = (text) => show(false, h('p', { class: 'ks-say ks-watch' }, ...rich(text)));
  ui.end = (notebook) => {
    ui.phase('end');
    const rows = notebook.map((n) => h('li', { class: 'ks-end-item' },
      h('div', { class: 'ks-end-maps' }, n.maps.map(([k, r]) => h('span', { class: 'ks-end-map' }, k, ' → ', h('code', { text: r })))),
      h('p', { class: 'ks-end-plain' }, ...rich(n.plain))));
    show(true,
      h('p', { class: 'ks-kicker', text: 'Shift complete' }),
      h('h2', { class: 'ks-h', text: 'You just ran Kubernetes' }),
      h('p', { class: 'ks-say', text: 'Every kitchen word you used has a real name. Here is your notebook.' }),
      h('ul', { class: 'ks-end-list' }, rows),
      h('div', { class: 'ks-links' },
        h('a', { class: 'ks-link', href: NOTE('02-pods-and-workloads'), text: 'Read: Pods and workloads' }),
        h('a', { class: 'ks-link', href: NOTE('07-probes-and-resources'), text: 'Read: Probes and resources' }),
        h('a', { class: 'ks-link', href: new URL('kubernetes/', HUB).href, text: 'Play the real cluster game' })),
      h('div', { class: 'ks-actions' }, h('button', { class: 'ks-btn alt', type: 'button', 'data-action': 'replay', text: 'Play the story again' })));
  };
  return ui;
}

/* ------------------------------------------------------------------------------------------ */
/* The kitchen: a very small cluster                                                           */
/* ------------------------------------------------------------------------------------------ */

function createKitchen(app, ui) {
  const K = {
    cooks: [], stations: 4, desired: 3, rate: 0, warm: 2, probe: true, version: 'v1',
    queue: 0, served: 0, lost: 0, maxQueue: 6, tickMs: 800, ticks: 0, timer: null, picking: null,
    startLabel: 'Starting', rolloutTo: null, rolloutFrom: 0, serial: 0, sawPending: false,
  };
  let slots = [];

  const live = (c) => c.state !== 'gone';
  const accepting = (c) => c.state === 'ready' || (c.state === 'starting' && !K.probe);
  const readyCount = () => K.cooks.filter((c) => c.state === 'ready').length;

  function layout() {
    slots = Array.from({ length: K.stations }, () => h('div', { class: 'ks-slot' }));
    app.kitchen.replaceChildren(...slots);
    for (const c of K.cooks.filter(live)) place(c);
    paintOutside();
  }
  function place(c) {
    if (c.slot == null) return;
    slots[c.slot]?.replaceChildren(c.el);
  }
  const freeSlot = () => slots.findIndex((_, i) => !K.cooks.some((c) => live(c) && c.slot === i));

  function paint(c) {
    c.el.className = `ks-cook is-${c.state} ${c.ver}${K.picking && c.state !== 'pending' ? ' ks-pick' : ''}`;
    c.el.disabled = !(K.picking && c.state !== 'pending');
    c.chip.textContent = c.state === 'starting' ? K.startLabel : STATE_LABEL[c.state];
    c.el.setAttribute('aria-label', `${c.name}, pod ${c.pod}, ${c.chip.textContent}${K.picking ? '. Tap to send home' : ''}`);
  }
  function paintOutside() {
    const waiting = K.cooks.filter((c) => c.state === 'pending');
    app.outside.hidden = waiting.length === 0;
    app.outside.querySelectorAll('.ks-cook').forEach((n) => n.remove());
    for (const c of waiting) app.outside.append(c.el);
    if (waiting.length) K.sawPending = true;
  }
  function make(ver, state) {
    const n = K.serial++;
    const c = { name: COOK_NAMES[n % COOK_NAMES.length], pod: POD_IDS[n % POD_IDS.length], ver, state, warm: K.warm, slot: null };
    c.chip = h('span', { class: 'ks-chip' });
    c.el = h('button', { class: 'ks-cook', type: 'button' }, h('span', { class: 'ks-cook-art' }), h('span', { class: 'ks-cook-name', text: c.name }), h('code', { class: 'ks-cook-pod', text: `web-${c.pod}` }), c.chip);
    c.el.firstChild.innerHTML = COOK_SVG;
    c.el.addEventListener('click', () => K.picking && K.picking(c));
    return c;
  }
  function spawn(ver, state = 'starting') {
    const c = make(ver, state);
    K.cooks.push(c);
    const slot = freeSlot();
    if (slot === -1) c.state = 'pending';
    else { c.slot = slot; c.state = state === 'ready' ? 'ready' : 'starting'; place(c); }
    if (c.state === 'ready') c.warm = 0;
    paint(c);
    return c;
  }
  function remove(c, state = 'gone') {
    c.state = state;
    paint(c);
    if (state === 'gone') {
      c.el.classList.add('is-gone');
      setTimeout(() => { c.el.remove(); K.cooks = K.cooks.filter((x) => x !== c); }, FAST ? 10 : 500);
      c.slot = null;
    }
  }

  function flight(c, ok) {
    const flash = () => {
      c.el.classList.remove('flash-ok', 'flash-bad');
      void c.el.offsetWidth;
      c.el.classList.add(ok ? 'flash-ok' : 'flash-bad');
    };
    if (FAST || REDUCED || !c.el.animate || !c.el.isConnected) return flash();
    const sr = app.stage.getBoundingClientRect();
    const from = app.pass.getBoundingClientRect();
    const to = c.el.getBoundingClientRect();
    const t = h('span', { class: `ks-ticket${ok ? '' : ' bad'}`, 'aria-hidden': 'true' });
    t.style.left = `${from.left + from.width / 2 - sr.left - 9}px`;
    t.style.top = `${from.bottom - sr.top - 4}px`;
    app.stage.append(t);
    const a = t.animate([{ transform: 'translate(0,0)' }, { transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px,${to.top + 18 - from.bottom}px)` }], { duration: K.tickMs * 0.6, easing: 'ease-in' });
    a.onfinish = () => { t.remove(); flash(); };
  }

  function reconcile() {
    // Pending cooks move in as soon as a station is free.
    for (const c of K.cooks.filter((x) => x.state === 'pending')) {
      const slot = freeSlot();
      if (slot === -1) break;
      c.slot = slot; c.state = 'starting'; c.warm = K.warm; place(c); paint(c);
    }
    paintOutside();
    // The rota: keep the number of cooks at what was asked for.
    if (!K.rolloutTo) {
      const counted = K.cooks.filter((c) => ['ready', 'starting', 'pending'].includes(c.state));
      for (let n = counted.length; n < K.desired; n++) spawn(K.version);
      const extra = counted.length - K.desired;
      if (extra > 0) {
        const order = ['pending', 'starting', 'ready'];
        const victims = [...counted].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state)).slice(0, extra);
        victims.forEach((c) => remove(c));
      }
    }
    paintOutside();
    refreshRota();
  }

  // One new cook at a time; an old cook leaves once a new one counts as available.
  function rolloutStep() {
    const to = K.rolloutTo;
    const olds = K.cooks.filter((c) => c.ver !== to && c.state === 'ready');
    const news = K.cooks.filter((c) => c.ver === to && live(c));
    const available = news.filter(accepting).length;
    const removed = K.rolloutFrom - olds.length;
    if (available > removed && olds.length) { remove(olds[0]); return; }
    if (!olds.length && news.length >= K.desired && news.every((c) => c.state === 'ready')) { K.version = to; K.rolloutTo = null; return; }
    const warming = news.filter((c) => c.state === 'starting' && !accepting(c));
    if (!warming.length && news.length < K.desired && olds.length) spawn(to);
  }

  function tick() {
    if (!app.root.isConnected) return stop();
    K.ticks += 1;
    reconcile();
    if (K.rolloutTo) rolloutStep();
    K.queue += K.rate;
    const takers = K.cooks.filter(accepting);
    for (let i = 0; i < takers.length && K.queue > 0; i++) {
      const c = takers[(i + K.ticks) % takers.length];
      K.queue -= 1;
      if (c.state === 'starting') { K.lost += 1; flight(c, false); } else { K.served += 1; flight(c, true); }
    }
    if (K.queue > K.maxQueue) { K.lost += K.queue - K.maxQueue; K.queue = K.maxQueue; }
    for (const c of K.cooks.filter((x) => x.state === 'starting')) {
      c.warm -= 1;
      if (c.warm <= 0) { c.state = 'ready'; paint(c); }
    }
    for (const c of K.cooks) paint(c);
    paintHud();
    K.onTick && K.onTick(K);
  }
  function start() {
    if (K.timer) return;
    K.timer = setInterval(tick, FAST ? 40 : K.tickMs);
  }
  function stop() {
    clearInterval(K.timer);
    K.timer = null;
  }

  function paintHud() {
    app.served.textContent = String(K.served);
    app.lost.textContent = String(K.lost);
    app.hud.hidden = !(K.served || K.lost || K.rate);
    app.pips.replaceChildren(...Array.from({ length: Math.min(K.queue, 8) }, () => h('span', { class: 'ks-pip' })));
    app.waiting.textContent = K.queue ? `${K.queue} order${K.queue === 1 ? '' : 's'} waiting` : 'No orders waiting';
  }
  function refreshRota() {
    app.rotaCount.textContent = String(K.desired);
    app.rotaMinus.disabled = K.desired <= 1;
    app.rotaPlus.disabled = K.desired >= 8;
  }

  app.rotaPlus.addEventListener('click', () => { K.desired = Math.min(8, K.desired + 1); reconcile(); });
  app.rotaMinus.addEventListener('click', () => { K.desired = Math.max(1, K.desired - 1); reconcile(); });

  Object.assign(K, {
    refresh() { K.cooks.forEach(paint); },
    readyCount,
    // Set the kitchen up for a chapter.
    reset({ stations = 4, desired = 3, rate = 0, warm = 2, version = 'v1', probe = true, maxQueue = 6, tickMs = 800, startLabel = 'Starting' } = {}) {
      stop();
      K.cooks.forEach((c) => c.el.remove());
      Object.assign(K, { cooks: [], stations, desired, rate, warm, version, probe, maxQueue, tickMs, startLabel, queue: 0, served: 0, lost: 0, ticks: 0, rolloutTo: null, picking: null, sawPending: false });
      layout();
      for (let i = 0; i < desired; i++) spawn(version, 'ready');
      app.rota.hidden = true;
      app.caption.textContent = '';
      app.probe.hidden = true;
      app.hud.hidden = true;
      paintHud();
      refreshRota();
      K.setProbe(probe);
    },
    caption(text) { app.caption.textContent = text || ''; },
    showRota(on, term, stepper = true) {
      app.rota.hidden = !on;
      app.rota.classList.toggle('no-step', !stepper);
      app.rotaTerm.hidden = !term;
      app.rotaTerm.textContent = term || '';
    },
    showProbe(on, locked) {
      app.probe.hidden = !on;
      app.probe.disabled = Boolean(locked);
    },
    setProbe(on) {
      K.probe = on;
      app.probe.setAttribute('aria-checked', String(on));
      app.probe.querySelector('.ks-switch-text').textContent = `Ready check: ${on ? 'on' : 'off'}`;
    },
    setDesired(n) { K.desired = n; reconcile(); },
    start, stop,
    // Resolve once cond(K) is true, checking after every tick.
    until(cond, maxTicks = 80) {
      return new Promise((resolve) => {
        let n = 0;
        const check = () => {
          if (cond(K)) { K.onTick = null; resolve(true); } else if (++n > maxTicks) { K.onTick = null; resolve(false); }
        };
        K.onTick = check;
        check();
      });
    },
    sendHome(c) { remove(c, 'sick'); setTimeout(() => remove(c), FAST ? 30 : K.tickMs); },
    rollout(to) {
      K.rolloutTo = to;
      K.rolloutFrom = K.cooks.filter((c) => c.ver !== to && c.state === 'ready').length;
    },
    cooksNow() { return K.cooks.filter((c) => c.state === 'ready'); },
  });
  app.probe.addEventListener('click', () => { if (!app.probe.disabled) { K.setProbe(!K.probe); K.onProbe && K.onProbe(K.probe); } });
  return K;
}

/* ------------------------------------------------------------------------------------------ */
/* The story                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const CHAPTERS = [
  {
    title: 'The cook who went home',
    hook: 'It is your first night on call at Pizza Palace. The dinner rush starts in a minute.',
    learn: 'what a Pod is, and how Kubernetes heals itself.',
    async play({ ui, K }) {
      K.reset({ stations: 6, desired: 3, rate: 2, warm: 2, maxQueue: 2 });
      K.caption('Each box is a station. A cook is one running copy of the app.');
      await ui.say('maya', 'Hi, I am Maya. Think of our website as a **kitchen**. Each cook runs one copy of our app.');
      K.start();
      await ui.say('maya', 'Customers never pick a cook. **The pass** hands each order to a cook who is ready. Watch the tickets go out.');
      const sick = await ui.pick('maya', 'Oh no. A cook just felt dizzy. **Tap a cook** to send them home.', K);
      const left = sick.name;
      K.sendHome(sick);
      ui.watch(`${left} is on the way home. Only two cooks are left. Watch the kitchen.`);
      await K.until((k) => k.cooks.some((c) => c.state === 'starting' || c.state === 'ready') && k.readyCount() >= 3 && k.cooks.filter((c) => c.state !== 'gone').length === 3);
      await ui.say('maya', 'Wait. A new cook just started, and **nobody hired her**. The rota did it by itself.');
      await ui.card({
        maps: [['Cook', 'Pod'], ['The rota', 'Deployment']],
        plain: 'A **Pod** is one running copy of your app. A **Deployment** is the rota: you say "I want 3", and Kubernetes keeps it at 3, replacing any Pod that dies.',
        cmd: 'kubectl get deployment web          # READY 3/3\nkubectl delete pod web-k3x9         # send a cook home\nkubectl get pods -w                 # watch a new one start',
      });
      K.showRota(true, 'Deployment · replicas: 3', false);
      const bet = await ui.choose('maya', 'Test time. If we send **all three** cooks home at once, what happens?', [
        { label: 'The kitchen stays closed', value: 'closed' },
        { label: 'Kubernetes hires three new cooks', value: 'heals' },
        { label: 'Nothing, they refuse to leave', value: 'stay' },
      ]);
      K.cooksNow().forEach((c) => K.sendHome(c));
      const before = K.lost;
      ui.watch('Everyone is leaving. Watch the rota.');
      await K.until((k) => k.readyCount() >= 3 && k.cooks.filter((c) => c.state !== 'gone').length === 3);
      const dropped = K.lost - before;
      const cost = dropped > 0 ? ` But ${dropped} order${dropped === 1 ? ' was' : 's were'} lost while they started.` : ' Orders only waited a little while they started.';
      await ui.say('maya', `${bet === 'heals' ? 'Right!' : 'Not quite.'} The rota hired three new cooks.${cost}`);
      await ui.say('maya', 'That is why real apps keep **spare cooks**. If one leaves, the others cover. Next, the Friday rush.', 'Next chapter');
    },
  },
  {
    title: 'The Friday rush',
    hook: 'Seven o\'clock on a Friday. The phones are ringing and the orders are piling up.',
    learn: 'how to scale replicas, and what Pending means.',
    async play({ ui, K }) {
      K.reset({ stations: 5, desired: 3, rate: 0, warm: 2, tickMs: 1000, maxQueue: 8 });
      K.showRota(true, 'Deployment · replicas');
      K.caption('The kitchen has 5 stations. A cook with no station has to wait outside.');
      await ui.say('maya', 'Tonight we get **4 orders every tick**. A cook can finish **1 order per tick**.');
      await ui.say('maya', 'You run the rota now. Tap **+** to hire, **−** to send home. Do not let the orders pile up!', 'Start the rush');
      ui.phase('rush');
      for (let attempt = 1; ; attempt++) {
        K.queue = 0; K.served = 0; K.lost = 0; K.ticks = 0; K.rate = 4;
        K.start();
        let nagged = false;
        const total = 14;
        const done = K.until((k) => {
          const left = Math.max(0, total - k.ticks);
          ui.watch(`**The rush is on.** ${left} ticks to go. Cooks on the rota: **${k.desired}**.`);
          if (!nagged && k.ticks >= 3 && k.queue >= 3 && k.desired < 4) {
            nagged = true;
            ui.toast(attempt === 1 ? 'The line is growing. Tap + to hire a cook.' : '4 orders arrive each tick, and a cook does 1. How many cooks is that?');
          }
          return k.ticks >= total;
        }, total + 4);
        await done;
        K.rate = 0;
        if (K.lost === 0) break;
        ui.phase('story');
        await ui.say('maya', `We lost **${K.lost}** orders. Too few cooks for the rush. Let's try again.`, 'Try again');
        K.reset({ stations: 5, desired: 3, rate: 0, warm: 2, tickMs: 1000, maxQueue: 8 });
        K.caption('The kitchen has 5 stations. A cook with no station has to wait outside.');
        K.showRota(true, 'Deployment · replicas');
        ui.phase('rush');
      }
      ui.phase('story');
      K.stop();
      await ui.say('maya', `Not one order lost! You ran **${K.desired}** cooks for a 4-order rush.`);
      await ui.card({
        maps: [['Cooks on the rota', 'replicas'], ['Hire or send home', 'scale']],
        plain: 'To handle more traffic, you raise the number of **replicas**. Kubernetes starts the extra Pods for you.',
        cmd: 'kubectl scale deployment web --replicas=4\nkubectl get pods',
      });
      const go = await ui.choose('maya', 'Curious what happens if we hire **too many**? Our kitchen only has 5 stations.', [
        { label: 'Try 7 cooks', value: 'try' },
        { label: 'Skip', value: 'skip' },
      ]);
      if (go === 'try') {
        K.start();
        K.setDesired(7);
        ui.watch('Seven cooks, five stations. Look outside the kitchen.');
        await ui.sleep(2400);
        await ui.say('maya', 'Two cooks are stuck **outside**. There is no free station for them, so they wait.');
        await ui.card({
          maps: [['No free station', 'Pending'], ['Station', 'Node capacity']],
          plain: 'A Pod that fits on no machine stays **Pending**. Add more room (more Nodes) or ask for fewer Pods. The event says why.',
          cmd: 'kubectl get pods                 # STATUS: Pending\nkubectl describe pod web-p2m7    # Events: 0/1 nodes are available:\n                                 # insufficient cpu',
        });
        K.setDesired(4);
      }
    },
  },
  {
    title: 'The new menu',
    hook: 'Tonight we launch a new menu. New cooks in orange aprons will replace the old ones in blue.',
    learn: 'rolling updates, and why a ready check protects your customers.',
    async play({ ui, K }) {
      K.reset({ stations: 4, desired: 3, rate: 3, warm: 3, probe: false, startLabel: 'Learning the menu' });
      K.showProbe(true, true);
      K.caption('Blue aprons: old menu (v1). Orange aprons: new menu (v2). Swapping them one by one is a rolling update.');
      K.start();
      await ui.say('maya', 'We swap the cooks **one at a time**, so the kitchen never closes. A new cook needs **a few ticks** to learn the menu.');
      const bet = await ui.choose('maya', 'The pass can send orders to a new cook right away, or wait. What should it do?', [
        { label: 'Send orders right away', value: 'now' },
        { label: 'Wait until she says "ready"', value: 'wait' },
      ]);
      await ui.say('maya', 'Let us see what the pass does **by default**. Roll out the new menu.', 'Roll out');
      K.queue = 0; K.served = 0; K.lost = 0;
      K.rollout('v2');
      ui.watch('The new menu is rolling out. Watch the tickets turn red.');
      await K.until((k) => !k.rolloutTo && k.cooks.filter((c) => c.state !== 'gone').every((c) => c.ver === 'v2' && c.state === 'ready'), 120);
      const bad = K.lost;
      await ui.say('maya', `${bet === 'wait' ? 'Your instinct was right.' : 'Ouch.'} **${bad} orders** went to a cook who was still learning, and failed. By default the pass does not know who is ready.`);
      K.showProbe(true, false);
      ui.note('maya', 'Fix it: flip the **Ready check** switch above. The pass will wait until a cook says she is ready.');
      ui.phase('probe');
      await new Promise((resolve) => { K.onProbe = (on) => { if (on) { K.onProbe = null; resolve(); } }; });
      ui.phase('story');
      await ui.say('maya', 'Good. Now the old team is back in blue. Roll out the new menu again.', 'Roll out again');
      K.reset({ stations: 4, desired: 3, rate: 3, warm: 3, probe: true, startLabel: 'Learning the menu' });
      K.showProbe(true, true);
      K.caption('Blue aprons: old menu (v1). Orange aprons: new menu (v2). Swapping them one by one is a rolling update.');
      K.start();
      K.rollout('v2');
      ui.watch('Rolling out, with the ready check on.');
      await K.until((k) => !k.rolloutTo && k.cooks.filter((c) => c.state !== 'gone').every((c) => c.ver === 'v2' && c.state === 'ready'), 160);
      K.stop();
      await ui.say('maya', K.lost === 0 ? 'Zero failed orders. The pass only used cooks who said "ready". Customers never noticed the change.' : `Only ${K.lost} failed this time. The pass only used cooks who said "ready".`);
      await ui.card({
        maps: [['"I am ready"', 'readinessProbe'], ['The pass', 'Service'], ['Swap one by one', 'Rolling update']],
        plain: 'A **readiness probe** tells Kubernetes when a Pod can take traffic. The **Service** only sends requests to Pods that pass it, so a rolling update stays invisible.',
        cmd: 'readinessProbe:\n  httpGet: { path: /healthz, port: 8080 }\n  periodSeconds: 5\n\nkubectl set image deployment/web web=web:2.0\nkubectl rollout status deployment/web',
      });
    },
  },
];

export function mountStory(host) {
  const app = buildApp(CHAPTERS);
  const ui = createUI(app, CHAPTERS);
  const K = createKitchen(app, ui);
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

  let run = 0;
  async function play(from = 0) {
    const mine = ++run;
    ui.gen = mine;
    ui.notebook.length = 0;
    for (let i = from; i < CHAPTERS.length; i++) {
      if (mine !== run) return;
      ui.progress(i, i);
      K.stop();
      K.reset({ stations: 4, desired: 3 });
      await ui.title(i);
      if (mine !== run) return;
      await CHAPTERS[i].play({ ui, K });
    }
    if (mine !== run) return;
    K.stop();
    ui.progress(-1, CHAPTERS.length);
    ui.end(ui.notebook);
  }
  app.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-action="replay"]')) play(0); });
  app.dots.forEach((d) => d.addEventListener('click', () => play(Number(d.dataset.chapter))));
  window.cookbookStory = { play };
  play(0);
}
