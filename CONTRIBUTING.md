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

4. Add the topic's `README.md` and notes to `nav:` in `mkdocs.yml`, nested under whichever
   category it belongs to under **Learn** (`Infrastructure`, `Delivery`, `Operations`, `AI
   Tooling` — see the existing entries for the shape; add a new category only if none of
   those genuinely fit, and give it its own `docs/<category>.md` landing page, linked from
   `docs/learn.md`). Run `make docs` — the strict build fails if a page is missing from
   `nav`. The top-level sections are **Play** (the games), **Learn** (the notes) and
   **About**; the site build adds a "Play it" banner to every note of a topic that has an
   entry in `docs/games/games.json` (a topic README links to its game itself).

Keep examples **self-contained and credential-free** so CI can run them anywhere (e.g.
Terraform examples use the `local`/`random`/`null` providers, not real clouds).

## Validators and how to run them locally

| Topic | Tool | Command |
| --- | --- | --- |
| all | markdownlint | `npx markdownlint-cli2 "**/*.md"` |
| all | check_links.py | `python3 scripts/check_links.py` — internal cross-references (`` `NN-title.md` ``, `` `examples/...` ``, and real Markdown links) actually resolve |
| all YAML | yamllint | `make lint` |
| kubernetes | kubeconform | `kubeconform -summary -strict topics/kubernetes/examples/**/*.yaml` |
| kubernetes | kind | see `validate.yml` `k8s-kind` job |
| kubernetes | helm lint | `helm lint topics/kubernetes/examples/helm/sample-chart` |
| kubernetes | kubectl kustomize | `kubectl kustomize topics/kubernetes/examples/kustomize/overlays/dev` |
| docker | hadolint | `docker run --rm -i hadolint/hadolint < path/to/Dockerfile` |
| docker | live smoke test | see `validate.yml` `docker-smoke` job (build, run, curl) |
| linux | shellcheck | `shellcheck topics/linux/examples/scripts/*.sh` |
| linux | live smoke test | see `validate.yml` `linux-smoke` job (runs `backup.sh` against a real tarball) |
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
| games | scenario validator | `python3 scripts/check_games.py` (schema, and every event's `learn.note`/`learn.section` must exist) |
| games | live playthrough | see `validate.yml` `games-smoke` job (builds the site, replays each game's scripted solution in Chromium) |

## Site design tokens

Colours, fonts, radii and spacing for the home page, the games and the notes live in
`docs/site/tokens.css`; `docs/site/material.css` maps them onto Material. Style new UI with
`var(--surface)`, `var(--ink)`, `var(--accent)` and friends instead of literal colours, so it
follows the light and dark themes. The dark palette appears three times in `tokens.css`; change all
three, then run `python3 scripts/check_contrast.py`, which fails on drift or on any text pair below
WCAG AA (4.5:1). Pages outside Material use `docs/site/theme.js`, which reads and writes the same
stored theme choice as Material's own toggle.

## Game page layout

Every game page gets the same frame from the shared shell, so a game's own code only draws its board:
a topic strip (from the game's entry in `docs/games/games.json`) with a link to the notes; a level
picker that scrolls sideways; a collapsible level goal; the HUD and action buttons; the board; and, after
a run, a result panel with **Next level**, **Play again** and **Read the notes**. The page text below the
board (every `##` section in `index.md`) folds into collapsible panels, open on a first visit and closed
afterwards, and the table of contents is hidden. Keep the text above the board to one or two sentences:
on a 390px-wide phone the board should start near the top of the screen.

## Progress

The shell saves each run in the browser (`docs/games/shared/progress.js`): a best score and a won flag
per level, under `cookbook-game-progress:<game>`. Games do nothing for this; the shell records every
finished run, marks completed levels with a check in the level picker, shows the saved best in the HUD,
and the home page board reads the same entries. The older `cookbook-game-best:<game>` key is still
written and read, so earlier scores survive. Storage can be blocked, so always go through `progress.js`
(every access is wrapped) and never assume a saved value exists.

## Adding a game

The browser games under `docs/games/` (see the **Play** section of the docs site) share one
small engine, so a new game is mostly its own rules plus data. A game lives in
`docs/games/<id>/`, where `<id>` is the topic or game name:

```text
docs/games/<id>/
  index.md          # the page: intro, <div id="game" data-game="<id>"></div>, how to play
  game.js           # the rules: registerGame({...})
  scenarios.json    # chaos events, learn links and the scripted winning run, as data
  game.css          # optional; set `styles: 'game.css'` in game.js
```

Also add (or update) the game's entry in `docs/games/games.json`: it drives the board on the home
page (title, topic, blurb, command chips, level count, `status: "live"`). `scripts/check_games.py`
fails if a game has no entry or its level count disagrees with `scenarios.json`.

`game.js` registers itself with the shared engine:

```js
import { registerGame } from '../shared/engine.js';

registerGame({
  id: '<id>',                  // must match the directory name
  init(state, ctx) {},         // build the starting state; draw into ctx.ui.board
  tick(state, ctx) {},         // advance one tick; ctx.rng() is seeded, ctx.fire('event-id')
  actions: {                   // buttons; `key` is an optional keyboard shortcut
    doThing: { label: 'Do thing', key: 't', run(state, ctx) {} },  // return false = not counted
  },
  isWon: (state) => false,
  isLost: (state) => false,
  render(state, ctx) {},       // optional; redraw after every tick or action
});
```

The shell owns the loop, HUD, scoring, event log and result screen. `state.health` (0-100) is
the meter it shows. A few rules keep the games consistent:

- **Randomness comes from `ctx.rng()`**, never `Math.random()`, so `?seed=N` replays a run.
  Draw the same number of values every tick regardless of what the player did.
- **Every chaos event is declared in `scenarios.json`** with a `fix` explanation and a
  `learn: { note, section }` pointing at a real heading in a topic note. `ctx.fire(id)` shows
  it; `ctx.resolve(id)` attaches the explanation and the link. `scripts/check_games.py` fails
  if the note or heading doesn't exist, so renaming a note heading shows up in CI.
- **A scripted winning run is part of the scenario**: `solution` is a list of
  `{ "tick": N, "action": "name" }` steps. CI replays it and the game must end `won`.
- **Build boards from `<div>`s** (with `role="list"`/`"listitem"` where it helps), not `<ul>`:
  Material styles lists in a way a single class can't override. Use `.cg .your-class` selectors
  in `game.css`.
- **Keys `p` and `r` are reserved** (pause, restart), and the shell stops them reaching
  Material's own shortcuts. Avoid `f`, `s`, `n` and `/` for actions.
- Keep everything static: no build step, no network calls.
- **Keep the game page short.** The game carries the understanding, so `index.md` is a few lines
  of rules plus the key commands or syntax and a pointer to the notes, not a second copy of them.
- **Levels** are optional: add `levels: [{ id, title, blurb, seed, winTicks, ... }]` to
  `scenarios.json`. The selected level is merged over the top-level fields (events always come
  from the top), `?level=<id>` picks one, and each level needs its own `solution` (CI plays every
  one). A level's `schedule: [{ tick, event, ... }]` may only name events declared at the top.
- **Turn-based games** set `manual: true` (and optionally `tickLabel`, e.g. "Build") at the top of
  `scenarios.json`: no timer runs, there is no pause, and time advances only when an action calls
  `ctx.step()`. In `solution`, the steps run in order and `tick` is just a sort key. An action may
  return `'free'` to be valid but unscored (rearranging cards); `ctx.over` is true once the game
  has ended, so a game's own controls can disable themselves.
- **Hidden actions** (`hidden: true`) get no button, for games that drive the pipeline from their
  own UI. From that UI call `ctx.act('name', ...args)` so the action is still counted, scored and
  blocked while paused. An action that returns `false` is not counted, which is how a game keeps
  read-only commands free. The engine does not re-render after a `false`, so an action whose
  output matters (a terminal) calls its own `render` before returning.

Run it locally with `make docs-serve` and open `/docs/games/<id>/`. Add `?autoplay=0` to stop
the clock and `?seed=42` for a repeatable run; in the browser console,
`cookbookGames.<id>.step(5)` and `.act('doThing')` drive it by hand. To run what CI runs:

```bash
python3 scripts/check_games.py
make docs                               # builds the site into site/
python3 -m http.server 8000 --directory site &
NODE_PATH=<dir containing node_modules/playwright> SITE_URL=http://localhost:8000/ \
  node scripts/games_smoke.cjs
```

## Updating the README screenshots

`docs/images/docs-home.png` and `docs/images/docs-topic-page.png` are real
screenshots of the built docs site. If a theme change in `mkdocs.yml` (palette, nav
style, logo) would make them look stale, regenerate them from a local build
(`make docs-serve`, then screenshot the home page and a topic page at a ~1400px-wide
viewport) and replace the files in the same PR as the theme change.

## Commit / PR

- Branch from `main`; don't push to `main` directly.
- Fill in the PR template (topic + which validator covers the change).
- CI must be green before merge. `@xudipta` owns review (see [`.github/CODEOWNERS`](https://github.com/xudipta/cookbook/blob/main/.github/CODEOWNERS)).
- `CHANGELOG.md` doesn't need updating on every PR — it's regenerated periodically with
  `topics/skills/examples/release-notes/`, not maintained by hand per change.
