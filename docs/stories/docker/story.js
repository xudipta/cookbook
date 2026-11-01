// Story mode, Docker: "The Layer Cake".
//
// An image is a cake: every Dockerfile line is a layer baked on top of the one below, and the build cache is
// the fridge of layers already baked. The bakery runs on the game's real build simulator
// (docs/games/docker/sim.js): the same layer cache, the same errors and the same timings, so what the story
// shows is what `docker build` does. Each chapter is a plain async script over it (see ../shared/story.js).
import { h, createSwitch, createCounters, mountStory as mount, siteUrl } from '../shared/story.js';
import { arrange, createWorld, simulateBuild } from '../../games/docker/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/docker/notes/${name}/`);

// What each kind of Dockerfile line is called in the bakery.
const KIND_WORD = { from: 'Sponge', workdir: 'Tin', copy: 'Filling', run: 'Bake step', cmd: 'Label', expose: 'Label', healthcheck: 'Label', user: 'Label', env: 'Label' };

const fmtSeconds = (n) => `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}s`;

// The pantry, the cake, the fridge counters: a view over one simulator world.
function createBakery(app, levels) {
  const switchEl = createSwitch({ text: 'Ship only the last stage: off' });
  const counters = createCounters([
    { label: 'Baking time', cls: 'ks-hud-ok' },
    { label: 'Fridge', cls: 'ks-hud-ok' },
    { label: 'Cake size', cls: 'ks-hud-ok' },
  ]);
  const cake = h('ol', { class: 'lc-cake', 'aria-label': 'The cake, bottom layer first' });
  const undo = h('button', { class: 'lc-tool', type: 'button', text: 'Undo' });
  const clear = h('button', { class: 'lc-tool', type: 'button', text: 'Start over' });
  const tools = h('div', { class: 'lc-tools', hidden: true }, undo, clear);
  const pantry = h('div', { class: 'lc-pantry', role: 'group', 'aria-label': 'Pantry: tap a layer to add it to the cake', hidden: true });
  app.caption.before(switchEl, counters.el, cake, tools, pantry);

  const D = { sc: null, world: null, stack: [], stacking: false, last: null, onSwitch: null };

  const card = (id) => D.world.cards.get(id);
  const layerEl = (id, status, note) => {
    const c = card(id);
    return h('li', { class: `lc-layer is-${status}`, 'data-id': id },
      h('span', { class: 'lc-kind', text: KIND_WORD[c.kind] || 'Layer' }),
      h('code', { class: 'lc-text', text: c.text }),
      h('span', { class: 'lc-chip', text: note }));
  };

  function paintCake() {
    const res = D.last;
    // In a multi-stage build only the last stage is shipped: the earlier stages stay in the kitchen.
    const lastStage = res && res.ok ? Math.max(...res.layers.map((l) => l.stage)) : 0;
    cake.replaceChildren(...D.stack.map((id, i) => {
      const layer = res && res.layers[i];
      if (!layer) return layerEl(id, 'new', 'New');
      if (res.ok && layer.stage < lastStage) return layerEl(id, 'left', 'Stays in the kitchen');
      if (layer.status === 'CACHED') return layerEl(id, 'cached', 'From the fridge');
      if (layer.status === 'ERROR') return layerEl(id, 'error', 'Failed');
      return layerEl(id, 'built', layer.time >= 0.5 ? `Baked ${fmtSeconds(layer.time)}` : 'Baked');
    }));
    // An error leaves the layers after it untouched.
    if (res && !res.ok) for (let i = res.layers.length; i < D.stack.length; i++) cake.children[i].querySelector('.lc-chip').textContent = 'Not reached';
  }

  function paintPantry() {
    const left = [...D.world.cards.keys()].filter((id) => !D.stack.includes(id));
    pantry.hidden = !D.stacking || left.length === 0;
    pantry.replaceChildren(...left.map((id) => {
      const c = card(id);
      const b = h('button', { class: 'lc-card', type: 'button', 'data-id': id },
        h('span', { class: 'lc-kind', text: KIND_WORD[c.kind] || 'Layer' }),
        h('code', { class: 'lc-text', text: c.text }));
      b.addEventListener('click', () => { if (D.stacking) D.add(id); });
      return b;
    }));
    tools.hidden = !D.stacking;
    undo.disabled = D.stack.length === 0;
    clear.disabled = D.stack.length === 0;
  }

  function paintCounters() {
    const res = D.last;
    const [time, fridge, size] = counters.values;
    counters.el.hidden = !res;
    if (!res || !res.ok) return;
    time.textContent = fmtSeconds(res.seconds);
    const cached = res.layers.filter((l) => l.status === 'CACHED').length;
    fridge.textContent = `${cached}/${res.layers.length}`;
    size.textContent = `${Math.round(res.size)}MB`;
  }

  const paint = () => { paintCake(); paintPantry(); paintCounters(); };

  Object.assign(D, {
    // Start a chapter from one of the game's levels, with only the cards the story needs in the pantry.
    load(levelId, { cards, stack = [] }) {
      const level = levels.find((l) => l.id === levelId);
      D.sc = { ...level, cards: level.cards.filter((c) => cards.includes(c.id)), dockerfile: [] };
      D.fresh();
      D.stack = [...stack];
      arrange(D.world, D.stack);
      D.last = null;
      paint();
    },
    // A new world: nothing baked yet, so an empty fridge.
    fresh() {
      D.world = createWorld(D.sc);
    },
    allowStacking(on) {
      D.stacking = on;
      paint();
    },
    add(id) {
      if (D.stack.includes(id)) return;
      D.stack.push(id);
      D.last = null;
      paint();
    },
    undoLast() {
      D.stack.pop();
      D.last = null;
      paint();
    },
    clearStack() {
      D.stack = [];
      D.last = null;
      paint();
    },
    setStack(ids) {
      D.stack = [...ids];
      D.last = null;
      paint();
    },
    // Bake the cake the way `docker build` would, in this world (so its fridge counts).
    bake() {
      arrange(D.world, D.stack);
      D.last = simulateBuild(D.world, D.sc);
      if (D.last.ok) D.world.lastVersions = { ...D.world.versions };
      paint();
      return D.last;
    },
    // Someone edits some of the files in the build context.
    edit(files) {
      for (const f of files) D.world.versions[f] += 1;
    },
    showSwitch(on, text) {
      switchEl.hidden = !on;
      if (text) switchEl.querySelector('.ks-switch-text').textContent = text;
    },
    setSwitch(on, text) {
      switchEl.setAttribute('aria-checked', String(on));
      switchEl.querySelector('.ks-switch-text').textContent = text;
    },
    caption(text) { app.caption.textContent = text || ''; },
    // Required by the story shell.
    reset() {
      D.sc = null;
      D.world = null;
      D.stack = [];
      D.last = null;
      D.stacking = false;
      cake.replaceChildren();
      pantry.replaceChildren();
      pantry.hidden = true;
      tools.hidden = true;
      counters.el.hidden = true;
      switchEl.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  undo.addEventListener('click', () => D.undoLast());
  clear.addEventListener('click', () => D.clearStack());
  switchEl.addEventListener('click', () => { if (!switchEl.disabled && D.onSwitch) D.onSwitch(); });
  D.switchEl = switchEl;
  return D;
}

// What a failed or useless bake means, in the bakery's words (the real error is shown too).
function bakeProblem(res) {
  if (!res.ok) {
    const id = res.error && res.error.id;
    if (id === 'err-no-from') return 'Nothing to build on! Every Dockerfile starts with **FROM**: the sponge. The other layers go on top of it.';
    if (id === 'err-missing-input') return 'A step needed something that is not in the cake yet. Layers can only use what the layers below them put there.';
    return 'The bake failed.';
  }
  if (!res.runs) return `The cake bakes, but it is not finished: ${res.runsWhy}.`;
  return null;
}

const realError = (res) => (res.ok ? res.runsWhy : res.error.short);

// The Dockerfile order that keeps the slow step in the fridge.
const SMART_ORDER = ['from-node', 'workdir', 'copy-manifest', 'npm-ci', 'copy-all', 'build', 'cmd-node'];
const SLOW_ORDER = ['from-node', 'workdir', 'copy-all', 'npm-ci', 'build', 'cmd-node'];

function makeChapters() {
  return [
    {
      title: 'The first cake',
      hook: 'Bea runs a bakery that sells one thing: layered cakes. Today she hands you the apron.',
      learn: 'what an image and a layer are, and how Docker remembers a layer.',
      async play({ ui, sim: D }) {
        D.load('hello', { cards: ['from-nginx', 'copy-index', 'expose-80'] });
        D.caption('The first line is the bottom of the cake. Each layer sits on the one before it.');
        await ui.say('bea', 'Welcome to the bakery! We sell cakes, and a cake is a **stack of layers**. Each layer is baked on top of the one below it.');
        await ui.say('bea', 'A Docker **image** is a cake too. Build one from the pantry: tap layers to stack them, **bottom layer first**.');
        D.allowStacking(true);
        for (;;) {
          ui.phase('stack1');
          await ui.choose('bea', 'Stack your cake, then bake it. Tap **Undo** or **Start over** if you change your mind.', [
            { label: 'Bake the cake', value: 'bake' },
          ]);
          const res = D.bake();
          const problem = bakeProblem(res);
          if (!problem) break;
          ui.phase('story');
          await ui.say('bea', `${problem} Docker said: **${realError(res)}**`, 'Try again');
          D.clearStack();
        }
        ui.phase('story');
        D.allowStacking(false);
        await ui.say('bea', 'Baked! Every layer says how long it took. The sponge came out of the oven first, then the filling on top of it.');
        await ui.say('bea', 'Now a customer wants a new sign on the front page. You edit **index.html** and bake the same cake again.');
        const guess = await ui.choose('bea', 'Before we bake: which layers do you think have to be baked again?', [
          { label: 'Only the top layer', value: 'top' },
          { label: 'The filling and everything above it', value: 'above' },
          { label: 'Every layer, from the sponge up', value: 'all' },
        ]);
        D.edit(['index.html']);
        D.bake();
        await ui.say('bea', `${guess === 'above' ? 'Right!' : 'Not quite.'} The sponge came straight out of the **fridge**. The filling changed, so it and everything on top of it were baked again.`);
        await ui.card({
          maps: [['Sponge', 'FROM'], ['Filling', 'COPY'], ['The cake', 'image'], ['Baking', 'docker build'], ['The fridge', 'build cache']],
          plain: 'Every Dockerfile line makes a **layer**. Docker keeps each one in its **cache**. A layer is reused only if its line, its files and every layer below it are unchanged.',
          cmd: 'FROM nginx:1.27-alpine\nCOPY index.html /usr/share/nginx/html/index.html\nEXPOSE 80\n\ndocker build -t hello-nginx .\n# edit index.html and build again: the base layers say CACHED',
        });
      },
    },
    {
      title: 'Don\'t re-bake the sponge',
      hook: 'The bakery is growing. Every small change costs almost a minute, and the customers are queueing.',
      learn: 'why the order of Dockerfile lines decides how fast your builds are.',
      async play({ ui, sim: D }) {
        D.load('cache', { cards: SMART_ORDER, stack: SLOW_ORDER });
        D.caption('The slow step is npm ci: 38 seconds to install every ingredient.');
        await ui.say('bea', 'This is our app cake. It needs **ingredients** installed (that is the slow step) and then a final bake. Here is the recipe as it stands.');
        ui.phase('story');
        await ui.say('bea', 'Bake it once.', 'Bake the cake');
        D.bake();
        await ui.say('bea', `About a minute. Fine for the first cake. But then a teammate fixes **one typo** in the code, and we bake again.`);
        const guess = await ui.choose('bea', 'Which layers come out of the fridge this time?', [
          { label: 'All of them: only the code changed', value: 'all' },
          { label: 'Just the first two layers', value: 'two' },
          { label: 'Only the last layer is baked again', value: 'last' },
        ]);
        D.edit(['src']);
        const second = D.bake();
        await ui.say('bea', `${guess === 'two' ? 'Right.' : 'Nope.'} Only the sponge and the tin were reused. The code is copied in **before** the ingredients are installed, so changing one line re-installs everything: **${fmtSeconds(second.seconds)}** for a typo.`);
        await ui.say('bea', 'The ingredients do not depend on our code, only on the shopping list (**package.json**). So copy the shopping list first, install, and copy the code **after**. Rebuild the cake in that order.');
        let attempts = 0;
        for (;;) {
          D.clearStack();
          D.fresh();
          D.allowStacking(true);
          ui.phase('stack2');
          const choice = await ui.choose('bea', attempts >= 2 ? 'Still stuck? I can show you the order.' : 'Stack all seven layers: tap them in the order you would bake them, then bake.', [
            { label: 'Bake it, then change the code', value: 'bake' },
            ...(attempts >= 2 ? [{ label: 'Show me the order', value: 'show' }] : []),
          ]);
          if (choice === 'show') { D.setStack(SMART_ORDER); continue; }
          ui.phase('story');
          D.allowStacking(false);
          const cold = D.bake();
          const problem = bakeProblem(cold);
          if (problem) {
            attempts += 1;
            await ui.say('bea', `${problem} Docker said: **${realError(cold)}**`, 'Try again');
            continue;
          }
          D.edit(['src']);
          const warm = D.bake();
          if (warm.seconds <= 12) {
            await ui.say('bea', `**${fmtSeconds(warm.seconds)}** instead of ${fmtSeconds(second.seconds)}! The ingredients stayed in the fridge, and only the code and the final bake were redone.`);
            break;
          }
          attempts += 1;
          await ui.say('bea', `That took ${fmtSeconds(warm.seconds)}: the install was baked again. Something that changes often sits **below** the install. Try again.`, 'Try again');
        }
        await ui.card({
          maps: [['A changed layer', 'cache miss'], ['The shopping list', 'package.json'], ['Bake order', 'instruction order']],
          plain: 'Put what **changes rarely** (the dependency files and the install) near the top of the Dockerfile, and what **changes often** (your code) below it. A change only re-bakes its layer and the ones after it.',
          cmd: 'FROM node:20-alpine\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\nCMD ["node", "dist/server.js"]',
        });
      },
    },
    {
      title: 'Ship the cake, not the kitchen',
      hook: 'A customer complains: the cake arrived with the oven, the flour sacks and the mixing bowls.',
      learn: 'how a multi-stage build ships only the finished result.',
      async play({ ui, sim: D }) {
        const single = ['from-node', 'workdir', 'copy-manifest', 'npm-ci', 'copy-all', 'build', 'cmd-node'];
        const multi = ['from-node-build', 'workdir', 'copy-manifest', 'npm-ci', 'copy-all', 'build', 'from-nginx', 'copy-dist', 'expose-80'];
        D.load('bloat', { cards: [...new Set([...single, ...multi])], stack: single });
        D.showSwitch(true, 'Ship only the last stage: off');
        D.caption('Cake size is what gets delivered over the network.');
        await ui.say('bea', 'Our site is just a few **static pages**, but the cake we ship still contains Node, every ingredient and all the source code. Look at the size.', 'Bake it');
        D.bake();
        await ui.say('bea', 'That is the **whole kitchen** in the box. We only need the finished pages, served by a small web server.');
        const guess = await ui.choose('bea', 'If we bake in one kitchen, then move only the finished pages to a clean box, how big will the cake be?', [
          { label: 'About the same, it is still a cake', value: 'same' },
          { label: 'Much smaller: the kitchen stays behind', value: 'small' },
        ]);
        let shipped = false;
        D.onSwitch = () => {
          shipped = !shipped;
          D.setStack(shipped ? multi : single);
          D.setSwitch(shipped, `Ship only the last stage: ${shipped ? 'on' : 'off'}`);
        };
        ui.note('bea', 'Flip the switch: the first stage bakes the site, the second stage is a clean box that only receives the result.');
        ui.phase('ship');
        await new Promise((resolve) => {
          const prev = D.onSwitch;
          D.onSwitch = () => { prev(); if (shipped) resolve(); };
        });
        ui.phase('story');
        D.onSwitch = null;
        D.fresh();
        const res = D.bake();
        await ui.say('bea', `${guess === 'small' ? 'Right!' : 'Surprise!'} The cake is now **${Math.round(res.size)}MB**. The kitchen did its work in the first stage and was thrown away. Only the finished pages came along.`);
        await ui.card({
          maps: [['Two kitchens', 'multi-stage build'], ['Clean box', 'final stage'], ['Move the result', 'COPY --from']],
          plain: 'A **multi-stage build** bakes in one stage and copies only the result into a small final stage. Compilers, dependencies and source stay behind, and the image gets smaller and safer.',
          cmd: 'FROM node:20-alpine AS build\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n\nFROM nginx:1.27-alpine\nCOPY --from=build /app/dist /usr/share/nginx/html\nEXPOSE 80',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/docker/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const levels = (await res.json()).levels;
  mount(host, {
    id: 'docker',
    title: 'The Layer Cake',
    stageLabel: 'The bakery',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      bea: { name: 'Bea', role: 'Head baker', color: '#9d174d' },
    },
    chapters: makeChapters(),
    createStage: (app) => createBakery(app, levels),
    startLabel: 'Start baking',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real Docker',
    endKicker: 'Shift complete',
    endTitle: 'You just built Docker images',
    endIntro: 'Every bakery word you used has a real name. Here is your notebook.',
    endLinks: [
      { text: 'Read: Images and Dockerfiles', href: NOTE('01-images-and-dockerfiles') },
      { text: 'Read: Multi-stage builds and caching', href: NOTE('02-multi-stage-builds-and-caching') },
      { text: 'Play the real Docker game', href: new URL('docker/', HUB).href },
    ],
  });
}
