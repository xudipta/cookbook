# Workflow patterns

## Path filtering — skip irrelevant runs

```yaml
on:
  push:
    paths:
      - "src/**"
      - "!**/*.md"
```

`on.paths` decides whether the *whole workflow* runs. For finer-grained control within
one workflow (e.g. "only run the docker job if `topics/docker/**` changed"), compute a
`changes` output with `dorny/paths-filter` and gate jobs on it — this is exactly how this
repo's own `validate.yml` avoids spinning up a `kind` cluster for a docs-only change:

```yaml
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      docker: ${{ steps.filter.outputs.docker }}
    steps:
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            docker:
              - 'topics/docker/**'

  docker-lint:
    needs: changes
    if: needs.changes.outputs.docker == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "lint docker files"
```

## Caching dependencies

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: |
      npm-${{ runner.os }}-
```

Key the cache on a lockfile hash so it invalidates exactly when dependencies change; a
`restore-keys` prefix lets a near-miss still restore a partial cache instead of starting
cold. Many `setup-*` actions (`setup-node`, `setup-python`) have a built-in `cache:`
input that does this for you — prefer it over hand-rolling `actions/cache`.

## Matrix builds

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest]
    node: ["18", "20"]
jobs:
  test:
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
```

Runs one job per combination (4 here). Add `fail-fast: false` under `strategy` if one
combination failing shouldn't cancel the others — useful when you want the full picture
of which OS/version pairs actually broke.

## Concurrency — cancel superseded runs

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

Runs that share a `group` queue behind each other, and `cancel-in-progress: true` cancels the
older run when a newer one starts. Five quick pushes to one PR branch then cost one full run
(plus a few seconds each for the cancelled ones) instead of five. Keep the group per branch or
PR (`github.ref`), and don't set `cancel-in-progress` on a deploy workflow: cancelling a deploy
half-way is worse than letting it finish.

## Reusable vs. composite

- **Reusable workflow** (`workflow_call`, like `examples/workflows/reusable-lint.yml`) —
  a whole set of jobs, called with `uses: ./.github/workflows/x.yml`. Runs as its own
  job(s) with its own runner.
- **Composite action** (`action.yml` with `runs.using: composite`) — a sequence of steps
  called with `uses: ./.github/actions/x` *inside* an existing job, sharing that job's
  runner and context. Use this when you want to reuse a handful of steps without the
  overhead of a whole separate job.
