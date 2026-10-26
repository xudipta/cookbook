# Migrations

A migration is a small, numbered SQL file that moves the schema from one version to the
next; a migration tool applies them in order and records which ones have run in a
tracking table (`schema_migrations` or similar), so re-running the tool is a no-op for
anything already applied.

```mermaid
flowchart LR
    M1["0001_create_users.up.sql"] --> M2["0002_create_products.up.sql"]
    M2 --> M3["0003_create_orders.up.sql"]
    M3 --> M4["0004_create_order_items.up.sql"]
    M4 --> DB[(Current schema)]
    Track["schema_migrations table\ntracks which have run"] -.-> M1
    Track -.-> M2
    Track -.-> M3
    Track -.-> M4
```

`examples/migrations/` builds up `examples/schema/schema.sql` one table at a time, in
dependency order — `0003_create_orders.up.sql` can `REFERENCES users (id)` because
`0001` already ran.

## Why not just hand-edit the schema

- **Reproducibility** — a fresh environment (a new dev's laptop, a CI test database, a
  disaster-recovery restore) gets to the exact same schema by replaying the same
  numbered files, instead of someone remembering every `ALTER TABLE` they ran by hand.
- **Review** — a migration is a diff in a pull request like any other code change,
  reviewable before it touches a real database.
- **Ordering** — numbered/timestamped filenames make the apply order unambiguous, even
  with multiple people adding migrations in parallel branches.

## up/down

```sql
-- 0001_create_users.up.sql
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```sql
-- 0001_create_users.down.sql
DROP TABLE users;
```

Every `up` gets a matching `down` that reverses it, so a bad migration can be rolled
back without a manual cleanup script. In practice `down` migrations are exercised far
less than `up` (most teams roll forward with a fix instead of rolling back a production
schema change once other migrations depend on it) — but write them anyway; the cost is
small and they're essential in dev/CI where you rebuild the database from scratch often.

Test the pair, not just the `up`: on a throwaway database run `up`, `down`, `up`. A `down`
that is empty or wrong does nothing visible until the day you need a rollback, and by then
the next `up` fails with "column already exists".

## Never edit an applied migration

Once a migration has run anywhere beyond your laptop, its file is history. The tracking
table says it already ran, so production will never run the new text, while a fresh database
built from the files will — and the two schemas quietly differ. Some tools (Flyway,
Liquibase) store a checksum of each applied file and refuse to run when it changed;
`golang-migrate` does not, so it is a review rule. Put the change in a **new** numbered
migration, and keep the old file as it was.

## Running them

Tooling differs by ecosystem but the shape is the same — point a CLI at a database URL
and a migrations directory:

```bash
# golang-migrate
migrate -database "$DATABASE_URL" -path examples/migrations up
migrate -database "$DATABASE_URL" -path examples/migrations down 1

# Flyway (Java ecosystem)
flyway -url=$DATABASE_URL migrate

# Alembic (Python/SQLAlchemy)
alembic upgrade head
```

## In CI/CD

A deploy pipeline typically runs migrations as a **separate step before** the new
application version starts (see `topics/cicd/notes/03-deployment-strategies.md` for the
surrounding rollout) — the new code and the new schema need to be compatible for the
window where old and new app versions run side by side during a rolling deploy, which is
why "add a column" is safe to ship in the same release as the code that uses it, but
"drop a column" needs the code stop using it first, in an earlier release.
