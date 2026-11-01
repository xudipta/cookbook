// Story mode, Terraform: "The Drift Detective".
//
// Terraform compares three worlds: the blueprint (the configuration), the ledger (the state) and the
// building (the real infrastructure). The detective story shows all three side by side and runs on the
// practice game's real simulator (docs/games/terraform/sim.js), so plan, apply, import and
// force-unlock print what the game prints. Each chapter is a plain async script over it (see ../shared/story.js).
import { h, outputBox, mountStory as mount, siteUrl } from '../shared/story.js';
import { computePlan, createWorld, evalValue, runCommand } from '../../games/terraform/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/terraform/notes/${name}/`);

const show = (v) => (v === undefined || v === null ? '—' : String(v));

// The case board: one row per resource, with its blueprint, ledger and building values side by side.
function createCaseBoard(app, { levels, schema }) {
  const ci = h('p', { class: 'td-ci', hidden: true });
  const rowsEl = h('ol', { class: 'td-rows', 'aria-label': 'Resources: what the blueprint, the ledger and the building say' });
  app.caption.before(ci, rowsEl);

  const T = { sc: null, world: null, rows: [], ledgerName: 'Ledger' };
  const ctx = { scenario: null, ticks: 0, fire() {}, resolve() {}, log() {}, step() {} };

  const env = () => T.world.envs[T.world.workspace];

  // The three values for one row (the building's object is found through the ledger, or by id for an unmanaged one).
  function worlds(row) {
    const w = T.world;
    const res = w.config.resources[row.addr];
    const blueprint = res ? evalValue(w, w.workspace, res.attrs[row.attr]) : undefined;
    const entry = env().state[row.addr];
    const ledger = entry ? entry.attrs[row.attr] : undefined;
    const real = env().real[entry ? entry.id : row.id];
    return { blueprint, ledger, building: real ? real.attrs[row.attr] : undefined };
  }

  function paint() {
    rowsEl.replaceChildren(...T.rows.map((row) => {
      const v = worlds(row);
      const same = v.blueprint === v.ledger && v.ledger === v.building;
      const cell = (name, value, off) => h('div', { class: `td-cell${off ? ' is-off' : ''}`, 'data-world': name },
        h('span', { class: 'td-world', text: name === 'ledger' ? T.ledgerName : name[0].toUpperCase() + name.slice(1) }),
        h('code', { class: 'td-value', text: `${off ? '≠ ' : ''}${show(value)}` }));
      return h('li', { class: `td-row ${same ? 'is-sync' : 'is-diff'}` },
        h('div', { class: 'td-name' }, h('code', { text: row.addr }), h('span', { class: 'td-attr', text: row.attr }), h('span', { class: 'td-status', text: same ? 'In sync' : 'Out of sync' })),
        h('div', { class: 'td-cells' },
          cell('blueprint', v.blueprint, false),
          cell('ledger', v.ledger, v.ledger !== v.blueprint),
          cell('building', v.building, v.building !== v.blueprint)));
    }));
    ci.hidden = !T.world.lock && !T.showCi;
    ci.textContent = `CI robot: ${T.world.ci}`;
    rowsEl.hidden = T.rows.length === 0;
  }

  Object.assign(T, {
    // A chapter starts from one of the game's levels.
    load(levelId, { rows, shared = false }) {
      const level = levels.find((l) => l.id === levelId);
      T.sc = { ...level, schema };
      T.world = createWorld(T.sc);
      ctx.scenario = T.sc;
      T.rows = rows;
      T.showCi = shared;
      T.ledgerName = shared ? 'Shared ledger' : 'Ledger';
      if (shared) { T.world.stateStore = 'remote'; T.world.initialized = true; }
      paint();
    },
    // Run a command in the simulator; returns what it printed (with the command echoed first).
    run(line) {
      const w = T.world;
      const before = w.term.length;
      runCommand(w, ctx, line);
      const out = w.term.slice(before).map((l) => l.text).join('\n').trim();
      paint();
      return out;
    },
    plan() { return computePlan(T.world); },
    paint,
    // Things that happen behind Terraform's back, as in the game's own events:
    setVar(name, value) { T.world.config.vars[name] = value; paint(); },
    setAttr(addr, attr, value) { T.world.config.resources[addr].attrs[attr] = value; paint(); },
    consoleEdit(addr, attr, value) {
      const entry = env().state[addr];
      env().real[entry.id].attrs[attr] = value;
      paint();
    },
    handMade({ addr, id, type, attrs, config }) {
      env().real[id] = { type, attrs: { ...attrs } };
      T.world.config.resources[addr] = { type, attrs: { ...config } };
      T.rows.push({ addr, attr: 'versioning', id });
      paint();
    },
    lock(info) {
      T.world.lock = info;
      T.world.ci = info.expires === null ? 'No pipeline running. The last run was cancelled (runner lost).' : `CI plan job running (${info.who}).`;
      paint();
    },
    unlock() {
      T.world.lock = null;
      T.world.ci = 'No pipeline running.';
      paint();
    },
    caption(text) { app.caption.textContent = text || ''; },
    reset() {
      T.sc = null;
      T.world = null;
      T.rows = [];
      T.showCi = false;
      rowsEl.replaceChildren();
      rowsEl.hidden = true;
      ci.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  return T;
}

// The output box under a line of story: the command, then the part of its output that matters (a plan opens with
// a legend and a preamble that the story does not need).
function lastCommandBox(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l, i) => i > 0 && /^(\s*# |Objects have changed|Terraform used the selected|No changes|Error:)/.test(l));
  const shown = at > 1 ? [lines[0], ...lines.slice(at)] : lines;
  const body = shown.join('\n').trim();
  return outputBox(body.length > 2400 ? `${body.slice(0, 2400)}\n...` : body);
}

function makeChapters() {
  return [
    {
      title: 'The blueprint and the building',
      hook: 'Chief Inspector Ada has a new recruit: you. Her first case is a building that has to match its blueprint.',
      learn: 'the three worlds Terraform compares, and what plan and apply do.',
      async play({ ui, sim: T }) {
        T.load('first-apply', { rows: [{ addr: 'local_file.greeting', attr: 'content' }] });
        T.caption('Dashes mean "does not exist yet".');
        await ui.say('ada', 'Every case has **three worlds**. The **blueprint** says what should exist. The **building** is what really exists. The **ledger** is Terraform\'s notebook of what it built.');
        await ui.say('ada', 'Right now the blueprint wants a greeting file, but the building is empty and the ledger has nothing. First, Terraform needs to get ready.', 'Run terraform init');
        let out = T.run('terraform init');
        await ui.say('ada', 'Ready. Now the detective compares all three worlds and writes a report. The report only **reads**: nothing changes yet.', 'Run terraform plan', lastCommandBox(out));
        out = T.run('terraform plan');
        await ui.say('ada', 'A **+** means "will be created". Nothing exists, so everything in the blueprint has to be built. The builder follows the report.', 'Run terraform apply', lastCommandBox(out));
        out = T.run('terraform apply -auto-approve');
        await ui.say('ada', 'Built! All three worlds agree now: the building exists and the ledger remembers it.', 'Next', lastCommandBox(out));

        T.setVar('greeting', 'hi from the team');
        await ui.say('ada', 'A teammate edits the **blueprint**: the greeting changes. Now the blueprint disagrees with the building and the ledger.');
        const guess = await ui.choose('ada', 'Before the detective writes the report: what will it say?', [
          { label: 'Create a new file', value: 'create' },
          { label: 'Update the file in place', value: 'update' },
          { label: 'Destroy the file', value: 'destroy' },
        ]);
        out = T.run('terraform plan');
        await ui.say('ada', `${guess === 'update' ? 'Right!' : 'Not quite.'} The file already exists, so the report says **~** : "update in place". Only the content changes.`, 'Run terraform apply', lastCommandBox(out));
        out = T.run('terraform apply -auto-approve');
        await ui.say('ada', 'Back in sync.', 'Next', lastCommandBox(out));

        T.consoleEdit('local_file.greeting', 'content', 'oops, edited by hand');
        const fix = await ui.choose('ada', 'Trouble. Someone edited the **building** by hand, behind the blueprint\'s back. The ledger still remembers the old greeting. What do we do?', [
          { label: 'Put the building back to match the blueprint', value: 'apply' },
          { label: 'Keep the hand edit: change the blueprint instead', value: 'keep' },
        ]);
        if (fix === 'apply') {
          out = T.run('terraform apply -auto-approve');
          await ui.say('ada', 'The blueprint wins: apply put the building back. Terraform noticed the hand edit because plan always looks at the real building first.', 'Next', lastCommandBox(out));
        } else {
          T.setVar('greeting', 'oops, edited by hand');
          out = T.run('terraform plan');
          await ui.say('ada', 'Also fine. If the building is right, fix the **blueprint**. The goal is always the same: after your change, the plan says "No changes".', 'Next', lastCommandBox(out));
        }
        await ui.card({
          maps: [['Blueprint', 'configuration (.tf)'], ['Ledger', 'state'], ['Building', 'real infrastructure'], ['The detective\'s report', 'terraform plan'], ['The builder', 'terraform apply']],
          plain: 'Terraform makes the **real infrastructure** match your **configuration**, and remembers what it built in the **state**. plan is a read-only report: **+** create, **~** update in place, **-** destroy.',
          cmd: 'terraform init\nterraform plan     # + create, ~ update in place, - destroy\nterraform apply    # make the real world match the configuration',
        });
      },
    },
    {
      title: 'The mystery edit',
      hook: 'Overnight, somebody changed the building. Nobody wrote it in the ledger.',
      learn: 'what drift is, how plan finds it, and how import adopts an object Terraform did not build.',
      async play({ ui, sim: T }) {
        T.load('drift', {
          rows: [
            { addr: 'aws_instance.web', attr: 'instance_type' },
            { addr: 'aws_s3_bucket.logs', attr: 'versioning' },
            { addr: 'aws_db_instance.main', attr: 'identifier' },
          ],
        });
        T.caption('A sign (≠) marks a world that disagrees with the blueprint.');
        await ui.say('ada', 'Yesterday every world agreed: a web server, a log bucket and a database. This morning, something is off.');
        T.consoleEdit('aws_instance.web', 'instance_type', 't3.large');
        const guess = await ui.choose('ada', 'The web server was resized in the cloud console. Nobody touched the blueprint. Will the detective notice?', [
          { label: 'No: it only reads the blueprint', value: 'no' },
          { label: 'Yes: plan looks at the building first', value: 'yes' },
        ]);
        let out = T.run('terraform plan');
        await ui.say('ada', `${guess === 'yes' ? 'Right!' : 'It does!'} Before comparing, plan **refreshes** the ledger from the real building, so it sees the change. That is **drift**: the building moved away from the blueprint.`, 'Run terraform apply', lastCommandBox(out));
        out = T.run('terraform apply -auto-approve');
        await ui.say('ada', 'The builder put the server back to what the blueprint says.', 'Next', lastCommandBox(out));

        T.handMade({ addr: 'aws_s3_bucket.assets', id: 'acme-assets', type: 'aws_s3_bucket', attrs: { bucket: 'acme-assets', versioning: 'Disabled' }, config: { bucket: 'acme-assets', versioning: 'Enabled' } });
        for (;;) {
          const pick = await ui.choose('ada', 'Someone built a storage bucket **by hand**, then wrote it into the blueprint. The building already has it, but the ledger has never heard of it. What now?', [
            { label: 'Apply anyway and let the builder create it', value: 'apply' },
            { label: 'Import the existing bucket into the ledger', value: 'import' },
          ]);
          if (pick === 'import') break;
          out = T.run('terraform apply -auto-approve');
          await ui.say('ada', 'The builder tried to create a bucket that is already there, and the cloud said no. The ledger has to **adopt** the bucket first.', 'Try again', lastCommandBox(out));
        }
        out = T.run('terraform import aws_s3_bucket.assets acme-assets');
        await ui.say('ada', 'The ledger now knows the bucket. The plan will show how it differs from the blueprint.', 'Run terraform plan', lastCommandBox(out));
        out = T.run('terraform plan');
        await ui.say('ada', 'Versioning is off in the building but on in the blueprint. That is a small **~** update, not a rebuild.', 'Run terraform apply', lastCommandBox(out));
        out = T.run('terraform apply -auto-approve');
        await ui.say('ada', 'Adopted and fixed.', 'Next', lastCommandBox(out));

        T.setAttr('aws_db_instance.main', 'identifier', 'orders-db-v2');
        const rename = await ui.choose('ada', 'A teammate renames the database in the blueprint. Just one word. What will the plan do?', [
          { label: 'It renames the database in place', value: 'rename' },
          { label: 'It destroys the old one and builds a new one', value: 'replace' },
          { label: 'Nothing: names are only labels', value: 'nothing' },
        ]);
        out = T.run('terraform plan');
        await ui.say('ada', `${rename === 'replace' ? 'Right.' : 'Look closer.'} The report says **-/+** and "forces replacement": the old database, **and its data**, would be deleted. Reading the plan before you apply is the whole point.`, 'Next', lastCommandBox(out));
        for (;;) {
          const stop = await ui.choose('ada', 'Do we apply it?', [
            { label: 'Apply it anyway', value: 'apply' },
            { label: 'Undo the rename in the blueprint', value: 'undo' },
          ]);
          if (stop === 'undo') break;
          await ui.say('ada', 'Stop! The plan said "forces replacement". Applying would delete the orders database. Think again.', 'Back');
        }
        T.setAttr('aws_db_instance.main', 'identifier', 'orders-db');
        await ui.card({
          maps: [['The building moved on its own', 'drift'], ['Detective checks the building first', 'refresh (plan)'], ['Adopt an object that already exists', 'terraform import'], ['Destroy and rebuild', '-/+ forces replacement']],
          plain: 'Every plan first **refreshes** the state from the real world, so drift shows up as a change. An object Terraform did not build must be **imported** before it can be managed. Always read the plan for **-/+**.',
          cmd: 'terraform plan                                       # refreshes, then diffs\nterraform import aws_s3_bucket.assets acme-assets   # adopt an existing object\n# -/+ "forces replacement" means destroy, then create',
        });
      },
    },
    {
      title: 'Two detectives, one ledger',
      hook: 'The agency grows. Now several people, and a CI robot, all work from the same ledger.',
      learn: 'remote state, the state lock, and when force-unlock is safe.',
      async play({ ui, sim: T }) {
        T.load('team', {
          shared: true,
          rows: [
            { addr: 'aws_instance.web', attr: 'instance_type' },
            { addr: 'aws_s3_bucket.logs', attr: 'versioning' },
          ],
        });
        await ui.say('ada', 'Until now the ledger lived on one laptop. A team keeps it in a shared place, a **remote backend**, so everyone reads the same notebook.');
        await ui.say('ada', 'Two people writing to one ledger at once would corrupt it. So whoever is working takes a **lock**. The board shows what the CI robot is doing.');

        T.lock({ id: '6a4e2f1c-9b1d-4c33-8f0a-2d5e7b9c1a10', who: 'ci-runner@nightly-plan', op: 'OperationTypePlan', day: 1, expires: 99 });
        let out = '';
        await ui.say('ada', 'The nightly robot is running a plan right now. You try to run your own.', 'Run terraform plan');
        out = T.run('terraform plan');
        for (;;) {
          const pick = await ui.choose('ada', 'The ledger is **locked** by a job that is still running. What do you do?', [
            { label: 'Force-unlock it right now', value: 'force' },
            { label: 'Wait for the robot to finish', value: 'wait' },
          ], lastCommandBox(out));
          if (pick === 'wait') break;
          await ui.say('ada', 'No! The CI board says the job is **running**. Breaking its lock lets two writers corrupt the ledger. Never unlock a lock that someone is using.', 'Back');
        }
        T.unlock();
        out = T.run('terraform plan');
        await ui.say('ada', 'The robot finished and released the lock, and your plan runs. Locks protect the ledger. Waiting is cheap.', 'Next', lastCommandBox(out));

        T.lock({ id: 'b81c0d52-7e44-4a0f-9d3b-5c2a8e6f1b77', who: 'ci-runner@deploy-812', op: 'OperationTypeApply', day: 1, expires: null });
        await ui.say('ada', 'Another morning. The robot crashed halfway through an apply and its machine is gone. You try a plan.', 'Run terraform plan');
        out = T.run('terraform plan');
        for (;;) {
          const pick = await ui.choose('ada', 'The ledger is locked again, but look at the CI board: no pipeline is running. The lock is **stale**. What do you do?', [
            { label: 'Keep waiting for it', value: 'wait' },
            { label: 'Check the CI, then force-unlock', value: 'force' },
          ], lastCommandBox(out));
          if (pick === 'force') break;
          await ui.say('ada', 'Nobody is coming back: the runner is gone, so the lock will never release itself. Once you are sure nothing is running, you break it.', 'Back');
        }
        out = T.run('terraform force-unlock b81c0d52-7e44-4a0f-9d3b-5c2a8e6f1b77');
        await ui.say('ada', 'Unlocked. Now your plan can run.', 'Run terraform plan', lastCommandBox(out));
        out = T.run('terraform plan');
        await ui.say('ada', 'The ledger is free again, and the three worlds still agree.', 'Next', lastCommandBox(out));
        await ui.card({
          maps: [['Shared ledger', 'remote backend'], ['A reservation on the ledger', 'state lock'], ['Break a dead reservation', 'terraform force-unlock']],
          plain: 'A team keeps the **state** in a **remote backend** that supports **locking**. While one run holds the lock, others wait. Use force-unlock only for a **stale** lock, after you checked that nothing is running.',
          cmd: 'terraform {\n  backend "s3" {\n    bucket         = "acme-tfstate"\n    key            = "prod/terraform.tfstate"\n    dynamodb_table = "tf-locks"\n  }\n}\n\nterraform force-unlock LOCK_ID   # only if the lock is stale',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/terraform/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const data = await res.json();
  mount(host, {
    id: 'terraform',
    title: 'The Drift Detective',
    stageLabel: 'The case board',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      ada: { name: 'Ada', role: 'Chief Inspector', color: '#6d3bb5' },
    },
    chapters: makeChapters(),
    createStage: (app) => createCaseBoard(app, data),
    startLabel: 'Open the case',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real Terraform',
    endKicker: 'Case closed',
    endTitle: 'You just ran Terraform',
    endIntro: 'Every detective word you used has a real name. Here is your notebook.',
    endLinks: [
      { text: 'Read: Core workflow', href: NOTE('01-core-workflow') },
      { text: 'Read: State and workspaces', href: NOTE('03-state-and-workspaces') },
      { text: 'Play the real Terraform game', href: new URL('terraform/', HUB).href },
    ],
  });
}
