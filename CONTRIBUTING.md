# Contributing

## Found something wrong, or have a suggestion?

[Open an issue](https://github.com/xudipta/cookbook/issues/new/choose) — there's a
**Bug report** template for something that's wrong, outdated, or fails to validate, and a
**Content suggestion** template for a note/example/topic worth adding. (The form under
`topics/github/examples/ISSUE_TEMPLATE/` is a *teaching example* of this same pattern,
not this repo's own template — these two are.)

## Adding a note to an existing topic

1. Create `topics/<topic>/notes/NN-short-title.md` (next free `NN`).
2. If it references a runnable artifact, add it under `topics/<topic>/examples/<name>/`.
3. Run the relevant local check (see below), then open a PR.

## Adding a new topic

1. Create the directory skeleton:

   ```text
   topics/<topic>/
     README.md              # copy the shape of an existing topic README:
                            #   what it covers + a "Validation" section
     notes/01-<short-title>.md
     examples/               # at least one real, minimal example
   ```

2. Wire a validator into [`.github/workflows/validate.yml`](https://github.com/xudipta/cookbook/blob/main/.github/workflows/validate.yml):

   - add a filter under the `changes` job (`<topic>: - 'topics/<topic>/**'`);
   - add a job gated on `needs.changes.outputs.<topic> == 'true'` that runs the
     linter/checker for that topic's file type.

3. Add a row to the **Topics** table in [`README.md`](README.md).

4. Add the topic's `README.md` and notes to `nav:` in `mkdocs.yml` so they appear on the
   docs site. Run `make docs` — the strict build fails if a page is missing from `nav`.

Keep examples **self-contained and credential-free** so CI can run them anywhere (e.g.
Terraform examples use the `local`/`random`/`null` providers, not real clouds).

## Validators and how to run them locally

| Topic | Tool | Command |
| --- | --- | --- |
| all | markdownlint | `npx markdownlint-cli2 "**/*.md"` |
| all YAML | yamllint | `make lint` |
| kubernetes | kubeconform | `kubeconform -summary -strict topics/kubernetes/examples/**/*.yaml` |
| kubernetes | kind | see `validate.yml` `k8s-kind` job |
| kubernetes | helm lint | `helm lint topics/kubernetes/examples/helm/sample-chart` |
| kubernetes | kubectl kustomize | `kubectl kustomize topics/kubernetes/examples/kustomize/overlays/dev` |
| docker | hadolint | `docker run --rm -i hadolint/hadolint < path/to/Dockerfile` |
| docker | live smoke test | see `validate.yml` `docker-smoke` job (build, run, curl) |
| linux | shellcheck | `shellcheck topics/linux/examples/scripts/*.sh` |
| terraform | terraform / tflint | `terraform fmt -check -recursive topics/terraform && tflint --recursive` |
| terraform | live apply | see `validate.yml` `terraform-apply` job (`init`/`apply`/`destroy`) |
| cicd | actionlint | `actionlint topics/cicd/examples/workflows/*.yml` |
| github | shellcheck / yamllint | `shellcheck topics/github/examples/scripts/*.sh && yamllint topics/github/examples/ISSUE_TEMPLATE/*.yml` |
| skills | check_skill.py | `python scripts/check_skill.py topics/skills/examples/*/SKILL.md` |
| mcp | jq | `find topics/mcp/examples -name '*.json' -o -name '.mcp.json' \| xargs -n1 jq empty` |
| observability | promtool | `promtool check config topics/observability/examples/prometheus/prometheus.yml && promtool check rules topics/observability/examples/prometheus/rules.yml` |
| observability | jq | `jq empty topics/observability/examples/grafana/dashboard.json` |
| database | sqlfluff | `sqlfluff lint topics/database/examples/` |
| database | live migrate | see `validate.yml` `database-migrate` job (migrate up/down against a real Postgres service container) |

## Commit / PR

- Branch from `main`; don't push to `main` directly.
- Fill in the PR template (topic + which validator covers the change).
- CI must be green before merge. `@xudipta` owns review (see [`.github/CODEOWNERS`](https://github.com/xudipta/cookbook/blob/main/.github/CODEOWNERS)).
