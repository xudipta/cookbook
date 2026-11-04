#!/usr/bin/env node
// Regenerates the screenshots used by the README and the home page from a built, served site, so they can be
// refreshed in one command (`make screenshots`) instead of by hand.
//
//   docs/images/docs-home.png         the home page, wide screen
//   docs/images/docs-topic-page.png   a note page with its story and practice banners, wide screen
//   docs/images/story-kubernetes.png  the Kubernetes story on a phone (also the hero image on the home page)
//   docs/images/docs-game.png         a practice game on a phone (its first screen)
//
// Usage:
//   SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright> node scripts/screenshots.cjs
//   node scripts/screenshots.cjs --check   # no browser: fail if an image is missing, or if the home page
//                                          # sources changed in git after the home screenshot did
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const SITE_URL = (process.env.SITE_URL || 'http://localhost:8000/').replace(/\/?$/, '/');

const IMAGES = ['docs-home.png', 'docs-topic-page.png', 'story-kubernetes.png', 'docs-game.png'];
const HOME_SOURCES = ['docs/site/index.html', 'docs/site/home.js', 'docs/site/home.css', 'docs/site/tokens.css'];

const commitTime = (file) => {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim();
    return out ? Number(out) : 0;
  } catch {
    return 0;
  }
};

function check() {
  const problems = [];
  for (const name of IMAGES) if (!fs.existsSync(path.join(OUT, name))) problems.push(`docs/images/${name} is missing`);
  const shot = commitTime('docs/images/docs-home.png');
  const newest = Math.max(...HOME_SOURCES.map(commitTime));
  if (shot && newest > shot) problems.push('the home page changed after docs/images/docs-home.png was last committed: run `make screenshots`');
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('screenshots are present and not older than the home page');
}

async function shoot() {
  const { chromium } = require('playwright');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const open = async (viewport, url, extra = {}) => {
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce', ...extra });
    const page = await ctx.newPage();
    await page.goto(`${SITE_URL}${url}`, { waitUntil: 'load' });
    return page;
  };
  const save = async (page, name) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, name) });
    await page.context().close();
    console.log(`wrote docs/images/${name}`);
  };

  // Wide screen: the home page and a note page (a fixed light scheme, so the images do not depend on the machine).
  const wide = { width: 1280, height: 860 };
  const light = { colorScheme: 'light' };
  let page = await open(wide, '', light);
  await page.waitForSelector('.story-tile');
  await save(page, 'docs-home.png');

  page = await open(wide, 'topics/docker/notes/01-images-and-dockerfiles/', light);
  await page.waitForSelector('.md-typeset h1');
  await save(page, 'docs-topic-page.png');

  // Phone: the Kubernetes story at the "tap a cook" beat (the same taps as scripts/story_check.cjs).
  const phone = { hasTouch: true, isMobile: true, deviceScaleFactor: 1.5, colorScheme: 'light' };
  page = await open({ width: 390, height: 780 }, 'docs/stories/kubernetes/?fast=1', phone);
  await page.waitForSelector('.ks .ks-btn');
  for (let i = 0; i < 12 && !(await page.locator('.ks-pick').count()); i++) {
    const buttons = page.locator('.ks-sheet .ks-btn');
    if (!(await buttons.count())) {
      await page.waitForTimeout(150);
      continue;
    }
    await buttons.first().click();
    await page.waitForTimeout(150);
  }
  await page.waitForSelector('.ks-pick', { timeout: 15000 });
  await save(page, 'story-kubernetes.png');

  // Phone: a practice game, first screen (the Linux game: a pager and a terminal).
  page = await open({ width: 390, height: 844 }, 'docs/games/linux/?autoplay=0&seed=7', { ...phone, deviceScaleFactor: 1 });
  await page.waitForSelector('.cg-board');
  await save(page, 'docs-game.png');

  await browser.close();
}

if (process.argv.includes('--check')) check();
else
  shoot().catch((err) => {
    console.error(err);
    process.exit(1);
  });
