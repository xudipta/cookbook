#!/usr/bin/env node
// Plays every game under docs/games/<id>/ in a real browser against the BUILT docs site:
//   1. loads the page with a fixed seed and no wall-clock timer (autoplay=0),
//   2. replays the scripted `solution` (per level, when the scenario has `levels`) from scenarios.json
//      through the game's own action API,
//   3. asserts the game reaches "won" and that the page logged no errors of its own,
//   4. checks every event's "learn" link points at a real page and a real heading anchor.
//
// Usage: SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright> node scripts/games_smoke.cjs
// Optional: CHROMIUM_PATH=<browser binary> to use an already-installed Chromium.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const SITE_URL = (process.env.SITE_URL || 'http://localhost:8000/').replace(/\/?$/, '/');
const GAMES_DIR = path.join(__dirname, '..', 'docs', 'games');
const MAX_TICKS = 1000;

async function checkLearnLinks(scenario, learnUrl) {
  const problems = [];
  for (const event of scenario.events) {
    const url = learnUrl(event.learn, new URL(SITE_URL));
    const res = await fetch(url);
    if (!res.ok) {
      problems.push(`event ${event.id}: ${url} -> HTTP ${res.status}`);
      continue;
    }
    const hash = new URL(url).hash.slice(1);
    if (hash && !(await res.text()).includes(`id="${hash}"`)) {
      problems.push(`event ${event.id}: ${url} has no #${hash} anchor`);
    }
  }
  return problems;
}

// The home page builds its board from docs/games/games.json: one tile per entry, no errors, and a
// teaser game that responds to a click.
async function checkHome(browser) {
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, 'games.json'), 'utf8')).games;
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && m.location().url.startsWith(SITE_URL)) problems.push(`console error: ${m.text()}`);
  });
  await page.goto(SITE_URL, { waitUntil: 'load' });
  try {
    await page.waitForSelector('.tile', { timeout: 15000 });
  } catch {
    problems.push('the board never rendered (no .tile within 15s)');
    await page.close();
    return problems;
  }
  const tiles = await page.locator('.tile').count();
  if (tiles !== manifest.length) problems.push(`board has ${tiles} tiles, games.json has ${manifest.length}`);
  for (const game of manifest.filter((g) => g.status === 'live')) {
    const href = await page.locator(`a.tile[href="docs/games/${game.id}/"]`).count();
    if (!href) problems.push(`no tile links to docs/games/${game.id}/`);
  }
  const crashed = page.locator('.pod[data-s="crash"]').first();
  await crashed.click();
  if (!(await page.locator('#term').innerText()).includes('kubectl delete pod')) problems.push('teaser: deleting a crashed pod did not log the command');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) problems.push('home page scrolls horizontally');
  await page.close();
  return problems;
}

async function playRun(browser, id, run) {
  const problems = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  // Third-party failures (fonts, CDNs) aren't the game's fault; anything from our own origin is.
  page.on('console', (m) => {
    if (m.type() === 'error' && m.location().url.startsWith(SITE_URL)) problems.push(`console error: ${m.text()}`);
  });

  const level = run.level ? `&level=${encodeURIComponent(run.level)}` : '';
  await page.goto(`${SITE_URL}docs/games/${id}/?seed=${run.seed}&autoplay=0${level}`, { waitUntil: 'load' });
  try {
    await page.waitForFunction((gid) => window.cookbookGames && window.cookbookGames[gid], id, { timeout: 15000 });
  } catch {
    problems.push('game never mounted (no window.cookbookGames entry within 15s)');
    await page.close();
    return problems;
  }

  const outcome = await page.evaluate(
    ({ gid, solution, maxTicks, manual }) => {
      const game = window.cookbookGames[gid];
      // Turn-based (manual) games only advance when an action does; the step's `tick` is just an order key.
      for (const step of [...solution].sort((a, b) => a.tick - b.tick)) {
        if (!manual && step.tick > game.ticks) game.step(step.tick - game.ticks);
        if (game.act(step.action, ...(step.args || [])) === false) {
          return { error: `action "${step.action}" was rejected at tick ${game.ticks}` };
        }
      }
      if (!manual) game.step(maxTicks - game.ticks);
      return { status: game.status, ticks: game.ticks, health: Math.round(game.state.health) };
    },
    { gid: id, solution: run.solution, maxTicks: MAX_TICKS, manual: Boolean(run.manual) },
  );

  if (outcome.error) problems.push(outcome.error);
  else if (outcome.status !== 'won') problems.push(`scripted solution ended "${outcome.status}" after ${outcome.ticks} ticks (health ${outcome.health})`);
  else console.log(`  won after ${outcome.ticks} ticks, health ${outcome.health}`);

  if (!outcome.error && outcome.status === 'won' && !(await page.locator('.cg-result-won').count())) {
    problems.push('game reported won but the result panel is missing');
  }
  await page.close();
  return problems;
}

async function playGame(browser, id) {
  const scenario = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, id, 'scenarios.json'), 'utf8'));
  const runs = scenario.levels
    ? scenario.levels.map((l) => ({ label: l.id, level: l.id, seed: l.seed ?? scenario.seed, solution: l.solution, manual: scenario.manual }))
    : [{ label: null, level: null, seed: scenario.seed, solution: scenario.solution, manual: scenario.manual }];

  const problems = [];
  for (const run of runs) {
    if (run.label) console.log(` level: ${run.label}`);
    problems.push(...(await playRun(browser, id, run)).map((p) => (run.label ? `[${run.label}] ${p}` : p)));
  }

  const { learnUrl } = await import(pathToFileURL(path.join(GAMES_DIR, 'shared', 'learn.js')).href);
  problems.push(...(await checkLearnLinks(scenario, learnUrl)));
  return problems;
}

(async () => {
  const ids = fs
    .readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'shared' && fs.existsSync(path.join(GAMES_DIR, d.name, 'scenarios.json')))
    .map((d) => d.name)
    .sort();
  if (!ids.length) {
    console.error('no games found under docs/games/');
    process.exit(1);
  }

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let failed = 0;
  console.log('home page');
  const homeProblems = await checkHome(browser);
  for (const p of homeProblems) console.error(`  FAIL ${p}`);
  if (homeProblems.length) failed += 1;
  for (const id of ids) {
    console.log(`game: ${id}`);
    const problems = await playGame(browser, id);
    for (const p of problems) console.error(`  FAIL ${p}`);
    if (problems.length) failed += 1;
  }
  await browser.close();
  if (failed) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log(`${ids.length} game(s) passed`);
})();
