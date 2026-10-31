#!/usr/bin/env node
// Plays every story (docs/stories/<id>/) from start to finish on phone-sized touch screens and checks
// that it is playable by tapping alone:
//   - the story reaches its ending (fast mode: ?fast=1 shortens every wait),
//   - nothing scrolls sideways, and no script errors,
//   - every button, link and switch in the story is at least 44x44 CSS px,
//   - the button that moves the story on is on screen without scrolling the page,
//   - axe finds no violations in the first screen of each phase the story goes through.
//
// How a story is driven is data: docs/stories/<id>/drive.json (the answer to prefer, what to tap in the
// phases the script waits in). A new story needs no change to this file, and docs/stories/shared/ must stay
// free of topic words (checked below).
//
// Usage: SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright> node scripts/story_check.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

let AXE = null;
try {
  AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
} catch {
  console.log('note: axe-core is not installed, so the accessibility scan is skipped');
}

const SITE_URL = (process.env.SITE_URL || 'http://localhost:8000/').replace(/\/?$/, '/');
const STORIES_DIR = path.join(__dirname, '..', 'docs', 'stories');
const SCREENS = [{ name: 'phone 390x844', width: 390, height: 844 }, { name: 'small phone 360x640', width: 360, height: 640 }];
const MIN = 44;

async function play(browser, id, screen, drive) {
  const ctx = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(`${SITE_URL}docs/stories/${id}/?fast=1`, { waitUntil: 'load' });
  await page.waitForSelector('.ks .ks-btn', { timeout: 15000 });

  const small = new Set();
  const audit = async () => {
    const found = await page.evaluate((min) => {
      const out = [];
      for (const n of document.querySelectorAll('.ks button, .ks a, .ks summary')) {
        const r = n.getBoundingClientRect();
        if (!r.width || !r.height || n.disabled) continue;
        if (r.width < min - 0.5 || r.height < min - 0.5) out.push(`${n.className || n.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    }, MIN);
    found.forEach((f) => small.add(f));
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth)) problems.push('scrolls sideways');
  };
  const offscreen = new Set();
  const scanned = new Set();
  const prefer = drive.prefer ? new RegExp(drive.prefer) : null;
  const deadline = Date.now() + 90000;
  const tapped = new Set();
  let steps = 0;
  while (Date.now() < deadline) {
    const phase = await page.getAttribute('.ks', 'data-phase');
    if (phase === 'end') break;
    await audit();
    if (AXE && !scanned.has(phase)) {
      scanned.add(phase);
      if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: AXE });
      const found = await page.evaluate(() => window.axe.run('.ks', { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] }).then((r) => r.violations.map((v) => `${v.id} (${v.nodes[0].target.join(' ')})`)));
      found.forEach((f) => problems.push(`axe in phase "${phase}": ${f}`));
    }
    const rule = drive.phases && drive.phases[phase];
    if (rule) {
      if (!rule.once || !tapped.has(phase)) {
        tapped.add(phase);
        await page.click(rule.click);
      } else await page.waitForTimeout(60);
      continue;
    }
    tapped.clear();
    const buttons = page.locator('.ks-sheet .ks-btn');
    if (await buttons.count()) {
      const box = await buttons.first().boundingBox();
      if (box && box.y + box.height > screen.height + 0.5) offscreen.add((await buttons.first().innerText()).slice(0, 30));
      const labels = await buttons.allInnerTexts();
      const best = prefer ? labels.findIndex((l) => prefer.test(l)) : -1;
      await buttons.nth(best >= 0 ? best : 0).click();
      steps += 1;
      await page.waitForTimeout(30);
    } else await page.waitForTimeout(80);
  }
  const phase = await page.getAttribute('.ks', 'data-phase');
  if (phase !== 'end') problems.push(`the story did not reach its ending (stuck in phase "${phase}")`);
  await audit();
  // The ending lists the whole notebook, so the replay button may be scrolled; the links must work as links.
  const links = await page.$$eval('.ks-end-list ~ .ks-links a', (a) => a.map((x) => x.getAttribute('href')));
  if (links.length < 2 || links.some((l) => !l || l === '#')) problems.push('the ending needs links to the notes and the real game');
  await ctx.close();
  if (small.size) problems.push(`controls under ${MIN}px: ${[...small].slice(0, 6).join(', ')}`);
  if (offscreen.size) problems.push(`the next-step button was below the fold: ${[...offscreen].join(', ')}`);
  return { problems, steps };
}

// The shared shell must stay topic-free, so a new story never needs a change to it.
function sharedIsTopicFree() {
  const topic = /\b(cooks?|kitchen|pizza|pods?|kubernetes|kubectl|docker|terraform)\b/i;
  const dir = path.join(STORIES_DIR, 'shared');
  const bad = [];
  for (const f of fs.readdirSync(dir)) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (topic.test(line)) bad.push(`docs/stories/shared/${f}:${i + 1}: ${line.trim().slice(0, 60)}`);
    });
  }
  return bad;
}

(async () => {
  const leaks = fs.existsSync(path.join(STORIES_DIR, 'shared')) ? sharedIsTopicFree() : [];
  if (leaks.length) {
    console.error(`topic words in the shared story shell:\n  ${leaks.join('\n  ')}`);
    process.exit(1);
  }
  const ids = fs.existsSync(STORIES_DIR) ? fs.readdirSync(STORIES_DIR).filter((d) => fs.existsSync(path.join(STORIES_DIR, d, 'index.md'))) : [];
  if (!ids.length) { console.log('no stories'); return; }
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let failed = 0;
  for (const id of ids) {
    for (const screen of SCREENS) {
      const drive = JSON.parse(fs.readFileSync(path.join(STORIES_DIR, id, 'drive.json'), 'utf8'));
      const r = await play(browser, id, screen, drive).catch((e) => ({ problems: [e.message.split('\n')[0]], steps: 0 }));
      console.log(`${r.problems.length ? 'FAIL' : 'ok  '} ${id} on ${screen.name}: ${r.steps} taps`);
      r.problems.forEach((p) => console.log(`      ${p}`));
      if (r.problems.length) failed += 1;
    }
  }
  await browser.close();
  if (failed) { console.error(`\n${failed} story run(s) failed`); process.exit(1); }
  console.log('\nevery story can be played to the end by tapping');
})();
