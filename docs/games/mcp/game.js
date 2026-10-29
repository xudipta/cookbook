// "Patch Bay": wire an AI host to MCP servers with `claude mcp` commands, watch the JSON-RPC go by, and
// keep a rogue server out. The simulation is in sim.js (DOM-free); this file is the panes, the terminal
// and the registerGame wiring. The game is turn-based: a request is served only when you press a button.
import { registerGame } from '../shared/engine.js';
import { createPrompt } from '../shared/prompt.js';
import { el } from '../shared/ui.js';
import {
  afterMove,
  builderView,
  catalogRows,
  createWorld,
  decide,
  envRows,
  FILE_TITLES,
  fileText,
  isLost as simIsLost,
  isWon as simIsWon,
  nextWords,
  requestRows,
  runCommand,
  saveServer as simSaveServer,
  serve,
  serverRows,
  setKnob as simSetKnob,
  start,
  tick as simTick,
} from './sim.js';

// ---------------------------------------------------------------- panes

function statusStrip(w) {
  const rows = serverRows(w);
  const up = rows.filter((r) => r.state === 'connected').length;
  const now = w.queue[w.cursor];
  const item = (label, value) => el('span', { class: 'mc-fact' }, el('span', { class: 'mc-fact-label', text: label }), el('strong', { text: value }));
  return [
    item('Host', 'Claude Code'),
    item('Clients', `${up} connected of ${rows.length} configured`),
    item('Serving', now ? (now.as === 'teammate' ? `${w.teammate.name}, fresh clone` : 'you') : 'nobody, queue empty'),
  ];
}

function requestPane(w) {
  return requestRows(w).map((r) =>
    el(
      'div',
      { class: 'mc-item mc-req', role: 'listitem', 'data-state': r.state },
      el('span', { class: 'mc-n', 'aria-hidden': 'true', text: String(r.n) }),
      el(
        'div',
        { class: 'mc-req-body' },
        el('strong', { text: r.text }),
        el('span', { class: 'mc-state', text: r.state === 'done' ? `✓ ${r.sam ? "Sam: " : ""}served via ${r.via}: ${r.reply}` : `${r.state === 'now' ? '▶ next' : 'waiting'}${r.sam ? ` · from ${r.from}` : ''}` }),
      ),
    ),
  );
}

function serverPane(w, ctx) {
  const rows = serverRows(w);
  if (!rows.length) return [el('p', { class: 'mc-empty', role: 'listitem', text: 'No servers wired yet. Add one with claude mcp add.' })];
  let client = 0;
  return rows.map((r) => {
    const list = (label, items) => el('span', { class: 'mc-prim' }, el('span', { class: 'mc-fact-label', text: label }), el('code', { text: items.length ? items.join(', ') : 'none' }));
    const card = el(
      'div',
      { class: 'mc-item mc-card', role: 'listitem', 'data-state': r.state },
      el('div', { class: 'mc-card-head' }, el('strong', { class: 'mc-name', text: r.name }), el('span', { class: 'mc-tag', text: r.scope }), el('span', { class: 'mc-tag', text: r.type })),
      el('span', { class: 'mc-status', text: r.label }),
      el('code', { class: 'mc-what', text: r.what }),
    );
    if (r.state === 'connected') {
      client += 1;
      card.append(el('span', { class: 'mc-sub', text: `client ${client} ⇄ ${r.name}` }), list('tools', r.tools));
      if (r.resources.length) card.append(list('resources', r.resources));
      if (r.prompts.length) card.append(list('prompts', r.prompts));
    }
    if (r.error) card.append(el('code', { class: 'mc-error', text: r.error }));
    if (r.oauth) card.append(el('span', { class: 'mc-sub', text: `Sign in from a session: /mcp auth ${r.name}` }));
    if (r.state === 'pending') {
      const yes = el('button', { class: 'mc-btn', type: 'button', text: 'Approve' });
      const no = el('button', { class: 'mc-btn', type: 'button', text: 'Reject' });
      yes.addEventListener('click', () => ctx.act('approve', r.name));
      no.addEventListener('click', () => ctx.act('reject', r.name));
      yes.setAttribute('aria-label', `Approve ${r.name}`);
      no.setAttribute('aria-label', `Reject ${r.name}`);
      yes.disabled = ctx.over;
      no.disabled = ctx.over;
      card.append(el('div', { class: 'mc-card-actions' }, yes, no));
    }
    return card;
  });
}

function filePane(w) {
  return ['project', 'local', 'user'].map((scope) => {
    const text = fileText(w, scope);
    const empty = scope === 'project' ? !text : !Object.keys(w.files[scope]).length;
    return el(
      'div',
      { class: 'mc-file' },
      el('span', { class: 'mc-fact-label', text: FILE_TITLES[scope] }),
      empty
        ? el('p', { class: 'mc-empty', text: scope === 'project' && !text ? 'No .mcp.json yet.' : 'No servers in this scope.' })
        : el('pre', { class: 'mc-code', tabindex: 0, 'aria-label': FILE_TITLES[scope], text }),
    );
  });
}

function catalogPane(w) {
  const servers = catalogRows(w).map((s) =>
    el(
      'div',
      { class: 'mc-item', role: 'listitem' },
      el('div', { class: 'mc-card-head' }, el('strong', { class: 'mc-name', text: s.title }), el('span', { class: 'mc-tag', text: s.kind })),
      el('code', { class: 'mc-what', text: s.run }),
      el('span', { class: 'mc-sub', text: `needs ${s.needs}` }),
    ),
  );
  const env = envRows(w).map((e) => el('div', { class: 'mc-item', role: 'listitem' }, el('code', { class: 'mc-what', text: `$${e.name}` }), el('span', { class: 'mc-sub', text: e.label })));
  return { servers, env };
}

function wireLines(w) {
  if (!w.wire.length) return [el('span', { class: 'mc-line mc-line-note', text: 'The JSON-RPC between host and servers appears here.\n' })];
  return w.wire.map((l) => {
    const text = l.kind === 'out' ? `→ ${l.tag}  ${l.text}` : l.kind === 'in' ? `← ${l.tag}  ${l.text}` : l.kind === 'note' ? l.text : `${l.tag}  ${l.text}`;
    return el('span', { class: `mc-line mc-line-${l.kind}`, text: `${text}\n` });
  });
}

function termLines(w) {
  return w.term.map((l) => el('span', { class: `mc-line mc-line-${l.kind}`, text: `${l.text}\n` }));
}

function submit(state, ctx, line) {
  const text = line.trim();
  if (!text) return;
  state.stickBottom = true;
  ctx.act('sh', text);
}

// ---------------------------------------------------------------- render

function pin(node, render) {
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  render();
  if (atBottom) node.scrollTop = node.scrollHeight;
}

function renderBuilder(state, ctx) {
  const b = state.dom.builder;
  if (!b) return;
  const view = builderView(state);
  for (const k of view.knobs) b.selects[k.id].value = k.value;
  b.source.textContent = view.source;
  b.save.textContent = view.dirty ? `Save ${view.file}` : `${view.file} saved`;
  b.save.disabled = ctx.over || !view.dirty;
  b.state.textContent = view.saved ? `${view.file}: saved, tool ${view.savedName}${view.dirty ? ' (edits not saved yet)' : ''}` : `${view.file}: not written yet`;
  for (const s of Object.values(b.selects)) s.disabled = ctx.over;
}

function render(state, ctx) {
  const d = state.dom;
  d.status.replaceChildren(...statusStrip(state));
  d.requests.replaceChildren(...requestPane(state));
  d.servers.replaceChildren(...serverPane(state, ctx));
  d.files.replaceChildren(...filePane(state));
  const cat = catalogPane(state);
  d.catalog.replaceChildren(...cat.servers);
  d.env.replaceChildren(...cat.env);
  d.envBox.hidden = !cat.env.length;
  pin(d.wire, () => d.wire.replaceChildren(...wireLines(state)));
  pin(d.term, () => d.term.replaceChildren(...(state.term.length ? termLines(state) : [el('span', { class: 'mc-line mc-line-out', text: 'Type a command below, for example: claude mcp list\n' })])));
  if (state.stickBottom) {
    d.term.scrollTop = d.term.scrollHeight;
    state.stickBottom = false;
  }
  renderBuilder(state, ctx);
  const over = ctx.over;
  d.prompt.setDisabled(over);
}

// ---------------------------------------------------------------- the game

function buildWorkshop(state, ctx) {
  const view = builderView(state);
  if (!view) return null;
  const selects = {};
  const rows = view.knobs.map((k) => {
    const id = `mc-knob-${k.id}`;
    const select = el('select', { class: 'mc-select', id }, ...k.options.map((o) => el('option', { value: o.id, text: o.label })));
    select.addEventListener('change', () => ctx.act('setKnob', k.id, select.value));
    selects[k.id] = select;
    return el('div', { class: 'mc-knob' }, el('label', { class: 'mc-fact-label', for: id, text: k.label }), select);
  });
  const source = el('pre', { class: 'mc-code', tabindex: 0, 'aria-label': `${view.file} source` });
  const save = el('button', { class: 'mc-btn', type: 'button' });
  save.addEventListener('click', () => ctx.act('saveServer'));
  const status = el('span', { class: 'mc-sub', role: 'status' });
  const panel = el(
    'section',
    { class: 'mc-panel', 'aria-label': 'Server workshop' },
    el('h4', { class: 'mc-h', text: `Build your own server (${view.file})` }),
    el('p', { class: 'mc-hint', text: 'Pick the blocks, save the file, test it with the inspector (npx @modelcontextprotocol/inspector --cli node ./wordcount.js --method tools/list), then add it with claude mcp add.' }),
    el('div', { class: 'mc-knobs' }, ...rows),
    source,
    el('div', { class: 'mc-card-actions' }, save, status),
  );
  return { panel, selects, source, save, state: status };
}

registerGame({
  id: 'mcp',
  styles: 'game.css',

  init(state, ctx) {
    Object.assign(state, createWorld(ctx.scenario));
    state.stickBottom = true;

    const status = el('div', { class: 'mc-status-strip', role: 'status', 'aria-label': 'Host, clients and who is asking' });
    const requests = el('div', { class: 'mc-list', role: 'list', 'aria-label': 'Requests' });
    const hint = el('p', { class: 'mc-hint', text: 'Tool: the model calls it (mcp__server__tool). Resource: data you attach (@server:uri). Prompt: a template you run (/server:name).' });
    const servers = el('div', { class: 'mc-list', role: 'list', 'aria-label': 'Configured servers' });
    const files = el('div', { class: 'mc-files' });
    const catalog = el('div', { class: 'mc-list', role: 'list', 'aria-label': 'Available servers' });
    const env = el('div', { class: 'mc-list', role: 'list', 'aria-label': 'Environment variables in your shell' });
    const envBox = el('div', {}, el('h4', { class: 'mc-h mc-h-sub', text: 'Your shell environment' }), env);
    const wire = el('pre', { class: 'mc-term mc-wire', tabindex: 0, role: 'log', 'aria-label': 'JSON-RPC wire log' });

    const term = el('pre', { class: 'mc-term', tabindex: 0, role: 'log', 'aria-label': 'Terminal output' });
    const prompt = createPrompt({
      label: 'Terminal command',
      placeholder: 'claude mcp list',
      cls: { form: 'mc-prompt', ps1: 'mc-ps1', input: 'mc-input mc-cmd', run: 'mc-btn', chips: 'mc-quicks', chip: 'mc-btn mc-quick' },
      next: (words) => nextWords(state, words),
      onSubmit: (line) => submit(state, ctx, line),
    });

    const workshop = buildWorkshop(state, ctx);
    const wide = matchMedia('(min-width: 700px)').matches;
    // On a phone the reference panels fold away so the terminal stays close to the requests.
    const fold = (title, label, open, ...kids) => {
      const d = el('details', { class: 'mc-panel mc-fold', 'aria-label': label }, el('summary', { class: 'mc-h', text: title }), ...kids);
      d.open = wide || open;
      return d;
    };
    const root = el(
      'div',
      { class: 'mc' },
      status,
      el(
        'div',
        { class: 'mc-cols' },
        el('div', { class: 'mc-col' }, el('section', { class: 'mc-panel', 'aria-label': 'Requests' }, el('h4', { class: 'mc-h', text: 'Requests' }), requests, hint), el('section', { class: 'mc-panel', 'aria-label': 'Wired servers' }, el('h4', { class: 'mc-h', text: 'Wired servers (clients)' }), servers)),
        el('div', { class: 'mc-col' }, fold('Available servers', 'Available servers', true, catalog, envBox), fold('Config files', 'Config files', false, files)),
      ),
      workshop ? workshop.panel : null,
      el('section', { class: 'mc-panel', 'aria-label': 'Terminal' }, el('h4', { class: 'mc-h', text: 'Terminal' }), term, prompt.form, prompt.tray),
      fold('Wire (JSON-RPC 2.0)', 'Wire log', false, wire),
    );
    state.dom = { root, status, requests, servers, files, catalog, env, envBox, wire, term, prompt, builder: workshop };
    ctx.ui.board.append(root);
    start(state, ctx);
    ctx.log('Wire servers with claude mcp commands, then serve each request. Reading is free; changes and serves are moves.');
  },

  tick: (state, ctx) => simTick(state, ctx),

  actions: {
    serveTool: { label: 'Call tool', key: 't', run: (state, ctx) => serve(state, ctx, 'tool') },
    serveResource: { label: 'Attach resource', key: 'a', run: (state, ctx) => serve(state, ctx, 'resource') },
    servePrompt: { label: 'Run prompt', key: 'u', run: (state, ctx) => serve(state, ctx, 'prompt') },
    sh: {
      hidden: true,
      run(state, ctx, line) {
        const result = runCommand(state, ctx, line);
        afterMove(state, ctx); // the host reloads its servers whenever the files change; reading is harmless
        render(state, ctx); // the engine does not re-render after a read-only or failed command (false)
        return result;
      },
    },
    approve: { hidden: true, run: (state, ctx, name) => decide(state, ctx, name, true) },
    reject: { hidden: true, run: (state, ctx, name) => decide(state, ctx, name, false) },
    setKnob: { hidden: true, run: (state, ctx, knob, option) => (simSetKnob(state, knob, option) ? 'free' : false) },
    saveServer: { hidden: true, run: (state, ctx) => simSaveServer(state, ctx) },
  },

  isWon: (state) => simIsWon(state),
  isLost: (state) => simIsLost(state),
  render,
});
