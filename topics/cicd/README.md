# CI/CD

Notes on pipelines and GitHub Actions, plus reusable workflow examples.

For git itself and GitHub-the-platform (the `gh` CLI, PRs, repo configuration), see
[`topics/github/`](../github/README.md).

## What a pipeline actually does

```mermaid
flowchart LR
    Push["git push / PR"] -->|on:| WF["Workflow"]
    WF --> J1["Job: lint"]
    WF --> J2["Job: test"]
    J1 --> J3["Job: deploy\n(needs: lint, test)"]
    J2 --> J3
    J3 --> Prod["running system"]
```

Every job in a workflow runs on its own fresh runner, in parallel by default — `needs:`
is the only thing that makes one wait for another, which is why `deploy` above only
starts once both `lint` and `test` have passed.

## Contents

- `notes/01-github-actions-basics.md` — workflow anatomy (`on`/`jobs`/`steps`),
  permissions, walking through `examples/workflows/reusable-lint.yml`, security basics.
- `notes/02-workflow-patterns.md` — path filtering, dependency caching, matrix builds,
  reusable workflows vs. composite actions.
- `notes/03-deployment-strategies.md` — rolling, blue-green, and canary deployments,
  environment promotion, and a GitOps overview (with diagrams).
- `examples/workflows/` — example workflow files.

New here? Start with `notes/01-github-actions-basics.md` and read it alongside
`examples/workflows/reusable-lint.yml`.

See a build-and-deploy workflow for an actual service, not just a lint job, in
[`topics/capstone/`](../capstone/README.md).

## Quickstart

Call the example reusable workflow from another workflow in the same repo:

```yaml
jobs:
  lint:
    uses: ./.github/workflows/reusable-lint.yml
    with:
      paths: "."
```

Or check it out and validate it locally the same way CI does:

```bash
actionlint examples/workflows/reusable-lint.yml
```

## Validation

- `yamllint` runs on every `*.yaml`/`*.yml` change (workflow files under
  `.github/workflows/` and `examples/workflows/` are ignored — see `.yamllint.yaml` —
  because Actions expressions trip the linter).
- `actionlint` checks the example workflow files for schema and shell errors.
