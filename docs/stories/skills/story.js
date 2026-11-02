// Story mode, Agent Skills: "The New Hire".
//
// An assistant with a small desk and a binder of recipe cards. A skill is a card: the title is the description,
// the body is the card itself, and the appendix drawer holds bundled files. The desk is the context window: only
// what is on it counts, and the assistant picks a card by reading the titles. The story runs on the practice game's
// real simulator (docs/games/skills/sim.js): a request queue is replayed against the card the learner built, the
// agent's pick is scored from the words in the descriptions, and the card is checked by the same lint the game uses.
// Each chapter is a plain async script over it (see ../shared/story.js).
import { h, createCounters, outputBox, mountStory as mount, siteUrl } from '../shared/story.js';
import { createWorld, footprint, isClean, place, setDir, setLocation, saveText, skillStatus, tick } from '../../games/skills/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/skills/notes/${name}/`);
const box = (text) => outputBox(text);
const clone = (o) => JSON.parse(JSON.stringify(o));

// The segments of the desk, in the order they are loaded.
const SEGMENTS = [
  ['base', 'Instructions'],
  ['meta', 'Card titles'],
  ['body', 'Card'],
  ['bundled', 'Appendix'],
];

// The desk and the queue: how full the desk is for the heaviest request, and how each request would go.
function createDesk(app, { data }) {
  const desk = h('div', { class: 'sk-desk', hidden: true });
  const deskText = h('p', { class: 'sk-desk-text', hidden: true });
  const queue = h('ol', { class: 'sk-queue', 'aria-label': 'The queue of requests', hidden: true });
  const counters = createCounters([{ label: 'Answered', cls: 'ks-hud-ok' }]);
  app.caption.before(desk, deskText, queue, counters.el);

  const A = { world: null, sc: null, showQueue: false };

  const stepper = (w) => {
    const ctx = { ticks: 0, fire() {}, resolve() {}, log() {}, step() {}, rng: () => 0.5, scenario: A.sc };
    ctx.step = () => { ctx.ticks += 1; tick(w, ctx); };
    return ctx;
  };

  // A scratch copy of the live world, run through the whole queue.
  function scratch(mutate) {
    const w = createWorld(A.sc);
    if (A.world.mode === 'layers') w.layers = { ...A.world.layers };
    else w.skill = clone(A.world.skill);
    if (mutate) mutate(w);
    const ctx = stepper(w);
    while (w.cursor < w.requests.length) ctx.step();
    return w;
  }

  const lineOf = (r) => {
    const sk = r.req.text;
    if (r.ok) return `✓ ${r.index + 1}. ${sk} → ${r.pick || 'answered directly'}`;
    return `✗ ${r.index + 1}. ${sk} → ${r.message}`;
  };
  A.lines = (w) => w.results.map(lineOf).join('\n');

  function paint() {
    const w = A.world;
    if (!w) return;
    if (!A.showQueue) {
      desk.hidden = true;
      deskText.hidden = true;
      queue.hidden = true;
      counters.el.hidden = true;
      return;
    }
    const s = scratch();
    const heavy = s.results.reduce((a, r) => (r.total > a.total ? r : a), s.results[0]);
    const win = Math.max(...s.results.map((r) => r.window));
    const used = heavy.total;
    const over = used > heavy.window;
    desk.hidden = false;
    desk.setAttribute('role', 'img');
    desk.setAttribute('aria-label', `The desk for the heaviest request: ${used} of ${heavy.window} tokens${over ? ', too many' : ''}. ${SEGMENTS.map(([k, label]) => `${label} ${heavy.loads[k]}`).join(', ')}.`);
    desk.classList.toggle('is-over', over);
    desk.replaceChildren(
      ...SEGMENTS.filter(([k]) => heavy.loads[k] > 0).map(([k, label]) =>
        h('span', { class: `sk-seg sk-seg-${k}`, style: `flex-grow:${heavy.loads[k]}`, text: `${label} ${heavy.loads[k]}` })),
      h('span', { class: 'sk-free', style: `flex-grow:${Math.max(0, win - used)}` }),
    );
    deskText.hidden = false;
    deskText.textContent = `The desk holds ${heavy.window} tokens. The heaviest request needs ${used}${over ? ': too many' : ''}.`;
    queue.hidden = false;
    queue.replaceChildren(
      ...s.results.map((r) => h('li', { class: 'sk-req', 'data-ok': r.ok ? 'yes' : 'no' }, h('span', { class: 'sk-mark', text: r.ok ? '✓' : '✗' }), h('span', { text: r.req.text }))),
    );
    counters.el.hidden = false;
    const okN = s.results.filter((r) => r.ok).length;
    counters.values[0].textContent = `${okN}/${s.results.length}`;
    counters.el.children[0].className = okN === s.results.length ? 'ks-hud-ok' : 'ks-hud-bad';
  }

  Object.assign(A, {
    load(levelId) {
      const level = data.levels.find((l) => l.id === levelId);
      const { levels: _levels, ...rest } = data;
      A.sc = { ...rest, ...level };
      A.world = createWorld(A.sc);
      A.showQueue = false;
      paint();
    },
    show() {
      A.showQueue = true;
      paint();
    },
    // Moves on the live card.
    place(id, layer) { place(A.world, id, layer); paint(); },
    text(next) { saveText(A.world, next); paint(); },
    dir(name) { setDir(A.world, name); paint(); },
    location(where) { setLocation(A.world, where); paint(); },
    // The whole queue on a scratch copy, with an optional change applied first.
    trial(mutate) {
      const w = scratch(mutate);
      return { world: w, out: A.lines(w), ok: w.results.every((r) => r.ok), status: skillStatus(w) };
    },
    status() { return skillStatus(A.world); },
    run() {
      const w = scratch();
      return { world: w, out: A.lines(w), ok: w.results.every((r) => r.ok) };
    },
    clean: () => isClean(A.world),
    footprint: () => footprint(A.world),
    caption(text) { app.caption.textContent = text || ''; },
    reset() {
      A.world = null;
      A.sc = null;
      A.showQueue = false;
      desk.hidden = true;
      deskText.hidden = true;
      queue.hidden = true;
      queue.replaceChildren();
      counters.el.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  return A;
}

// The words that decided a pick, as one line: "release-notes 4 (changed, since); docs-helper 2 (changed)".
const scoreLine = (r) => r.scores.filter((s) => s.score > 0).map((s) => `${s.name} ${s.score} (${s.matches.map((m) => m.word).join(', ')})`).join('; ') || 'no card matched any word';

function whyText(w, indexes) {
  return indexes.map((i) => {
    const r = w.results[i];
    return `${r.ok ? '✓' : '✗'} "${r.req.text}"\n   picked: ${r.pick || 'none'}. Scores: ${scoreLine(r)}`;
  }).join('\n');
}

const DESC = {
  vague: 'Helps with notes.',
  stuffed: 'Helps with documentation, docs, changelogs, release notes, README files, notes, guides, pull requests, markdown, writing and editing. Use when the user asks about docs, notes, changelogs, writing, documentation, guides or pull requests.',
  specific: 'Generate release notes from merged pull requests since the last git tag. Use when the user asks for a changelog, release notes, or "what changed since <version>".',
};
const withDescription = (w, desc) => saveText(w, w.skill.text.replace(/^description: .*$/m, `description: ${JSON.stringify(desc)}`));
const withFoldedDescription = (w, desc) => saveText(w, w.skill.text.replace(/^description: [\s\S]*?\nallowed-tools:/m, `description: >-\n  ${desc}\nallowed-tools:`));

// One decision. A wrong pick is applied to a scratch copy, the queue is replayed and the real result is shown.
async function decide(ui, A, ask, options, after) {
  for (;;) {
    const picked = await ui.choose('sam', ask, options.map((o) => ({ label: o.label, value: o.label })));
    const opt = options.find((o) => o.label === picked);
    if (opt.right) {
      opt.apply();
      await ui.say('sam', after, 'Next', opt.show ? box(opt.show()) : null);
      return;
    }
    const t = opt.trial ? A.trial(opt.trial) : null;
    const extra = t && opt.show ? box(opt.show(t)) : null;
    await ui.say('sam', typeof opt.why === 'function' ? opt.why(t) : opt.why, 'Try again', extra);
  }
}

function makeChapters() {
  return [
    {
      title: 'A small desk',
      hook: 'Sam is the new hire. The desk is small, the binder is big, and only what is on the desk counts.',
      learn: 'what goes on the title, in the card and in the appendix, and why.',
      async play({ ui, sim: A }) {
        A.load('disclosure');
        A.caption('The desk is the context window. Everything the assistant reads must fit on it.');
        await ui.say('sam', 'Hi, I am Sam, the assistant. I keep a **binder of recipe cards**: each one is a **skill**. A card has a **title** (the description), the **card** itself (the body), and an **appendix drawer** (bundled files). My **desk** is small: it is my **context window**, and only what is on it counts.');
        await ui.say('sam', 'Here is the card for writing **release notes**. Someone pasted everything onto it: the steps, a 60-line script, a label table and a full sample changelog. Watch what happens to today\'s seven requests.', 'Run the queue');
        A.show();
        const first = A.run();
        await ui.say('sam', 'The first requests were fine, but the moment the desk shrank to 1900 tokens, **every release-notes request overflowed**. A skill is loaded **in layers**: the titles are always on the desk, the card only when I pick it, and an appendix file only when it is needed.', 'Next', box(first.out));
        const layers = [
          {
            id: 'steps',
            ask: 'The **five steps** are the recipe itself. Where do they go?',
            options: [
              { label: 'On the card (the body)', layer: 'body', right: true },
              { label: 'In the appendix drawer', layer: 'bundled', why: (t) => `Then the card has nothing in it: I picked it and found no procedure. The real result:` },
              { label: 'On the title (always on the desk)', layer: 'frontmatter', why: () => 'The title is read for **every** request, so putting the steps there makes every request heavier, and a frontmatter that is not a short name and description is rejected by the lint. The real result:' },
            ],
            after: 'The steps stay on the card: loaded **when I pick it**.',
          },
          {
            id: 'script',
            ask: 'The **60-line collection script** is needed for every release-notes request, but it is long. Where does it go?',
            options: [
              { label: 'Keep it on the card', layer: 'body', why: () => 'It is needed, but it makes the card heavy every time, and when the script breaks the pasted copy is the one that breaks. The real result:' },
              { label: 'In the appendix, with a pointer on the card', layer: 'bundled', right: true },
            ],
            after: 'A one-line **pointer** on the card (Run scripts/collect_prs.sh) and the file in the appendix: I read it **only when I run it**, and a fix has one place to go.',
          },
          {
            id: 'labels',
            ask: 'The **label-to-section table** matters only when someone asks how PRs are grouped. Where?',
            options: [
              { label: 'Keep it on the card', layer: 'body', why: () => 'It is on the desk for every request, including the ones that never need it. The real result:' },
              { label: 'In the appendix, with a pointer', layer: 'bundled', right: true },
            ],
            after: 'Appendix: 300 tokens that were on the desk for every request are now read only when asked.',
          },
          {
            id: 'example',
            ask: 'The **full sample changelog** is only for "same format as last time". Where?',
            options: [
              { label: 'Keep it on the card', layer: 'body', why: (t) => { const top = t.world.results.reduce((a, r) => (r.total > a.total ? r : a)); return `It still fits today, but only just: the heaviest request needs ${top.total} of ${top.window} tokens, and this 500-token sample is on the desk for every release-notes request. One more paste and it overflows. The real result:`; } },
              { label: 'In the appendix, with a pointer', layer: 'bundled', right: true },
            ],
            after: 'Done.',
          },
        ];
        for (const q of layers) {
          await decide(ui, A, q.ask, q.options.map((o) => ({
            label: o.label,
            right: o.right,
            apply: () => A.place(q.id, o.layer),
            trial: (w) => place(w, q.id, o.layer),
            why: o.why,
            show: o.right ? () => A.run().out : (t) => t.out,
          })), q.after);
        }
        const end = A.run();
        await ui.say('sam', `Now all seven requests work, and the **titles** that are always on the desk cost only about **${A.footprint()} tokens**. This is **progressive disclosure**: the title decides, the card guides and the appendix is read on demand.`, 'Next', box(end.out));
        await ui.card({
          maps: [['The desk', 'the context window'], ['The title on the card', 'frontmatter: name and description'], ['The card', 'the SKILL.md body'], ['The appendix drawer', 'bundled files (scripts/, reference.md)'], ['Only what is needed, when needed', 'progressive disclosure']],
          plain: 'A skill loads in **layers**: the **name and description** are always in context, the **body** loads when the agent picks the skill, and a **bundled file** loads only when the body points at it.',
          cmd: '---\nname: release-notes\ndescription: Generate release notes from merged pull requests... Use when the user asks for a changelog.\n---\n# Release notes\n1. Run `scripts/collect_prs.sh [<since-tag>]`\n2. Read `reference.md` for how labels map to sections.',
        });
      },
    },
    {
      title: 'The title on the card',
      hook: 'Sam answers every request by reading only the titles. A vague title never gets picked and a stuffed title steals other requests.',
      learn: 'how to write a description that triggers when it should.',
      async play({ ui, sim: A }) {
        A.load('descriptions');
        A.caption('Sam scores each title against the request: a word from "Use when" is worth 2, other words 1.');
        await ui.say('sam', 'I choose a card by reading **only the titles**, never the card. Right now this card\'s title says "**Helps with notes.**" A new card, **docs-helper**, will join the shelf later today. Let us see how the title does.', 'Run the queue');
        A.show();
        const base = A.run();
        await ui.say('sam', 'The vague title won two requests and lost two: **docs-helper** took "What changed since v2.2?" and "Draft a changelog" because its title mentions changelogs. Each word of a request earns points on a title.', 'Next', box(`${base.out}\n\n${whyText(base.world, [2, 3])}`));
        await decide(ui, A, 'Which title should the card have?', [
          { label: 'Helps with notes.', trial: () => {}, why: () => 'That is the title you started with. Too vague: it matches almost nothing, so another card wins:', show: (t) => `${t.out}\n\n${whyText(t.world, [2, 3])}` },
          { label: 'A title with every word: docs, notes, changelogs, writing, guides...', trial: (w) => withDescription(w, DESC.stuffed), why: () => 'A stuffed title steals requests that are not its job: it now answers "Write a poem about spring", and still loses one changelog request to the other card.', show: (t) => `${t.out}\n\n${whyText(t.world, [2, 4])}` },
          { label: 'What it does, then "Use when" the user asks for it', apply: () => withDescription(A.world, DESC.specific), right: true, show: () => { const r = A.run(); return `${r.out}\n\n${whyText(r.world, [2, 3])}`; } },
        ], 'The specific title wins: it says **what** it does (release notes from merged pull requests) and **when** to use it, with the words people actually say ("changelog", "what changed since"). Words in the "Use when" clause score double.');
        await ui.say('sam', 'One request deserves a note: "**Whenever I commit, run the linter**". No card should answer that. Something that must happen **every time** on an event is not a recipe a model may follow, it is a **hook**. Skills are advice; hooks are enforced. We come back to this in the last chapter.', 'Next');
        const last = A.run();
        await ui.say('sam', `All seven requests go the right way, and the other card did not steal one. Health stays at **${last.world.health}%**.`, 'Next', box(last.out));
        await ui.card({
          maps: [['The title on the card', 'description'], ['What it does', 'the first sentence'], ['When to pick it', '"Use when the user asks for..."'], ['Words people really say', 'changelog, what changed since...'], ['A title with every word', 'steals other requests']],
          plain: 'Write a **specific** description: say **what** the skill does and **when** to use it, in the words a user would say. A vague one never triggers; a keyword-stuffed one steals requests from other skills. (Sam is a simple stand-in that counts matching words; a real model reads more cleverly, but the advice is the same.)',
          cmd: '---\nname: release-notes\ndescription: >-\n  Generate release notes from merged pull requests since the last git tag. Use when the user\n  asks for a changelog, release notes, or "what changed since <version>".\n---',
        });
      },
    },
    {
      title: 'Ship it',
      hook: 'The card is written. Before it goes in the binder, it must pass the lint gate and be safe to hand out.',
      learn: 'the lint rules, where a skill must live, and a short list of allowed tools.',
      async play({ ui, sim: A }) {
        A.load('ship-it');
        A.caption('The agent only sees a card that passes the lint gate and sits in a folder it scans.');
        await ui.say('sam', 'This card is ready to ship: the description is good (too good, as you will see), but **nothing has been checked**. Let us see what happens to the queue as it is.', 'Run the queue');
        A.show();
        const base = A.run();
        await ui.say('sam', 'I could not even load the card: the **lint gate rejected it**. Let us read what the gate says.', 'Show the lint report', box(base.out));
        const errs0 = A.status().errors;
        await ui.say('sam', `The gate says: **${errs0[0]}**. The description is a very long single line with a colon in it ("Steps: run..."), which breaks the front matter. It is also far too long to be a title.`, 'Next', box(errs0.map((e) => `lint: ${e}`).join('\n')));
        await decide(ui, A, 'What should the description be?', [
          { label: 'Keep it as it is, it explains everything', trial: () => {}, why: () => 'It cannot be read at all: the front matter is not valid YAML. The real lint report:', show: (t) => t.status.errors.map((e) => `lint: ${e}`).join('\n') },
          { label: 'Make it even longer so nothing is missed', trial: (w) => withFoldedDescription(w, `${DESC.specific} ${'Also handles many other things, in a lot of detail. '.repeat(20)}`), why: () => 'The title is read for **every** request, so a long one is heavy, and the gate caps it at 1024 characters. The real lint report:', show: (t) => t.status.errors.map((e) => `lint: ${e}`).join('\n') },
          { label: 'Cut it to what it does and when to use it', apply: () => withFoldedDescription(A.world, DESC.specific), right: true, show: () => A.status().errors.map((e) => `lint: ${e}`).join('\n') || 'lint: no errors in the description' },
        ], 'Short and specific. The steps stay in the body, where they are loaded only when the card is picked. The name still has problems.');
        await decide(ui, A, 'The name and folder: how should they be spelled?', [
          { label: 'Name Release_Notes, folder ReleaseNotes', trial: () => {}, why: () => 'Names are **lowercase kebab-case**, and the name must match the folder. The real lint report:', show: (t) => t.status.errors.map((e) => `lint: ${e}`).join('\n') },
          { label: 'Name release-notes, folder ReleaseNotes', trial: (w) => saveText(w, w.skill.text.replace(/^name: .*$/m, 'name: release-notes')), why: () => 'The name is right but it must match the folder name exactly. The real lint report:', show: (t) => t.status.errors.map((e) => `lint: ${e}`).join('\n') },
          { label: 'Both release-notes', apply: () => { A.text(A.world.skill.text.replace(/^name: .*$/m, 'name: release-notes')); A.dir('release-notes'); }, right: true, show: () => `lint: ${A.status().errors.length ? A.status().errors.join('; ') : 'no errors'}` },
        ], 'Both are **release-notes**: lowercase kebab-case, the same as the folder. The gate passes.');
        await decide(ui, A, 'Where does the folder live? Sam only scans certain places.', [
          { label: 'In skills/ at the top of the project', trial: () => {}, why: () => 'That is a folder Sam does not scan, so the card is never found:', show: (t) => t.out },
          { label: 'In docs/skills/', trial: (w) => setLocation(w, 'docs/skills'), why: () => 'Also not a place Sam scans:', show: (t) => t.out },
          { label: 'In .claude/skills/', apply: () => A.location('.claude/skills'), right: true, show: () => A.run().out },
        ], '**.claude/skills/** (in the project) or **~/.claude/skills/** (personal) are the folders Sam scans. Now the card is found.');
        await ui.say('sam', 'One request was still wrong, the fourth: "Draft the release notes, then **write them straight into CHANGELOG.md without asking**". The card does what it is asked.', 'Next');
        await decide(ui, A, 'What may this card be allowed to do?', [
          { label: 'Everything it asks for (Bash, Read, Write, Edit, Grep)', trial: () => {}, why: () => 'With **Write** and **Edit** allowed, the skill wrote to CHANGELOG.md without asking, outside its job:', show: (t) => t.out },
          { label: 'No list, so any tool', trial: (w) => saveText(w, w.skill.text.replace(/^allowed-tools: .*\n/m, '')), why: () => 'With no list at all, the skill can use **any** tool:', show: (t) => t.out },
          { label: 'Only Bash', trial: (w) => saveText(w, w.skill.text.replace(/^allowed-tools: .*$/m, 'allowed-tools: [Bash]')), why: () => 'Too tight: the skill needs to **read** files too, so it could not do its job:', show: (t) => t.out },
          { label: 'Only Bash and Read', apply: () => A.text(A.world.skill.text.replace(/^allowed-tools: .*$/m, 'allowed-tools: [Bash, Read]')), right: true, show: () => A.run().out },
        ], '**allowed-tools: [Bash, Read]**: the skill can collect and read, and it was **stopped at the write**. Draft first, ask before writing.');
        const end = A.run();
        await ui.say('sam', 'Every request goes the right way, and the card is safe to hand out. The same lint rules run in CI as scripts/check_skill.py.', 'Next', box(end.out));
        await ui.card({
          maps: [['Lowercase kebab-case, same as the folder', 'name: release-notes'], ['A short title, at most 1024 characters', 'description'], ['Folders Sam scans', '.claude/skills/ or ~/.claude/skills/'], ['A short list of tools', 'allowed-tools: [Bash, Read]']],
          plain: 'A skill must pass the **lint gate** (kebab-case name that matches the folder, valid frontmatter, a description of at most 1024 characters), sit in a folder the agent scans, and list only the **allowed-tools** it needs.',
          cmd: 'python scripts/check_skill.py .claude/skills/*/SKILL.md\n\n---\nname: release-notes\ndescription: Generate release notes... Use when...\nallowed-tools: [Bash, Read]\n---',
        });
      },
    },
    {
      title: 'Skill or something else?',
      hook: 'Not every job is a skill. Four small jobs, and four mechanisms to pick from.',
      learn: 'when a skill, a hook, an MCP server or a subagent is the right tool.',
      async play({ ui }) {
        await ui.say('sam', 'Last lesson: a skill is **advice** Sam may follow. Other tools do other jobs. A **skill** is a procedure for a kind of task. A **hook** runs every time on an event. An **MCP server** adds tools and data sources. A **subagent** is someone else with a fresh desk.', 'Four jobs');
        const jobs = [
          {
            ask: 'Job 1: **run the formatter every time the agent edits a file**, with no exceptions.',
            options: [
              { label: 'A skill for the formatter', why: 'A skill is advice. Sam may or may not follow it, and "every time, no exceptions" needs the opposite.' },
              { label: 'A hook for the formatter', right: true },
              { label: 'An MCP server for the formatter', why: 'An MCP server adds tools or data. It does not run something on an event.' },
              { label: 'A subagent for the formatter', why: 'A subagent works on a task in a fresh context. It does not guarantee anything on every edit.' },
            ],
            after: 'A **hook**: the harness runs it on the event, not the model. "Whenever X happens, do Y" is a hook.',
          },
          {
            ask: 'Job 2: **follow our release-notes procedure** whenever someone asks for a changelog.',
            options: [
              { label: 'A skill for the release notes', right: true },
              { label: 'A hook for the release notes', why: 'There is no event to hook onto. The trigger is a kind of request, and it needs judgement.' },
              { label: 'An MCP server for the release notes', why: 'The procedure is knowledge, not a new tool or data source.' },
              { label: 'A subagent for the release notes', why: 'The procedure should be followed by Sam, not handed away.' },
            ],
            after: 'A **skill**: a procedure for a **kind of task**, found by its description.',
          },
          {
            ask: 'Job 3: **let the agent read and update tickets** in our issue tracker.',
            options: [
              { label: 'A skill for the tickets', why: 'A skill can describe how to use a tracker, but it cannot give Sam access to one.' },
              { label: 'A hook for the tickets', why: 'Nothing here happens on an event.' },
              { label: 'An MCP server for the tickets', right: true },
              { label: 'A subagent for the tickets', why: 'A subagent still needs the tools to reach the tracker.' },
            ],
            after: 'An **MCP server**: it adds **tools and data sources**. A skill can then explain how to use them well.',
          },
          {
            ask: 'Job 4: **read 200 files to find where a bug lives**, without filling Sam\'s desk.',
            options: [
              { label: 'A skill for the bug hunt', why: 'A skill would load more onto the same desk. The problem is the size of the work.' },
              { label: 'A hook for the bug hunt', why: 'Nothing here happens on an event.' },
              { label: 'An MCP server for the bug hunt', why: 'That adds a tool, but the 200 files would still fill the desk.' },
              { label: 'A subagent for the bug hunt', right: true },
            ],
            after: 'A **subagent**: it works on a fresh desk and reports back only a short answer.',
          },
        ];
        for (const j of jobs) {
          for (;;) {
            const picked = await ui.choose('sam', j.ask, j.options.map((o) => ({ label: o.label, value: o.label })));
            const opt = j.options.find((o) => o.label === picked);
            if (opt.right) break;
            await ui.say('sam', opt.why, 'Try again');
          }
          await ui.say('sam', j.after, 'Next');
        }
        await ui.card({
          maps: [['Advice for a kind of task', 'Skill (SKILL.md)'], ['Must run every time on an event', 'Hook (settings.json)'], ['New tools and data sources', 'MCP server (.mcp.json)'], ['Work on a fresh desk', 'Subagent (.claude/agents/)']],
          plain: 'A **skill** is advisory. If it must happen **every time**, use a **hook**. Use an **MCP server** to add tools and data, and a **subagent** to keep a big job off the main context.',
          cmd: '.claude/skills/<name>/SKILL.md   # a procedure, picked by its description\nsettings.json                    # hooks: enforced on an event\n.mcp.json                        # MCP servers\n.claude/agents/<name>.md         # subagents',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/skills/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const data = await res.json();
  mount(host, {
    id: 'skills',
    title: 'The New Hire',
    stageLabel: 'The desk',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      sam: { name: 'Sam', role: 'New hire with a binder', color: '#3b4a9c' },
    },
    chapters: makeChapters(),
    createStage: (app) => createDesk(app, { data }),
    startLabel: 'Meet Sam',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real Agent Skills',
    endKicker: 'Binder complete',
    endTitle: 'You just taught an agent to use a skill',
    endIntro: 'Every desk and binder word you used has a real term. Here is your notebook.',
    endLinks: [
      { text: 'Read: What are Agent Skills', href: NOTE('01-what-are-agent-skills') },
      { text: 'Read: Authoring a skill', href: NOTE('02-authoring-skills') },
      { text: 'Play the real skills game', href: new URL('skills/', HUB).href },
    ],
  });
}
