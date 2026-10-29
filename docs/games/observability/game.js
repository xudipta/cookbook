// "Quiet Hours": write the alerting rules, then live through the night. The simulation is in sim.js
// (DOM-free); this file draws the dashboard, the night timeline, the rules editor and the phone, and
// wires them to the shared engine. The game is turn-based: time passes only on Next hour.
import { registerGame } from '../shared/engine.js';
import { el } from '../shared/ui.js';
import {
  FN_LABELS,
  FORS,
  GROUP_BYS,
  HORIZONS,
  METRICS,
  NIGHT_MIN,
  PANELS,
  QUANTILES,
  SEVERITIES,
  backtest,
  classify,
  clockOf,
  clockText,
  createWorld,
  dashSlow,
  exprOf,
  hourOf,
  isLost,
  isWon,
  needsWindow,
  nightOver,
  panelExpr,
  panelSeries,
  quizDone,
  recordedExpr,
  removeRule,
  routeYaml,
  rulesYaml,
  saveRule,
  setRoute,
  stars,
  tick,
  unitFor,
  valueExpr,
  validateRule,
  whenText,
  windowsFor,
} from './sim.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined) node.append(kid);
  return node;
}

const METRIC_LABELS = {
  req: 'http_requests_total (counter)',
  err: 'http_requests_total{code=~"5.."} (counter)',
  lat: 'http_request_duration_seconds (histogram)',
  cpu: 'process_cpu_usage (gauge)',
  disk: 'node_filesystem_avail_bytes (gauge)',
  queue: 'job_queue_depth (gauge)',
  up: 'up (gauge, 15 targets)',
};
const GROUP_LABELS = {
  '...': "['...']",
  'alertname,instance': '[alertname, instance]',
  'alertname,job': '[alertname, job]',
  alertname: '[alertname]',
};
const GROUP_HELP = {
  '...': 'Grouping is off: every firing alert notifies on its own, so 15 dead instances make 15 pages.',
  'alertname,instance': 'One notification per rule and instance: 15 dead instances still make 15 pages.',
  'alertname,job': 'One notification per rule and job: 15 dead instances make 1 page.',
  alertname: 'One notification per rule: 15 dead instances make 1 page.',
};
const TYPES = ['counter', 'gauge', 'histogram', 'summary'];
const QUIZ_FNS = [
  ['rate', 'rate()'],
  ['histogram_quantile', 'histogram_quantile()'],
  ['predict_linear', 'predict_linear()'],
  ['nothing', 'as it is'],
];

// What the graph of each kind of signal looks like, and what an alert on it does when it is read wrongly.
const SHAPE_NOTES = {
  counter: 'Look at the graph: it only climbs and drops to zero on a restart, which is what a counter does.',
  gauge: 'Look at the graph: it wanders up and down around a level, which is what a gauge does.',
  histogram: 'Look at the bars: counts per latency bucket, which is a histogram.',
  summary: 'Look at the lines: percentiles already worked out, one line each, which is a summary.',
  decline: 'Look at the graph: a steady slide down, a gauge that is running out.',
};
const FN_CONSEQUENCE = {
  rate: 'rate() of something that is not a counter stays near zero: the alert stays quiet while users suffer.',
  histogram_quantile: 'histogram_quantile() needs _bucket series; on this signal it returns nothing, so the alert stays quiet.',
  predict_linear: 'predict_linear() projects a trend; on a signal without one it fires on noise, or never.',
  nothing: 'Alerting on the raw value: for a counter it only ever rises, so the alert fires once and never clears.',
};

// A tiny deterministic picture of each kind of signal, so the warm-up is about reading a graph.
function sparkFor(shape) {
  const W = 150;
  const H = 54;
  const n = 30;
  const pts = [];
  const noise = (k) => Math.sin(k * 2.3) * 0.5 + Math.sin(k * 0.9 + 1) * 0.5;
  const line = (f) => {
    for (let k = 0; k < n; k++) pts.push(`${((k / (n - 1)) * (W - 4) + 2).toFixed(1)},${(H - 4 - f(k) * (H - 10)).toFixed(1)}`);
    return pts.splice(0).join(' ');
  };
  const parts = [];
  if (shape === 'counter') parts.push(svg('polyline', { points: line((k) => ((k % 15) / 15) * 0.9 + 0.05), class: 'oh-spark' }));
  else if (shape === 'gauge') parts.push(svg('polyline', { points: line((k) => 0.5 + noise(k) * 0.3), class: 'oh-spark' }));
  else if (shape === 'decline') parts.push(svg('polyline', { points: line((k) => 0.9 - (k / n) * 0.8 + noise(k) * 0.03), class: 'oh-spark' }));
  else if (shape === 'summary') {
    for (const [base, amp] of [[0.25, 0.05], [0.5, 0.08], [0.8, 0.1]]) parts.push(svg('polyline', { points: line((k) => base + noise(k + base * 10) * amp), class: 'oh-spark' }));
  } else {
    [0.15, 0.4, 0.8, 0.55, 0.3, 0.1].forEach((v, k) => parts.push(svg('rect', { x: 8 + k * 23, y: H - 4 - v * (H - 10), width: 16, height: v * (H - 10), class: 'oh-spark-bar' })));
  }
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'oh-sparkline', role: 'img', 'aria-label': SHAPE_NOTES[shape].replace('Look at the graph: ', '').replace('Look at the bars: ', '').replace('Look at the lines: ', '') }, parts);
}

function consequence(item, choice) {
  const bits = [];
  const kind = item.shape || item.type;
  if (item.type !== choice.type) bits.push(SHAPE_NOTES[kind]);
  if (item.fn !== choice.fn) bits.push(FN_CONSEQUENCE[choice.fn]);
  return bits.join(' ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- the dashboard

const niceMax = (v) => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v * 1.1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v * 1.1) return m * p;
  return 10 * p;
};
const fmtVal = (v, id) => {
  if (!Number.isFinite(v)) return 'no data';
  if (id === 2) return `${v.toFixed(2)} %`;
  if (id === 3) return `${v.toFixed(2)} s`;
  if (id === 4) return `${Math.round(v)} %`;
  if (id === 5) return `${Math.round(v)} jobs`;
  return `${Math.round(v)} req/s`;
};
const axisVal = (v, id) => (id === 3 ? v.toFixed(2) : id === 2 ? v.toFixed(1) : String(Math.round(v * 10) / 10));

// An alert threshold that belongs on this panel (same metric and function), in the panel's unit.
function thresholdFor(w, id) {
  for (const r of w.rules) {
    if (r.kind === 'record') continue;
    if (id === 1 && r.metric === 'req' && (r.fn === 'rate' || r.fn === 'sum_rate')) return r.threshold;
    if (id === 2 && r.metric === 'err' && r.fn === 'ratio') return r.threshold * 100;
    if (id === 3 && r.metric === 'lat' && r.fn === 'quantile' && (r.q ?? 0.95) === 0.95) return r.threshold;
    if (id === 4 && r.metric === 'cpu' && r.fn === 'raw') return r.threshold * 100;
    if (id === 5 && r.metric === 'queue' && r.fn === 'raw') return r.threshold;
  }
  return null;
}

// A chart drawn at about its real size (so the 11px axis text stays 11px), plus the text a screen reader or a
// thumb can use instead: a summary and a slider that reads one point.
function chartFor(w, panel) {
  const data = panelSeries(w, panel.id).filter((p) => Number.isFinite(p.v));
  const thr = thresholdFor(w, panel.id);
  const W = 330;
  const H = 150;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const top = niceMax(Math.max(...data.map((p) => p.v), thr ?? 0, 0));
  const i0 = data[0].i;
  const i1 = data[data.length - 1].i;
  const x = (i) => pad.l + ((i - i0) / Math.max(1, i1 - i0)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - Math.min(v, top) / top) * (H - pad.t - pad.b);
  const peak = data.reduce((a, p) => (p.v > a.v ? p : a), data[0]);
  const now = data[data.length - 1];
  const crossed = thr !== null ? data.find((p) => p.v > thr) : null;
  const summary = `${panel.title}: now ${fmtVal(now.v, panel.id)}; highest ${fmtVal(peak.v, panel.id)} at ${clockOf(w, peak.i)}.${
    thr === null ? '' : crossed ? ` It crossed your alert level (${axisVal(thr, panel.id)}) at ${clockOf(w, crossed.i)}.` : ` It never crossed your alert level (${axisVal(thr, panel.id)}).`
  }`;
  const grid = [0, 0.5, 1].map((f) => {
    const gy = y(top * f);
    return [
      svg('line', { x1: pad.l, x2: W - pad.r, y1: gy, y2: gy, class: 'oh-grid' }),
      svg('text', { x: pad.l - 4, y: gy + 4, class: 'oh-axis', 'text-anchor': 'end' }, axisVal(top * f, panel.id)),
    ];
  });
  const cursor = svg('circle', { cx: x(now.i), cy: y(now.v), r: 4, class: 'oh-dot' });
  const chart = svg(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'oh-chart', role: 'img', 'aria-label': summary },
    grid,
    svg('text', { x: pad.l, y: H - 4, class: 'oh-axis' }, clockOf(w, i0)),
    svg('text', { x: W - pad.r, y: H - 4, class: 'oh-axis', 'text-anchor': 'end' }, clockOf(w, i1)),
    thr !== null && thr <= top ? [svg('line', { x1: pad.l, x2: W - pad.r, y1: y(thr), y2: y(thr), class: 'oh-thr' }), svg('text', { x: W - pad.r, y: y(thr) - 3, class: 'oh-axis oh-thr-label', 'text-anchor': 'end' }, 'alert level')] : null,
    svg('polyline', { points: data.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '), class: 'oh-line', fill: 'none' }),
    cursor,
  );
  // Slide to read one point as text: the time and the value.
  const readout = el('p', { class: 'oh-readout', role: 'status', 'aria-live': 'polite', text: `Now (${clockOf(w, now.i)}): ${fmtVal(now.v, panel.id)}` });
  const slider = el('input', { class: 'oh-scrub', type: 'range', min: 0, max: data.length - 1, value: data.length - 1, 'aria-label': `Read ${panel.title} at a point in time` });
  slider.addEventListener('input', () => {
    const p = data[Number(slider.value)];
    cursor.setAttribute('cx', String(x(p.i)));
    cursor.setAttribute('cy', String(y(p.v)));
    readout.textContent = `${clockOf(w, p.i)}: ${fmtVal(p.v, panel.id)}`;
  });
  return { chart, summary, slider, readout };
}

// One panel at a time: tabs choose which, so the page stays short.
function panelNode(state, panel) {
  const w = state;
  const slow = panel.id === 1 && dashSlow(w);
  const data = panelSeries(w, panel.id);
  const now = data[data.length - 1];
  const expr = panelExpr(w, panel.id);
  const head = el('div', { class: 'oh-panel-head' }, el('strong', { text: panel.title }), el('span', { class: 'oh-type', text: panel.type }), el('span', { class: 'oh-now', text: slow ? 'timeout' : fmtVal(now.v, panel.id) }));
  if (slow) return el('div', { class: 'oh-panel', role: 'listitem', 'data-panel': panel.id }, head, el('p', { class: 'oh-slow', text: 'Loading... this query takes about 10 s and times out. Precompute it with a recording rule.' }), el('code', { class: 'oh-expr', text: expr }));
  const c = chartFor(w, panel);
  return el('div', { class: 'oh-panel', role: 'listitem', 'data-panel': panel.id }, head, c.chart, c.slider, c.readout, el('p', { class: 'oh-summary', text: c.summary }), el('code', { class: 'oh-expr', text: expr }));
}

function renderDashboard(state, d) {
  const shown = PANELS.find((p) => p.id === state.panelId) || PANELS[0];
  d.tabs.replaceChildren(
    ...PANELS.map((p) => {
      const tab = el('button', { class: 'oh-tab', type: 'button', 'aria-pressed': String(p.id === shown.id), text: p.title });
      tab.addEventListener('click', () => {
        state.panelId = p.id;
        renderDashboard(state, d);
      });
      return tab;
    }),
  );
  d.panels.replaceChildren(panelNode(state, shown));
}

// ---------------------------------------------------------------- the night timeline

function timelineNode(w) {
  const W = 360;
  const left = 16;
  const scale = (W - 2 * left) / NIGHT_MIN;
  const x = (i) => left + (i - w.H) * scale;
  const incs = w.incidents.filter((i) => i.night && i.started);
  const letters = incs.map((_, k) => String.fromCharCode(65 + k));
  const parts = [svg('rect', { x: x(w.H + 60), y: 4, width: 420 * scale, height: 86, class: 'oh-asleep' })];
  for (let h = 0; h <= 9; h += 1) {
    const hx = x(w.H + h * 60);
    parts.push(svg('line', { x1: hx, x2: hx, y1: 90, y2: 94, class: 'oh-grid' }));
    if (h % 2 === 0) parts.push(svg('text', { x: hx, y: 107, class: 'oh-axis', 'text-anchor': 'middle' }, clockText(22 * 60 + h * 60)));
  }
  parts.push(svg('text', { x: x(w.H + 270), y: 122, class: 'oh-axis', 'text-anchor': 'middle' }, 'asleep (23:00 to 06:00)'));
  // Overlapping incidents go on separate rows.
  const rowEnd = [];
  incs.forEach((inc, k) => {
    const last = Math.min(inc.end, w.H + NIGHT_MIN);
    let row = rowEnd.findIndex((e) => e <= inc.start);
    if (row < 0) row = rowEnd.length;
    rowEnd[row] = last + 25;
    const by = 8 + Math.min(row, 2) * 17;
    const bx = x(inc.start);
    const bw = Math.max(3, (last - inc.start) * scale);
    parts.push(svg('rect', { x: bx, y: by, width: bw, height: 14, class: inc.urgent ? 'oh-bar oh-bar-urgent' : 'oh-bar' }), svg('text', { x: bx + bw / 2, y: by + 12, class: 'oh-letter', 'text-anchor': 'middle' }, letters[k]));
  });
  for (const n of w.night) {
    const nx = x(n.t);
    if (n.severity === 'critical') {
      const real = n.verdict === 'actionable';
      parts.push(svg('polygon', { points: `${nx},58 ${nx - 5},70 ${nx + 5},70`, class: real ? 'oh-page' : 'oh-page oh-page-false' }));
    } else {
      parts.push(svg('rect', { x: nx - 3, y: 76, width: 7, height: 7, class: 'oh-ticket' }));
    }
  }
  if (w.now < w.H + NIGHT_MIN) parts.push(svg('line', { x1: x(w.now), x2: x(w.now), y1: 4, y2: 90, class: 'oh-now-line' }));
  const label = `Night timeline from 22:00 to 07:00. ${plural(incs.length, 'incident')} so far, ${plural(w.stats.pages, 'page')} (${w.stats.falsePages} false), ${plural(w.stats.tickets, 'ticket')}.`;
  return {
    chart: svg('svg', { viewBox: `0 0 ${W} 130`, class: 'oh-timeline', role: 'img', 'aria-label': label }, parts),
    legend: incs.map((inc, k) => el('span', { class: 'oh-key', role: 'listitem' }, el('b', { text: letters[k] }), ` ${clockOf(w, inc.start)} ${inc.title}${inc.urgent ? ' (needs a page)' : ' (no page needed)'}`)),
  };
}

// ---------------------------------------------------------------- rules and the replay

function ruleBacktestLine(w, rule, bt) {
  if (rule.kind === 'record') return recordedExpr(w) && rule.name ? 'Recorded: the request-rate panel now queries this series.' : 'Stores the result under this name every evaluation.';
  const crit = rule.severity === 'critical';
  const count = crit ? bt.pages : bt.tickets;
  if (!count) return 'Past 7 days: it would never have fired.';
  const caught = bt.incidents.filter((i) => i.urgent && i.status === 'caught').length;
  const urgent = bt.incidents.filter((i) => i.urgent).length;
  const bits = [crit ? `${plural(bt.pages, 'page')} (${bt.falsePages} false, ${bt.overnight} overnight)` : `${plural(bt.tickets, 'ticket')}, nobody woken`];
  if (urgent) bits.push(`${caught} of ${urgent} real incidents paged`);
  return `Past 7 days: ${bits.join('; ')}.`;
}

function incidentOutcome(w, inc) {
  if (!inc.urgent) return 'no page (good)';
  if (inc.status === 'caught') {
    const lead = inc.event === 'disk-fill' ? ` and ${Math.max(0, w.incidents.find((x) => x.id === inc.id).impactStart - (inc.start + inc.after))} minutes before it filled` : '';
    return `paged by ${inc.byRule}, ${inc.after} min in${lead}`;
  }
  if (inc.status === 'ticket') return 'only a ticket: nobody acts on it until morning';
  return inc.urgent ? 'MISSED: nothing paged' : 'no page (good)';
}

// ---------------------------------------------------------------- render

function setMeter(node, label, value) {
  node.fill.style.width = `${Math.round(value)}%`;
  node.fill.dataset.level = value >= 70 ? 'ok' : value >= 40 ? 'warn' : 'bad';
  node.bar.setAttribute('aria-valuenow', String(Math.round(value)));
  node.text.textContent = `${label} ${Math.round(value)}%`;
}

function render(state, ctx) {
  const d = state.dom;
  const over = ctx.over;
  const hour = hourOf(state);
  const done = nightOver(state);
  // Status strip
  d.clock.textContent = done ? '07:00' : clockOf(state, state.now);
  d.clockSub.textContent = done ? 'Morning' : hour === 0 ? 'Before the shift' : `Hour ${hour} of 9 done`;
  setMeter(d.sleep, 'Sleep', state.sleep);
  setMeter(d.slo, 'SLO', state.slo);
  const lastPage = [...state.night].reverse().find((n) => n.severity === 'critical');
  d.phoneCount.textContent = String(state.stats.pages);
  d.phoneText.textContent = lastPage ? `Last page ${clockOf(state, lastPage.t)}: ${lastPage.name}${lastPage.verdict === 'false' ? ' (false)' : ''}` : 'Quiet so far';
  d.phone.dataset.buzz = String(Boolean(lastPage) && state.now - lastPage.t <= 60 && !done);
  d.note.textContent = state.message || '';
  d.note.hidden = !state.message;

  // Warm-up: read each graph, pick its type and what to do with it, and see what the alert would do
  d.warm.hidden = state.quiz.items.length === 0;
  if (state.quiz.items.length) {
    d.warmHead.textContent = quizDone(state) ? 'Warm-up complete' : `Warm-up: read the graphs (${state.quiz.done.filter(Boolean).length} of ${state.quiz.items.length})`;
    // One signal at a time: the one to read now, with the finished ones folded to a line.
    const current = state.quiz.done.indexOf(false);
    state.quiz.items.forEach((item, k) => {
      const row = d.quiz[k];
      const ok = state.quiz.done[k];
      row.root.dataset.done = String(ok);
      row.root.dataset.compact = String(ok);
      row.root.hidden = current !== -1 && k > current;
      row.status.textContent = ok ? `Correct: a ${item.type}; ${item.fn === 'nothing' ? 'use it as it is' : `${item.fn}() first`}. ${item.why}` : row.feedback;
      row.status.dataset.ok = String(ok);
      for (const [value, chip] of row.typeChips) chip.setAttribute('aria-pressed', String(row.choice.type === value));
      for (const [value, chip] of row.fnChips) chip.setAttribute('aria-pressed', String(row.choice.fn === value));
      for (const chip of [...row.typeChips.values(), ...row.fnChips.values()]) chip.disabled = ok || over;
      row.btn.disabled = ok || over || !row.choice.type || !row.choice.fn;
      row.btn.hidden = ok;
    });
  }

  // Dashboard and timeline
  renderDashboard(state, d);
  const tl = timelineNode(state);
  d.timeline.replaceChildren(tl.chart);
  d.legend.replaceChildren(...(tl.legend.length ? tl.legend : [el('span', { class: 'oh-key', role: 'listitem', text: 'Nothing has happened yet.' })]));

  // Rules
  const cacheKey = (r) => JSON.stringify([r, state.route.groupBy]);
  const items = state.rules.map((r) => {
    const key = cacheKey(r);
    let bt = state.btCache.get(key);
    if (!bt && r.kind !== 'record') {
      bt = backtest(state, [r], state.route);
      state.btCache.set(key, bt);
    }
    const sev = r.kind === 'record' ? 'recording rule' : r.severity === 'critical' ? 'critical: pages you' : 'warning: ticket only';
    const forText = r.kind === 'record' ? '' : r.for && r.for !== '0m' ? `  for: ${r.for}` : '  no for:';
    const edit = el('button', { class: 'oh-btn', type: 'button', text: 'Edit', 'aria-label': `Edit ${r.name}` });
    const del = el('button', { class: 'oh-btn', type: 'button', text: 'Remove', 'aria-label': `Remove ${r.name}` });
    edit.disabled = over;
    del.disabled = over;
    edit.addEventListener('click', () => openEditor(state, ctx, r));
    del.addEventListener('click', () => {
      if (state.draft && state.draft.id === r.id) closeEditor(state);
      ctx.act('removeRule', r.id);
    });
    // A rule is a line (name, severity, how it did over the last week); tap it for the PromQL and the buttons.
    const card = el(
      'details',
      { class: 'oh-rule', role: 'listitem', 'data-rule': r.id },
      el('summary', { class: 'oh-rule-sum' }, el('span', { class: 'oh-rule-head' }, el('strong', { class: 'oh-name', text: r.name }), el('span', { class: `oh-badge oh-sev-${r.kind === 'record' ? 'rec' : r.severity}`, text: sev })), el('span', { class: 'oh-bt', text: ruleBacktestLine(state, r, bt || {}) })),
      el('code', { class: 'oh-expr', text: `${exprOf(r)}${forText}` }),
      el('div', { class: 'oh-rule-actions' }, edit, del),
    );
    card.open = state.openRules.has(r.id);
    card.addEventListener('toggle', () => (card.open ? state.openRules.add(r.id) : state.openRules.delete(r.id)));
    return card;
  });
  d.rules.replaceChildren(...(items.length ? items : [el('p', { class: 'oh-empty', role: 'listitem', text: 'No rules. Nothing will page you, and nothing will tell you the service is down.' })]));
  d.addAlert.disabled = over;
  d.addRecord.disabled = over;
  d.group.value = state.route.groupBy;
  d.groupHelp.textContent = `In effect: ${GROUP_HELP[state.route.groupBy]}`;
  d.group.disabled = over;
  d.saveRoute.disabled = over;
  d.routeYaml.textContent = routeYaml(state.route);
  d.rulesYaml.textContent = rulesYaml(state.rules);
  d.editor.root.querySelectorAll('input, select, button').forEach((c) => {
    if (over) c.disabled = true;
  });

  // Replay of the past week with the whole rule set
  const key = JSON.stringify([state.rules, state.route]);
  if (state.replayKey !== key) {
    state.replayKey = key;
    state.replay = backtest(state, state.rules, state.route);
  }
  const bt = state.replay;
  const urgent = bt.incidents.filter((i) => i.urgent);
  d.replaySummary.textContent = `With these rules the last week would have produced ${plural(bt.pages, 'page')} (${bt.falsePages} false, ${bt.duplicates} duplicate, ${bt.overnight} overnight) and ${plural(bt.tickets, 'ticket')}. Real incidents paged: ${urgent.filter((i) => i.status === 'caught').length} of ${urgent.length}.`;
  const noise = bt.notifs.filter((n) => n.verdict === 'false');
  d.replayRows.replaceChildren(
    ...bt.incidents.map((inc) => {
      const falseHere = noise.filter((n) => n.incAny === inc.id);
      const outcome = falseHere.length ? `FALSE PAGE from ${[...new Set(falseHere.map((n) => n.name))].join(', ')}` : incidentOutcome(state, inc);
      const cls = falseHere.length || (inc.urgent && inc.status !== 'caught') ? 'oh-bad' : 'oh-good';
      return el(
        'div',
        { class: 'oh-row', role: 'row' },
        el('span', { class: 'oh-cell oh-when', role: 'cell', text: whenText(state, inc.start) }),
        el('span', { class: 'oh-cell', role: 'cell' }, el('b', { text: inc.title }), inc.urgent ? ' (needs a page)' : ' (no page needed)'),
        el('span', { class: `oh-cell oh-result ${cls}`, role: 'cell', text: outcome }),
      );
    }),
  );
  const stray = noise.filter((n) => n.incAny === null);
  if (stray.length) {
    d.replayRows.append(el('div', { class: 'oh-row', role: 'row' }, el('span', { class: 'oh-cell oh-when', role: 'cell', text: 'any time' }), el('span', { class: 'oh-cell', role: 'cell' }, el('b', { text: 'Pages with no incident behind them' })), el('span', { class: 'oh-cell oh-result oh-bad', role: 'cell', text: `${plural(stray.length, 'false page')} from ${[...new Set(stray.map((n) => n.name))].join(', ')}` })));
  }

  // Morning report
  d.report.hidden = !done && !over;
  if (done || over) {
    const s = stars(state);
    const urgentNight = state.incidents.filter((i) => i.night && i.urgent);
    const caught = urgentNight.filter((i) => i.pageAt !== null).length;
    const lines = [
      ['Real incidents paged', `${caught} of ${urgentNight.length}`],
      ['False pages', String(state.stats.falsePages)],
      ['Duplicate pages', String(state.stats.duplicates)],
      ['Tickets', String(state.stats.tickets)],
      ['Minutes of user impact', String(state.bad)],
      ['Sleep left', `${Math.round(state.sleep)}%`],
      ['SLO left', `${Math.round(state.slo)}%`],
      ['Stars', `${'★'.repeat(s.count)}${'☆'.repeat(3 - s.count)} (${s.count} of 3)`],
    ];
    d.reportRows.replaceChildren(...lines.map(([k, v]) => el('div', { class: 'oh-row', role: 'row' }, el('span', { class: 'oh-cell', role: 'cell', text: k }), el('b', { class: 'oh-cell', role: 'cell', text: v }))));
    d.reportNotes.replaceChildren(
      ...[
        `Stars: SLO at or above ${state.level.sloTarget}% ${s.slo ? '(earned)' : '(missed)'}; at most one false page ${s.quiet ? '(earned)' : '(missed)'}; every page actionable ${s.clean ? '(earned)' : '(missed)'}.`,
        ...(state.failReasons.length ? ['What went wrong:', ...state.failReasons] : []),
      ].map((t) => el('p', { class: 'oh-note-line', text: t })),
    );
  }

}

// ---------------------------------------------------------------- the rule editor

const DEFAULT_ALERT = { kind: 'alert', name: '', metric: 'err', fn: 'ratio', window: '5m', q: 0.95, horizon: 4, op: '>', threshold: 0.05, for: '5m', severity: 'critical' };
const DEFAULT_RECORD = { kind: 'record', name: '', metric: 'req', fn: 'rate', window: '5m' };

function openEditor(state, ctx, rule) {
  const base = rule ? { ...rule } : state.nextKind === 'record' ? { ...DEFAULT_RECORD } : { ...DEFAULT_ALERT, name: `NewAlert${state.nextRuleId}` };
  state.draft = base;
  state.dom.editor.root.hidden = false;
  syncEditor(state, true);
  state.dom.editor.name.focus();
}

function closeEditor(state) {
  state.draft = null;
  state.dom.editor.root.hidden = true;
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([v, label]) => el('option', { value: v, text: label })));
  select.value = String(value);
  if (select.value !== String(value) && options.length) select.value = String(options[0][0]);
}

// Bring every field and the preview in line with the draft.
function syncEditor(state, full = false) {
  const e = state.dom.editor;
  const r = state.draft;
  if (!r) return;
  const isAlert = r.kind !== 'record';
  const m = METRICS[r.metric];
  if (!m.fns.includes(r.fn)) r.fn = m.fns[0];
  if (full) {
    e.title.textContent = r.id ? `Edit ${r.name}` : isAlert ? 'New alerting rule' : 'New recording rule';
    e.name.value = r.name;
    e.name.placeholder = isAlert ? 'HighErrorRatio' : 'job:http_requests:rate5m';
    fillSelect(e.metric, Object.keys(METRICS).map((k) => [k, METRIC_LABELS[k]]), r.metric);
  }
  fillSelect(e.fn, m.fns.filter((f) => isAlert || f !== 'raw').map((f) => [f, FN_LABELS[f]]), r.fn);
  r.fn = e.fn.value;
  const wins = windowsFor(r);
  if (needsWindow(r)) {
    if (!wins.includes(r.window)) r.window = wins.includes('5m') ? '5m' : wins[0];
    fillSelect(e.window, wins.map((x) => [x, x]), r.window);
  }
  e.windowWrap.hidden = !needsWindow(r);
  e.qWrap.hidden = r.fn !== 'quantile';
  if (r.fn === 'quantile') fillSelect(e.q, QUANTILES.map((x) => [x, String(x)]), r.q ?? 0.95);
  e.horizonWrap.hidden = r.fn !== 'predict_linear';
  if (r.fn === 'predict_linear') fillSelect(e.horizon, HORIZONS.map((x) => [x, `${x} h ahead`]), r.horizon ?? 4);
  for (const wrap of [e.opWrap, e.thrWrap, e.forWrap, e.sevWrap]) wrap.hidden = !isAlert;
  if (isAlert) {
    if (full) {
      fillSelect(e.op, [['>', '>  above'], ['<', '<  below']], r.op);
      fillSelect(e.forSel, FORS.map((x) => [x, x === '0m' ? '0m (no for:)' : x]), r.for);
      fillSelect(e.sev, SEVERITIES.map((x) => [x, x === 'critical' ? 'critical: pages you' : 'warning: ticket only']), r.severity);
      e.thr.value = String(r.threshold);
    }
    e.unit.textContent = unitFor(r);
  }
  // Preview
  const spec = { ...r, name: e.name.value.trim() || (isAlert ? 'Unnamed' : 'level:metric:operation') };
  e.promql.textContent = !isAlert ? valueExpr(spec) : Number.isFinite(Number(spec.threshold)) ? exprOf(spec) : `${valueExpr(spec)} ${spec.op} ?`;
  e.yaml.textContent = rulesYaml([{ ...spec, id: 'draft' }]);
  const problem = validateRule(state, { ...spec, id: r.id });
  e.check.textContent = problem || (isAlert ? 'Valid PromQL. The replay below shows how this rule alone would have behaved.' : 'Valid recording rule.');
  e.check.dataset.ok = String(!problem);
  if (isAlert && !problem) {
    const bt = backtest(state, [{ ...spec, id: 'draft', threshold: Number(spec.threshold) }], state.route);
    e.replay.replaceChildren(...draftReplay(state, bt));
  } else {
    e.replay.replaceChildren(el('p', { class: 'oh-bt', text: isAlert ? 'Fix the rule to see its replay.' : 'A recording rule does not alert. Write the expensive query once, and dashboards read the stored series.' }));
  }
}

function draftReplay(state, bt) {
  const crit = state.draft.severity === 'critical';
  const lines = [];
  const urgent = bt.incidents.filter((i) => i.urgent);
  lines.push(
    el('p', { class: 'oh-bt', text: bt.notifs.length ? `Last 7 days, this rule alone: ${crit ? `${plural(bt.pages, 'page')} (${bt.falsePages} false, ${bt.overnight} overnight)` : `${plural(bt.tickets, 'ticket')}`}.` : 'Last 7 days: it would never have fired.' }),
  );
  for (const inc of urgent) lines.push(el('p', { class: 'oh-bt', text: `${whenText(state, inc.start)} ${inc.title}: ${incidentOutcome(state, inc)}.` }));
  const falses = bt.notifs.filter((n) => n.verdict === 'false').slice(0, 5);
  for (const n of falses) lines.push(el('p', { class: 'oh-bt oh-bad', text: `False page ${whenText(state, n.t)}.` }));
  if (bt.falsePages > falses.length) lines.push(el('p', { class: 'oh-bt oh-bad', text: `...and ${bt.falsePages - falses.length} more false pages.` }));
  return lines;
}

function buildEditor(state, ctx) {
  const field = (label, control, extra) => el('label', { class: 'oh-field' }, el('span', { class: 'oh-label', text: label }), control, extra);
  const name = el('input', { class: 'oh-input', type: 'text', maxlength: 60, autocomplete: 'off', spellcheck: 'false' });
  const metric = el('select', { class: 'oh-input' });
  const fn = el('select', { class: 'oh-input' });
  const win = el('select', { class: 'oh-input' });
  const q = el('select', { class: 'oh-input' });
  const horizon = el('select', { class: 'oh-input' });
  const op = el('select', { class: 'oh-input' });
  const thr = el('input', { class: 'oh-input', type: 'number', step: 'any', inputmode: 'decimal' });
  const unit = el('span', { class: 'oh-unit' });
  const forSel = el('select', { class: 'oh-input' });
  const sev = el('select', { class: 'oh-input' });
  const save = el('button', { class: 'oh-btn oh-btn-primary', type: 'submit', text: 'Save rule' });
  const cancel = el('button', { class: 'oh-btn', type: 'button', text: 'Cancel' });
  const promql = el('code', { class: 'oh-expr oh-expr-big' });
  const yaml = el('pre', { class: 'oh-yaml', tabindex: 0, 'aria-label': 'Rule as it appears in rules.yml' });
  const check = el('p', { class: 'oh-check', role: 'status' });
  const replay = el('div', { class: 'oh-replay-draft' });
  const title = el('h4', { class: 'oh-h' });
  const wrap = {
    windowWrap: field('Window', win),
    qWrap: field('Quantile', q),
    horizonWrap: field('Look ahead', horizon),
    opWrap: field('Compare', op),
    thrWrap: field('Threshold', thr, unit),
    forWrap: field('for:', forSel),
    sevWrap: field('severity:', sev),
  };
  const root = el(
    'form',
    { class: 'oh-editor', hidden: true, 'aria-label': 'Rule editor' },
    title,
    el(
      'div',
      { class: 'oh-fields' },
      field('Name', name),
      field('Metric', metric),
      field('Function', fn),
      wrap.windowWrap,
      wrap.qWrap,
      wrap.horizonWrap,
      wrap.opWrap,
      wrap.thrWrap,
      wrap.forWrap,
      wrap.sevWrap,
    ),
    el('span', { class: 'oh-label', text: 'PromQL' }),
    promql,
    check,
    el('details', { class: 'oh-details' }, el('summary', { text: 'As it appears in rules.yml' }), yaml),
    replay,
    el('div', { class: 'oh-rule-actions' }, save, cancel),
  );
  const draft = () => state.draft;
  const on = (node, prop, read) =>
    node.addEventListener('change', () => {
      if (!draft()) return;
      draft()[prop] = read();
      syncEditor(state);
    });
  name.addEventListener('input', () => {
    if (!draft()) return;
    draft().name = name.value;
    syncEditor(state);
  });
  metric.addEventListener('change', () => {
    if (!draft()) return;
    draft().metric = metric.value;
    syncEditor(state);
  });
  on(fn, 'fn', () => fn.value);
  on(win, 'window', () => win.value);
  on(q, 'q', () => Number(q.value));
  on(horizon, 'horizon', () => Number(horizon.value));
  on(op, 'op', () => op.value);
  on(forSel, 'for', () => forSel.value);
  on(sev, 'severity', () => sev.value);
  thr.addEventListener('input', () => {
    if (!draft()) return;
    draft().threshold = thr.value === '' ? NaN : Number(thr.value);
    syncEditor(state);
  });
  root.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!draft()) return;
    const spec = { ...draft(), name: name.value.trim() };
    if (ctx.act('saveRule', spec)) closeEditor(state);
  });
  cancel.addEventListener('click', () => {
    closeEditor(state);
    state.message = '';
    render(state, ctx);
  });
  return { root, title, name, metric, fn, window: win, q, horizon, op, thr, unit, forSel, sev, save, cancel, promql, yaml, check, replay, ...wrap };
}

// ---------------------------------------------------------------- the game

registerGame({
  id: 'observability',
  styles: 'game.css',

  init(state, ctx) {
    Object.assign(state, createWorld(ctx.scenario, ctx.rng));
    state.btCache = new Map();
    state.replayKey = null;
    state.draft = null;
    state.nextKind = 'alert';
    state.openRules = new Set();

    const meter = (label) => {
      const fill = el('div', { class: 'oh-meter-fill' });
      const bar = el('div', { class: 'oh-meter', role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 100 }, fill);
      const text = el('span', { class: 'oh-meter-text' });
      return { fill, bar, text, root: el('div', { class: 'oh-meter-wrap' }, text, bar) };
    };
    const sleep = meter('Sleep');
    const slo = meter('SLO');
    const clock = el('strong', { class: 'oh-clock' });
    const clockSub = el('span', { class: 'oh-sub' });
    const phoneCount = el('strong', { class: 'oh-phone-count' });
    const phoneText = el('span', { class: 'oh-sub' });
    const phone = el('div', { class: 'oh-phone', 'data-buzz': 'false' }, el('span', { class: 'oh-sub', text: 'Pages tonight' }), phoneCount, phoneText);
    const strip = el('div', { class: 'oh-strip' }, el('div', { class: 'oh-clockbox' }, el('span', { class: 'oh-sub', text: 'Clock' }), clock, clockSub), phone, el('div', { class: 'oh-meters' }, sleep.root, slo.root));
    const note = el('p', { class: 'oh-msg', role: 'status', hidden: true });

    // Warm-up: a graph per signal, chips for its type and for what to do with it, then Check
    const warmHead = el('h4', { class: 'oh-h' });
    const quiz = state.quiz.items.map((item, k) => {
      const choice = { type: '', fn: '' };
      const row = { choice, feedback: '', typeChips: new Map(), fnChips: new Map() };
      const chip = (map, key, value, label, group) => {
        const b = el('button', { class: 'oh-chip', type: 'button', 'aria-pressed': 'false', text: label });
        b.addEventListener('click', () => {
          choice[key] = value;
          row.feedback = '';
          render(state, ctx);
        });
        map.set(value, b);
        return b;
      };
      const typeRow = el('div', { class: 'oh-chips', role: 'group', 'aria-label': `Type of ${item.signal}` }, ...TYPES.map((t) => chip(row.typeChips, 'type', t, t)));
      const fnRow = el('div', { class: 'oh-chips', role: 'group', 'aria-label': `What to do with ${item.signal} before graphing` }, ...QUIZ_FNS.map(([v, l]) => chip(row.fnChips, 'fn', v, l)));
      const btn = el('button', { class: 'oh-btn', type: 'button', text: 'Check', 'aria-label': `Check the answer for ${item.signal}` });
      const status = el('p', { class: 'oh-ok', role: 'status', 'aria-live': 'polite' });
      btn.addEventListener('click', () => {
        ctx.act('classify', k, choice.type, choice.fn);
        if (!state.quiz.done[k]) {
          // The card says what the wrong choice would have done; the reason comes when it is right.
          row.feedback = consequence(item, choice);
          state.message = '';
          choice.fn = '';
          render(state, ctx);
        }
      });
      row.root = el(
        'div',
        { class: 'oh-quiz', role: 'listitem' },
        el('div', { class: 'oh-quiz-top' }, sparkFor(item.shape || item.type), el('code', { class: 'oh-expr', text: item.signal }), el('span', { class: 'oh-hint', text: item.hint })),
        el('span', { class: 'oh-label', text: 'What type is it?' }),
        typeRow,
        el('span', { class: 'oh-label', text: 'What do you do with it first?' }),
        fnRow,
        btn,
        status,
      );
      Object.assign(row, { btn, status });
      return row;
    });
    const warm = el('section', { class: 'oh-sec', 'aria-label': 'Warm-up' }, warmHead, el('div', { role: 'list', 'aria-label': 'Signals to read' }, ...quiz.map((x) => x.root)));

    // Dashboard, timeline
    const tabs = el('div', { class: 'oh-tabs', role: 'group', 'aria-label': 'Dashboard panels' });
    const panels = el('div', { class: 'oh-panels', role: 'list', 'aria-label': 'Dashboard panel' });
    state.panelId = PANELS[0].id;
    const timeline = el('div', { class: 'oh-timeline-wrap' });
    const legend = el('div', { class: 'oh-legend', role: 'list', 'aria-label': 'Incidents so far' });
    const key = el('p', { class: 'oh-keytext', text: 'Bars are incidents (solid: needs a page; dashed: no page needed). Triangles are pages (solid: real; hollow: false). Squares are tickets.' });

    // Rules
    const rules = el('div', { class: 'oh-rules', role: 'list', 'aria-label': 'Rules in effect' });
    const addAlert = el('button', { class: 'oh-btn', type: 'button', text: 'Add alerting rule' });
    const addRecord = el('button', { class: 'oh-btn', type: 'button', text: 'Add recording rule' });
    const editor = buildEditor(state, ctx);
    addAlert.addEventListener('click', () => {
      state.nextKind = 'alert';
      openEditor(state, ctx, null);
    });
    addRecord.addEventListener('click', () => {
      state.nextKind = 'record';
      openEditor(state, ctx, null);
    });
    const group = el('select', { class: 'oh-input', 'aria-label': 'Alertmanager group_by' });
    group.append(...GROUP_BYS.map((g) => el('option', { value: g, text: GROUP_LABELS[g] })));
    const groupHelp = el('p', { class: 'oh-hint' });
    const saveRoute = el('button', { class: 'oh-btn', type: 'button', text: 'Save route' });
    saveRoute.addEventListener('click', () => ctx.act('setRoute', group.value));
    const routeYamlEl = el('pre', { class: 'oh-yaml', tabindex: 0, 'aria-label': 'alertmanager.yml' });
    const rulesYamlEl = el('pre', { class: 'oh-yaml', tabindex: 0, 'aria-label': 'rules.yml' });

    // Replay
    const replaySummary = el('p', { class: 'oh-bt' });
    const replayRows = el('div', { class: 'oh-table', role: 'table', 'aria-label': 'Replay of the last week' });

    // Report
    const reportRows = el('div', { class: 'oh-table', role: 'table', 'aria-label': 'Morning report' });
    const reportNotes = el('div');
    const report = el('section', { class: 'oh-sec oh-report', 'aria-label': 'Morning report', hidden: true }, el('h4', { class: 'oh-h', text: 'Morning report' }), reportRows, reportNotes);

    // The parts of the night. On a wide screen they stack as folds; on a phone a tab bar shows one at a time,
    // so the page is one screen of the thing you are working on, not a scroll through all of it.
    const wide = matchMedia('(min-width: 700px)').matches;
    const parts = [
      { id: 'rules', tab: 'Rules', title: 'Rules in effect', kids: [rules, el('div', { class: 'oh-rule-actions' }, addAlert, addRecord), editor.root] },
      { id: 'charts', tab: 'Charts', title: 'Dashboard (Sample App Overview, last 6 hours)', kids: [tabs, panels] },
      { id: 'tonight', tab: 'Tonight', title: 'Night timeline', kids: [timeline, key, legend] },
      {
        id: 'route',
        tab: 'Route',
        title: 'Alertmanager route',
        kids: [
          el('p', { class: 'oh-hint', text: 'critical alerts page you (PagerDuty); warning alerts open a ticket in Slack. group_by decides how many pages one incident makes.' }),
          el('div', { class: 'oh-quiz-row' }, group, saveRoute),
          groupHelp,
          el('details', { class: 'oh-details' }, el('summary', { text: 'alertmanager.yml' }), routeYamlEl),
        ],
      },
      { id: 'replay', tab: 'Replay', title: 'Replay of the last week', kids: [replaySummary, replayRows] },
      { id: 'yaml', tab: 'rules.yml', title: 'rules.yml (what promtool checks)', kids: [rulesYamlEl] },
    ];
    const panelsEl = parts.map((part) => {
      if (wide) {
        const d = el('details', { class: 'oh-sec', 'data-part': part.id }, el('summary', { class: 'oh-sum', text: part.title }), ...part.kids);
        d.open = part.id === 'rules' || part.id === 'charts' || part.id === 'tonight';
        return d;
      }
      return el('section', { class: 'oh-sec oh-tabbed', 'data-part': part.id, 'aria-label': part.title }, ...part.kids);
    });
    const tabbar = wide ? null : el('div', { class: 'oh-tabbar', role: 'group', 'aria-label': 'Parts of the night' });
    const showPart = (id) => {
      for (const node of panelsEl) node.hidden = node.dataset.part !== id;
      for (const btn of tabbar.children) btn.setAttribute('aria-pressed', String(btn.dataset.part === id));
    };
    if (tabbar) {
      for (const part of parts) {
        const btn = el('button', { class: 'oh-tab', type: 'button', 'data-part': part.id, 'aria-pressed': 'false', text: part.tab });
        btn.addEventListener('click', () => showPart(part.id));
        tabbar.append(btn);
      }
    }
    const root = el('div', { class: 'oh' }, strip, note, report, warm, tabbar, ...panelsEl);
    if (tabbar) showPart('rules');
    state.dom = {
      root, clock, clockSub, sleep, slo, phone, phoneCount, phoneText, note, warm, warmHead, quiz, tabs, panels, timeline, legend, rules, addAlert, addRecord, editor,
      group, groupHelp, saveRoute, routeYaml: routeYamlEl, rulesYaml: rulesYamlEl, replaySummary, replayRows, report, reportRows, reportNotes,
    };
    ctx.ui.board.append(root);
    ctx.log(state.quiz.items.length ? 'Finish the warm-up, fix the rules, then press Next hour. Rules cost a move to change; time is free.' : 'Fix the rules, then press Next hour. Rules can change all night, but pages already sent cannot be taken back.', { kind: 'hint' });
  },

  // How a move reads in the debrief and in the efficient path.
  describeMove(name, args) {
    if (name === 'classify') return `Classify signal ${Number(args[0]) + 1}: a ${args[1]}, alert with ${args[2]}`;
    if (name === 'setRoute') return `Alertmanager group_by: ${args[0]}`;
    if (name === 'saveRule') {
      const r = args[0];
      return r.kind === 'record' ? `Record ${r.name}: ${r.fn}(${r.metric}[${r.window}])` : `Rule ${r.name}: ${r.fn} ${r.metric} ${r.op} ${r.threshold} for ${r.for} (${r.severity})`;
    }
    return undefined;
  },

  tick: (state, ctx) => tick(state, ctx),

  actions: {
    nextHour: {
      label: 'Next hour',
      key: 'h',
      run(state, ctx) {
        if (!quizDone(state)) {
          state.message = 'Finish the warm-up first: read every graph.';
          render(state, ctx);
          return false;
        }
        state.message = '';
        ctx.step(1);
        return 'free';
      },
    },
    toMorning: {
      label: 'Run to morning',
      run(state, ctx) {
        if (!quizDone(state)) {
          state.message = 'Finish the warm-up first: read every graph.';
          render(state, ctx);
          return false;
        }
        state.message = '';
        ctx.step(9);
        return 'free';
      },
    },
    classify: {
      hidden: true,
      run(state, ctx, index, type, fn) {
        const ok = classify(state, index, type, fn);
        if (!ok) return false;
        render(state, ctx);
        return true;
      },
    },
    saveRule: {
      hidden: true,
      run(state, ctx, spec) {
        const ok = saveRule(state, spec);
        if (!ok) {
          render(state, ctx);
          return false;
        }
        return true;
      },
    },
    removeRule: {
      hidden: true,
      run(state, ctx, id) {
        const ok = removeRule(state, id);
        if (!ok) {
          render(state, ctx);
          return false;
        }
        return true;
      },
    },
    setRoute: {
      hidden: true,
      run(state, ctx, groupBy) {
        if (!setRoute(state, groupBy)) {
          state.message = 'That is already the route in effect.';
          render(state, ctx);
          return false;
        }
        state.message = '';
        return true;
      },
    },
  },

  isWon: (state) => isWon(state),
  isLost: (state) => isLost(state),
  render,
});
