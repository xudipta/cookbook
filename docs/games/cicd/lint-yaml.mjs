#!/usr/bin/env node
// Runs actionlint over the workflow YAML that the game's cards generate: each Pipeline Tycoon level's
// starting workflow and the workflow its scripted solution ends with. The preview must be valid
// workflow syntax, not just look like it. Usage (actionlint on PATH): node docs/games/cicd/lint-yaml.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
// sim.js is a browser ES module in a folder without a package.json, so load a copy named .mjs: that
// works on every Node version without relying on module-syntax detection.
const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cicd-sim-')), 'sim.mjs');
fs.copyFileSync(path.join(here, 'sim.js'), copy);
const { applyAction, buildFiles, createWorld } = await import(pathToFileURL(copy).href);
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenarios.json'), 'utf8'));
const reusable = path.join(here, '..', '..', '..', 'topics', 'cicd', 'examples', 'workflows', 'reusable-lint.yml');
const { levels: _levels, ...base } = scenario;

// Replay only the card moves of a level's solution: that is all the YAML depends on.
function solved(level, replay) {
  const w = createWorld({ ...base, ...level });
  if (replay) {
    for (const step of level.solution) {
      if (step.action === 'place' || step.action === 'remove') applyAction(w, null, step.action, ...step.args);
    }
  }
  return w;
}

let failed = 0;
for (const level of scenario.levels.filter((l) => l.mode === 'pipeline')) {
  for (const [label, replay] of [['start', false], ['solution', true]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicd-game-'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.copyFileSync(reusable, path.join(dir, '.github', 'workflows', 'reusable-lint.yml'));
    for (const file of buildFiles(solved(level, replay))) {
      fs.mkdirSync(path.dirname(path.join(dir, file.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, file.path), file.text);
    }
    const run = spawnSync('actionlint', ['-no-color'], { cwd: dir, encoding: 'utf8' });
    const ok = run.status === 0;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${level.id} (${label})`);
    if (!ok) {
      failed += 1;
      console.log(run.stdout || run.stderr || String(run.error));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
