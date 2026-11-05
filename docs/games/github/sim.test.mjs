// Unit tests for the Merge Conflict Rush simulator: the git model and the GitHub side (sim.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from './sim.js';
import { scenario, stubCtx, printed } from '../shared/testkit.mjs';

function boot(levelId) {
  const { sc, levels } = scenario('github', levelId);
  let w;
  const ctx = stubCtx(sc, (world, c) => G.tick(world, c), () => w);
  w = G.createWorld(sc);
  const git = (line) => {
    const from = w.term.length;
    const result = G.execute(w, ctx, line);
    return { result, out: printed(w.term, from) };
  };
  return { w, ctx, git, sc, levels };
}

test('merge3: edits to different lines merge cleanly', () => {
  const m = G.merge3(['a', 'b', 'c', 'd', 'e'], ['a', 'B', 'c', 'd', 'e'], ['a', 'b', 'c', 'D', 'e'], { ours: 'HEAD', theirs: 'x' });
  assert.deepEqual(m, { lines: ['a', 'B', 'c', 'D', 'e'], conflict: false });
});

test('merge3: edits to the same line conflict and leave markers', () => {
  const m = G.merge3(['a', 'b', 'c'], ['a', 'X', 'c'], ['a', 'Y', 'c'], { ours: 'HEAD', theirs: 'feature' });
  assert.equal(m.conflict, true);
  assert.deepEqual(m.lines, ['a', '<<<<<<< HEAD', 'X', '=======', 'Y', '>>>>>>> feature', 'c']);
  assert.equal(G.hasMarkers(m.lines.join('\n')), true);
});

test('merge3: a side that changed nothing takes the other side', () => {
  const m = G.merge3(['a', 'b'], ['a', 'b'], ['a', 'B'], { ours: 'HEAD', theirs: 'x' });
  assert.deepEqual(m, { lines: ['a', 'B'], conflict: false });
});

test('tokenize: quotes group words and an unbalanced quote is null', () => {
  assert.deepEqual(G.tokenize('git commit -m "two words" --amend'), ['git', 'commit', '-m', 'two words', '--amend']);
  assert.equal(G.tokenize('git commit -m "oops'), null);
});

test('commit messages: the checker names what is wrong', () => {
  assert.deepEqual(G.messageProblems('Add a LICENSE'), []);
  assert.ok(G.messageProblems('fixed stuff.').some((p) => /period/.test(p)));
  assert.ok(G.messageProblems('fixed stuff.').some((p) => /imperative/.test(p)));
  assert.ok(G.messageProblems('').length > 0);
});

test('git: a new branch is checked out and shows in status and log', () => {
  const { git } = boot('first-pr');
  assert.match(git('git switch -c docs/x').out, /Switched to a new branch 'docs\/x'/);
  assert.match(git('git status').out, /On branch docs\/x/);
  assert.match(git('git log --oneline').out, /HEAD -> docs\/x/);
});

test('git: reading is free, branching and committing are moves', () => {
  const { w, git } = boot('first-pr');
  assert.equal(git('git status').result, false);
  assert.equal(git('git log --oneline').result, false);
  assert.equal(git('git switch -c docs/x').result, true);
  G.editFile(w, { step() {} }, 'README.md', '# site\nchanged');
  assert.equal(git('git add README.md').result, true);
  assert.equal(git('git commit -m "Link CONTRIBUTING from the README"').result, true);
});

test('git: fetch moves origin/main but not your branch; a diverged push is rejected', () => {
  const { w, git } = boot('behind-main');
  const local = { ...w.branches };
  const tracked = w.tracking['origin/main'];
  assert.match(git('git fetch').out, /origin\/main/);
  assert.deepEqual(w.branches, local, 'fetch must not move local branches');
  assert.notEqual(w.tracking['origin/main'], tracked, 'fetch must move origin/main');
  git('git reset --hard HEAD~1');
  assert.match(git('git push').out, /rejected/);
});

test('git: merging a branch that edits the same lines stops on a conflict', () => {
  const { w, git } = boot('behind-main');
  git('git fetch');
  assert.match(git('git merge origin/main').out, /CONFLICT \(content\): Merge conflict in config\.yml/);
  assert.ok(w.unmerged.length > 0);
  assert.equal(G.hasMarkers(w.worktree['config.yml']), true);
  assert.equal(G.isWon(w), false);
});

test('git: committing with markers still in the file is refused or flagged, resolving then adding clears it', () => {
  const { w, git } = boot('behind-main');
  git('git fetch');
  git('git merge origin/main');
  G.editFile(w, { step() {} }, 'config.yml', 'service: web\ntimeout: 60\nretries: 3\nlog_level: info');
  assert.match(git('git add config.yml').out, /^$|./);
  assert.equal(w.unmerged.length, 0);
  assert.equal(G.hasMarkers(w.worktree['config.yml']), false);
});

test('git: reset --hard throws away uncommitted work', () => {
  const { w, git } = boot('first-pr');
  G.editFile(w, { step() {} }, 'README.md', 'changed');
  assert.match(git('git status').out, /modified:\s+README\.md/);
  git('git reset --hard');
  assert.notEqual(w.worktree['README.md'], 'changed');
  assert.match(git('git status').out, /nothing to commit, working tree clean/);
});

test('git: an unknown command is reported, not thrown', () => {
  const { git } = boot('first-pr');
  assert.match(git('frobnicate').out, /command not found/);
});

test('world: doing nothing is not a win', () => {
  const { w } = boot('first-pr');
  assert.equal(G.isWon(w), false);
});

// The property the scripted solutions rely on: replaying each level's `solution` wins it.
const { levels } = scenario('github');
for (const level of levels) {
  test(`solution wins level "${level.id}"`, () => {
    const { w, ctx, git } = boot(level.id);
    for (const step of [...level.solution].sort((a, b) => a.tick - b.tick)) {
      if (step.action === 'terminal') {
        git(...step.args);
      } else if (step.action === 'edit') {
        G.editFile(w, ctx, ...step.args);
      } else assert.fail(`unknown action ${step.action}`);
    }
    assert.equal(G.isLost(w), false, `lost: health ${w.health}, goals ${JSON.stringify(G.goalStatus(w).filter((g) => !g.done).map((g) => g.id))}`);
    assert.equal(G.isWon(w), true, `unmet goals: ${JSON.stringify(G.goalStatus(w).filter((g) => !g.done).map((g) => g.id))}`);
  });
}
