// A small git + `gh` simulator for the "Merge Conflict Rush" game. Pure logic, no DOM.
//
// It models what topics/github/notes/01-03 teach, over an in-memory commit graph:
//   * commits are immutable snapshots with parents; a branch is a movable pointer; HEAD names the
//     checked-out branch (or a commit, when detached); remote-tracking refs (origin/*) are only
//     updated by fetch, pull and push;
//   * merge makes a merge commit unless the branch can fast-forward; rebase replays commits and so
//     creates new commit IDs; revert adds a commit; reset moves a branch, and --hard throws away
//     uncommitted work; cherry-pick copies one commit;
//   * two branches that edit the same lines conflict: the file gets <<<<<<< / ======= / >>>>>>>
//     markers and the operation waits for you to resolve, `git add`, and continue;
//   * `origin` is a second set of branches that teammates push to between your commands; the
//     "GitHub" side has pull requests, code-owner reviews, required checks and branch protection.
// Scenario data (history, remote, protection, owners, goals) comes from scenarios.json.

const clone = (o) => JSON.parse(JSON.stringify(o));
export const ME = 'you';
const REPO = 'acme/site';
const HOST = 'github.com:acme/site.git';
const WEB = 'https://github.com/acme/site';

// ---------------------------------------------------------------- small helpers

export function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (quote) return null;
  if (cur || has) out.push(cur);
  return out;
}

function hash7(str) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 7);
}

const lines = (t) => (t === '' || t === undefined ? [] : t.split('\n'));
const joinLines = (a) => a.join('\n');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const paths = (...trees) => [...new Set(trees.flatMap((t) => Object.keys(t)))].sort();
const treeEq = (a, b) => paths(a, b).every((p) => a[p] === b[p]);
export const hasMarkers = (text) => /^<{7}( |$)/m.test(text || '') && /^>{7}( |$)/m.test(text || '');

function say(w, text, kind = 'out') {
  for (const l of String(text).split('\n')) w.term.push({ kind, text: l });
  if (w.term.length > 300) w.term.splice(0, w.term.length - 300);
}
function fail(w, text) {
  say(w, text, 'err');
  return false;
}

// ---------------------------------------------------------------- diff and merge

function lcsMap(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const map = new Map();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      map.set(i, j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return map;
}

function diffLines(a, b) {
  const map = lcsMap(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && map.has(i) && map.get(i) === j) {
      ops.push({ t: ' ', s: a[i] });
      i++;
      j++;
    } else if (i < a.length && !map.has(i)) {
      ops.push({ t: '-', s: a[i] });
      i++;
    } else {
      ops.push({ t: '+', s: b[j] });
      j++;
    }
  }
  return ops;
}

function hunkText(ops) {
  const changed = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const groups = [];
  let start = changed[0];
  let end = changed[0];
  for (const i of changed.slice(1)) {
    if (i - end <= 6) end = i;
    else {
      groups.push([start, end]);
      start = end = i;
    }
  }
  groups.push([start, end]);
  const out = [];
  for (const [s, e] of groups) {
    const from = Math.max(0, s - 3);
    const to = Math.min(ops.length - 1, e + 3);
    const before = ops.slice(0, from);
    const slice = ops.slice(from, to + 1);
    const aStart = before.filter((o) => o.t !== '+').length + 1;
    const bStart = before.filter((o) => o.t !== '-').length + 1;
    const aCount = slice.filter((o) => o.t !== '+').length;
    const bCount = slice.filter((o) => o.t !== '-').length;
    const rng = (st, c) => (c === 1 ? `${st}` : `${st},${c}`);
    out.push(`@@ -${rng(aStart, aCount)} +${rng(bStart, bCount)} @@`);
    for (const o of slice) out.push(`${o.t}${o.s}`);
  }
  return out;
}

// Three-way line merge. A "sync" line is one both sides kept; between them, a side that did not
// change takes the other side's change, and two different changes are a conflict.
export function merge3(base, ours, theirs, labels) {
  const A = lcsMap(base, ours);
  const B = lcsMap(base, theirs);
  const sync = [];
  for (let i = 0; i < base.length; i++) if (A.has(i) && B.has(i)) sync.push([i, A.get(i), B.get(i)]);
  sync.push([base.length, ours.length, theirs.length]);
  const eq = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
  const out = [];
  let conflict = false;
  let ib = 0;
  let ia = 0;
  let it = 0;
  for (const [bi, ai, ti] of sync) {
    const cb = base.slice(ib, bi);
    const ca = ours.slice(ia, ai);
    const ct = theirs.slice(it, ti);
    if (eq(ca, cb)) out.push(...ct);
    else if (eq(ct, cb) || eq(ca, ct)) out.push(...ca);
    else {
      conflict = true;
      out.push(`<<<<<<< ${labels.ours}`, ...ca, '=======', ...ct, `>>>>>>> ${labels.theirs}`);
    }
    if (bi < base.length) out.push(base[bi]);
    ib = bi + 1;
    ia = ai + 1;
    it = ti + 1;
  }
  return { lines: out, conflict };
}

export function mergeTrees(base, ours, theirs, labels) {
  const tree = {};
  const conflicts = [];
  for (const p of paths(base, ours, theirs)) {
    const b = base[p];
    const o = ours[p];
    const t = theirs[p];
    let v;
    if (o === t) v = o;
    else if (o === b) v = t;
    else if (t === b) v = o;
    else if (o === undefined || t === undefined) {
      v = o === undefined ? t : o;
      conflicts.push({ path: p, kind: 'modify/delete' });
    } else {
      const r = merge3(lines(b ?? ''), lines(o), lines(t), labels);
      v = joinLines(r.lines);
      if (r.conflict) conflicts.push({ path: p, kind: 'content' });
    }
    if (v !== undefined) tree[p] = v;
  }
  return { tree, conflicts };
}

function treeDiff(a, b) {
  return paths(a, b)
    .filter((p) => a[p] !== b[p])
    .map((p) => {
      const kind = a[p] === undefined ? 'new' : b[p] === undefined ? 'deleted' : 'modified';
      const ops = diffLines(lines(a[p] ?? ''), lines(b[p] ?? ''));
      return { path: p, kind, ops, add: ops.filter((o) => o.t === '+').length, del: ops.filter((o) => o.t === '-').length };
    });
}

function statLine(d) {
  const ins = d.reduce((s, f) => s + f.add, 0);
  const del = d.reduce((s, f) => s + f.del, 0);
  let t = ` ${plural(d.length, 'file')} changed`;
  if (ins) t += `, ${plural(ins, 'insertion')}(+)`;
  if (del) t += `, ${plural(del, 'deletion')}(-)`;
  return t;
}

function statBlock(d) {
  const width = Math.max(...d.map((f) => f.path.length));
  return [...d.map((f) => ` ${f.path.padEnd(width)} | ${f.add + f.del} ${'+'.repeat(f.add)}${'-'.repeat(f.del)}`), statLine(d)];
}

function modeLines(d) {
  return d.filter((f) => f.kind !== 'modified').map((f) => ` ${f.kind === 'new' ? 'create' : 'delete'} mode 100644 ${f.path}`);
}

function patchText(d) {
  const out = [];
  for (const f of d) {
    out.push(`diff --git a/${f.path} b/${f.path}`);
    if (f.kind === 'new') out.push('new file mode 100644');
    if (f.kind === 'deleted') out.push('deleted file mode 100644');
    out.push(`--- ${f.kind === 'new' ? '/dev/null' : `a/${f.path}`}`, `+++ ${f.kind === 'deleted' ? '/dev/null' : `b/${f.path}`}`, ...hunkText(f.ops));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- repository model

const commitOf = (w, id) => w.commits[id];
const subject = (c) => c.msg.split('\n')[0];
const headId = (w) => (w.head.branch ? w.branches[w.head.branch] : w.head.detached);
const headTree = (w) => w.commits[headId(w)].tree;
const byNewest = (w) => (a, b) => w.commits[b].n - w.commits[a].n;

function newCommit(w, { parents, msg, tree, author }) {
  const n = ++w.seq;
  let id = hash7(JSON.stringify([parents, msg, tree, author, n]));
  while (w.commits[id]) id = hash7(id + n);
  w.commits[id] = { id, n, parents, msg, tree: { ...tree }, author };
  return id;
}

function ancestors(w, ids) {
  const seen = new Set();
  const stack = [...ids].filter(Boolean);
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...w.commits[id].parents);
  }
  return seen;
}

const isAncestor = (w, a, b) => ancestors(w, [b]).has(a);

function mergeBase(w, a, b) {
  const sa = ancestors(w, [a]);
  const sb = ancestors(w, [b]);
  const common = [...sa].filter((id) => sb.has(id));
  common.sort(byNewest(w));
  return common[0] ?? null;
}

// Commits in `include` that are not in `exclude`, oldest first.
function commitsBetween(w, exclude, include) {
  const ex = ancestors(w, [exclude]);
  return [...ancestors(w, [include])].filter((id) => !ex.has(id)).sort((a, b) => w.commits[a].n - w.commits[b].n);
}

function allTips(w) {
  const tips = [...Object.values(w.branches), ...Object.values(w.tags).map((t) => t.id), ...Object.values(w.tracking)];
  if (w.head.detached) tips.push(w.head.detached);
  if (w.op && w.op.kind === 'rebase') tips.push(w.op.orig);
  return tips;
}

const knownCommits = (w) => ancestors(w, allTips(w));

function resolveName(w, name) {
  if (name === 'HEAD' || name === '@') return headId(w);
  const lg = name.match(/^HEAD@\{(\d+)\}$/);
  if (lg) return w.reflog[Number(lg[1])]?.id ?? null;
  if (name in w.branches) return w.branches[name];
  if (name in w.tracking) return w.tracking[name];
  if (name.startsWith('refs/heads/') && name.slice(11) in w.branches) return w.branches[name.slice(11)];
  if (name in w.tags) return w.tags[name].id;
  if (/^[0-9a-f]{4,40}$/.test(name)) {
    const known = knownCommits(w);
    const hit = [...known].filter((id) => id.startsWith(name.slice(0, 7)) || name.startsWith(id));
    if (hit.length === 1) return hit[0];
  }
  return null;
}

function resolveRev(w, rev) {
  if (!rev) return null;
  const m = rev.match(/^([^~^]+)((?:[~^]\d*)+)$/);
  let id = resolveName(w, m ? m[1] : rev);
  if (!id || !m) return id;
  for (const [, op, num] of m[2].matchAll(/([~^])(\d*)/g)) {
    const n = num === '' ? 1 : Number(num);
    if (op === '^' && n === 0) continue;
    if (op === '~') {
      for (let i = 0; i < n; i++) {
        id = w.commits[id].parents[0];
        if (!id) return null;
      }
    } else {
      id = w.commits[id].parents[n - 1];
      if (!id) return null;
    }
  }
  return id;
}

function setHead(w, id, why) {
  if (w.head.branch) w.branches[w.head.branch] = id;
  else w.head = { detached: id };
  w.reflog.unshift({ id, text: why });
}

function decorations(w, id) {
  const out = [];
  const hb = w.head.branch;
  if (hb && w.branches[hb] === id) out.push({ kind: 'head', text: `HEAD -> ${hb}` });
  else if (!hb && w.head.detached === id) out.push({ kind: 'head', text: 'HEAD' });
  for (const [b, bid] of Object.entries(w.branches)) if (bid === id && b !== hb) out.push({ kind: 'branch', text: b });
  for (const [t, tag] of Object.entries(w.tags)) if (tag.id === id) out.push({ kind: 'tag', text: `tag: ${t}` });
  for (const [r, rid] of Object.entries(w.tracking)) if (rid === id) out.push({ kind: 'remote', text: r });
  return out;
}

const decoText = (w, id) => {
  const d = decorations(w, id);
  return d.length ? ` (${d.map((x) => x.text).join(', ')})` : '';
};

function aheadBehind(w, local, upstream) {
  const a = ancestors(w, [local]);
  const b = ancestors(w, [upstream]);
  return { ahead: [...a].filter((x) => !b.has(x)).length, behind: [...b].filter((x) => !a.has(x)).length };
}

// ---------------------------------------------------------------- work tree and index

function workStatus(w) {
  const head = headTree(w);
  const um = new Set(w.unmerged);
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const p of paths(head, w.index)) {
    if (um.has(p) || head[p] === w.index[p]) continue;
    staged.push({ path: p, kind: head[p] === undefined ? 'new file' : w.index[p] === undefined ? 'deleted' : 'modified' });
  }
  for (const p of Object.keys(w.index)) {
    if (um.has(p)) continue;
    if (w.worktree[p] === undefined) unstaged.push({ path: p, kind: 'deleted' });
    else if (w.worktree[p] !== w.index[p]) unstaged.push({ path: p, kind: 'modified' });
  }
  for (const p of Object.keys(w.worktree).sort()) if (!(p in w.index) && !um.has(p)) untracked.push({ path: p, kind: 'untracked' });
  return { branch: w.head.branch || null, staged, unstaged: unstaged.sort((a, b) => a.path.localeCompare(b.path)), untracked, unmerged: [...w.unmerged], op: w.op ? w.op.kind : null };
}
export { workStatus };

const isClean = (w) => {
  const s = workStatus(w);
  return !s.staged.length && !s.unstaged.length && !s.unmerged.length;
};

// Files whose uncommitted state would be overwritten if `paths` changed.
function localChanges(w, changed) {
  const head = headTree(w);
  return changed.filter((p) => w.index[p] !== head[p] || (w.worktree[p] !== head[p] && p in w.index) || (!(p in head) && p in w.worktree) || w.unmerged.includes(p));
}

// Move index and work tree from `from` to `to` for every path that differs, keeping other edits.
function applyTree(w, from, to) {
  for (const p of paths(from, to)) {
    if (from[p] === to[p]) continue;
    if (to[p] === undefined) {
      delete w.index[p];
      delete w.worktree[p];
    } else {
      w.index[p] = to[p];
      w.worktree[p] = to[p];
    }
  }
}

function enterConflict(w, ours, result) {
  const untracked = {};
  for (const p of Object.keys(w.worktree)) if (!(p in w.index)) untracked[p] = w.worktree[p];
  const bad = new Set(result.conflicts.map((c) => c.path));
  w.index = {};
  for (const p of Object.keys(result.tree)) if (!bad.has(p)) w.index[p] = result.tree[p];
  for (const p of bad) if (ours[p] !== undefined) w.index[p] = ours[p];
  w.worktree = { ...untracked, ...result.tree };
  w.unmerged = [...bad];
}

function conflictReport(w, result) {
  const out = [];
  for (const c of result.conflicts) {
    out.push(c.kind === 'content' ? `Auto-merging ${c.path}` : '', c.kind === 'content' ? `CONFLICT (content): Merge conflict in ${c.path}` : `CONFLICT (modify/delete): ${c.path} deleted in one branch and modified in the other.`);
  }
  return out.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- remote (GitHub) model

const remoteTree = (w, branch) => (w.remote.refs[branch] ? w.commits[w.remote.refs[branch]].tree : {});

function ownersFor(w, path) {
  let owners = [];
  for (const rule of w.owners) {
    const pat = rule.pattern;
    let hit;
    if (pat === '*') hit = true;
    else if (pat.startsWith('/')) hit = pat.endsWith('/') ? path.startsWith(pat.slice(1)) : path === pat.slice(1);
    else hit = path.endsWith(pat) || path.startsWith(pat);
    if (hit) owners = rule.owners;
  }
  return owners.map((o) => o.replace(/^@/, ''));
}

function prHeadTip(w, pr) {
  return w.remote.refs[pr.head] ?? pr.headTip;
}

function prChangedFiles(w, pr) {
  const base = w.remote.refs[pr.base];
  const head = prHeadTip(w, pr);
  const mb = mergeBase(w, base, head);
  return treeDiff(mb ? w.commits[mb].tree : {}, w.commits[head].tree).map((f) => f.path);
}

function runChecks(w, tree) {
  const results = [];
  for (const name of w.protection.checks || []) {
    const bad = (w.buildRules || []).find((r) => r.check === name && lines(tree[r.file] ?? '').some((l) => new RegExp(r.forbid).test(l)));
    results.push({ name, state: bad ? 'fail' : 'pass', log: bad ? bad.message : '' });
  }
  return results;
}

function prChecks(w, pr) {
  return runChecks(w, w.commits[prHeadTip(w, pr)].tree);
}

function prMergeability(w, pr) {
  const base = w.remote.refs[pr.base];
  const head = prHeadTip(w, pr);
  const mb = mergeBase(w, base, head);
  const res = mergeTrees(mb ? w.commits[mb].tree : {}, w.commits[base].tree, w.commits[head].tree, { ours: pr.base, theirs: pr.head });
  return { mb, res, conflicts: res.conflicts.length > 0 };
}

// Reasons GitHub would refuse to merge this PR into a protected branch.
function prBlockers(w, pr) {
  const out = [];
  if (pr.draft) out.push({ id: 'draft', text: 'this pull request is still a draft' });
  if (prMergeability(w, pr).conflicts) out.push({ id: 'conflict', text: 'this branch has conflicts that must be resolved' });
  const p = w.protection;
  if (p.branch === pr.base) {
    if (p.approvals === 'codeowner') {
      const missing = [];
      for (const path of prChangedFiles(w, pr)) {
        const owners = ownersFor(w, path);
        if (owners.length && !owners.some((o) => pr.reviewers.some((r) => r.name === o && r.state === 'approved'))) missing.push(`${path} needs ${owners.map((o) => `@${o}`).join(' or ')}`);
      }
      if (missing.length) out.push({ id: 'owner', text: `code owner review required (${[...new Set(missing)].join('; ')})` });
    }
    const failing = prChecks(w, pr).filter((c) => c.state === 'fail');
    if (failing.length) out.push({ id: 'checks', text: `required status check failing: ${failing.map((c) => c.name).join(', ')}` });
  }
  return out;
}

function requestReviewers(w, ctx, pr, names) {
  for (const name of names) {
    if (name === pr.author || pr.reviewers.some((r) => r.name === name)) continue;
    pr.reviewers.push({ name, state: 'requested', at: ctx.ticks + 1 });
  }
}

function requestOwners(w, ctx, pr) {
  const names = new Set();
  for (const path of prChangedFiles(w, pr)) ownersFor(w, path).forEach((o) => names.add(o));
  requestReviewers(w, ctx, pr, [...names]);
}

const prByNumber = (w, n) => w.remote.prs.find((p) => p.n === Number(n));

// ---------------------------------------------------------------- scoring and lessons

function lesson(w, ctx, id, detail) {
  if (w.lessons.has(id)) return;
  w.lessons.add(id);
  ctx.fire(id, detail);
  ctx.resolve(id);
}

function penalize(w, ctx, id, amount, detail) {
  w.health = Math.max(0, w.health - amount);
  ctx.fire(id, detail);
  ctx.resolve(id);
  ctx.log(`Team trust -${amount}`, { kind: 'warn' });
}

const IMPERATIVE_OK = new Set(['embed', 'seed', 'speed', 'feed', 'need', 'proceed', 'succeed', 'exceed', 'bleed', 'breed', 'bring', 'swing', 'ring', 'focus', 'canvas', 'alias', 'bias', 'gas', 'plus', 'pass', 'access', 'process', 'address', 'dismiss', 'discuss', 'miss', 'press', 'bypass', 'compress', 'express', 'progress', 'redress', 'trim', 'tweak']);

export function messageProblems(msg) {
  const sub = msg.split('\n')[0].trim();
  const problems = [];
  const first = (sub.split(/\s+/)[0] || '').toLowerCase();
  if (sub.length > 50) problems.push('subject is longer than 50 characters');
  if (/\.$/.test(sub)) problems.push('subject ends with a period');
  if (sub.length < 5 || /^(wip|fix|fixes|fixed|update|updates|updated|stuff|changes|misc|test|tmp|asdf|oops)$/i.test(sub)) problems.push('subject says nothing about what changed');
  else if (!IMPERATIVE_OK.has(first) && (/(ed|ing)$/.test(first) || (/s$/.test(first) && !/ss$/.test(first)))) problems.push('use the imperative mood ("Add", not "Added", "Adding" or "Adds")');
  return problems;
}

function checkNewCommit(w, ctx, id, { auto = false } = {}) {
  const c = w.commits[id];
  if (!auto) {
    const problems = messageProblems(c.msg);
    if (problems.length) penalize(w, ctx, 'bad-message', 3, `"${subject(c)}": ${problems.join('; ')}`);
  }
  const first = c.parents[0] ? w.commits[c.parents[0]].tree : {};
  const bad = treeDiff(first, c.tree).filter((f) => f.kind !== 'deleted' && hasMarkers(c.tree[f.path]));
  if (bad.length) penalize(w, ctx, 'markers-committed', 15, bad.map((f) => f.path).join(', '));
}

// ---------------------------------------------------------------- world

export function createWorld(sc) {
  const w = {
    commits: {},
    keys: {},
    seq: 0,
    branches: {},
    head: { branch: 'main' },
    tags: {},
    tracking: {},
    upstream: {},
    index: {},
    worktree: {},
    unmerged: [],
    op: null,
    stash: [],
    reflog: [],
    config: { pullRebase: null },
    remote: { refs: {}, tags: {}, prs: [], next: sc.nextPr || 1 },
    protection: sc.protection || {},
    owners: sc.owners || [],
    buildRules: sc.buildRules || [],
    reviewDelay: sc.reviewDelay ?? 1,
    schedule: sc.schedule || [],
    goals: clone(sc.goals || []),
    term: [],
    lessons: new Set(),
    health: 100,
    ticks: 0,
    winTicks: sc.winTicks,
    minHealth: sc.minHealth ?? 50,
  };
  const repo = sc.repo;
  let prev = null;
  for (const spec of repo.commits) {
    const parents = (spec.parents || (prev ? [prev] : [])).map((k) => w.keys[k]);
    const base = parents[0] ? { ...w.commits[parents[0]].tree } : {};
    const tree = spec.files ? { ...spec.files } : base;
    for (const [p, v] of Object.entries(spec.set || {})) tree[p] = v;
    for (const p of spec.del || []) delete tree[p];
    w.keys[spec.key] = newCommit(w, { parents, msg: spec.msg, tree, author: spec.author || ME });
    prev = spec.key;
  }
  const key = (k) => w.keys[k];
  for (const [b, k] of Object.entries(repo.remote.refs)) w.remote.refs[b] = key(k);
  for (const [b, k] of Object.entries(repo.local.branches)) w.branches[b] = key(k);
  for (const [r, k] of Object.entries(repo.local.tracking || {})) w.tracking[r] = key(k);
  w.upstream = { ...(repo.local.upstream || {}) };
  w.head = { branch: repo.local.head };
  const tree = headTree(w);
  w.index = { ...tree };
  w.worktree = { ...tree };
  for (const [p, v] of Object.entries(repo.worktree || {})) {
    if (v === null) delete w.worktree[p];
    else w.worktree[p] = v;
  }
  const first = w.commits[headId(w)];
  w.reflog.unshift({ id: first.id, text: first.author === ME ? `commit: ${subject(first)}` : 'clone: from github.com:acme/site.git' });
  for (const pr of repo.prs || []) {
    w.remote.prs.push({ n: pr.n, title: pr.title, body: pr.body || '', head: pr.head, base: pr.base || 'main', author: pr.author || ME, draft: Boolean(pr.draft), state: 'open', reviewers: (pr.reviewers || []).map((name) => ({ name, state: 'requested', at: 0 })), headTip: w.remote.refs[pr.head] });
  }
  return w;
}

// ---------------------------------------------------------------- the commit graph

// Lays commits (newest first) out in lanes, like `git log --graph`.
export function layout(w, ids) {
  const set = new Set(ids);
  const lanes = [];
  const rows = [];
  for (const id of ids) {
    let lane = lanes.indexOf(id);
    const fresh = lane === -1;
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
      lanes[lane] = id;
    }
    const before = lanes.slice();
    const merged = [];
    lanes.forEach((x, k) => {
      if (x === id && k !== lane) merged.push(k);
    });
    for (const k of merged) lanes[k] = null;
    const parents = w.commits[id].parents.filter((p) => set.has(p));
    lanes[lane] = parents[0] ?? null;
    const parentLanes = parents.length ? [lane] : [];
    const added = [];
    for (const p of parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k === -1) {
        k = lanes.indexOf(null);
        if (k === -1) k = lanes.length;
        lanes[k] = p;
        added.push(k);
      }
      parentLanes.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ id, lane, fresh, before, after: lanes.slice(), merged, added, parentLanes });
  }
  return rows;
}

function visibleIds(w) {
  return [...knownCommits(w)].sort(byNewest(w));
}

export function graphRows(w, max = 14) {
  const all = visibleIds(w);
  const ids = all.slice(0, max);
  return {
    hidden: all.length - ids.length,
    width: Math.max(1, ...layout(w, ids).map((r) => Math.max(r.before.length, r.after.length))),
    rows: layout(w, ids).map((r) => {
      const c = w.commits[r.id];
      return { ...r, subject: subject(c), author: c.author, n: c.n, refs: decorations(w, r.id), mine: c.author === ME };
    }),
  };
}

function asciiGraph(w, ids, text) {
  const out = [];
  for (const r of layout(w, ids)) {
    const n = Math.max(r.before.length, r.after.length);
    if (r.merged.length) {
      const cells = Array(2 * n + 2).fill(' ');
      r.before.forEach((x, k) => {
        if (x === null || k === r.lane) return;
        if (r.merged.includes(k)) cells[2 * k - 1] = '/';
        else cells[2 * k] = '|';
      });
      cells[2 * r.lane] = '|';
      out.push({ graph: cells.join('').trimEnd(), text: null });
    }
    const cells = [];
    for (let k = 0; k < n; k++) cells.push(k === r.lane ? '*' : r.before[k] && !r.merged.includes(k) ? '|' : ' ');
    // Like git, a merge row keeps the width of the lane it is about to open.
    const row = cells.join(' ');
    out.push({ graph: r.added.length ? row : row.trimEnd(), text: text(r.id) });
    if (r.added.length) {
      const cells2 = Array(2 * n + 2).fill(' ');
      r.after.forEach((x, k) => {
        if (x === null) return;
        if (r.added.includes(k)) cells2[2 * k - 1] = '\\';
        else cells2[2 * k] = '|';
      });
      out.push({ graph: cells2.join('').trimEnd(), text: null });
    }
  }
  return out.map((o) => (o.text === null ? o.graph : `${o.graph} ${o.text}`)).join('\n');
}

// ---------------------------------------------------------------- argument parsing

function parse(args, valueFlags = []) {
  const flags = {};
  const pos = [];
  const list = [];
  let rest = false;
  for (const a of args) {
    if (!rest && /^-[a-zA-Z]{2,}$/.test(a)) for (const ch of a.slice(1)) list.push(`-${ch}`);
    else list.push(a);
    if (a === '--') rest = true;
  }
  rest = false;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (rest || a === '-' || !a.startsWith('-')) {
      pos.push(a);
      continue;
    }
    if (a === '--') {
      rest = true;
      flags['--'] = true;
      continue;
    }
    let k = a;
    let v;
    if (a.startsWith('--') && a.includes('=')) {
      k = a.slice(0, a.indexOf('='));
      v = a.slice(a.indexOf('=') + 1);
    }
    if (valueFlags.includes(k)) {
      if (v === undefined) v = list[++i];
      (flags[k] ||= []).push(v ?? '');
    } else flags[k] = v === undefined ? true : v;
  }
  return { flags, pos, has: (...ks) => ks.some((k) => flags[k]), val: (...ks) => ks.map((k) => flags[k]?.[0]).find((x) => x !== undefined) };
}

// ---------------------------------------------------------------- git: reading

function trackingLine(w) {
  const b = w.head.branch;
  const up = b && w.upstream[b];
  if (!up) return [];
  if (!(up in w.tracking)) return [`Your branch is based on '${up}', but the upstream is gone.`, '  (use "git branch --unset-upstream" to fixup)'];
  const { ahead, behind } = aheadBehind(w, w.branches[b], w.tracking[up]);
  if (!ahead && !behind) return [`Your branch is up to date with '${up}'.`];
  if (ahead && !behind) return [`Your branch is ahead of '${up}' by ${plural(ahead, 'commit')}.`, '  (use "git push" to publish your local commits)'];
  if (!ahead) return [`Your branch is behind '${up}' by ${plural(behind, 'commit')}, and can be fast-forwarded.`, '  (use "git pull" to update your local branch)'];
  return [`Your branch and '${up}' have diverged,`, `and have ${ahead} and ${behind} different commits each, respectively.`, '  (use "git pull" if you want to integrate the remote branch with yours)'];
}

function cmdStatus(w) {
  const s = workStatus(w);
  const out = [];
  if (w.op && w.op.kind === 'rebase') {
    out.push(`rebase in progress; onto ${w.op.onto.slice(0, 7)}`, `You are currently rebasing branch '${w.op.branch}' on '${w.op.onto.slice(0, 7)}'.`);
    out.push(s.unmerged.length ? '  (fix conflicts and then run "git rebase --continue")' : '  (all conflicts fixed: run "git rebase --continue")', '  (use "git rebase --skip" to skip this patch)', '  (use "git rebase --abort" to check out the original branch)', '');
  } else {
    out.push(w.head.branch ? `On branch ${w.head.branch}` : `HEAD detached at ${w.head.detached}`);
    out.push(...trackingLine(w));
    if (s.unmerged.length) {
      const verb = w.op?.kind === 'merge' ? 'git merge --abort' : `git ${w.op?.kind} --abort`;
      out.push('You have unmerged paths.', `  (fix conflicts and run "git ${w.op?.kind === 'merge' ? 'commit' : `${w.op?.kind} --continue`}")`, `  (use "${verb}" to abort the ${w.op?.kind})`);
    }
    out.push('');
  }
  if (s.staged.length) out.push('Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)', ...s.staged.map((f) => `\t${`${f.kind}:`.padEnd(12)}${f.path}`), '');
  if (s.unmerged.length) out.push('Unmerged paths:', '  (use "git add <file>..." to mark resolution)', ...s.unmerged.map((p) => `\tboth modified:   ${p}`), '');
  if (s.unstaged.length) out.push('Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)', ...s.unstaged.map((f) => `\t${`${f.kind}:`.padEnd(12)}${f.path}`), '');
  if (s.untracked.length) out.push('Untracked files:', '  (use "git add <file>..." to include in what will be committed)', ...s.untracked.map((f) => `\t${f.path}`), '');
  if (!s.staged.length && !s.unstaged.length && !s.unmerged.length) out.push(s.untracked.length ? 'nothing added to commit but untracked files present (use "git add" to track)' : 'nothing to commit, working tree clean');
  else if (!s.staged.length && !s.unmerged.length) out.push('no changes added to commit (use "git add" and/or "git commit -a")');
  say(w, out.join('\n').replace(/\n+$/, ''));
  return false;
}

const dateOf = (c) => {
  const m = 540 + c.n * 9;
  return `Mon Oct 26 ${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00 2026 +0000`;
};
const authorOf = (name) => `${name[0].toUpperCase()}${name.slice(1)} <${name}@acme.dev>`;

function cmdLog(w, args) {
  const dd = args.indexOf('--');
  const p = parse(dd >= 0 ? args.slice(0, dd) : args, ['-n', '--max-count', '--format', '--pretty']);
  let max = Infinity;
  const n = p.val('-n', '--max-count');
  if (n) max = Number(n);
  for (const a of args) if (/^-\d+$/.test(a)) max = Number(a.slice(1));
  const oneline = p.has('--oneline') || p.val('--pretty', '--format') === 'oneline';
  let ids;
  const revs = p.pos;
  if (p.has('--all')) ids = [...knownCommits(w)];
  else if (revs.length) {
    const set = new Set();
    for (const r of revs) {
      if (r.includes('..')) {
        const [from, to] = r.split('..');
        const a = resolveRev(w, from || 'HEAD');
        const b = resolveRev(w, to || 'HEAD');
        if (!a || !b) return fail(w, `fatal: ambiguous argument '${r}': unknown revision or path not in the working tree.`);
        commitsBetween(w, a, b).forEach((id) => set.add(id));
      } else {
        const id = resolveRev(w, r);
        if (!id) return fail(w, `fatal: ambiguous argument '${r}': unknown revision or path not in the working tree.`);
        ancestors(w, [id]).forEach((x) => set.add(x));
      }
    }
    ids = [...set];
  } else ids = [...ancestors(w, [headId(w)])];
  ids.sort(byNewest(w));
  ids = ids.slice(0, max);
  if (p.has('--graph')) {
    say(w, asciiGraph(w, ids, (id) => `${id}${decoText(w, id)} ${subject(w.commits[id])}`));
    return false;
  }
  if (oneline) say(w, ids.map((id) => `${id}${decoText(w, id)} ${subject(w.commits[id])}`).join('\n'));
  else {
    say(w, ids.map((id) => {
      const c = w.commits[id];
      const merge = c.parents.length > 1 ? `Merge: ${c.parents.join(' ')}\n` : '';
      return `commit ${id}${decoText(w, id)}\n${merge}Author: ${authorOf(c.author)}\nDate:   ${dateOf(c)}\n\n${c.msg.split('\n').map((l) => `    ${l}`).join('\n')}\n`;
    }).join('\n').trimEnd());
  }
  return false;
}

function cmdDiff(w, args) {
  const p = parse(args);
  let d;
  if (p.has('--staged', '--cached')) d = treeDiff(headTree(w), w.index);
  else {
    const paths2 = p.pos.filter((x) => x !== '--');
    const idx = {};
    const wt = {};
    for (const k of Object.keys(w.index)) if (!w.unmerged.includes(k)) {
      idx[k] = w.index[k];
      if (w.worktree[k] !== undefined) wt[k] = w.worktree[k];
    }
    d = treeDiff(idx, wt).filter((f) => !paths2.length || paths2.some((x) => f.path === x || f.path.startsWith(x.replace(/\/?$/, '/'))));
    for (const u of w.unmerged) say(w, `* Unmerged path ${u}`);
  }
  if (d.length) say(w, patchText(d));
  return false;
}

function cmdShow(w, args) {
  const rev = args.find((a) => !a.startsWith('-')) || 'HEAD';
  const id = resolveRev(w, rev);
  if (!id) return fail(w, `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
  const c = w.commits[id];
  const parent = c.parents[0] ? w.commits[c.parents[0]].tree : {};
  say(w, `commit ${id}${decoText(w, id)}\nAuthor: ${authorOf(c.author)}\nDate:   ${dateOf(c)}\n\n${c.msg.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  const d = treeDiff(parent, c.tree);
  if (d.length) say(w, patchText(d));
  return false;
}

function cmdReflog(w) {
  if (!w.reflog.length) say(w, '(no entries yet)');
  else say(w, w.reflog.slice(0, 15).map((e, i) => `${e.id} HEAD@{${i}}: ${e.text}`).join('\n'));
  return false;
}

// ---------------------------------------------------------------- git: branches and checkout

function cmdBranch(w, ctx, args) {
  const p = parse(args, ['-m', '-u']);
  if (p.has('--show-current')) {
    say(w, w.head.branch || '');
    return false;
  }
  if (p.has('-d', '-D', '--delete')) {
    let changed = false;
    for (const name of p.pos) {
      if (!(name in w.branches)) {
        fail(w, `error: branch '${name}' not found.`);
        continue;
      }
      if (w.head.branch === name) {
        fail(w, `error: Cannot delete branch '${name}' checked out at '/work/site'`);
        continue;
      }
      const id = w.branches[name];
      const into = w.upstream[name] && w.tracking[w.upstream[name]] ? w.tracking[w.upstream[name]] : headId(w);
      if (!p.has('-D') && !isAncestor(w, id, into) && !isAncestor(w, id, headId(w))) {
        fail(w, `error: the branch '${name}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${name}'.`);
        continue;
      }
      delete w.branches[name];
      delete w.upstream[name];
      say(w, `Deleted branch ${name} (was ${id}).`);
      changed = true;
    }
    return changed;
  }
  if (p.pos.length === 0) {
    const names = Object.keys(w.branches).sort();
    const rows = [];
    const verbose = p.has('-v', '-vv');
    const wide = Math.max(0, ...names.map((b) => b.length));
    const detail = (b) => {
      if (!verbose) return '';
      const id = w.branches[b];
      const up = w.upstream[b];
      let track = '';
      if (up && up in w.tracking) {
        const { ahead, behind } = aheadBehind(w, id, w.tracking[up]);
        track = ` [${up}${ahead || behind ? `: ${[ahead && `ahead ${ahead}`, behind && `behind ${behind}`].filter(Boolean).join(', ')}` : ''}]`;
      } else if (up) track = ` [${up}: gone]`;
      return ` ${' '.repeat(wide - b.length)}${id}${track} ${subject(w.commits[id])}`;
    };
    if (!p.has('-r')) for (const b of names) rows.push(`${w.head.branch === b ? '* ' : '  '}${b}${detail(b)}`);
    if (!w.head.branch && !p.has('-r')) rows.unshift(`* (HEAD detached at ${w.head.detached})`);
    if (p.has('-a', '-r')) for (const r of Object.keys(w.tracking).sort()) rows.push(`  remotes/${r}`);
    say(w, rows.join('\n'));
    return false;
  }
  const [name, start] = p.pos;
  if (name in w.branches && !p.has('-f')) return fail(w, `fatal: a branch named '${name}' already exists`);
  const at = start ? resolveRev(w, start) : headId(w);
  if (!at) return fail(w, `fatal: not a valid object name: '${start}'`);
  if (name === w.head.branch) return fail(w, `fatal: cannot force update the branch '${name}' checked out at '/work/site'`);
  w.branches[name] = at;
  if (start && start in w.tracking) w.upstream[name] = start;
  return true;
}

function describeSwitch(w, name) {
  return `Switched to branch '${name}'`;
}

function checkoutTarget(w, targetId, why) {
  const cur = headTree(w);
  const tgt = w.commits[targetId].tree;
  const changed = paths(cur, tgt).filter((p) => cur[p] !== tgt[p]);
  const blocked = changed.filter((p) => w.index[p] !== cur[p] || w.worktree[p] !== cur[p]);
  if (blocked.length) {
    const untracked = blocked.every((p) => !(p in cur) && !(p in w.index));
    return fail(w, untracked
      ? `error: The following untracked working tree files would be overwritten by checkout:\n${blocked.map((p) => `\t${p}`).join('\n')}\nPlease move or remove them before you switch branches.\nAborting`
      : `error: Your local changes to the following files would be overwritten by checkout:\n${blocked.map((p) => `\t${p}`).join('\n')}\nPlease commit your changes or stash them before you switch branches.\nAborting`);
  }
  applyTree(w, cur, tgt);
  w.reflog.unshift({ id: targetId, text: why });
  return true;
}

function cmdSwitch(w, ctx, args, legacy) {
  const p = parse(args, ['-c', '-C', '-b', '-B']);
  if (w.unmerged.length) return fail(w, 'error: you need to resolve your current index first');
  if (w.op) return fail(w, `fatal: you are in the middle of a ${w.op.kind}; finish it or run "git ${w.op.kind} --abort" first`);
  const create = p.val('-c', '-C', '-b', '-B');
  const startArg = create ? p.pos[0] : undefined;
  if (create) {
    if (create in w.branches && !p.has('-C', '-B')) return fail(w, `fatal: a branch named '${create}' already exists`);
    const at = startArg ? resolveRev(w, startArg) : headId(w);
    if (!at) return fail(w, `fatal: invalid reference: ${startArg}`);
    const from = w.head.branch || w.head.detached;
    if (!checkoutTarget(w, at, `checkout: moving from ${from} to ${create}`)) return false;
    w.branches[create] = at;
    if (startArg && startArg in w.tracking) w.upstream[create] = startArg;
    w.head = { branch: create };
    say(w, `${startArg && startArg in w.tracking ? `branch '${create}' set up to track '${startArg}'.\n` : ''}Switched to a new branch '${create}'`);
    return true;
  }
  if (p.has('-')) return fail(w, 'fatal: this terminal does not remember the previous branch; name it.');
  const name = p.pos[0];
  if (!name) return fail(w, legacy ? 'fatal: you must name a branch' : 'fatal: missing branch or commit argument');
  if (name === w.head.branch) {
    say(w, `Already on '${name}'`);
    return false;
  }
  if (name in w.branches) {
    if (!checkoutTarget(w, w.branches[name], `checkout: moving from ${w.head.branch || w.head.detached} to ${name}`)) return false;
    w.head = { branch: name };
    say(w, describeSwitch(w, name));
    return true;
  }
  const guess = `origin/${name}`;
  if (guess in w.tracking && !p.has('--detach')) {
    if (!checkoutTarget(w, w.tracking[guess], `checkout: moving from ${w.head.branch || w.head.detached} to ${name}`)) return false;
    w.branches[name] = w.tracking[guess];
    w.upstream[name] = guess;
    w.head = { branch: name };
    say(w, `branch '${name}' set up to track '${guess}'.\nSwitched to a new branch '${name}'`);
    return true;
  }
  const id = resolveRev(w, name);
  if (id && (legacy || p.has('--detach', '-d'))) {
    if (!checkoutTarget(w, id, `checkout: moving from ${w.head.branch || w.head.detached} to ${id}`)) return false;
    w.head = { detached: id };
    say(w, `Note: switching to '${name}'.\n\nYou are in 'detached HEAD' state. Create a branch to keep commits you make here:\n  git switch -c <new-branch-name>\n\nHEAD is now at ${id} ${subject(w.commits[id])}`);
    return true;
  }
  return fail(w, id ? `fatal: a branch is expected, got commit '${name}'` : legacy ? `error: pathspec '${name}' did not match any file(s) known to git` : `fatal: invalid reference: ${name}`);
}

function cmdCheckout(w, ctx, args) {
  const p = parse(args, ['-b', '-B']);
  if (p.has('-b', '-B')) return cmdSwitch(w, ctx, args, true);
  const first = p.pos[0];
  const refLike = first && (first in w.branches || `origin/${first}` in w.tracking || resolveRev(w, first));
  if (p.flags['--'] || !first || !refLike) return cmdRestore(w, ctx, ['--', ...p.pos]);
  return cmdSwitch(w, ctx, args, true);
}

function cmdRestore(w, ctx, args) {
  const p = parse(args, ['--source', '-s']);
  const staged = p.has('--staged', '-S');
  const worktree = p.has('--worktree', '-W') || !staged;
  const targets = p.pos;
  if (!targets.length) return fail(w, 'fatal: you must specify path(s) to restore');
  const head = headTree(w);
  const srcRev = p.val('--source', '-s');
  const srcTree = srcRev ? w.commits[resolveRev(w, srcRev)]?.tree : null;
  const all = paths(head, w.index, w.worktree);
  const sel = new Set();
  for (const t of targets) {
    if (t === '.') all.forEach((x) => sel.add(x));
    else {
      const hit = all.filter((x) => x === t || x.startsWith(t.replace(/\/?$/, '/')));
      if (!hit.length) return fail(w, `error: pathspec '${t}' did not match any file(s) known to git`);
      hit.forEach((x) => sel.add(x));
    }
  }
  let changed = false;
  const put = (tree, x, v) => {
    if (tree[x] === v) return;
    if (v === undefined) delete tree[x];
    else tree[x] = v;
    changed = true;
  };
  for (const x of sel) {
    if (w.unmerged.includes(x)) {
      fail(w, `error: path '${x}' is unmerged`);
      continue;
    }
    if (staged) put(w.index, x, srcTree ? srcTree[x] : head[x]);
    if (worktree) put(w.worktree, x, srcTree ? srcTree[x] : staged ? head[x] : w.index[x]);
  }
  return changed;
}

function cmdAdd(w, ctx, args) {
  const p = parse(args);
  if (p.has('-p', '--patch', '-i')) return fail(w, 'This terminal has no interactive prompt. Stage whole files: git add <file>.');
  const targets = p.pos.filter((x) => x !== '--');
  if (!targets.length && !p.has('-A', '--all', '-u')) return fail(w, 'Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?');
  const sel = new Set();
  const all = paths(w.index, w.worktree);
  if (p.has('-A', '--all')) all.forEach((x) => sel.add(x));
  if (p.has('-u')) Object.keys(w.index).forEach((x) => sel.add(x));
  for (const t of targets) {
    if (t === '.') all.forEach((x) => sel.add(x));
    else {
      const hit = all.filter((x) => x === t || x.startsWith(t.replace(/\/?$/, '/')));
      if (!hit.length) return fail(w, `fatal: pathspec '${t}' did not match any files`);
      hit.forEach((x) => sel.add(x));
    }
  }
  let changed = false;
  for (const x of sel) {
    if (w.worktree[x] === undefined) {
      if (x in w.index) {
        delete w.index[x];
        changed = true;
      }
    } else if (w.index[x] !== w.worktree[x]) {
      w.index[x] = w.worktree[x];
      changed = true;
    }
    if (w.unmerged.includes(x)) {
      w.unmerged = w.unmerged.filter((u) => u !== x);
      changed = true;
    }
  }
  return changed;
}

function cmdRm(w, ctx, args) {
  const p = parse(args);
  const files = p.pos.filter((x) => x !== '--');
  if (!files.length) return fail(w, 'fatal: No pathspec was given. Which files should I remove?');
  for (const f of files) {
    if (!(f in w.index) && !w.unmerged.includes(f)) return fail(w, `fatal: pathspec '${f}' did not match any files`);
  }
  for (const f of files) {
    delete w.index[f];
    delete w.worktree[f];
    w.unmerged = w.unmerged.filter((u) => u !== f);
    say(w, `rm '${f}'`);
  }
  return true;
}

// ---------------------------------------------------------------- git: commit and friends

function finishCommit(w, ctx, id, label) {
  const c = w.commits[id];
  const parentTree = c.parents[0] ? w.commits[c.parents[0]].tree : {};
  const d = treeDiff(parentTree, c.tree);
  say(w, `[${w.head.branch || 'detached HEAD'} ${id}] ${subject(c)}\n${statLine(d)}${modeLines(d).length ? `\n${modeLines(d).join('\n')}` : ''}`);
}

function cmdCommit(w, ctx, args) {
  const p = parse(args, ['-m', '--message', '-F', '--author']);
  if (w.unmerged.length) return fail(w, 'error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.');
  if (w.op && w.op.kind === 'rebase') return fail(w, 'You are in the middle of a rebase. Use "git rebase --continue" to finish this step.');
  if (p.has('-a', '--all')) {
    for (const x of Object.keys(w.index)) {
      if (w.worktree[x] === undefined) delete w.index[x];
      else w.index[x] = w.worktree[x];
    }
  }
  const msgs = [...(p.flags['-m'] || []), ...(p.flags['--message'] || [])];
  let msg = msgs.join('\n\n');
  const amend = p.has('--amend');
  const finishing = w.op && ['merge', 'cherry-pick', 'revert'].includes(w.op.kind);
  let auto = false;
  if (!msg && finishing) {
    msg = w.op.msg;
    auto = true;
  }
  if (!msg && amend) {
    msg = commitOf(w, headId(w)).msg;
    auto = true;
  }
  if (!msg) return fail(w, 'Aborting commit: this terminal has no editor. Pass the message with -m "...".');
  const head = headId(w);
  const staged = treeDiff(headTree(w), w.index);
  if (!staged.length && !finishing && !amend && !p.has('--allow-empty')) {
    const s = workStatus(w);
    return fail(w, `${w.head.branch ? `On branch ${w.head.branch}` : 'HEAD detached'}\n${s.unstaged.length ? 'Changes not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n' + s.unstaged.map((f) => `\t${f.kind}: ${f.path}`).join('\n') + '\n\nno changes added to commit (use "git add" and/or "git commit -a")' : s.untracked.length ? 'nothing added to commit but untracked files present (use "git add" to track)' : 'nothing to commit, working tree clean'}`);
  }
  let parents = [head];
  let author = ME;
  if (amend) {
    parents = commitOf(w, head).parents.slice();
  } else if (finishing) {
    if (w.op.kind === 'merge') parents = [head, w.op.other];
    if (w.op.kind === 'cherry-pick') author = w.op.author;
  }
  const id = newCommit(w, { parents, msg, tree: w.index, author });
  setHead(w, id, `commit${amend ? ' (amend)' : finishing ? ` (${w.op.kind === 'merge' ? 'merge' : w.op.kind})` : ''}: ${msg.split('\n')[0]}`);
  w.op = finishing ? null : w.op;
  finishCommit(w, ctx, id);
  checkNewCommit(w, ctx, id, { auto });
  return true;
}

function dirtyOverlap(w, ctx, changedPaths, what) {
  const bad = localChanges(w, changedPaths);
  if (!bad.length) return false;
  fail(w, `error: Your local changes to the following files would be overwritten by ${what}:\n${bad.map((p) => `\t${p}`).join('\n')}\nPlease commit your changes or stash them before you ${what}.\nAborting`);
  return true;
}

// merge `other` into HEAD. Shared by `git merge` and `git pull`.
function integrate(w, ctx, other, label, { noff = false, ffOnly = false, msg } = {}) {
  const head = headId(w);
  if (isAncestor(w, other, head)) {
    say(w, 'Already up to date.');
    return false;
  }
  const tree = headTree(w);
  const target = w.commits[other].tree;
  if (isAncestor(w, head, other) && !noff) {
    const changed = paths(tree, target).filter((p) => tree[p] !== target[p]);
    if (dirtyOverlap(w, ctx, changed, 'merge')) return false;
    const d = treeDiff(tree, target);
    say(w, `Updating ${head}..${other}\nFast-forward\n${statBlock(d).join('\n')}${modeLines(d).length ? `\n${modeLines(d).join('\n')}` : ''}`);
    applyTree(w, tree, target);
    setHead(w, other, `${w.pullContext ? 'pull' : 'merge'} ${label}: Fast-forward`);
    return true;
  }
  if (ffOnly) return fail(w, 'fatal: Not possible to fast-forward, aborting.');
  const base = mergeBase(w, head, other);
  if (!base) return fail(w, 'fatal: refusing to merge unrelated histories');
  const result = mergeTrees(w.commits[base].tree, tree, target, { ours: 'HEAD', theirs: label });
  const changed = paths(tree, result.tree).filter((p) => tree[p] !== result.tree[p]).concat(result.conflicts.map((c) => c.path));
  if (dirtyOverlap(w, ctx, changed, 'merge')) return false;
  const message = msg || (label.includes('/') && label in w.tracking ? `Merge remote-tracking branch '${label}'` : `Merge branch '${label}'`) + (w.head.branch && w.head.branch !== 'main' ? ` into ${w.head.branch}` : '');
  if (result.conflicts.length) {
    enterConflict(w, tree, result);
    w.op = { kind: 'merge', other, label, msg: message };
    say(w, `${conflictReport(w, result)}\nAutomatic merge failed; fix conflicts and then commit the result.`, 'err');
    lesson(w, ctx, 'conflict', result.conflicts.map((c) => c.path).join(', '));
    return true;
  }
  const d = treeDiff(tree, result.tree);
  const id = newCommit(w, { parents: [head, other], msg: message, tree: result.tree, author: ME });
  applyTree(w, tree, result.tree);
  setHead(w, id, `merge ${label}: Merge made by the 'ort' strategy.`);
  say(w, `Merge made by the 'ort' strategy.\n${statBlock(d).join('\n')}`);
  return true;
}

function cmdMerge(w, ctx, args) {
  const p = parse(args, ['-m']);
  if (p.has('--abort')) {
    if (!w.op || w.op.kind !== 'merge') return fail(w, 'fatal: There is no merge to abort (MERGE_HEAD missing).');
    return abortOp(w);
  }
  if (p.has('--continue')) return cmdCommit(w, ctx, []);
  if (w.op) return fail(w, `error: You have not concluded your ${w.op.kind}.\nfatal: Exiting because of unfinished ${w.op.kind}.`);
  const name = p.pos[0];
  if (!name) return fail(w, 'fatal: No remote for the current branch.');
  const id = resolveRev(w, name);
  if (!id) return fail(w, `merge: ${name} - not something we can merge`);
  w.pullContext = false;
  return integrate(w, ctx, id, name, { noff: p.has('--no-ff'), ffOnly: p.has('--ff-only'), msg: p.val('-m') });
}

function abortOp(w) {
  const op = w.op;
  const head = op.kind === 'rebase' ? op.orig : headId(w);
  if (op.kind === 'rebase') {
    w.head = { branch: op.branch };
    w.branches[op.branch] = op.orig;
  }
  const tree = w.commits[head].tree;
  const untracked = {};
  for (const p of Object.keys(w.worktree)) if (!(p in w.index)) untracked[p] = w.worktree[p];
  w.index = { ...tree };
  w.worktree = { ...tree, ...untracked };
  w.unmerged = [];
  w.op = null;
  w.reflog.unshift({ id: head, text: `${op.kind}: aborting` });
  return true;
}

// ---------------------------------------------------------------- git: rebase, cherry-pick, revert

function cmdRebase(w, ctx, args) {
  const p = parse(args);
  if (p.has('--abort')) return w.op?.kind === 'rebase' ? abortOp(w) : fail(w, 'fatal: No rebase in progress?');
  if (p.has('--continue')) return rebaseContinue(w, ctx);
  if (p.has('--skip')) return rebaseSkip(w, ctx);
  if (p.has('-i', '--interactive')) return fail(w, 'Interactive rebase needs an editor, which this terminal does not have. Use `git rebase <branch>`.');
  if (w.op) return fail(w, `fatal: you are in the middle of a ${w.op.kind}`);
  if (!w.head.branch) return fail(w, 'fatal: You are not currently on a branch.');
  const ref = p.pos[0] || w.upstream[w.head.branch];
  if (!ref) return fail(w, 'There is no tracking information for the current branch.\nPlease specify which branch you want to rebase against.');
  const onto = resolveRev(w, ref);
  if (!onto) return fail(w, `fatal: invalid upstream '${ref}'`);
  const s = workStatus(w);
  if (s.unstaged.length) return fail(w, 'error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.');
  if (s.staged.length) return fail(w, 'error: cannot rebase: Your index contains uncommitted changes.\nerror: Please commit or stash them.');
  const head = headId(w);
  if (isAncestor(w, onto, head)) {
    say(w, `Current branch ${w.head.branch} is up to date.`);
    return false;
  }
  const branch = w.head.branch;
  if (isAncestor(w, head, onto)) {
    applyTree(w, headTree(w), w.commits[onto].tree);
    setHead(w, onto, `rebase (finish): refs/heads/${branch} onto ${onto}`);
    say(w, `Successfully rebased and updated refs/heads/${branch}.`);
    return true;
  }
  const todo = commitsBetween(w, onto, head).filter((id) => w.commits[id].parents.length < 2);
  const pushedBefore = w.upstream[branch] && w.tracking[w.upstream[branch]] && isAncestor(w, w.tracking[w.upstream[branch]], head);
  w.op = { kind: 'rebase', branch, orig: head, onto, todo, stopped: null, pushedBefore: Boolean(pushedBefore) };
  applyTree(w, headTree(w), w.commits[onto].tree);
  w.head = { detached: onto };
  w.reflog.unshift({ id: onto, text: `rebase (start): checkout ${ref}` });
  rebaseRun(w, ctx);
  return true;
}

function rebaseRun(w, ctx) {
  const op = w.op;
  while (op.todo.length) {
    const cid = op.todo[0];
    const c = w.commits[cid];
    const ours = headTree(w);
    const baseTree = c.parents[0] ? w.commits[c.parents[0]].tree : {};
    const result = mergeTrees(baseTree, ours, c.tree, { ours: 'HEAD', theirs: `${cid} (${subject(c)})` });
    if (result.conflicts.length) {
      enterConflict(w, ours, result);
      op.stopped = cid;
      say(w, [conflictReport(w, result), `error: could not apply ${cid}... ${subject(c)}`, 'hint: Resolve all conflicts manually, mark them as resolved with', 'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".', 'hint: You can instead skip this commit: run "git rebase --skip".', 'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".', `Could not apply ${cid}... ${subject(c)}`].join('\n'), 'err');
      lesson(w, ctx, 'conflict', result.conflicts.map((x) => x.path).join(', '));
      return;
    }
    if (!treeEq(result.tree, ours)) {
      const id = newCommit(w, { parents: [headId(w)], msg: c.msg, tree: result.tree, author: c.author });
      applyTree(w, ours, result.tree);
      w.head = { detached: id };
      w.reflog.unshift({ id, text: `rebase (pick): ${subject(c)}` });
    }
    op.todo.shift();
  }
  const final = headId(w);
  w.branches[op.branch] = final;
  w.head = { branch: op.branch };
  w.reflog.unshift({ id: final, text: `rebase (finish): refs/heads/${op.branch} onto ${op.onto}` });
  say(w, `Successfully rebased and updated refs/heads/${op.branch}.`);
  if (op.pushedBefore) lesson(w, ctx, 'rebase-rewrote', op.branch);
  w.op = null;
}

function rebaseContinue(w, ctx) {
  const op = w.op;
  if (!op || op.kind !== 'rebase') return fail(w, 'fatal: No rebase in progress?');
  if (w.unmerged.length) return fail(w, `${w.unmerged.map((p) => `${p}: needs merge`).join('\n')}\nYou must edit all merge conflicts and then\nmark them as resolved using git add`);
  const c = w.commits[op.stopped];
  if (treeEq(w.index, headTree(w))) return fail(w, 'No changes - did you forget to use \'git add\'?\nIf there is nothing left to stage, chances are that something else\nalready introduced the same changes; you might want to skip this patch (git rebase --skip).');
  const id = newCommit(w, { parents: [headId(w)], msg: c.msg, tree: w.index, author: c.author });
  w.head = { detached: id };
  w.reflog.unshift({ id, text: `rebase (continue): ${subject(c)}` });
  checkNewCommit(w, ctx, id, { auto: true });
  op.todo.shift();
  op.stopped = null;
  rebaseRun(w, ctx);
  return true;
}

function rebaseSkip(w, ctx) {
  const op = w.op;
  if (!op || op.kind !== 'rebase') return fail(w, 'fatal: No rebase in progress?');
  const tree = headTree(w);
  const untracked = {};
  for (const p of Object.keys(w.worktree)) if (!(p in w.index)) untracked[p] = w.worktree[p];
  w.index = { ...tree };
  w.worktree = { ...tree, ...untracked };
  w.unmerged = [];
  op.todo.shift();
  op.stopped = null;
  rebaseRun(w, ctx);
  return true;
}

function cmdPick(w, ctx, args, mode) {
  const p = parse(args, ['-m', '--mainline']);
  const name = mode === 'revert' ? 'revert' : 'cherry-pick';
  if (p.has('--abort')) return w.op?.kind === name ? abortOp(w) : fail(w, `error: no ${name} in progress`);
  if (p.has('--continue')) return w.op?.kind === name ? cmdCommit(w, ctx, []) : fail(w, `error: no ${name} in progress`);
  if (w.op) return fail(w, `error: ${w.op.kind} is already in progress`);
  if (!p.pos.length) return fail(w, `fatal: ${name === 'revert' ? 'revert' : 'cherry-pick'}: you must specify a commit`);
  let changed = false;
  for (const rev of p.pos) {
    const id = resolveRev(w, rev);
    if (!id) return changed || fail(w, `fatal: bad revision '${rev}'`);
    const c = w.commits[id];
    if (c.parents.length > 1 && !p.has('-m', '--mainline')) return changed || fail(w, `error: commit ${id} is a merge but no -m option was given.\nfatal: ${name} failed`);
    const parent = c.parents[0] ? w.commits[c.parents[0]].tree : {};
    const ours = headTree(w);
    const [base, theirs] = mode === 'revert' ? [c.tree, parent] : [parent, c.tree];
    const result = mergeTrees(base, ours, theirs, mode === 'revert' ? { ours: 'HEAD', theirs: `parent of ${id} (${subject(c)})` } : { ours: 'HEAD', theirs: `${id} (${subject(c)})` });
    const touched = paths(ours, result.tree).filter((x) => ours[x] !== result.tree[x]).concat(result.conflicts.map((x) => x.path));
    if (dirtyOverlap(w, ctx, touched, name)) return changed;
    const msg = mode === 'revert' ? `Revert "${subject(c)}"\n\nThis reverts commit ${id}.` : c.msg;
    if (result.conflicts.length) {
      enterConflict(w, ours, result);
      w.op = { kind: name, id, msg, author: mode === 'revert' ? ME : c.author };
      say(w, [conflictReport(w, result), `error: could not ${mode === 'revert' ? 'revert' : 'apply'} ${id}... ${subject(c)}`, 'hint: After resolving the conflicts, mark them with', 'hint: "git add/rm <pathspec>", then run', `hint: "git ${name} --continue".`, `hint: You can instead skip this commit with "git ${name} --skip".`, `hint: To abort and get back to the state before "git ${name}",`, `hint: run "git ${name} --abort".`].join('\n'), 'err');
      lesson(w, ctx, 'conflict', result.conflicts.map((x) => x.path).join(', '));
      return true;
    }
    if (treeEq(result.tree, ours)) return changed || fail(w, 'The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty');
    const nid = newCommit(w, { parents: [headId(w)], msg, tree: result.tree, author: mode === 'revert' ? ME : c.author });
    applyTree(w, ours, result.tree);
    setHead(w, nid, `${name}: ${subject(c)}`);
    finishCommit(w, ctx, nid);
    if (mode === 'revert') checkNewCommit(w, ctx, nid, { auto: true });
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------- git: reset, stash, tags

function cmdReset(w, ctx, args) {
  const p = parse(args);
  const explicit = p.has('--hard', '--soft', '--mixed');
  const mode = p.has('--hard') ? 'hard' : p.has('--soft') ? 'soft' : 'mixed';
  const targets = p.pos;
  if (!explicit) {
    // `git reset file` and `git reset HEAD file` unstage paths.
    if (p.flags['--'] || (targets.length && !resolveRev(w, targets[0]))) return cmdRestore(w, ctx, ['--staged', '--', ...targets]);
    if (targets.length > 1) return cmdRestore(w, ctx, ['--staged', '--', ...targets.slice(1)]);
  }
  const rev = targets[0] || 'HEAD';
  const target = resolveRev(w, rev);
  if (!target) return fail(w, `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
  if (w.op && w.op.kind === 'rebase') return fail(w, 'fatal: you are in the middle of a rebase');
  const old = headId(w);
  const cur = headTree(w);
  const newTree = w.commits[target].tree;
  const untracked = {};
  for (const x of Object.keys(w.worktree)) if (!(x in w.index)) untracked[x] = w.worktree[x];
  if (mode === 'hard') {
    const lost = Object.keys(w.index).filter((x) => (w.worktree[x] !== cur[x] || w.index[x] !== cur[x]) && w.worktree[x] !== newTree[x]);
    if (lost.length && !w.unmerged.length && !w.op) penalize(w, ctx, 'work-lost', 15, lost.join(', '));
  }
  const dead = w.head.branch ? [...ancestors(w, [old])].filter((id) => w.commits[id].author === ME) : [];
  setHead(w, target, `reset: moving to ${rev}`);
  if (mode !== 'soft') w.index = { ...newTree };
  if (mode === 'hard') {
    w.worktree = { ...untracked, ...newTree };
    w.unmerged = [];
    w.op = null;
    say(w, `HEAD is now at ${target} ${subject(w.commits[target])}`);
  } else if (mode === 'mixed') {
    const s = workStatus(w);
    if (s.unstaged.length) say(w, `Unstaged changes after reset:\n${s.unstaged.map((f) => `${f.kind === 'deleted' ? 'D' : 'M'}\t${f.path}`).join('\n')}`);
  }
  const keep = ancestors(w, [...allTips(w), ...Object.values(w.remote.refs)]);
  const orphans = dead.filter((id) => !keep.has(id));
  if (orphans.length) lesson(w, ctx, 'orphaned-commit', orphans.join(', '));
  return true;
}

function cmdStash(w, ctx, args) {
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'push';
  const rest = sub === 'push' && args[0] === 'push' ? args.slice(1) : sub === 'push' ? args : args.slice(1);
  if (sub === 'list') {
    say(w, w.stash.map((s, i) => `stash@{${i}}: ${s.msg}`).join('\n'));
    return false;
  }
  if (sub === 'push' || sub === 'save') {
    const p = parse(rest, ['-m', '--message']);
    const head = headTree(w);
    const tracked = {};
    for (const x of paths(head, w.index)) {
      const v = w.worktree[x];
      if (v !== undefined) tracked[x] = v;
    }
    const deleted = Object.keys(head).filter((x) => w.worktree[x] === undefined);
    const s = workStatus(w);
    if (!s.staged.length && !s.unstaged.length) return fail(w, 'No local changes to save');
    if (w.unmerged.length) return fail(w, 'error: could not write index');
    const id = headId(w);
    const msg = p.val('-m', '--message');
    const label = `${w.head.branch ? `WIP on ${w.head.branch}` : 'WIP'}: ${id} ${subject(w.commits[id])}`;
    w.stash.unshift({ msg: msg ? `On ${w.head.branch || 'HEAD'}: ${msg}` : label, base: id, tree: tracked, deleted });
    const untracked = {};
    for (const x of Object.keys(w.worktree)) if (!(x in w.index) && !(x in head)) untracked[x] = w.worktree[x];
    w.index = { ...head };
    w.worktree = { ...head, ...untracked };
    say(w, `Saved working directory and index state ${w.stash[0].msg}`);
    return true;
  }
  if (sub === 'pop' || sub === 'apply' || sub === 'drop') {
    if (!w.stash.length) return fail(w, 'No stash entries found.');
    const entry = w.stash[0];
    if (sub === 'drop') {
      w.stash.shift();
      say(w, `Dropped refs/stash@{0} (${entry.base})`);
      return true;
    }
    const base = w.commits[entry.base].tree;
    const theirs = { ...entry.tree };
    for (const x of entry.deleted) delete theirs[x];
    const ours = {};
    for (const x of Object.keys(w.index)) if (w.worktree[x] !== undefined) ours[x] = w.worktree[x];
    const result = mergeTrees(base, ours, theirs, { ours: 'Updated upstream', theirs: 'Stashed changes' });
    const head = headTree(w);
    for (const x of paths(ours, result.tree)) {
      if (ours[x] === result.tree[x]) continue;
      if (result.tree[x] === undefined) {
        delete w.worktree[x];
        if (!(x in head)) delete w.index[x];
      } else {
        w.worktree[x] = result.tree[x];
        if (!(x in head)) w.index[x] = result.tree[x];
      }
    }
    if (result.conflicts.length) {
      say(w, `${conflictReport(w, result)}\nThe stash entry is kept in case you need it again.`, 'err');
      lesson(w, ctx, 'conflict', result.conflicts.map((c) => c.path).join(', '));
      return true;
    }
    if (sub === 'pop') w.stash.shift();
    const s2 = workStatus(w);
    const rows = (list) => list.map((f) => `\t${`${f.kind}:`.padEnd(12)}${f.path}`).join('\n');
    say(w, `${w.head.branch ? `On branch ${w.head.branch}` : 'HEAD detached'}\n${s2.staged.length ? `Changes to be committed:\n${rows(s2.staged)}\n\n` : ''}${s2.unstaged.length ? `Changes not staged for commit:\n${rows(s2.unstaged)}\n` : ''}${sub === 'pop' ? `\nDropped refs/stash@{0} (${entry.base})` : ''}`.trimEnd());
    return true;
  }
  return fail(w, `error: unknown stash subcommand '${sub}'. This game supports push, list, pop, apply and drop.`);
}

function cmdTag(w, ctx, args) {
  const p = parse(args, ['-m', '-a']);
  if (p.has('-d')) {
    const t = p.pos[0];
    if (!(t in w.tags)) return fail(w, `error: tag '${t}' not found.`);
    say(w, `Deleted tag '${t}' (was ${w.tags[t].id})`);
    delete w.tags[t];
    return true;
  }
  const annotated = p.flags['-a'];
  const name = typeof annotated === 'object' ? annotated[0] : p.pos[0];
  if (!name) {
    say(w, Object.keys(w.tags).sort().join('\n'));
    return false;
  }
  if (name in w.tags) return fail(w, `fatal: tag '${name}' already exists`);
  const at = (typeof annotated === 'object' ? p.pos[0] : p.pos[1]) ? resolveRev(w, typeof annotated === 'object' ? p.pos[0] : p.pos[1]) : headId(w);
  if (!at) return fail(w, 'fatal: Failed to resolve the target as a valid ref.');
  if (annotated && !p.val('-m')) return fail(w, 'fatal: no tag message?');
  w.tags[name] = { id: at, msg: p.val('-m') || null };
  return true;
}

function cmdConfig(w, args) {
  const p = parse(args);
  const [key, value] = p.pos;
  if (key === 'pull.rebase' && value !== undefined) {
    w.config.pullRebase = value === 'true';
    return false;
  }
  if (key === 'pull.rebase') {
    say(w, w.config.pullRebase === null ? '' : String(w.config.pullRebase));
    return false;
  }
  return false;
}

// ---------------------------------------------------------------- git: remote

function cmdFetch(w, ctx, args, quiet = false) {
  const p = parse(args);
  const remote = p.pos[0];
  if (remote && remote !== 'origin') return fail(w, `fatal: '${remote}' does not appear to be a git repository`);
  const rows = [];
  const names = Object.keys(w.remote.refs).sort();
  const width = Math.max(0, ...names.map((n) => n.length));
  let changed = false;
  for (const b of names) {
    const ref = `origin/${b}`;
    const old = w.tracking[ref];
    const now = w.remote.refs[b];
    if (old === now) continue;
    changed = true;
    w.tracking[ref] = now;
    if (!old) rows.push(` * [new branch]      ${b.padEnd(width)} -> ${ref}`);
    else if (isAncestor(w, old, now)) rows.push(`   ${old}..${now}  ${b.padEnd(width)} -> ${ref}`);
    else rows.push(` + ${old}...${now} ${b.padEnd(width)} -> ${ref}  (forced update)`);
  }
  if (p.has('-p', '--prune')) {
    for (const ref of Object.keys(w.tracking)) {
      if (!ref.startsWith('origin/')) continue;
      if (!(ref.slice(7) in w.remote.refs)) {
        rows.push(` - [deleted]         ${'(none)'.padEnd(width)} -> ${ref}`);
        delete w.tracking[ref];
        changed = true;
      }
    }
  }
  for (const [t, id] of Object.entries(w.remote.tags)) {
    if (!(t in w.tags)) {
      w.tags[t] = { id, msg: null };
      rows.push(` * [new tag]         ${t} -> ${t}`);
      changed = true;
    }
  }
  if (rows.length && !quiet) say(w, `From ${HOST.replace(/\.git$/, '')}\n${rows.join('\n')}`);
  return changed;
}

function cmdPull(w, ctx, args) {
  const p = parse(args);
  if (w.op) return fail(w, `error: You have not concluded your ${w.op.kind}.\nfatal: Exiting because of unfinished ${w.op.kind}.`);
  if (!w.head.branch) return fail(w, 'You are not currently on a branch.\nPlease specify which branch you want to merge with.');
  let remote = p.pos[0];
  let branch = p.pos[1];
  if (!remote) {
    const up = w.upstream[w.head.branch];
    if (!up) return fail(w, `There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=origin/<branch> ${w.head.branch}`);
    [remote, branch] = [up.split('/')[0], up.split('/').slice(1).join('/')];
  }
  if (remote !== 'origin') return fail(w, `fatal: '${remote}' does not appear to be a git repository`);
  if (!branch) branch = w.head.branch;
  if (!(branch in w.remote.refs)) return fail(w, `fatal: couldn't find remote ref ${branch}`);
  const fetched = cmdFetch(w, ctx, [], false);
  const ref = `origin/${branch}`;
  const target = w.tracking[ref];
  const head = headId(w);
  const rebase = p.has('--rebase', '-r') ? true : p.has('--no-rebase') ? false : w.config.pullRebase;
  if (isAncestor(w, target, head)) {
    say(w, 'Already up to date.');
    return fetched;
  }
  w.pullContext = true;
  if (isAncestor(w, head, target) || rebase === false || p.has('--ff-only')) {
    return integrate(w, ctx, target, ref, { ffOnly: p.has('--ff-only') }) || fetched;
  }
  if (rebase === null) {
    lesson(w, ctx, 'divergent-pull', w.head.branch);
    return fail(w, ['hint: You have divergent branches and need to specify how to reconcile them.', 'hint: You can do so by running one of the following commands sometime before', 'hint: your next pull:', 'hint:', 'hint:   git config pull.rebase false  # merge', 'hint:   git config pull.rebase true   # rebase', 'hint:   git config pull.ff only       # fast-forward only', 'hint:', 'hint: You can replace "git config" with "git config --global" to set a default', 'hint: preference for all repositories. You can also pass --rebase, --no-rebase,', 'hint: or --ff-only on the command line to override the configured default per', 'hint: invocation.', 'fatal: Need to specify how to reconcile divergent branches.'].join('\n')) || fetched;
  }
  return cmdRebase(w, ctx, [ref]) || fetched;
}

function rejectedPush(w, src, dst, reason, fetchFirst) {
  const lines2 = [`To ${HOST}`, ` ! [rejected]        ${src} -> ${dst} (${reason})`, `error: failed to push some refs to '${HOST}'`];
  if (fetchFirst) lines2.push('hint: Updates were rejected because the remote contains work that you do', 'hint: not have locally. This is usually caused by another repository pushing', "hint: to the same ref. You may want to first integrate the remote changes", "hint: (e.g., 'git pull ...') before pushing again.", "hint: See the 'Note about fast-forwards' in 'git push --help' for details.");
  else lines2.push('hint: Updates were rejected because the tip of your current branch is behind', 'hint: its remote counterpart. If you want to integrate the remote changes,', "hint: use 'git pull' before pushing again.", "hint: See the 'Note about fast-forwards' in 'git push --help' for details.");
  say(w, lines2.join('\n'), 'err');
}

function pushOne(w, ctx, { dst, srcId, srcName, force, lease, setUp }) {
  const prot = w.protection;
  const old = w.remote.refs[dst];
  if (prot.branch === dst && prot.requirePr && old !== srcId) {
    say(w, [`remote: error: GH006: Protected branch update failed for refs/heads/${dst}.`, `remote: error: ${force || lease ? 'Cannot force-push to this branch' : 'Changes must be made through a pull request'}.`, `To ${HOST}`, ` ! [remote rejected] ${srcName} -> ${dst} (protected branch hook declined)`, `error: failed to push some refs to '${HOST}'`].join('\n'), 'err');
    lesson(w, ctx, 'protected-push', dst);
    return { ok: false };
  }
  if (old === srcId) return { ok: true, line: `   [up to date]      ${srcName} -> ${dst}`, noop: true };
  let line;
  if (!old) line = ` * [new branch]      ${srcName} -> ${dst}`;
  else if (isAncestor(w, old, srcId)) line = `   ${old}..${srcId}  ${srcName} -> ${dst}`;
  else {
    const known = knownCommits(w).has(old);
    if (!force && !lease) {
      rejectedPush(w, srcName, dst, known ? 'non-fast-forward' : 'fetch first', !known);
      lesson(w, ctx, 'push-rejected', dst);
      return { ok: false };
    }
    if (lease && w.tracking[`origin/${dst}`] !== old) {
      say(w, [`To ${HOST}`, ` ! [rejected]        ${srcName} -> ${dst} (stale info)`, `error: failed to push some refs to '${HOST}'`].join('\n'), 'err');
      lesson(w, ctx, 'lease-rejected', dst);
      return { ok: false };
    }
    line = ` + ${old}...${srcId} ${srcName} -> ${dst} (forced update)`;
    const gone = commitsBetween(w, srcId, old);
    if (gone.some((id) => w.commits[id].author !== ME)) penalize(w, ctx, 'overwrote-teammate', 30, `${dst}: ${gone.map((id) => id).join(', ')}`);
    else if (dst === 'main') penalize(w, ctx, 'rewrote-shared', 30, dst);
    else if (!lease) penalize(w, ctx, 'force-without-lease', 10, dst);
  }
  w.remote.refs[dst] = srcId;
  w.tracking[`origin/${dst}`] = srcId;
  const extra = [];
  if (setUp && w.branches[srcName] !== undefined) {
    w.upstream[srcName] = `origin/${dst}`;
    extra.push(`branch '${srcName}' set up to track 'origin/${dst}'.`);
  }
  return { ok: true, line, extra };
}

function cmdPush(w, ctx, args) {
  const p = parse(args, ['--repo']);
  const force = p.has('--force', '-f');
  const lease = Object.keys(p.flags).some((k) => k.startsWith('--force-with-lease'));
  const setUp = p.has('-u', '--set-upstream');
  const del = p.has('--delete', '-d');
  let [remote, ...specs] = p.pos;
  if (w.op) return fail(w, `error: you are in the middle of a ${w.op.kind}`);
  if (remote && remote !== 'origin') return fail(w, `fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.`);
  if (!remote) remote = 'origin';
  if (!specs.length && !p.has('--tags')) {
    if (!w.head.branch) return fail(w, 'fatal: You are not currently on a branch.');
    if (!w.upstream[w.head.branch] && !setUp) {
      return fail(w, `fatal: The current branch ${w.head.branch} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin ${w.head.branch}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.`);
    }
    specs = [w.head.branch];
  }
  const lines2 = [];
  const extras = [];
  let ok = true;
  let changed = false;
  if (p.has('--tags')) {
    for (const [t, tag] of Object.entries(w.tags)) {
      if (w.remote.tags[t] !== tag.id) {
        w.remote.tags[t] = tag.id;
        lines2.push(` * [new tag]         ${t} -> ${t}`);
        changed = true;
      }
    }
  }
  for (const spec of specs) {
    if (del || spec.startsWith(':')) {
      const name = spec.replace(/^:/, '');
      if (!(name in w.remote.refs)) {
        ok = false;
        fail(w, `error: unable to delete '${name}': remote ref does not exist\nerror: failed to push some refs to '${HOST}'`);
        continue;
      }
      if (w.protection.branch === name) {
        ok = false;
        say(w, `remote: error: GH006: Protected branch update failed for refs/heads/${name}.\nremote: error: Cannot delete this protected branch.\nTo ${HOST}\n ! [remote rejected] ${name} (protected branch hook declined)\nerror: failed to push some refs to '${HOST}'`, 'err');
        continue;
      }
      delete w.remote.refs[name];
      lines2.push(` - [deleted]         ${name}`);
      changed = true;
      continue;
    }
    let [src, dst] = spec.includes(':') ? spec.split(':') : [spec, spec];
    if (src === 'HEAD') {
      if (!w.head.branch) {
        ok = false;
        fail(w, 'fatal: You are not currently on a branch.');
        continue;
      }
      src = w.head.branch;
      if (!spec.includes(':')) dst = src;
    }
    if (src in w.tags && !(src in w.branches)) {
      if (w.remote.tags[src] === w.tags[src].id) lines2.push(`   [up to date]      ${src} -> ${src}`);
      else {
        w.remote.tags[src] = w.tags[src].id;
        lines2.push(` * [new tag]         ${src} -> ${src}`);
        changed = true;
      }
      continue;
    }
    if (!(src in w.branches)) {
      ok = false;
      fail(w, `error: src refspec ${src} does not match any\nerror: failed to push some refs to '${HOST}'`);
      continue;
    }
    const r = pushOne(w, ctx, { dst, srcId: w.branches[src], srcName: src, force, lease, setUp });
    if (!r.ok) {
      ok = false;
      continue;
    }
    lines2.push(r.line);
    if (r.extra) extras.push(...r.extra);
    if (!r.noop) changed = true;
  }
  if (lines2.length && lines2.every((l) => l.includes('[up to date]'))) say(w, 'Everything up-to-date');
  else if (lines2.length) say(w, `To ${HOST}\n${lines2.join('\n')}${extras.length ? `\n${extras.join('\n')}` : ''}`);
  void ok;
  return changed;
}

// ---------------------------------------------------------------- gh

function reviewText(pr) {
  if (!pr.reviewers.length) return 'none';
  return pr.reviewers.map((r) => `${r.name} (${r.state === 'approved' ? 'approved' : 'requested'})`).join(', ');
}

function findPr(w, ref) {
  if (ref) {
    const n = String(ref).replace(/^#/, '').replace(/.*\/pull\//, '');
    if (/^\d+$/.test(n)) return prByNumber(w, n);
    return w.remote.prs.find((p) => p.head === ref && p.state === 'open');
  }
  if (!w.head.branch) return null;
  return w.remote.prs.find((p) => p.head === w.head.branch && p.state === 'open') || null;
}

function cmdGhPr(w, ctx, sub, args) {
  const p = parse(args, ['--title', '-t', '--body', '-b', '--base', '-B', '--head', '-H', '--reviewer', '-r', '--add-reviewer', '--subject', '--body-file']);
  if (sub === 'list') {
    const open = w.remote.prs.filter((x) => x.state === 'open');
    say(w, open.length ? open.map((x) => `#${x.n}\t${x.title}\t${x.head}\t${x.draft ? 'DRAFT' : 'OPEN'}`).join('\n') : `no open pull requests in ${REPO}`);
    return false;
  }
  if (sub === 'create') return ghCreate(w, ctx, p);
  const pr = findPr(w, p.pos[0]);
  if (!pr) return fail(w, p.pos[0] ? `no pull requests found for "${p.pos[0]}"` : `no pull requests found for branch "${w.head.branch || 'HEAD'}"`);
  if (sub === 'view') {
    const commits = commitsBetween(w, w.remote.refs[pr.base], prHeadTip(w, pr)).length;
    const state = pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : pr.draft ? 'Draft' : 'Open';
    const checks = pr.state === 'merged' ? [] : prChecks(w, pr);
    const blockers = pr.state === 'open' ? prBlockers(w, pr) : [];
    const out = [`${pr.title} #${pr.n}`, `${state} • ${pr.author} wants to merge ${plural(commits, 'commit')} into ${pr.base} from ${pr.head}`, `Reviewers: ${reviewText(pr)}`];
    if (checks.length) out.push(`Checks: ${checks.map((c) => `${c.name} ${c.state === 'pass' ? 'passing' : 'FAILING'}`).join(', ')}`);
    if (pr.state === 'open') out.push(blockers.length ? `Merge: blocked, ${blockers.map((b) => b.text).join('; ')}` : 'Merge: ready');
    if (pr.body) out.push('', pr.body);
    out.push('', `View this pull request on GitHub: ${WEB}/pull/${pr.n}`);
    say(w, out.join('\n'));
    return false;
  }
  if (sub === 'checks') {
    const checks = prChecks(w, pr);
    if (!checks.length) return fail(w, `no checks reported on the '${pr.head}' branch`);
    const failing = checks.filter((c) => c.state === 'fail');
    const out = [failing.length ? 'Some checks were not successful' : 'All checks were successful', `0 cancelled, ${failing.length} failing, ${checks.length - failing.length} successful, 0 skipped, and 0 pending checks`, ''];
    for (const c of checks) out.push(`${c.state === 'pass' ? '✓' : 'X'}  ${c.name}  ${c.state === 'pass' ? 'pass' : 'fail'}  41s  ${WEB}/actions/runs/${pr.n}${c.state === 'pass' ? 1 : 2}`);
    for (const c of failing) out.push('', `${c.name}: ${c.log}`);
    say(w, out.join('\n'), failing.length ? 'err' : 'out');
    return false;
  }
  if (sub === 'ready') {
    if (!pr.draft) return fail(w, `Pull request #${pr.n} is already "ready for review"`);
    pr.draft = false;
    requestOwners(w, ctx, pr);
    say(w, `✓ Pull request #${pr.n} is marked as "ready for review"`);
    return true;
  }
  if (sub === 'edit') {
    const names = (p.flags['--add-reviewer'] || []).flatMap((x) => x.split(',')).map((x) => x.replace(/^@/, ''));
    if (!names.length) return fail(w, 'nothing to edit: pass --add-reviewer name[,name]');
    requestReviewers(w, ctx, pr, names);
    say(w, `${WEB}/pull/${pr.n}`);
    return true;
  }
  if (sub === 'review') {
    if (pr.author === ME) return fail(w, 'failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)');
    return fail(w, 'Reviews come from your teammates in this game.');
  }
  if (sub === 'merge') return ghMerge(w, ctx, pr, p);
  return fail(w, `unknown command "${sub}" for "gh pr". This game supports create, list, view, checks, ready, edit and merge.`);
}

function ghCreate(w, ctx, p) {
  if (!w.head.branch) return fail(w, 'fatal: not on a branch; switch to the branch first');
  const head = p.val('--head', '-H') || w.head.branch;
  const base = p.val('--base', '-B') || w.protection.branch || 'main';
  if (!(head in w.remote.refs)) return fail(w, 'aborted: you must first push the current branch to a remote, or use the --head flag');
  const existing = w.remote.prs.find((x) => x.head === head && x.state === 'open');
  if (existing) return fail(w, `a pull request for branch "${head}" into branch "${base}" already exists:\n${WEB}/pull/${existing.n}`);
  const tip = w.remote.refs[head];
  const baseTip = w.remote.refs[base];
  const commits = commitsBetween(w, baseTip, tip);
  if (!commits.length) return fail(w, `pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`);
  let title = p.val('--title', '-t');
  let body = p.val('--body', '-b');
  const fill = p.has('--fill', '-f', '--fill-first', '--fillverbose');
  if (fill) {
    const first = w.commits[commits[0]];
    if (commits.length === 1 || p.has('--fill-first')) {
      title = title || subject(first);
      body = body ?? first.msg.split('\n').slice(1).join('\n').trim();
    } else {
      const nice = head.replace(/[-_/]+/g, ' ');
      title = title || `${nice[0].toUpperCase()}${nice.slice(1)}`;
      body = body ?? commits.map((id) => `- ${subject(w.commits[id])}`).join('\n');
    }
  } else if (title === undefined || body === undefined) {
    return fail(w, 'must provide `--title` and `--body` (or `--fill` or `fill-first` or `--fillverbose`) when not running interactively');
  }
  const draft = p.has('--draft', '-d');
  const pr = { n: w.remote.next++, title, body: body || '', head, base, author: ME, draft, state: 'open', reviewers: [], headTip: tip };
  w.remote.prs.push(pr);
  const asked = [...(p.flags['--reviewer'] || []), ...(p.flags['-r'] || [])].flatMap((x) => x.split(',')).map((x) => x.replace(/^@/, ''));
  if (!draft) {
    requestOwners(w, ctx, pr);
    requestReviewers(w, ctx, pr, asked);
  } else lesson(w, ctx, 'draft-pr', `#${pr.n}`);
  say(w, `\nCreating ${draft ? 'draft ' : ''}pull request for ${head} into ${base} in ${REPO}\n\n${WEB}/pull/${pr.n}`);
  return true;
}

function ghMerge(w, ctx, pr, p) {
  const squash = p.has('--squash', '-s');
  const merge = p.has('--merge', '-m');
  const rebase = p.has('--rebase', '-r');
  if (pr.state !== 'open') return fail(w, `X Pull request ${REPO}#${pr.n} is already ${pr.state}`);
  if (!squash && !merge && !rebase) return fail(w, '--merge, --rebase, or --squash required when not running interactively');
  if ([squash, merge, rebase].filter(Boolean).length > 1) return fail(w, 'only one of --merge, --rebase, or --squash can be enabled');
  const blockers = prBlockers(w, pr);
  const admin = p.has('--admin');
  if (blockers.length && !(admin && !blockers.some((b) => b.id === 'conflict' || b.id === 'draft'))) {
    const lines2 = [`X Pull request ${REPO}#${pr.n} is not mergeable: ${blockers.some((b) => b.id === 'conflict') ? 'the merge commit cannot be cleanly created.' : pr.draft ? 'it is a draft.' : 'the base branch policy prohibits the merge.'}`];
    for (const b of blockers) lines2.push(`  - ${b.text}`);
    if (!blockers.some((b) => b.id === 'conflict' || b.id === 'draft')) lines2.push('To have the pull request merged after all the requirements have been met, add the `--auto` flag.', 'To use administrator privileges to immediately merge the pull request, add the `--admin` flag.');
    say(w, lines2.join('\n'), 'err');
    for (const b of blockers) lesson(w, ctx, { draft: 'draft-pr', conflict: 'conflict', owner: 'owner-review-missing', checks: 'checks-failing' }[b.id], `#${pr.n}`);
    return false;
  }
  if (blockers.length) penalize(w, ctx, 'admin-bypass', 30, `#${pr.n}`);
  const { mb, res } = prMergeability(w, pr);
  const baseTip = w.remote.refs[pr.base];
  const headTip = prHeadTip(w, pr);
  let newTip;
  let verb;
  if (squash) {
    newTip = newCommit(w, { parents: [baseTip], msg: `${pr.title} (#${pr.n})`, tree: res.tree, author: ME });
    verb = 'Squashed and merged';
  } else if (merge) {
    newTip = newCommit(w, { parents: [baseTip, headTip], msg: `Merge pull request #${pr.n} from ${REPO.split('/')[0]}/${pr.head}\n\n${pr.title}`, tree: res.tree, author: ME });
    verb = 'Merged';
  } else {
    newTip = baseTip;
    for (const id of commitsBetween(w, mb, headTip).filter((x) => w.commits[x].parents.length < 2)) {
      const c = w.commits[id];
      const parent = c.parents[0] ? w.commits[c.parents[0]].tree : {};
      const r = mergeTrees(parent, w.commits[newTip].tree, c.tree, { ours: pr.base, theirs: id });
      if (!treeEq(r.tree, w.commits[newTip].tree)) newTip = newCommit(w, { parents: [newTip], msg: c.msg, tree: r.tree, author: c.author });
    }
    verb = 'Rebased and merged';
  }
  w.remote.refs[pr.base] = newTip;
  pr.state = 'merged';
  pr.headTip = headTip;
  pr.mergedHow = squash ? 'squash' : merge ? 'merge' : 'rebase';
  const out = [`✓ ${verb} pull request #${pr.n} (${pr.title})`];
  if (squash) lesson(w, ctx, 'squash-merged', `#${pr.n}`);
  if (p.has('--delete-branch', '-d')) {
    delete w.remote.refs[pr.head];
    const wasCurrent = w.head.branch === pr.head;
    if (wasCurrent) {
      const target = w.branches[pr.base];
      if (target !== undefined && checkoutTarget(w, target, `checkout: moving from ${pr.head} to ${pr.base}`)) {
        w.head = { branch: pr.base };
        const upd = w.remote.refs[pr.base];
        w.tracking[`origin/${pr.base}`] = upd;
        const tree = headTree(w);
        if (isAncestor(w, headId(w), upd) && headId(w) !== upd) {
          const d = treeDiff(tree, w.commits[upd].tree);
          out.push(`From ${HOST.replace(/\.git$/, '')}`, ` * branch            ${pr.base}     -> FETCH_HEAD`, `Updating ${headId(w)}..${upd}`, 'Fast-forward', ...statBlock(d));
          applyTree(w, tree, w.commits[upd].tree);
          setHead(w, upd, 'pull: Fast-forward');
        }
      }
    }
    if (pr.head in w.branches && w.head.branch !== pr.head) {
      delete w.branches[pr.head];
      delete w.upstream[pr.head];
    }
    out.push(`✓ Deleted branch ${pr.head}${wasCurrent && w.head.branch === pr.base ? ` and switched to branch ${pr.base}` : ''}`);
  }
  say(w, out.join('\n'));
  return true;
}

function cmdGh(w, ctx, args) {
  const [area, sub, ...rest] = args;
  if (area === 'pr') return cmdGhPr(w, ctx, sub, rest);
  if (area === 'auth' && sub === 'status') {
    say(w, `github.com\n  ✓ Logged in to github.com account ${ME}\n  - Git operations protocol: ssh`);
    return false;
  }
  if (area === '--version') {
    say(w, 'gh version 2.65.0');
    return false;
  }
  return fail(w, `This game supports "gh pr create | list | view | checks | ready | edit | merge". You typed: gh ${args.join(' ')}`);
}

// ---------------------------------------------------------------- the terminal

const HELP = [
  'Commands in this game:',
  '  git  status | log | diff | show | add | rm | commit | branch | switch | checkout',
  '       merge | rebase | cherry-pick | revert | reset | restore | stash | tag | reflog',
  '       fetch | pull | push | config pull.rebase true|false',
  '  gh   pr create | list | view | checks | ready | edit | merge',
  '  echo "text" >> file, cat file, ls    (or use the file editor)',
  'Reading commands are free. Commands that change something take a step.',
].join('\n');

function dispatchGit(w, ctx, args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'status': return cmdStatus(w);
    case 'log': return cmdLog(w, rest);
    case 'diff': return cmdDiff(w, rest);
    case 'show': return cmdShow(w, rest);
    case 'reflog': return cmdReflog(w);
    case 'branch': return cmdBranch(w, ctx, rest);
    case 'switch': return cmdSwitch(w, ctx, rest, false);
    case 'checkout': return cmdCheckout(w, ctx, rest);
    case 'restore': return cmdRestore(w, ctx, rest);
    case 'add': return cmdAdd(w, ctx, rest);
    case 'rm': return cmdRm(w, ctx, rest);
    case 'commit': return cmdCommit(w, ctx, rest);
    case 'merge': return cmdMerge(w, ctx, rest);
    case 'rebase': return cmdRebase(w, ctx, rest);
    case 'cherry-pick': return cmdPick(w, ctx, rest, 'pick');
    case 'revert': return cmdPick(w, ctx, rest, 'revert');
    case 'reset': return cmdReset(w, ctx, rest);
    case 'stash': return cmdStash(w, ctx, rest);
    case 'tag': return cmdTag(w, ctx, rest);
    case 'config': return cmdConfig(w, rest);
    case 'fetch': return cmdFetch(w, ctx, rest);
    case 'pull': return cmdPull(w, ctx, rest);
    case 'push': return cmdPush(w, ctx, rest);
    case 'remote':
      say(w, `origin\t${HOST} (fetch)\norigin\t${HOST} (push)`);
      return false;
    case 'clone':
    case 'init':
      return fail(w, 'You already have a clone of acme/site here.');
    case undefined:
      say(w, HELP);
      return false;
    default:
      return fail(w, `git: '${cmd}' is not supported in this game. Type "help" for the list.`);
  }
}

function shellCommand(w, cmd, args) {
  if (cmd === 'ls') {
    say(w, Object.keys(w.worktree).sort().join('\n'));
    return false;
  }
  if (cmd === 'cat') {
    for (const f of args) {
      if (w.worktree[f] === undefined) fail(w, `cat: ${f}: No such file or directory`);
      else say(w, w.worktree[f]);
    }
    return false;
  }
  if (cmd === 'echo') {
    const i = args.findIndex((a) => a === '>' || a === '>>');
    if (i === -1) {
      say(w, args.join(' '));
      return false;
    }
    const file = args[i + 1];
    if (!file) return fail(w, 'bash: syntax error near unexpected token `newline\'');
    const text = args.slice(0, i).join(' ');
    const cur = w.worktree[file];
    w.worktree[file] = args[i] === '>>' && cur !== undefined && cur !== '' ? `${cur}\n${text}` : text;
    return 'free';
  }
  return undefined;
}

// Runs one terminal line. Returns false (read-only or rejected), 'free' (valid, unscored) or true (a step).
export function execute(w, ctx, line) {
  const text = line.trim().replace(/^\$\s*/, '');
  if (!text) return false;
  w.term.push({ kind: 'cmd', text: `$ ${text}` });
  const args = tokenize(text);
  if (!args) return fail(w, 'bash: unexpected EOF while looking for matching quote');
  const [cmd, ...rest] = args;
  let result;
  if (cmd === 'git') result = dispatchGit(w, ctx, rest);
  else if (cmd === 'gh') result = cmdGh(w, ctx, rest);
  else if (cmd === 'help') {
    say(w, HELP);
    result = false;
  } else if (cmd === 'clear') {
    w.term.length = 0;
    result = false;
  } else {
    result = shellCommand(w, cmd, rest);
    if (result === undefined) result = fail(w, `bash: ${cmd}: command not found. Type "help" for what this terminal supports.`);
  }
  if (result === true) ctx.step();
  return result === true ? true : result;
}

// The mini editor: replaces a file in the working tree (what saving in an editor does).
export function editFile(w, ctx, path, text) {
  const clean = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (!path || w.worktree[path] === clean) return false;
  w.worktree[path] = clean;
  w.term.push({ kind: 'note', text: `# saved ${path} in the editor` });
  return 'free';
}

export const listFiles = (w) => Object.keys(w.worktree).sort();

// What the working-tree panel shows about the checked-out branch.
export function branchInfo(w) {
  const b = w.head.branch;
  const up = b && w.upstream[b];
  const info = { branch: b || null, detached: b ? null : w.head.detached, upstream: up || null, ahead: 0, behind: 0, gone: false, stash: w.stash.length };
  if (up && up in w.tracking) Object.assign(info, aheadBehind(w, w.branches[b], w.tracking[up]));
  else if (up) info.gone = true;
  if (w.op) {
    const left = w.unmerged.length;
    info.op = w.op.kind === 'rebase' ? `Rebase in progress onto ${w.op.onto}: ${plural(w.op.todo.length, 'commit')} left` : `${w.op.kind[0].toUpperCase()}${w.op.kind.slice(1)} in progress`;
    info.opHint = left ? `${plural(left, 'file')} to resolve: edit, git add, then ${w.op.kind === 'rebase' ? 'git rebase --continue' : w.op.kind === 'merge' ? 'git commit' : `git ${w.op.kind} --continue`}` : w.op.kind === 'rebase' ? 'All resolved: git rebase --continue' : 'All resolved: git commit';
  }
  return info;
}

// ---------------------------------------------------------------- turns, goals, outcome

export function tick(w, ctx) {
  w.ticks = ctx.ticks;
  for (const item of w.schedule) {
    if (item.tick !== ctx.ticks) continue;
    if (item.push) {
      const tip = w.remote.refs[item.push.branch];
      const tree = { ...w.commits[tip].tree, ...(item.push.set || {}) };
      for (const x of item.push.del || []) delete tree[x];
      w.remote.refs[item.push.branch] = newCommit(w, { parents: [tip], msg: item.push.msg, tree, author: item.push.author });
    }
    ctx.fire(item.event, item.detail);
    ctx.resolve(item.event);
  }
  for (const pr of w.remote.prs) {
    if (pr.state !== 'open' || pr.draft) continue;
    for (const r of pr.reviewers) {
      if (r.state === 'requested' && ctx.ticks - r.at >= w.reviewDelay) {
        r.state = 'approved';
        ctx.fire('review-approved', `${r.name} on #${pr.n}`);
        ctx.resolve('review-approved');
      }
    }
  }
}

function checkGoal(w, g) {
  switch (g.type) {
    case 'remote-file': {
      const t = remoteTree(w, g.branch || 'main')[g.path];
      return t !== undefined && (g.has || []).every((s) => t.includes(s)) && (g.hasNot || []).every((s) => !t.includes(s));
    }
    case 'remote-clean': {
      const tree = remoteTree(w, g.branch || 'main');
      return Object.values(tree).every((t) => !hasMarkers(t)) && runChecks(w, tree).every((c) => c.state === 'pass');
    }
    case 'pr-merged':
      return w.remote.prs.filter((x) => x.state === 'merged' && x.author === ME).length >= (g.min || 1);
    case 'main-synced':
      return w.branches.main !== undefined && w.branches.main === w.remote.refs.main;
    case 'clean':
      return isClean(w) && !w.op;
    case 'ancestor':
      return isAncestor(w, w.keys[g.commit], w.remote.refs[g.of || 'main']);
    case 'wip-safe': {
      const inTree = (t) => Object.values(t).some((s) => s.includes(g.marker));
      const kept = inTree(w.worktree) || w.stash.some((s) => inTree(s.tree));
      const leaked = Object.values(w.remote.refs).some((id) => inTree(w.commits[id].tree));
      return kept && !leaked;
    }
    default:
      return false;
  }
}

export function goalStatus(w) {
  return w.goals.map((g) => ({ id: g.id, text: g.text, hint: g.hint, done: checkGoal(w, g) }));
}

export function isWon(w) {
  return w.health >= w.minHealth && !w.op && !w.unmerged.length && goalStatus(w).every((g) => g.done) && !Object.values(w.worktree).some(hasMarkers);
}

export function isLost(w) {
  if (w.health < w.minHealth) return true;
  return w.ticks >= w.winTicks && !isWon(w);
}

// ---------------------------------------------------------------- views for the UI

export function repoBadges(w) {
  const p = w.protection;
  const out = [];
  if (!p.branch) return [{ ok: false, text: 'main is not protected' }, { ok: true, text: 'Squash merging allowed' }];
  out.push({ ok: true, text: `${p.branch} is protected` });
  if (p.requirePr) out.push({ ok: true, text: 'Pull request required' });
  if (p.approvals === 'codeowner') out.push({ ok: true, text: 'Code-owner approval required' });
  for (const c of p.checks || []) out.push({ ok: true, text: `Check "${c}" must pass` });
  if (p.requirePr) out.push({ ok: true, text: 'No force-push' });
  return out;
}

export function ownersLines(w) {
  return w.owners.map((r) => `${r.pattern.padEnd(14)} ${r.owners.join(' ')}`);
}

export function mainBuild(w) {
  const checks = runChecks(w, remoteTree(w, 'main'));
  if (!checks.length) return null;
  return checks.every((c) => c.state === 'pass') ? 'passing' : 'FAILING';
}

export function prCards(w) {
  return w.remote.prs
    .filter((pr) => pr.state === 'open' || pr.state === 'merged')
    .slice(-4)
    .map((pr) => {
      const checks = pr.state === 'open' ? prChecks(w, pr) : [];
      return {
        n: pr.n,
        title: pr.title,
        head: pr.head,
        base: pr.base,
        state: pr.state === 'merged' ? `merged (${pr.mergedHow})` : pr.draft ? 'draft' : 'open',
        reviewers: pr.reviewers.map((r) => ({ name: r.name, state: r.state })),
        checks: checks.map((c) => ({ name: c.name, state: c.state })),
        blockers: pr.state === 'open' ? prBlockers(w, pr).map((b) => b.text) : [],
      };
    });
}

// ---------------------------------------------------------------- tap-to-compose

const NAME_IDEAS = ['feature/update', 'fix/typo', 'docs/update'];

// What the prompt offers next, given the words already on the line (see shared/prompt.js). Reading
// commands run when tapped; commands that change something are filled in and wait for Run.
export function nextWords(w, words) {
  const read = (text) => ({ text, full: true, run: true });
  const fill = (text) => ({ text, full: true });
  if (!words.length) {
    return [read('git status'), read('git log --oneline --graph --all'), read('git diff'), read('git branch -a'), read('git fetch'), read('gh pr view'), fill('git add .'), fill('git commit -m "Update"'), 'git', 'gh'];
  }
  const [tool, cmd, a] = words;
  const branches = Object.keys(w.branches);
  const refs = [...branches, ...Object.keys(w.remote.refs).map((b) => `origin/${b}`), 'HEAD~1', 'HEAD~2'];
  const files = Object.keys(w.worktree).sort();
  if (tool === 'gh') {
    if (!cmd) return ['pr'];
    if (cmd !== 'pr') return [];
    if (words.length === 2) return ['create', 'list', 'view', 'checks', 'ready', 'edit', 'merge'];
    const sub = words[2];
    const open = w.remote.prs.filter((p) => p.state === 'open').map((p) => String(p.n));
    if (sub === 'merge') return [...(words.length === 3 ? open : []), '--squash', '--merge', '--rebase', '--delete-branch'];
    if (words.length === 3 && ['view', 'checks', 'ready', 'edit'].includes(sub)) return open;
    if (sub === 'create') return ['--fill', '--draft'];
    return [];
  }
  if (tool !== 'git') return [];
  if (!cmd) return ['status', 'log', 'diff', 'add', 'commit', 'switch', 'push', 'pull', 'fetch', 'branch', 'merge', 'rebase', 'stash', 'reset', 'restore', 'show', 'cherry-pick', 'revert', 'checkout', 'rm', 'tag', 'reflog'];
  switch (cmd) {
    case 'log':
      return ['--oneline', '--graph', '--all', ...branches];
    case 'diff':
      return ['--staged', ...refs];
    case 'show':
    case 'merge':
    case 'cherry-pick':
    case 'revert':
      return refs;
    case 'switch':
    case 'checkout':
      return a === '-c' || a === '-b' ? (words.length === 3 ? NAME_IDEAS : []) : ['-c', ...branches];
    case 'branch':
      return ['-a', '-d', '-vv', ...(a === '-d' ? branches.filter((b) => b !== w.head.branch) : words.length === 2 ? NAME_IDEAS : [])];
    case 'add':
      return ['.', ...files];
    case 'rm':
    case 'restore':
      return ['--staged', ...files];
    case 'commit':
      return a === '-m' ? [] : ['-m "Update"', '--amend', '--no-edit'];
    case 'reset':
      return ['--hard', '--soft', 'HEAD~1', ...refs.filter((r) => r.startsWith('origin/'))];
    case 'stash':
      return ['pop', 'list'];
    case 'fetch':
      return ['--all', '--prune'];
    case 'pull':
      return ['--rebase', '--no-rebase'];
    case 'rebase':
      return ['--continue', '--abort', ...refs];
    case 'push':
      return ['-u', 'origin', '--force-with-lease', ...(words.includes('origin') ? ['HEAD', ...branches] : [])];
    default:
      return [];
  }
}
