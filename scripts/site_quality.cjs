#!/usr/bin/env node
// Layout and accessibility checks on the BUILT site, in a real browser:
//   * no page scrolls sideways at phone width (390px) or desktop width (1280px);
//   * axe-core finds no serious or critical violations, in the light and the dark theme.
// Pages checked: the home page, one page of every game, a note with its Play banner, and the Learn overview.
//
// Usage: SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright and axe-core> node scripts/site_quality.cjs
// Optional: CHROMIUM_PATH=<browser binary>.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SITE_URL = (process.env.SITE_URL || 'http://localhost:8000/').replace(/\/?$/, '/');
const GAMES_DIR = path.join(__dirname, '..', 'docs', 'games');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const games = fs
  .readdirSync(GAMES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'shared')
  .map((d) => d.name)
  .sort();

const PAGES = [
  { name: 'home', url: '', ready: '.tile' },
  { name: 'learn overview', url: 'docs/learn/', ready: '.md-content' },
  { name: 'note with a Play banner', url: 'topics/docker/notes/01-images-and-dockerfiles/', ready: '.admonition' },
  // Games are audited with the guided start open, a hint revealed and the first level won, so the debrief on the
  // result panel (timeline, efficient path, copyable commands) is on the page too.
  ...games.map((g) => ({
    name: `game ${g}`,
    url: `docs/games/${g}/?autoplay=0&coach=1`,
    ready: '.cg-board',
    prepare: async (tab) => {
      await tab.click('[data-cg="hint"]');
      const scenario = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, g, 'scenarios.json'), 'utf8'));
      const first = scenario.levels ? scenario.levels[0] : scenario;
      await tab.evaluate(
        ({ gid, solution, manual }) => {
          const game = window.cookbookGames[gid];
          for (const step of [...solution].sort((a, b) => a.tick - b.tick)) {
            if (!manual && step.tick > game.ticks) game.step(step.tick - game.ticks);
            game.act(step.action, ...(step.args || []));
          }
          if (!manual) game.step(1000 - game.ticks);
        },
        { gid: g, solution: first.solution, manual: Boolean(scenario.manual) },
      );
      await tab.click('[data-cg="coach-skip"]');
      await tab.locator('.cg-debrief-part summary').nth(0).waitFor();
      // Open every part so axe sees the timeline, the path and the commands, not just the closed summaries.
      await tab.evaluate(() => document.querySelectorAll('.cg-debrief-part').forEach((d) => (d.open = true)));
    },
  })),
];

const VIEWS = [
  { label: 'phone, dark', width: 390, height: 844, scheme: 'dark' },
  { label: 'desktop, light', width: 1280, height: 900, scheme: 'light' },
];

// Violations in Material's own chrome (header, search, footer) are not ours to fix here.
const IGNORED_SELECTORS = ['.md-search', '.md-progress', '.md-header', '.md-footer', '.md-tabs', '.md-sidebar'];

async function checkPage(browser, page, view) {
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: view.scheme });
  const tab = await ctx.newPage();
  tab.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await tab.goto(SITE_URL + page.url, { waitUntil: 'load' });
  try {
    await tab.waitForSelector(page.ready, { timeout: 15000 });
  } catch {
    problems.push(`never rendered (no ${page.ready} within 15s)`);
    await ctx.close();
    return problems;
  }
  if (page.prepare) await page.prepare(tab);
  await tab.waitForTimeout(500);

  if (await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) {
    const wide = await tab.evaluate(() => {
      const w = window.innerWidth;
      const el = [...document.querySelectorAll('body *')].find((e) => e.getBoundingClientRect().right > w + 1);
      return el ? `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}` : 'unknown';
    });
    problems.push(`scrolls sideways (first element past the edge: ${wide})`);
  }

  await tab.evaluate(AXE);
  const result = await tab.evaluate(
    async (ignored) =>
      // eslint-disable-next-line no-undef
      axe.run({ exclude: ignored.map((s) => [s]) }, { resultTypes: ['violations'] }),
    IGNORED_SELECTORS,
  );
  for (const v of result.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
    const where = v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('; ');
    problems.push(`axe ${v.impact}: ${v.id}: ${v.help} (${v.nodes.length} element(s), e.g. ${where})`);
  }
  await ctx.close();
  return problems;
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let failed = 0;
  for (const page of PAGES) {
    for (const view of VIEWS) {
      const problems = await checkPage(browser, page, view);
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${page.name} (${view.label})`);
      for (const p of problems) console.error(`  ${p}`);
      if (problems.length) failed += 1;
    }
  }
  await browser.close();
  if (failed) {
    console.error(`${failed} page view(s) failed`);
    process.exit(1);
  }
  console.log(`${PAGES.length * VIEWS.length} page views passed`);
})();
