// "Index Fund": keep a growing shop database fast with the right indexes and ship schema changes
// through migrations without breaking production. The simulation is in sim.js and sql.js (DOM-free);
// this file is the board (tables, query feed, migration files), the SQL prompt and the wiring.
// The game is turn-based: the day only advances when you press Next day.
import { registerGame } from '../shared/engine.js';
import { el } from '../shared/ui.js';
import {
  afterMove,
  createWorld,
  describeApp,
  evalQuery,
  fmtInt,
  isLost as simIsLost,
  isWon as simIsWon,
  metrics,
  migrationRows,
  releaseList,
  runLine,
  saveFile as simSaveFile,
  schemaLines,
  start,
  swapQuery,
  tick as simTick,
} from './sim.js';
import { indexBytes, indexesOf, tableBytes } from './sql.js';

const TUNING_QUICK = [
  ['\\dt', '\\dt'],
  ['\\d orders', '\\d orders'],
  ['\\di', '\\di'],
  ['pg_stat_user_indexes', 'SELECT relname, indexrelname, idx_scan FROM pg_stat_user_indexes;'],
  ['\\?', '\\?'],
];
const MIGRATION_QUICK = [
  ['\\c staging', '\\c staging'],
  ['\\c prod', '\\c prod'],
  ['migrate status', 'migrate status'],
  ['migrate up', 'migrate up'],
  ['migrate down 1', 'migrate down 1'],
  ['migrate validate', 'migrate validate'],
  ['\\d orders', '\\d orders'],
  ['\\?', '\\?'],
];

const fmtMs = (ms) => (ms >= 100 ? `${Math.round(ms)} ms` : ms >= 10 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`);
const fmtMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

// ---------------------------------------------------------------- status strip

function fact(label, value, note, bad) {
  return el(
    'span',
    { class: `db-fact${bad ? ' db-fact-bad' : ''}` },
    el('span', { class: 'db-fact-label', text: label }),
    el('strong', { text: value }),
    note ? el('span', { class: 'db-fact-note', text: note }) : null,
  );
}

function statusStrip(w) {
  if (w.mode === 'tuning') {
    const m = metrics(w);
    const over = m.p95 > w.targetMs;
    return [
      fact('p95 read', fmtMs(m.p95), over ? `over the ${w.targetMs} ms target` : `within ${w.targetMs} ms`, over),
      fact('Write latency', fmtMs(m.writeMs), m.writeOver ? `over the ${w.writeBudgetMs} ms budget` : `within ${w.writeBudgetMs} ms`, m.writeOver),
      fact('Storage', fmtMb(m.storageMb), m.storageOver ? `over the ${fmtMb(w.storageBudgetMb)} budget` : `within ${fmtMb(w.storageBudgetMb)}`, m.storageOver),
    ];
  }
  const app = describeApp(w);
  return [
    fact('Connected to', w.conn, w.conn === 'prod' ? 'live data' : 'throwaway copy'),
    fact('App', app.version, app.missing.length ? `failing: needs ${app.missing.join(', ')}` : 'healthy', app.missing.length > 0),
    fact('Prod schema', w.dbs.prod.version || 'none'),
    fact('Staging schema', w.dbs.staging.version || 'none'),
  ];
}

// ---------------------------------------------------------------- tuning board

function indexRow(db, ix) {
  const t = db.tables[ix.table];
  const kind = ix.kind === 'pkey' ? 'primary key' : ix.unique ? 'unique' : '';
  return el(
    'div',
    { class: 'db-ix', role: 'listitem' },
    el('span', { class: 'db-ix-name', text: ix.name }),
    el('span', { class: 'db-ix-cols', text: `(${ix.cols.join(', ')})` }),
    kind ? el('span', { class: 'db-tag', text: kind }) : null,
    el('span', { class: 'db-ix-meta', text: `${fmtInt(ix.scans || 0)} scans · ${(indexBytes(t, ix) / 1048576).toFixed(1)} MB` }),
  );
}

function tableCards(w) {
  const db = w.dbs[w.shop];
  return Object.entries(db.tables).map(([name, t]) =>
    el(
      'div',
      { class: 'db-t', role: 'listitem' },
      el('div', { class: 'db-t-head' }, el('strong', { text: name }), el('span', { class: 'db-t-rows', text: `${fmtInt(t.rows)} rows · ${(tableBytes(t) / 1048576).toFixed(1)} MB` })),
      el('div', { class: 'db-ixs', role: 'list', 'aria-label': `Indexes on ${name}` }, ...indexesOf(db, name).map((ix) => indexRow(db, ix))),
    ),
  );
}

function queryCard(state, ctx, q) {
  const e = evalQuery(state, q);
  const kind = q.kind;
  const slow = e.slow;
  const badge = kind === 'write' ? 'WRITE' : kind === 'batch' ? 'BATCH' : slow ? '▲ SLOW' : '✓ OK';
  const flat = (sql) => sql.replace(/\s*\n\s*/g, ' ');
  const sqlLines = [el('code', { class: 'db-sql', text: flat(q.sql) })];
  if (q.each) sqlLines.push(el('code', { class: 'db-sql db-sql-each', text: `${q.each.count}× ${flat(q.each.sql)}` }));
  const meta = kind === 'write' ? e.summary : `${e.summary}${e.calls > 1 ? ` · ${e.calls} queries per request` : ''}`;
  const explain = (sql, label) => {
    const b = el('button', { class: 'db-btn', type: 'button', text: label });
    b.addEventListener('click', () => {
      ctx.act('sql', `EXPLAIN ANALYZE ${sql}`);
      state.stickBottom = true;
      state.dom.input.focus();
    });
    return b;
  };
  const buttons = [];
  if (kind !== 'write') buttons.push(explain(q.sql, q.each ? 'EXPLAIN first query' : 'EXPLAIN ANALYZE'));
  if (q.each) buttons.push(explain(q.each.sql, 'EXPLAIN per-item query'));
  if (q.swap && q.each) {
    const deploy = el('button', { class: 'db-btn db-btn-main db-deploy', type: 'button', text: 'Deploy my last SELECT as this query' });
    deploy.disabled = !state.lastSelect;
    deploy.addEventListener('click', () => {
      ctx.act('swap', q.id);
      state.dom.input.focus();
    });
    buttons.push(deploy);
  }
  const bar =
    kind === 'read'
      ? el('div', { class: 'db-bar', 'aria-hidden': 'true' }, el('span', { class: 'db-bar-fill', style: `width:${Math.min(100, (e.requestMs / (2 * e.budget)) * 100).toFixed(1)}%` }), el('span', { class: 'db-bar-mark' }))
      : null;
  return el(
    'div',
    { class: 'db-q', role: 'listitem', 'data-state': kind === 'read' ? (slow ? 'slow' : 'ok') : kind },
    el(
      'div',
      { class: 'db-q-head' },
      el('strong', { text: q.name }),
      el('span', { class: 'db-badge', text: badge }),
      el('span', { class: 'db-q-ms', text: kind === 'write' ? `${fmtMs(e.ms)} per insert` : `${fmtMs(e.requestMs)}${Number.isFinite(e.budget) ? ` of ${e.budget} ms` : ''}` }),
    ),
    ...sqlLines,
    el('div', { class: 'db-q-meta', text: meta }),
    bar,
    buttons.length ? el('div', { class: 'db-q-actions' }, ...buttons) : null,
  );
}

// ---------------------------------------------------------------- migrations board

function fileKey(f, kind) {
  return `${f.version}_${f.name}.${kind}.sql`;
}

function editorTargets(w) {
  return w.files.flatMap((f) => [
    { id: `${f.version}:up`, label: fileKey(f, 'up'), text: f.up },
    { id: `${f.version}:down`, label: fileKey(f, 'down'), text: f.down },
  ]);
}

function syncEditor(state) {
  const { select, area } = state.dom.editor;
  const targets = editorTargets(state);
  const sig = JSON.stringify(targets.map((t) => t.id));
  if (state.editorSig !== sig) {
    const previous = select.value;
    state.editorSig = sig;
    select.replaceChildren(...targets.map((t) => el('option', { value: t.id, text: t.label })));
    select.value = targets.some((t) => t.id === previous) ? previous : targets[targets.length - 1]?.id;
    fillArea(state);
  }
}

function fillArea(state) {
  const { select, area } = state.dom.editor;
  const target = editorTargets(state).find((t) => t.id === select.value);
  area.value = target ? target.text : '';
}

function saveEditor(state, ctx) {
  const { select, area } = state.dom.editor;
  const [version, kind] = select.value.split(':');
  ctx.act('saveFile', version, kind, area.value);
}

function restoreEditor(state, ctx) {
  const { select } = state.dom.editor;
  const target = editorTargets(state).find((t) => t.id === select.value);
  if (target) ctx.act('sql', `git restore ${target.label}`);
}

function migrationList(w) {
  return migrationRows(w).map((r) =>
    el(
      'div',
      { class: 'db-m', role: 'listitem' },
      el('span', { class: 'db-m-name', text: `${r.version}_${r.name}` }),
      el('span', { class: 'db-m-state', text: `staging: ${r.staging}` }),
      el('span', { class: 'db-m-state', text: `prod: ${r.prod}` }),
      r.dirty ? el('span', { class: 'db-tag db-tag-warn', text: 'edited, not committed' }) : null,
    ),
  );
}

function appPanel(w) {
  const app = describeApp(w);
  const releases = releaseList(w);
  return [
    el(
      'div',
      { class: 'db-app', 'data-state': app.missing.length ? 'broken' : 'ok' },
      el('strong', { text: `shop-app ${app.version}` }),
      el('span', { class: 'db-app-note', text: app.note }),
      el('span', { class: 'db-app-reads', text: `reads: ${app.needs.join(', ')}` }),
      el('span', { class: 'db-app-state', text: app.missing.length ? `▲ failing requests: ${app.missing.join(', ')} missing in prod` : '✓ serving requests' }),
    ),
    el(
      'div',
      { class: 'db-releases', role: 'list', 'aria-label': 'Releases' },
      ...(releases.length
        ? releases.map((r) => el('div', { class: 'db-rel', role: 'listitem', 'data-state': r.state }, el('span', { text: r.title }), el('span', { class: 'db-badge', text: r.state === 'shipped' ? '✓ shipped' : r.state === 'pulled' ? 'pulled' : '▲ waiting to ship' })))
        : [el('div', { class: 'db-empty', role: 'listitem', text: 'No release is waiting.' })]),
    ),
  ];
}

// ---------------------------------------------------------------- terminal

function termLines(w) {
  return w.term.map((l) => el('span', { class: `db-line db-line-${l.kind}`, text: `${l.text}\n` }));
}

function submit(state, ctx, line) {
  const text = line.trim();
  if (!text) return;
  if (state.history[state.history.length - 1] !== text) state.history.push(text);
  state.historyAt = state.history.length;
  state.stickBottom = true;
  ctx.act('sql', text);
}

// ---------------------------------------------------------------- render

function render(state, ctx) {
  const d = state.dom;
  d.status.replaceChildren(...statusStrip(state));
  if (state.mode === 'tuning') {
    const visible = state.queries.filter((q) => q.visible);
    d.tables.replaceChildren(...tableCards(state));
    d.feed.replaceChildren(...visible.map((q) => queryCard(state, ctx, q)));
  } else {
    d.files.replaceChildren(...migrationList(state));
    syncEditor(state);
    d.app.replaceChildren(...appPanel(state));
    d.schema.textContent = schemaLines(state).join('\n').trimEnd();
    d.schemaHead.textContent = `Schema of ${state.conn}`;
    const versions = Object.keys(state.apps).filter((v) => state.apps[v].available);
    const sig = versions.join(',');
    if (d.deploySig !== sig) {
      d.deploySig = sig;
      d.deployChips.replaceChildren(...versions.map((v) => quickButton(state, ctx, `deploy ${v}`, `deploy ${v}`)));
    }
  }
  const atBottom = d.term.scrollHeight - d.term.scrollTop - d.term.clientHeight < 40;
  d.term.replaceChildren(...(state.term.length ? termLines(state) : [el('span', { class: 'db-line db-line-note', text: 'Type SQL below, or press a button. \\? lists the commands.\n' })]));
  if (atBottom || state.stickBottom) d.term.scrollTop = d.term.scrollHeight;
  state.stickBottom = false;
  d.prompt.textContent = `${state.conn}=#`;
  const over = ctx.over;
  d.input.disabled = over;
  d.run.disabled = over;
  for (const b of d.root.querySelectorAll('.db-quick, .db-btn')) {
    const swap = b.classList.contains('db-deploy');
    b.disabled = over || (swap && !state.lastSelect);
  }
  if (d.editor) {
    d.editor.select.disabled = over;
    d.editor.area.disabled = over;
  }
}

function quickButton(state, ctx, label, cmd) {
  const b = el('button', { class: 'db-btn db-quick', type: 'button', 'data-cmd': cmd, text: label });
  b.addEventListener('click', () => {
    submit(state, ctx, cmd);
    state.dom.input.focus();
  });
  return b;
}

// ---------------------------------------------------------------- the game

registerGame({
  id: 'database',
  styles: 'game.css',

  init(state, ctx) {
    Object.assign(state, createWorld(ctx.scenario));
    state.history = [];
    state.historyAt = 0;
    state.editorSig = null;
    state.stickBottom = true;

    const status = el('div', { class: 'db-status', role: 'status', 'aria-label': 'Latency, storage and connection' });
    const term = el('pre', { class: 'db-term', tabindex: 0, role: 'log', 'aria-label': 'Terminal output' });
    const prompt = el('span', { class: 'db-ps1', 'aria-hidden': 'true' });
    const input = el('textarea', { class: 'db-input', rows: 2, 'aria-label': 'SQL or command', placeholder: state.mode === 'tuning' ? 'EXPLAIN ANALYZE SELECT ...' : 'migrate up', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const run = el('button', { class: 'db-btn', type: 'submit', text: 'Run' });
    const form = el('form', { class: 'db-prompt' }, prompt, input, run);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const line = input.value;
      input.value = '';
      submit(state, ctx, line);
      input.focus();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      } else if (e.key === 'ArrowUp' && !input.value.includes('\n') && state.historyAt > 0) {
        e.preventDefault();
        state.historyAt -= 1;
        input.value = state.history[state.historyAt];
      } else if (e.key === 'ArrowDown' && !input.value.includes('\n')) {
        e.preventDefault();
        state.historyAt = Math.min(state.history.length, state.historyAt + 1);
        input.value = state.history[state.historyAt] || '';
      }
    });
    const quickSet = state.mode === 'tuning' ? TUNING_QUICK : MIGRATION_QUICK;
    const quicks = el('div', { class: 'db-quicks' }, ...quickSet.map(([label, cmd]) => quickButton(state, ctx, label, cmd)));
    const terminal = el('section', { class: 'db-panel' }, el('h4', { class: 'db-h', text: 'Terminal' }), term, form, quicks);

    const root = el('div', { class: 'db' }, status);
    const dom = { root, status, term, input, run, prompt, editor: null };

    if (state.mode === 'tuning') {
      dom.tables = el('div', { class: 'db-list', role: 'list', 'aria-label': 'Tables and their indexes' });
      dom.feed = el('div', { class: 'db-list', role: 'list', 'aria-label': 'Query feed' });
      root.append(
        el('div', { class: 'db-cols' }, el('section', { class: 'db-panel' }, el('h4', { class: 'db-h', text: 'Tables' }), dom.tables), el('section', { class: 'db-panel' }, el('h4', { class: 'db-h', text: 'Query feed' }), dom.feed)),
        terminal,
      );
      ctx.log('Read each plan before you change anything: EXPLAIN is free, every CREATE or DROP costs a move. Next day (d) ends the day; whatever is still over budget overnight costs error budget.');
    } else {
      dom.files = el('div', { class: 'db-list', role: 'list', 'aria-label': 'Migration files' });
      dom.app = el('div', { class: 'db-app-wrap' });
      dom.schema = el('pre', { class: 'db-code', tabindex: 0, 'aria-label': 'Schema of the connected database' });
      dom.schemaHead = el('h4', { class: 'db-h' });
      dom.deployChips = el('div', { class: 'db-quicks' });
      dom.deploySig = null;
      const select = el('select', { class: 'db-select', 'aria-label': 'Migration file to edit' });
      const area = el('textarea', { class: 'db-input db-file', rows: 5, 'aria-label': 'File contents', spellcheck: 'false' });
      const save = el('button', { class: 'db-btn db-btn-main', type: 'button', text: 'Save file' });
      const restore = el('button', { class: 'db-btn', type: 'button', text: 'git restore' });
      select.addEventListener('change', () => fillArea(state));
      save.addEventListener('click', () => saveEditor(state, ctx));
      restore.addEventListener('click', () => restoreEditor(state, ctx));
      dom.editor = { select, area };
      state.dom = dom; // syncEditor reads it
      const editor = el('div', { class: 'db-editor' }, el('span', { class: 'db-fact-label', text: 'Edit a migration file' }), select, area, el('div', { class: 'db-q-actions' }, save, restore));
      root.append(
        el(
          'div',
          { class: 'db-cols' },
          el('section', { class: 'db-panel' }, el('h4', { class: 'db-h', text: 'Migrations (db/migrations)' }), dom.files, editor),
          el('section', { class: 'db-panel' }, el('h4', { class: 'db-h', text: 'Production' }), dom.app, el('h4', { class: 'db-h', text: 'Roll out' }), dom.deployChips, dom.schemaHead, dom.schema),
        ),
        terminal,
      );
      ctx.log('Test every migration on staging first (staging is reset to prod each morning). Prod gets the schema, then the app that needs it, in the order that keeps production serving.');
    }
    state.dom = dom;
    ctx.ui.board.append(root);
    start(state, ctx);
  },

  tick: (state, ctx) => simTick(state, ctx),

  actions: {
    nextDay: {
      label: 'Next day',
      key: 'd',
      run(state, ctx) {
        ctx.step();
        return 'free';
      },
    },
    sql: {
      hidden: true,
      run(state, ctx, line) {
        const result = runLine(state, ctx, line);
        afterMove(state, ctx);
        render(state, ctx); // the engine does not re-render after a rejected command (false)
        return result;
      },
    },
    saveFile: {
      hidden: true,
      run(state, ctx, version, kind, text) {
        const ok = simSaveFile(state, version, kind, text);
        if (ok) afterMove(state, ctx);
        render(state, ctx);
        return ok;
      },
    },
    swap: {
      hidden: true,
      run(state, ctx, id) {
        const ok = swapQuery(state, ctx, id);
        afterMove(state, ctx);
        render(state, ctx);
        return ok;
      },
    },
  },

  isWon: (state) => simIsWon(state),
  isLost: (state) => simIsLost(state),
  render,
});
