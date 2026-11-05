// Unit tests for the Index Fund simulator: the SQL subset and planner (sql.js) and the world rules (sim.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from './sim.js';
import { splitStatements, tokenize } from './sql.js';
import { scenario, stubCtx, printed } from '../shared/testkit.mjs';

function boot(levelId) {
  const { sc, levels } = scenario('database', levelId);
  let w;
  const ctx = stubCtx(sc, (world, c) => D.tick(world, c), () => w);
  w = D.createWorld(sc);
  D.start(w, ctx);
  const sql = (line) => {
    const from = w.term.length;
    const result = D.runLine(w, ctx, line);
    D.afterMove(w, ctx);
    return { result, out: printed(w.term, from) };
  };
  return { w, ctx, sql, sc, levels };
}

const costOf = (out) => Number(/cost=[\d.]+\.\.([\d.]+)/.exec(out)[1]);
const scanKind = (out) => (/(Seq Scan|Index Scan|Bitmap Heap Scan|Index Only Scan)/.exec(out) || [])[1];

test('sql: statements split on semicolons outside quotes', () => {
  assert.equal(splitStatements("SELECT 1; SELECT ';' ; ").filter((s) => String(s.text ?? s).trim()).length, 2);
});

test('sql: the tokenizer keeps quoted text together', () => {
  const toks = tokenize("SELECT * FROM users WHERE email = 'a b@c.d'");
  assert.ok(toks.some((t) => JSON.stringify(t).includes('a b@c.d')));
});

test('sql: an unsupported statement is an error that names what is supported', () => {
  const { sql } = boot('seq-scans');
  const { result, out } = sql('SELEC 1;');
  assert.equal(result, false);
  assert.match(out, /ERROR/);
  assert.match(out, /supports SELECT, EXPLAIN, CREATE INDEX/);
});

test('sql: an unknown column or index is an error', () => {
  const { sql } = boot('seq-scans');
  assert.match(sql('EXPLAIN SELECT * FROM orders WHERE nope = 1;').out, /column "nope" does not exist/);
  assert.match(sql('DROP INDEX nope;').out, /index "nope" does not exist/);
});

test('planner: no index means a seq scan of every row', () => {
  const { sql } = boot('seq-scans');
  const { out } = sql("EXPLAIN SELECT id FROM users WHERE email = 'a@b.c';");
  assert.equal(scanKind(out), 'Seq Scan');
});

test('planner: an index on the filter column turns the seq scan into an index scan and is far cheaper', () => {
  const { sql } = boot('seq-scans');
  const q = "EXPLAIN SELECT id FROM users WHERE email = 'a@b.c';";
  const before = sql(q).out;
  sql('CREATE UNIQUE INDEX idx_users_email ON users (email);');
  const after = sql(q).out;
  assert.equal(scanKind(after), 'Index Scan');
  assert.match(after, /using idx_users_email/);
  assert.ok(costOf(after) * 10 < costOf(before), `${costOf(after)} should be far below ${costOf(before)}`);
});

test('planner: the planner ignores an index when the filter keeps most of the table', () => {
  const { sql } = boot('seq-scans');
  sql('CREATE INDEX idx_orders_status ON orders (status);');
  assert.equal(scanKind(sql("EXPLAIN SELECT * FROM orders WHERE status = 'shipped';").out), 'Seq Scan');
});

test('planner: an index on (a, b) serves a and (a AND b) but not b alone', () => {
  const { sql } = boot('seq-scans');
  sql('CREATE INDEX idx_ab ON orders (user_id, status);');
  assert.equal(scanKind(sql('EXPLAIN SELECT * FROM orders WHERE user_id = 5;').out), 'Index Scan');
  assert.equal(scanKind(sql("EXPLAIN SELECT * FROM orders WHERE user_id = 5 AND status = 'new';").out), 'Index Scan');
  assert.equal(scanKind(sql("EXPLAIN SELECT * FROM orders WHERE status = 'new';").out), 'Seq Scan');
});

test('planner: dropping the index puts the seq scan back', () => {
  const { sql } = boot('seq-scans');
  const q = "EXPLAIN SELECT id FROM users WHERE email = 'a@b.c';";
  sql('CREATE UNIQUE INDEX idx_users_email ON users (email);');
  assert.equal(sql('DROP INDEX idx_users_email;').out, 'DROP INDEX');
  assert.equal(scanKind(sql(q).out), 'Seq Scan');
});

test('world: doing nothing does not win', () => {
  const { w, ctx } = boot('seq-scans');
  for (let i = 0; i < w.winTicks + 2; i += 1) ctx.step();
  assert.equal(D.isWon(w), false);
});

// The property the scripted solutions rely on: replaying each level's `solution` wins it.
const { levels } = scenario('database');
for (const level of levels) {
  test(`solution wins level "${level.id}"`, () => {
    const { w, ctx, sql } = boot(level.id);
    const afterMove = () => D.afterMove(w, ctx);
    for (const step of [...level.solution].sort((a, b) => a.tick - b.tick)) {
      if (step.action === 'sql') sql(...step.args);
      else if (step.action === 'nextDay') ctx.step();
      else if (step.action === 'saveFile') {
        assert.ok(D.saveFile(w, ...step.args), `saveFile ${step.args[0]} rejected`);
        afterMove();
      } else if (step.action === 'swap') {
        D.swapQuery(w, ctx, ...step.args);
        afterMove();
      } else assert.fail(`unknown action ${step.action}`);
    }
    assert.equal(D.isLost(w), false, `lost: health ${w.health}`);
    assert.equal(D.isWon(w), true, `not won: day ${w.days}/${w.winTicks}, health ${w.health}, open ${w.open.length}`);
  });
}
