#!/usr/bin/env node
// Phone-usability checks on the BUILT site, in a real browser with touch emulation. For every level of
// every game (initial state) at 390x844 and 360x640 it measures:
//   small44   visible interactive elements under 44x44 CSS px (the recommended touch target)
//   small24   ... under 24x24 (the WCAG 2.2 minimum)
//   input16   text inputs with a font under 16px (iOS Safari zooms the page on focus)
//   tiny11    visible text nodes under 11px
//   overflow  1 if the page scrolls sideways
//   action    1 if, with the board scrolled to its end, no primary action button is visible
//   narrow    1 if the board is narrower than the screen minus 40px (cards inside cards waste width)
// and compares them with scripts/mobile_baseline.json. The baseline is a ratchet: a metric may go DOWN
// (lower the baseline with --update) but never UP, and a level or game missing from the baseline must be
// clean. Landscape (844x390) is measured and reported, not enforced.
//
// Usage: SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright> node scripts/mobile_quality.cjs [--update]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SITE_URL = (process.env.SITE_URL || 'http://localhost:8000/').replace(/\/?$/, '/');
const GAMES_DIR = path.join(__dirname, '..', 'docs', 'games');
const BASELINE = path.join(__dirname, 'mobile_baseline.json');
const UPDATE = process.argv.includes('--update');
const METRICS = ['small44', 'small24', 'input16', 'tiny11', 'overflow', 'action', 'narrow'];

const VIEWS = [
  { name: '390x844', width: 390, height: 844, enforce: true },
  { name: '360x640', width: 360, height: 640, enforce: true },
  { name: '844x390', width: 844, height: 390, enforce: false },
];

const games = fs
  .readdirSync(GAMES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'shared' && fs.existsSync(path.join(GAMES_DIR, d.name, 'scenarios.json')))
  .map((d) => d.name)
  .sort();

function levelsOf(game) {
  const s = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, game, 'scenarios.json'), 'utf8'));
  return (s.levels || [{ id: null }]).map((l) => l.id);
}

// Runs in the page. Returns the metrics and a few example offenders per metric.
function measure() {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const cg = document.querySelector('.cg');
  const label = (e) => (e.getAttribute('aria-label') || e.textContent || e.className || e.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 30);
  // A radio or checkbox is tapped through its label, and a link inside a sentence is exempt (WCAG 2.5.8).
  const target = (e) => (e.matches('input[type=radio], input[type=checkbox]') && e.closest('label')) || e;
  const inlineLink = (e) => e.matches('a[href]') && getComputedStyle(e).display === 'inline' && e.parentElement.textContent.trim() !== e.textContent.trim();
  const interactive = [...cg.querySelectorAll('button, a[href], input, select, textarea, summary, [role=button]')].filter((e) => visible(e) && !inlineLink(e));
  const under = (n) => interactive.filter((e) => { const r = target(e).getBoundingClientRect(); return r.width < n || r.height < n; });
  const small44 = under(44);
  const small24 = under(24);
  const inputs = [...cg.querySelectorAll('input[type=text], input:not([type]), input[type=search], textarea')].filter(visible);
  const input16 = inputs.filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16);
  const tiny = [];
  const walker = document.createTreeWalker(cg, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim() || !n.parentElement || !visible(n.parentElement)) continue;
    if (parseFloat(getComputedStyle(n.parentElement).fontSize) < 11) tiny.push(n.parentElement);
  }
  // Scroll the board to its end: is a primary action still on screen?
  const board = document.querySelector('.cg-board');
  const narrow = board.getBoundingClientRect().width < innerWidth - 40 ? 1 : 0;
  window.scrollTo(0, board.getBoundingClientRect().bottom + scrollY - innerHeight);
  const actions = [...document.querySelectorAll('.cg-actions .cg-btn-action, [data-primary-action]')].filter(visible);
  const reachable = actions.some((a) => { const r = a.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
  const sample = (list) => list.slice(0, 3).map(label);
  return {
    metrics: {
      small44: small44.length,
      small24: small24.length,
      input16: input16.length,
      tiny11: tiny.length,
      overflow: document.documentElement.scrollWidth > innerWidth ? 1 : 0,
      action: actions.length && !reachable ? 1 : 0,
      narrow,
    },
    examples: { small44: sample(small44), small24: sample(small24), input16: sample(input16), tiny11: sample(tiny) },
  };
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const results = {};
  const examples = {};
  for (const view of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
    for (const game of games) {
      // The levels of a game are independent pages: measure them in parallel.
      await Promise.all(
        levelsOf(game).map(async (level) => {
          const page = await ctx.newPage();
          await page.goto(`${SITE_URL}docs/games/${game}/?autoplay=0${level ? `&level=${encodeURIComponent(level)}` : ''}`, { waitUntil: 'load' });
          const key = `${game}/${level || '_'}@${view.name}`;
          try {
            await page.waitForSelector('.cg-board > *', { timeout: 15000 });
            await page.waitForTimeout(400);
            const { metrics, examples: ex } = await page.evaluate(measure);
            results[key] = { enforce: view.enforce, ...metrics };
            examples[key] = ex;
          } catch {
            results[key] = { enforce: view.enforce, error: 'board did not render' };
          }
          await page.close();
        }),
      );
    }
    await ctx.close();
  }
  await browser.close();

  if (UPDATE) {
    const out = {};
    for (const [k, v] of Object.entries(results)) if (v.enforce) out[k] = Object.fromEntries(METRICS.map((m) => [m, v[m]]));
    fs.writeFileSync(BASELINE, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`wrote ${Object.keys(out).length} baseline entries to ${path.relative(process.cwd(), BASELINE)}`);
    return;
  }

  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
  const worse = [];
  let improved = 0;
  for (const [key, r] of Object.entries(results)) {
    if (!r.enforce) continue;
    if (r.error) { worse.push(`${key}: ${r.error}`); continue; }
    const base = baseline[key] || {}; // a level or metric missing from the baseline must be clean
    for (const m of METRICS) {
      if (r[m] > (base[m] ?? 0)) worse.push(`${key}: ${m} is ${r[m]} (baseline ${base[m] ?? 0})${examples[key] && examples[key][m] ? `, e.g. ${examples[key][m].join(' | ')}` : ''}`);
      else if (r[m] < (base[m] ?? 0)) improved += 1;
    }
  }
  for (const key of Object.keys(baseline)) if (!results[key]) worse.push(`${key}: in the baseline but not measured (a game or level was removed; run with --update)`);

  const land = Object.entries(results).filter(([, r]) => !r.enforce && !r.error);
  const landTotal = land.reduce((s, [, r]) => s + r.small44 + r.input16 + r.tiny11 + r.overflow, 0);
  console.log(`measured ${Object.keys(results).length} level views; landscape (not enforced) issues: ${landTotal}`);
  const total = Object.entries(results).filter(([, r]) => r.enforce && !r.error).reduce((s, [, r]) => s + METRICS.reduce((a, m) => a + r[m], 0), 0);
  console.log(`enforced phone issues remaining: ${total}${improved ? ` (${improved} metric(s) improved: run with --update to lower the baseline)` : ''}`);
  if (worse.length) {
    for (const w of worse) console.error(`  FAIL ${w}`);
    console.error(`${worse.length} metric(s) got worse than scripts/mobile_baseline.json`);
    process.exit(1);
  }
})();
