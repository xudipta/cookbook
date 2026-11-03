#!/usr/bin/env node
// First-screen check for the practice games on a phone (#111). At 390x844 with touch emulation, for the first
// level of every game, it measures what a learner sees before they scroll:
//   board   where the game board starts (px from the top of the page)
//   ctrls   interactive controls inside the game that are on the first screen
//   stats   score / moves / tick numbers shown before the first move (the dock shows them; the HUD keeps the bar)
//   kbd     keyboard-shortcut badges on screen (a touch screen has no keyboard)
// and fails when a game is over its limit. The limits are a ratchet: scripts/first_screen_limits.json holds the
// default and any per-game exception, and only ever goes down.
//
// Usage: SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright> node scripts/first_screen_check.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SITE_URL = (process.env.SITE_URL || 'http://localhost:8000/').replace(/\/?$/, '/');
const GAMES_DIR = path.join(__dirname, '..', 'docs', 'games');
const LIMITS = JSON.parse(fs.readFileSync(path.join(__dirname, 'first_screen_limits.json'), 'utf8'));

const games = fs
  .readdirSync(GAMES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'shared' && fs.existsSync(path.join(GAMES_DIR, d.name, 'scenarios.json')))
  .map((d) => d.name)
  .sort();

(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  for (const id of games) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(`${SITE_URL}docs/games/${id}/?autoplay=0&seed=7`, { waitUntil: 'load' });
    await page.waitForSelector('.cg-board', { timeout: 20000 });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const vh = innerHeight;
      const shown = (e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < vh;
      };
      const board = document.querySelector('.cg-board');
      return {
        board: Math.round(board.getBoundingClientRect().top + scrollY),
        ctrls: [...document.querySelectorAll('#game a[href], #game button, #game input, #game select, #game textarea, #game [tabindex]:not([tabindex="-1"])')].filter(shown).length,
        stats: [...document.querySelectorAll('.cg-hud .cg-stat')].filter(shown).length,
        kbd: [...document.querySelectorAll('#game kbd')].filter(shown).length,
        about: Boolean(document.querySelector('details.cg-about')),
      };
    });
    await ctx.close();
    const lim = { ...LIMITS.default, ...(LIMITS.games[id] || {}) };
    const problems = [];
    if (m.board > lim.board) problems.push(`the board starts at ${m.board}px (limit ${lim.board})`);
    if (m.ctrls > lim.ctrls) problems.push(`${m.ctrls} controls on the first screen (limit ${lim.ctrls})`);
    if (m.stats > lim.stats) problems.push(`${m.stats} stat numbers before the first move (limit ${lim.stats})`);
    if (m.kbd > 0) problems.push(`${m.kbd} keyboard-shortcut badge(s) on a touch screen`);
    if (!m.about) problems.push('the intro is not folded into "About this game"');
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${id.padEnd(14)} board ${m.board}px, ${m.ctrls} controls, ${m.stats} stats${problems.length ? `: ${problems.join('; ')}` : ''}`);
    if (problems.length) failed += 1;
  }
  await browser.close();
  if (failed) {
    console.log(`\n${failed} game(s) over the first-screen limits (see scripts/first_screen_check.cjs)`);
    process.exit(1);
  }
  console.log('\nevery game is within the first-screen limits');
})();
