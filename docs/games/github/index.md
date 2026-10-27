# Merge Conflict Rush

A shared repo, teammates who keep pushing, and your branch to rescue. Type real `git` and `gh` commands and watch the commit graph change.

<div id="game" data-game="github">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- Type commands in the terminal (or tap a button). Reading is free: `status`, `log`, `diff`,
  `show`, branch lists, `gh pr view`. Anything that changes the repo takes a step, and each level has
  a step limit. **Wait** (`w`) lets a step pass; **Hint** (`h`) names the next goal.
- The graph is your clone. `origin/*` labels move only when you `fetch`, `pull` or `push`, so
  teammates' work stays invisible until you look.
- Edit files in the editor panel (or `echo "text" >> file`). A conflict leaves `<<<<<<<` markers
  for you to resolve, then `git add` and continue.
- Team trust drops for a sloppy commit message, committed conflict markers, discarding
  uncommitted work, a force-push without `--force-with-lease`, rewriting `main`, or merging
  past protection with `--admin`. Win with every goal done, nothing half-finished, and trust at 50% or more.

## Syntax worth remembering

```bash
git switch -c feature/x               # branch from HEAD
git fetch                              # update origin/* without touching your branches
git merge origin/main                  # or: git rebase origin/main
git add file && git rebase --continue  # after fixing a conflict (git commit, for a merge)
git push -u origin HEAD                # first push of a branch
git push --force-with-lease            # after a rebase; refuses if the remote moved
git revert <sha>                       # undo a pushed commit with a new commit
git stash push -m wip                  # set uncommitted work aside; git stash pop
gh pr create --fill                    # open a PR from the branch's commits
gh pr merge 12 --squash --delete-branch
```

| In the game | What it teaches |
| --- | --- |
| Squash merge | one new commit on `main`; the branch's own commits are not in its history |
| Rebase | replays commits with new IDs, so a pushed branch needs `--force-with-lease` |
| Protected branch | direct pushes are refused; code owners are auto-requested; required checks must pass |

Notes behind it: [Git fundamentals](../../../topics/github/notes/01-git-fundamentals.md),
[GitHub CLI and pull requests](../../../topics/github/notes/02-github-cli-and-prs.md) and
[Repo configuration](../../../topics/github/notes/03-repo-configuration.md).
