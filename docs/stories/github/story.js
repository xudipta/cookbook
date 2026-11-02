// Story mode, Git and GitHub: "The Shared Cookbook".
//
// A cookbook that many chefs edit: main is the printed book, a branch is your own photocopy, a commit is a
// saved page edit, a pull request is "please add my page to the book". The commit graph is the stage, and it
// runs on the practice game's real git and gh simulator (docs/games/github/sim.js), so the commands, the
// output, the graph and the conflicts are the game's. Each chapter is a plain async script over it
// (see ../shared/story.js).
import { h, outputBox, mountStory as mount, siteUrl } from '../shared/story.js';
import { branchInfo, createWorld, editFile, execute, graphRows, workStatus } from '../../games/github/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/github/notes/${name}/`);

const SVG = 'http://www.w3.org/2000/svg';
const LANE = 14;
const laneX = (k) => 9 + k * LANE;

const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};
const edge = (x1, y1, x2, y2, lane) => svg('line', { x1, y1, x2, y2, class: `gc-edge gc-l${lane % 4}`, 'vector-effect': 'non-scaling-stroke' });

// One commit row: the top half of its lane lines (down to the dot) and the bottom half (stretching to the row's height).
function rowGraphic(row, width) {
  const w = laneX(width - 1) + 9;
  const top = svg('svg', { class: 'gc-svg gc-svg-top', width: w, height: 14, viewBox: `0 0 ${w} 14`, 'aria-hidden': 'true', focusable: 'false' });
  const bottom = svg('svg', { class: 'gc-svg gc-svg-bottom', width: w, height: '100%', viewBox: `0 0 ${w} 100`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
  row.before.forEach((id, k) => {
    if (id === null || id === undefined) return;
    if (k === row.lane) {
      if (!row.fresh) top.append(edge(laneX(k), 0, laneX(k), 14, k));
    } else if (row.merged.includes(k)) top.append(edge(laneX(k), 0, laneX(row.lane), 14, k));
    else if (row.after[k] === id) top.append(edge(laneX(k), 0, laneX(k), 14, k));
  });
  row.parentLanes.forEach((pl) => bottom.append(edge(laneX(row.lane), 0, laneX(pl), 100, pl)));
  row.after.forEach((id, k) => {
    if (id === null || id === undefined || k === row.lane || row.added.includes(k)) return;
    if (row.before[k] === id) bottom.append(edge(laneX(k), 0, laneX(k), 100, k));
  });
  const node = h('span', { class: `gc-node gc-l${row.lane % 4}${row.parentLanes.length > 1 ? ' gc-node-merge' : ''}${row.refs.some((r) => r.kind === 'head') ? ' gc-node-head' : ''}`, style: `left: ${laneX(row.lane) - 6}px` });
  return h('div', { class: 'gc-gfx', style: `width: ${w}px`, 'aria-hidden': 'true' }, top, bottom, node);
}

// Parse the first conflict in a file: the lines around it and the two sides.
function parseConflict(text) {
  const lines = text.split('\n');
  const a = lines.findIndex((l) => /^<{7}( |$)/.test(l));
  const mid = lines.findIndex((l, i) => i > a && /^={7}$/.test(l));
  const z = lines.findIndex((l, i) => i > mid && /^>{7}( |$)/.test(l));
  if (a < 0 || mid < 0 || z < 0) return null;
  return { before: lines.slice(0, a), first: lines.slice(a + 1, mid), second: lines.slice(mid + 1, z), after: lines.slice(z + 1) };
}

// The stage: the commit graph, where you are, the file being edited, and the conflict to resolve.
function createCookbook(app, { levels }) {
  const where = h('p', { class: 'gc-where', hidden: true });
  const graphEl = h('div', { class: 'gc-graph', role: 'list', 'aria-label': 'The commit graph, newest first', hidden: true });
  const fileEl = h('div', { class: 'gc-file', hidden: true });
  const conflictEl = h('div', { class: 'gc-conflict', hidden: true });
  app.caption.before(where, graphEl, fileEl, conflictEl);

  const G = { sc: null, world: null, shown: null, conflict: null, seen: new Set() };
  const ctx = { ticks: 0, step() {}, fire() {}, resolve() {}, log() {}, scenario: null };

  function paintGraph() {
    const w = G.world;
    const g = graphRows(w, 7);
    graphEl.replaceChildren(
      ...g.rows.map((r) => {
        const fresh = G.seen.size && !G.seen.has(r.id);
        return h('div', { class: `gc-row${fresh ? ' gc-new' : ''}`, role: 'listitem' },
          rowGraphic(r, g.width),
          h('div', { class: 'gc-info' },
            h('div', { class: 'gc-line' }, h('span', { class: 'gc-subj', text: r.subject }), h('span', { class: 'gc-who', text: r.author })),
            r.refs.length ? h('div', { class: 'gc-pills' }, r.refs.map((ref) => h('span', { class: `gc-pill gc-pill-${ref.kind}`, text: ref.text }))) : null));
      }),
      ...(g.hidden > 0 ? [h('div', { class: 'gc-more', role: 'listitem', text: `${g.hidden} older commits not shown` })] : []),
    );
    for (const r of g.rows) G.seen.add(r.id);
  }

  function paintWhere() {
    const w = G.world;
    const info = branchInfo(w);
    const s = workStatus(w);
    const track = info.upstream ? (!info.ahead && !info.behind ? `in step with ${info.upstream}` : `${info.ahead} ahead, ${info.behind} behind ${info.upstream}`) : 'not on GitHub yet';
    const bits = [];
    if (s.unmerged.length) bits.push(`to resolve: ${s.unmerged.join(', ')}`);
    if (s.staged.length) bits.push(`staged: ${s.staged.map((f) => f.path || f).join(', ')}`);
    if (s.unstaged.length) bits.push(`edited: ${s.unstaged.map((f) => f.path || f).join(', ')}`);
    where.replaceChildren(...[h('strong', { text: info.branch ? `On ${info.branch}` : 'Detached' }), h('span', { text: ` · ${track}` }), bits.length ? h('span', { class: 'gc-changes', text: bits.join(' · ') }) : null].filter(Boolean));
    where.hidden = false;
  }

  function paintFile() {
    if (!G.shown) { fileEl.hidden = true; return; }
    const text = G.world.worktree[G.shown];
    fileEl.hidden = text === undefined;
    if (text === undefined) return;
    fileEl.replaceChildren(h('code', { class: 'gc-file-name', text: G.shown }), h('pre', { class: 'gc-file-text' }, h('code', { text })));
  }

  function paintConflict() {
    const c = G.conflict;
    conflictEl.hidden = !c;
    if (!c) return;
    const line = (side, text) => {
      const on = c.picked.has(`${side}:${text}`);
      const b = h('button', { class: `gc-line-pick${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on), 'data-text': text, 'data-side': side },
        h('span', { class: 'gc-check', 'aria-hidden': 'true', text: on ? '✓' : '' }),
        h('code', { text }));
      b.addEventListener('click', () => { c.picked.has(`${side}:${text}`) ? c.picked.delete(`${side}:${text}`) : c.picked.add(`${side}:${text}`); paintConflict(); });
      return b;
    };
    conflictEl.replaceChildren(
      h('p', { class: 'gc-side-title', text: c.firstLabel }), ...c.parsed.first.map((t) => line('first', t)),
      h('p', { class: 'gc-side-title', text: c.secondLabel }), ...c.parsed.second.map((t) => line('second', t)));
  }

  // While a conflict is open, the file and its lines get the whole stage.
  const paint = () => { paintGraph(); paintWhere(); paintFile(); paintConflict(); graphEl.hidden = Boolean(G.conflict); };

  Object.assign(G, {
    // Start from one of the game's levels, optionally replaying commands to reach a situation.
    load(levelId, replay = []) {
      const level = levels.find((l) => l.id === levelId);
      G.sc = level;
      ctx.scenario = level;
      G.world = createWorld({ ...level, schedule: [] }); // the story, not the clock, decides when things happen
      G.seen = new Set();
      G.shown = null;
      G.conflict = null;
      paint();
      for (const cmd of replay) execute(G.world, ctx, cmd);
      paint();
    },
    // Run one command line; returns what it printed (the command echoed first).
    run(line) {
      const w = G.world;
      const before = w.term.length;
      execute(w, ctx, line);
      paint();
      return w.term.slice(before).map((t) => t.text).join('\n').trim();
    },
    edit(path, text) {
      editFile(G.world, ctx, path, text);
      G.shown = path;
      paint();
    },
    show(path) { G.shown = path; paint(); },
    // The conflict in the first unresolved file, as tappable lines. `mineFirst`: HEAD is my branch (a merge).
    startConflict(mineFirst) {
      const path = G.world.unmerged[0];
      const parsed = parseConflict(G.world.worktree[path]);
      G.conflict = { path, parsed, picked: new Set(), firstLabel: mineFirst ? 'From your branch' : 'From main', secondLabel: mineFirst ? 'From main' : 'From your branch' };
      G.shown = path;
      paint();
      return path;
    },
    // The file text if the picked lines were kept (null when nothing is picked).
    resolved() {
      const c = G.conflict;
      const keep = [...c.parsed.first.filter((t) => c.picked.has(`first:${t}`)), ...c.parsed.second.filter((t) => c.picked.has(`second:${t}`))];
      return keep.length ? [...c.parsed.before, ...keep, ...c.parsed.after].join('\n') : null;
    },
    endConflict() { G.conflict = null; paint(); },
    caption(text) { app.caption.textContent = text || ''; },
    reset() {
      G.world = null;
      G.sc = null;
      G.shown = null;
      G.conflict = null;
      G.seen = new Set();
      where.hidden = true;
      graphEl.replaceChildren();
      graphEl.hidden = true;
      fileEl.hidden = true;
      conflictEl.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  return G;
}

// The output box under a line of story: the command and what it printed (long hints are cut short).
const box = (text) => outputBox(text.length > 2200 ? `${text.slice(0, 2200)}\n...` : text);

let strategy = 'merge'; // how the player brought main in (chapter 2), used when chapter 3 replays the situation

function makeChapters() {
  return [
    {
      title: 'Everyday flow',
      hook: 'Ines edits a cookbook that a whole team writes in. Today you add your first page.',
      learn: 'what a branch, a commit and a pull request are, and how a change reaches main.',
      async play({ ui, sim: G }) {
        G.load('first-pr');
        G.caption('Each dot is a commit. The labels say which branch points at it.');
        await ui.say('ines', 'This is our **cookbook**. **main** is the printed book that customers read. The team has a copy on GitHub and everyone keeps a copy on their laptop.');
        await ui.say('ines', 'You never write straight into the printed book. You make your **own photocopy** to work on: a **branch**.', 'Run git switch -c docs/contributing');
        let out = G.run('git switch -c docs/contributing');
        await ui.say('ines', 'Your branch starts at the same page as main. Now add a line to the README that points at CONTRIBUTING.md.', 'Edit README.md', box(out));
        G.edit('README.md', '# site\nA tiny web service.\nSee CONTRIBUTING.md before you open a pull request.');
        await ui.say('ines', 'Edited. The change is only in your working copy. First choose what goes in the next page edit: that is **staging**.', 'Run git add README.md');
        out = G.run('git add README.md');
        await ui.say('ines', 'Staged. Now save the page edit with a short note about what changed: a **commit**.', 'Run git commit', box(out));
        out = G.run('git commit -m "Link CONTRIBUTING from the README"');
        await ui.say('ines', 'A new dot on your branch. It exists only on your laptop for now.', 'Next', box(out));
        const guess = await ui.choose('ines', 'You send your branch to GitHub. Does the printed book, **main**, change?', [
          { label: 'Yes: main is updated now', value: 'main' },
          { label: 'No: only my branch is sent', value: 'branch' },
        ]);
        out = G.run('git push -u origin HEAD');
        await ui.say('ines', `${guess === 'branch' ? 'Right!' : 'Not yet!'} Look at the labels: **origin/docs/contributing** appeared, and main did not move. Pushing shares your branch, nothing more.`, 'Run gh pr create', box(out));
        out = G.run('gh pr create --fill');
        await ui.say('ines', 'A **pull request** asks the team: "please add my page to the book". People can read the change and comment before it goes in.', 'Run gh pr merge', box(out));
        out = G.run('gh pr merge --squash --delete-branch');
        await ui.say('ines', 'Merged! Your page is in the printed book and your photocopy is thrown away. main on GitHub and main on your laptop agree again.', 'Next', box(out));
        await ui.card({
          maps: [['Cookbook', 'repository'], ['The printed book', 'main'], ['Your photocopy', 'branch'], ['A saved page edit', 'commit'], ['Send it to GitHub', 'git push'], ['"Please add my page"', 'pull request']],
          plain: 'Work on a **branch**, save it as **commits**, **push** the branch, then open a **pull request** so the team can review it before it is merged into **main**.',
          cmd: 'git switch -c docs/contributing\ngit add README.md\ngit commit -m "Link CONTRIBUTING from the README"\ngit push -u origin HEAD\ngh pr create --fill\ngh pr merge --squash --delete-branch',
        });
      },
    },
    {
      title: 'Behind main',
      hook: 'You have been working on your page for days. Meanwhile the book moved on.',
      learn: 'what fetch shows you, why your branch is behind, and merge versus rebase.',
      async play({ ui, sim: G }) {
        G.load('behind-main');
        G.caption('Your pull request #7 is open. Your branch has your two edits.');
        await ui.say('ines', 'Your branch **feature/retries** has an open pull request. But while you worked, teammates added pages to **main**.', 'Next');
        await ui.say('ines', 'Your laptop does not know yet. To look at what is new on GitHub without changing your pages, run **fetch**.', 'Run git fetch');
        const out = G.run('git fetch');
        await ui.say('ines', 'Two new dots appeared on **origin/main**, on their own line of the graph. Your branch does not have those pages: it is **behind main**.', 'Next', box(out));
        const pick = await ui.choose('ines', 'To bring those pages into your branch you can **merge** main in, or **rebase** your edits on top of main. Which do you want?', [
          { label: 'Merge main into my branch', value: 'merge' },
          { label: 'Rebase my branch onto main', value: 'rebase' },
        ]);
        strategy = pick;
        const res = G.run(pick === 'merge' ? 'git merge origin/main' : 'git rebase origin/main');
        const why = pick === 'merge'
          ? 'A merge ties the two lines together with a **merge commit**. Nothing is rewritten.'
          : 'A rebase **replays** your edits on top of main, one at a time, as new commits. The history stays a straight line.';
        await ui.say('ines', `${why} But look: Git stopped. **Conflict!** Dana and you both changed the same line of config.yml.`, 'Next', box(res));
        await ui.card({
          maps: [['Look at the book on GitHub', 'git fetch'], ['Your copy is out of date', 'behind main'], ['Tie the two lines together', 'git merge'], ['Replay my edits on top', 'git rebase']],
          plain: '**fetch** downloads what is new without touching your files. To catch up, **merge** keeps history as it happened (with a merge commit); **rebase** rewrites your commits on top of the new main for a straight line.',
          cmd: 'git fetch\ngit merge origin/main      # or:\ngit rebase origin/main',
        });
      },
    },
    {
      title: 'Two chefs, one line',
      hook: 'Two people changed the same line of the same page. Git cannot pick a winner for you.',
      learn: 'how to read a merge conflict, resolve it, and finish the pull request.',
      async play({ ui, sim: G }) {
        G.load('behind-main', ['git fetch', strategy === 'merge' ? 'git merge origin/main' : 'git rebase origin/main']);
        G.caption('Tap the lines you want to keep.');
        const mineFirst = strategy === 'merge';
        G.startConflict(mineFirst);
        await ui.say('ines', 'Git put **both versions** of the line into config.yml, with markers around them. Dana raised the timeout to **60**. Your branch added **retries: 3**. We want both changes, and only one timeout.', 'Next');
        let text = null;
        for (;;) {
          ui.phase('conflict');
          await ui.choose('ines', 'Tap the lines to keep, then save. Keep Dana\'s new timeout and your retries setting.', [{ label: 'Save my resolution', value: 'save' }]);
          text = G.resolved();
          if (text && text.includes('timeout: 60') && text.includes('retries: 3') && !text.includes('timeout: 30')) break;
          ui.phase('story');
          await ui.say('ines', !text ? 'Nothing is selected, so the file would lose those lines.' : 'Not quite. Dana\'s team raised the timeout to 60, so the old 30 must go. And your **retries: 3** has to stay.', 'Try again');
        }
        ui.phase('story');
        G.endConflict();
        G.edit('config.yml', text);
        await ui.say('ines', 'The file now holds exactly what we want, with no markers. Tell Git the conflict is **resolved** by staging the file.', 'Run git add config.yml');
        let out = G.run('git add config.yml');
        const merge = strategy === 'merge';
        await ui.say('ines', merge ? 'Staged. Finish the merge by saving it as a commit.' : 'Staged. Tell the rebase to carry on with your next edit.', merge ? 'Run git commit' : 'Run git rebase --continue', box(out));
        out = G.run(merge ? 'git commit --no-edit' : 'git rebase --continue');
        await ui.say('ines', merge ? 'The two lines of work are tied together.' : 'Your edits now sit on top of main in a straight line. Because a rebase made **new commits**, GitHub\'s copy of your branch looks different from yours now.', merge ? 'Run git push' : 'Run git push --force-with-lease', box(out));
        out = G.run(merge ? 'git push' : 'git push --force-with-lease');
        await ui.say('ines', merge ? 'Your pull request is up to date and has no conflict any more.' : '**--force-with-lease** overwrites your own old branch on GitHub, but only if nobody else pushed to it. It is the safe way to push after a rebase.', 'Run gh pr merge', box(out));
        out = G.run('gh pr merge --squash --delete-branch');
        await ui.say('ines', 'Merged! Pull request #7 is in the book, with Dana\'s timeout and your retries.', 'Next', box(out));
        await ui.card({
          maps: [['Two chefs, one line', 'merge conflict'], ['The lines around it', '<<<<<<< ======= >>>>>>>'], ['Say it is fixed', 'git add'], ['Carry on', 'git commit / git rebase --continue'], ['Safe overwrite after a rebase', 'git push --force-with-lease']],
          plain: 'A **merge conflict** is Git asking a person to decide. Edit the file to keep what you want, remove the markers, **git add** it, then finish with **git commit** (merge) or **git rebase --continue**.',
          cmd: '<<<<<<< HEAD\ntimeout: 30\nretries: 3\n=======\ntimeout: 60\n>>>>>>> origin/main\n\n# edit the file, then:\ngit add config.yml\ngit commit            # or: git rebase --continue',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/github/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const data = await res.json();
  mount(host, {
    id: 'github',
    title: 'The Shared Cookbook',
    stageLabel: 'The cookbook',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      ines: { name: 'Ines', role: 'Editor-in-chief', color: '#b8470f' },
    },
    chapters: makeChapters(),
    createStage: (app) => createCookbook(app, data),
    startLabel: 'Open the cookbook',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real Git',
    endKicker: 'Edition printed',
    endTitle: 'You just used Git and GitHub',
    endIntro: 'Every cookbook word you used has a real name. Here is your notebook.',
    endLinks: [
      { text: 'Read: Git fundamentals', href: NOTE('01-git-fundamentals') },
      { text: 'Read: GitHub CLI and PRs', href: NOTE('02-github-cli-and-prs') },
      { text: 'Play the real Git game', href: new URL('github/', HUB).href },
    ],
  });
}
