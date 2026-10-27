# Pipeline Panic

Build a GitHub Actions workflow out of cards, then pick a deployment strategy for each release. Keep PRs fast, secrets safe and bad releases small.

<div id="game" data-game="cicd">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- **Levels 1 and 2 (Pipeline Tycoon).** Add and remove cards: the YAML preview is the workflow
  you are building, and rearranging is free. **Run next event** (`e`) pushes the next PR or push
  through the workflow as it stands. The next event is shown before you run it.
- You win a month by finishing with the runner minutes inside budget, the level's goals met and
  nothing broken or leaked. A fork PR that runs your code with your secrets ends the game.
- **Levels 3 and 4 (Deploy Day).** Promote a release through staging, then pick rolling,
  blue-green or canary for prod. **Wait a minute** (`w`) lets time pass: rollouts advance and the
  error graph gets a new point. Roll back when the alert fires. Failed requests cost health.
- `pull_request_target` is not unsafe by itself. It becomes dangerous when it checks out
  untrusted PR code while secrets are in scope.

## Syntax worth remembering

```yaml
on:
  pull_request:
    paths-ignore: ["**.md", "docs/**"]   # skip the run for docs-only changes
permissions:
  contents: read                         # least-privilege job token
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true               # a newer push cancels the older run
jobs:
  test:
    needs: lint                          # wait for lint, skip if it fails
    strategy:
      matrix:
        node: ["18", "20"]               # one job per version
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm                     # cache keyed on the lockfile
      - uses: some-org/action@<full-commit-sha>   # third party: pin a SHA, not @main
```

| Strategy | Blast radius of a bad release | Rollback |
| --- | --- | --- |
| Rolling | grows as batches update | another rollout |
| Blue-green | 0% until cutover, then 100% | flip the router back |
| Canary | the small slice only | weight back to 0% |

Notes behind it: [GitHub Actions basics](../../../topics/cicd/notes/01-github-actions-basics.md),
[Workflow patterns](../../../topics/cicd/notes/02-workflow-patterns.md) and
[Deployment strategies](../../../topics/cicd/notes/03-deployment-strategies.md).
