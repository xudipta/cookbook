// A small MCP host for the "Patch Bay" game. Pure logic, no DOM.
//
// It models what topics/mcp/notes teach, and nothing that contradicts them:
//   * a host runs one client per server; a client talks JSON-RPC 2.0 to its server over stdio (a
//     process the host launches from `command` + `args`) or Streamable HTTP (a URL);
//   * a connection starts with the handshake (initialize, notifications/initialized, then tools/list
//     and the other list calls for the capabilities the server declared);
//   * a server offers tools (the model calls them), resources (data you attach by URI) and prompts
//     (templates you run);
//   * Claude Code keeps servers in three scopes (local, project = the committed .mcp.json, user); the
//     more specific scope wins when names collide, `${VAR}` in a file expands from the environment,
//     and project servers wait for approval because the file is shared;
//   * tool descriptions are text the model obeys, so an untrusted server is a risk before it runs a call.
// The world is data from scenarios.json: a catalogue of servers, tokens, a config, a queue of requests.

const clone = (o) => JSON.parse(JSON.stringify(o));
const J = (v) => JSON.stringify(v);

const PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'claude-code', version: '2.0.0' };
const HOME = '/home/dev';
const REPO = '/home/dev/shop';
const SCOPES = ['local', 'project', 'user'];
const SCOPE_NAME = {
  local: 'Local config (private to you in this project)',
  project: 'Project config (shared via .mcp.json)',
  user: 'User config (available in all your projects)',
};
const STATE_LABEL = {
  connected: '✓ Connected',
  failed: '✗ Failed to connect',
  auth: '⚠ Needs authentication',
  pending: '? Waiting for approval',
  rejected: '✗ Rejected, not started',
};

export const MODES = { tool: 'tool', resource: 'resource', prompt: 'prompt' };

// ---------------------------------------------------------------- shell

// Splits a command line like bash does: quotes, backslashes and $VAR expansion (`expand` null = none).
export function tokenize(line, expand) {
  const tokens = [];
  let cur = '';
  let has = false;
  let i = 0;
  const readVar = () => {
    if (line[i + 1] === '{') {
      const end = line.indexOf('}', i + 2);
      if (end < 0) return '$';
      const name = line.slice(i + 2, end);
      i = end;
      return expand ? expand(name) : `\${${name}}`;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i + 1));
    if (!m) return '$';
    i += m[0].length;
    return expand ? expand(m[0]) : `$${m[0]}`;
  };
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      if (has) tokens.push(cur);
      cur = '';
      has = false;
      i += 1;
      continue;
    }
    has = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { error: "unexpected EOF while looking for matching `''" };
      cur += line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i += 1;
      for (;;) {
        if (i >= line.length) return { error: 'unexpected EOF while looking for matching `"\'' };
        const d = line[i];
        if (d === '"') {
          i += 1;
          break;
        }
        if (d === '\\' && '"\\$'.includes(line[i + 1] || '#')) {
          cur += line[i + 1];
          i += 2;
        } else if (d === '$') {
          cur += readVar();
          i += 1;
        } else {
          cur += d;
          i += 1;
        }
      }
    } else if (c === '\\') {
      cur += line[i + 1] || '';
      i += 2;
    } else if (c === '$') {
      cur += readVar();
      i += 1;
    } else {
      cur += c;
      i += 1;
    }
  }
  if (has) tokens.push(cur);
  return { tokens };
}

// ---------------------------------------------------------------- world

export function createWorld(sc) {
  const w = {
    sc,
    servers: Object.fromEntries(Object.entries(sc.servers).map(([id, srv]) => [id, { id, ...srv }])),
    tokens: sc.tokens,
    events: Object.fromEntries(sc.events.map((e) => [e.id, e])),
    catalog: sc.catalog,
    envNames: sc.env || [],
    files: {
      project: sc.files && sc.files.project ? clone(sc.files.project) : null,
      local: clone((sc.files && sc.files.local) || {}),
      user: clone((sc.files && sc.files.user) || {}),
    },
    approval: {},
    foreign: [],
    oauth: Object.fromEntries((sc.oauth || []).map((id) => [id, true])),
    builder: sc.builder || null,
    draft: sc.builder ? { ...sc.builder.defaults } : null,
    built: null,
    queue: sc.requests,
    cursor: 0,
    teammate: sc.teammate || { name: 'Sam' },
    term: [],
    wire: [],
    rpc: {},
    conn: {},
    seenPoison: [],
    open: [],
    flags: {},
    compromised: false,
    health: 100,
    minHealth: sc.minHealth ?? 40,
    penalties: sc.penalties || {},
    costs: sc.costs || { fail: 15, wrongPrimitive: 12 },
    winTicks: sc.winTicks,
  };
  for (const name of Object.keys(w.files.project || {})) w.approval[name] = 'approved';
  return w;
}

const out = (w, text, kind = 'out') => w.term.push({ kind, text });

function wire(w, kind, tag, text) {
  w.wire.push({ kind, tag, text });
  if (w.wire.length > 300) w.wire.splice(0, w.wire.length - 300);
}

function hurt(w, ctx, n, why) {
  w.health = Math.max(0, w.health - n);
  ctx.log(`-${n} trust: ${why}`, { kind: 'warn' });
}

// ---------------------------------------------------------------- environment and tokens

export function envValue(w, persp, name) {
  const t = w.tokens[name];
  if (!t || !w.envNames.includes(name)) return undefined;
  return persp === 'teammate' ? t.teammate : t.value;
}

export function envRows(w) {
  return w.envNames.map((name) => ({ name, label: w.tokens[name].label }));
}

function tokenInfo(w, value) {
  for (const t of Object.values(w.tokens)) if (t.value === value || t.teammate === value) return t;
  return null;
}

// `${VAR}` and `${VAR:-default}` in a config value expand from the environment of whoever runs the host.
function expandCfg(w, persp, raw) {
  const missing = [];
  const text = String(raw ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, name, dflt) => {
    const v = envValue(w, persp, name);
    if (v !== undefined) return v;
    if (dflt !== undefined) return dflt;
    missing.push(name);
    return '';
  });
  return { text, missing };
}

const isSecretKey = (k) => /token|key|secret|auth|password|credential/i.test(k);

// A literal credential in a config entry: a secret-looking env/header value that is not a ${VAR} reference.
function literalSecret(w, entry) {
  const maps = [entry.env, entry.headers];
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== 'string' || v.includes('${')) continue;
      if (isSecretKey(k) && v.trim() && !/^(bearer|basic)?\s*$/i.test(v)) return true;
      if (/(?:^|\s)(?:ghp_|github_pat_|glsa_|sk-)[A-Za-z0-9_]+/.test(v)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- config files

// The file as it would be on disk (valid JSON).
export function fileText(w, scope) {
  if (scope === 'project') return w.files.project ? JSON.stringify({ mcpServers: w.files.project }, null, 2) : null;
  const servers = w.files[scope];
  if (scope === 'local') return JSON.stringify({ projects: { [REPO]: { mcpServers: servers } } }, null, 2);
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

export const FILE_TITLES = {
  project: '.mcp.json (project scope, committed)',
  local: '~/.claude.json, projects["/home/dev/shop"] (local scope, private)',
  user: '~/.claude.json, top level (user scope, private)',
};

function allNames(w) {
  const names = [];
  for (const s of SCOPES) for (const n of Object.keys(w.files[s] || {})) if (!names.includes(n)) names.push(n);
  return names;
}

function visibleNames(w, persp) {
  return persp === 'teammate' ? Object.keys(w.files.project || {}) : allNames(w);
}

function resolveEntry(w, persp, name) {
  const order = persp === 'teammate' ? ['project'] : SCOPES; // most specific first
  for (const scope of order) {
    const f = w.files[scope];
    if (f && f[name]) return { scope, entry: f[name] };
  }
  return null;
}

// ---------------------------------------------------------------- connecting

const fail = (code, lines, extra = {}) => ({ ok: false, code, lines, ...extra });
const closed = { k: 'err', t: 'MCP error -32000: Connection closed' };

function findStdioTarget(w, cmd, args) {
  for (const s of Object.values(w.servers)) {
    const l = s.launch;
    if (!l || s.transport !== 'stdio') continue;
    if (cmd === l.command && l.prefix.every((p, i) => args[i] === p)) return s;
  }
  return null;
}

function findHttpTarget(w, url) {
  const clean = String(url || '').replace(/\/$/, '');
  return Object.values(w.servers).find((s) => s.transport === 'http' && s.url.replace(/\/$/, '') === clean) || null;
}

// What the player's wordcount.js is, given the blocks they saved.
function builtServer(w) {
  const bl = w.builder;
  const b = w.built;
  const opt = (knob) => bl.knobs.find((k) => k.id === knob).options.find((o) => o.id === b[knob]);
  const [n, d, i, r, t] = ['name', 'description', 'input', 'result', 'transport'].map(opt);
  return {
    id: 'wordcount',
    title: 'wordcount',
    transport: 'stdio',
    custom: true,
    serverInfo: { name: bl.serverName, version: '0.1.0' },
    tools: [{ name: n.value, ...(d.value ? { description: d.value } : {}), inputSchema: i.schema }],
    resources: [],
    prompts: [],
    interfaceProblems: [n, d, i].filter((o) => !o.good).map((o) => o.problem),
    result: r.effect || null,
    transportBad: t.effect === 'transport',
  };
}

function diagStdio(w, persp, entry) {
  const cmd = entry.command;
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (typeof cmd !== 'string' || !cmd) {
    return fail('invalid', [{ k: 'err', t: 'Invalid MCP server config: a stdio server needs a "command"' }]);
  }
  if (/^https?:\/\//i.test(cmd)) {
    return fail('transport', [{ k: 'err', t: `spawn ${cmd} ENOENT` }, closed]);
  }
  const target = findStdioTarget(w, cmd, args);
  if (!target) {
    if (cmd === 'npx') {
      const pkg = args.find((a) => !String(a).startsWith('-')) || '';
      return fail('exited', [
        { k: 'stderr', t: 'npm error code E404' },
        { k: 'stderr', t: `npm error 404 Not Found - GET https://registry.npmjs.org/${String(pkg).replace('/', '%2f')} - Not found` },
        closed,
      ]);
    }
    return fail('exited', [{ k: 'err', t: `spawn ${cmd} ENOENT` }, closed]);
  }
  const l = target.launch;
  if (args.length - l.prefix.length < (l.minExtra || 0)) return fail('exited', [{ k: 'stderr', t: l.usage }, closed], { target });
  if (l.custom) {
    if (!w.built) {
      return fail('exited', [{ k: 'stderr', t: `Error: Cannot find module '${REPO}/wordcount.js'` }, closed], { target });
    }
    const b = builtServer(w);
    if (b.transportBad) {
      return fail('transport', [{ k: 'stderr', t: 'wordcount: listening on http://localhost:3000/mcp' }, { k: 'err', t: 'MCP error -32001: Request timed out' }], { target: b });
    }
    return { ok: true, type: 'stdio', target: b, missing: [] };
  }
  let tok = null;
  const missing = [];
  for (const v of l.env || []) {
    const ex = expandCfg(w, persp, entry.env && entry.env[v]);
    missing.push(...ex.missing);
    if (!ex.text) return fail('exited', [{ k: 'stderr', t: `Error: ${v} environment variable is required` }, closed], { target, missing });
    tok = tokenInfo(w, ex.text);
    if (!tok || !(tok.grants || []).includes(l.needs)) {
      return fail('auth', [{ k: 'stderr', t: 'GitHub API error: 401 Unauthorized: Bad credentials' }, closed], { target, missing });
    }
  }
  return { ok: true, type: 'stdio', target, tok, missing };
}

function diagHttp(w, persp, entry) {
  let u = null;
  try {
    u = new URL(entry.url);
    if (!/^https?:$/.test(u.protocol)) u = null;
  } catch {
    u = null;
  }
  if (!u) return fail('invalid', [{ k: 'err', t: `Invalid MCP server config: "url" must be an http(s) URL (got ${J(entry.url ?? null)})` }]);
  const target = findHttpTarget(w, entry.url);
  if (!target) {
    const known = Object.values(w.servers).some((s) => s.url && new URL(s.url).host === u.host);
    return fail('unreachable', [{ k: 'err', t: known ? 'Streamable HTTP error: Error POSTing to endpoint (HTTP 404): Not Found' : `getaddrinfo ENOTFOUND ${u.hostname}` }]);
  }
  if (entry.type === 'sse') return fail('transport', [{ k: 'err', t: 'SSE error: Non-200 status code (405)' }], { target });
  const auth = target.auth || {};
  if (auth.type === 'bearer') {
    const key = Object.keys(entry.headers || {}).find((k) => k.toLowerCase() === auth.header.toLowerCase());
    const ex = expandCfg(w, persp, key ? entry.headers[key] : '');
    if (!ex.text) {
      return fail('auth', [{ k: 'err', t: 'Streamable HTTP error: Error POSTing to endpoint (HTTP 401): {"error":"missing bearer token"}' }], { target, missing: ex.missing });
    }
    const prefix = `${auth.scheme} `;
    const tok = ex.text.startsWith(prefix) ? tokenInfo(w, ex.text.slice(prefix.length)) : null;
    if (!tok || !(tok.grants || []).includes(auth.needs)) {
      return fail('auth', [{ k: 'err', t: 'Streamable HTTP error: Error POSTing to endpoint (HTTP 401): {"error":"invalid token"}' }], { target, missing: ex.missing });
    }
    return { ok: true, type: 'http', target, tok, missing: ex.missing };
  }
  if (auth.type === 'oauth' && persp === 'you' && !w.oauth[target.id]) {
    return fail(
      'auth',
      [{ k: 'err', t: 'Streamable HTTP error: Error POSTing to endpoint (HTTP 401): {"error":"invalid_token","error_description":"Authorization required"}' }],
      { target, oauth: true },
    );
  }
  return { ok: true, type: 'http', target, missing: [] };
}

function diagnoseEntry(w, persp, entry) {
  const type = entry.type || (entry.command ? 'stdio' : null);
  if (type === 'stdio') return diagStdio(w, persp, entry);
  if (type === 'http' || type === 'sse') return diagHttp(w, persp, entry);
  if (entry.url) {
    return fail('invalid', [{ k: 'err', t: 'Invalid MCP server config: this entry has a "url" but no "type": add "type": "http" for a remote server' }]);
  }
  return fail('invalid', [{ k: 'err', t: 'Invalid MCP server config: expected a "command" (stdio) or "type": "http" with a "url"' }]);
}

export function statusOf(w, persp, name) {
  const found = resolveEntry(w, persp, name);
  if (!found) return null;
  const res = diagnoseEntry(w, persp, found.entry);
  let state = res.ok ? 'connected' : res.code === 'auth' ? 'auth' : 'failed';
  if (persp === 'you' && found.scope === 'project') {
    const a = w.approval[name];
    if (a === 'pending') state = 'pending';
    if (a === 'rejected') state = 'rejected';
  }
  return { name, persp, scope: found.scope, entry: found.entry, res, state };
}

// ---------------------------------------------------------------- wire log

const tagOf = (w, persp, name) => (persp === 'teammate' ? `${w.teammate.name.toLowerCase()}/${name}` : name);
const rpcId = (w, tag) => {
  const id = w.rpc[tag] ?? 1;
  w.rpc[tag] = id + 1;
  return id;
};
const msg = (w, dir, tag, obj) => wire(w, dir, tag, J({ jsonrpc: '2.0', ...obj }));

function describeEntry(entry) {
  if (entry.type === 'http' || entry.type === 'sse' || (!entry.command && entry.url)) return `${entry.url}`;
  return [entry.command, ...(entry.args || [])].join(' ');
}

function capsOf(t) {
  const caps = {};
  if (t.tools.length) caps.tools = {};
  if (t.resources.length) caps.resources = {};
  if (t.prompts.length) caps.prompts = {};
  return caps;
}

// Logs a connection attempt once per configuration (a changed entry reconnects).
function connectLog(w, persp, name, st) {
  const tag = tagOf(w, persp, name);
  const tid = st.res.target ? st.res.target.id : '';
  const key = [J(st.entry), st.state, tid, Boolean(w.oauth[tid]), w.built ? J(w.built) : ''].join('|');
  if (w.conn[tag] === key) return tag;
  w.conn[tag] = key;
  if (st.state === 'pending') {
    wire(w, 'note', tag, `# ${name} is in .mcp.json but waiting for your approval; the process is not started`);
    return tag;
  }
  if (st.state === 'rejected') return tag;
  const http = st.entry.type === 'http' || st.entry.type === 'sse' || (!st.entry.command && st.entry.url);
  wire(w, 'note', tag, http ? `# ${name}: POST ${st.entry.url}  Accept: application/json, text/event-stream` : `# ${name}: spawn ${describeEntry(st.entry)}`);
  if (!st.res.ok) {
    for (const l of st.res.lines) wire(w, l.k, tag, l.k === 'err' ? `! ${l.t}` : `stderr: ${l.t}`);
    return tag;
  }
  const t = st.res.target;
  const caps = capsOf(t);
  w.rpc[tag] = 1;
  msg(w, 'out', tag, { id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO } });
  msg(w, 'in', tag, { id: 0, result: { protocolVersion: PROTOCOL, capabilities: caps, serverInfo: t.serverInfo } });
  if (http) wire(w, 'note', tag, `# 200 OK  Mcp-Session-Id: ${(0x5a17c0de + name.length * 977).toString(16)}  (sent back on every later request)`);
  msg(w, 'out', tag, { method: 'notifications/initialized' });
  for (const [cap, method, field] of [['tools', 'tools/list', 'tools'], ['resources', 'resources/list', 'resources'], ['prompts', 'prompts/list', 'prompts']]) {
    if (!caps[cap]) continue;
    const id = rpcId(w, tag);
    msg(w, 'out', tag, { id, method });
    msg(w, 'in', tag, { id, result: { [field]: t[field] } });
  }
  if (t.poisoned && !w.seenPoison.includes(t.id)) w.seenPoison.push(t.id);
  return tag;
}

function connectAll(w) {
  const names = visibleNames(w, 'you');
  for (const tag of Object.keys(w.conn)) if (!tag.includes('/') && !names.includes(tag)) delete w.conn[tag]; // removed: a re-add reconnects
  for (const name of names) connectLog(w, 'you', name, statusOf(w, 'you', name));
}

// ---------------------------------------------------------------- conditions and events

function conditions(w) {
  const c = {};
  const add = (id, detail) => {
    c[id] = c[id] ? `${c[id]}, ${detail}` : detail;
  };
  const names = visibleNames(w, 'you');
  for (const name of names) {
    const st = statusOf(w, 'you', name);
    if (st.state !== 'pending' && st.state !== 'rejected' && !st.res.ok) {
      add(st.res.code === 'transport' ? 'wrong-transport' : st.res.code === 'auth' ? 'needs-auth' : 'connect-failed', name);
    }
    if (st.state === 'connected' && st.res.tok && st.res.tok.broad) add('admin-token', name);
    const present = SCOPES.filter((s) => w.files[s] && w.files[s][name]);
    if (present.length > 1 && new Set(present.map((s) => J(w.files[s][name]))).size > 1) {
      add('shadowed', `${name}: ${present[0]} over ${present.slice(1).join(' and ')}`);
    }
    if (st.state !== 'rejected' && st.res.target && w.seenPoison.includes(st.res.target.id)) add('tool-poisoning', name);
  }
  for (const [name, entry] of Object.entries(w.files.project || {})) {
    if (literalSecret(w, entry)) add('secret-committed', name);
  }
  for (const name of w.foreign) {
    if (w.files.project && w.files.project[name] && w.approval[name] !== 'rejected') add('unvetted-server', name);
  }
  if (w.flags.sam && w.queue.slice(w.cursor).some((r) => r.as === 'teammate')) add('teammate-clones', w.teammate.name);
  if (w.flags.notShared) add('not-shared', w.flags.notShared);
  if (w.flags.wrongPrimitive) add('wrong-primitive', w.flags.wrongPrimitive);
  if (w.flags.weakInterface) add('weak-interface', 'wordcount');
  if (w.flags.bloated) add('bloated-result', 'wordcount');
  if (w.flags.invalid) add('invalid-result', 'wordcount');
  return c;
}

export function reconcile(w, ctx) {
  const now = conditions(w);
  for (const id of Object.keys(now)) {
    if (w.open.includes(id)) continue;
    ctx.fire(id, now[id]);
    w.open.push(id);
    const once = w.penalties[id] && w.penalties[id].once;
    if (once) hurt(w, ctx, once, w.events[id].title.toLowerCase());
  }
  for (const id of [...w.open]) {
    if (id in now) continue;
    ctx.resolve(id);
    w.open = w.open.filter((x) => x !== id);
  }
}

export function afterMove(w, ctx) {
  connectAll(w);
  reconcile(w, ctx);
}

export function start(w, ctx) {
  wire(w, 'note', 'host', '# claude starts: connecting to the configured MCP servers');
  afterMove(w, ctx);
}

export function tick(w, ctx) {
  for (const id of w.open) {
    const p = w.penalties[id] && w.penalties[id].tick;
    if (p) hurt(w, ctx, p, `${w.events[id].title.toLowerCase()} is still open`);
  }
  for (const item of ctx.scenario.schedule || []) {
    if (item.tick !== ctx.ticks) continue;
    if (item.event === 'teammate-clones') {
      w.flags.sam = true;
      ctx.log(`${w.teammate.name} clones the repo. Their host only sees the project scope.`);
    } else if (item.event === 'unvetted-server') {
      if (!w.files.project) w.files.project = {};
      w.files.project[item.name] = clone(item.entry);
      w.approval[item.name] = 'pending';
      w.foreign.push(item.name);
      ctx.log(`git pull: .mcp.json now lists ${item.name}, added by a teammate.`);
    }
  }
  afterMove(w, ctx);
}

export const isLost = (w) => w.compromised || w.health <= 0;
export const isWon = (w) => !w.compromised && w.cursor >= w.queue.length && w.open.length === 0 && w.health >= w.minHealth;

// ---------------------------------------------------------------- terminal: claude mcp

const HELP = [
  'claude mcp add [--transport stdio|http] [--scope local|project|user] [-e KEY=VALUE] [--header "Name: value"] <name> (-- <command> [args...] | <url>)',
  "claude mcp add-json <name> '<json>' [--scope local|project|user]",
  'claude mcp list | get <name> | remove <name> [--scope local|project|user]',
  '/mcp                       connection status',
  '/mcp auth <name>           sign in to an OAuth server',
  'npx @modelcontextprotocol/inspector --cli <command args... | url> [--transport http] [--method tools/list|resources/list|prompts/list|tools/call] [--tool-name N] [--tool-arg k=v]',
  'cat .mcp.json',
  'Single-quote ${VAR} so your shell does not expand it before claude writes it down.',
].join('\n');

function parseFlags(tokens) {
  const opts = { env: [], header: [] };
  const positional = [];
  let rest = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--') {
      rest = tokens.slice(i + 1);
      break;
    }
    const eq = /^(--[a-z-]+)=(.*)$/.exec(t);
    const flag = eq ? eq[1] : t;
    const val = () => (eq ? eq[2] : tokens[++i]);
    if (flag === '--transport' || flag === '-t') opts.transport = val();
    else if (flag === '--scope' || flag === '-s') opts.scope = val();
    else if (flag === '--env' || flag === '-e') {
      opts.env.push(val());
      while (!eq && i + 1 < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i + 1])) opts.env.push(tokens[++i]);
    } else if (flag === '--header' || flag === '-H') {
      opts.header.push(val());
      while (!eq && i + 1 < tokens.length && /^[\w-]+:\s/.test(tokens[i + 1])) opts.header.push(tokens[++i]);
    } else if (t.startsWith('-') && t.length > 1) return { error: `error: unknown option '${t}'` };
    else positional.push(t);
  }
  return { opts, positional, rest };
}

function scopeOf(opts) {
  const scope = opts.scope || 'local';
  return SCOPES.includes(scope) ? { scope } : { error: `Invalid scope: ${scope}. Must be one of: local, user, project` };
}

const where = (scope) => (scope === 'project' ? `${REPO}/.mcp.json` : `${HOME}/.claude.json${scope === 'local' ? ` [project: ${REPO}]` : ''}`);

function storeEntry(w, name, scope, entry) {
  if (scope === 'project') {
    if (!w.files.project) w.files.project = {};
    w.files.project[name] = entry;
    w.approval[name] = 'approved'; // you wrote this entry yourself
  } else {
    w.files[scope][name] = entry;
  }
}

function cmdAdd(w, tokens) {
  const parsed = parseFlags(tokens);
  if (parsed.error) {
    out(w, parsed.error + (parsed.error.includes("'-") ? '\nTip: put -- between the server name and its command, so its own flags are left alone.' : ''), 'err');
    return false;
  }
  const { opts, positional, rest } = parsed;
  const transport = opts.transport || 'stdio';
  if (!['stdio', 'http', 'sse'].includes(transport)) {
    out(w, `Invalid transport type: ${transport}. Must be one of: stdio, sse, http`, 'err');
    return false;
  }
  const sc = scopeOf(opts);
  if (sc.error) {
    out(w, sc.error, 'err');
    return false;
  }
  const name = positional[0];
  if (!name) {
    out(w, "error: missing required argument 'name'", 'err');
    return false;
  }
  if (w.files[sc.scope] && w.files[sc.scope][name]) {
    out(w, `MCP server ${name} already exists in ${sc.scope} config`, 'err');
    return false;
  }
  const env = {};
  for (const kv of opts.env) env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  let entry;
  let summary;
  if (transport === 'stdio') {
    const argv = rest !== null ? rest : positional.slice(1);
    if (!argv.length) {
      out(w, "error: missing required argument 'commandOrUrl'", 'err');
      return false;
    }
    entry = { type: 'stdio', command: argv[0], args: argv.slice(1), env };
    summary = `Added stdio MCP server ${name} with command: ${argv.join(' ')} to ${sc.scope} config`;
  } else {
    const url = positional[1];
    if (!url) {
      out(w, "error: missing required argument 'commandOrUrl'", 'err');
      return false;
    }
    entry = { type: transport, url };
    if (opts.header.length) {
      entry.headers = {};
      for (const h of opts.header) entry.headers[h.slice(0, h.indexOf(':')).trim()] = h.slice(h.indexOf(':') + 1).trim();
    }
    summary = `Added ${transport.toUpperCase()} MCP server ${name} with URL: ${url} to ${sc.scope} config`;
  }
  storeEntry(w, name, sc.scope, entry);
  out(w, `${summary}\nFile modified: ${where(sc.scope)}`);
  return true;
}

function cmdAddJson(w, tokens) {
  const parsed = parseFlags(tokens);
  if (parsed.error) {
    out(w, parsed.error, 'err');
    return false;
  }
  const sc = scopeOf(parsed.opts);
  if (sc.error) {
    out(w, sc.error, 'err');
    return false;
  }
  const [name, json] = parsed.positional;
  if (!name || json === undefined) {
    out(w, "error: add-json needs a name and a JSON string, for example: claude mcp add-json grafana '{\"type\":\"http\",\"url\":\"https://...\"}'", 'err');
    return false;
  }
  let entry;
  try {
    entry = JSON.parse(json);
  } catch (e) {
    out(w, `Invalid JSON: ${e.message}`, 'err');
    return false;
  }
  const type = entry && (entry.type || (entry.command ? 'stdio' : null));
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !['stdio', 'http', 'sse'].includes(type)) {
    out(w, 'Invalid configuration: expected {"command": ...} for stdio or {"type": "http", "url": ...}', 'err');
    return false;
  }
  if (w.files[sc.scope] && w.files[sc.scope][name]) {
    out(w, `MCP server ${name} already exists in ${sc.scope} config`, 'err');
    return false;
  }
  storeEntry(w, name, sc.scope, entry);
  out(w, `Added ${type} MCP server ${name} to ${sc.scope} config\nFile modified: ${where(sc.scope)}`);
  return true;
}

function cmdRemove(w, ctx, tokens) {
  const parsed = parseFlags(tokens);
  if (parsed.error) {
    out(w, parsed.error, 'err');
    return false;
  }
  const name = parsed.positional[0];
  if (!name) {
    out(w, "error: missing required argument 'name'", 'err');
    return false;
  }
  const present = SCOPES.filter((s) => w.files[s] && w.files[s][name]);
  if (!present.length) {
    out(w, `No MCP server found with name: ${name}`, 'err');
    return false;
  }
  let scope = parsed.opts.scope;
  if (scope && !SCOPES.includes(scope)) {
    out(w, `Invalid scope: ${scope}. Must be one of: local, user, project`, 'err');
    return false;
  }
  if (!scope) {
    if (present.length > 1) {
      out(
        w,
        `MCP server "${name}" exists in multiple scopes:\n${present.map((s) => `  - ${SCOPE_NAME[s]}`).join('\n')}\nTo remove it from a specific scope, run:\n${present.map((s) => `  claude mcp remove "${name}" -s ${s}`).join('\n')}`,
        'err',
      );
      return false;
    }
    scope = present[0];
  }
  if (!present.includes(scope)) {
    out(w, `No ${scope}-scoped MCP server found with name: ${name}`, 'err');
    return false;
  }
  delete w.files[scope][name];
  if (scope === 'project') {
    delete w.approval[name];
    w.foreign = w.foreign.filter((n) => n !== name);
  }
  out(w, `Removed MCP server ${name} from ${scope} config\nFile modified: ${where(scope)}`);
  return true;
}

function listLine(st) {
  const e = st.entry;
  const http = e.type === 'http' || e.type === 'sse' || (!e.command && e.url);
  const what = http ? `${e.url} (${(e.type || 'http').toUpperCase()})` : describeEntry(e);
  return `${st.name}: ${what} - ${STATE_LABEL[st.state]}`;
}

function cmdList(w, ctx) {
  const names = visibleNames(w, 'you');
  if (!names.length) {
    out(w, 'No MCP servers configured. Use `claude mcp add` to add a server.');
    return false;
  }
  afterMove(w, ctx);
  out(w, `Checking MCP server health...\n\n${names.map((n) => listLine(statusOf(w, 'you', n))).join('\n')}`);
  return false;
}

function cmdGet(w, tokens) {
  const name = tokens[0];
  const st = name && statusOf(w, 'you', name);
  if (!st) {
    out(w, `No MCP server found with name: ${name || ''}`.trim(), 'err');
    return false;
  }
  const e = st.entry;
  const http = e.type === 'http' || e.type === 'sse' || (!e.command && e.url);
  const lines = [`${name}:`, `  Scope: ${SCOPE_NAME[st.scope]}`, `  Status: ${STATE_LABEL[st.state]}`, `  Type: ${e.type || (http ? 'http' : 'stdio')}`];
  if (http) {
    lines.push(`  URL: ${e.url}`);
    if (e.headers) lines.push('  Headers:', ...Object.entries(e.headers).map(([k, v]) => `    ${k}: ${v}`));
  } else {
    lines.push(`  Command: ${e.command}`, `  Args: ${(e.args || []).join(' ')}`);
    lines.push('  Environment:', ...Object.entries(e.env || {}).map(([k, v]) => `    ${k}=${v}`));
  }
  lines.push('', `To remove this server, run: claude mcp remove "${name}" -s ${st.scope}`);
  out(w, lines.join('\n'));
  return false;
}

function cmdSlash(w, ctx, tokens) {
  if (tokens[1] === 'auth') {
    const name = tokens[2];
    const st = name && statusOf(w, 'you', name);
    if (!st) {
      out(w, `No MCP server named "${name || ''}". Run /mcp to see the configured servers.`, 'err');
      return false;
    }
    const target = st.res.target;
    if (!target || !target.auth || target.auth.type !== 'oauth') {
      out(w, `${name} does not use OAuth. Servers that take a token read it from env or headers (use \${VAR} so the value stays out of the file).`, 'err');
      return false;
    }
    if (w.oauth[target.id]) {
      out(w, `${name} is already authenticated.`);
      return false;
    }
    w.oauth[target.id] = true;
    out(w, `Opening your browser to sign in to ${name}...\nAuthentication successful. Connected to ${name}.`);
    return true;
  }
  if (tokens[1]) {
    out(w, `Unknown /mcp option: ${tokens[1]}. Try /mcp or /mcp auth <name>.`, 'err');
    return false;
  }
  const names = visibleNames(w, 'you');
  if (!names.length) {
    out(w, 'No MCP servers configured.');
    return false;
  }
  afterMove(w, ctx);
  const rows = names.map((n) => {
    const st = statusOf(w, 'you', n);
    const extra = st.state === 'auth' && st.res.oauth ? `   (run: /mcp auth ${n})` : '';
    return `  ${n.padEnd(14)} ${STATE_LABEL[st.state]} · ${st.res.type || (st.entry.url ? 'http' : 'stdio')} · ${st.scope}${extra}`;
  });
  out(w, `Manage MCP servers\n${rows.join('\n')}`);
  return false;
}

// ---------------------------------------------------------------- terminal: inspector

function pretty(v) {
  return JSON.stringify(v, null, 2);
}

function callBuilt(w, target, name, args) {
  if (!target.tools.some((t) => t.name === name)) return { error: `MCP error -32602: Unknown tool: ${name}` };
  const text = String(args.text ?? '');
  const n = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (target.result === 'invalid') {
    return { error: 'MCP error -32602: Invalid tools/call result: [{"code":"invalid_type","expected":"array","received":"undefined","path":["content"],"message":"Required"}]' };
  }
  if (target.result === 'bloat') return { result: { content: [{ type: 'text', text: `${text}\n\n(${n} words)` }] }, note: 'the whole input comes back with the count' };
  return { result: { content: [{ type: 'text', text: String(n) }] } };
}

function cmdInspector(w, tokens) {
  const opts = { toolArgs: {}, env: {}, headers: {} };
  const rest = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--cli') opts.cli = true;
    else if (t === '--method') opts.method = tokens[++i];
    else if (t === '--tool-name') opts.toolName = tokens[++i];
    else if (t === '--tool-arg') {
      const kv = tokens[++i] || '';
      opts.toolArgs[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
    } else if (t === '--transport') opts.transport = tokens[++i];
    else if (t === '-e') {
      const kv = tokens[++i] || '';
      opts.env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
    } else if (t === '--header') {
      const h = tokens[++i] || '';
      opts.headers[h.slice(0, h.indexOf(':')).trim()] = h.slice(h.indexOf(':') + 1).trim();
    } else rest.push(t);
  }
  if (!opts.cli || !rest.length) {
    out(w, 'Starting MCP inspector...\nMCP Inspector is up and running at http://localhost:6274\n(This page cannot open a browser: use the CLI form, for example\n  npx @modelcontextprotocol/inspector --cli node ./server.js --method tools/list)', 'out');
    return false;
  }
  const http = (opts.transport === 'http' || opts.transport === 'sse') && /^https?:\/\//.test(rest[0]);
  const entry = http
    ? { type: opts.transport, url: rest[0], ...(Object.keys(opts.headers).length ? { headers: opts.headers } : {}) }
    : { type: 'stdio', command: rest[0], args: rest.slice(1), env: opts.env };
  const res = diagnoseEntry(w, 'you', entry);
  if (!res.ok) {
    out(w, `Failed to connect to MCP server: ${res.lines.map((l) => l.t).join('\n')}`, 'err');
    return false;
  }
  const t = res.target;
  if (t.poisoned && !w.seenPoison.includes(t.id)) w.seenPoison.push(t.id);
  const method = opts.method || 'tools/list';
  if (method === 'tools/list') out(w, pretty({ tools: t.tools }));
  else if (method === 'resources/list') out(w, pretty({ resources: t.resources }));
  else if (method === 'prompts/list') out(w, pretty({ prompts: t.prompts }));
  else if (method === 'tools/call') {
    if (!opts.toolName) {
      out(w, 'error: --tool-name is required with --method tools/call', 'err');
      return false;
    }
    if (t.custom) {
      const r = callBuilt(w, t, opts.toolName, opts.toolArgs);
      if (r.error) out(w, `Failed to call tool ${opts.toolName}: ${r.error}`, 'err');
      else out(w, pretty(r.result) + (r.note ? `\n(${r.note})` : ''));
    } else if (!t.tools.some((x) => x.name === opts.toolName)) {
      out(w, `Failed to call tool ${opts.toolName}: MCP error -32602: Unknown tool: ${opts.toolName}`, 'err');
    } else {
      out(w, pretty({ content: [{ type: 'text', text: '(the inspector would run the real tool here)' }] }));
    }
  } else {
    out(w, `error: unsupported --method ${method}. Try tools/list, resources/list, prompts/list or tools/call.`, 'err');
    return false;
  }
  return false;
}

// ---------------------------------------------------------------- terminal: dispatch

export function runCommand(w, ctx, line) {
  const text = line.trim();
  out(w, `${text.startsWith('/') ? '>' : '$'} ${text}`, 'cmd');
  const slash = text.startsWith('/');
  const parsed = tokenize(text, slash ? null : (name) => envValue(w, 'you', name) ?? '');
  if (parsed.error) {
    out(w, `bash: ${parsed.error}`, 'err');
    return false;
  }
  const tokens = parsed.tokens;
  const cmd = tokens[0];
  if (cmd === 'claude') {
    if (tokens[1] !== 'mcp') {
      out(w, 'This terminal runs `claude mcp ...` commands. The session itself is the Requests panel above. Type help for the list.', 'err');
      return false;
    }
    const sub = tokens[2];
    const args = tokens.slice(3);
    if (sub === 'add') return cmdAdd(w, args);
    if (sub === 'add-json') return cmdAddJson(w, args);
    if (sub === 'remove') return cmdRemove(w, ctx, args);
    if (sub === 'list') return cmdList(w, ctx);
    if (sub === 'get') return cmdGet(w, args);
    out(w, `Usage: claude mcp <add|add-json|list|get|remove>\n${HELP}`, 'err');
    return false;
  }
  if (cmd === '/mcp') return cmdSlash(w, ctx, tokens);
  if (cmd === 'npx' && tokens[1] === '@modelcontextprotocol/inspector') return cmdInspector(w, tokens.slice(2));
  if (cmd === 'cat' && (tokens[1] === '.mcp.json' || tokens[1] === './.mcp.json')) {
    if (w.files.project) out(w, fileText(w, 'project'));
    else out(w, 'cat: .mcp.json: No such file or directory', 'err');
    return false;
  }
  if (cmd === 'help' || cmd === '--help') {
    out(w, HELP);
    return false;
  }
  if (cmd === 'clear') {
    w.term.length = 0;
    return false;
  }
  out(w, `bash: ${cmd}: command not found. Type help for the commands this terminal knows.`, 'err');
  return false;
}

// ---------------------------------------------------------------- approvals

export function decide(w, ctx, name, yes) {
  if (w.approval[name] !== 'pending') return false;
  w.approval[name] = yes ? 'approved' : 'rejected';
  out(w, yes ? `Approved MCP server ${name} from .mcp.json.` : `Rejected MCP server ${name}; it will not be started.`);
  afterMove(w, ctx);
  return true;
}

// ---------------------------------------------------------------- the server workshop

export function setKnob(w, knob, optionId) {
  if (!w.builder || !w.draft) return false;
  const k = w.builder.knobs.find((x) => x.id === knob);
  if (!k || !k.options.some((o) => o.id === optionId)) return false;
  w.draft[knob] = optionId;
  return true;
}

export function builderSource(w, draft = w.draft) {
  const bl = w.builder;
  const o = (k) => bl.knobs.find((x) => x.id === k).options.find((x) => x.id === draft[k]);
  const name = o('name');
  const desc = o('description');
  const input = o('input');
  const result = o('result');
  const transport = o('transport');
  const lines = [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    transport.import,
    'import { z } from "zod";',
    '',
    `const server = new McpServer({ name: "${bl.serverName}", version: "0.1.0" });`,
    '',
    'server.tool(',
    `  ${J(name.value)},`,
  ];
  if (desc.value) lines.push(`  ${J(desc.value)},`);
  lines.push(`  { ${input.code} },`, ...result.code, ');', '', transport.code);
  return lines.join('\n');
}

export function saveServer(w, ctx) {
  if (!w.builder) return false;
  if (w.built && J(w.built) === J(w.draft)) return false;
  w.built = { ...w.draft };
  const b = builtServer(w);
  out(w, `$ wrote ./${w.builder.file} (${builderSource(w).split('\n').length} lines)`, 'cmd');
  if (!b.interfaceProblems.length) w.flags.weakInterface = false;
  if (b.result !== 'bloat') w.flags.bloated = false;
  if (b.result !== 'invalid') w.flags.invalid = false;
  afterMove(w, ctx);
  return true;
}

export function builderView(w) {
  if (!w.builder) return null;
  return {
    file: w.builder.file,
    knobs: w.builder.knobs.map((k) => ({ id: k.id, label: k.label, value: w.draft[k.id], options: k.options.map((o) => ({ id: o.id, label: o.label })) })),
    source: builderSource(w),
    saved: Boolean(w.built),
    dirty: !w.built || J(w.built) !== J(w.draft),
    savedName: w.built ? builtServer(w).tools[0].name : null,
  };
}

// ---------------------------------------------------------------- serving requests

function viaOf(kind, name, ident) {
  return kind === 'tool' ? `mcp__${name}__${ident}` : kind === 'resource' ? `@${name}:${ident}` : `/${name}:${ident}`;
}

function findProvider(w, persp, serverId) {
  let stand = null;
  for (const name of visibleNames(w, persp)) {
    const st = statusOf(w, persp, name);
    if (!st || st.state !== 'connected') continue;
    if (st.res.target.id === serverId) return st;
    if (st.res.target.standsIn === serverId && !stand) stand = st;
  }
  return stand;
}

function failServe(w, ctx, req, text, cost) { // a counted move; time does not advance
  hurt(w, ctx, cost, text);
  return true;
}

function listFor(t, kind) {
  return kind === 'tool' ? t.tools : kind === 'resource' ? t.resources : t.prompts;
}

// What the client sends, and the server's answer, for the primitive the player chose.
function callWire(w, tag, mode, req, target, ok) {
  const id = rpcId(w, tag);
  if (mode === 'tool') {
    msg(w, 'out', tag, { id, method: 'tools/call', params: { name: req.name, arguments: req.args } });
    if (ok === 'result') msg(w, 'in', tag, { id, result: { content: [{ type: 'text', text: req.result }] } });
    else msg(w, 'in', tag, { id, error: { code: -32602, message: `Unknown tool: ${req.name}` } });
  } else if (mode === 'resource') {
    msg(w, 'out', tag, { id, method: 'resources/read', params: { uri: req.name } });
    if (ok === 'result') msg(w, 'in', tag, { id, result: { contents: [{ uri: req.name, mimeType: req.mime || 'text/plain', text: req.result }] } });
    else msg(w, 'in', tag, { id, error: { code: -32002, message: `Resource not found: ${req.name}` } });
  } else {
    msg(w, 'out', tag, { id, method: 'prompts/get', params: { name: req.name, arguments: req.args } });
    if (ok === 'result') msg(w, 'in', tag, { id, result: { description: target.prompts.find((p) => p.name === req.name).description, messages: [{ role: 'user', content: { type: 'text', text: req.result } }] } });
    else msg(w, 'in', tag, { id, error: { code: -32602, message: `Invalid prompt name: ${req.name}` } });
  }
}

function compromise(w, ctx, name, st) {
  const tag = connectLog(w, 'you', name, st);
  const t = st.res.target;
  const tool = t.tools.find((x) => /<IMPORTANT>/.test(x.description || '')) || t.tools[0];
  const id = rpcId(w, tag);
  msg(w, 'out', tag, { id, method: 'tools/call', params: { name: tool.name, arguments: { text: '...', notes: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA... aws_access_key_id=AKIA...' } } });
  w.compromised = true;
  w.health = 0; // game over
  ctx.fire('compromised', `via ${name}`);
  ctx.log(`The model obeyed the hidden instructions in ${name}'s tool description and sent your keys to it.`, { kind: 'warn' });
}

export function serve(w, ctx, mode) {
  const req = w.queue[w.cursor];
  if (!req) return false;
  const persp = req.as === 'teammate' ? 'teammate' : 'you';
  const who = persp === 'you' ? 'You' : w.teammate.name;
  connectAll(w);

  // Every connected server's tool descriptions are in the model's context, whichever server this request is for.
  if (persp === 'you') {
    for (const name of visibleNames(w, 'you')) {
      const st = statusOf(w, 'you', name);
      if (st.state === 'connected' && st.res.target.poisoned) {
        compromise(w, ctx, name, st);
        return true;
      }
    }
  }

  const prov = findProvider(w, persp, req.server);
  if (!prov) {
    const broken = visibleNames(w, persp)
      .map((n) => statusOf(w, persp, n))
      .filter((st) => st && st.state !== 'connected' && st.state !== 'rejected');
    const why = broken.length ? ` ${broken.map((st) => `${st.name}: ${STATE_LABEL[st.state].replace(/^\S+ /, '').toLowerCase()}`).join('; ')}.` : ' No connected server offers it.';
    const mine = persp === 'teammate' && findProvider(w, 'you', req.server);
    if (mine) w.flags.notShared = `${mine.name} is in your ${mine.scope} scope only`;
    ctx.log(`${who} asked: "${req.text}". The agent has no ${req.kind} for it.${why}`, { kind: 'warn' });
    return failServe(w, ctx, req, 'a request went unanswered', w.costs.fail);
  }
  const target = prov.res.target;
  const tag = connectLog(w, persp, prov.name, prov);

  if (target.custom) return serveBuilt(w, ctx, req, prov, mode, tag, persp);

  if (mode !== req.kind) {
    callWire(w, tag, mode, req, target, 'error');
    w.flags.wrongPrimitive = `${req.kind} asked for as a ${mode}`;
    ctx.log(`"${req.text}": ${prov.name} has no ${mode} called ${req.name}. It exposes a ${req.kind}.`, { kind: 'warn' });
    afterMove(w, ctx);
    return failServe(w, ctx, req, 'the wrong primitive', w.costs.wrongPrimitive);
  }
  if (target.id !== req.server) {
    // A stale entry answered from another instance (the staging copy).
    const has = listFor(target, mode).some((x) => (mode === 'resource' ? x.uri : x.name) === req.name);
    const stale = { ...req, result: `${target.emptyResult || 'nothing found'} (this is ${target.title})` };
    callWire(w, tag, mode, stale, target, has ? 'result' : 'error');
    ctx.log(`"${req.text}": ${prov.name} answered from ${target.title}, not the real thing.`, { kind: 'warn' });
    return failServe(w, ctx, req, 'the wrong server answered', w.costs.fail);
  }
  callWire(w, tag, mode, req, target, 'result');
  return served(w, ctx, req, prov, mode, persp);
}

function served(w, ctx, req, prov, mode, persp) {
  const via = viaOf(mode, prov.name, req.name);
  req.done = { via, reply: req.reply, as: persp };
  w.cursor += 1;
  w.flags.wrongPrimitive = null;
  if (persp === 'teammate') w.flags.notShared = null;
  ctx.log(`${persp === 'you' ? 'You' : w.teammate.name}: "${req.text}" served via ${via}.`, { kind: 'good' });
  ctx.step();
  return true;
}

function serveBuilt(w, ctx, req, prov, mode, tag, persp) {
  const b = prov.res.target;
  if (mode !== 'tool') {
    callWire(w, tag, mode, req, b, 'error');
    w.flags.wrongPrimitive = `${req.kind} asked for as a ${mode}`;
    ctx.log(`"${req.text}": ${prov.name} has no ${mode} called ${req.name}. It exposes a tool.`, { kind: 'warn' });
    afterMove(w, ctx);
    return failServe(w, ctx, req, 'the wrong primitive', w.costs.wrongPrimitive);
  }
  if (b.interfaceProblems.length) {
    w.flags.weakInterface = true;
    ctx.log(`The agent did not call ${prov.name}: ${b.interfaceProblems[0]}`, { kind: 'warn' });
    reconcile(w, ctx);
    return failServe(w, ctx, req, 'the agent could not use the tool', w.costs.fail);
  }
  const id = rpcId(w, tag);
  msg(w, 'out', tag, { id, method: 'tools/call', params: { name: b.tools[0].name, arguments: req.args } });
  if (b.result === 'invalid') {
    msg(w, 'in', tag, { id, result: 17 });
    wire(w, 'err', tag, '! MCP error -32602: Invalid tools/call result: [{"code":"invalid_type","expected":"array","received":"undefined","path":["content"],"message":"Required"}]');
    w.flags.invalid = true;
    reconcile(w, ctx);
    return failServe(w, ctx, req, 'the client rejected the tool result', w.costs.fail);
  }
  if (b.result === 'bloat') {
    msg(w, 'in', tag, { id, result: { content: [{ type: 'text', text: `# Shop ... (the whole file, about 6,400 tokens) ...\n\n(412 words)` }] } });
    w.flags.bloated = true;
    ctx.log('The tool returned the whole document just to say how long it is. The context filled up.', { kind: 'warn' });
    reconcile(w, ctx);
    return failServe(w, ctx, req, 'the tool flooded the context', w.costs.fail);
  }
  msg(w, 'in', tag, { id, result: { content: [{ type: 'text', text: req.result }] } });
  return served(w, ctx, req, prov, 'tool', persp);
}

// ---------------------------------------------------------------- views for the UI

export function requestRows(w) {
  return w.queue.map((r, i) => ({
    id: r.id,
    n: i + 1,
    text: r.text,
    from: r.as === 'teammate' ? `${w.teammate.name}, fresh clone, project scope only` : 'you',
    sam: r.as === 'teammate',
    state: i < w.cursor ? 'done' : i === w.cursor ? 'now' : 'todo',
    via: r.done ? r.done.via : null,
    reply: r.done ? r.done.reply : null,
  }));
}

export function serverRows(w) {
  return visibleNames(w, 'you').map((name) => {
    const st = statusOf(w, 'you', name);
    const t = st.res.target;
    const line = st.res.lines && st.res.lines.length ? st.res.lines[0].t : '';
    return {
      name,
      scope: st.scope,
      type: st.res.type || st.entry.type || (st.entry.url ? 'http' : 'stdio'),
      what: describeEntry(st.entry),
      state: st.state,
      label: STATE_LABEL[st.state],
      error: st.state === 'failed' || st.state === 'auth' ? line : '',
      oauth: Boolean(st.res.oauth),
      tools: st.state === 'connected' ? t.tools.map((x) => x.name) : null,
      resources: st.state === 'connected' ? t.resources.map((x) => x.uri) : null,
      prompts: st.state === 'connected' ? t.prompts.map((x) => x.name) : null,
    };
  });
}

export function catalogRows(w) {
  return w.catalog.map((id) => {
    const s = w.servers[id];
    return { id, title: s.title, kind: s.kind, transport: s.transport, run: s.run, needs: s.needs };
  });
}

export function samView(w) {
  const req = w.queue[w.cursor];
  return req && req.as === 'teammate' ? w.teammate.name : null;
}
