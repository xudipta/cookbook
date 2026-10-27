# Index Fund

Tables grow, queries slow down, and every index costs writes and disk. Read the plans, add only the indexes that pay off, then ship schema changes through migrations without breaking production.

<div id="game" data-game="database">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- Type SQL in the terminal (or use the buttons). `EXPLAIN`, `SELECT` and the `\d` commands are free.
  `CREATE INDEX`, `DROP INDEX`, `ALTER TABLE`, `migrate up` and a saved file cost a move.
- **Next day** (`d`) ends the day. Anything still over budget overnight burns error budget, and tables
  keep growing. Win by reaching the last day with every endpoint within its latency budget, writes and
  storage within budget, and nothing left open.
- Levels 1 and 2 tune a shop's queries: the feed shows each query's latency against its budget,
  and click **EXPLAIN** for its plan. Level 3 is a release pipeline: test on staging, migrate
  production, deploy the app in the order that keeps it serving, and roll back a bad release.
- The planner is a model of Postgres: it times the plan and does not return the rows.

## Syntax worth remembering

```sql
EXPLAIN ANALYZE SELECT id FROM orders WHERE user_id = 42;   -- Seq Scan vs Index Scan
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);  -- column order matters
DROP INDEX idx_orders_status;                               -- unused indexes still cost writes
SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0;      -- which indexes nothing uses
```

```bash
migrate up                 # apply pending NNNN_name.up.sql files, in order
migrate down 1             # reverse the latest one with its .down.sql
migrate create add_coupon  # a new numbered pair; never edit one that has already run
```

Notes behind it: [Queries and indexing](../../../topics/database/notes/03-queries-and-indexing.md) and
[Migrations](../../../topics/database/notes/02-migrations.md).
