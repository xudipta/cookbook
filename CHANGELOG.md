# Changelog

Grouped from this repo's own merged PR history (the squash commits on `main`, whose subjects end in the
PR number), in the spirit of `topics/skills/examples/release-notes/`: a real usage example of that skill, not a
hypothetical one. See `topics/skills/examples/release-notes/SKILL.md` for the process and `CONTRIBUTING.md`
(the Changelog section) for how to keep this updated.

Every merged PR number appears below, in parentheses, or is listed in `scripts/changelog_skip.txt` with a
reason (the skip rule: a pure revert, or a fix to a PR that was never released on its own).
`scripts/check_changelog.py` checks this in CI.

## Topics

- Refactor into a multi-topic cookbook with per-topic validation CI (#9)
- Add Agent Skills and MCP topics, each with its own validation (#10)
- Add the GitHub / Git topic, split out of CI/CD for a cleaner scope per topic (#13)
- Expand thin getting-started placeholders into full notes across Docker, Linux,
  Terraform, and CI/CD (#12)
- Expand Kubernetes documentation to match its already-substantial example set (#14)
- Add a CI/CD deployment-strategies note, Helm/Kustomize notes, and new Observability
  and Database topics (#15)
- Round out Kubernetes examples: Namespace, resource limits, probes (#30)
- Add a capstone walkthrough chaining Docker, Kubernetes, Observability, and CI/CD (#29)

## Docs site

- Add the GitHub Pages docs site (MkDocs Material) (#11)
- Polish the docs site: tabbed navigation, theme, a sharper README hook, and per-topic
  diagrams/quickstarts (#16)
- Redesign the docs site: group navigation into categories, calmer theme (#35)
- Add the site design system: shared tokens, fonts and themes (#63)
- Add the home page at the site root (#64), then Navigation: Play, Learn and About, with Play
  banners on the notes (#67)
- Home and Play copy now that every topic has a game (#76); Play banners list the note
  sections the game links back to (#77)
- Put stories in focus: a story board, notes by topic, then practice (#121)
- Retire the Replica Rescue demo game and its page `docs/games/demo/`: the Kubernetes
  story is the "start here", and the real games exercise the shared shell in CI (#134)

## Stories

Short, tap-only stories that teach a topic with a metaphor first and the real command after.

- Proof of concept: Kubernetes, "Night Shift at Pizza Palace" (#118), with the home page and nav
  leading with it (#119)
- A shared story shell, so a topic is a script plus a stage (#120)
- Docker: The Layer Cake (#122)
- Terraform: The Drift Detective (#123), with a fourth chapter on moved blocks (#132)
- Git and GitHub: The Shared Cookbook (#125), with a fourth chapter on protected main (#133)
- CI/CD: The Assembly Line (#127), with a fourth chapter on gates and drift (#135)
- Linux: The Night Superintendent (#129)
- Database: The Card Catalogue (#130)
- Observability: Quiet Hours (#131)
- Agent Skills: The New Hire (#137)
- MCP: The Switchboard (#136)
- Kubernetes chapters 4 and 5: the recipe card (ConfigMaps and Secrets) and the wrong sign on
  the door (Services) (#139)
- Stories and practice games link to each other, level by level (#138)

## Practice games

- Add the games foundation: shared shell, Play section, and games-smoke CI (#48)
- Add the games, one per topic: Kubernetes, Chaos Monkey Cluster (#49); Docker, Layer Cake (#52);
  Terraform, Drift Detective (#53); CI/CD, Pipeline Panic (#69); Agent Skills, Skill Issue (#70);
  MCP, Patch Bay (#71); Observability, Quiet Hours (#72); GitHub / Git, Merge Conflict Rush (#73);
  Database, Index Fund (#74); Linux, Night Shift (#75)
- Game pages: a focused play layout (#65); progress with per-level completion and best scores,
  shown on the board (#66)
- Docker level 6, Compose wiring (#78); Terraform level 4, copy-paste to module (#79)
- Games quality pass: 44px touch targets (#101), full-width board on phones (#102), a sticky
  action dock and collapsible event log (#103), one command prompt with tap-to-compose chips for
  the terminal games (#104), a hint ladder and guided start on every level (#105), par, stars and
  different versions (#106), and a debrief on every level (#107)
- Per-game polish: Observability readable charts and a graph-led warm-up (#108); Kubernetes
  without a clock, tap a pod for its actions (#109); Docker predict-before-build and a Slow CI
  level (#110)
- A game-first phone layout: the board starts near the top of the first screen, with a first-screen
  check in CI (#140)

## CI and tooling

- Initial CI setup and a Trivy vulnerability scan fix (#1, #2)
- Add a `kind`-based Kubernetes CI workflow, then iterate on it: use the full
  deployment file, add Service connectivity verification (#3, #4, #5)
- Add a PR template and `CODEOWNERS` (#6, #7, #8)
- Add a LICENSE (#26), an "About this project" section (#27) and docs-site screenshots (#28, #50)
  to the README
- Add a real `.github/ISSUE_TEMPLATE/` (#31), a live smoke-test CI job for Linux (#32) and a
  repo-wide broken-link check (#33)
- Add this changelog (#34)
- CI for the redesigned site: page stability, layout and accessibility checks (#68)
- Phone-usability checks in CI with a ratcheting baseline (#100)
