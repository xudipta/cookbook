// Story mode, Kubernetes: "Night Shift at Pizza Palace".
//
// The cluster is a pizza kitchen: a cook is a Pod, the rota is a Deployment, the pass is a Service, the
// stations are node capacity. The kitchen is a tiny simulation (createKitchen); each chapter is a plain
// async script over it (see ../shared/story.js for the script API). Nothing here needs a keyboard.
import { h, createStepper, createSwitch, createCounters, flyTo, mountStory as mount, practiceLinks, FAST, siteUrl } from '../shared/story.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/kubernetes/notes/${name}/`);

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

const STATE_LABEL = { ready: 'Ready', starting: 'Starting', sick: 'Sick', pending: 'Pending', blocked: 'Cannot start' };

// The stage: the rota stepper, the ready-check switch, the pass, the kitchen stations, the cooks waiting
// outside and the served/lost counters, added to the shared stage in front of its caption.
function buildStage(app) {
  const rota = createStepper({ label: 'Cooks on the rota', minusLabel: 'Send one cook home', plusLabel: 'Hire one more cook' });
  const probe = createSwitch({ text: 'Ready check: off' });
  const pips = h('span', { class: 'ks-pips', 'aria-hidden': 'true' });
  const waiting = h('span', { class: 'ks-waiting', text: 'No orders waiting' });
  const pass = h('div', { class: 'ks-pass' }, h('span', { class: 'ks-pass-label', text: 'The pass' }), pips, waiting);
  const kitchen = h('div', { class: 'ks-kitchen', role: 'group', 'aria-label': 'The kitchen' });
  const outside = h('div', { class: 'ks-outside', hidden: true }, h('span', { class: 'ks-outside-label', text: 'Waiting outside: no free station' }));
  const counters = createCounters([{ label: 'Served', cls: 'ks-hud-ok' }, { label: 'Lost', cls: 'ks-hud-bad' }]);
  app.caption.before(rota.el, probe, pass, kitchen, outside, counters.el);
  return {
    ...app, kitchen, outside, pass, pips, waiting, probe,
    hud: counters.el, served: counters.values[0], lost: counters.values[1],
    rota: rota.el, rotaCount: rota.count, rotaMinus: rota.minus, rotaPlus: rota.plus, rotaTerm: rota.term,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The kitchen: a very small cluster                                                           */
/* ------------------------------------------------------------------------------------------ */

function createKitchen(app) {
  const K = {
    cooks: [], stations: 4, desired: 3, rate: 0, warm: 2, probe: true, version: 'v1',
    queue: 0, served: 0, lost: 0, maxQueue: 6, tickMs: 800, ticks: 0, timer: null, picking: null,
    startLabel: 'Starting', rolloutTo: null, rolloutFrom: 0, serial: 0, sawPending: false,
    noteFn: null, passSel: 'web', sauce: 'classic',
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
    c.noteEl.textContent = c.note || '';
    c.noteEl.hidden = !c.note;
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
    const c = { name: COOK_NAMES[n % COOK_NAMES.length], pod: POD_IDS[n % POD_IDS.length], ver, state, warm: K.warm, slot: null, tag: 'web' };
    c.note = K.noteFn ? K.noteFn(c) : '';
    c.chip = h('span', { class: 'ks-chip' });
    c.noteEl = h('code', { class: 'ks-cook-note', text: c.note, hidden: !c.note });
    c.el = h('button', { class: 'ks-cook', type: 'button' }, h('span', { class: 'ks-cook-art' }), h('span', { class: 'ks-cook-name', text: c.name }), h('code', { class: 'ks-cook-pod', text: `web-${c.pod}` }), c.noteEl, c.chip);
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
    if (!c.el.isConnected) return flash();
    flyTo(app.stage, app.pass, c.el, { ms: K.tickMs * 0.6, bad: !ok, done: flash });
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
      const counted = K.cooks.filter((c) => ['ready', 'starting', 'pending', 'blocked'].includes(c.state));
      for (let n = counted.length; n < K.desired; n++) spawn(K.version);
      const extra = counted.length - K.desired;
      if (extra > 0) {
        const order = ['pending', 'blocked', 'starting', 'ready'];
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
    const takers = K.cooks.filter((c) => accepting(c) && c.tag === K.passSel);
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
    reset({ stations = 4, desired = 3, rate = 0, warm = 2, version = 'v1', probe = true, maxQueue = 6, tickMs = 800, startLabel = 'Starting', noteFn = null, sauce = 'classic', passSel = 'web' } = {}) {
      stop();
      K.cooks.forEach((c) => c.el.remove());
      Object.assign(K, { cooks: [], stations, desired, rate, warm, version, probe, maxQueue, tickMs, startLabel, noteFn, sauce, passSel, queue: 0, served: 0, lost: 0, ticks: 0, rolloutTo: null, picking: null, sawPending: false });
      layout();
      for (let i = 0; i < desired; i++) spawn(version, 'ready');
      app.rota.hidden = true;
      app.caption.textContent = '';
      app.probe.hidden = true;
      app.hud.hidden = true;
      K.setPassSel(passSel);
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
    // The pass looks for cooks by name tag (a label). Cooks keep the tag they were hired with.
    setPassSel(sel, show = false) {
      K.passSel = sel;
      app.pass.querySelector('.ks-pass-label').textContent = show ? `The pass asks for: app=${sel}` : 'The pass';
    },
    setSauce(v) { K.sauce = v; },
    // A cook that cannot start (it reads a recipe key that is not on the card).
    spawnBlocked(note) {
      const c = spawn(K.version);
      c.state = 'blocked';
      c.note = note;
      paint(c);
      return c;
    },
    unblock(c, note) {
      c.state = 'starting';
      c.warm = K.warm;
      c.note = note;
      paint(c);
    },
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
    async play({ ui, sim: K }) {
      K.reset({ stations: 6, desired: 3, rate: 2, warm: 2, maxQueue: 2 });
      K.caption('Each box is a station. A cook is one running copy of the app.');
      await ui.say('maya', 'Hi, I am Maya. Think of our website as a **kitchen**. Each cook runs one copy of our app.');
      K.start();
      await ui.say('maya', 'Customers never pick a cook. **The pass** hands each order to a cook who is ready. Watch the tickets go out.');
      const sick = await ui.pick('maya', 'Oh no. A cook just felt dizzy. **Tap a cook** to send them home.', K, 'Tap a cook above.');
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
    async play({ ui, sim: K }) {
      K.reset({ stations: 5, desired: 3, rate: 0, warm: 2, tickMs: 1000, maxQueue: 8 });
      K.showRota(true, 'Deployment · replicas');
      K.caption('The kitchen has 5 stations. A cook with no station has to wait outside.');
      await ui.say('maya', 'Tonight we get **4 orders every tick**. A cook can finish **1 order per tick**.');
      await ui.say('maya', 'You run the rota now. Tap **+** to hire, **−** to send home. Do not let the orders pile up!', 'Start the rush');
      ui.phase('rush', true);
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
        ui.phase('rush', true);
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
    async play({ ui, sim: K }) {
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
  {
    title: 'The recipe card',
    hook: 'The owner wants a spicier sauce. Changing a cook\'s training for every small tweak would take all night.',
    learn: 'ConfigMaps for settings, Secrets for passwords, and when a change takes effect.',
    async play({ ui, sim: K }) {
      const sauceNote = () => (c) => `sauce: ${K.sauce}`;
      K.reset({ stations: 6, desired: 3, rate: 0, warm: 2, noteFn: sauceNote() });
      K.caption('Each cook shows the recipe they follow. The card on the wall says: sauce = classic.');
      await ui.say('maya', 'Tonight the sauce changes from **classic** to **spicy**. Each cook follows a recipe, shown on their badge.');
      const how = await ui.choose('maya', 'How do we change the recipe?', [
        { label: 'Retrain every cook from scratch', value: 'train' },
        { label: 'Put the recipe on a wall card and let cooks read it', value: 'card' },
      ]);
      await ui.say('maya', how === 'card' ? 'Yes. Settings live **outside** the cook, on a card, so one edit changes the recipe for everyone.' : 'That works, but it is slow: you would rebuild and redeploy the app for every tiny tweak. Better to keep settings on a card on the wall and let cooks read it.');
      await ui.card({
        maps: [['The recipe card', 'ConfigMap'], ['A cook reading the card', 'env or a mounted file']],
        plain: 'A **ConfigMap** holds settings outside your image. Pods read it as environment variables or as files, so you change the setting without rebuilding.',
        cmd: 'kubectl create configmap web-config --from-literal=sauce=classic\n\nenv:\n  - name: SAUCE\n    valueFrom:\n      configMapKeyRef: { name: web-config, key: sauce }',
      });
      const bet = await ui.choose('maya', 'Test time. I change the card to **spicy**. What do the cooks already on shift do?', [
        { label: 'They switch to spicy at once', value: 'now' },
        { label: 'Nothing until they start a new shift', value: 'later' },
      ]);
      K.setSauce('spicy');
      K.caption('The card now says: sauce = spicy. Cooks on shift still follow what they read when they started.');
      await ui.say('maya', `${bet === 'later' ? 'Right.' : 'Not quite.'} Look at the badges: they still say **classic**. A cook reads the card **once, when the shift starts** (that is how environment variables work).`, 'Next');
      await ui.say('maya', 'To pick up the change, the cooks need a fresh shift. Swap them one at a time, like the new menu.', 'Restart the cooks');
      K.start();
      K.rollout('v2');
      ui.watch('A fresh shift is starting. New cooks read the card as they arrive.');
      await K.until((k) => !k.rolloutTo && k.cooks.filter((c) => c.state !== 'gone').every((c) => c.ver === 'v2' && c.state === 'ready'), 160);
      K.stop();
      await ui.say('maya', 'Now every badge says **spicy**. The card changed once, and a rolling restart carried it to every cook with no downtime.');
      await ui.card({
        maps: [['A fresh shift for everyone', 'rollout restart']],
        plain: 'A Pod reads **environment variables** from a ConfigMap only when it starts, so after an edit you run a **rollout restart**. Settings mounted as **files** are refreshed in place after a short delay.',
        cmd: 'kubectl edit configmap web-config\nkubectl rollout restart deployment/web\nkubectl rollout status deployment/web',
      });
      await ui.say('maya', 'Now a trickier one. The kitchen needs the **safe\'s code**, the database password.', 'Next');
      const where = await ui.choose('maya', 'Where should the password go?', [
        { label: 'On the open recipe card', value: 'card' },
        { label: 'In the safe', value: 'safe' },
      ]);
      const encoded = btoa('pizza-42');
      await ui.say('maya', where === 'safe' ? 'Right. A **Secret** is the safe: separate from the open card, with its own access rules.' : 'Anyone who can read the card could read the password. Put it in the **safe**, called a **Secret**, which has its own access rules.');
      const scrambled = await ui.choose('maya', `A Secret shows the code as **${encoded}**. Is it encrypted, so nobody can read it?`, [
        { label: 'Yes, it looks scrambled', value: 'yes' },
        { label: 'No, it is only encoded', value: 'no' },
      ]);
      await ui.say('maya', `${scrambled === 'no' ? 'Right.' : 'No!'} Anyone can undo it: decoding **${encoded}** gives **${atob(encoded)}**. That is **base64**, an encoding and not encryption. What keeps the safe safe is **who may open it**.`);
      await ui.card({
        maps: [['The safe', 'Secret'], ['Looks scrambled', 'base64 (not encryption)'], ['Who may open the safe', 'RBAC, plus encryption at rest']],
        plain: 'A **Secret** is stored base64-encoded, which anyone can decode. Protect it with **RBAC** (who can read Secrets) and turn on **encryption at rest**. Never commit the values to git.',
        cmd: 'kubectl create secret generic db --from-literal=password=pizza-42\nkubectl get secret db -o jsonpath=\'{.data.password}\' | base64 -d\n# access is controlled with RBAC, not by the encoding',
      });
      K.reset({ stations: 6, desired: 3, rate: 0, warm: 2, noteFn: () => 'sauce: spicy' });
      K.caption('The card now has the key "sauce_level", renamed by a colleague. The cooks still ask for "sauce".');
      await ui.say('maya', 'One last problem. A colleague **renamed the key** on the card, and a new cook is asking for the old name.', 'Hire a cook');
      K.start();
      K.desired = 4;
      const stuck = K.spawnBlocked('no key "sauce"');
      await ui.say('maya', 'The new cook stands at the door and **cannot start**. The other cooks are fine. How do we find out why?', 'Ask the cook');
      await ui.say('maya', 'The cook says: **couldn\'t find key sauce in ConfigMap web-config**. The card has no key with that name.');
      const fix = await ui.choose('maya', 'What fixes it?', [
        { label: 'Fire and rehire the cook, again and again', value: 'again' },
        { label: 'Put the key back on the card (or ask for the right key)', value: 'fix' },
      ]);
      if (fix !== 'fix') await ui.say('maya', 'A new cook would read the same card and fail the same way. The problem is the **key name**, not the cook. The card and the cooks must agree.', 'Fix the key');
      K.unblock(stuck, 'sauce: spicy');
      K.caption('The card has the key "sauce" again.');
      ui.watch('The key is back. The cook starts.');
      await K.until((k) => k.readyCount() >= 4, 40);
      K.stop();
      await ui.say('maya', 'She started right away. Check the card and the cook agree on the key before blaming the cook.');
      await ui.card({
        maps: [['"Cannot start"', 'CreateContainerConfigError'], ['A key not on the card', 'missing key in ConfigMap']],
        plain: 'A Pod that asks for a ConfigMap key that does not exist stays in **CreateContainerConfigError**. **describe** shows the event with the exact name it could not find.',
        cmd: 'kubectl get pods\nkubectl describe pod web-p2m7   # Events: couldn\'t find key sauce in ConfigMap web-config\nkubectl get configmap web-config -o yaml',
      });
    },
  },
  {
    title: 'The wrong sign on the door',
    hook: 'Every cook is healthy, but customers get nothing. The pass sends orders into thin air.',
    learn: 'how a Service finds Pods by label, and the one command that shows the match.',
    async play({ ui, sim: K }) {
      K.reset({ stations: 6, desired: 3, rate: 2, warm: 2, maxQueue: 2, noteFn: () => 'app=web' });
      K.setPassSel('web', true);
      K.caption('Each cook wears a name tag, shown on the badge. The pass looks for cooks by tag, never by name.');
      K.start();
      await ui.say('maya', 'The pass does not know the cooks by name, because cooks come and go. It looks for a **name tag**: here, **app=web**.');
      await ui.say('maya', 'Watch an order go out. The pass finds every cook wearing **app=web** and hands them the ticket.');
      await ui.card({
        maps: [['A name tag', 'label'], ['The tag the pass looks for', 'Service selector']],
        plain: 'A **Service** finds its Pods by **labels**: its **selector** is the tag it looks for, and any Ready Pod that wears it receives traffic.',
        cmd: 'kubectl get pods --show-labels\nkubectl describe service web       # Selector: app=web',
      });
      await ui.say('maya', 'Now someone is editing the pass and makes **a small typo**.', 'Edit the pass');
      const before = K.lost;
      K.setPassSel('wbe', true);
      K.caption('The pass now asks for app=wbe. Every cook still wears app=web.');
      ui.watch('The pass is asking for the wrong tag. Watch the lost orders.');
      await ui.sleep(2200);
      await ui.say('maya', `All three cooks are **Ready**, but **${K.lost - before}** orders have already been lost. The cooks are not the problem.`);
      for (;;) {
        const pick = await ui.choose('maya', 'What do you check first?', [
          { label: 'Restart all the cooks', value: 'restart' },
          { label: 'Ask the pass who it found', value: 'ask' },
        ]);
        if (pick === 'ask') break;
        await ui.say('maya', 'Fresh cooks would still wear **app=web**, and the pass would still look for **app=wbe**. Nothing changes. Ask the pass who it found instead.', 'Try again');
      }
      await ui.say('maya', 'The pass says it found **nobody**: no endpoints. It looks for **app=wbe** and the cooks wear **app=web**.');
      await ui.card({
        maps: [['Who the pass found', 'endpoints'], ['Nobody matched', 'no endpoints']],
        plain: 'A Service with a selector that matches no Pods has **no endpoints**, so every request fails even though the Pods are healthy. Compare the Service\'s **selector** with the Pods\' **labels**.',
        cmd: 'kubectl get endpoints web           # ENDPOINTS: <none>\nkubectl describe service web         # Selector: app=wbe\nkubectl get pods --show-labels       # LABELS: app=web',
      });
      for (;;) {
        const fix = await ui.choose('maya', 'What do you change?', [
          { label: 'Give every cook the new tag, app=wbe', value: 'cooks' },
          { label: 'Fix the tag the pass asks for', value: 'pass' },
        ]);
        if (fix === 'pass') break;
        await ui.say('maya', 'It would work, but it spreads the typo to every cook, and new cooks would get the right tag again. The mistake lives in the **pass**: fix it there.', 'Try again');
      }
      const lostBefore = K.lost;
      K.setPassSel('web', true);
      K.caption('The pass asks for app=web again.');
      ui.watch('The pass finds its cooks again.');
      await ui.sleep(2000);
      await ui.say('maya', `Orders flow again (${K.lost - lostBefore} lost since the fix). The tag matches, so the pass found all three cooks.`);
      await ui.say('maya', 'Last thing. Cooks come and go, but customers always ring **the same number**. Send a cook home and watch.', 'Send a cook home');
      const sick = await ui.pick('maya', '**Tap a cook** to send them home.', K, 'Tap a cook above.');
      K.sendHome(sick);
      ui.watch('A cook left. Her replacement wears the same tag, so the pass finds her too.');
      await K.until((k) => k.readyCount() >= 3 && k.cooks.filter((c) => c.state !== 'gone').length === 3);
      K.stop();
      await ui.say('maya', 'A new cook with a different name now takes orders, and customers never noticed. The pass keeps **one address** and follows the tags.');
      await ui.card({
        maps: [['One number to ring', 'ClusterIP and DNS name'], ['Follow the name tags', 'selector and endpoints']],
        plain: 'A **Service** gives your Pods one stable address and name (such as **web**). Pods come and go, and the Service follows the **label selector**, so callers never have to change.',
        cmd: 'apiVersion: v1\nkind: Service\nmetadata: { name: web }\nspec:\n  selector: { app: web }   # must match the Pods\' labels\n  ports: [{ port: 80, targetPort: 8080 }]',
      });
    },
  },
];

export function mountStory(host) {
  mount(host, {
    id: 'kubernetes',
    title: 'Night Shift at Pizza Palace',
    stageLabel: 'The kitchen',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      maya: { name: 'Maya', role: 'Owner', color: '#6d28d9' },
    },
    chapters: CHAPTERS,
    createStage: (app) => createKitchen(buildStage(app)),
    startLabel: 'Start the shift',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real Kubernetes',
    endKicker: 'Shift complete',
    endTitle: 'You just ran Kubernetes',
    endIntro: 'Every kitchen word you used has a real name. Here is your notebook.',
    endLinks: [
      { text: 'Read: Pods and workloads', href: NOTE('02-pods-and-workloads') },
      { text: 'Read: Config and secrets', href: NOTE('03-config-and-secrets') },
      { text: 'Read: Services and networking', href: NOTE('04-services-and-networking') },
      { text: 'Read: Probes and resources', href: NOTE('07-probes-and-resources') },
      ...practiceLinks('kubernetes', [['tutorial', 'The tutorial'], ['shift', 'The shift'], ['incident', 'The incident']]),
    ],
  });
}
