// Story mode, Observability: "Quiet Hours".
//
// A night ward: metrics are the bedside vitals, an alert is the pager, and a nurse who is paged for nothing stops
// answering. The story runs on the practice game's real simulator (docs/games/observability/sim.js): the charts are
// the simulated week and night, every alert is a real rule that is replayed against the last seven days, and the
// night is played through the real engine. Each chapter is a plain async script over it (see ../shared/story.js).
import { h, createCounters, outputBox, mountStory as mount, practiceLinks, siteUrl } from '../shared/story.js';
import { backtest, classify, createWorld, exprOf, nightOver, saveRule, tick, valueAt } from '../../games/observability/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/observability/notes/${name}/`);
const box = (text) => outputBox(text);

const seedRng = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// Which simulated series each warm-up signal is drawn from.
const SIGNAL = {
  http_requests_total: { metric: 'req', fn: 'raw', word: 'requests so far', alias: 'Requests' },
  job_queue_depth: { metric: 'queue', fn: 'raw', word: 'jobs waiting', alias: 'Queue' },
  http_request_duration_seconds_bucket: { metric: 'lat', fn: 'quantile', q: 0.95, window: '5m', word: 'seconds (p95)', alias: 'Latency' },
  'http_request_duration_seconds{quantile="0.95"}': { metric: 'lat', fn: 'quantile', q: 0.95, window: '5m', word: 'seconds (p95)', alias: 'p95 line' },
  node_filesystem_avail_bytes: { metric: 'disk', fn: 'raw', word: 'GB free', alias: 'Disk' },
  up: { metric: 'up', fn: 'raw', word: '1 = answering, 0 = down', alias: 'Up' },
};

const fmtNum = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, ''));
const EVENT_WORD = { 'error-spike': 'The error spike', 'latency-creep': 'The slow latency creep', 'disk-fill': 'The filling disk', 'rack-down': 'The dead rack' };
const DEFAULTS = { kind: 'alert', window: '5m', q: 0.95, horizon: 4, for: '0m', op: '>', severity: 'critical' };

// The ward: a chart of one vital, the week's replay of the current rules, and the night's scores.
function createWard(app, { data }) {
  const chartTitle = h('p', { class: 'qh-chart-title', hidden: true });
  const chart = h('div', { class: 'qh-chart', hidden: true });
  const chartNote = h('p', { class: 'qh-chart-note', hidden: true });
  const replay = h('div', { class: 'qh-replay', hidden: true });
  const counters = createCounters([
    { label: 'Sleep', cls: 'ks-hud-ok' },
    { label: 'Patient', cls: 'ks-hud-ok' },
  ]);
  app.caption.before(chartTitle, chart, chartNote, replay, counters.el);

  const A = { world: null, sc: null, lines: [] };
  const ctx = { ticks: 0, fire() {}, resolve() {}, log(t) { A.lines.push(String(t)); }, step() {}, rng: null, scenario: null };

  // The word for what a replay found, one line per kind of real incident.
  function describe(r) {
    const seen = new Set();
    const lines = [`Replay of the last 7 days`, `pages: ${r.pages} (${r.falsePages} false, ${r.duplicates} repeats), tickets: ${r.tickets}`];
    for (const i of r.incidents) {
      if (!i.urgent || seen.has(i.event)) continue;
      seen.add(i.event);
      const what = EVENT_WORD[i.event] || i.title;
      lines.push(`${what}: ${i.status === 'caught' ? `paged ${i.after} min after it began` : i.status === 'ticket' ? 'only a ticket, nobody woken' : 'MISSED'}`);
    }
    return lines.join('\n');
  }

  function paintReplay() {
    const w = A.world;
    if (!w) return;
    if (!A.replayOn) {
      replay.hidden = true;
      return;
    }
    const r = backtest(w, w.rules, w.route);
    const missed = r.incidents.filter((i) => i.urgent && i.status !== 'caught').length;
    replay.hidden = false;
    replay.replaceChildren(
      h('span', { text: 'Last week with your rules:' }),
      h('strong', { text: `${r.pages} pages` }),
      h('span', { class: r.falsePages ? 'qh-bad' : '', text: `${r.falsePages} false` }),
      h('span', { class: missed ? 'qh-bad' : '', text: missed ? `${missed} real missed` : 'all real caught' }),
    );
  }

  function paintScores() {
    const w = A.world;
    counters.el.hidden = !A.night;
    if (!A.night) return;
    counters.values[0].textContent = `${Math.round(w.sleep)}%`;
    counters.values[1].textContent = `${Math.round(w.slo)}%`;
    counters.el.children[0].className = w.sleep < w.level.minSleep ? 'ks-hud-bad' : 'ks-hud-ok';
    counters.el.children[1].className = w.slo < w.level.sloTarget ? 'ks-hud-bad' : 'ks-hud-ok';
  }

  Object.assign(A, {
    load(levelId) {
      const level = data.levels.find((l) => l.id === levelId);
      const { levels: _levels, ...rest } = data;
      A.sc = { ...rest, ...level };
      ctx.scenario = A.sc;
      ctx.ticks = 0;
      A.night = false;
      A.replayOn = false;
      A.world = createWorld(A.sc, seedRng(A.sc.seed || 7));
      A.lines = [];
      chartTitle.hidden = true;
      chart.hidden = true;
      chartNote.hidden = true;
      paintReplay();
      paintScores();
    },
    // Draw one vital. `during` = the night (otherwise the last 8 hours before it).
    chart(signal, during = false) {
      const w = A.world;
      const spec = SIGNAL[signal];
      const from = during ? w.H : w.H - 480;
      const to = during ? w.H + 540 : w.H;
      const pts = [];
      for (let i = from; i < to; i += 5) {
        const v = valueAt(w, { window: '5m', q: 0.95, ...spec }, i);
        if (Number.isFinite(v)) pts.push(v);
      }
      const lo = Math.min(...pts);
      const hi = Math.max(...pts);
      const span = hi - lo || 1;
      const X = (k) => (k / Math.max(1, pts.length - 1)) * 300;
      const Y = (v) => 76 - ((v - lo) / span) * 68;
      const line = svg('polyline', { points: pts.map((v, k) => `${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), fill: 'none', 'stroke-width': '2.5', class: 'qh-line' });
      const top = svg('text', { x: '2', y: '10', class: 'qh-svg-text' });
      top.textContent = `max ${fmtNum(hi)}`;
      const bottom = svg('text', { x: '2', y: '79', class: 'qh-svg-text' });
      bottom.textContent = `min ${fmtNum(lo)}`;
      const s = svg('svg', { viewBox: '0 0 300 82', role: 'img', 'aria-label': `${signal}: starts at ${fmtNum(pts[0])}, ends at ${fmtNum(pts[pts.length - 1])}, lowest ${fmtNum(lo)}, highest ${fmtNum(hi)} (${spec.word})` });
      s.append(svg('rect', { x: '0', y: '0', width: '300', height: '82', class: 'qh-bg' }), line, top, bottom);
      chart.replaceChildren(s);
      chartTitle.textContent = signal;
      chartNote.textContent = `${during ? 'Tonight' : 'Last 8 hours'}: ${spec.word}. From ${fmtNum(pts[0])} to ${fmtNum(pts[pts.length - 1])}.`;
      chartTitle.hidden = false;
      chart.hidden = false;
      chartNote.hidden = false;
    },
    showReplay() {
      A.replayOn = true;
      paintReplay();
    },
    hideChart() {
      chartTitle.hidden = true;
      chart.hidden = true;
      chartNote.hidden = true;
    },
    classify(index, type, fn) {
      const w = A.world;
      const ok = w.quiz.items[index].type === type && w.quiz.items[index].fn === fn;
      classify(w, index, type, fn);
      return ok;
    },
    // The rules as they would be with this candidate in place of `replaces`, replayed against the last week.
    candidate(spec, replaces) {
      const w = A.world;
      const base = { ...DEFAULTS, ...spec };
      if (base.fn === 'raw') delete base.window;
      const rules = w.rules.map((r) => (r.name === replaces ? { ...base, id: r.id } : r));
      if (!w.rules.some((r) => r.name === replaces)) rules.push({ ...base, id: 'cand' });
      return { result: backtest(w, rules, w.route), rules };
    },
    setRule(spec, replaces) {
      const w = A.world;
      const cur = w.rules.find((r) => r.name === replaces);
      saveRule(w, cur ? { ...DEFAULTS, ...spec, id: cur.id } : { ...DEFAULTS, ...spec });
      paintReplay();
    },
    route(groupBy) {
      A.world.route = { groupBy };
      paintReplay();
    },
    current: () => backtest(A.world, A.world.rules, A.world.route),
    describe,
    // A rule's PromQL, for the cards.
    expr: (spec) => exprOf({ ...DEFAULTS, ...spec }),
    // Play the night. Returns what the pager did.
    runNight() {
      const w = A.world;
      A.night = true;
      A.lines = [];
      while (!nightOver(w) && w.sleep > 0) tick(w, ctx);
      paintScores();
      return A.lines.map((l) => l.replace(/^\d\d:\d\d /, (m) => m)).join('\n');
    },
    stats() {
      const w = A.world;
      return { pages: w.stats.pages, actionable: w.stats.actionable, falsePages: w.stats.falsePages, duplicates: w.stats.duplicates, sleep: Math.round(w.sleep), slo: Math.round(w.slo), passed: Boolean(w.passed), reasons: w.failReasons };
    },
    caption(text) {
      app.caption.textContent = text || '';
    },
    reset() {
      A.world = null;
      A.sc = null;
      A.night = false;
      chart.replaceChildren();
      chart.hidden = true;
      chartTitle.hidden = true;
      chartNote.hidden = true;
      replay.hidden = true;
      counters.el.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  return A;
}

// What the learner may pick when asked what kind of vital a signal is.
const KINDS = [
  { label: 'a counter, so graph its rate()', type: 'counter', fn: 'rate' },
  { label: 'a gauge, so read it as it is', type: 'gauge', fn: 'nothing' },
  { label: 'a histogram, so use histogram_quantile()', type: 'histogram', fn: 'histogram_quantile' },
  { label: 'a summary, so its quantile is already computed', type: 'summary', fn: 'nothing' },
  { label: 'a gauge that is running out, so use predict_linear()', type: 'gauge', fn: 'predict_linear' },
];

// The warm-up: look at a vital and say what kind it is.
async function readVital(ui, A, index, during = false) {
  const item = A.world.quiz.items[index];
  A.chart(item.signal, during);
  for (;;) {
    // The right kind plus the next two (in the list's order), so every question is a choice of three.
    const at = KINDS.findIndex((k) => k.type === item.type && k.fn === item.fn);
    const offered = [0, 1, 2].map((d) => KINDS[(at + d) % KINDS.length]).sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b));
    const picked = await ui.choose('nia', `**${item.signal}**: ${item.hint} What kind of vital is it?`, offered.map((k) => ({ label: `${SIGNAL[item.signal].alias}: ${k.label}`, value: k.label })));
    const kind = KINDS.find((k) => k.label === picked);
    if (A.classify(index, kind.type, kind.fn)) {
      await ui.say('nia', `Right. ${item.why}`, 'Next');
      return;
    }
    await ui.say('nia', `Not quite. ${item.why}`, 'Try again');
  }
}

// One alert decision. A wrong rule is replayed against the last week and the result shown; the right one is installed.
async function decideRule(ui, A, ask, replaces, options, after) {
  for (;;) {
    const picked = await ui.choose('nia', ask, options.map((o) => ({ label: o.label, value: o.label })));
    const opt = options.find((o) => o.label === picked);
    const { result } = A.candidate(opt.spec, replaces);
    if (opt.right) {
      A.setRule(opt.spec, replaces);
      await ui.say('nia', after, 'Next', box(A.describe(result)));
      return;
    }
    await ui.say('nia', opt.why, 'Try again', box(A.describe(result)));
  }
}

function makeChapters() {
  return [
    {
      title: 'Reading the monitor',
      hook: 'A night ward with one patient: a web service. The monitor shows its vitals, and the pager is yours.',
      learn: 'what each kind of vital is, and why a good alert pages rarely.',
      async play({ ui, sim: A }) {
        A.load('first-shift');
        A.caption('The chart is the vital. Later, a strip counts last week\'s pages.');
        await ui.say('nia', 'Welcome to the night ward. I am Nia, the charge nurse. The patient is a web service. **Metrics** are the vitals on the bedside monitor, and an **alert** is the pager that wakes you. A nurse who is paged for nothing stops answering the pager, so every page must matter.');
        await ui.say('nia', 'First, learn to read a vital. Each one is a different **kind**, and the kind tells you what to do with it.', 'Show the first vital');
        for (let i = 0; i < 4; i++) await readVital(ui, A, i);
        A.hideChart();
        await ui.say('nia', 'Now the pager. The starter rules were written in a hurry. Before I show you, guess: **how many times** would they have paged you last week?', 'Make a guess');
        const guess = await ui.choose('nia', 'How many pages?', [
          { label: 'Once or twice: only the real error spike', value: 'few' },
          { label: 'About nine', value: 'nine' },
          { label: 'About thirty', value: 'many' },
        ]);
        A.showReplay();
        const base = A.current();
        await ui.say('nia', `${guess === 'nine' ? 'Close' : 'Not quite'}: they would have paged **${base.pages} times, and ${base.falsePages} of them were false**. A traffic surge and CPU blips are not emergencies, yet they woke you ${base.overnight} times in the night.`, 'Next', box(A.describe(base)));
        await decideRule(ui, A, 'The real incident is an **error spike**: 8% of requests failing for 20 minutes. Which alert would you page on?', 'HighErrorCount', [
          { label: 'More than 2 errors a second, right away', spec: { name: 'HighErrorCount', metric: 'err', fn: 'sum_rate', op: '>', threshold: 2, for: '0m' }, why: 'That is the starter rule: it counts a number of errors, so a busy night pages for nothing. A **share** of requests failing is a better question.' },
          { label: 'More than 5% of requests failing, for 5 minutes', spec: { name: 'HighErrorRatio', metric: 'err', fn: 'ratio', op: '>', threshold: 0.05, for: '5m' }, right: true },
          { label: 'More than 5% failing, but only open a ticket', spec: { name: 'HighErrorRatio', metric: 'err', fn: 'ratio', op: '>', threshold: 0.05, for: '5m', severity: 'warning' }, why: 'A ticket waits until morning. Nobody is woken, and the real incident goes on for hours.' },
        ], 'That is the one: a **ratio** (a share, not a count), and **for: 5m**, so a blip does not page. It catches the real spike. The false pages that remain come from the CPU alert.');
        await decideRule(ui, A, 'The CPU alert pages you for every one-minute blip. What should it be?', 'HighCPU', [
          { label: 'Keep paging: CPU is important', spec: { name: 'HighCPU', metric: 'cpu', fn: 'raw', op: '>', threshold: 0.9, for: '0m' }, why: 'A CPU that touches 90% for a minute is not hurting anyone, and it woke you every time.' },
          { label: 'Above 90% for 10 minutes, as a ticket', spec: { name: 'HighCPU', metric: 'cpu', fn: 'raw', op: '>', threshold: 0.9, for: '10m', severity: 'warning' }, right: true },
        ], 'A **for:** window rides out the blip, and a **warning** opens a ticket for the morning instead of waking you. The pager is quiet now.');
        await ui.say('nia', 'Let us live through the night with the new rules.', 'Run the night');
        const log = A.runNight();
        const s = A.stats();
        await ui.say('nia', `Morning. You were paged **${s.pages}** time${s.pages === 1 ? '' : 's'}, ${s.actionable} for a real incident and ${s.falsePages} false. Sleep ${s.sleep}%, patient ${s.slo}% healthy.`, 'Next', box(log));
        await ui.card({
          maps: [['A vital on the monitor', 'a metric'], ['It only ever goes up', 'counter: use rate()'], ['A share, not a count', 'ratio of rates'], ['Hold on for a few minutes first', 'for: 5m'], ['The pager vs a note in the chart', 'critical vs warning']],
          plain: 'Classify the signal first: a **counter** is read with **rate()**. Alert on a **ratio**, add **for:** so a blip does not page, and send what can wait as a **warning**.',
          cmd: '- alert: HighErrorRatio\n  expr: ' + A.expr({ metric: 'err', fn: 'ratio', op: '>', threshold: 0.05 }) + '\n  for: 5m\n  labels:\n    severity: critical',
        });
      },
    },
    {
      title: 'The pager that cried wolf',
      hook: 'Two quiet killers: latency creeping up and a disk filling slowly. Averages and fixed limits notice too late.',
      learn: 'alert on the tail and on where a resource is heading.',
      async play({ ui, sim: A }) {
        A.load('slow-burn');
        A.caption('The strip counts last week\'s pages and any real incident that was missed.');
        await ui.say('nia', 'Two problems creep up on the ward in the small hours. A **slow** problem is the dangerous kind: nothing is on fire until it suddenly is. The strip shows what last week would have looked like with the current rules.');
        await readVital(ui, A, 0, true);
        A.showReplay();
        const base = A.current();
        await ui.say('nia', `With the current rules the **slow latency creep** was **missed**: its alert looks at the **average**. Most requests are fine, and the average hides the slow few.`, 'Next', box(A.describe(base)));
        await decideRule(ui, A, 'Which number should the latency alert watch?', 'AvgLatencyHigh', [
          { label: 'The average, above half a second', spec: { name: 'AvgLatencyHigh', metric: 'lat', fn: 'mean', op: '>', threshold: 0.5, for: '5m' }, why: 'That is the current rule: the average stays low while the slowest requests suffer.' },
          { label: 'The median, above half a second', spec: { name: 'HighP95Latency', metric: 'lat', fn: 'quantile', q: 0.5, op: '>', threshold: 0.5, for: '5m' }, why: 'The median is the typical request. The pain is in the tail, which the median does not show.' },
          { label: 'The 95th percentile, above half a second', spec: { name: 'HighP95Latency', metric: 'lat', fn: 'quantile', q: 0.95, op: '>', threshold: 0.5, for: '5m' }, right: true },
        ], '**histogram_quantile(0.95, ...)** looks at the slowest 5% of requests. The creep is now caught.');
        await readVital(ui, A, 1, true);
        await ui.say('nia', 'The current disk alert pages when **less than 10 GB** is free. How long after the disk started filling would that page you, do you think?', 'Make a guess');
        const guess = await ui.choose('nia', 'How long?', [
          { label: 'About 30 minutes', value: 'a' },
          { label: 'About an hour', value: 'b' },
          { label: 'About three hours', value: 'c' },
        ]);
        const cur = A.current();
        const d = cur.incidents.find((i) => i.event === 'disk-fill');
        await ui.say('nia', `${guess === 'c' ? 'Right' : 'Longer than that'}: it paged **${d.after} minutes** after the filling began, when the disk was almost gone. Nothing could be done in time.`, 'Next', box(A.describe(cur)));
        await decideRule(ui, A, 'What should the disk alert ask instead?', 'DiskAlmostFull', [
          { label: 'Less than 10 GB free (now)', spec: { name: 'DiskAlmostFull', metric: 'disk', fn: 'raw', op: '<', threshold: 10, for: '0m' }, why: 'That is the current rule. By the time 10 GB is left, there are minutes to act.' },
          { label: 'Less than 50 GB free', spec: { name: 'DiskAlmostFull', metric: 'disk', fn: 'raw', op: '<', threshold: 50, for: '0m' }, why: 'Earlier, but still a fixed number. It does not know how fast the disk is filling.' },
          { label: 'Will it run out in 4 hours at this speed?', spec: { name: 'DiskFillingUp', metric: 'disk', fn: 'predict_linear', window: '1h', horizon: 4, op: '<', threshold: 0, for: '5m' }, right: true },
        ], '**predict_linear()** draws a line through the last hour and asks where it ends. It pages while there is still time to act, and stays quiet when the disk is merely low and steady.');
        await decideRule(ui, A, 'One more: the CPU alert still pages for blips. You know what to do.', 'HighCPU', [
          { label: 'Keep paging', spec: { name: 'HighCPU', metric: 'cpu', fn: 'raw', op: '>', threshold: 0.9, for: '0m' }, why: 'It woke you for a one-minute blip again.' },
          { label: 'Above 90% for 10 minutes, as a ticket', spec: { name: 'HighCPU', metric: 'cpu', fn: 'raw', op: '>', threshold: 0.9, for: '10m', severity: 'warning' }, right: true },
        ], 'Quiet again.');
        await ui.say('nia', 'Now the night.', 'Run the night');
        const log = A.runNight();
        const s = A.stats();
        await ui.say('nia', s.passed ? `Morning. Both slow problems were paged in time: **${s.actionable}** real pages, ${s.falsePages} false. Sleep ${s.sleep}%, patient ${s.slo}% healthy.` : `Morning. ${s.reasons.join(' ')}`, 'Next', box(log));
        await ui.card({
          maps: [['The slowest few visitors', 'p95 latency, not the average'], ['Where the disk is heading', 'predict_linear()'], ['A slow problem is a long page', 'alert on the trend']],
          plain: 'Alert on the **tail** (**histogram_quantile**), not the average, and on where a resource is **heading** (**predict_linear**), not where it is now.',
          cmd: '- alert: HighP95Latency\n  expr: ' + A.expr({ metric: 'lat', fn: 'quantile', q: 0.95, op: '>', threshold: 0.5 }) + '\n  for: 5m\n- alert: DiskFillingUp\n  expr: ' + A.expr({ metric: 'disk', fn: 'predict_linear', window: '1h', horizon: 4, op: '<', threshold: 0 }) + '\n  for: 5m',
        });
      },
    },
    {
      title: 'Storm night',
      hook: 'A rack goes dark and fifteen alerts fire at once, a flapping scrape looks like an outage, and the dashboard will not load.',
      learn: 'grouping alerts, riding out a flap, and recording an expensive query.',
      async play({ ui, sim: A }) {
        A.load('storm-night');
        A.caption('Every instance that goes down is its own alert, unless they are grouped.');
        await ui.say('nia', 'Storm night. The earlier rules are in place, and the strip shows how last week would have gone with them: **a lot of pages**. Something is badly wrong with how the pager is wired.');
        A.showReplay();
        const base = A.current();
        await ui.say('nia', `**${base.pages} pages** in a week, ${base.falsePages} false and ${base.duplicates} repeats of the same incident. The real killer is the **dead rack**: 15 servers down at once, so 15 alerts.`, 'Next', box(A.describe(base)));
        await readVital(ui, A, 0, true);
        for (;;) {
          const pick = await ui.choose('nia', 'The pager sends one page per **group** of alerts. What should an alert group share?', [
            { label: 'Nothing: one page for every server', value: '...' },
            { label: 'The alert name and the server', value: 'alertname,instance' },
            { label: 'The alert name and the job', value: 'alertname,job' },
          ]);
          const before = A.world.route.groupBy;
          A.route(pick);
          const r = backtest(A.world, A.world.rules, A.world.route);
          if (pick === 'alertname,job') {
            await ui.say('nia', 'Fifteen dead servers of one job are **one problem**, so now they make **one page**. The week drops from 46 pages to a handful.', 'Next', box(A.describe(r)));
            break;
          }
          A.route(before);
          await ui.say('nia', pick === '...' ? 'That is no grouping at all: fifteen servers, fifteen pages. The pager sounds like a fire alarm in a corridor.' : 'Grouping by server keeps each server separate, so the dead rack is still fifteen pages. Group by what they **share**: the job.', 'Try again', box(A.describe(r)));
        }
        await decideRule(ui, A, 'The **scrape flap**: every server misses one scrape and comes back a minute later, and the pager screams. The alert says "up is 0, page now". What changes?', 'InstanceDown', [
          { label: 'Nothing: a server is a server', spec: { name: 'InstanceDown', metric: 'up', fn: 'raw', op: '<', threshold: 1, for: '0m' }, why: 'It pages for a hiccup that fixes itself. That is a false page at 3am.' },
          { label: 'It must be down for 15 minutes first', spec: { name: 'InstanceDown', metric: 'up', fn: 'raw', op: '<', threshold: 1, for: '15m' }, why: 'It rides out the flap, but a real outage is now noticed 15 minutes late. Look at the "paged ... min after it began" line.' },
          { label: 'It must be down for 2 minutes first', spec: { name: 'InstanceDown', metric: 'up', fn: 'raw', op: '<', threshold: 1, for: '2m' }, right: true },
        ], 'A **for: 2m** rides out the flap but still pages quickly when a rack really goes dark.');
        await ui.say('nia', 'One last thing. The **request-rate panel** takes ten seconds to load, because it recomputes an expensive query over a week of data every time. When the rack goes dark, you cannot afford that wait.', 'Next');
        for (;;) {
          const pick = await ui.choose('nia', 'What do we do about the slow panel?', [
            { label: 'Alert when the panel is slow', value: 'alert' },
            { label: 'Precompute the query as a recording rule', value: 'record' },
          ]);
          if (pick === 'record') break;
          await ui.say('nia', 'A pager message will not make the panel faster. The query is expensive because it is **recomputed** on every load, so compute it **once a minute** and read the stored result.', 'Try again');
        }
        saveRule(A.world, { kind: 'record', name: 'job:http_requests:rate5m', metric: 'req', fn: 'sum_rate', window: '5m' });
        await ui.say('nia', 'Done: **job:http_requests:rate5m** is computed once a minute, and the panel reads that. Now live the storm.', 'Run the night');
        const log = A.runNight();
        const s = A.stats();
        await ui.say('nia', s.passed ? `Morning. The storm cost **${s.pages}** pages: ${s.actionable} real, ${s.falsePages} false, ${s.duplicates} repeats. Sleep ${s.sleep}%, patient ${s.slo}% healthy.` : `Morning. ${s.reasons.join(' ')}`, 'Next', box(log));
        await ui.card({
          maps: [['One page for one problem', 'group_by: [alertname, job]'], ['Ride out a hiccup', 'for: 2m'], ['Compute once, read many times', 'recording rule']],
          plain: '**Group** alerts by what they share, use **for:** to ride out a flap, and **record** an expensive query so dashboards stay fast.',
          cmd: 'route:\n  group_by: [alertname, job]\n\n- record: job:http_requests:rate5m\n  expr: sum by (job) (rate(http_requests_total[5m]))\n- alert: InstanceDown\n  expr: up == 0\n  for: 2m',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/observability/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const data = await res.json();
  mount(host, {
    id: 'observability',
    title: 'Quiet Hours',
    stageLabel: 'The ward',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      nia: { name: 'Nia', role: 'Night charge nurse', color: '#0f766e' },
    },
    chapters: makeChapters(),
    createStage: (app) => createWard(app, { data }),
    startLabel: 'Start the shift',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real Prometheus',
    endKicker: 'Shift complete',
    endTitle: 'You just ran a night of alerting',
    endIntro: 'Every ward word you used has a real Prometheus word. Here is your notebook.',
    endLinks: [
      { text: 'Read: Prometheus basics', href: NOTE('01-prometheus-basics') },
      { text: 'Read: Alerting and rules', href: NOTE('02-alerting-and-rules') },
      ...practiceLinks('observability', [['first-shift', 'First shift'], ['slow-burn', 'Slow burn'], ['storm-night', 'Storm night']]),
    ],
  });
}
