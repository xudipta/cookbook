// Story mode, CI/CD: "The Assembly Line".
//
// A workflow is an assembly line: a trigger starts it, jobs are stations, the cache is a bin of ready-made
// parts, and runner minutes are the electricity bill. The story runs on the practice game's real simulator
// (docs/games/cicd/sim.js): the cards generate the real GitHub Actions YAML, every incoming pull request is run
// through the workflow as it stands, and Deploy Day replays a bad release through three rollout strategies. Each
// chapter is a plain async script over it (see ../shared/story.js).
import { h, createCounters, outputBox, mountStory as mount, practiceLinks, siteUrl } from '../shared/story.js';
import { applyAction, buildFiles, createWorld, goals, incoming, pipelineStats, tick, tileStates } from '../../games/cicd/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/cicd/notes/${name}/`);

// What each group of card is, in the factory's words.
const GROUP_WORD = {
  trigger: 'Starts the line', filter: 'Skips the line', cache: 'Parts bin', matrix: 'Test on both models', needs: 'Wait for lint',
  concurrency: 'One run per branch', perms: 'Key card', ref: 'Vendor tool', 'reuse-lint': 'Shared lint station', 'reuse-setup': 'Shared setup',
  checkout: 'Fetches the PR code',
};

const seedRng = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n) => `${(n * 100).toFixed(1)}%`;

// The line: the placed cards as stations and the meters; on Deploy Day, the three environments and the fleet.
function createLine(app, { levels, cardDefs }) {
  const next = h('p', { class: 'al-next', hidden: true });
  const counters = createCounters([
    { label: 'Minutes', cls: 'ks-hud-ok' },
    { label: 'Feedback', cls: 'ks-hud-ok' },
    { label: 'Security', cls: 'ks-hud-ok' },
  ]);
  const line = h('ol', { class: 'al-line', 'aria-label': 'The stations on your line', hidden: true });
  const envs = h('ol', { class: 'al-envs', 'aria-label': 'Environments', hidden: true });
  const release = h('div', { class: 'al-release', hidden: true });
  const fleet = h('div', { class: 'al-fleet', role: 'img', hidden: true });
  const errors = h('p', { class: 'al-errors', hidden: true });
  app.caption.before(next, counters.el, line, envs, release, fleet, errors);

  const A = { sc: null, world: null, kind: null, lines: [] };
  const ctx = { ticks: 0, fire() {}, resolve() {}, log(t, o) { A.lines.push(`${o && o.kind === 'warn' ? 'Problem' : 'Note'}: ${String(t).replace(/\s*\(-\d+ health\)/, '')}`); }, step() {}, rng: null, scenario: null };
  ctx.step = () => { ctx.ticks += 1; tick(A.world, ctx); };

  function paintPipeline() {
    const w = A.world;
    next.hidden = !A.nextText;
    next.textContent = A.nextText ? `Next order: ${A.nextText}` : '';
    const s = pipelineStats(w);
    counters.el.hidden = false;
    const [minutes, feedback, security] = counters.values;
    minutes.textContent = `${fmt(s.minutes)}/${s.budget}`;
    feedback.textContent = s.median === null ? '—' : `${fmt(s.median)} min`;
    security.textContent = s.security === null ? '\u2014' : String(s.security);
    line.hidden = false;
    line.replaceChildren(...w.placed.map((id) => {
      const def = cardDefs[id];
      return h('li', { class: 'al-station' },
        h('span', { class: 'al-word', text: GROUP_WORD[def.group] || 'Station' }),
        h('code', { class: 'al-label', text: def.label }));
    }));
  }

  function paintDeploy() {
    const w = A.world;
    next.hidden = true;
    line.hidden = true;
    envs.hidden = false;
    release.hidden = false;
    fleet.hidden = false;
    errors.hidden = false;
    envs.replaceChildren(...['dev', 'staging', 'prod'].map((name) => h('li', { class: `al-env${w.stage === name ? ' is-here' : ''}`, 'aria-current': w.stage === name ? 'step' : null, text: name })));
    const r = w.releases[w.idx];
    release.replaceChildren(...(r ? [h('strong', { text: `${r.version} ${r.title}` }), h('span', { text: r.notes.join(' · ') })] : [h('strong', { text: 'All releases handled' })]));
    const tiles = tileStates(w);
    fleet.setAttribute('aria-label', `Fleet of ${tiles.length} servers: ${tiles.filter((t) => t === 'new').length} run the new version`);
    fleet.replaceChildren(...tiles.map((t) => h('span', { class: `al-tile is-${t}` })));
    const last = w.history[w.history.length - 1];
    const rate = last ? (last.fresh ?? last.all) : 0;
    errors.replaceChildren(h('span', { text: `Errors: ${pct(rate)}` }), h('span', { text: `Failed requests: ${Math.round(w.failedRelease)}` }), h('span', { text: `Minute ${w.minute}` }));
    errors.classList.toggle('is-bad', rate >= 0.05);
    counters.el.hidden = true;
  }

  const paint = () => (A.kind === 'deploy' ? paintDeploy() : paintPipeline());

  Object.assign(A, {
    place(id) { applyAction(A.world, ctx, 'place', id); paint(); },
    remove(id) { applyAction(A.world, ctx, 'remove', id); paint(); },
    paint,
    // Start a chapter from one of the game's levels.
    load(levelId, { replay = [] } = {}) {
      const level = levels.find((l) => l.id === levelId);
      A.sc = { ...level, cardDefs };
      ctx.scenario = A.sc;
      ctx.rng = seedRng(level.seed || 7);
      ctx.ticks = 0;
      A.world = createWorld(A.sc);
      A.kind = A.world.mode;
      for (const [name, ...args] of replay) applyAction(A.world, ctx, name, ...args);
      A.hist = replay.map((s) => [...s]);
      A.lines = [];
      A.nextText = A.kind === 'pipeline' ? incoming(A.world, ctx) : null;
      paint();
    },
    // One counted action; returns what the simulator printed (jobs, minutes, problems).
    act(name, ...args) {
      const w = A.world;
      A.lines = [];
      const before = w.out.length;
      const result = applyAction(w, ctx, name, ...args);
      (A.hist ||= []).push([name, ...args]);
      const out = w.out.splice(before).map((o) => o.text).filter((t) => t.trim()).concat(A.lines);
      A.nextText = A.kind === 'pipeline' ? incoming(w, ctx) : null;
      paint();
      A.lastResult = result;
      return out.join('\n');
    },
    // The real workflow the placed cards generate.
    yaml() { return buildFiles(A.world)[0].text.trim(); },
    goals() { return goals(A.world); },
    // Replay a bad release through a rollout strategy in a world of its own: how many requests failed?
    failedWith(kind, replay) {
      const w = createWorld(A.sc);
      const c = { ticks: 0, fire() {}, resolve() {}, log() {}, step() { c.ticks += 1; tick(w, c); }, rng: seedRng(A.sc.seed || 7), scenario: A.sc };
      for (const [name, ...args] of replay) applyAction(w, c, name, ...args);
      applyAction(w, c, 'promote'); applyAction(w, c, 'wait');
      applyAction(w, c, 'deploy', kind);
      for (let i = 0; i < 14 && w.alerted == null; i++) {
        applyAction(w, c, 'wait');
        if (kind === 'bluegreen' && i === 0) applyAction(w, c, 'cutover');
      }
      return Math.round(w.failedTotal);
    },
    // What a wrong choice would really do: the same steps so far, then these, on a scratch copy of the level.
    // Returns what the simulator printed for the extra steps, the delivery health and the failed requests.
    trial(steps) {
      const w = createWorld(A.sc);
      const c = { ticks: 0, fire() {}, resolve() {}, log(t, o) { lines.push(`${o && o.kind === 'warn' ? 'Problem' : 'Note'}: ${String(t).replace(/\s*\(-\d+ health\)/, '')}`); }, step() { c.ticks += 1; tick(w, c); }, rng: seedRng(A.sc.seed || 7), scenario: A.sc };
      const lines = [];
      for (const [name, ...args] of A.hist || []) applyAction(w, c, name, ...args);
      lines.length = 0;
      const before = w.out.length;
      for (const [name, ...args] of steps) applyAction(w, c, name, ...args);
      const out = w.out.slice(before).map((o) => o.text).filter((t) => t.trim()).concat(lines);
      return { out: out.join('\n'), health: Math.round(w.health ?? 100), failed: Math.round(w.failedTotal || 0) };
    },
    alerted() { return A.world.alerted != null; },
    caption(text) { app.caption.textContent = text || ''; },
    reset() {
      A.world = null;
      A.sc = null;
      A.kind = null;
      A.nextText = null;
      next.hidden = true;
      counters.el.hidden = true;
      line.replaceChildren();
      line.hidden = true;
      envs.hidden = true;
      release.hidden = true;
      fleet.hidden = true;
      errors.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  return A;
}

// What a run printed, as an output box.
const box = (text) => outputBox(text);

// One problem on the line: the player picks the card that fixes it; a wrong pick is explained and asked again.
async function pickFix(ui, A, ask, options) {
  for (;;) {
    const picked = await ui.choose('ray', ask, options.map((o) => ({ label: o.label, value: o.card })));
    const opt = options.find((o) => o.card === picked);
    if (opt.right) {
      A.place(picked);
      return;
    }
    await ui.say('ray', opt.why, 'Try again');
  }
}

function makeChapters() {
  return [
    {
      title: 'Fast feedback',
      hook: 'Ray runs the factory line that tests every change to the shop. The electricity bill is huge and the testers wait for ages.',
      learn: 'how a workflow runs, and which cards make it faster and cheaper.',
      async play({ ui, sim: A }) {
        A.load('fast-feedback');
        A.caption('Each order that arrives runs through the stations. Minutes are the electricity bill.');
        await ui.say('ray', 'Welcome to the line. Every time someone sends a change, an **order** arrives. A **trigger** starts the line, then the **stations** (jobs) run one after another. The meter counts **minutes** of electricity: we have **50** this month.');
        await ui.say('ray', 'Our goal: the people who send changes must hear back in **6 minutes or less**, without blowing the 50. Right now the line starts on a push and on a pull request, and runs everything, every time.');
        const problems = [
          {
            ask: 'The first order of the month arrives. Every run downloads **all the parts** from scratch. What helps?',
            options: [
              { card: 'matrix', label: 'Test on two models of everything', why: 'That doubles the testing. The slow part is fetching parts every time, not how many tests there are.' },
              { card: 'cache-setup', label: 'Keep a bin of ready-made parts (cache)', right: true },
              { card: 'on-schedule', label: 'Add a nightly run as well', why: 'More runs means more minutes on the meter. We are trying to spend less.' },
            ],
            done: 'The parts bin is on the line. From now on a run reuses what it already fetched.',
          },
          {
            ask: 'Next order: a change that **only edits a README**. Do we need to run the whole line for it?',
            options: [
              { card: 'paths-ignore', label: 'Skip the line for notes-only changes', right: true },
              { card: 'on-dispatch', label: 'Add a manual run button', why: 'A button lets people start runs. It does not stop pointless runs from starting.' },
              { card: 'concurrency', label: 'Cancel older runs', why: 'That helps when pushes pile up, but a README edit starts only one run. The run itself is the waste.' },
            ],
            done: 'Notes-only changes no longer start the line.',
          },
          {
            ask: 'Next order: a change with a **style error**. The tests station still runs in full on it. What fixes that?',
            options: [
              { card: 'cache-action', label: 'A second kind of parts bin', why: 'We already keep a parts bin. The tests are running because they do not wait for lint.' },
              { card: 'needs-lint', label: 'Tests wait for lint, and stop if it fails', right: true },
              { card: 'matrix', label: 'Test on two models of everything', why: 'That would make a failed change cost even more minutes.' },
            ],
            done: 'The tests station now waits for lint. A failed lint stops the line.',
          },
          {
            ask: 'Next: **five quick pushes** to the same branch in one minute. Five runs start. What do we do with the older four?',
            options: [
              { card: 'concurrency', label: 'Cancel older runs: only the newest matters', right: true },
              { card: 'on-schedule', label: 'Add a nightly run as well', why: 'That adds a run. The problem is runs nobody will read.' },
              { card: 'paths-ignore', label: 'Skip the line for notes-only changes', why: 'These changes are real code, so that filter would not skip them.' },
            ],
            done: 'A newer push now cancels the older run on the same branch.',
          },
          {
            ask: 'Next: production runs **Node 18 and Node 20**, but we only test on 20, and this change breaks on 18. What do we add?',
            options: [
              { card: 'matrix', label: 'Test on both Node versions', right: true },
              { card: 'cache-setup', label: 'Keep a bin of ready-made parts (cache)', why: 'We already have that. It makes runs faster, but it cannot find a bug that only happens on another version.' },
              { card: 'on-dispatch', label: 'Add a manual run button', why: 'Somebody has to remember to press it, on the right version. We want it automatic.' },
            ],
            done: 'Every change is now tested on both versions.',
          },
        ];
        for (const p of problems) {
          await pickFix(ui, A, p.ask, p.options);
          const out = A.act('runNext');
          await ui.say('ray', p.done, 'Next order', box(out));
        }
        const out = A.act('runNext');
        const ok = A.goals().every((g) => g.ok);
        await ui.say('ray', ok ? 'The last order: another README edit, and the line did not even start. Feedback is under 6 minutes and the bill is within the 50. The line works.' : 'The last order ran. Look at the meter.', 'Next', box(out));
        await ui.card({
          maps: [['The assembly line', 'workflow'], ['A station', 'job'], ['What starts the line', 'trigger (on:)'], ['Bin of ready-made parts', 'cache'], ['Test on both models', 'matrix'], ['Electricity', 'runner minutes']],
          plain: 'A **workflow** is a set of **jobs** that a **trigger** starts. **Caching**, **path filters**, `needs:`, **concurrency** and a **matrix** make it faster, cheaper and more thorough.',
          cmd: A.yaml(),
        });
      },
    },
    {
      title: 'Locked down',
      hook: 'Somebody wired a shortcut into the line. A stranger\'s change can now reach the factory\'s keys.',
      learn: 'least privilege: the safe trigger, pinned vendor tools, a read-only key card.',
      async play({ ui, sim: A }) {
        A.load('locked-down');
        A.caption('The security score starts low. Fix the risky stations.');
        await ui.say('ray', 'Look at the line. It starts on **pull_request_target** and then checks out the **stranger\'s code** while our **secrets** are in the room. A stranger\'s change from a fork could print our keys.');
        for (;;) {
          const pick = await ui.choose('ray', 'What do we do about the trigger?', [
            { label: 'Keep it: it works for forks', value: 'keep' },
            { label: 'Use pull_request and stop fetching the stranger\'s code with secrets', value: 'fix' },
          ]);
          if (pick === 'fix') break;
          await ui.say('ray', 'It works, and that is the danger: **pull_request_target** has the secrets, and we hand a stranger\'s code the keys. A **pull_request** run from a fork gets read-only access and no secrets.', 'Try again');
        }
        A.remove('on-prt');
        A.remove('checkout-head');
        A.place('on-pr');
        await ui.say('ray', 'Fixed: the line starts on a **pull_request** and no longer runs strangers\' code with our secrets.', 'Next');
        const steps = [
          {
            ask: 'The lint rules changed, and **four workflows paste the same lint job**. Updating four copies by hand will go wrong. What do we do?',
            options: [
              { card: 'composite-setup', label: 'A shared tool for the Node setup steps', why: 'That is for the setup steps. The repeated part here is the lint job.' },
              { card: 'reusable-lint', label: 'One shared lint station that every workflow calls', right: true },
            ],
          },
          {
            ask: 'The Node setup is pasted into **every job**. How do we stop copying it?',
            options: [
              { card: 'composite-setup', label: 'Fold the setup steps into one shared tool', right: true },
              { card: 'reusable-lint', label: 'A shared station for the lint job', why: 'We already share the lint station. This repeated part is the setup steps.' },
            ],
          },
          {
            ask: 'A vendor tool we use (**notify-slack**) was **hacked upstream**: its main branch got a malicious commit. How should we have pointed at it?',
            options: [
              { card: 'ref-main', label: 'Follow the vendor\'s latest (@main)', why: 'That is how we got hit: the line picks up whatever the vendor pushes, including a malicious commit.' },
              { card: 'ref-tag', label: 'A named version (@v2)', why: 'Better, but a tag can be moved to a new commit, so a hacked vendor can still swap it.' },
              { card: 'ref-sha', label: 'One exact commit (a full SHA)', right: true },
            ],
          },
          {
            ask: 'A dependency tries to **push code to our repo** using the job\'s key card. The key card can write by default. What do we do?',
            options: [
              { card: 'perms-read', label: 'Give the key card read-only access', right: true },
              { card: 'concurrency', label: 'Cancel older runs', why: 'That does not limit what a run is allowed to do. We need a smaller key card.' },
            ],
          },
        ];
        let out = A.act('runNext');
        await ui.say('ray', 'A first order ran on the safe trigger. Now, the next problems on the line.', 'Next', box(out));
        for (const s of steps) {
          await pickFix(ui, A, s.ask, s.options);
          out = A.act('runNext');
          await ui.say('ray', 'Done.', 'Next', box(out));
        }
        const goal = A.goals().find((g) => g.id === 'security');
        await ui.say('ray', `Nothing leaked, and the line is locked down. ${goal ? goal.text + '.' : ''}`, 'Next');
        await ui.card({
          maps: [['A stranger\'s change from a fork', 'pull_request'], ['A key card that only reads', 'permissions: contents: read'], ['Pin the vendor tool to one exact version', 'uses: owner/action@<full SHA>'], ['A station every workflow calls', 'reusable workflow'], ['Shared setup steps', 'composite action']],
          plain: 'Give every workflow the **least privilege** it needs: the safe trigger for forks, a **read-only** token, and third-party actions **pinned to a full commit SHA**. Share repeated jobs and steps instead of pasting them.',
          cmd: A.yaml(),
        });
      },
    },
    {
      title: 'Deploy day',
      hook: 'The line works. Now a release must travel from the workshop to the customers, and this one has a hidden fault.',
      learn: 'environments, and how rolling, blue-green and canary releases limit the damage of a bad release.',
      async play({ ui, sim: A }) {
        const replay = [['promote'], ['wait'], ['deploy', 'rolling'], ...Array(7).fill(['wait'])];
        A.load('deploy-day', { replay });
        A.caption('Each square is 5% of the servers. Errors above 5% raise the alarm.');
        await ui.say('ray', 'Today\'s release, **v1.5.0**, is the checkout redesign. A release travels through **environments**: dev, then staging, then production, where the customers are.');
        await ui.say('ray', 'CI is green. First, send it to **staging** and run the smoke tests.', 'Promote to staging');
        let out = A.act('promote');
        out = A.act('wait');
        await ui.say('ray', 'The staging smoke tests passed too. But this release has a fault that only real customers will hit. You must choose how to put it in production.', 'Next', box(out));
        const kind = await ui.choose('ray', 'Which way do we release it to production?', [
          { label: 'Rolling: replace servers a few at a time', value: 'rolling' },
          { label: 'Blue-green: build a full copy, then switch everyone', value: 'bluegreen' },
          { label: 'Canary: 5% of customers first, then widen', value: 'canary' },
        ]);
        out = A.act('deploy', kind);
        if (kind === 'bluegreen') {
          await ui.say('ray', 'The full copy ("green") is built next to the old one ("blue"). Nobody uses it yet. Switch the customers over when you are ready.', 'Switch all customers', box(out));
          out = A.act('cutover');
        }
        let minutes = 0;
        for (;;) {
          ui.phase('watch');
          await ui.say('ray', A.alerted() ? '**The alarm is ringing**: more than 5% of requests are failing.' : 'Watch the error rate for a minute.', A.alerted() ? 'Roll back now' : 'Watch a minute', box(out));
          if (A.alerted()) break;
          out = A.act('wait');
          minutes += 1;
          if (minutes > 14) break;
        }
        ui.phase('story');
        out = A.act('rollback');
        const failed = Math.round(A.world.failedTotal);
        const others = {};
        for (const k of ['rolling', 'bluegreen', 'canary']) others[k] = A.failedWith(k, replay);
        const label = { rolling: 'Rolling', bluegreen: 'Blue-green', canary: 'Canary' };
        await ui.say('ray', `Rolled back. Customers saw **${failed}** failed requests with ${label[kind].toLowerCase()}. The same bad release would have failed: ${Object.entries(others).map(([k, n]) => `**${label[k]}** ${n}`).join(', ')}. A canary only exposes a few customers, so it limits the damage.`, 'Next', box(out));
        await ui.card({
          maps: [['The workshop, the shop floor, the customers', 'dev, staging, prod'], ['A few servers at a time', 'rolling update'], ['Switch everyone at once', 'blue-green'], ['5% of customers first', 'canary'], ['Undo the release', 'rollback']],
          plain: 'A **rolling** update replaces a few servers at a time, **blue-green** switches all traffic at once, and a **canary** sends a small share of customers first. Watch the error rate and **roll back** when it climbs.',
          cmd: 'kubectl set image deployment/shop web=shop:v1.5.0\nkubectl rollout status deployment/shop\nkubectl rollout undo deployment/shop   # roll back a bad release',
        });
      },
    },
    {
      title: 'Gates and drift',
      hook: 'Another deploy day, with three traps: a release that staging would catch, a hot-fix made by hand in prod, and a change that drops a column.',
      learn: 'gates, keeping prod the same as git, and changing a database in steps you can undo.',
      async play({ ui, sim: A }) {
        A.load('gates-and-drift');
        A.caption('Gates stop a bad release before the customers. Each one only works if you use it.');
        await ui.say('ray', 'Another deploy day, and this time there are **gates**: a release must pass staging before it may reach the customers. Today\'s first release, **v1.7.0**, is the promo banner. Send it to staging.', 'Promote to staging');
        let out = A.act('promote');
        out = A.act('wait');
        await ui.say('ray', 'The staging smoke tests **failed**: the checkout returns an error. This is exactly what a gate is for.', 'Next', box(out));
        for (;;) {
          const pick = await ui.choose('ray', 'What do we do with v1.7.0?', [
            { label: 'Ship it to prod anyway: we are in a hurry', value: 'ship' },
            { label: 'Reject it at the gate', value: 'reject' },
          ]);
          if (pick === 'reject') break;
          const t = A.trial([['deploy', 'rolling'], ['wait']]);
          await ui.say('ray', `A gate only helps if a bad release **stops** at it. Here is what shipping it really does: delivery health falls to **${t.health}%** and customers see errors.`, 'Try again', box(t.out));
        }
        out = A.act('reject');
        await ui.say('ray', '**v1.7.0 never reaches the customers.** The next release is **v1.8.0**, order totals. Its notes say: "Migration 0042 **drops** the legacy_total column".', 'Next', box(out));
        for (;;) {
          const pick = await ui.choose('ray', 'The version running today still **reads that column**. How do we change the database?', [
            { label: 'Drop the column with this release', value: 'drop' },
            { label: 'Add the new column first, and drop the old one in a later release', value: 'expand' },
          ]);
          if (pick === 'expand') break;
          const t = A.trial([['promote'], ['wait'], ['commit'], ['deploy', 'canary'], ['wait']]);
          await ui.say('ray', 'The old version still reads **legacy_total**, so dropping it breaks it at once, and you cannot simply undo a dropped column. Here is what happens:', 'Try again', box(t.out));
        }
        out = A.act('expand');
        await ui.say('ray', 'That is the **expand** step: the new column is added and the old one stays, so both versions of the app keep working. The **contract** step (the drop) comes in a later release, once nothing reads the old column.', 'Next', box(out));
        await ui.say('ray', 'Now send v1.8.0 to staging.', 'Promote to staging');
        out = A.act('promote');
        out = A.act('wait');
        await ui.say('ray', '**An alarm**: four prod pods run an image that is **not in git**. Somebody fixed the checkout timeout by hand with a **kubectl** command at 2am. It works, but nobody wrote it down.', 'Next', box(out));
        for (;;) {
          const pick = await ui.choose('ray', 'What do we do about the hand-made fix?', [
            { label: 'Leave it: it works', value: 'leave' },
            { label: 'Commit it to git, so prod matches git again', value: 'commit' },
          ]);
          if (pick === 'commit') break;
          const t = A.trial([['deploy', 'canary']]);
          await ui.say('ray', 'The next deploy **overwrites** whatever is not in git. The hand-made fix would silently disappear and the checkout timeouts would come back:', 'Try again', box(t.out));
        }
        out = A.act('commit');
        await ui.say('ray', 'The fix is **in git** now, so prod and git agree. That is **drift** fixed: what runs in production is only ever what the repo says.', 'Next', box(out));
        for (;;) {
          const kind = await ui.choose('ray', 'v1.8.0 is ready for the customers. This release changes totals. How do we release it?', [
            { label: 'Rolling: replace every server in turn', value: 'rolling' },
            { label: 'Canary: 5% of customers first', value: 'canary' },
          ]);
          if (kind === 'canary') break;
          const t = A.trial([['deploy', kind], ['wait'], ['wait']]);
          await ui.say('ray', 'This release is a risky one, and a rolling update puts it in front of **more and more customers** before the alarm can ring. A small canary limits the damage.', 'Try again', box(t.out));
        }
        out = A.act('deploy', 'canary');
        ui.phase('watch');
        await ui.say('ray', 'The canary is out for **5%** of the customers. Watch the error rate.', 'Watch a minute', box(out));
        out = A.act('wait');
        await ui.say('ray', '**The alarm is ringing**: 30% of the new version\'s requests fail.', 'Roll back now', box(out));
        ui.phase('story');
        out = A.act('rollback');
        await ui.say('ray', 'Rolled back, after only a handful of failed requests. And because we **expanded** first, rolling back is safe: the old column is still there, so the old version works. If we had dropped it, there would have been no way back.', 'Next', box(out));
        await ui.card({
          maps: [['A gate before the customers', 'staging smoke tests, environment protection rules'], ['Stop the bad release at the gate', 'reject the release'], ['What the hand-fix left behind', 'drift: prod differs from git'], ['Add first, remove later', 'expand then contract'], ['5% of customers first', 'canary release']],
          plain: 'A **gate** only helps if a bad release stops at it. Keep prod the same as git by **committing every hand-fix**, and change a database in steps (**expand**, deploy, **contract**) so the last step can always be undone.',
          cmd: '-- release 1 (expand): add the new column, keep the old one\nALTER TABLE orders ADD COLUMN status_v2 text;\n-- release 2: write both columns, backfill, then read the new one\nUPDATE orders SET status_v2 = status WHERE status_v2 IS NULL;\n-- release 3 (contract): only after nothing reads the old column\nALTER TABLE orders DROP COLUMN status;',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/cicd/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const data = await res.json();
  mount(host, {
    id: 'cicd',
    title: 'The Assembly Line',
    stageLabel: 'The line',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      ray: { name: 'Ray', role: 'Line foreman', color: '#1a7a44' },
    },
    chapters: makeChapters(),
    createStage: (app) => createLine(app, data),
    startLabel: 'Start the line',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real CI/CD',
    endKicker: 'Shift complete',
    endTitle: 'You just ran a delivery pipeline',
    endIntro: 'Every factory word you used has a real name. Here is your notebook.',
    endLinks: [
      { text: 'Read: GitHub Actions basics', href: NOTE('01-github-actions-basics') },
      { text: 'Read: Deployment strategies', href: NOTE('03-deployment-strategies') },
      ...practiceLinks('cicd', [['fast-feedback', 'Fast feedback'], ['locked-down', 'Locked down'], ['deploy-day', 'Deploy day'], ['gates-and-drift', 'Gates and drift']]),
    ],
  });
}
