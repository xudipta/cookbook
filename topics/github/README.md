# GitHub / Git

Notes and examples for git itself and for GitHub as a platform — the `gh` CLI, pull
requests, and repo configuration (CODEOWNERS, branch protection, issue/PR templates).

For GitHub Actions and CI/CD pipelines specifically, see [`topics/cicd/`](../cicd/README.md).

## What git + GitHub add on top of each other

```mermaid
flowchart LR
    WD["working directory"] -->|git add| Stage["staging area"]
    Stage -->|git commit| Local[("local repo\n.git history")]
    Local -->|git push| Remote[("GitHub\nremote repo")]
    Remote -->|gh pr create| PR["Pull Request"]
    PR -->|review + merge| Base["base branch"]
```

**git** is the history — commits, branches, diffs — and works with no network at all.
**GitHub** adds the collaboration layer on top: a shared remote, pull requests for
review, issues, and everything in `03-repo-configuration.md` (CODEOWNERS, branch
protection, templates).

**Play it:** [Merge Conflict Rush](../../docs/games/github/index.md) puts you on a shared
repo with real `git` and `gh` commands: update a branch that fell behind, resolve a conflict,
and undo a bad commit on a protected `main`, all while a commit graph redraws.

## Contents

- `notes/01-git-fundamentals.md` — everyday flow, merge vs. rebase, staging/stashing,
  undoing changes safely, commit conventions, tags/releases.
- `notes/02-github-cli-and-prs.md` — `gh` setup, the PR loop, `gh issue`, `gh api`, draft
  PRs and review requests, walking through `examples/scripts/open-pr.sh`.
- `notes/03-repo-configuration.md` — CODEOWNERS, branch protection, PR/issue templates,
  labels and releases.
- `examples/scripts/open-pr.sh` — commit, push, and open a PR in one command.
- `examples/ISSUE_TEMPLATE/bug_report.yml` — a GitHub issue form.
- `examples/PULL_REQUEST_TEMPLATE.md` — a generic PR template shape.

New here? Start with `notes/01-git-fundamentals.md`, then `notes/02-github-cli-and-prs.md`
alongside `examples/scripts/open-pr.sh`.

## Quickstart

`examples/scripts/open-pr.sh` commits, pushes, and opens a real PR — don't run it against
*this* repo, but it's exactly what to try in a scratch repo of your own:

```bash
gh repo create my-scratch-repo --private --clone
cd my-scratch-repo
git switch -c try-open-pr
echo "hello" > NOTES.md
/path/to/cookbook/topics/github/examples/scripts/open-pr.sh \
  "docs: try open-pr.sh" "just trying it out"
gh pr view --web
```

## Validation

- `markdownlint` covers the notes and `examples/PULL_REQUEST_TEMPLATE.md`.
- `yamllint` covers `examples/ISSUE_TEMPLATE/bug_report.yml`.
- `shellcheck` covers `examples/scripts/open-pr.sh`.

```bash
shellcheck examples/scripts/open-pr.sh
yamllint examples/ISSUE_TEMPLATE/bug_report.yml
```
