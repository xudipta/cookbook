#!/usr/bin/env node
// Replays each terminal-style game's scripted solution on a phone-sized touch screen, entering every
// command by tapping the suggestion chips and Run, never typing. It proves the shared prompt
// (docs/games/shared/prompt.js) offers enough to play without the keyboard.
//
//   - The first level of every terminal-style game must be fully composable and must be won.
//   - Later levels are reported (commands that still need the keyboard, such as a commit message)
//     but do not fail the check.
//
// Usage: SITE_URL=http://localhost:8000/ NODE_PATH=<dir with playwright> node scripts/compose_check.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SITE_URL = (process.env.SITE_URL || 'http://localhost:8000/').replace(/\/?$/, '/');
const GAMES_DIR = path.join(__dirname, '..', 'docs', 'games');
const COMMAND_ACTION = { kubernetes: 'kubectl', linux: 'sh', terraform: 'terraform', github: 'terminal', mcp: 'sh', database: 'sql' };
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const canon = (t) => (t.length > 1 ? t.replace(/\/+$/, '') : t);
const tokens = (s) => (s ? norm(s).split(' ').map(canon) : []);
// A token may still be on its way to a longer path (a directory chip), so /opt counts for /opt/deploy.
const covers = (t, goal) => goal === t || goal.startsWith(`${t}/`) || goal.startsWith(`${t.replace(/\/$/, '')}/`);
const subset = (a, b) => {
  const left = [...b];
  for (const t of a) {
    const i = left.findIndex((g) => covers(t, g));
    if (i === -1) return false;
    left.splice(i, 1);
  }
  return true;
};
const sameBag = (a, b) => a.length === b.length && a.every((t) => b.includes(t)) && b.every((t) => a.includes(t));

// Names the player makes up (a branch, a commit message, an index) are not in the scripted
// solutions' control, so the check substitutes what the prompt can offer.
const FREE_TEXT = {
  github: [
    [/-m "[^"]*"/, '-m "Update"'],
    [/switch -c \S+/, 'switch -c feature/update'],
  ],
  database: [
    [/(CREATE (?:UNIQUE )?INDEX) \S+ ON/, '$1 ON'],
    [/^EXPLAIN (?=SELECT)/, 'EXPLAIN ANALYZE '],
  ],
};

// Taps chips until the line holds the same words as `target`, then taps Run. Chips may be tapped in
// any order (flags commute); whether the result is right is decided by the level being won.
async function compose(page, id, target) {
  let want = norm(target);
  for (const [re, to] of FREE_TEXT[id] || []) want = want.replace(re, to);
  const goal = tokens(want);
  for (let guard = 0; guard < 40; guard++) {
    const raw = await page.inputValue('.cg-prompt-input');
    const cur = tokens(raw);
    if (sameBag(cur, goal)) {
      await page.click('.cg-prompt-run');
      return null;
    }
    if (!subset(cur, goal)) return `the line drifted to "${norm(raw)}"`;
    const chips = await page.$$eval('.cg-chip', (nodes) => nodes.map((n) => ({ text: n.dataset.text, full: n.hasAttribute('data-cmd'), run: n.dataset.run === 'true', disabled: n.disabled })));
    const head = raw.slice(0, /(\S*)$/.exec(raw).index);
    let best = null;
    chips.forEach((c, i) => {
      if (c.disabled) return;
      const line = tokens(c.full ? c.text : head + c.text);
      // A chip that runs on tap is only safe when it is exactly the command wanted.
      if (c.full && c.run ? !sameBag(line, goal) : !subset(line, goal)) return;
      const size = line.join(' ').length;
      if (size <= cur.join(' ').length) return;
      // The first chip that makes progress, in the order a player sees them.
      if (!best) best = { i, len: size, ran: c.full && c.run };
    });
    if (!best) {
      const missing = goal.filter((t) => !cur.includes(t)).join(' ');
      return `no chip continues "${norm(raw)}" (still missing: ${missing.slice(0, 70)})`;
    }
    await page.locator('.cg-chip').nth(best.i).click();
    if (best.ran) return null;
  }
  return 'too many taps';
}

async function playLevel(browser, id, scenario, level, index) {
  const solution = level ? level.solution : scenario.solution;
  const seed = level ? level.seed ?? scenario.seed : scenario.seed;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(`${SITE_URL}docs/games/${id}/?seed=${seed}&autoplay=0${level ? `&level=${encodeURIComponent(level.id)}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction((gid) => window.cookbookGames && window.cookbookGames[gid], id, { timeout: 15000 });
  const manual = Boolean(scenario.manual);
  const commandAction = COMMAND_ACTION[id];
  let composed = 0;
  let total = 0;
  const stuck = [];
  for (const step of [...solution].sort((a, b) => a.tick - b.tick)) {
    if (!manual) await page.evaluate((t) => { const g = window.cookbookGames[t.id]; if (t.tick > g.ticks) g.step(t.tick - g.ticks); }, { id, tick: step.tick });
    if (step.action === commandAction) {
      total += 1;
      const why = await compose(page, id, step.args[0]);
      if (why) {
        stuck.push(`${step.args[0].replace(/\s+/g, ' ').slice(0, 70)}  ->  ${why}`);
        const ok = await page.evaluate((s) => window.cookbookGames[s.id].act(s.action, ...(s.args || [])) !== false, { id, action: step.action, args: step.args });
        if (!ok) problems.push(`action ${step.action} was rejected`);
        await page.fill('.cg-prompt-input', '').catch(() => {});
      } else composed += 1;
    } else {
      const ok = await page.evaluate((s) => window.cookbookGames[s.id].act(s.action, ...(s.args || [])) !== false, { id, action: step.action, args: step.args });
      if (!ok) problems.push(`action ${step.action} was rejected`);
    }
  }
  const outcome = await page.evaluate(({ gid, manual: man }) => {
    const g = window.cookbookGames[gid];
    if (!man) g.step(1000 - g.ticks);
    return g.status;
  }, { gid: id, manual });
    await ctx.close();
  return { composed, total, stuck, outcome, problems, first: index === 0 };
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let failed = 0;
  for (const id of Object.keys(COMMAND_ACTION)) {
    const scenario = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, id, 'scenarios.json'), 'utf8'));
    const levels = scenario.levels || [null];
    console.log(id);
    for (let i = 0; i < levels.length; i++) {
      const label = levels[i] ? levels[i].id : '(single level)';
      let r;
      try {
        r = await playLevel(browser, id, scenario, levels[i], i);
      } catch (e) {
        console.log(`  ${label}: ${e.message.split('\n')[0]}`);
        if (i === 0) failed += 1;
        continue;
      }
      const must = r.first;
      const bad = r.problems.length || (must && (r.stuck.length || r.outcome !== 'won'));
      console.log(`  ${bad ? 'FAIL' : 'ok  '} ${label}: ${r.composed}/${r.total} commands by tapping, ${r.outcome}${must ? ' (must be keyboard-free)' : ''}`);
      for (const s of r.stuck) console.log(`      needs the keyboard: ${s}`);
      for (const p of r.problems) console.log(`      ${p}`);
      if (bad) failed += 1;
    }
  }
  await browser.close();
  if (failed) {
    console.error(`\n${failed} level(s) cannot be played without the keyboard`);
    process.exit(1);
  }
  console.log('\nevery first level can be played by tapping alone');
})();
