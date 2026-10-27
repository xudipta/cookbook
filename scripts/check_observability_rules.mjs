#!/usr/bin/env node
// Runs `promtool check rules` over the rules file each level of the Observability game produces: the
// starting rules, and the rules left after the level's scripted solution. The game builds real PromQL
// from its blocks (docs/games/observability/sim.js), so this fails if a block combination stops being
// valid. Needs `promtool` on PATH.
//
// Usage: node scripts/check_observability_rules.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'games', 'observability');
const sim = await import(pathToFileURL(path.join(root, 'sim.js')).href);
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'scenarios.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-rules-'));

const rng = () => 0.5; // the rules do not depend on the random series
let failed = 0;
for (const level of scenario.levels) {
  const world = sim.createWorld({ ...scenario, ...level }, rng);
  const files = { starting: sim.rulesYaml(world.rules) };
  for (const step of level.solution) {
    const args = step.args || [];
    if (step.action === 'saveRule') {
      if (!sim.saveRule(world, args[0])) throw new Error(`${level.id}: solution rule rejected: ${world.message}`);
    } else if (step.action === 'removeRule') {
      sim.removeRule(world, args[0]);
    }
  }
  files.solution = sim.rulesYaml(world.rules);
  for (const [label, yaml] of Object.entries(files)) {
    const file = path.join(tmp, `${level.id}-${label}.yml`);
    fs.writeFileSync(file, yaml);
    try {
      const out = execFileSync('promtool', ['check', 'rules', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`${level.id} (${label}): ${out.trim().split('\n').pop().trim()}`);
    } catch (err) {
      failed += 1;
      console.error(`${level.id} (${label}): promtool rejected the rules\n${err.stdout || ''}${err.stderr || ''}\n${yaml}`);
    }
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
