// "Merge Conflict Rush": resolve real team situations with git and gh commands while a commit graph
// shows every change. The simulation is in sim.js (DOM-free); this file is the graph, the working-tree
// and repo panels, the terminal and the registerGame wiring. The game is turn-based: only a command
// that changes something (or Wait) advances time, which is when teammates push and reviews arrive.
import { registerGame } from '../shared/engine.js';
import { createPrompt } from '../shared/prompt.js';
import { el } from '../shared/ui.js';
import {
  branchInfo,
  createWorld,
  editFile,
  execute,
  goalStatus,
  graphRows,
  hasMarkers,
  isLost as simIsLost,
  isWon as simIsWon,
  listFiles,
  mainBuild,
  nextWords,
  ownersLines,
  prCards,
  repoBadges,
  tick as simTick,
  workStatus,
} from './sim.js';

const SVG = 'http://www.w3.org/2000/svg';
const LANE = 14;
const laneX = (k) => 9 + k * LANE;

// ---------------------------------------------------------------- commit graph

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function line(x1, y1, x2, y2, lane) {
  return svg('line', { x1, y1, x2, y2, class: `gh-edge gh-l${lane % 6}`, 'vector-effect': 'non-scaling-stroke' });
}

// Each row draws the top half of its node (14px, up to the dot) and the bottom half (stretches to the
// row's height), so a row can wrap to several lines and its lane lines still connect.
function rowGraphic(row, width) {
  const w = laneX(width - 1) + 9;
  const top = svg('svg', { class: 'gh-svg gh-svg-top', width: w, height: 14, viewBox: `0 0 ${w} 14`, 'aria-hidden': 'true', focusable: 'false' });
  const bottom = svg('svg', { class: 'gh-svg gh-svg-bottom', width: w, height: '100%', viewBox: `0 0 ${w} 100`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
  row.before.forEach((id, k) => {
    if (id === null || id === undefined) return;
    if (k === row.lane) {
      if (!row.fresh) top.append(line(laneX(k), 0, laneX(k), 14, k));
    } else if (row.merged.includes(k)) top.append(line(laneX(k), 0, laneX(row.lane), 14, k));
    else if (row.after[k] === id) top.append(line(laneX(k), 0, laneX(k), 14, k));
  });
  row.parentLanes.forEach((pl) => bottom.append(line(laneX(row.lane), 0, laneX(pl), 100, pl)));
  row.after.forEach((id, k) => {
    if (id === null || id === undefined || k === row.lane || row.added.includes(k)) return;
    if (row.before[k] === id) bottom.append(line(laneX(k), 0, laneX(k), 100, k));
  });
  const node = el('span', { class: `gh-node gh-l${row.lane % 6}${row.parentLanes.length > 1 ? ' gh-node-merge' : ''}${row.refs.some((r) => r.kind === 'head') ? ' gh-node-head' : ''}`, style: `left: ${laneX(row.lane) - 6}px` });
  return el('div', { class: 'gh-gfx', style: `width: ${w}px`, 'aria-hidden': 'true' }, top, bottom, node);
}

function graphList(w, state) {
  const g = graphRows(w, 14);
  const rows = g.rows.map((r) => {
    const fresh = !state.seen.has(r.id);
    const pills = r.refs.map((ref) => el('span', { class: `gh-pill gh-pill-${ref.kind}`, text: ref.text }));
    return el(
      'div',
      { class: `gh-row${fresh && state.seen.size ? ' gh-new' : ''}`, role: 'listitem' },
      rowGraphic(r, g.width),
      el(
        'div',
        { class: 'gh-info' },
        el('div', { class: 'gh-line' }, el('code', { class: 'gh-sha', text: r.id }), el('span', { class: 'gh-subj', text: r.subject }), el('span', { class: 'gh-who', text: r.author })),
        pills.length ? el('div', { class: 'gh-pills' }, ...pills) : null,
      ),
    );
  });
  for (const r of g.rows) state.seen.add(r.id);
  if (g.hidden > 0) rows.push(el('div', { class: 'gh-more', role: 'listitem', text: `${g.hidden} older commits not shown` }));
  return rows;
}

// ---------------------------------------------------------------- panels

function goalItems(w) {
  return goalStatus(w).map((g) =>
    el(
      'div',
      { class: `gh-goal${g.done ? ' gh-goal-done' : ''}`, role: 'listitem' },
      el('span', { class: 'gh-mark', 'aria-hidden': 'true', text: g.done ? '✓' : '○' }),
      el('span', { class: 'gh-sr', text: g.done ? 'Done: ' : 'To do: ' }),
      el('span', { text: g.text }),
    ),
  );
}

function fileGroup(title, items, kind) {
  if (!items.length) return null;
  return el(
    'div',
    { class: 'gh-group' },
    el('h4', { class: 'gh-h5', text: title }),
    el('div', { class: 'gh-files', role: 'list', 'aria-label': title }, ...items.map((f) => el('div', { class: `gh-file gh-file-${kind}`, role: 'listitem' }, el('span', { class: 'gh-kind', text: f.kind || kind }), el('code', { text: f.path || f })))),
  );
}

function treePanel(w) {
  const info = branchInfo(w);
  const s = workStatus(w);
  const where = info.branch ? `on ${info.branch}` : `detached at ${info.detached}`;
  let track = '';
  if (info.upstream) {
    track = info.gone ? `${info.upstream} (gone)` : !info.ahead && !info.behind ? `in step with ${info.upstream}` : `${info.ahead} ahead, ${info.behind} behind ${info.upstream}`;
  } else if (info.branch) track = 'no upstream yet';
  const clean = !s.staged.length && !s.unstaged.length && !s.untracked.length && !s.unmerged.length;
  return [
    el('p', { class: 'gh-where' }, el('strong', { text: where }), el('span', { class: 'gh-track', text: track })),
    info.stash ? el('p', { class: 'gh-note', text: `${info.stash} stash ${info.stash === 1 ? 'entry' : 'entries'} (git stash list)` }) : null,
    info.op ? el('p', { class: 'gh-op', role: 'status' }, el('strong', { text: info.op }), ` — ${info.opHint}`) : null,
    fileGroup('Conflicted', s.unmerged.map((p) => ({ path: p, kind: 'both modified' })), 'conflict'),
    fileGroup('Staged', s.staged, 'staged'),
    fileGroup('Not staged', s.unstaged, 'unstaged'),
    fileGroup('Untracked', s.untracked, 'untracked'),
    clean ? el('p', { class: 'gh-note', text: 'Working tree clean.' }) : null,
  ];
}

function repoPanel(w) {
  const build = mainBuild(w);
  const cards = prCards(w);
  return [
    el('div', { class: 'gh-badges', role: 'list', 'aria-label': 'Repository settings' }, ...repoBadges(w).map((b) => el('span', { class: 'gh-badge', role: 'listitem', text: `${b.ok ? '✓' : '–'} ${b.text}` }))),
    build ? el('p', { class: 'gh-note' }, 'Build on origin/main: ', el('strong', { class: build === 'FAILING' ? 'gh-bad' : '', text: build === 'FAILING' ? '✗ FAILING' : '✓ passing' })) : null,
    ownersLines(w).length ? el('div', { class: 'gh-owners' }, el('h4', { class: 'gh-h5', text: 'CODEOWNERS' }), el('pre', { class: 'gh-pre', text: ownersLines(w).join('\n') })) : null,
    el('h4', { class: 'gh-h5', text: 'Pull requests' }),
    el(
      'div',
      { class: 'gh-prs', role: 'list', 'aria-label': 'Pull requests' },
      ...(cards.length
        ? cards.map((c) =>
            el(
              'div',
              { class: `gh-pr gh-pr-${c.state.split(' ')[0]}`, role: 'listitem' },
              el('div', { class: 'gh-pr-head' }, el('strong', { text: `#${c.n} ${c.title}` }), el('span', { class: 'gh-pr-state', text: c.state })),
              el('div', { class: 'gh-pr-meta', text: `${c.head} → ${c.base}` }),
              c.reviewers.length ? el('div', { class: 'gh-pr-meta', text: `Reviewers: ${c.reviewers.map((r) => `${r.name} ${r.state === 'approved' ? '✓ approved' : '○ requested'}`).join(', ')}` }) : null,
              c.checks.length ? el('div', { class: 'gh-pr-meta', text: `Checks: ${c.checks.map((k) => `${k.name} ${k.state === 'pass' ? '✓ pass' : '✗ fail'}`).join(', ')}` }) : null,
              c.blockers.length ? el('div', { class: 'gh-pr-block', text: `Blocked: ${c.blockers.join('; ')}` }) : null,
            ),
          )
        : [el('p', { class: 'gh-note', role: 'listitem', text: 'No pull requests yet. gh pr create --fill opens one.' })]),
    ),
  ];
}

// ---------------------------------------------------------------- editor

const MARK_OPEN = /^<{7}( |$)/;
const MARK_MID = /^={7}$/;
const MARK_CLOSE = /^>{7}( |$)/;

// Resolves every conflict block in `text`: keep the top side, the bottom side, or both.
export function resolveMarkers(text, mode) {
  const out = [];
  let side = 0;
  for (const l of text.split('\n')) {
    if (side === 0 && MARK_OPEN.test(l)) side = 1;
    else if (side === 1 && MARK_MID.test(l)) side = 2;
    else if (side === 2 && MARK_CLOSE.test(l)) side = 0;
    else if (side === 0 || (side === 1 && mode !== 'bottom') || (side === 2 && mode !== 'top')) out.push(l);
  }
  return out.join('\n');
}

function syncEditor(state) {
  const ed = state.dom.editor;
  const files = listFiles(state);
  const sig = files.join('|');
  if (state.editorSig !== sig) {
    state.editorSig = sig;
    const keep = ed.select.value;
    ed.select.replaceChildren(...files.map((f) => el('option', { value: f, text: state.unmerged.includes(f) ? `${f} (conflict)` : f })));
    ed.select.value = files.includes(keep) ? keep : files[0];
  }
  for (const opt of ed.select.options) opt.textContent = state.unmerged.includes(opt.value) ? `${opt.value} (conflict)` : opt.value;
  const path = ed.select.value;
  const disk = state.worktree[path] ?? '';
  // Reload the text unless the player has typed something unsaved into the box.
  if (ed.loaded.path !== path || (ed.loaded.text !== disk && ed.area.value === ed.loaded.text)) {
    ed.area.value = disk;
    ed.loaded = { path, text: disk };
  }
  ed.markers.hidden = !hasMarkers(ed.area.value);
}

function wireEditor(state, ctx) {
  const ed = state.dom.editor;
  ed.select.addEventListener('change', () => {
    ed.loaded = { path: null, text: '' };
    syncEditor(state);
  });
  ed.area.addEventListener('input', () => {
    ed.markers.hidden = !hasMarkers(ed.area.value);
  });
  ed.save.addEventListener('click', () => {
    ctx.act('edit', ed.select.value, ed.area.value);
    ed.loaded = { path: ed.select.value, text: ed.area.value.replace(/\r\n/g, '\n').replace(/\n$/, '') };
    state.dom.editor.status.textContent = `Saved ${ed.select.value}. Next: git add ${ed.select.value}`;
  });
  for (const [btn, mode] of [[ed.top, 'top'], [ed.bottom, 'bottom'], [ed.both, 'both']]) {
    btn.addEventListener('click', () => {
      ed.area.value = resolveMarkers(ed.area.value, mode);
      ed.markers.hidden = !hasMarkers(ed.area.value);
      ed.status.textContent = 'Markers removed in the box. Check the result, then Save file.';
    });
  }
}

// ---------------------------------------------------------------- terminal

function termLines(w) {
  return w.term.map((l) => el('span', { class: `gh-tl gh-tl-${l.kind}`, text: `${l.text}\n` }));
}

function submit(state, ctx, text) {
  const line = text.trim();
  if (!line) return;
  state.stick = true;
  ctx.act('terminal', line);
}

// ---------------------------------------------------------------- render

function render(state, ctx) {
  const d = state.dom;
  d.goals.replaceChildren(...goalItems(state));
  d.graph.replaceChildren(...graphList(state, state));
  d.tree.replaceChildren(...treePanel(state).filter(Boolean));
  d.repo.replaceChildren(...repoPanel(state).filter(Boolean));
  syncEditor(state);
  const atBottom = d.term.scrollHeight - d.term.scrollTop - d.term.clientHeight < 40;
  d.term.replaceChildren(...termLines(state));
  if (atBottom || state.stick) d.term.scrollTop = d.term.scrollHeight;
  state.stick = false;
  const over = ctx.over;
  d.prompt.setDisabled(over);
  const ed = d.editor;
  for (const c of [ed.select, ed.area, ed.save, ed.top, ed.bottom, ed.both]) c.disabled = over;
}

// ---------------------------------------------------------------- the game

registerGame({
  id: 'github',
  styles: 'game.css',

  init(state, ctx) {
    Object.assign(state, createWorld(ctx.scenario));
    state.stick = true;
    state.editorSig = null;
    state.seen = new Set();
    state.term.push({ kind: 'note', text: '# acme/site, cloned to /work/site. Type git and gh commands, or tap a button. "help" lists what works.' });

    const goals = el('div', { class: 'gh-goals', role: 'list', 'aria-label': 'Goals' });
    const term = el('pre', { class: 'gh-term', tabindex: 0, role: 'log', 'aria-label': 'Terminal output' });
    const prompt = createPrompt({
      label: 'Terminal command',
      placeholder: 'git status',
      cls: { form: 'gh-prompt', ps1: 'gh-ps1', input: 'gh-input gh-cmd', run: 'gh-btn', chips: 'gh-quicks', chip: 'gh-btn gh-quick' },
      next: (words) => nextWords(state, words),
      onSubmit: (line) => submit(state, ctx, line),
    });

    const graph = el('div', { class: 'gh-graph', role: 'list', 'aria-label': 'Commit graph, newest first', tabindex: 0 });
    const tree = el('div', { class: 'gh-tree' });
    const repo = el('div', { class: 'gh-repo' });

    const select = el('select', { class: 'gh-input', 'aria-label': 'File to edit' });
    const area = el('textarea', { class: 'gh-area', rows: 7, spellcheck: 'false', 'aria-label': 'File contents' });
    const save = el('button', { class: 'gh-btn', type: 'button', text: 'Save file' });
    const top = el('button', { class: 'gh-btn', type: 'button', text: 'Keep top side' });
    const bottom = el('button', { class: 'gh-btn', type: 'button', text: 'Keep bottom side' });
    const both = el('button', { class: 'gh-btn', type: 'button', text: 'Keep both' });
    const markers = el('div', { class: 'gh-markers', hidden: true }, el('span', { class: 'gh-note', text: 'Conflict markers in this file:' }), top, bottom, both);
    const status = el('p', { class: 'gh-note', role: 'status', 'aria-live': 'polite' });
    const editor = { select, area, save, top, bottom, both, markers, status, loaded: { path: null, text: '' } };

    const panel = (area2, title, ...kids) => el('section', { class: `gh-panel gh-${area2}` }, el('h3', { class: 'gh-h', text: title }), ...kids);
    const root = el(
      'div',
      { class: 'gh' },
      panel('p-goals', 'Goals', goals),
      panel('p-term', 'Terminal', term, prompt.form, prompt.tray),
      panel('p-graph', 'Commit graph (your clone, newest first)', graph),
      panel('p-tree', 'Working tree', tree),
      panel('p-edit', 'File editor', el('div', { class: 'gh-editrow' }, select, save), area, markers, status),
      panel('p-repo', 'GitHub: settings and pull requests', repo),
    );
    state.dom = { root, goals, term, prompt, graph, tree, repo, editor };
    wireEditor(state, ctx);
    ctx.ui.board.append(root);
    ctx.log('Reading (status, log, diff) is free; each change takes a step. Wait (w) lets time pass for a review or a teammate.');
  },

  tick: (state, ctx) => simTick(state, ctx),

  actions: {
    wait: {
      label: 'Wait',
      key: 'w',
      run(state, ctx) {
        state.term.push({ kind: 'note', text: '# time passes: teammates push, reviewers review' });
        ctx.step();
        return true;
      },
    },
    terminal: {
      hidden: true,
      run(state, ctx, line) {
        const result = execute(state, ctx, line);
        render(state, ctx); // the engine does not re-render after a read-only or failed command (false)
        return result;
      },
    },
    edit: {
      hidden: true,
      run: (state, ctx, path, text) => editFile(state, ctx, path, text),
    },
  },

  isWon: (state) => simIsWon(state),
  isLost: (state) => simIsLost(state),
  render,
});
