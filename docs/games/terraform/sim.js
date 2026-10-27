// A small `terraform` simulator for the "Drift Detective" game. Pure logic, no DOM.
//
// It models what topics/terraform/notes/01 and 03 teach and nothing that contradicts them:
//   * `plan` first refreshes state against the real world, then diffs the config against the
//     refreshed state: `+` create, `~` update in place, `-/+` replace (a ForceNew attribute changed),
//     `-` destroy;
//   * state maps a resource block to a real object's ID; an object nobody put in state is invisible
//     to Terraform until it is imported (and a `create` of one that already exists fails);
//   * each workspace has its own state, and a remote backend keeps state off one laptop and locks it
//     while an operation runs;
//   * a stale lock (the run died) is cleared with `force-unlock`; an active one is not.
// The world is data from scenarios.json: a provider schema, a config, and per-workspace state + reality.

const clone = (o) => JSON.parse(JSON.stringify(o));
// The last two parts of an address are the resource type and name; anything before them is a module path.
const leaf = (addr) => {
  const parts = addr.split('.');
  return { type: parts[parts.length - 2] || parts[0], name: parts[parts.length - 1] };
};
const quote = (v) => JSON.stringify(v);

// ---------------------------------------------------------------- config values

// An attribute is a literal string, {var: name}, or {ws: {<workspace>: value, '*': value}}.
export function evalValue(w, workspace, v) {
  if (v && typeof v === 'object') {
    if ('var' in v) return w.config.vars[v.var];
    if ('ws' in v) return workspace in v.ws ? evalValue(w, workspace, v.ws[workspace]) : evalValue(w, workspace, v.ws['*']);
  }
  return v;
}

// How a value reads in main.tf.
export function describeValue(v) {
  if (v && typeof v === 'object') {
    if ('var' in v) return `var.${v.var}`;
    if ('ws' in v) {
      const keys = Object.keys(v.ws).filter((k) => k !== '*');
      const rest = describeValue(v.ws['*']);
      return keys.reduceRight((acc, k) => `terraform.workspace == ${quote(k)} ? ${describeValue(v.ws[k])} : ${acc}`, rest);
    }
  }
  return quote(v);
}

// What the player can edit: variables and plain literal attributes.
export function editTargets(w) {
  const out = Object.entries(w.config.vars).map(([name, value]) => ({ id: `var.${name}`, label: `var.${name}`, value }));
  for (const [addr, res] of Object.entries(w.config.resources)) {
    for (const [attr, v] of Object.entries(res.attrs)) {
      if (typeof v === 'string') out.push({ id: `${addr}.${attr}`, label: `${addr}.${attr}`, value: v });
    }
  }
  return out;
}

export function setVar(w, name, value) {
  if (!(name in w.config.vars) || w.config.vars[name] === value || typeof value !== 'string' || !value.trim()) return false;
  w.config.vars[name] = value.trim();
  w.pending = null;
  return true;
}

export function setAttr(w, addr, attr, value) {
  const res = w.config.resources[addr];
  if (!res || typeof res.attrs[attr] !== 'string' || res.attrs[attr] === value || typeof value !== 'string' || !value.trim()) return false;
  res.attrs[attr] = value.trim();
  w.pending = null;
  return true;
}

// "Extract a module": the level's `refactor.mapping` says where every resource block goes. The config
// still describes the same real objects with the same attributes; only the addresses change, and state is
// untouched, so Terraform now sees a destroy at each old address and a create at each new one.
export function extractModule(w, ctx) {
  if (!w.refactor || w.refactored) return false;
  const before = outOfSync(w);
  for (const { from, to } of w.refactor.mapping) {
    w.config.resources[to] = w.config.resources[from];
    delete w.config.resources[from];
  }
  w.refactored = true;
  w.pending = null;
  openEvent(w, ctx, 'module-extracted', `${w.refactor.mapping.length} resources now live in module "${w.refactor.module}"`, before);
  return true;
}

// A `moved { from, to }` block: `to` must be a resource the config declares.
export function addMoved(w, from, to) {
  if (!from || !to || from === to || !w.config.resources[to]) return false;
  if ((w.config.moved || []).some((m) => m.from === from && m.to === to)) return false;
  w.config.moved.push({ from, to });
  w.pending = null;
  return true;
}

// ---------------------------------------------------------------- world

export function createWorld(sc) {
  const w = {
    schema: sc.schema,
    config: { ...clone(sc.config), moved: clone(sc.config.moved || []) },
    refactor: sc.refactor ? clone(sc.refactor) : null, // an optional "extract a module" step (see extractModule)
    refactored: false,
    envs: {},
    workspace: sc.workspace,
    stateStore: sc.stateStore || 'local',
    initialized: Boolean(sc.initialized),
    lock: null,
    ci: 'No pipeline running.',
    pending: null,
    open: [],
    term: [],
    seq: 0x1a2b3,
    days: 0,
    health: 100,
    winTicks: sc.winTicks,
    minHealth: sc.minHealth,
    drift: sc.driftCost ?? 4,
  };
  // `deployed` addresses start in sync: a real object and a state entry, built from the config.
  for (const [name, env] of Object.entries(sc.envs)) {
    w.envs[name] = { state: {}, real: {} };
    for (const addr of env.deployed || []) {
      const res = w.config.resources[addr];
      const attrs = wanted(w, name, res);
      const id = newId(w, res.type, attrs);
      w.envs[name].real[id] = { type: res.type, attrs: { ...attrs } };
      w.envs[name].state[addr] = { id, type: res.type, attrs: { ...attrs } };
    }
  }
  return w;
}

function wanted(w, workspace, res) {
  return Object.fromEntries(Object.entries(res.attrs).map(([k, v]) => [k, evalValue(w, workspace, v)]));
}

function newId(w, type, attrs) {
  const key = w.schema[type].key;
  return key ? attrs[key] : `i-0${(w.seq++).toString(16)}`;
}

const diffAttrs = (from, to) =>
  Object.keys(to)
    .filter((k) => from[k] !== to[k])
    .map((attr) => ({ attr, from: from[attr], to: to[attr] }));

// ---------------------------------------------------------------- plan

export function computePlan(w, workspace = w.workspace) {
  const env = w.envs[workspace];
  const refreshed = {};
  const drift = [];
  for (const [addr, s] of Object.entries(env.state)) {
    const real = env.real[s.id];
    if (!real) {
      drift.push({ addr, type: s.type, deleted: true });
      continue;
    }
    const diffs = diffAttrs(s.attrs, real.attrs).concat(diffAttrs(real.attrs, s.attrs).filter((d) => !(d.attr in real.attrs)));
    if (diffs.length) drift.push({ addr, type: s.type, diffs });
    refreshed[addr] = { id: s.id, type: real.type, attrs: { ...real.attrs } };
  }

  // `moved` blocks: a state entry at `from` that has no entry at `to` is re-keyed before the diff.
  const moves = [];
  for (const m of w.config.moved || []) {
    if (refreshed[m.from] && !refreshed[m.to]) {
      refreshed[m.to] = refreshed[m.from];
      delete refreshed[m.from];
      moves.push({ from: m.from, to: m.to, type: refreshed[m.to].type });
    }
  }

  const changes = [];
  for (const [addr, res] of Object.entries(w.config.resources)) {
    const want = wanted(w, workspace, res);
    const cur = refreshed[addr];
    if (!cur) {
      changes.push({ addr, type: res.type, action: 'create', want });
      continue;
    }
    const diffs = diffAttrs(cur.attrs, want);
    if (!diffs.length) continue;
    const forces = diffs.filter((d) => w.schema[res.type].forceNew.includes(d.attr)).map((d) => d.attr);
    changes.push({ addr, type: res.type, action: forces.length ? 'replace' : 'update', diffs, forces, from: cur.attrs, want, id: cur.id });
  }
  for (const [addr, cur] of Object.entries(refreshed)) {
    if (!w.config.resources[addr]) changes.push({ addr, type: cur.type, action: 'destroy', from: cur.attrs });
  }
  return { workspace, refreshed, drift, changes, moves };
}

// "env/addr" pairs where reality, state and config disagree.
export function outOfSync(w) {
  const out = new Set();
  for (const name of Object.keys(w.envs)) {
    const plan = computePlan(w, name);
    for (const c of plan.changes) out.add(`${name}/${c.addr}`);
    for (const m of plan.moves) out.add(`${name}/${m.to}`); // a move not yet applied to state

  }
  return out;
}

const SYMBOL = { create: '+', update: '~', replace: '-/+', destroy: '-' };
const VERB = {
  create: 'will be created',
  update: 'will be updated in-place',
  replace: 'must be replaced',
  destroy: 'will be destroyed',
};

function changeLines(w, c) {
  const type = c.type;
  const { name } = leaf(c.addr);
  const sym = SYMBOL[c.action];
  const lines = [`  # ${c.addr} ${VERB[c.action]}`, `${sym.length === 1 ? `  ${sym}` : sym} resource "${type}" "${name}" {`];
  const keys = [...new Set([...Object.keys(c.from || {}), ...Object.keys(c.want || {})])];
  const width = Math.max(...keys.map((k) => k.length), 2);
  if (c.action === 'create') {
    lines.push(`      + ${'id'.padEnd(width)} = (known after apply)`);
    for (const k of keys) lines.push(`      + ${k.padEnd(width)} = ${quote(c.want[k])}`);
  } else if (c.action === 'destroy') {
    for (const k of keys) lines.push(`      - ${k.padEnd(width)} = ${quote(c.from[k])} -> null`);
  } else {
    const changed = new Map(c.diffs.map((d) => [d.attr, d]));
    let hidden = 0;
    for (const k of keys) {
      const d = changed.get(k);
      if (!d) {
        hidden += 1;
        continue;
      }
      lines.push(`      ~ ${k.padEnd(width)} = ${quote(d.from)} -> ${quote(d.to)}${c.forces.includes(k) ? ' # forces replacement' : ''}`);
    }
    if (c.action === 'replace') lines.push(`      ~ ${'id'.padEnd(width)} = ${quote(c.id ?? '')} -> (known after apply)`);
    if (hidden) lines.push(`        # (${hidden} unchanged attribute${hidden > 1 ? 's' : ''} hidden)`);
  }
  lines.push('    }', '');
  return lines;
}

const count = (changes, f) => changes.filter(f).length;
const summary = (changes) =>
  `${count(changes, (c) => c.action === 'create' || c.action === 'replace')} to add, ${count(changes, (c) => c.action === 'update')} to change, ${count(changes, (c) => c.action === 'destroy' || c.action === 'replace')} to destroy`;

export function planText(w, plan) {
  const lines = [];
  for (const addr of Object.keys(w.envs[plan.workspace].state)) {
    lines.push(`${addr}: Refreshing state... [id=${w.envs[plan.workspace].state[addr].id}]`);
  }
  if (lines.length) lines.push('');
  if (plan.drift.length) {
    lines.push('Note: Objects have changed outside of Terraform', '', 'Terraform detected the following changes made outside of Terraform since the last "terraform apply":', '');
    for (const d of plan.drift) {
      const { name } = leaf(d.addr);
      if (d.deleted) {
        lines.push(`  # ${d.addr} has been deleted`, `  - resource "${d.type}" "${name}" {`, '    }', '');
        continue;
      }
      lines.push(`  # ${d.addr} has changed`, `  ~ resource "${d.type}" "${name}" {`);
      for (const x of d.diffs) lines.push(`      ~ ${x.attr} = ${quote(x.from)} -> ${quote(x.to)}`);
      lines.push('    }', '');
    }
  }
  if (!plan.changes.length && !plan.moves.length) {
    lines.push('No changes. Your infrastructure matches the configuration.');
    return lines;
  }
  lines.push(
    'Resource actions: + create, ~ update in-place, -/+ destroy and then create replacement, - destroy',
    '',
    'Terraform will perform the following actions:',
    '',
  );
  for (const m of plan.moves) {
    lines.push(`  # ${m.from} has moved to ${m.to}`, `    resource "${m.type}" "${leaf(m.to).name}" {`, '        # (all attributes unchanged)', '    }', '');
  }
  for (const c of plan.changes) lines.push(...changeLines(w, c));
  lines.push(`Plan: ${summary(plan.changes)}.`);
  return lines;
}

// ---------------------------------------------------------------- applying a plan

const isData = (w, type) => Boolean(w.schema[type].data);

function exists(w, env, type, attrs) {
  const key = w.schema[type].key;
  return Boolean(key) && Object.values(env.real).some((r) => r.type === type && r.attrs[key] === attrs[key]);
}

function say(w, text, kind = 'out') {
  for (const line of String(text).split('\n')) w.term.push({ kind, text: line });
  if (w.term.length > 400) w.term.splice(0, w.term.length - 400);
}

function failure(w, summaryText, detail) {
  say(w, `Error: ${summaryText}`, 'err');
  if (detail) say(w, detail, 'err');
}

function hurt(w, amount) {
  w.health = Math.max(0, w.health - amount);
}

function applyPlan(w, ctx, plan) {
  const env = w.envs[plan.workspace];
  env.state = plan.refreshed; // an apply saves the refreshed state, drift included
  let added = 0;
  let changed = 0;
  let destroyed = 0;
  let errors = 0;
  let dataLost = false;

  const create = (c) => {
    if (exists(w, env, c.type, c.want)) {
      failure(w, `creating ${c.type} (${c.want[w.schema[c.type].key]}): ${w.schema[c.type].exists}`, `  with ${c.addr}`);
      errors += 1;
      return false;
    }
    const id = newId(w, c.type, c.want);
    say(w, `${c.addr}: Creating...`);
    env.real[id] = { type: c.type, attrs: { ...c.want } };
    env.state[c.addr] = { id, type: c.type, attrs: { ...c.want } };
    say(w, `${c.addr}: Creation complete after 1s [id=${id}]`);
    added += 1;
    return true;
  };
  const destroy = (addr, cur) => {
    say(w, `${addr}: Destroying... [id=${cur.id}]`);
    delete env.real[cur.id];
    delete env.state[addr];
    say(w, `${addr}: Destruction complete after 1s`);
    destroyed += 1;
    if (isData(w, cur.type)) dataLost = true;
  };

  for (const c of plan.changes) {
    const cur = plan.refreshed[c.addr];
    if (c.action === 'create') create(c);
    else if (c.action === 'update') {
      say(w, `${c.addr}: Modifying... [id=${cur.id}]`);
      Object.assign(env.real[cur.id].attrs, c.want);
      Object.assign(env.state[c.addr].attrs, c.want);
      say(w, `${c.addr}: Modifications complete after 1s [id=${cur.id}]`);
      changed += 1;
    } else if (c.action === 'replace') {
      destroy(c.addr, cur);
      create(c);
    } else destroy(c.addr, cur);
  }

  say(w, '');
  say(w, `Apply ${errors ? 'incomplete' : 'complete'}! Resources: ${added} added, ${changed} changed, ${destroyed} destroyed.`, errors ? 'err' : 'out');
  if (dataLost) {
    hurt(w, 35);
    ctx.fire('data-loss', 'a stateful resource was destroyed');
    ctx.resolve('data-loss');
  }
}

// ---------------------------------------------------------------- commands

function lockError(w, ctx) {
  const l = w.lock;
  say(w, 'Error: Error acquiring the state lock', 'err');
  say(
    w,
    [
      '',
      'Error message: ConditionalCheckFailedException: The conditional request failed',
      'Lock Info:',
      `  ID:        ${l.id}`,
      `  Path:      tfstate/${w.workspace}/terraform.tfstate`,
      `  Operation: ${l.op}`,
      `  Who:       ${l.who}`,
      `  Created:   day ${l.day}`,
      '',
      'Terraform acquires a state lock to protect the state from being written',
      'by multiple users at the same time. Please resolve the issue above and try again.',
    ].join('\n'),
    'err',
  );
  return false;
}

// True when the command can run; otherwise prints why not.
function gate(w, ctx, { lock = true } = {}) {
  if (!w.initialized) {
    failure(w, 'Backend initialization required, please run "terraform init"', w.config.backend ? 'Reason: Initial configuration of the requested backend "s3"' : null);
    return false;
  }
  if (lock && w.lock) return lockError(w, ctx);
  return true;
}

function init(w, args) {
  const migrate = args.includes('-migrate-state');
  const reconfigure = args.includes('-reconfigure');
  if (!w.config.backend) {
    if (migrate || reconfigure) {
      failure(w, 'no backend block in the configuration', 'There is nothing to migrate to. Add a backend block first.');
      return false;
    }
    w.initialized = true;
    say(w, 'Initializing the backend...\nInitializing provider plugins...\n\nTerraform has been successfully initialized!');
    return 'free';
  }
  if (w.stateStore === 'local' && !migrate && !reconfigure) {
    failure(
      w,
      'Backend configuration changed',
      [
        'A change in the backend configuration has been detected, which may require migrating existing state.',
        '',
        'If you wish to attempt automatic migration of the state, use "terraform init -migrate-state".',
        'If you wish to store the current configuration with no changes to the state, use "terraform init -reconfigure".',
      ].join('\n'),
    );
    return false;
  }
  if (reconfigure) {
    // -reconfigure points at the new backend and leaves the old state behind.
    for (const env of Object.values(w.envs)) env.state = {};
    say(w, 'Successfully configured the backend "s3"! Terraform will automatically use this backend unless the backend configuration changes.');
  } else if (migrate && w.stateStore === 'local') {
    say(w, 'Successfully configured the backend "s3"! Existing state copied to the new backend.');
  } else {
    say(w, 'Terraform has been successfully initialized!');
  }
  w.stateStore = 'remote';
  w.initialized = true;
  return 'free';
}

function doPlan(w, ctx) {
  if (!gate(w, ctx)) return false;
  say(w, planText(w, computePlan(w)).join('\n'));
  return false; // reading a plan is free and never counts as a move
}

function doApply(w, ctx, args) {
  if (!gate(w, ctx)) return false;
  const plan = computePlan(w);
  const auto = args.includes('-auto-approve');
  if (!plan.changes.length && !plan.moves.length) {
    say(w, planText(w, plan).join('\n'));
    applyPlan(w, ctx, plan); // still saves the refreshed state
    return 'free';
  }
  say(w, planText(w, plan).join('\n'));
  if (!auto) {
    say(w, ['', 'Do you want to perform these actions?', '  Terraform will perform the actions described above.', "  Only 'yes' will be accepted to approve.", '', '  Enter a value:'].join('\n'));
    w.pending = { workspace: w.workspace };
    return false;
  }
  say(w, '');
  applyPlan(w, ctx, plan);
  return true;
}

function confirm(w, ctx) {
  const pending = w.pending;
  w.pending = null;
  if (!pending) {
    say(w, '`yes` answers an apply prompt. Run terraform apply first.', 'err');
    return false;
  }
  if (!gate(w, ctx)) return false;
  say(w, '');
  applyPlan(w, ctx, computePlan(w));
  return true;
}

function doImport(w, ctx, args) {
  if (!gate(w, ctx)) return false;
  const [addr, id] = args.filter((a) => !a.startsWith('-'));
  const env = w.envs[w.workspace];
  if (!addr || !id) {
    failure(w, 'The import command expects two arguments', 'Usage: terraform import ADDRESS ID');
    return false;
  }
  const res = w.config.resources[addr];
  if (!res) {
    failure(w, 'Resource address does not exist in configuration', `Before importing this resource, add a resource "${leaf(addr).type}" "${leaf(addr).name || 'NAME'}" block to the configuration.`);
    return false;
  }
  if (env.state[addr]) {
    failure(w, 'Resource already managed by Terraform', `Terraform is already managing a remote object for ${addr}.`);
    return false;
  }
  const real = env.real[id];
  if (!real || real.type !== res.type) {
    failure(w, 'Cannot import non-existent remote object', `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id (${id}).`);
    return false;
  }
  env.state[addr] = { id, type: real.type, attrs: { ...real.attrs } };
  say(w, `${addr}: Importing from ID "${id}"...\n${addr}: Import prepared!\n\nImport successful!\n\nThe resources that were imported are shown above. They are now in your Terraform state and will henceforth be managed by Terraform.`);
  return true;
}

function doState(w, ctx, args) {
  const [sub, addr] = args;
  const env = w.envs[w.workspace];
  if (!gate(w, ctx, { lock: sub === 'rm' || sub === 'mv' })) return false;
  if (sub === 'list') {
    say(w, Object.keys(env.state).join('\n') || 'No state.');
    return false;
  }
  if (sub === 'show') {
    const s = env.state[addr];
    if (!s) {
      failure(w, 'No instance found for the given address!', `This command requires that the address references one specific instance. "${addr || ''}" is not in state.`);
      return false;
    }
    say(w, [`# ${addr}:`, `resource "${s.type}" "${leaf(addr).name}" {`, `    id = ${quote(s.id)}`, ...Object.entries(s.attrs).map(([k, v]) => `    ${k} = ${quote(v)}`), '}'].join('\n'));
    return false;
  }
  if (sub === 'mv') {
    const [, from, to] = args;
    if (!from || !to) {
      failure(w, 'Invalid arguments', 'Usage: terraform state mv SOURCE DESTINATION');
      return false;
    }
    if (!env.state[from]) {
      failure(w, 'Invalid source address', `No matching objects found for "${from}".`);
      return false;
    }
    if (env.state[to]) {
      failure(w, 'Invalid destination address', `The destination resource instance already exists: ${to}.`);
      return false;
    }
    if (!/^(module\.[\w-]+\.)*[a-z0-9_]+\.[\w-]+$/.test(to)) {
      failure(w, 'Invalid destination address', `"${to}" is not a valid resource address.`);
      return false;
    }
    env.state[to] = env.state[from];
    delete env.state[from];
    say(w, `Move "${from}" to "${to}"\nSuccessfully moved 1 object(s). The real object is untouched.`);
    return true;
  }
  if (sub === 'rm') {
    if (!env.state[addr]) {
      failure(w, 'Invalid target address', `No matching objects found for "${addr || ''}".`);
      return false;
    }
    delete env.state[addr];
    say(w, `Removed ${addr}\nSuccessfully removed 1 resource instance(s). The real object is untouched.`);
    return true;
  }
  failure(w, 'Unknown state subcommand', 'Usage: terraform state (list | show ADDRESS | mv SOURCE DESTINATION | rm ADDRESS)');
  return false;
}

function doWorkspace(w, ctx, args) {
  const [sub, name] = args;
  if (sub === 'show') {
    say(w, w.workspace);
    return false;
  }
  if (sub === 'list') {
    say(w, Object.keys(w.envs).map((n) => `${n === w.workspace ? '*' : ' '} ${n}`).join('\n'));
    return false;
  }
  if (sub === 'select') {
    if (!w.envs[name]) {
      failure(w, `Workspace "${name}" doesn't exist.`, 'You can create this workspace with the "new" subcommand.');
      return false;
    }
    w.workspace = name;
    w.pending = null;
    say(w, `Switched to workspace "${name}".`);
    return 'free';
  }
  if (sub === 'new') {
    if (!name || w.envs[name]) {
      failure(w, name ? `Workspace "${name}" already exists` : 'A workspace name is required');
      return false;
    }
    w.envs[name] = { state: {}, real: {} };
    w.workspace = name;
    w.pending = null;
    say(w, `Created and switched to workspace "${name}"!`);
    return 'free';
  }
  failure(w, 'Unknown workspace subcommand', 'Usage: terraform workspace (show | list | select NAME | new NAME)');
  return false;
}

function doForceUnlock(w, ctx, args) {
  if (!gate(w, ctx, { lock: false })) return false;
  const id = args.filter((a) => !a.startsWith('-')).pop();
  if (!w.lock) {
    failure(w, 'Failed to unlock state', 'There is no lock to remove.');
    return false;
  }
  if (id !== w.lock.id) {
    failure(w, 'Failed to unlock state', `Local state cannot be unlocked by another process\nLock ID ${id || '(none)'} does not match the lock held on the state (${w.lock.id}).`);
    return false;
  }
  const active = w.lock.expires !== null;
  w.lock = null;
  w.ci = active ? 'CI apply job: failed (state changed under it).' : w.ci;
  say(w, 'Terraform state has been successfully unlocked!\n\nThe state has been unlocked, and Terraform commands should now be able to obtain a new lock on the remote state.');
  if (active) {
    hurt(w, 40);
    ctx.fire('lock-forced', 'the running apply lost its lock');
    ctx.resolve('lock-forced');
  }
  return true;
}

const HELP = [
  'Main commands (this game supports):',
  '  init [-migrate-state | -reconfigure]',
  '  plan',
  '  apply [-auto-approve]       (answer the prompt with: yes)',
  '  import ADDRESS ID',
  '  state list | state show ADDRESS | state mv SOURCE DESTINATION | state rm ADDRESS',
  '  workspace show | list | select NAME | new NAME',
  '  force-unlock LOCK_ID',
].join('\n');

// Runs one command line. Returns false (read-only, rejected or failed: not a move), 'free' (valid,
// not scored) or true (a scored move that changed something).
export function runCommand(w, ctx, line) {
  const text = String(line || '').trim();
  if (!text) return false;
  say(w, `$ ${text}`, 'cmd');
  const words = text.split(/\s+/);
  if (words[0] === 'yes') return confirm(w, ctx);
  if (words[0] === 'terraform' || words[0] === 'tf') words.shift();
  else {
    say(w, `${words[0]}: command not found. Commands start with terraform.`, 'err');
    return false;
  }
  const [cmd, ...args] = words;
  if (w.pending && cmd !== 'plan') say(w, 'Apply cancelled.');
  if (cmd !== 'plan' && cmd !== undefined) w.pending = null;
  switch (cmd) {
    case 'init':
      return init(w, args);
    case 'plan':
      w.pending = null;
      return doPlan(w, ctx);
    case 'apply':
      return doApply(w, ctx, args);
    case 'import':
      return doImport(w, ctx, args);
    case 'state':
      return doState(w, ctx, args);
    case 'workspace':
      return doWorkspace(w, ctx, args);
    case 'force-unlock':
      return doForceUnlock(w, ctx, args);
    case 'validate':
      say(w, 'Success! The configuration is valid.');
      return false;
    case 'fmt':
      say(w, 'main.tf');
      return false;
    case 'destroy':
      say(w, 'terraform destroy is switched off in this exercise: it would remove everything you are trying to keep.', 'err');
      return false;
    case 'help':
    case undefined:
      say(w, HELP);
      return false;
    default:
      failure(w, `Terraform has no command named "${cmd}"`, 'Try "terraform help".');
      return false;
  }
}

// ---------------------------------------------------------------- the day clock

function openEvent(w, ctx, id, detail, before) {
  const targets = [...outOfSync(w)].filter((t) => !before.has(t));
  ctx.fire(id, detail);
  w.open.push({ id, targets });
}

function reconcile(w, ctx) {
  const out = outOfSync(w);
  w.open = w.open.filter((e) => {
    const done = e.lock ? !w.lock : e.targets.every((t) => !out.has(t));
    if (done) ctx.resolve(e.id);
    return !done;
  });
}

export function afterMove(w, ctx) {
  reconcile(w, ctx);
}

export function tick(w, ctx) {
  const sc = ctx.scenario;
  w.days += 1;
  w.pending = null;

  if (w.refactor && !w.refactored && sc.nagCost) {
    hurt(w, sc.nagCost);
    ctx.log(`The refactoring ticket is still open (-${sc.nagCost} ${sc.healthLabel.toLowerCase()}).`, { kind: 'warn' });
  }

  // Overnight, anything still out of sync costs trust. An active lock freezes the clock: nobody can fix it.
  const stuck = outOfSync(w);
  if (stuck.size && !(w.lock && w.lock.expires !== null)) {
    hurt(w, stuck.size * w.drift);
    ctx.log(`Overnight: ${stuck.size} resource${stuck.size > 1 ? 's' : ''} still out of sync (-${stuck.size * w.drift} ${sc.healthLabel.toLowerCase()}).`, { kind: 'warn' });
  }
  if (w.lock && w.lock.expires !== null && ctx.ticks >= w.lock.expires) {
    w.lock = null;
    w.ci = 'No pipeline running.';
    ctx.log('The CI job finished and released the state lock.', { kind: 'good' });
  }

  for (const item of sc.schedule || []) {
    if (item.tick !== ctx.ticks) continue;
    const before = outOfSync(w);
    switch (item.event) {
      case 'var-change':
        w.config.vars[item.var] = item.value;
        openEvent(w, ctx, 'var-change', `var.${item.var} = ${quote(item.value)}`, before);
        break;
      case 'console-edit': {
        const env = w.envs[item.env];
        if (!env.state[item.addr]) break; // never deployed, so there is nothing to edit by hand
        env.real[env.state[item.addr].id].attrs[item.attr] = item.value;
        openEvent(w, ctx, 'console-edit', `${item.addr} in workspace ${item.env}`, before);
        break;
      }
      case 'hand-made': {
        const env = w.envs[item.env];
        env.real[item.id] = { type: item.type, attrs: { ...item.attrs } };
        w.config.resources[item.addr] = { type: item.type, attrs: clone(item.config) };
        openEvent(w, ctx, 'hand-made', `${item.addr} already exists as ${item.id}`, before);
        break;
      }
      case 'forces-replace':
        w.config.resources[item.addr].attrs[item.attr] = item.value;
        openEvent(w, ctx, 'forces-replace', `${item.addr}: ${item.attr} = ${quote(item.value)}`, before);
        break;
      case 'lock-active':
        if (w.stateStore !== 'remote') break; // a local state has no shared lock to hold
        w.lock = { id: item.lockId, who: item.who, op: item.op, day: ctx.ticks, expires: ctx.ticks + item.days };
        w.ci = `CI ${item.op === 'OperationTypeApply' ? 'apply' : 'plan'} job running (${item.who}).`;
        ctx.fire('lock-active', item.who);
        w.open.push({ id: 'lock-active', lock: true, targets: [] });
        break;
      case 'lock-stale':
        if (w.stateStore !== 'remote') break;
        w.lock = { id: item.lockId, who: item.who, op: item.op, day: ctx.ticks, expires: null };
        w.ci = 'No pipeline running. The last run was cancelled (runner lost).';
        ctx.fire('lock-stale', item.who);
        w.open.push({ id: 'lock-stale', lock: true, targets: [] });
        break;
      case 'state-lost':
        if (w.stateStore === 'remote') {
          ctx.fire('state-lost', 'remote state is untouched');
          ctx.resolve('state-lost');
          break;
        }
        for (const env of Object.values(w.envs)) env.state = {};
        openEvent(w, ctx, 'state-lost', 'terraform.tfstate is gone', before);
        break;
      default:
        throw new Error(`terraform sim: no handler for event "${item.event}"`);
    }
  }
  reconcile(w, ctx);
}

export const isWon = (w) => (!w.refactor || w.refactored) && w.days >= w.winTicks && !w.open.length && !w.lock && w.health >= w.minHealth && outOfSync(w).size === 0;
export const isLost = (w) => w.health < w.minHealth;
