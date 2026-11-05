// Unit tests for the Night Shift simulator: the shell (shell.js, text.js, os.js) and the rules on top (sim.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, isWon, run, start, tick } from './sim.js';
import { scenario, stubCtx, printed } from '../shared/testkit.mjs';

function boot(levelId) {
  const { sc, levels } = scenario('linux', levelId);
  let w;
  const ctx = stubCtx(sc, (world, c) => tick(world, c), () => w);
  w = createWorld(sc);
  start(w, ctx);
  // One command the way the game runs it: a command that changes the machine costs a minute.
  const sh = (line) => {
    const from = w.term.length;
    const result = run(w, ctx, line);
    if (result === true) ctx.step();
    return { result, out: printed(w.term, from) };
  };
  return { w, ctx, sh, sc, levels };
}

// Table-driven: command -> exact output.
const READS = [
  ['pwd', '/home/ops'],
  ['cat /etc/hostname', 'web-01'],
  ['echo hello world', 'hello world'],
  ['echo "a   b"', 'a   b'],
  ['grep -c root /etc/passwd', '1'],
  ["echo a b c | awk '{print $2}'", 'b'],
  ['ls /nonexistent; echo $?', "ls: cannot access '/nonexistent': No such file or directory\n2"],
  ['true && echo yes', 'yes'],
  ['false || echo fallback', 'fallback'],
  ['false && echo never', ''],
];
for (const [line, expected] of READS) {
  test(`shell: ${line}`, () => {
    const { sh } = boot('first-night');
    assert.equal(sh(line).out, expected);
  });
}

test('shell: reading is free, changing the machine is a move', () => {
  const { sh } = boot('first-night');
  assert.equal(sh('ls -l').result, 'free');
  assert.equal(sh('cat /etc/hostname').result, 'free');
  assert.equal(sh('touch note.txt').result, true);
});

test('shell: a file a command wrote can be read back, and cp/mv/rm change it', () => {
  const { sh } = boot('first-night');
  sh('echo first > a.txt');
  assert.equal(sh('cat a.txt').out, 'first');
  sh('echo second >> a.txt');
  assert.equal(sh('cat a.txt').out, 'first\nsecond');
  sh('cp a.txt b.txt');
  sh('mv b.txt c.txt');
  assert.match(sh('ls').out, /c\.txt/);
  assert.doesNotMatch(sh('ls').out, /b\.txt/);
  sh('rm a.txt');
  assert.match(sh('cat a.txt').out, /No such file or directory/);
});

test('shell: an unknown command says so instead of crashing', () => {
  const { sh } = boot('first-night');
  assert.match(sh('frobnicate --now').out, /command not found|not in this sim/);
});

test('shell: chmod changes what ls shows and what can run', () => {
  const { sh } = boot('first-night');
  assert.match(sh('ls -l /opt/deploy').out, /deploy\.sh/);
  assert.doesNotMatch(sh('ls -l /opt/deploy/deploy.sh').out, /^-rwx/m);
  assert.equal(sh('chmod +x /opt/deploy/deploy.sh').result, true);
  assert.match(sh('ls -l /opt/deploy/deploy.sh').out, /-rwx/);
});

test('rules: init ignores a polite kill, but kill -9 on PID 1 ends the level', () => {
  const { w, sh } = boot('first-night');
  sh('kill 1');
  assert.equal(w.dead, null);
  sh('kill -9 1');
  assert.equal(w.dead, 'killed-init');
  assert.equal(isWon(w), false);
});

test('rules: doing nothing never wins, and the open incident costs health every minute', () => {
  const { w, ctx } = boot('first-night');
  const before = w.health;
  for (let i = 0; i < w.winTicks + 2; i += 1) ctx.step();
  assert.equal(isWon(w), false);
  assert.ok(w.health < before, `health ${w.health} should have dropped from ${before}`);
});

// The property the scripted solutions rely on: replaying each level's `solution` wins it.
const { levels } = scenario('linux');
for (const level of levels) {
  test(`solution wins level "${level.id}"`, () => {
    const { w, ctx, sh } = boot(level.id);
    for (const step of [...level.solution].sort((a, b) => a.tick - b.tick)) {
      if (step.action === 'wait') ctx.step();
      else if (step.action === 'sh') sh(...step.args);
      else assert.fail(`unknown action ${step.action}`);
    }
    for (let i = 0; i < 100 && !isWon(w) && !w.dead; i += 1) ctx.step();
    assert.ok(!w.dead, `the solution ended the level: ${w.dead}`);
    assert.equal(isWon(w), true, `health ${w.health}, open ${w.open.map((o) => o.id)}`);
  });
}
