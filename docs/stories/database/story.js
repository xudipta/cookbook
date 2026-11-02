// Story mode, Database: "The Card Catalogue".
//
// A table is a bookshelf, a row is a book, a seq scan is the librarian checking every book, an index is the card
// catalogue, and a migration is renovating the library without closing it. The story runs on the practice game's
// real engine (docs/games/database/sim.js): every card runs real SQL against the simulated database and shows the
// plan the planner printed. Each chapter is a plain async script over it (see ../shared/story.js).
import { h, createCounters, outputBox, mountStory as mount, siteUrl } from '../shared/story.js';
import { afterMove, createWorld, describeApp, evalQuery, metrics, migrationRows, runLine, saveFile, start, swapQuery, tick } from '../../games/database/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/database/notes/${name}/`);

const box = (text) => outputBox(text);
const fmtMs = (n) => (n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(0) : n.toFixed(1));
const MARK = { applied: 'done', pending: 'waiting', changed: 'edited' };

// The library: the requests with their speed, then (for renovations) the app and the migrations.
function createLibrary(app, { data }) {
  const reqs = h('ol', { class: 'lb-reqs', 'aria-label': 'Requests to the library', hidden: true });
  const counters = createCounters([
    { label: 'Storage', cls: 'ks-hud-ok' },
    { label: 'Write cost', cls: 'ks-hud-ok' },
  ]);
  const shop = h('div', { class: 'lb-shop', hidden: true });
  const migs = h('ol', { class: 'lb-migs', 'aria-label': 'Migrations', hidden: true });
  app.caption.before(reqs, counters.el, shop, migs);

  const A = { world: null, sc: null, hist: [] };
  const ctx = { ticks: 0, fire() {}, resolve() {}, log() {}, step() {}, rng: () => 0.5, scenario: null };
  ctx.step = () => {
    ctx.ticks += 1;
    tick(A.world, ctx);
  };

  function paintTuning() {
    const w = A.world;
    const m = metrics(w);
    reqs.hidden = false;
    counters.el.hidden = false;
    shop.hidden = true;
    migs.hidden = true;
    reqs.replaceChildren(
      ...w.queries.filter((q) => q.visible && q.kind !== 'write').map((q) => {
        const e = evalQuery(w, q);
        const limit = q.kind === 'batch' ? 'runs at night' : `limit ${q.budgetMs ?? w.targetMs} ms`;
        return h('li', { class: 'lb-req', 'data-slow': e.slow ? 'yes' : 'no' }, h('span', { class: 'lb-req-name', text: q.name }), h('strong', { text: `${fmtMs(e.requestMs)} ms` }), h('span', { class: 'lb-req-limit', text: limit }));
      }),
    );
    counters.values[0].textContent = `${Math.round(m.storageMb)}/${w.storageBudgetMb} MB`;
    counters.values[1].textContent = `${m.writeMs.toFixed(2)}/${w.writeBudgetMs} ms`;
    counters.el.children[0].className = m.storageOver ? 'ks-hud-bad' : 'ks-hud-ok';
    counters.el.children[1].className = m.writeOver ? 'ks-hud-bad' : 'ks-hud-ok';
    app.caption.textContent = `Day ${w.days}. Each request has a speed limit.`;
  }

  function paintRenovation() {
    const w = A.world;
    reqs.hidden = true;
    counters.el.hidden = true;
    const a = describeApp(w);
    shop.hidden = false;
    shop.setAttribute('data-broken', w.appBroken ? 'yes' : 'no');
    shop.replaceChildren(h('strong', { text: `The shop (app ${a.version})` }), h('span', { text: w.appBroken ? 'Customers see errors' : 'Customers are being served' }), h('span', { class: 'lb-needs', text: `It reads: ${a.needs.join(', ')}` }));
    migs.hidden = false;
    migs.replaceChildren(
      ...migrationRows(w).slice(-3).map((r) =>
        h('li', { class: 'lb-mig' }, h('span', { class: 'lb-mig-name', text: `${r.version} ${r.name}` }), h('span', { text: `practice: ${MARK[r.staging]}` }), h('span', { text: `real: ${MARK[r.prod]}` })),
      ),
    );
    app.caption.textContent = `Day ${w.days}. Nothing may ever stop the library serving.`;
  }

  const paint = () => {
    if (!A.world) return;
    if (A.world.mode === 'migrations') paintRenovation();
    else paintTuning();
  };

  const build = () => {
    const w = createWorld(A.sc);
    ctx.scenario = A.sc;
    ctx.ticks = 0;
    return w;
  };

  const exec = (w, c, step, rec) => {
    if (rec) A.hist.push(step);
    if (step.day) {
      c.ticks += 1;
      tick(w, c);
    } else if (step.save) {
      if (saveFile(w, ...step.save)) afterMove(w, c);
    } else if (step.swap) {
      swapQuery(w, c, step.swap);
      afterMove(w, c);
    } else {
      runLine(w, c, step.sh);
      afterMove(w, c);
    }
  };

  Object.assign(A, {
    load(levelId) {
      const level = data.levels.find((l) => l.id === levelId);
      const { levels: _levels, ...rest } = data;
      A.sc = { ...rest, ...level };
      A.hist = [];
      A.world = build();
      start(A.world, ctx);
      paint();
    },
    // Real SQL (or a migrate/deploy command) on the simulated database. Returns what the server printed.
    sh(cmds) {
      const w = A.world;
      const before = w.term.length;
      for (const c of [].concat(cmds)) exec(w, ctx, { sh: c }, true);
      paint();
      return w.term.slice(before).map((l) => l.text).join('\n');
    },
    day() {
      exec(A.world, ctx, { day: 1 }, true);
      paint();
    },
    save(version, kind, text) {
      exec(A.world, ctx, { save: [version, kind, text] }, true);
      paint();
    },
    swap(id) {
      exec(A.world, ctx, { swap: id }, true);
      paint();
    },
    // What a wrong choice would really do: the same commands on a scratch copy of the library. Returns the
    // printed output, plus how the scratch copy ended up.
    trial(cmds) {
      const w = build();
      const c = { ticks: 0, fire() {}, resolve() {}, log() {}, step() {}, rng: () => 0.5, scenario: A.sc };
      c.step = () => { c.ticks += 1; tick(w, c); };
      start(w, c);
      for (const step of A.hist) exec(w, c, step, false);
      const before = w.term.length;
      for (const x of [].concat(cmds)) exec(w, c, { sh: x }, false);
      return { out: w.term.slice(before).map((l) => l.text).join('\n'), world: w, metrics: w.mode === 'migrations' ? null : metrics(w), ctx: c };
    },
    // Runs fn and returns everything the server printed meanwhile.
    capture(fn, head = '') {
      const before = A.world.term.length;
      fn();
      const out = A.world.term.slice(before).map((l) => l.text).join('\n');
      return head ? `${head}\n${out}` : out;
    },
    slow(id) {
      const q = A.world.queries.find((x) => x.id === id);
      return q ? evalQuery(A.world, q) : null;
    },
    isSlow(id) {
      const e = A.slow(id);
      return Boolean(e && e.slow);
    },
    broken: () => Boolean(A.world.appBroken),
    reset() {
      A.world = null;
      A.sc = null;
      A.hist = [];
      reqs.hidden = true;
      reqs.replaceChildren();
      counters.el.hidden = true;
      shop.hidden = true;
      migs.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  return A;
}

// One decision. The right card runs the real SQL and shows what the database printed; a wrong card is explained
// (with the real consequence on a scratch copy, when there is one) and the question is asked again.
async function decide(ui, A, ask, options, after) {
  for (;;) {
    const picked = await ui.choose('libby', ask, options.map((o) => ({ label: o.label, value: o.label })));
    const opt = options.find((o) => o.label === picked);
    if (opt.right) {
      const out = typeof opt.cmd === 'function' ? opt.cmd() : A.sh(opt.cmd);
      await ui.say('libby', typeof after === 'function' ? after(out) : after, 'Next', box(out));
      return out;
    }
    const t = opt.trial ? A.trial(opt.trial) : null;
    await ui.say('libby', typeof opt.why === 'function' ? opt.why(t) : opt.why, 'Try again', t && opt.show !== false ? box(t.out) : null);
  }
}

// A look that is not a decision: one button, then the real output.
async function look(ui, A, text, button, cmd, after) {
  await ui.say('libby', text, button);
  const out = A.sh(cmd);
  await ui.say('libby', typeof after === 'function' ? after(out) : after, 'Next', box(out));
  return out;
}

// How long a request takes in a trial copy.
const msOf = (t, id) => fmtMs(evalQuery(t.world, t.world.queries.find((q) => q.id === id)).requestMs);

const LOGIN = "EXPLAIN ANALYZE SELECT id, email FROM users WHERE email = 'ada@example.com';";
const RECENT = 'EXPLAIN ANALYZE SELECT id, status, created_at FROM orders WHERE user_id = 4242 ORDER BY created_at DESC LIMIT 10;';
const JOIN = 'EXPLAIN ANALYZE SELECT oi.product_id, oi.quantity, p.name, p.price_cents FROM order_items AS oi INNER JOIN products AS p ON oi.product_id = p.id WHERE oi.order_id = 1042;';

function makeChapters() {
  return [
    {
      title: 'The librarian who reads every book',
      hook: 'A library where finding one book means checking every shelf. The queue at the desk is getting longer.',
      learn: 'what an index is, and why every one costs something.',
      async play({ ui, sim: A }) {
        A.load('seq-scans');
        await ui.say('libby', 'Welcome to the library. I am Libby, the head librarian. Visitors ask for things, and **speed limits** say how long they may wait. The **bookshelves** are the tables and every **book** is a row.');
        await ui.say('libby', 'Look at the board. **Login** takes **62 ms** and the limit is **20**. People log in with their email. Let us watch how the librarian finds one.', 'Watch the search');
        const plan = A.sh(LOGIN);
        await ui.say('libby', 'That plan says **Seq Scan on users**. A **seq scan** means she checked every one of the 150,000 books to find one email. The more books we get, the slower it gets.', 'Next', box(plan));
        await decide(ui, A, 'We can build a **card catalogue**: a sorted list that points straight to the shelf. Sorted by which column?', [
          { label: 'By creation date', why: (t) => `Nobody asks for "the user created at 3pm". Visitors ask by email, so a catalogue by date does not help: login is still **${msOf(t, 'login')} ms**.`, trial: ['CREATE INDEX idx_users_created ON users (created_at);'], show: false },
          { label: 'By email', cmd: 'CREATE UNIQUE INDEX idx_users_email ON users (email);', right: true },
          { label: 'By id', why: 'Books are already sorted by id (the primary key has a catalogue). Visitors do not know the id; they know the email.' },
        ], 'That was **CREATE INDEX** on the column that visitors search by. The card catalogue is built.');
        const again = A.sh(LOGIN);
        await ui.say('libby', 'Watch again. The plan now says **Index Scan**: the librarian looked up the card and went to one shelf. The speed fell from **61 ms to 0.2 ms**.', 'Next', box(again));
        await decide(ui, A, 'Order history is fast today (9 ms) but **the shelves grow 6% a day**. It also checks every book. What do we do?', [
          { label: 'Leave it, it is under the limit', why: 'It is under the limit today. Every day the shelf is bigger and a full scan gets slower. A catalogue by customer keeps it fast however big the shelf gets.' },
          { label: 'Add a catalogue by customer', cmd: 'CREATE INDEX idx_orders_user_id ON orders (user_id);', right: true },
        ], 'Another catalogue, by **user_id**. Both requests are now fast.');
        await ui.say('libby', 'Let the days pass and watch the shelves fill.', 'Wait three days');
        for (let i = 0; i < 3; i++) A.day();
        await ui.say('libby', 'A **nightly report** now counts shipped orders and takes 154 ms. It runs once a night with nobody waiting for it. Should we add a catalogue by **status** for it?', 'Next');
        await decide(ui, A, 'What do you do?', [
          {
            label: 'Add a catalogue by status',
            why: (t) => `That is a trap. The report got faster, but the storage grew from about ${Math.round(metrics(A.world).storageMb)} MB to **${Math.round(t.metrics.storageMb)} MB** and **every order we write** now has one more catalogue to update. Nobody is waiting for the nightly report.`,
            trial: ['CREATE INDEX idx_orders_status ON orders (status);'],
            show: false,
          },
          { label: 'Look at its plan, then leave it', cmd: "EXPLAIN SELECT count(*) FROM orders WHERE status = 'shipped';", right: true },
        ], 'The plan says a seq scan, and that is fine here: a once-a-night job that nobody waits for does not deserve a catalogue. **Every index speeds some reads and slows every write, and takes space.**');
        for (let i = 0; i < 2; i++) A.day();
        const m = metrics(A.world);
        await ui.say('libby', `Day ${A.world.days}: every request is within its limit, storage is **${Math.round(m.storageMb)} MB** and writes are cheap. Two catalogues, and the one we refused.`, 'Next');
        await ui.card({
          maps: [['Checking every book', 'Seq Scan'], ['A card catalogue', 'index'], ['Looking up the card', 'Index Scan'], ['Sorted by the question people ask', 'the WHERE column'], ['Every card costs something', 'slower writes, more storage']],
          plain: 'An **index** is a sorted list that lets the database skip a **Seq Scan**. Index the columns that queries filter by, and skip the one-off report: each index slows writes and takes space.',
          cmd: "EXPLAIN ANALYZE SELECT id, email FROM users WHERE email = 'ada@example.com';\nCREATE UNIQUE INDEX idx_users_email ON users (email);\nCREATE INDEX idx_orders_user_id ON orders (user_id);",
        });
      },
    },
    {
      title: 'Reading the map',
      hook: 'A wholesale library with big accounts. Some catalogues are missing, one is the wrong shape and two nobody uses.',
      learn: 'reading a plan, the order of columns in an index, and one query that runs forty times.',
      async play({ ui, sim: A }) {
        A.load('plans');
        await ui.say('libby', 'This is a wholesale library, with much bigger shelves. Look at the board: two requests are over their limit, and **writes are over budget** because of too many catalogues.');
        await look(ui, A, 'Before we add anything, ask which catalogue cards **nobody has used**.', 'Check card usage', 'SELECT relname, indexrelname, idx_scan FROM pg_stat_user_indexes;', 'The **idx_scan** column counts how many times each catalogue was used. Three have **0**: **idx_users_created_at**, **idx_orders_status** and **idx_orders_created_at**.');
        await decide(ui, A, 'Which cards do we throw away?', [
          { label: 'The busiest one, idx_orders_user_id', why: (t) => 'It has 410,000 uses: the most useful card in the library. Removing it would send every order lookup back to checking every book.', trial: ['DROP INDEX idx_orders_user_id;'], show: false },
          { label: 'The three with zero uses', cmd: ['DROP INDEX idx_orders_status;', 'DROP INDEX idx_orders_created_at;', 'DROP INDEX idx_users_created_at;'], right: true },
        ], 'Dropped the three unused ones. **Every card costs a little on every write**, so the write cost on the board came down.');
        await look(ui, A, '**Recent orders** is over its 4 ms limit. See how the plan works.', 'Show the plan', RECENT, 'It uses the catalogue by user, but then it has a **Sort** step: it fetches all 75 of this customer\'s orders and sorts them by date, to keep ten.');
        await decide(ui, A, 'A catalogue that is already sorted the right way avoids the sort. Which one?', [
          { label: 'By date first, then customer', why: () => 'The order of columns matters. This catalogue is sorted by date and only then by customer, so the planner cannot jump to one customer\'s orders. The plan below is the same as before.', trial: ['CREATE INDEX idx_orders_created_user ON orders (created_at, user_id);', RECENT], },
          { label: 'By customer first, then date', cmd: ['CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);', RECENT], right: true },
          { label: 'By status', why: 'Nobody asked for the status here. Filter by customer, sort by date: those are the two columns.' },
        ], 'The **Sort** is gone: the plan reads **Index Scan Backward**. The catalogue is sorted by customer, and within each customer by date, so the newest ten are right there.');
        await decide(ui, A, '**Who bought this** scans 6 million order lines to find one product. Which catalogue?', [
          { label: 'Order lines by product', cmd: 'CREATE INDEX idx_order_items_product_id ON order_items (product_id);', right: true },
          { label: 'Products by name', why: 'The question is "which order lines mention this product", and the lines are on a different shelf. The catalogue has to be on **order_items**, sorted by **product_id**.', trial: ['CREATE INDEX idx_products_name ON products (name);'], show: false },
        ], 'Done. A 2,000 ms request is now about 10 ms.');
        await ui.say('libby', 'A new page launches tomorrow.', 'Next day');
        A.day();
        await ui.say('libby', 'The new **order page** shows 40 items. It asks the database for the order, then asks **again for every product**: 40 trips to the shelf for one order. Each trip is fast, but forty of them add up to **43 ms**, over the 15 limit.', 'Next');
        await look(ui, A, 'There is a way to get everything in one trip: a **JOIN**. Try it.', 'Try the join', JOIN, 'One query, one trip, all 40 products. A **JOIN** is the librarian fetching a whole pile at once.');
        await decide(ui, A, 'The app should ask the database once. What do we ship?', [
          { label: 'Keep 40 trips, add more catalogues', why: 'Each trip is already fast. The cost is the **number** of trips. More catalogues cannot help.' },
          { label: 'Ship the join as the app\'s query', cmd: () => A.capture(() => { A.sh(JOIN); A.swap('order-page'); }), right: true },
        ], 'Shipped.');
        const m = metrics(A.world);
        await ui.say('libby', `Everything is now within its limit: storage ${Math.round(m.storageMb)} MB and writes ${m.writeMs.toFixed(2)} ms.`, 'Next');
        await ui.card({
          maps: [['The librarian\'s route', 'EXPLAIN'], ['Cards nobody uses', 'pg_stat_user_indexes, idx_scan = 0'], ['Sorted by customer, then date', 'index on (user_id, created_at)'], ['One trip instead of forty', 'JOIN (no N+1)']],
          plain: '**EXPLAIN** shows the route. **Column order** in a multi-column index matters: put the filter first and the sort second. Drop indexes nothing uses, and replace many tiny queries with a **JOIN**.',
          cmd: 'SELECT relname, indexrelname, idx_scan FROM pg_stat_user_indexes;\nDROP INDEX idx_orders_status;\nCREATE INDEX idx_orders_user_created ON orders (user_id, created_at);\nEXPLAIN ANALYZE SELECT ... FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = 1042;',
        });
      },
    },
    {
      title: 'Renovate without closing',
      hook: 'The library must change its shelves while it is open. Order matters: add before you use, stop using before you remove.',
      learn: 'safe migrations: test on staging, expand then contract, and a real undo.',
      async play({ ui, sim: A }) {
        A.load('migrations');
        await ui.say('libby', 'Now we renovate. The library stays **open all day**. Changes to the shelves are written as **migrations**, numbered files with an **up** (make the change) and a **down** (undo it). We have a **practice library** (staging) and the **real one**.');
        await look(ui, A, 'Release 1 adds a **currency** column to orders, and a new version of the app shows prices in it. What is waiting?', 'Check the migrations', 'migrate status', 'Migration **0006** is **pending**: not yet applied in the real library.');
        await decide(ui, A, 'Where do we try it first?', [
          { label: 'Straight in the real library', why: 'If the change fails there, customers see it. Try it in the practice library first, where nobody is watching.' },
          { label: 'In the practice library', cmd: ['\\c staging', 'migrate up'], right: true },
        ], 'It applied. Now try the **undo** as well, then apply it again.');
        await look(ui, A, 'A migration you cannot undo is a trap. Test the down, then the up again.', 'Undo, then redo', ['migrate down 1', 'migrate up'], 'Both directions work.');
        await decide(ui, A, 'In the real library, two things must happen: **add the column**, and **ship the new app** that reads it. Which first?', [
          { label: 'Ship the new app first', why: () => 'The new app asks for a column that does not exist yet, and customers get errors. Here is what really happens:', trial: ['\\c prod', 'deploy v2'] },
          { label: 'Add the column first, then ship the app', cmd: ['\\c prod', 'migrate up', 'deploy v2'], right: true },
        ], 'Nobody noticed. **Adding something: the schema goes first, then the code that uses it.**');
        await ui.say('libby', 'A day goes by. Release 2 adds **shipped_at**.', 'Next day');
        A.day();
        await look(ui, A, 'Try it in the practice library, and test its undo.', 'Try up and down', ['\\c staging', 'migrate up', 'migrate down 1', '\\d orders'], 'The undo said **7/d** and finished in 3 ms, but look at the table: **shipped_at is still there**. The down file only says "TODO".');
        await decide(ui, A, 'What does that mean?', [
          { label: 'It is fine, it said it worked', why: 'It reported success, but the column is still there. If we had to roll back at midnight, nothing would be undone.' },
          { label: 'The undo is empty: write a real one', cmd: () => A.capture(() => { A.save('0007', 'down', 'ALTER TABLE orders DROP COLUMN shipped_at;\n'); A.sh(['ALTER TABLE orders DROP COLUMN shipped_at;', 'migrate up', 'migrate down 1']); }, '-- 0007 down: ALTER TABLE orders DROP COLUMN shipped_at;'), right: true },
        ], 'We wrote a real down (**DROP COLUMN**) and tested it.');
        await ui.say('libby', 'Same order as before: the column first, then the new app.', 'Ship release 2');
        A.sh(['\\c prod', 'migrate up', 'deploy v3']);
        A.day();
        await ui.say('libby', 'Bad news: release 2 has a bug and must be **rolled back**. The new column is in the real library and app v3 is using it.', 'Next');
        await decide(ui, A, 'In which order do we undo it?', [
          { label: 'Remove the column first, then the old app', why: () => 'The new app is still running and it reads the column you just removed. Customers see errors:', trial: ['migrate down 1'] },
          { label: 'Bring back the old app first, then remove the column', cmd: ['deploy v2', 'migrate down 1'], right: true },
        ], 'Rolled back. **Removing something: stop the code that uses it first, then drop it.**');
        await ui.say('libby', 'One more day. Release 3 retires an old column, **users.legacy_username**, that the current app still reads.', 'Next day');
        A.day();
        await decide(ui, A, 'The new app (v4) no longer reads the column. The migration drops it. Which first?', [
          { label: 'Drop the column first', why: () => 'The app in production still reads **legacy_username**. Dropping it first breaks the app:', trial: ['migrate up'] },
          { label: 'Ship the app that does not read it, then drop it', cmd: ['deploy v4', 'migrate up'], right: true },
        ], 'Done, and the library never stopped.');
        await ui.say('libby', `The library stayed open through three renovations. Error budget left: **${Math.round(A.world.health)}%**.`, 'Next');
        await ui.card({
          maps: [['The practice library', 'staging'], ['A renovation plan, numbered', 'migration (up/down)'], ['Add: schema first, then the code', 'expand'], ['Remove: code first, then the schema', 'contract'], ['An undo that really undoes', 'a tested down migration']],
          plain: 'Test every migration **up and down** on staging. To **add** something, change the schema before the code that needs it. To **remove**, stop using it in the code first, then drop it.',
          cmd: 'migrate up\nmigrate down 1\nALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT \'USD\';\nALTER TABLE orders DROP COLUMN shipped_at;   -- the real down',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/database/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const data = await res.json();
  mount(host, {
    id: 'database',
    title: 'The Card Catalogue',
    stageLabel: 'The library',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      libby: { name: 'Libby', role: 'Head librarian', color: '#8a4b12' },
    },
    chapters: makeChapters(),
    createStage: (app) => createLibrary(app, { data }),
    startLabel: 'Open the library',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real SQL',
    endKicker: 'Library open',
    endTitle: 'You just tuned and renovated a database',
    endIntro: 'Every library word you used has a real SQL word. Here is your notebook.',
    endLinks: [
      { text: 'Read: Queries and indexing', href: NOTE('03-queries-and-indexing') },
      { text: 'Read: Migrations', href: NOTE('02-migrations') },
      { text: 'Play the real database game', href: new URL('database/', HUB).href },
    ],
  });
}
