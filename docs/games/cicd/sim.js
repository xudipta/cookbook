// The simulator for "Pipeline Panic". Pure logic, no DOM, importable from Node.
//
// It models what topics/cicd/notes/01-03 teach and nothing that contradicts them. Two modes share one
// file, picked per level with `mode` in scenarios.json:
//
//   "pipeline" (Pipeline Tycoon): place cards to build a GitHub Actions workflow. The cards generate
//     real workflow YAML (buildFiles), and each incoming PR or push is run through the workflow as it
//     stands: path filters skip docs-only PRs, a cache shortens installs, a matrix catches the
//     version-specific bug, `concurrency` cancels superseded runs, `needs:` stops the test job after a
//     lint failure, and `pull_request_target` plus a checkout of the PR's head leaks secrets to a fork.
//   "deploy" (Deploy Day): releases move dev -> staging -> prod. In prod the player picks rolling,
//     blue-green or canary and watches the blast radius of a buggy release play out, then rolls back.
//
// Time is turn-based: a tick is one incoming event (pipeline) or one minute (deploy), and it only
// advances when the player runs the next event or waits.

// ---------------------------------------------------------------- shared helpers

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => Math.round(n * 10) / 10;
const fmtMin = (n) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function createWorld(sc) {
  const w = {
    mode: sc.mode,
    minHealth: sc.minHealth,
    winTicks: sc.winTicks,
    schedule: sc.schedule || [],
    open: [], // fired events waiting for the player to deal with them: { id, ... }
    out: [], // the latest terminal / console lines: { kind, text }
    ticks: 0,
    penalty: 0,
  };
  if (sc.mode === 'pipeline') Object.assign(w, createPipeline(sc));
  else if (sc.mode === 'deploy') Object.assign(w, createDeploy(sc));
  else throw new Error(`cicd sim: unknown mode "${sc.mode}"`);
  return w;
}

function say(w, text, kind = 'out') {
  w.out.push({ kind, text });
  if (w.out.length > 160) w.out.splice(0, w.out.length - 160);
}

// health = 100 minus every penalty (and, in deploy mode, the share of the failure budget used up).
function setHealth(w) {
  const lost = w.mode === 'deploy' ? (w.failedTotal / w.failScale) * 100 : 0;
  w.health = clamp(Math.round(100 - w.penalty - lost), 0, 100);
}

function hurt(w, ctx, points, why) {
  w.penalty += points;
  setHealth(w);
  ctx.log(`${why} (-${points} health)`, { kind: 'warn' });
}

function openEvent(w, ctx, id, detail) {
  ctx.fire(id, detail);
  w.open.push({ id });
}

function closeEvent(w, ctx, id) {
  const at = w.open.findIndex((e) => e.id === id);
  if (at < 0) return false;
  w.open.splice(at, 1);
  ctx.resolve(id);
  return true;
}

// ================================================================ pipeline mode

const BILL_CANCELLED = 1; // minutes billed for a run cancelled early

function createPipeline(sc) {
  const cards = new Map(Object.entries(sc.cardDefs).map(([id, c]) => [id, { id, ...c }]));
  for (const id of [...sc.cards, ...sc.placed]) if (!cards.has(id)) throw new Error(`level ${sc.id}: unknown card "${id}"`);
  return {
    cards,
    tray: [...sc.cards],
    placed: [...sc.placed],
    thirdParty: Boolean(sc.thirdParty),
    usesSecret: Boolean(sc.usesSecret),
    costs: sc.costs,
    budget: sc.budget,
    goal: sc.goal || {},
    minutes: 0,
    feedback: [], // minutes until a PR's checks finished, for every run that actually ran
    merged: 0,
    broken: 0, // outcomes that left something broken: a shipped bug, drifted copies, a hit supply chain, a stolen token
    leaked: false,
    last: null, // the latest processed event, for the board
  };
}

export const hasCard = (w, id) => w.placed.includes(id);

// Place a card (a card in an exclusive group replaces the others in that group). Returns false if nothing changed.
export function placeCard(w, id) {
  const card = w.cards.get(id);
  if (!card || !w.tray.includes(id) || w.placed.includes(id)) return false;
  if (card.exclusive) w.placed = w.placed.filter((p) => w.cards.get(p).group !== card.group);
  w.placed.push(id);
  return true;
}

export function removeCard(w, id) {
  if (!w.placed.includes(id)) return false;
  w.placed = w.placed.filter((p) => p !== id);
  return true;
}

// What the placed cards mean for the workflow.
export function config(w) {
  const has = (id) => w.placed.includes(id);
  return {
    push: has('on-push'),
    pr: has('on-pr'),
    prt: has('on-prt'),
    dispatch: has('on-dispatch'),
    schedule: has('on-schedule'),
    pathsIgnore: has('paths-ignore'),
    cache: has('cache-setup') ? 'setup-node' : has('cache-action') ? 'actions/cache' : null,
    matrix: has('matrix'),
    needs: has('needs-lint'),
    concurrency: has('concurrency'),
    perms: has('perms-read'),
    ref: has('ref-main') ? 'main' : has('ref-tag') ? 'tag' : has('ref-sha') ? 'sha' : null,
    reusable: has('reusable-lint'),
    composite: has('composite-setup'),
    checkoutHead: has('checkout-head'),
  };
}

// ---------------------------------------------------------------- the YAML the cards generate

const SHA = '3f1c9a7e5b2d84a06c1e7f93b5a8d2c4e6f01a97';

function setupSteps(c, nodeExpr, pad = '      ', shell = false) {
  const lines = [`${pad}- uses: actions/setup-node@v4`, `${pad}  with:`, `${pad}    node-version: ${nodeExpr}`];
  if (c.cache === 'setup-node') lines.push(`${pad}    cache: npm`);
  if (c.cache === 'actions/cache') {
    lines.push(
      `${pad}- uses: actions/cache@v4`,
      `${pad}  with:`,
      `${pad}    path: ~/.npm`,
      `${pad}    key: npm-\${{ runner.os }}-\${{ hashFiles('package-lock.json') }}`,
      `${pad}    restore-keys: |`,
      `${pad}      npm-\${{ runner.os }}-`,
    );
  }
  lines.push(`${pad}- run: npm ci`);
  if (shell) lines.push(`${pad}  shell: bash`); // a composite action's run steps must name their shell
  return lines;
}

// The files the placed cards produce, as [{ path, text }]. Valid workflow syntax whatever you place.
export function buildFiles(w) {
  const c = config(w);
  const L = ['name: CI'];
  const filter = c.pathsIgnore ? ['    paths-ignore:', "      - '**.md'", "      - 'docs/**'"] : [];
  const triggers = [];
  if (c.push) triggers.push('  push:', '    branches: [main]', ...filter);
  if (c.pr) triggers.push('  pull_request:', ...filter);
  if (c.prt) triggers.push('  pull_request_target:', ...filter);
  if (c.dispatch) triggers.push('  workflow_dispatch:');
  if (c.schedule) triggers.push('  schedule:', "    - cron: '0 3 * * *'");
  if (triggers.length) L.push('on:', ...triggers);
  else L.push('on: {} # no trigger: this workflow never runs');
  L.push('');
  if (c.perms) L.push('permissions:', '  contents: read', '');
  if (c.concurrency) L.push('concurrency:', '  group: ci-${{ github.ref }}', '  cancel-in-progress: true', '');

  L.push('jobs:', '  lint:');
  if (c.reusable) L.push('    uses: ./.github/workflows/reusable-lint.yml', '    with:', '      paths: "."');
  else L.push('    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', '      - run: pip install yamllint', '      - run: yamllint .');
  L.push('', '  test:', '    runs-on: ubuntu-latest');
  if (c.needs) L.push('    needs: lint');
  if (c.matrix) L.push('    strategy:', '      matrix:', '        node: ["18", "20"]');
  if (w.usesSecret) L.push('    env:', '      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}');
  const node = c.matrix ? '${{ matrix.node }}' : '"20"';
  L.push('    steps:', '      - uses: actions/checkout@v4');
  if (c.checkoutHead) L.push('        with:', '          ref: ${{ github.event.pull_request.head.sha }}');
  if (c.composite) L.push('      - uses: ./.github/actions/setup-node-deps', '        with:', `          node-version: ${node}`);
  else L.push(...setupSteps(c, node));
  L.push('      - run: npm test');
  if (w.thirdParty) {
    const ref = c.ref === 'sha' ? `${SHA} # v2.3.1` : c.ref === 'tag' ? 'v2' : 'main';
    L.push(`      - uses: acme-ci/notify-slack@${ref}`, '        if: always()', '        with:', '          channel: "#ci"');
  }
  const files = [{ path: '.github/workflows/ci.yml', text: `${L.join('\n')}\n` }];

  if (c.composite) {
    const A = [
      'name: Set up Node and install',
      'description: Set up Node.js and install dependencies (run actions/checkout first)',
      'inputs:',
      '  node-version:',
      '    description: Node.js version',
      '    default: "20"',
      'runs:',
      '  using: composite',
      '  steps:',
    ];
    A.push(...setupSteps(c, '${{ inputs.node-version }}', '    ', true));
    files.push({ path: '.github/actions/setup-node-deps/action.yml', text: `${A.join('\n')}\n` });
  }
  return files;
}

export function previewText(w) {
  return buildFiles(w)
    .map((f) => `# ${f.path}\n${f.text}`)
    .join('\n');
}

// ---------------------------------------------------------------- security score

export function securityScore(w) {
  const c = config(w);
  let score = 100;
  const notes = [];
  if (c.prt && c.checkoutHead && w.usesSecret) {
    score = 10;
    notes.push('pull_request_target checks out untrusted code with secrets in scope');
  }
  if (w.thirdParty && c.ref === 'main') {
    score -= 40;
    notes.push('third-party action floats on @main');
  } else if (w.thirdParty && c.ref === 'tag') {
    score -= 10;
    notes.push('third-party action pinned to a movable tag');
  }
  if (!c.perms) {
    score -= 25;
    notes.push('no permissions: block, so the token keeps the repository default');
  }
  return { score: clamp(score, 0, 100), notes };
}

// ---------------------------------------------------------------- one run through the workflow

// What running the current workflow on a PR costs and finds. Pure: it returns, the caller applies it.
function planPr(w, c, item) {
  const costs = w.costs;
  const fires = c.pr || c.prt;
  const r = { fired: fires, skipped: false, ran: false, tested: false, minutes: 0, feedback: null, lines: [], lintFail: false, caught: false, leak: false };
  const who = `PR #${item.pr} "${item.title}"`;
  r.lines.push({ kind: 'cmd', text: `${who} (${item.files === 'docs' ? 'docs only' : 'src'}${item.fork ? ', from a fork' : ''})` });
  if (!fires) {
    r.lines.push({ kind: 'out', text: '  no workflow listens to pull requests: nothing ran.' });
    return r;
  }
  r.lines.push({ kind: 'dim', text: `  triggered by: ${[c.pr ? 'pull_request' : null, c.prt ? 'pull_request_target' : null].filter(Boolean).join(', ')}` });
  if (item.files === 'docs' && c.pathsIgnore) {
    r.skipped = true;
    r.lines.push({ kind: 'out', text: '  - CI skipped: every changed file matches paths-ignore.   0 min' });
    return r;
  }
  r.ran = true;
  r.tested = c.pr || (c.prt && c.checkoutHead);
  if (!r.tested) r.lines.push({ kind: 'dim', text: '  pull_request_target checks out the base branch: the PR\'s own code is not tested.' });
  if (item.malicious && c.prt && c.checkoutHead && w.usesSecret) r.leak = true;

  const lint = costs.lint;
  const cells = c.matrix ? ['node 18', 'node 20'] : ['node 20'];
  const install = c.cache ? costs.installWarm : costs.installCold;
  const testMin = install + costs.tests;
  const lintFail = item.lint === 'fail' && r.tested;
  r.lintFail = lintFail;
  r.lines.push({ kind: lintFail ? 'err' : 'out', text: `  ${lintFail ? '✗' : '✓'} lint${' '.repeat(18)}${fmtMin(lint)} min` });
  r.minutes += lint;
  const testRuns = !(c.needs && lintFail);
  if (!testRuns) {
    r.lines.push({ kind: 'out', text: '  - test skipped: needs: lint did not pass.   0 min' });
    r.feedback = lint;
    return r;
  }
  const bugOn18 = item.bug === 'node18' && r.tested;
  const bugAny = item.bug === 'any' && r.tested;
  for (const cell of cells) {
    const fails = bugAny || (bugOn18 && cell === 'node 18');
    r.lines.push({ kind: fails ? 'err' : 'out', text: `  ${fails ? '✗' : '✓'} test (${cell})${' '.repeat(Math.max(1, 11 - cell.length))}${fmtMin(testMin)} min${c.cache ? '' : '  (npm ci downloaded everything again)'}` });
    r.minutes += testMin;
    if (fails) r.caught = true;
  }
  r.feedback = c.needs ? lint + testMin : Math.max(lint, testMin);
  return r;
}

function processPr(w, ctx, item) {
  const c = config(w);
  const r = planPr(w, c, item);
  for (const l of r.lines) say(w, l.text, l.kind);
  w.minutes += r.minutes;
  if (r.feedback !== null) w.feedback.push(r.feedback);
  say(w, r.ran ? `  billed ${fmtMin(r.minutes)} min · checks done in ${fmtMin(r.feedback)} min` : '  billed 0 min', 'dim');

  openEvent(w, ctx, item.event, `PR #${item.pr}`);
  const ok = (why) => closeEvent(w, ctx, item.event) && ctx.log(why, { kind: 'good' });
  const buggy = Boolean(item.bug);
  const shipsBug = buggy && !r.caught;

  if (r.leak) {
    w.leaked = true;
    w.penalty = 100;
    setHealth(w);
    say(w, '  ✗ the fork\'s script printed NPM_TOKEN to a public log', 'err');
    ctx.log('A fork PR ran with your secrets: the token was exfiltrated. Rotate it and rebuild the workflow.', { kind: 'event' });
    return;
  }
  if (shipsBug) {
    w.broken += 1;
    say(w, '  ! merged with a bug nobody saw', 'err');
    hurt(w, ctx, 25, r.ran ? 'The bug only fails on a version your workflow never tests, so it shipped.' : 'No check ran on the PR, so a broken change was merged.');
    return;
  }
  if (r.caught) {
    say(w, '  the failing check blocked the merge', 'dim');
    ok(item.bug === 'node18' ? 'The matrix caught the version-specific failure before it shipped.' : 'The failing check blocked the merge: the PR was tested.');
    return;
  }
  w.merged += item.lint === 'fail' ? 0 : 1;

  switch (item.event) {
    case 'docs-only-pr':
      if (r.skipped) ok('The path filter skipped the docs-only change: no minutes spent.');
      else hurt(w, ctx, 8, `The whole suite ran for a README edit (${fmtMin(r.minutes)} min).`);
      break;
    case 'cold-install':
      if (c.cache) ok('Dependencies came from the cache instead of the network.');
      else hurt(w, ctx, 8, 'Every run downloads and installs dependencies from scratch.');
      break;
    case 'lint-fail':
      if (c.needs) ok('needs: lint stopped the test job: minutes saved on a PR that could not merge.');
      else hurt(w, ctx, 8, 'The test suite ran in full on a PR that had already failed lint.');
      break;
    case 'fork-pr-secret':
      ok(r.tested ? 'The fork PR ran with a read-only token and no secrets: the malicious script printed nothing useful.' : 'The fork PR ran no code from the fork, so nothing leaked.');
      break;
    default:
      ok('Handled.');
  }
}

function processBurst(w, ctx, item) {
  const c = config(w);
  const costs = w.costs;
  const cells = c.matrix ? 2 : 1;
  const full = costs.lint + cells * ((c.cache ? costs.installWarm : costs.installCold) + costs.tests);
  say(w, `${item.n} pushes to PR #${item.pr} within a minute`, 'cmd');
  openEvent(w, ctx, item.event, `${item.n} pushes`);
  if (!(c.pr || c.prt)) {
    say(w, '  no workflow listens to pull requests: nothing ran.', 'out');
    return;
  }
  let minutes;
  if (c.concurrency) {
    minutes = (item.n - 1) * BILL_CANCELLED + full;
    say(w, `  ⊘ ${item.n - 1} older runs cancelled by concurrency (${fmtMin((item.n - 1) * BILL_CANCELLED)} min billed)`, 'out');
    say(w, `  ✓ latest run finished   ${fmtMin(full)} min`, 'out');
    closeEvent(w, ctx, item.event);
    ctx.log('concurrency with cancel-in-progress kept only the newest run.', { kind: 'good' });
  } else {
    minutes = item.n * full;
    for (let i = 1; i <= item.n; i += 1) say(w, `  ✓ run ${i} of ${item.n} finished   ${fmtMin(full)} min`, 'out');
    hurt(w, ctx, 10, `${item.n} redundant runs for one PR (${fmtMin(minutes)} min).`);
  }
  w.minutes += minutes;
  w.feedback.push(full);
  say(w, `  billed ${fmtMin(minutes)} min`, 'dim');
}

function processMaintenance(w, ctx, item) {
  const c = config(w);
  const fixed = item.what === 'lint' ? c.reusable : c.composite;
  say(w, `${item.title}`, 'cmd');
  openEvent(w, ctx, item.event, item.what === 'lint' ? 'lint rule changed' : 'Node setup changed');
  if (fixed) {
    say(w, `  one edit, every workflow uses it: ${item.what === 'lint' ? 'reusable-lint.yml' : 'setup-node-deps'} updated in one place.`, 'out');
    closeEvent(w, ctx, item.event);
    ctx.log(item.what === 'lint' ? 'One reusable workflow, one edit.' : 'One composite action, one edit.', { kind: 'good' });
  } else {
    say(w, '  edited three of the four copies: the last one still runs the old rule.', 'err');
    w.broken += 1;
    hurt(w, ctx, 10, 'Copy-pasted steps drifted apart.');
  }
}

function processCompromise(w, ctx, item) {
  const c = config(w);
  say(w, `${item.title}`, 'cmd');
  openEvent(w, ctx, item.event, 'acme-ci/notify-slack');
  if (!w.thirdParty) {
    closeEvent(w, ctx, item.event);
    return;
  }
  if (c.ref === 'main') {
    say(w, '  ✗ the next run pulled the compromised commit and ran it with the job\'s secrets', 'err');
    w.broken += 1;
    hurt(w, ctx, 35, 'A floating @main ref ran attacker code in your pipeline.');
  } else {
    say(w, `  ✓ ${c.ref === 'sha' ? 'the pinned commit is unchanged' : 'the v2 tag was not touched this time'}: nothing ran from the attacker's branch`, 'out');
    closeEvent(w, ctx, item.event);
    ctx.log(c.ref === 'sha' ? 'A full commit SHA cannot be repointed.' : 'The tag held this time, but a tag can be moved: a commit SHA cannot.', { kind: 'good' });
  }
}

function processToken(w, ctx, item) {
  const c = config(w);
  say(w, `${item.title}`, 'cmd');
  openEvent(w, ctx, item.event, 'GITHUB_TOKEN');
  if (c.perms) {
    say(w, '  ✓ git push failed: the token has contents: read only', 'out');
    closeEvent(w, ctx, item.event);
    ctx.log('permissions: contents: read limited what the stolen token could do.', { kind: 'good' });
  } else {
    say(w, '  ✗ git push succeeded: the token could write to the repository', 'err');
    w.broken += 1;
    hurt(w, ctx, 25, 'Without a permissions: block the token kept write access.');
  }
}

function pipelineTick(w, ctx) {
  const item = w.schedule.find((s) => s.tick === ctx.ticks);
  w.last = item || null;
  if (!item) return;
  const c = config(w);
  say(w, `-- event ${ctx.ticks} --`, 'dim');
  switch (item.kind) {
    case 'pr':
      processPr(w, ctx, item);
      break;
    case 'burst':
      processBurst(w, ctx, item);
      break;
    case 'maintenance':
      processMaintenance(w, ctx, item);
      break;
    case 'compromise':
      processCompromise(w, ctx, item);
      break;
    case 'token':
      processToken(w, ctx, item);
      break;
    default:
      throw new Error(`cicd sim: no handler for kind "${item.kind}"`);
  }
  if (c.schedule) {
    const full = w.costs.lint + (c.matrix ? 2 : 1) * ((c.cache ? w.costs.installWarm : w.costs.installCold) + w.costs.tests);
    w.minutes += full;
    say(w, `  schedule: the nightly run also billed ${fmtMin(full)} min`, 'dim');
  }
  w.minutes = round1(w.minutes);
  if (w.minutes > w.budget) {
    w.penalty = 100;
    ctx.log(`Out of runner minutes: ${fmtMin(w.minutes)} used of ${w.budget}. The month's CI bill blew the budget.`, { kind: 'event' });
  }
  setHealth(w);
}

export function incoming(w, ctx) {
  const next = w.schedule.find((s) => s.tick === ctx.ticks + 1);
  return next ? next.desc : null;
}

export function pipelineStats(w) {
  const sec = securityScore(w);
  return {
    minutes: w.minutes,
    budget: w.budget,
    median: median(w.feedback),
    security: w.goal.minSecurity ? sec.score : null,
    securityNotes: sec.notes,
    merged: w.merged,
    efficiency: w.minutes ? round1((w.merged / w.minutes) * 100) : null, // merged PRs per 100 minutes
  };
}

function pipelineGoals(w) {
  const s = pipelineStats(w);
  const goals = [{ id: 'budget', ok: s.minutes <= w.budget, text: `Runner minutes within the budget: ${fmtMin(s.minutes)} of ${w.budget}` }];
  if (w.goal.maxFeedback) {
    goals.push({ id: 'feedback', ok: s.median !== null && s.median <= w.goal.maxFeedback, text: `Median PR feedback at most ${w.goal.maxFeedback} min${s.median === null ? '' : ` (now ${fmtMin(round1(s.median))})`}` });
  }
  if (w.goal.minSecurity) goals.push({ id: 'security', ok: s.security >= w.goal.minSecurity, text: `Security score at least ${w.goal.minSecurity} (now ${s.security})` });
  goals.push({ id: 'broken', ok: w.broken === 0 && !w.leaked, text: `Nothing left broken or leaked (${w.broken} broken)` });
  return goals;
}

// ================================================================ deploy mode

const TRAFFIC = 1000; // requests per minute
const TILES = 20; // each tile is 5% of the fleet
const ROLL_STEP = 5; // rolling: 25% of the fleet per minute (a Kubernetes default of maxSurge/maxUnavailable)
const BAKE = 3; // minutes the new version must run at 100% before the release counts as shipped
const ALERT = 0.05;
const CANARY_STEPS = [5, 25, 50, 100];

function createDeploy(sc) {
  return {
    releases: sc.releases.map((r) => ({ ...r })),
    idx: 0,
    stage: 'dev', // dev | staging | prod
    soak: null, // null | 'running' | 'pass' | 'fail' (the staging smoke tests)
    rollout: null, // { kind, ... } while a prod rollout is under way
    skipped: false,
    expanded: false,
    contracted: false,
    drift: false,
    alerted: null, // minute the alert fired for the current release
    history: [], // { min, all, fresh, stable } per minute, newest last
    failedTotal: 0,
    failedRelease: 0,
    broken: 0, // a bad release left live, or a hand-patched hot-fix overwritten
    failScale: sc.failScale,
    settled: [], // { id, version, outcome, failed }
    minute: 0,
    startedAt: null,
    announced: false,
  };
}

export const currentRelease = (w) => w.releases[w.idx] || null;

export function newShare(w) {
  const r = w.rollout;
  if (!r) return 0;
  if (r.kind === 'rolling') return r.n / TILES;
  if (r.kind === 'canary') return r.pct / 100;
  if (r.kind === 'bluegreen') return r.live ? 1 : 0;
  return 0;
}

export function tileStates(w) {
  const share = newShare(w);
  const fresh = Math.round(share * TILES);
  return Array.from({ length: TILES }, (_, i) => (i < fresh ? 'new' : 'old'));
}

function arrive(w, ctx) {
  const r = currentRelease(w);
  if (!r) return;
  w.stage = 'dev';
  w.soak = null;
  w.rollout = null;
  w.skipped = false;
  w.expanded = false;
  w.contracted = false;
  w.alerted = null;
  w.failedRelease = 0;
  w.startedAt = null;
  w.history = [];
  say(w, `release ${r.version} is built and deployed to dev: ${r.title}`, 'cmd');
  for (const n of r.notes) say(w, `  - ${n}`, 'dim');
  if (r.migration === 'breaking') openEvent(w, ctx, 'breaking-migration', `${r.version} drops a column`);
}

export function startDeploy(w, ctx) {
  arrive(w, ctx);
  w.announced = true;
}

function settle(w, ctx, outcome) {
  const r = currentRelease(w);
  const bad = Boolean(r.bug);
  if (bad && outcome === 'shipped') {
    w.broken += 1;
    hurt(w, ctx, 30, `${r.version} is still broken and now fully live.`);
  }
  if (!bad && (outcome === 'rolled-back' || outcome === 'rejected')) hurt(w, ctx, 15, `${r.version} was fine: holding it back cost the team a day.`);
  if (bad && w.alerted !== null && outcome === 'rolled-back') {
    ctx.log(`Time to rollback: ${w.minute - w.alerted} min after the alert. Failed requests for ${r.version}: ${w.failedRelease}.`, { kind: 'good' });
  }
  if (bad && (outcome === 'rolled-back' || outcome === 'rejected')) {
    for (const id of ['bad-rolling', 'bad-bluegreen', 'bad-canary', 'smoke-caught', 'staging-gate']) closeEvent(w, ctx, id);
  }
  w.settled.push({ id: r.id, version: r.version, outcome, failed: w.failedRelease });
  say(w, `release ${r.version}: ${outcome}`, 'cmd');
  w.idx += 1;
  w.rollout = null;
  w.contracted = false;
  setHealth(w);
  if (currentRelease(w)) arrive(w, ctx);
}

const KUBECTL = {
  rolling: ['$ kubectl set image deployment/shop web=shop:{v}', 'deployment.apps/shop image updated'],
  bluegreen: ['$ kubectl apply -f shop-green.yaml   # the full v{v} environment, taking no traffic yet', 'deployment.apps/shop-green created'],
  canary: ['$ kubectl scale deployment/shop-canary --replicas=1   # 5% of the pods run {v}', 'deployment.apps/shop-canary scaled'],
};

// ---------------------------------------------------------------- the player's moves

function refuse(w, text) {
  say(w, text, 'err');
  return false;
}

export function promote(w, ctx) {
  const r = currentRelease(w);
  if (!r || w.stage !== 'dev') return refuse(w, 'Only a release sitting in dev can be promoted to staging.');
  w.stage = 'staging';
  w.soak = 'running';
  say(w, `$ gh workflow run deploy.yml -f environment=staging -f version=${r.version}`, 'cmd');
  say(w, '✓ Created workflow_dispatch event. Staging smoke tests are running...', 'out');
  return true;
}

export function reject(w, ctx) {
  const r = currentRelease(w);
  if (!r || w.rollout || w.stage === 'prod') return refuse(w, 'There is nothing to reject: the release is already rolling out.');
  say(w, `${r.version} rejected at the ${w.stage} gate: it never reaches prod.`, 'out');
  if (w.stage === 'staging' && w.soak === 'fail') closeEvent(w, ctx, 'staging-gate');
  settle(w, ctx, 'rejected');
  return true;
}

export function expand(w, ctx) {
  const r = currentRelease(w);
  if (!r || r.migration !== 'breaking' || w.expanded || w.rollout) return refuse(w, 'Nothing to expand: this release has no breaking migration, or it is already rolling out.');
  w.expanded = true;
  say(w, '$ migrate -database "$DATABASE_URL" -path migrations up 1   # 0042a_add_total.up.sql', 'cmd');
  say(w, '0042a/u add_total (backward compatible: adds a column, old code ignores it)', 'out');
  say(w, 'The destructive step (drop legacy_total) waits for a later release.', 'dim');
  closeEvent(w, ctx, 'breaking-migration');
  return true;
}

export function commitHotfix(w, ctx) {
  if (!w.drift) return refuse(w, 'Prod already matches git: nothing to commit.');
  w.drift = false;
  say(w, '$ git commit -am "Raise the checkout timeout to 30s (hot-fix from prod)" && git push', 'cmd');
  say(w, 'The operator syncs: prod now matches git, and the hot-fix is in the next release.', 'out');
  closeEvent(w, ctx, 'hotfix-drift');
  return true;
}

export function deploy(w, ctx, kind) {
  const r = currentRelease(w);
  if (!r || w.rollout) return refuse(w, 'A rollout is already running.');
  if (!['rolling', 'bluegreen', 'canary'].includes(kind)) return refuse(w, `Unknown strategy "${kind}".`);
  if (w.stage === 'staging' && w.soak === 'running') return refuse(w, 'Staging is still soaking: wait a minute for the smoke tests.');
  if (w.stage === 'dev') {
    w.skipped = true;
    say(w, 'Skipping staging: no environment between dev and prod saw this release.', 'err');
  } else if (w.soak === 'fail') {
    w.skipped = true;
    say(w, 'Deploying with a failing staging gate.', 'err');
  }
  if (r.bug && r.bug.staging && w.skipped) {
    openEvent(w, ctx, 'skipped-staging', r.version);
    hurt(w, ctx, 10, 'A bug the staging soak would have caught went to prod.');
  }
  w.stage = 'prod';
  if (w.drift) {
    w.drift = false;
    w.broken += 1;
    hurt(w, ctx, 15, 'The deploy overwrote the hand-patched hot-fix: the checkout timeouts are back.');
  }
  if (r.migration === 'breaking' && !w.expanded) {
    w.contracted = true;
    say(w, '$ migrate -database "$DATABASE_URL" -path migrations up 1   # 0042_drop_legacy_total.up.sql', 'cmd');
    say(w, '0042/u drop_legacy_total (the old version still reads this column)', 'err');
  }
  const [cmd, ack] = KUBECTL[kind];
  say(w, cmd.replace('{v}', r.version), 'cmd');
  say(w, ack, 'out');
  w.startedAt = w.minute;
  if (kind === 'rolling') w.rollout = { kind, n: 0, dir: 1, bake: 0 };
  else if (kind === 'bluegreen') w.rollout = { kind, built: false, live: false, smoke: null, bake: 0 };
  else w.rollout = { kind, pct: 5, bake: 0, step: 0 };
  return true;
}

export function cutover(w, ctx) {
  const r = w.rollout;
  if (!r || r.kind !== 'bluegreen' || !r.built || r.live) return refuse(w, 'Cutover needs a blue-green deployment whose green side is ready and not yet live.');
  r.live = true;
  say(w, '$ kubectl patch service shop -p \'{"spec":{"selector":{"track":"green"}}}\'', 'cmd');
  say(w, 'service/shop patched   # 100% of traffic now goes to green', 'out');
  return true;
}

export function widen(w, ctx) {
  const r = w.rollout;
  if (!r || r.kind !== 'canary' || r.pct >= 100 || r.back) return refuse(w, 'Widening needs a canary rollout that is not yet at 100%.');
  r.step += 1;
  r.pct = CANARY_STEPS[r.step];
  say(w, `$ kubectl scale deployment/shop-canary --replicas=${Math.round((r.pct / 100) * TILES)}   # ${r.pct}% of traffic`, 'cmd');
  return true;
}

export function rollback(w, ctx) {
  const rel = currentRelease(w);
  const r = w.rollout;
  if (!rel || !r) return refuse(w, 'Nothing to roll back: no rollout is running. Reject a release before prod instead.');
  if (w.contracted) {
    return refuse(w, 'Rollback refused: migration 0042 already dropped legacy_total, so the previous version cannot start against this schema. Roll forward instead.');
  }
  if (r.kind === 'rolling') {
    if (r.dir === -1) return refuse(w, 'The rollback is already running.');
    r.dir = -1;
    say(w, '$ kubectl rollout undo deployment/shop', 'cmd');
    say(w, 'deployment.apps/shop rolled back   # replacing the new pods again, batch by batch', 'out');
    return true;
  }
  if (r.kind === 'bluegreen') {
    say(w, r.live ? '$ kubectl patch service shop -p \'{"spec":{"selector":{"track":"blue"}}}\'' : '$ kubectl delete -f shop-green.yaml', 'cmd');
    say(w, r.live ? 'service/shop patched   # traffic is back on blue, instantly' : 'green torn down: it never took traffic', 'out');
  } else {
    say(w, '$ kubectl scale deployment/shop-canary --replicas=0', 'cmd');
    say(w, 'deployment.apps/shop-canary scaled   # canary weight back to 0%', 'out');
  }
  w.rollout = null;
  settle(w, ctx, 'rolled-back');
  return true;
}

// Roll forward: the fix for a breaking migration that cannot be undone. Slow, and the damage continues meanwhile.
export function rollForward(w, ctx) {
  const rel = currentRelease(w);
  const r = w.rollout;
  if (!rel || !r || !w.contracted) return refuse(w, 'Rolling forward only applies when a rollback is impossible.');
  if (r.fix) return refuse(w, 'The fix is already building.');
  r.fix = 3;
  say(w, '$ git revert -n HEAD && git push   # a forward fix, through the whole pipeline', 'cmd');
  say(w, 'Fix build queued: it needs several minutes to reach prod.', 'dim');
  return true;
}

// ---------------------------------------------------------------- the minute clock

function deployTick(w, ctx) {
  deployMinute(w, ctx);
  if (w.minute >= w.winTicks && !isDone(w)) {
    // The window closed with releases still waiting: that costs most of the day's health.
    w.penalty = Math.max(w.penalty, 60);
    setHealth(w);
  }
}

function deployMinute(w, ctx) {
  // Draw the same number of values every minute, whatever the player did.
  const noiseA = ctx.rng();
  const noiseB = ctx.rng();
  w.minute += 1;
  const rel = currentRelease(w);

  for (const item of w.schedule) {
    if (item.tick !== ctx.ticks) continue;
    if (item.kind === 'drift') {
      w.drift = true;
      say(w, 'ALERT: 4 prod pods run an image tag that is not in git (someone ran kubectl set image by hand at 02:10).', 'err');
      openEvent(w, ctx, item.event, '4 pods');
    } else throw new Error(`cicd sim: no handler for kind "${item.kind}"`);
  }
  if (!rel) {
    setHealth(w);
    return;
  }

  // Staging soak.
  if (w.stage === 'staging' && w.soak === 'running') {
    w.soak = rel.bug && rel.bug.staging ? 'fail' : 'pass';
    if (w.soak === 'fail') {
      say(w, '✗ staging smoke tests: POST /checkout returned 500 (3 of 12 checks failed)', 'err');
      openEvent(w, ctx, 'staging-gate', rel.version);
    } else say(w, '✓ staging smoke tests: 12 of 12 checks passed', 'out');
  }

  const r = w.rollout;
  if (r) {
    // Progress the rollout.
    if (r.kind === 'rolling') {
      r.n = clamp(r.n + ROLL_STEP * r.dir, 0, TILES);
      say(w, r.dir > 0 ? `Waiting for deployment "shop" rollout to finish: ${r.n} out of ${TILES} new replicas have been updated...` : `Rolling back: ${TILES - r.n} of ${TILES} replicas are on the previous version...`, 'out');
      if (r.dir > 0 && r.n >= TILES) {
        say(w, 'deployment "shop" successfully rolled out', 'out');
        r.baking = true;
      }
    } else if (r.kind === 'bluegreen' && !r.built) {
      r.built = true;
      r.smoke = rel.bug && rel.bug.smoke ? 'fail' : 'pass';
      if (r.smoke === 'fail') {
        say(w, '✗ smoke tests against green: GET /cart returned 500 (green takes no user traffic yet)', 'err');
        openEvent(w, ctx, 'smoke-caught', rel.version);
      } else say(w, '✓ smoke tests against green passed: 12 of 12 checks. Green is ready and takes no user traffic yet.', 'out');
    } else if (r.kind === 'canary' && r.pct >= 100) r.baking = true;
    if (r.kind === 'bluegreen' && r.live) r.baking = true;
  }

  // Traffic and errors for this minute.
  const base = 0.002 + noiseA * 0.004;
  const share = newShare(w);
  const bad = rel.bug && w.rollout ? rel.bug.err : 0;
  let excess = TRAFFIC * share * bad;
  if (w.contracted) excess += TRAFFIC * (1 - share) * 0.7;
  const fresh = share > 0 ? base + bad + noiseB * 0.004 : null;
  const stable = share < 1 ? base + (w.contracted ? 0.7 : 0) : null;
  const all = base + excess / TRAFFIC;
  w.history.push({ min: w.minute, all, fresh, stable });
  if (w.history.length > 14) w.history.shift();
  excess = Math.round(excess);
  w.failedTotal += excess;
  w.failedRelease += excess;

  if (w.rollout && w.alerted === null && ((fresh !== null && fresh >= ALERT) || (stable !== null && stable >= ALERT))) {
    w.alerted = w.minute;
    const what = fresh !== null && fresh >= ALERT ? `new version error rate ${Math.round(fresh * 100)}%` : `stable version error rate ${Math.round(stable * 100)}%`;
    say(w, `ALERT: ${what} (threshold ${ALERT * 100}%)`, 'err');
    const kind = w.rollout.kind;
    if (!w.contracted) openEvent(w, ctx, `bad-${kind}`, `${rel.version}, ${Math.round(share * 100)}% of traffic`);
  }

  // Roll-forward fix after a breaking migration.
  if (w.rollout && w.rollout.fix) {
    w.rollout.fix -= 1;
    if (w.rollout.fix <= 0) {
      say(w, 'The forward fix is live: the old schema reads work again.', 'out');
      w.contracted = false;
      w.rollout = null;
      settle(w, ctx, 'shipped');
      setHealth(w);
      return;
    }
  }

  // Bake time at 100%, then the release counts as shipped.
  if (w.rollout && w.rollout.baking && !(w.rollout.kind === 'rolling' && w.rollout.dir < 0)) {
    w.rollout.bake += 1;
    if (w.rollout.bake >= BAKE) {
      settle(w, ctx, 'shipped');
      setHealth(w);
      return;
    }
  }

  // Rolling rollback finished.
  if (w.rollout && w.rollout.kind === 'rolling' && w.rollout.dir < 0 && w.rollout.n === 0) {
    w.rollout = null;
    settle(w, ctx, 'rolled-back');
  }
  setHealth(w);
}

export function deployGoals(w) {
  const cur = currentRelease(w);
  return [
    { id: 'releases', ok: !cur, text: `Every release settled: ${w.settled.length} of ${w.releases.length}` },
    { id: 'drift', ok: !w.drift, text: w.drift ? 'Prod differs from git: commit the hot-fix' : 'Prod matches git' },
    { id: 'broken', ok: w.broken === 0, text: `Nothing left broken (${w.broken} broken)` },
    { id: 'health', ok: w.health >= w.minHealth, text: `Delivery health at least ${w.minHealth} (now ${w.health})` },
  ];
}

// ================================================================ actions

// Every move the player can make, in one place so game.js and the headless tests drive the same code.
// Returns false (rejected or read-only), 'free' (valid but unscored) or true (a counted move).
export function applyAction(w, ctx, name, ...args) {
  const deployOnly = () => (w.mode === 'deploy' ? null : refuse(w, 'That only applies on Deploy Day.'));
  switch (name) {
    case 'place':
      return w.mode === 'pipeline' && placeCard(w, args[0]) ? 'free' : false;
    case 'remove':
      return w.mode === 'pipeline' && removeCard(w, args[0]) ? 'free' : false;
    case 'runNext':
      if (w.mode !== 'pipeline') return false;
      ctx.step();
      return true;
    case 'wait':
      if (w.mode !== 'deploy') return false;
      ctx.step();
      return 'free';
    case 'promote':
      return deployOnly() ?? promote(w, ctx);
    case 'reject':
      return deployOnly() ?? reject(w, ctx);
    case 'expand':
      return deployOnly() ?? expand(w, ctx);
    case 'commit':
      return deployOnly() ?? commitHotfix(w, ctx);
    case 'deploy':
      return deployOnly() ?? deploy(w, ctx, args[0]);
    case 'cutover':
      return deployOnly() ?? cutover(w, ctx);
    case 'widen':
      return deployOnly() ?? widen(w, ctx);
    case 'rollback':
      return deployOnly() ?? rollback(w, ctx);
    case 'rollForward':
      return deployOnly() ?? rollForward(w, ctx);
    default:
      throw new Error(`cicd sim: unknown action "${name}"`);
  }
}

// ================================================================ the clock, win and loss

export function tick(w, ctx) {
  w.ticks = ctx.ticks;
  if (w.mode === 'pipeline') pipelineTick(w, ctx);
  else deployTick(w, ctx);
}

export const goals = (w) => (w.mode === 'pipeline' ? pipelineGoals(w) : deployGoals(w));

export function isDone(w) {
  if (w.mode === 'pipeline') return w.ticks >= w.winTicks;
  return w.idx >= w.releases.length && !w.drift && !w.schedule.some((s) => s.tick > w.ticks);
}

export function isWon(w) {
  if (w.leaked || w.health < w.minHealth || !isDone(w)) return false;
  return goals(w).every((g) => g.ok);
}

export function isLost(w) {
  if (w.leaked || w.health < w.minHealth) return true;
  if (w.mode === 'pipeline') {
    if (w.minutes > w.budget) return true;
    return isDone(w) && !goals(w).every((g) => g.ok);
  }
  if (isDone(w)) return !goals(w).every((g) => g.ok);
  return w.ticks >= w.winTicks; // the deploy window closed with work left
}

export { fmtMin, median };
