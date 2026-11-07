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
   entry in `docs/games/games.json` (a topic README links to its game itself), listing the sections of
   that note the game's events link back to.

Keep examples **self-contained and credential-free** so CI can run them anywhere (e.g.
Terraform examples use the `local`/`random`/`null` providers, not real clouds).

## Validators and how to run them locally

| Topic | Tool | Command |
| --- | --- | --- |
| all | markdownlint | `npx markdownlint-cli2 "**/*.md"` |
| all | check_links.py | `python3 scripts/check_links.py` — internal cross-references (`` `NN-title.md` ``, `` `examples/...` ``, and real Markdown links) actually resolve |
| all | check_external_links.py | `python3 scripts/check_external_links.py` — external `http(s)` links in the notes, docs and stories still resolve (standard library only). A 404/410 or a host that does not exist is **dead** and fails; timeouts, 5xx, 429 and bot walls (401/403) are only listed. On a pull request, `validate.yml` checks just the links the PR adds (`--changed origin/main`). The weekly `links.yml` job checks them all and opens or updates one `Broken external links` issue. Placeholder hosts from snippets go in `scripts/external_links_ignore.txt` |
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
| games | simulator unit tests | `make unit` (`node --test "docs/games/**/*.test.mjs"`, Node 22+, a second; the `unit` job gates `games-smoke`) |
| games | live playthrough | see `validate.yml`: `site-build` builds the site once, the `browser` shards (games, site, stories, wrong picks) replay each game's scripted solution and check layout in Chromium in parallel, and `games-smoke` is the one aggregate check that gates merges |

## Site design tokens

Colours, fonts, radii and spacing for the home page, the games and the notes live in
`docs/site/tokens.css`; `docs/site/material.css` maps them onto Material. Style new UI with
`var(--surface)`, `var(--ink)`, `var(--accent)` and friends instead of literal colours, so it
follows the light and dark themes. The dark palette appears three times in `tokens.css`; change all
three, then run `python3 scripts/check_contrast.py`, which fails on drift or on any text pair below
WCAG AA (4.5:1). Pages outside Material use `docs/site/theme.js`, which reads and writes the same
stored theme choice as Material's own toggle.

## Site checks

Beyond the strict build, CI checks the built site: `scripts/check_site_urls.py` fails if a page listed
in `scripts/site_urls.txt` disappears (links to the site live elsewhere, so remove a page only on
purpose, and delete its line in the same change; add new pages to the list), and
`scripts/site_quality.cjs` opens the home page, the Learn overview, a note, and every game at 390px
(dark) and 1280px (light), failing on sideways scrolling or any serious or critical axe-core violation.
Run it locally against a built site with
`SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright and axe-core> node scripts/site_quality.cjs`.

## Phone checks

`scripts/mobile_quality.cjs` plays no game; it opens every level of every game in touch mode at 390x844 and
360x640 and counts: controls under 44px (the recommended touch target) and under 24px (the WCAG 2.2
minimum), text inputs under 16px (iOS Safari zooms the page on focus), text under 11px, sideways page
scroll, and whether a primary action button is still on screen at the end of the board. The counts are a
**ratchet** in `scripts/mobile_baseline.json`: a count may go down but never up, and a new game or level
(not in the baseline) must have zero of everything. When you fix things, run
`SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright> node scripts/mobile_quality.cjs --update`
and commit the lower baseline. Landscape (844x390) is reported but not enforced.

`scripts/first_screen_check.cjs` guards the first screen of a practice game on a phone (390x844, touch): the
board must start near the top (the page title and an "About this game" fold come first, the topic strip is
hidden), the HUD shows the health bar and two buttons but no score or move numbers before the first move (the dock
shows them), and no keyboard-shortcut badges appear on a touch screen. The limits are a ratchet in
`scripts/first_screen_limits.json`: lower them, never raise them.

Emulation cannot replace a phone. Before a release that changes game UI, spend ten minutes on a real
iPhone (Safari) and a real Android phone (Chrome) and tick each item for one game of each kind (a
terminal game, a card game, a chart game): play one level one-handed; open and close the keyboard (the
page must not zoom or jump); rotate the phone; try light and dark; set the browser text size to 200%;
check that the main action stays reachable and that nothing is clipped. Record what failed on the
tracking issue.

## Terminal prompts

Every terminal-style game (Kubernetes, Terraform, Linux, GitHub, MCP, Database) builds its prompt with
`createPrompt` from `docs/games/shared/prompt.js`, never its own `<input>`. The shared prompt gives you
16px text on touch screens, no autocorrect or autocapitalise, history buttons (no arrow keys on a phone)
and a tray of chips that builds a command by tapping. On desktop it is still type, Enter, and the arrow
keys for history.

A game supplies data only: `next(words, line)` returns what could come next given the words already on
the line (a string, or `{ text, label?, full?, run?, raw? }`), and `onSubmit(line)` runs the command.
Take the names from the live world (pods, resources, branches, files), so a player picks the real thing
instead of typing it. Reading commands should be `full: true, run: true` chips; a command that changes
something is filled in (`full: true`) and waits for the player to press Run. The function belongs in the
game's DOM-free `sim.js` (or `kubectl.js`) next to the commands it describes. Call `prompt.refresh()` after
the world changes (the shell does it for you when you call `setDisabled`).

`scripts/compose_check.cjs` replays each game's scripted solution on a 390px touch screen by tapping chips
only. The first level of every terminal game must be fully playable that way; later levels are reported,
and a command that needs the keyboard (a commit message, a `sed` expression) is listed so you can decide
whether a chip would help. When you add a game with a prompt, add it to `COMMAND_ACTION` in that script.

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

## The dock

On a phone (under 700px) the shell pins a "dock" to the bottom of the game card while you scroll the board:
the action buttons, a one-line status, a thin health meter and the latest event, which opens the full event
log when tapped. It is built in `docs/games/shared/ui.js` and styled in `shell.css`; a game does nothing for
it, but its own primary controls should not depend on being above the board. The dock is invisible on wide
screens.

## Story mode (preview)

`docs/stories/<id>/` holds lessons told as a short story on a phone-sized stage, for learners who find the
games confusing. The first is `docs/stories/kubernetes/` ("Night Shift at Pizza Palace"). The shell
(`docs/stories/shared/`: header, stage, bottom sheet, concept cards, ending, progress) is shared; a topic adds a
stage, chapter scripts, a stylesheet and a `drive.json`. The shape to keep:

- One idea per chapter. Start with a metaphor the learner already knows, let them do something and watch the
  result, and only then show the real word and command ("Now in real X").
- Every step is a tap: a button to go on, a choice, a tap on the stage, a stepper or a switch. No keyboard.
- A chapter is a plain `async` script (`say`, `choose`, `pick`, `card`, `watch`) over a small simulation, so adding
  a chapter touches only that topic's folder.

To add a story `docs/stories/<id>/`:

1. `index.md`: a title, a sentence, and `<div id="story" data-story="<id>"></div>`. Add it to the `nav` in
   `mkdocs.yml` and its URL to `scripts/site_urls.txt`, and change the topic's `story` entry in
   `docs/games/games.json` from `planned` to `live` (`path`, `blurb`, `chapters`, `learns`): that is what the
   home page's story board, the topic cards and the banners on the notes read (`check_games.py` checks it).
   The learning path is data too: `games.json` has a top-level `path` (every topic id once, in the recommended
   order) and each topic has a `short` name and `after` (the topics worth doing first, all earlier on the
   path). The home page's **Continue** button and path strip, the Learn page and the "Next" link at the end of
   each story read them, and `check_games.py` fails on an unknown topic, a topic missing from or repeated in
   the path, or an `after` that points forward (a cycle). `docs/learn.md` lists the path by hand; update it too.
2. `story.js`: export `mountStory(host)` that calls the shared `mountStory(host, config)` with the story's
   `id`, `title`, `characters`, `chapters`, `createStage(app)` (build the stage into `app.stage`, return an object
   with `reset()` and `stop()`), the card and ending texts, and `endLinks` to the notes and the practice game.
   `boot.js` loads it for any page with `#story[data-story]`.
3. `story.css`: set the palette with the `--ks-*` tokens under `.ks[data-story="<id>"]` and style the stage. Every
   rule must start with `.ks[data-story="<id>"]` (the file is loaded on every page, and a game page has classes of
   its own; `story_check.cjs` fails otherwise). Add it to `extra_css` in `mkdocs.yml`, after
   `docs/stories/shared/story.css`.
4. `drive.json`: the answer `scripts/story_check.cjs` prefers when you offer choices, and what to tap in the phases
   your script waits in (`"rush": { "click": "<selector>", "once": true }`).

Shared helpers live in `docs/stories/shared/helpers.js`: `decide` (ask until the right option is picked: the right
one runs `cmd`/`run` and shows the output, a wrong one is explained and may replay a `trial` on a scratch copy), `look`,
`askUntilRight` (the loop under both), `stubCtx` (the engine context a story hands a simulator), `seededRng` and
`printedSince`. A story gives `decide` what is topic-specific through its `A` object (`A.who`, `A.sh`, `A.trial`,
`A.trialText`) and its options; do not copy these into a story (`story_check.cjs` fails if you do).

`?fast=1` shortens every wait. `scripts/story_check.cjs` plays each story to the end on a 390x844 and a 360x640
touch screen and fails on sideways scrolling, controls under 44px, a next-step button below the fold, an axe
violation in any phase, a story that cannot finish, or a topic word in the shared shell. Chapters finished are
saved in this browser (`cookbook-story-progress:<id>`).

Stories follow the site's light/dark toggle. You write the light palette only: `python3 scripts/story_dark.py`
derives the dark one (the same hue with the lightness mirrored, a little less saturated; rules with a dark
background of their own, such as the terminal boxes, stay as they are) and writes it between two marker comments
at the end of each `story.css`, as `body[data-md-color-scheme="slate"] ...` rules. Run it after changing a colour;
CI runs it with `--check` and fails on a stale block. Do not edit between the markers; a hand-tuned exception goes
in the script's `OVERRIDES` table. Inline SVG art in a story script keeps its colours in both schemes.

`node scripts/story_check.cjs --wrong` (also run in CI) plays every wrong option of every question: in run *r* the
first time a question is asked the story takes its *r*-th wrong option (every option `drive.json`'s `prefer` does not
accept) and answers the rest rightly. It fails if a wrong pick shows nothing, a question repeats more than four
times, or the story no longer reaches its ending. A second valid way to do something (the Terraform `moved` block
versus `state mv`) is just an option `prefer` does not name, so it is played the same way. `ONLY=linux,docker` limits
the stories. `--dark` plays every story in the dark scheme (axe contrast included). Write `prefer` so it matches exactly the right option of each question; a question where nothing matches
is reported as a note.

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
- **Every level has a `par` and earns stars.** `par` is the number of counted moves in the scripted
  `solution` (reads and `'free'` actions do not count); `games_smoke.cjs` fails if it disagrees, so
  changing a solution means changing its par. Stars come from `starsFor` in `engine.js`: three at par or
  fewer, two within half as many moves again, one for any win. They are saved per level
  (`progress.js`) and shown on the result, in the level picker and on the home board.
- **Every level ends with a debrief**, built from data in `scenarios.json` and the run itself. `lessons`
  is one or two sentences of what to take away; `path` is the scripted run's moves as text (generated by
  replaying the solution; `games_smoke.cjs` fails if it drifts, and `describeMove(name, args)` on a game's
  definition shapes how its actions read); `tryItForReal` is `{ needs, example, commands }`: the real
  commands or config in a copyable block, what it needs, and a file or folder under `topics/<topic>/examples/`
  that `check_games.py` requires to exist. The game's top-level `lossRule` says which rule a lost run broke.
  The result shows the lessons, a timeline of the player's own moves and the incidents they answered, the
  efficient path next to it, the commands (Copy selects the text instead when the clipboard is blocked), and
  after a loss a **Retry with a hint** button.
- **Variants** are opt-in per level: set `variants: true` and the result panel offers "Try a different
  version", which walks `VARIANT_SEEDS` (`?seed=` in the address bar, so a version can be shared). Make
  the seed change something the player can see through `ctx.seed` / `ctx.variant` or `ctx.rng` (Kubernetes
  renames its pods and the chaos monkey strikes elsewhere; Quiet Hours draws different traffic), but never
  make the standard seed change: CI plays the scripted solution on every version and requires a win and
  that the versions differ. A level whose solution depends on names or timings should not offer variants.
- **Games on a clock** (not `manual`) get a **Pace** control (Slow x2 time, Normal, Pressure x1.5 score; changing
  it restarts the level) and may stop the clock while the player thinks: `ctx.hold('prompt', true)` while a
  prompt has focus or text (the shared prompt calls `onActivity` for this), `ctx.hold('sheet', true)` for a
  sheet or form, released with `false`. A read-only command that does not go through `act()` can still be part
  of the run (and the debrief) with `ctx.record(text)`. Make sure a scripted solution's reads do not name things
  that change between versions (pod names), or the versions of a level will stop being winnable.
- **Keys `p`, `r` and `?` are reserved** (pause, restart, hint), and the shell stops them reaching
  Material's own shortcuts. Avoid `f`, `s`, `n` and `/` for actions.
- **Every level has a hint ladder and every game a guided start**, both data in `scenarios.json`
  (`scripts/check_games.py` fails without them). `hints: [where to look, what is wrong, what to do]` is
  per level (a single-level game puts it at the top): one to four strings, shown one at a time by the shell's
  **Hint** button, each costing 25 points (`HINT_COST` in `engine.js`, shown in the score and the result
  panel). Write the first rung so it says where to look without saying what is wrong, and make the last
  one enough to finish the level. `coach: { board, actions, firstMove }` at the top feeds the guided
  start: four short steps that each light up one part of the page, shown once per game per browser
  (`localStorage`), skippable, and replayable from the **Guide** button. A scripted run (`autoplay=0`)
  skips it; `?coach=1` forces it. Do not add a game-specific hint button.
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
- **Per-level labels**: a level may set `actionLabels: { build: "Up" }` to relabel a visible action for that
  level (the Compose level of Layer Cake turns Build into Up).
- **Hidden actions** (`hidden: true`) get no button, for games that drive the pipeline from their
  own UI. From that UI call `ctx.act('name', ...args)` so the action is still counted, scored and
  blocked while paused. An action that returns `false` is not counted, which is how a game keeps
  read-only commands free. The engine does not re-render after a `false`, so an action whose
  output matters (a terminal) calls its own `render` before returning.

Run it locally with `make docs-serve` and open `/docs/games/<id>/`. Add `?autoplay=0` to stop
the clock and `?seed=42` for a repeatable run; in the browser console,
`cookbookGames.<id>.step(5)` and `.act('doThing')` drive it by hand. To run what CI runs:

```bash
make unit                               # simulator unit tests, about a second
python3 scripts/check_games.py
make docs                               # builds the site into site/
python3 -m http.server 8000 --directory site &
NODE_PATH=<dir containing node_modules/playwright> SITE_URL=http://localhost:8000/ \
  node scripts/games_smoke.cjs
```

## Updating the README screenshots

The four images under `docs/images/` (`docs-home.png`, `docs-topic-page.png`, `story-kubernetes.png`, which is
also the home page's hero image, and `docs-game.png`) are produced by `scripts/screenshots.cjs` from the built
site, so nothing is edited by hand:

```bash
make screenshots              # builds the site, serves it, regenerates the images (needs playwright)
node scripts/screenshots.cjs --check   # no browser: the images exist and are not older than the home page
```

Refresh them in the same PR whenever the home page (`docs/site/`), the theme in `mkdocs.yml`, a story's first
screen or the practice-game layout changes enough to make them look stale. There is no pixel comparison in CI
(it would be flaky); the `--check` mode is a quick local reminder.

## Changelog

`CHANGELOG.md` lists every merged PR once, by number, under Topics, Docs site, Stories, Practice games or CI and
tooling. `python3 scripts/check_changelog.py` reads the squash commits on `origin/main` (their subjects end in
`(#N)`) and fails when a merged PR is neither in the changelog nor in `scripts/changelog_skip.txt` (one number and a
reason per line, for a pure revert or a fix to a PR that was never released on its own). The `changelog` job runs it
on every pull request.

The PR you are writing cannot list itself, because its number is not known until it merges, and the newest five
merged PRs are not required yet (so PRs that merge back to back do not fail each other). Add the entries for the PRs
that merged since the last update to a later PR, or batch them in one small docs PR.

## Commit / PR

- Branch from `main`; don't push to `main` directly.
- Fill in the PR template (topic + which validator covers the change).
- CI must be green before merge. `@xudipta` owns review (see [`.github/CODEOWNERS`](https://github.com/xudipta/cookbook/blob/main/.github/CODEOWNERS)).
- `CHANGELOG.md` doesn't need updating on every PR — it's regenerated periodically with
  `topics/skills/examples/release-notes/`, not maintained by hand per change.
