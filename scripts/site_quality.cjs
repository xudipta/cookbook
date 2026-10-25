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
  ...games.map((g) => ({ name: `game ${g}`, url: `docs/games/${g}/?autoplay=0`, ready: '.cg-board' })),
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
