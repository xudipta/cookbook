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
  // A score saved before per-level progress existed (legacy key) and one completed level.
  await page.addInitScript(() => {
    if (!localStorage.getItem('seeded')) {
      localStorage.setItem('seeded', '1');
      localStorage.setItem('cookbook-game-best:kubernetes', '1234');
      localStorage.setItem('cookbook-game-progress:docker', JSON.stringify({ levels: { hello: { best: 900, won: true, stars: 2, plays: 1, last: 1 } } }));
    }
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
  const k8s = await page.locator('a.tile[href="docs/games/kubernetes/"]').innerText();
  if (!k8s.includes('1234')) problems.push('the board lost a score saved under the legacy key');
  const dockerLevels = manifest.find((g) => g.id === 'docker').levels;
  const docker = await page.locator('a.tile[href="docs/games/docker/"]').innerText();
  if (!docker.includes(`1 of ${dockerLevels} levels done`) || !docker.includes('900')) problems.push('the board does not show saved per-level progress');
  if (!docker.includes(`★ 2/${dockerLevels * 3}`)) problems.push('the board does not show the stars saved for a level');
  await page.click('#reset-progress');
  await page.click('#reset-progress');
  await page.waitForFunction((n) => document.querySelector('a.tile[href="docs/games/docker/"]').innerText.includes(`0 of ${n} levels done`), dockerLevels);
  const cleared = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cookbook-game-')));
  if (cleared.length) problems.push(`reset left saved progress behind: ${cleared.join(', ')}`);
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
      return { status: game.status, ticks: game.ticks, actions: game.actionsUsed, moves: game.moves.map((m) => m.text), health: Math.round(game.state.health) };
    },
    { gid: id, solution: run.solution, maxTicks: MAX_TICKS, manual: Boolean(run.manual) },
  );

  if (!outcome.error && outcome.status === 'won') {
    // Par is the scripted solution's counted moves, so playing it earns three stars.
    const par = run.par;
    if (typeof par === 'number' && outcome.actions !== par) problems.push(`par is ${par} but the scripted solution used ${outcome.actions} counted moves: set par to ${outcome.actions}`);
    // The efficient path shown in the debrief is the scripted run's own moves.
    if (run.path) {
      const played = collapseMoves(outcome.moves);
      if (JSON.stringify(played) !== JSON.stringify(run.path)) problems.push(`path in scenarios.json differs from what the scripted solution did: expected ${JSON.stringify(played).slice(0, 200)}`);
    }
    const parts = await page.locator('.cg-result-won .cg-debrief-part > summary').allInnerTexts();
    for (const want of ['What you did', 'The efficient path', 'Try it for real']) {
      if (!parts.some((t) => t.startsWith(want))) problems.push(`the debrief has no "${want}" section`);
    }
    if (!(await page.locator('.cg-result-won .cg-lessons li').count())) problems.push('the debrief shows no lessons');
    if (!(await page.locator('.cg-result-won .cg-timeline li').count())) problems.push('the debrief timeline is empty');
    const stars = await page.locator('.cg-result-won .cg-stars').innerText().catch(() => '');
    if (stars !== '★★★') problems.push(`the scripted solution should earn three stars, the result shows "${stars}"`);
  }
  if (outcome.error) problems.push(outcome.error);
  else if (outcome.status !== 'won') problems.push(`scripted solution ended "${outcome.status}" after ${outcome.ticks} ticks (health ${outcome.health})`);
  else console.log(`  won after ${outcome.ticks} ticks, health ${outcome.health}`);

  if (!outcome.error && outcome.status === 'won') {
    if (!(await page.locator('.cg-result-won').count())) {
      problems.push('game reported won but the result panel is missing');
    } else {
      // A win offers the next level (unless this is the last) and a way back to the notes (when the game is on the board).
      const next = await page.locator('.cg-result-won [data-cg="next"]').count();
      if (next !== (run.isLast ? 0 : 1)) problems.push(`result panel has ${next} "Next level" button(s), expected ${run.isLast ? 0 : 1}`);
      const notes = await page.locator('.cg-result-won a[data-cg="notes"]').count();
      if (run.onBoard && notes !== 1) problems.push('result panel has no "Read the notes" link');

      // The win was saved: the stored entry says so, and after a reload the level is marked done.
      const key = `cookbook-game-progress:${id}`;
      const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);
      const entry = saved && saved.levels && saved.levels[run.level || '_'];
      if (!entry || !entry.won || !(entry.best > 0)) problems.push(`the win was not saved under ${key}`);
      else if (entry.stars !== 3) problems.push(`the win was saved with ${entry.stars} stars, expected 3`);
      if (run.level) {
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector(`.cg-btn-level[data-level="${run.level}"]`, { timeout: 15000 });
        const done = await page.getAttribute(`.cg-btn-level[data-level="${run.level}"]`, 'data-done');
        if (done !== 'true') problems.push('after a reload the won level is not marked done');
        if ((await page.getAttribute(`.cg-btn-level[data-level="${run.level}"]`, 'data-stars')) !== '3') problems.push('after a reload the level picker does not show three stars');
      }
    }
  }
  await page.close();
  return problems;
}

// The guided start and the hint ladder, on the first level: the guide shows once (?coach=1 forces it on a
// scripted run), walks every step, can be skipped or replayed; each hint is shown, costs points and runs out.
async function checkGuidance(browser, id, scenario) {
  const problems = [];
  const first = scenario.levels ? scenario.levels[0] : scenario;
  const hints = first.hints || [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const level = scenario.levels ? `&level=${encodeURIComponent(first.id)}` : '';
  await page.goto(`${SITE_URL}docs/games/${id}/?seed=${first.seed ?? scenario.seed}&autoplay=0&coach=1${level}`, { waitUntil: 'load' });
  try {
    await page.waitForSelector('.cg-coach:not([hidden])', { timeout: 15000 });
  } catch {
    problems.push('the guided start did not show with ?coach=1');
    await page.close();
    return problems;
  }
  let steps = 0;
  while (await page.locator('.cg-coach:not([hidden])').count()) {
    steps += 1;
    if ((await page.locator('.cg-coach-on').count()) !== 1) problems.push(`guided start step ${steps} highlights ${await page.locator('.cg-coach-on').count()} parts of the page, expected 1`);
    await page.click('[data-cg="coach-next"]');
    if (steps > 8) break;
  }
  if (steps < 3 || steps > 4) problems.push(`guided start has ${steps} steps, expected 3 or 4`);
  await page.click('[data-cg="guide"]');
  if (!(await page.locator('.cg-coach:not([hidden])').count())) problems.push('the Guide button does not replay the guided start');
  await page.click('[data-cg="coach-skip"]');
  if (await page.locator('.cg-coach:not([hidden])').count()) problems.push('Skip guide did not close the guided start');
  // Remembered per game: a normal visit (no ?coach) after finishing it does not show it again.
  await page.goto(`${SITE_URL}docs/games/${id}/?seed=${first.seed ?? scenario.seed}${level}`, { waitUntil: 'load' });
  await page.waitForSelector('.cg-board');
  if (await page.locator('.cg-coach:not([hidden])').count()) problems.push('the guided start came back after it was skipped');

  const score = async () => Number((await page.textContent('[data-stat="score"]')).replace(/\D/g, ''));
  const before = await score();
  for (let i = 0; i < hints.length; i++) await page.click('[data-cg="hint"]');
  if ((await page.locator('.cg-hint').count()) !== hints.length) problems.push(`expected ${hints.length} hints on screen, saw ${await page.locator('.cg-hint').count()}`);
  if (before - (await score()) !== 25 * hints.length) problems.push(`${hints.length} hints should cost ${25 * hints.length} points, cost ${before - (await score())}`);
  if (!(await page.isDisabled('[data-cg="hint"]'))) problems.push('the Hint button is still enabled after every hint was shown');
  await page.close();
  return problems;
}

// The debrief on the first level: copy works, still works with the clipboard blocked (the text is selected), the
// example link points into the repo, and a lost run says which rule it broke and offers a retry with a hint.
async function checkDebrief(browser, id, scenario) {
  const problems = [];
  const first = scenario.levels ? scenario.levels[0] : scenario;
  const level = scenario.levels ? `&level=${encodeURIComponent(first.id)}` : '';
  const url = `${SITE_URL}docs/games/${id}/?seed=${first.seed ?? scenario.seed}&autoplay=0&coach=0${level}`;
  const play = (page, solution) =>
    page.evaluate(
      ({ gid, solution: sol, manual }) => {
        const game = window.cookbookGames[gid];
        for (const step of [...sol].sort((a, b) => a.tick - b.tick)) {
          if (!manual && step.tick > game.ticks) game.step(step.tick - game.ticks);
          game.act(step.action, ...(step.args || []));
        }
        if (!manual) game.step(1000 - game.ticks);
      },
      { gid: id, solution, manual: Boolean(scenario.manual) },
    );

  // Won, clipboard blocked.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction((g) => window.cookbookGames && window.cookbookGames[g], id);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await play(page, first.solution);
  await page.locator('.cg-debrief-part', { hasText: 'Try it for real' }).locator('summary').click();
  const box = await page.locator('.cg-commands').innerText();
  if (box.trim() !== first.tryItForReal.commands.trim()) problems.push('the copyable block does not show the level\'s commands');
  const copyBox = await page.locator('[data-cg="copy"]').boundingBox();
  if (!copyBox || copyBox.height < 44) problems.push(`the Copy button is ${copyBox ? Math.round(copyBox.height) : 0}px tall on a phone, expected at least 44`);
  await page.click('[data-cg="copy"]');
  const selected = await page.evaluate(() => String(window.getSelection()));
  if (selected.trim() !== first.tryItForReal.commands.trim()) problems.push('with the clipboard blocked, Copy did not select the commands');
  if (!(await page.locator('.cg-copy-note').innerText()).length) problems.push('Copy showed no message');
  const href = await page.getAttribute('[data-cg="example"]', 'href');
  if (!href || !href.endsWith(first.tryItForReal.example)) problems.push(`the example link is ${href}, expected it to end with ${first.tryItForReal.example}`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) problems.push('the debrief makes the phone page scroll sideways');
  await ctx.close();

  // Lost: the rule, and Retry with a hint.
  const lost = await browser.newPage();
  lost.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await lost.goto(url, { waitUntil: 'load' });
  await lost.waitForFunction((g) => window.cookbookGames && window.cookbookGames[g], id);
  await lost.evaluate((gid) => {
    const game = window.cookbookGames[gid];
    // Do nothing and let time run out; a turn-based game is lost by running the health down through its own rules.
    try {
      for (let i = 0; i < 400 && game.status === 'playing'; i++) game.step(1);
    } catch {
      // A turn-based game that has not started its first turn cannot tick: it is not lost this way.
    }
  }, id);
  const status = await lost.evaluate((g) => window.cookbookGames[g].status, id);
  if (process.env.SMOKE_VERBOSE) console.log(`  ${id}: idle run ends "${status}"`);
  if (status === 'lost') {
    if (!(await lost.locator('.cg-rule-broken').count())) problems.push('a lost run does not say which rule was broken');
    if (!(await lost.locator('.cg-result-lost [data-cg="retry-hint"]').count())) problems.push('a lost run has no "Retry with a hint" button');
    else {
      await lost.click('[data-cg="retry-hint"]');
      const state = await lost.evaluate((g) => ({ status: window.cookbookGames[g].status, hints: window.cookbookGames[g].hintsUsed }), id);
      if (state.status !== 'playing' || state.hints !== 1) problems.push(`"Retry with a hint" should restart with one hint open, got ${JSON.stringify(state)}`);
    }
  }
  await lost.close();
  return problems;
}

// A level that offers "Try a different version" must stay winnable on every version, and the versions must
// actually differ. Each version is played with the scripted solution; the board of each is fingerprinted.
async function checkVariants(browser, id, scenario, VARIANT_SEEDS) {
  const problems = [];
  const levels = scenario.levels || [scenario];
  for (const level of levels.filter((l) => l.variants)) {
    const standard = level.seed ?? scenario.seed;
    const prints = new Set();
    for (const seed of [standard, ...VARIANT_SEEDS]) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => problems.push(`[${level.id}] page error: ${e.message}`));
      await page.goto(`${SITE_URL}docs/games/${id}/?seed=${seed}&autoplay=0&coach=0${scenario.levels ? `&level=${encodeURIComponent(level.id)}` : ''}`, { waitUntil: 'load' });
      await page.waitForFunction((g) => window.cookbookGames && window.cookbookGames[g], id);
      const out = await page.evaluate(
        ({ gid, solution, manual }) => {
          const game = window.cookbookGames[gid];
          for (const step of [...solution].sort((a, b) => a.tick - b.tick)) {
            if (!manual && step.tick > game.ticks) game.step(step.tick - game.ticks);
            if (game.act(step.action, ...(step.args || [])) === false) return { error: `action "${step.action}" was rejected at tick ${game.ticks}` };
          }
          if (!manual) game.step(1000 - game.ticks);
          return { status: game.status, html: document.querySelector('.cg-board').innerHTML };
        },
        { gid: id, solution: level.solution, manual: Boolean(scenario.manual) },
      );
      if (out.error) problems.push(`[${level.id}] version ${seed}: ${out.error}`);
      else if (out.status !== 'won') problems.push(`[${level.id}] version ${seed}: the scripted solution ended "${out.status}", so this version is not winnable as scripted`);
      else prints.add(out.html);
      await page.close();
    }
    if (prints.size < 2) problems.push(`[${level.id}] every version looks the same: a variant must change something the player can see`);

    // The buttons: a win offers the next version, which restarts on a new seed, and a way back to the standard one.
    const page = await browser.newPage();
    await page.goto(`${SITE_URL}docs/games/${id}/?seed=${standard}&autoplay=0&coach=0${scenario.levels ? `&level=${encodeURIComponent(level.id)}` : ''}`, { waitUntil: 'load' });
    await page.waitForFunction((g) => window.cookbookGames && window.cookbookGames[g], id);
    await page.evaluate(
      ({ gid, solution, manual }) => {
        const game = window.cookbookGames[gid];
        for (const step of [...solution].sort((a, b) => a.tick - b.tick)) {
          if (!manual && step.tick > game.ticks) game.step(step.tick - game.ticks);
          game.act(step.action, ...(step.args || []));
        }
        if (!manual) game.step(1000 - game.ticks);
      },
      { gid: id, solution: level.solution, manual: Boolean(scenario.manual) },
    );
    if (!(await page.locator('.cg-result [data-cg="version"]').count())) problems.push(`[${level.id}] the result has no "Try a different version" button`);
    else {
      await page.click('.cg-result [data-cg="version"]');
      const seedNow = await page.evaluate((g) => window.cookbookGames[g].seed, id);
      if (seedNow !== VARIANT_SEEDS[0]) problems.push(`[${level.id}] "Try a different version" used seed ${seedNow}, expected ${VARIANT_SEEDS[0]}`);
      if (await page.locator('.cg-result').count()) problems.push(`[${level.id}] "Try a different version" did not restart the level`);
      if (!new URL(page.url()).searchParams.get('seed')) problems.push(`[${level.id}] the version is not in the address bar`);
    }
    await page.close();
  }
  return problems;
}

let collapseMoves = (x) => x; // set in main() from the engine, so the path check uses the engine's own rule

// Quiet Hours on a phone: no dropdown quiz, chart data as text, a short page (#95).
async function checkObservabilityPhone(browser, scenario) {
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => localStorage.setItem('cookbook-games-seen', '1'));
  const page = await ctx.newPage();
  for (const level of scenario.levels) {
    await page.goto(`${SITE_URL}docs/games/observability/?autoplay=0&coach=0&level=${level.id}`, { waitUntil: 'load' });
    await page.waitForSelector('.cg-board');
    if (await page.locator('.oh-quiz select').count()) problems.push(`[${level.id}] the warm-up still uses dropdowns`);
    if ((level.path || []).length < 6) problems.push(`[${level.id}] has only ${(level.path || []).length} player decisions, expected at least 6`);
    await page.click('.oh-tabbar [data-part="charts"]');
    if (!(await page.locator('.oh-summary').innerText()).includes('highest')) problems.push(`[${level.id}] the chart has no text summary`);
    if (!(await page.locator('.oh-scrub').count())) problems.push(`[${level.id}] the chart cannot be read point by point`);
    await page.locator('.oh-scrub').fill('3');
    if (!/\d\d:\d\d/.test(await page.locator('.oh-readout').innerText())) problems.push(`[${level.id}] sliding the chart shows no time and value`);
    await page.click('.oh-tabbar [data-part="rules"]');
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height > 3000) problems.push(`[${level.id}] the page is ${height}px tall on a 390px screen, expected under 3000`);
  }
  await ctx.close();
  return problems;
}

// Chaos Monkey Cluster on a phone (#89): typing and the action sheet stop the clock, a fix made before reading costs
// error budget, every level asks for at least eight decisions, and Pressure pays more than Normal.
async function checkKubernetesPlay(browser, scenario) {
  const problems = [];
  for (const level of scenario.levels) {
    if ((level.path || []).length < 8) problems.push(`[${level.id}] has only ${(level.path || []).length} player decisions, expected at least 8`);
  }
  const first = scenario.levels[0];
  const open = async (extra = '') => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await page.goto(`${SITE_URL}docs/games/kubernetes/?seed=${first.seed}&coach=0&level=${first.id}${extra}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.cookbookGames && window.cookbookGames.kubernetes);
    return { ctx, page };
  };
  const ticks = (page) => page.evaluate(() => window.cookbookGames.kubernetes.ticks);

  // The clock runs on its own, stops while the prompt has focus, and stops while a pod sheet is open.
  {
    const { ctx, page } = await open('&tick=200');
    await page.waitForFunction(() => window.cookbookGames.kubernetes.ticks >= 2, null, { timeout: 5000 }).catch(() => problems.push('the clock did not run on its own'));
    await page.focus('.cg-prompt-input');
    const frozen = await ticks(page);
    await page.waitForTimeout(900);
    if ((await ticks(page)) !== frozen) problems.push('typing in the prompt let the clock tick');
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForFunction((t) => window.cookbookGames.kubernetes.ticks > t, frozen, { timeout: 4000 }).catch(() => problems.push('the clock did not resume after leaving the prompt'));
    await page.locator('.k8s-pod').first().click();
    if (!(await page.locator('.k8s-sheet:not([hidden])').count())) problems.push('tapping a pod did not open the action sheet');
    const at = await ticks(page);
    await page.waitForTimeout(900);
    if ((await ticks(page)) !== at) problems.push('the clock ticked while the pod sheet was open');
    const lines = await page.locator('.k8s-sheet-cmd').allInnerTexts();
    if (!lines.some((l) => l.startsWith('kubectl describe pod ')) || !lines.some((l) => l.startsWith('kubectl logs '))) problems.push('the pod sheet does not show the kubectl commands it runs');
    await page.click('[data-cg="close-sheet"]');
    await ctx.close();
  }

  // A fix made before reading costs error budget; the same fix after a describe does not.
  const run = async (diagnose) => {
    const { ctx, page } = await open('&autoplay=0');
    const health = await page.evaluate(({ diag }) => {
      const g = window.cookbookGames.kubernetes;
      g.step(12 - g.ticks);
      if (diag) g.act('kubectl', 'kubectl describe deploy web');
      g.act('kubectl', 'kubectl rollout undo deploy/web');
      return g.state.health;
    }, { diag: diagnose });
    await ctx.close();
    return health;
  };
  const blind = await run(false);
  const read = await run(true);
  if (!(read - blind >= 3)) problems.push(`fixing before reading should cost error budget (blind ${blind}, after describe ${read})`);

  // Pressure pays more for the same run.
  const scoreAt = async (pace) => {
    const { ctx, page } = await open('&autoplay=0');
    if (pace !== 'normal') await page.click(`[data-pace="${pace}"]`);
    const score = await page.evaluate((sol) => {
      const g = window.cookbookGames.kubernetes;
      for (const step of [...sol].sort((a, b) => a.tick - b.tick)) {
        if (step.tick > g.ticks) g.step(step.tick - g.ticks);
        g.act(step.action, ...(step.args || []));
      }
      g.step(1000 - g.ticks);
      return Number((document.querySelector('[data-stat="score"]').textContent || '').replace(/\D/g, ''));
    }, first.solution);
    await ctx.close();
    return score;
  };
  const normal = await scoreAt('normal');
  const pressure = await scoreAt('pressure');
  if (Math.abs(pressure - Math.round(normal * 1.5)) > 2) problems.push(`Pressure should score 1.5x Normal (${normal} -> ${pressure})`);
  return problems;
}

// Layer Cake on a phone (#90): a non-drag path with 44px targets and a drag grip that works with pointer events,
// a prediction that gates Build and explains the difference, and no scripted level shorter than five steps.
async function checkDockerPlay(browser, scenario) {
  const problems = [];
  for (const level of scenario.levels) {
    if ((level.path || []).length < 5) problems.push(`[${level.id}] has only ${(level.path || []).length} steps, expected at least 5`);
    if (!(level.path || []).some((p) => p.startsWith('Predict'))) problems.push(`[${level.id}] has no prediction step`);
  }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const open = async (level) => {
    await page.goto(`${SITE_URL}docs/games/docker/?autoplay=0&coach=0&level=${level}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.cookbookGames && window.cookbookGames.docker);
  };
  const g = (fn, arg) => page.evaluate(({ f, a }) => new Function('g', 'a', `return (${f})(g, a)`)(window.cookbookGames.docker, a), { f: fn.toString(), a: arg });

  await open('hello');
  // Build is locked until the prediction is answered.
  const refused = await g((game) => game.act('build') === false && game.state.okBuilds === 0);
  if (!refused) problems.push('Build ran before the prediction was answered');
  if (!(await page.locator('.dk-predict:not([hidden]) .dk-pick').count())) problems.push('the prediction panel is not shown before the first build');
  for (const box of await page.locator('.dk-pick').all()) {
    const h = (await box.boundingBox()).height;
    if (h < 44) problems.push(`a prediction toggle is ${Math.round(h)}px tall on a phone, expected at least 44`);
  }
  // A deliberately wrong answer costs budget and is explained line by line. (Level 1 starts with the cards in the
  // wrong order, so its first question is which line fails; the right answer is the first line.)
  const before = await g((game) => game.state.health);
  await page.locator('.dk-pick').nth(1).click();
  await page.click('.dk-lock');
  const after = await g((game) => game.state.health);
  if (!(after < before)) problems.push('a wrong prediction cost nothing');
  if (!(await page.locator('.dk-verdict-wrong').count())) problems.push('the verdict does not mark the wrong layers');
  const whys = await page.locator('.dk-why').allInnerTexts();
  if (!whys.some((t) => t.length > 12)) problems.push('the verdict does not explain why layers rebuild or stay cached');
  if (!(await g((game) => game.act('build') !== false))) problems.push('Build stayed locked after the prediction was answered');

  // Touch reordering without dragging: Up and Down are at least 44px, and they move the card.
  await open('cache');
  for (const op of ['up', 'down', 'remove']) {
    const box = await page.locator(`.dk-deck button[data-op="${op}"]:not(:disabled)`).first().boundingBox();
    if (!box || box.height < 44) problems.push(`the ${op} button is ${box ? Math.round(box.height) : 0}px tall on a phone, expected at least 44`);
  }
  const grips = await page.locator('.dk-grip').all();
  if (!grips.length) problems.push('the deck cards have no drag grip');
  else {
    await grips[0].evaluate((node) => node.scrollIntoView({ block: 'center' }));
    const gb = await grips[0].boundingBox();
    if (gb.width < 44 || gb.height < 44) problems.push(`the drag grip is ${Math.round(gb.width)}x${Math.round(gb.height)}px, expected at least 44x44`);
    const first = await g((game) => game.state.order[0]);
    const third = await page.locator('.dk-deck .dk-card').nth(1).boundingBox();
    // Pointer events: press the first card's grip, move to just below the second card (still on screen), release.
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + gb.width / 2, third.y + third.height + 4, { steps: 6 });
    await page.mouse.up();
    const now = await g((game) => game.state.order);
    if (now[1] !== first) problems.push('dragging a card by its grip did not move it');
  }
  // Keyboard on the grip.
  const second = await g((game) => game.state.order[1]);
  await page.locator('.dk-grip').nth(1).focus();
  await page.keyboard.press('ArrowUp');
  if ((await g((game) => game.state.order[0])) !== second) problems.push('ArrowUp on the grip did not move the card up');

  // The Compose level asks before Up, too.
  await open('compose');
  if (!(await g((game) => game.act('build') === false))) problems.push('Compose: Up ran before the prediction was answered');
  if (!(await page.locator('.dk-predict:not([hidden]) .dk-pick').count())) problems.push('Compose: no prediction panel');
  await ctx.close();
  return problems;
}

async function playGame(browser, id) {
  const scenario = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, id, 'scenarios.json'), 'utf8'));
  const onBoard = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, 'games.json'), 'utf8')).games.some((g) => g.id === id);
  const runs = scenario.levels
    ? scenario.levels.map((l, i) => ({ label: l.id, level: l.id, seed: l.seed ?? scenario.seed, solution: l.solution, par: l.par, path: l.path, manual: scenario.manual, isLast: i === scenario.levels.length - 1, onBoard }))
    : [{ label: null, level: null, seed: scenario.seed, solution: scenario.solution, par: scenario.par, path: scenario.path, manual: scenario.manual, isLast: true, onBoard }];

  const problems = [];
  for (const run of runs) {
    if (run.label) console.log(` level: ${run.label}`);
    problems.push(...(await playRun(browser, id, run)).map((p) => (run.label ? `[${run.label}] ${p}` : p)));
  }

  problems.push(...(await checkGuidance(browser, id, scenario)).map((p) => `[guidance] ${p}`));
  problems.push(...(await checkDebrief(browser, id, scenario)).map((p) => `[debrief] ${p}`));
  if (id === 'docker') problems.push(...(await checkDockerPlay(browser, scenario)).map((p) => `[play] ${p}`));
  if (id === 'kubernetes') problems.push(...(await checkKubernetesPlay(browser, scenario)).map((p) => `[play] ${p}`));
  if (id === 'observability') problems.push(...(await checkObservabilityPhone(browser, scenario)).map((p) => `[phone] ${p}`));
  const { VARIANT_SEEDS } = await import(pathToFileURL(path.join(GAMES_DIR, 'shared', 'engine.js')).href);
  problems.push(...(await checkVariants(browser, id, scenario, VARIANT_SEEDS)).map((p) => `[versions] ${p}`));

  const { learnUrl } = await import(pathToFileURL(path.join(GAMES_DIR, 'shared', 'learn.js')).href);
  problems.push(...(await checkLearnLinks(scenario, learnUrl)));
  return problems;
}

(async () => {
  ({ collapseMoves } = await import(pathToFileURL(path.join(GAMES_DIR, 'shared', 'engine.js')).href));
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
