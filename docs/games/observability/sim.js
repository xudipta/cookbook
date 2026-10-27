// The "Quiet Hours" simulator. Pure logic, no DOM: importable from Node.
//
// It models what topics/observability/notes/01 and 02 teach:
//   * a service exposes counters, gauges and histograms; Prometheus scrapes them and evaluates alerting
//     rules every minute (the game uses a one-minute evaluation step to stay small);
//   * a rule's expression is real PromQL built from blocks (see `exprOf`), and `rulesYaml` writes the
//     rules file that `promtool check rules` accepts;
//   * `for:` means the condition must hold on every evaluation for that long before the alert moves
//     from pending to firing; a firing alert is sent to Alertmanager, which groups it (`group_by`) and
//     routes it by `severity` (critical pages the phone, warning opens a ticket);
//   * a recording rule precomputes an expensive query under a `level:metric:operations` name.
// The week of history and the night are generated from scenarios.json plus a seed, so a run replays.

export const DAY = 1440;
export const HIST_DAYS = 7;
export const NIGHT_MIN = 540; // 22:00 to 07:00
export const START_TOD = 22 * 60;
export const INSTANCES = 15;
export const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const REPEAT_MIN = 240; // Alertmanager's default repeat_interval (4h)
const DASH_SLOW_EXTRA = 10; // minutes a slow dashboard adds to every fix
const SLO_P95 = 0.6; // seconds: above this, users notice
const DISK_SIZE_GB = 200;
const DISK_BASE_USED = 0.58;

export const HEAVY_EXPR = 'sum(rate(http_requests_total[5m])) by (job)';

// ---------------------------------------------------------------- the rule vocabulary

export const METRICS = {
  req: { sel: 'http_requests_total', type: 'counter', signal: 'traffic', fns: ['raw', 'rate', 'increase', 'sum_rate'] },
  err: { sel: 'http_requests_total{code=~"5.."}', type: 'counter', signal: 'errors', fns: ['raw', 'rate', 'increase', 'sum_rate', 'ratio'] },
  lat: { sel: 'http_request_duration_seconds_bucket', type: 'histogram', signal: 'latency', fns: ['quantile', 'mean'] },
  cpu: { sel: 'process_cpu_usage', type: 'gauge', signal: 'cpu', fns: ['raw', 'avg_over_time', 'predict_linear'] },
  disk: { sel: 'node_filesystem_avail_bytes{mountpoint="/data"}', type: 'gauge', signal: 'disk', fns: ['raw', 'avg_over_time', 'predict_linear'] },
  queue: { sel: 'job_queue_depth', type: 'gauge', signal: 'queue', fns: ['raw', 'avg_over_time', 'predict_linear'] },
  up: { sel: 'up{job="sample-app"}', type: 'gauge', signal: 'up', fns: ['raw'] },
};

export const FN_LABELS = {
  raw: 'the series as it is',
  rate: 'rate()',
  increase: 'increase()',
  sum_rate: 'sum(rate()) by (job)',
  ratio: 'ratio of all requests',
  quantile: 'histogram_quantile()',
  mean: 'mean (sum / count)',
  avg_over_time: 'avg_over_time()',
  predict_linear: 'predict_linear()',
};

export const WINDOWS = ['1m', '5m', '15m', '1h'];
export const PREDICT_WINDOWS = ['30m', '1h', '3h'];
export const HORIZONS = [1, 4, 12, 24];
export const QUANTILES = [0.5, 0.95, 0.99];
export const FORS = ['0m', '1m', '2m', '5m', '10m', '15m'];
export const SEVERITIES = ['critical', 'warning'];
export const GROUP_BYS = ['...', 'alertname,instance', 'alertname,job', 'alertname'];

const minutes = (s) => (s.endsWith('h') ? parseInt(s, 10) * 60 : parseInt(s, 10));
const fmt = (n) => String(Number(n));

export function needsWindow(rule) {
  return !['raw'].includes(rule.fn);
}

export function windowsFor(rule) {
  return rule.fn === 'predict_linear' ? PREDICT_WINDOWS : WINDOWS;
}

// The threshold's unit: what the number means, and what to type.
export function unitFor(rule) {
  const m = METRICS[rule.metric];
  if (rule.fn === 'ratio') return 'ratio (0.05 = 5%)';
  if (rule.fn === 'quantile' || rule.fn === 'mean') return 'seconds';
  if (m.sel.startsWith('node_filesystem')) return 'GB';
  if (rule.metric === 'cpu') return 'ratio (1 = all cores)';
  if (rule.metric === 'queue') return 'jobs';
  if (rule.metric === 'up') return '1 = up, 0 = down';
  if (rule.fn === 'increase') return 'requests';
  if (rule.fn === 'raw') return 'requests in total';
  return 'requests per second';
}

// The PromQL for the value being watched (no comparison).
export function valueExpr(rule) {
  const m = METRICS[rule.metric];
  const w = rule.window || '5m';
  switch (rule.fn) {
    case 'raw':
      return m.sel;
    case 'rate':
      return `rate(${m.sel}[${w}])`;
    case 'increase':
      return `increase(${m.sel}[${w}])`;
    case 'sum_rate':
      return `sum(rate(${m.sel}[${w}])) by (job)`;
    case 'ratio':
      return `sum(rate(http_requests_total{code=~"5.."}[${w}])) / sum(rate(http_requests_total[${w}]))`;
    case 'quantile':
      return `histogram_quantile(${fmt(rule.q ?? 0.95)}, sum(rate(${m.sel}[${w}])) by (le))`;
    case 'mean':
      return `sum(rate(http_request_duration_seconds_sum[${w}])) / sum(rate(http_request_duration_seconds_count[${w}]))`;
    case 'avg_over_time':
      return `avg_over_time(${m.sel}[${w}])`;
    case 'predict_linear':
      return `predict_linear(${m.sel}[${w}], ${fmt(rule.horizon ?? 4)} * 3600)`;
    default:
      return m.sel;
  }
}

function thresholdText(rule) {
  const t = Number(rule.threshold);
  if (METRICS[rule.metric].sel.startsWith('node_filesystem') && t !== 0) return `${fmt(t)}e9`;
  return fmt(t);
}

export function exprOf(rule) {
  if (rule.kind === 'record') return valueExpr(rule);
  return `${valueExpr(rule)} ${rule.op} ${thresholdText(rule)}`;
}

function summaryOf(rule) {
  const sev = rule.severity === 'critical' ? 'pages' : 'opens a ticket';
  return `${rule.name} (${rule.severity}: ${sev})`;
}

export function rulesYaml(rules) {
  const alerts = rules.filter((r) => r.kind !== 'record');
  const records = rules.filter((r) => r.kind === 'record');
  const lines = ['groups:'];
  if (records.length) {
    lines.push('  - name: oncall-recording', '    rules:');
    for (const r of records) lines.push(`      - record: ${r.name}`, `        expr: ${exprOf(r)}`);
  }
  lines.push('  - name: oncall-alerts', '    rules:');
  if (!alerts.length) lines[lines.length - 1] = '    rules: []';
  for (const r of alerts) {
    lines.push(`      - alert: ${r.name}`, `        expr: ${exprOf(r)}`);
    if (r.for && r.for !== '0m') lines.push(`        for: ${r.for}`);
    else lines.push('        # no for: the first bad evaluation fires it');
    lines.push('        labels:', `          severity: ${r.severity}`, '        annotations:', `          summary: "${summaryOf(r)}"`);
  }
  return `${lines.join('\n')}\n`;
}

export function routeYaml(route) {
  const g = route.groupBy.split(',').map((s) => (s === '...' ? "'...'" : s));
  return [
    'route:',
    '  receiver: slack-default',
    `  group_by: [${g.join(', ')}]`,
    '  routes:',
    '    - match:',
    '        severity: critical',
    '      receiver: pagerduty',
    'receivers:',
    '  - name: slack-default',
    '  - name: pagerduty',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- time

export const clockText = (tod) => {
  const t = ((tod % DAY) + DAY) % DAY;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
export const todOf = (w, i) => (((START_TOD + i - w.H) % DAY) + DAY) % DAY;
export const clockOf = (w, i) => clockText(todOf(w, i));
export function whenText(w, i) {
  const rel = i - w.H + START_TOD;
  const day = Math.floor(rel / DAY);
  const label = day >= 0 ? 'tonight' : day === -1 ? 'yesterday' : `${-day} days ago`;
  return `${label} ${clockOf(w, i)}`;
}
const isAsleep = (w, i) => i - w.H >= 60 && i - w.H < 480;

// ---------------------------------------------------------------- the metric series

function erf(x) {
  const s = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-ax * ax);
  return s * y;
}
const lognormCdf = (x, median, sigma) => 0.5 * (1 + erf((Math.log(x) - Math.log(median)) / (sigma * Math.SQRT2)));
const FAST = { median: 0.08, sigma: 0.5 };
const SLOW = { median: 1.2, sigma: 0.4 };
const mixCdf = (x, s, k = 1) => (1 - s) * lognormCdf(x, FAST.median * k, FAST.sigma) + s * lognormCdf(x, SLOW.median, SLOW.sigma);
const mixMean = (s, k = 1) => (1 - s) * FAST.median * k * Math.exp((FAST.sigma ** 2) / 2) + s * SLOW.median * Math.exp((SLOW.sigma ** 2) / 2);

const parseAt = (at) => {
  const [h, m] = at.split(':').map(Number);
  return h * 60 + m;
};

// The incident list: history entries {event, day, at, dur, ...} and night entries {tick, minute, event, ...}.
function buildIncidents(w, scenario, events) {
  const out = [];
  let n = 0;
  const add = (spec, start, night) => {
    const def = events.get(spec.event);
    if (!def) throw new Error(`unknown event ${spec.event}`);
    out.push({
      id: `i${n++}`,
      event: spec.event,
      title: def.title,
      start,
      dur: spec.dur ?? def.dur ?? 1,
      params: spec,
      urgent: Boolean(def.urgent),
      signals: def.signals || [],
      fixMin: def.fixMin || 10,
      night,
      end: 0,
      impactStart: null,
      impactEnd: null,
      pageAt: null,
      ticketAt: null,
      resolveAt: null,
      started: false,
      closed: false,
      bad: 0,
    });
  };
  for (const h of scenario.history || []) add(h, w.H + h.day * DAY + parseAt(h.at) - START_TOD, false);
  for (const s of scenario.schedule || []) add(s, w.H + (s.tick - 1) * 60 + (s.minute || 0), true);
  for (const inc of out) inc.end = inc.start + inc.dur;
  out.sort((a, b) => a.start - b.start);
  return out;
}

function prefix(arr) {
  const p = new Float64Array(arr.length + 1);
  for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i];
  return p;
}

export function buildSeries(w, scenario, events, rng) {
  const L = w.L;
  // Fixed number of draws, whatever the incidents are.
  const noise = { req: new Float64Array(L), err: new Float64Array(L), cpu: new Float64Array(L), slow: new Float64Array(L), queue: new Float64Array(L), lat: new Float64Array(L) };
  for (let i = 0; i < L; i++) for (const k of Object.keys(noise)) noise[k][i] = rng() * 2 - 1;

  const req = new Float64Array(L);
  const errR = new Float64Array(L);
  const slowS = new Float64Array(L);
  const cpuBlip = new Float64Array(L);
  const down = new Float64Array(L);
  const used = new Float64Array(L);
  const reqMult = new Float64Array(L).fill(1);
  const errOverride = new Float64Array(L).fill(-1);
  const slowAdd = new Float64Array(L);

  for (const inc of w.incidents) {
    const { start, dur } = inc;
    const p = inc.params;
    for (let j = 0; j < dur; j++) {
      const i = start + j;
      if (i < 0 || i >= L) continue;
      switch (inc.event) {
        case 'error-spike': {
          const ramp = Math.min(1, (j + 1) / 2);
          errOverride[i] = Math.max(errOverride[i], (p.ratio ?? 0.08) * ramp * (1 + 0.05 * noise.err[i]));
          break;
        }
        case 'traffic-spike': {
          const edge = Math.min(1, (j + 1) / 3, (dur - j) / 3);
          reqMult[i] *= 1 + ((p.mult ?? 5) - 1) * edge;
          break;
        }
        case 'cpu-blip':
          cpuBlip[i] = 0.97;
          break;
        case 'latency-creep': {
          const ramp = p.ramp ?? 120;
          slowAdd[i] += (p.peak ?? 0.1) * Math.min(1, (j + 1) / ramp);
          break;
        }
        case 'disk-fill':
          used[i] = Math.min(1, DISK_BASE_USED + ((p.rate ?? 12) / 100) * ((j + 1) / 60)) - DISK_BASE_USED;
          break;
        case 'scrape-flap':
        case 'rack-down':
          down[i] = 1;
          break;
        default:
      }
    }
  }

  const cpu = new Float64Array(L);
  const queue = new Float64Array(L);
  const disk = new Float64Array(L);
  const latMean = new Float64Array(L);
  const bucketRates = BUCKETS.map(() => new Float64Array(L));
  for (let i = 0; i < L; i++) {
    const tod = (((START_TOD + i - w.H) % DAY) + DAY) % DAY;
    const f = 0.62 + 0.38 * Math.cos((2 * Math.PI * (tod - 840)) / DAY);
    req[i] = 180 * f * (1 + 0.05 * noise.req[i]) * reqMult[i];
    const spiking = reqMult[i] > 1.5;
    const base = (spiking ? 0.007 : 0.005) * (1 + 0.15 * noise.err[i]);
    errR[i] = errOverride[i] >= 0 ? errOverride[i] : base;
    cpu[i] = Math.min(0.99, Math.max(cpuBlip[i], 0.2 + 0.0022 * req[i] + 0.02 * noise.cpu[i]));
    queue[i] = Math.round(8 + 0.35 * req[i] + 3 * noise.queue[i]);
    slowS[i] = Math.min(0.5, 0.01 * (1 + 0.15 * noise.slow[i]) + slowAdd[i]);
    disk[i] = DISK_SIZE_GB * Math.max(0, 1 - (DISK_BASE_USED + (i / L) * 0.004 + used[i]));
    const k = 1 + 0.12 * noise.lat[i];
    latMean[i] = mixMean(slowS[i], k);
    for (let b = 0; b < BUCKETS.length; b++) {
      bucketRates[b][i] = req[i] * mixCdf(BUCKETS[b], slowS[i], k);
    }
  }
  const diskIy = new Float64Array(L);
  for (let i = 0; i < L; i++) diskIy[i] = i * disk[i];
  const cpuIy = new Float64Array(L);
  const queueIy = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    cpuIy[i] = i * cpu[i];
    queueIy[i] = i * queue[i];
  }

  const s = {
    req,
    errR,
    cpu,
    queue,
    disk,
    down,
    slowS,
    P: {
      req: prefix(req),
      err: prefix(req.map((r, i) => r * errR[i])),
      latSum: prefix(req.map((r, i) => r * latMean[i])),
      cpu: prefix(cpu),
      queue: prefix(queue),
      disk: prefix(disk),
      cpuIy: prefix(cpuIy),
      queueIy: prefix(queueIy),
      diskIy: prefix(diskIy),
      buckets: bucketRates.map(prefix),
    },
  };
  return s;
}

// ---------------------------------------------------------------- evaluating an expression at minute i

const sumRange = (P, a, b) => P[b + 1] - P[a]; // inclusive a..b

function histogramQuantile(q, upper, counts) {
  // counts are cumulative, one per upper bound, the last being +Inf
  const total = counts[counts.length - 1];
  if (!(total > 0)) return NaN;
  const rank = q * total;
  let b = 0;
  while (b < counts.length - 1 && counts[b] < rank) b++;
  if (b === counts.length - 1) return upper[upper.length - 1]; // in the +Inf bucket
  const lo = b === 0 ? 0 : upper[b - 1];
  const loCount = b === 0 ? 0 : counts[b - 1];
  const hi = upper[b];
  const inBucket = counts[b] - loCount;
  if (inBucket <= 0) return hi;
  return lo + ((hi - lo) * (rank - loCount)) / inBucket;
}

function predictLinear(Py, Piy, a, b, horizonSec) {
  // least squares over minutes a..b, evaluated horizon seconds after minute b
  const n = b - a + 1;
  const sy = sumRange(Py, a, b);
  const siy = sumRange(Piy, a, b);
  const sx = ((a + b) * n) / 2;
  const sumX2 = (b * (b + 1) * (2 * b + 1) - (a - 1) * a * (2 * a - 1)) / 6;
  const denom = n * sumX2 - sx * sx;
  if (denom === 0) return NaN;
  const slope = (n * siy - sx * sy) / denom; // per minute
  const intercept = (sy - slope * sx) / n;
  return intercept + slope * (b + horizonSec / 60);
}

// The value of the rule's expression at minute i (NaN where there is not enough history).
export function valueAt(w, rule, i) {
  const s = w.series;
  const win = minutes(rule.window || '5m');
  const a = i - win + 1;
  if (rule.fn !== 'raw' && a < 0) return NaN;
  switch (`${rule.metric}:${rule.fn}`) {
    case 'req:raw':
      return sumRange(s.P.req, 0, i) * 60;
    case 'err:raw':
      return sumRange(s.P.err, 0, i) * 60;
    case 'req:rate':
    case 'req:sum_rate':
      return sumRange(s.P.req, a, i) / win;
    case 'err:rate':
    case 'err:sum_rate':
      return sumRange(s.P.err, a, i) / win;
    case 'req:increase':
      return (sumRange(s.P.req, a, i) / win) * win * 60;
    case 'err:increase':
      return (sumRange(s.P.err, a, i) / win) * win * 60;
    case 'err:ratio':
      return sumRange(s.P.err, a, i) / sumRange(s.P.req, a, i);
    case 'lat:quantile': {
      const counts = s.P.buckets.map((P) => sumRange(P, a, i) / win);
      counts.push(sumRange(s.P.req, a, i) / win);
      return histogramQuantile(rule.q ?? 0.95, BUCKETS, counts);
    }
    case 'lat:mean':
      return sumRange(s.P.latSum, a, i) / sumRange(s.P.req, a, i);
    case 'up:raw':
      return 1 - s.down[i];
    default:
  }
  // gauges: cpu, queue, disk (the disk is kept in GB)
  const P = s.P[rule.metric];
  const Piy = s.P[`${rule.metric}Iy`];
  if (!P) return NaN;
  if (rule.fn === 'raw') return (rule.metric === 'disk' ? s.disk : rule.metric === 'cpu' ? s.cpu : s.queue)[i];
  if (rule.fn === 'avg_over_time') return sumRange(P, a, i) / win;
  if (rule.fn === 'predict_linear') return predictLinear(P, Piy, a, i, (rule.horizon ?? 4) * 3600);
  return NaN;
}

const nSeries = (rule) => (rule.metric === 'up' ? INSTANCES : 1);
const instanceName = (k) => `app-${k + 1}:8080`;

// ---------------------------------------------------------------- the rule engine (Prometheus + Alertmanager)

export function newEngine() {
  return { st: {} };
}

function ruleState(eng, rule) {
  const sig = JSON.stringify([rule.metric, rule.fn, rule.window, rule.q, rule.horizon, rule.op, rule.threshold, rule.for]);
  let st = eng.st[rule.id];
  if (!st || st.sig !== sig) {
    const n = nSeries(rule);
    st = { sig, since: new Array(n).fill(null), firing: new Array(n).fill(false), lastNotify: new Array(n).fill(null) };
    eng.st[rule.id] = st;
  }
  return st;
}

export function stepEngine(w, eng, rules, route, i) {
  const out = [];
  for (const rule of rules) {
    if (rule.kind === 'record') continue;
    const st = ruleState(eng, rule);
    const v = valueAt(w, rule, i);
    const thr = Number(rule.threshold);
    const breach = !Number.isNaN(v) && (rule.op === '>' ? v > thr : v < thr);
    const forMin = minutes(rule.for || '0m');
    const fresh = [];
    for (let k = 0; k < st.since.length; k++) {
      if (!breach) {
        st.since[k] = null;
        st.firing[k] = false;
        continue;
      }
      if (st.since[k] === null) st.since[k] = i;
      if (i - st.since[k] < forMin) continue; // pending
      if (!st.firing[k]) {
        st.firing[k] = true;
        st.lastNotify[k] = i;
        fresh.push({ k, kind: 'new' });
      } else if (i - st.lastNotify[k] >= REPEAT_MIN) {
        st.lastNotify[k] = i;
        fresh.push({ k, kind: 'repeat' });
      }
    }
    if (!fresh.length) continue;
    const groups = new Map();
    for (const f of fresh) {
      const key = route.groupBy === 'alertname' || route.groupBy === 'alertname,job' ? 'one' : String(f.k);
      const g = groups.get(key) || { k: f.k, kind: f.kind, n: 0, value: v };
      g.n += 1;
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      out.push({ t: i, rule: rule.id, name: rule.name, severity: rule.severity, signal: METRICS[rule.metric].signal, kind: g.kind, n: g.n, instance: rule.metric === 'up' && g.n === 1 ? instanceName(g.k) : null, value: v });
    }
  }
  return out;
}

// Decide what a notification was: an actionable page for an urgent incident, a duplicate of one, or a false page.
export function attribute(w, n, incidents) {
  let found = null;
  for (const inc of incidents) {
    if (n.t >= inc.start && n.t <= inc.end + 10 && inc.signals.includes(n.signal)) {
      found = inc;
      break;
    }
  }
  if (!found || !found.urgent) return { kind: 'false', inc: found };
  if (n.kind === 'new' && found.pageAt === null) return { kind: 'actionable', inc: found };
  return { kind: 'duplicate', inc: found };
}

// ---------------------------------------------------------------- a week of history, replayed against the rules

export function backtest(w, rules, route) {
  const eng = newEngine();
  const incs = w.incidents.filter((i) => !i.night).map((i) => ({ ...i, pageAt: null, ticketAt: null }));
  const notifs = [];
  const first = 3 * 60;
  for (let i = first; i < w.H; i++) {
    for (const n of stepEngine(w, eng, rules, route, i)) {
      if (n.severity === 'critical') {
        const a = attribute(w, n, incs);
        n.verdict = a.kind;
        n.incAny = a.inc ? a.inc.id : null;
        n.inc = a.inc && a.inc.urgent ? a.inc.id : null;
        if (a.kind === 'actionable') a.inc.pageAt = i;
        notifs.push(n);
      } else {
        const a = attribute(w, n, incs);
        n.incAny = a.inc ? a.inc.id : null;
        n.verdict = 'ticket';
        n.inc = a.inc && a.inc.urgent ? a.inc.id : null;
        if (n.inc && a.inc.ticketAt === null) a.inc.ticketAt = i;
        notifs.push(n);
      }
    }
  }
  const pages = notifs.filter((n) => n.severity === 'critical');
  const result = {
    notifs,
    pages: pages.length,
    falsePages: pages.filter((n) => n.verdict === 'false').length,
    duplicates: pages.filter((n) => n.verdict === 'duplicate').length,
    overnight: pages.filter((n) => todOf(w, n.t) >= 23 * 60 || todOf(w, n.t) < 6 * 60).length,
    tickets: notifs.length - pages.length,
    incidents: incs.map((inc) => {
      const status = inc.pageAt !== null ? 'caught' : inc.ticketAt !== null ? 'ticket' : 'missed';
      return { id: inc.id, event: inc.event, title: inc.title, start: inc.start, urgent: inc.urgent, status, byRule: pages.find((n) => n.inc === inc.id && n.verdict === 'actionable')?.name, after: inc.pageAt !== null ? inc.pageAt - inc.start : null };
    }),
  };
  return result;
}

// ---------------------------------------------------------------- world

const clone = (o) => JSON.parse(JSON.stringify(o));

export function createWorld(scenario, rng, eventList) {
  const events = new Map((eventList || scenario.events).map((e) => [e.id, e]));
  const H = HIST_DAYS * DAY;
  const w = { H, L: H + NIGHT_MIN + 180, events };
  w.incidents = buildIncidents(w, scenario, events);
  w.series = buildSeries(w, scenario, events, rng);
  for (const inc of w.incidents) {
    // When the incident starts to hurt users, and when it stops.
    if (inc.event === 'latency-creep') {
      const rule = { metric: 'lat', fn: 'quantile', q: 0.95, window: '5m' };
      let at = null;
      for (let i = inc.start; i < inc.end && at === null; i++) if (valueAt(w, rule, i) > SLO_P95) at = i;
      inc.impactStart = at === null ? inc.end : at;
      inc.impactEnd = inc.end;
    } else if (inc.event === 'disk-fill') {
      let at = null;
      for (let i = inc.start; i < inc.end && at === null; i++) if (w.series.disk[i] <= 0.0001) at = i;
      inc.impactStart = at === null ? inc.end : at;
      inc.impactEnd = inc.end;
    } else {
      inc.impactStart = inc.start;
      inc.impactEnd = inc.end;
    }
  }
  w.level = {
    budgetMin: scenario.budgetMin ?? 40,
    sloTarget: scenario.sloTarget ?? 60,
    minSleep: scenario.minSleep ?? 70,
  };
  w.rules = clone(scenario.rules || []).map((r) => ({ kind: 'alert', window: '5m', q: 0.95, horizon: 4, for: '0m', ...r }));
  w.nextRuleId = w.rules.length + 1;
  w.route = { groupBy: scenario.groupBy || 'alertname,job' };
  w.engine = newEngine();
  w.now = w.H; // the next minute to evaluate
  w.sleep = 100;
  w.slo = 100;
  w.bad = 0;
  w.stats = { pages: 0, actionable: 0, falsePages: 0, duplicates: 0, tickets: 0, asleepPages: 0 };
  w.night = []; // every notification tonight, with its verdict
  w.dashHeavy = false;
  w.quiz = { items: clone(scenario.warmup || []), done: new Array((scenario.warmup || []).length).fill(false), wrong: 0 };
  w.message = '';
  w.health = 100;
  w.failReasons = [];
  // Rules start evaluating three hours before the shift so windows and pending states are warm.
  for (let i = H - 180; i < H; i++) stepEngine(w, w.engine, w.rules, w.route, i);
  return w;
}

export const quizDone = (w) => w.quiz.done.every(Boolean);
export const nightOver = (w) => w.now >= w.H + NIGHT_MIN;
export const hourOf = (w) => Math.floor((w.now - w.H) / 60);

export function recordedExpr(w) {
  return w.rules.some((r) => r.kind === 'record' && /^[a-z_][a-z0-9_]*:[A-Za-z0-9_]+:[A-Za-z0-9_]+$/.test(r.name) && exprOf(r) === HEAVY_EXPR);
}
export const dashSlow = (w) => w.dashHeavy && !recordedExpr(w);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RECORD_RE = /^[a-z_][a-z0-9_]*:[A-Za-z0-9_]+:[A-Za-z0-9_]+$/;

// Check a rule spec; returns an error message or null.
export function validateRule(w, spec) {
  const kind = spec.kind === 'record' ? 'record' : 'alert';
  const name = String(spec.name || '').trim();
  const taken = w.rules.some((r) => r.name === name && r.id !== spec.id);
  if (kind === 'alert' && !NAME_RE.test(name)) return 'An alert name is letters, digits and underscores, such as HighErrorRatio.';
  if (kind === 'record' && !RECORD_RE.test(name)) return 'A recording rule is named level:metric:operations, for example job:http_requests:rate5m.';
  if (taken) return `A rule called ${name} already exists.`;
  const m = METRICS[spec.metric];
  if (!m) return 'Pick a metric.';
  if (!m.fns.includes(spec.fn)) return `${FN_LABELS[spec.fn] || spec.fn} is not for a ${m.type}: ${m.type === 'counter' ? 'a counter only goes up, so use rate() or increase()' : m.type === 'histogram' ? 'a histogram is read with histogram_quantile()' : 'a gauge is read as it is, or with avg_over_time() or predict_linear()'}.`;
  if (needsWindow(spec) && !windowsFor(spec).includes(spec.window)) return 'Pick a window for the range selector.';
  if (kind === 'alert') {
    if (!['>', '<'].includes(spec.op)) return 'Pick a comparison.';
    if (!Number.isFinite(Number(spec.threshold))) return 'The threshold must be a number.';
    if (!FORS.includes(spec.for)) return 'Pick a for: duration.';
    if (!SEVERITIES.includes(spec.severity)) return 'Pick a severity.';
  } else if (spec.fn === 'raw') {
    return 'Record a computed series, such as a sum of a rate.';
  }
  return null;
}

export function saveRule(w, spec) {
  const err = validateRule(w, spec);
  w.message = err || '';
  if (err) return false;
  const rule = { kind: spec.kind === 'record' ? 'record' : 'alert', window: '5m', q: 0.95, horizon: 4, for: '0m', op: '>', threshold: 0, severity: 'critical', ...spec, name: String(spec.name).trim(), threshold: Number(spec.threshold) };
  if (!needsWindow(rule)) delete rule.window;
  const at = w.rules.findIndex((r) => r.id === spec.id);
  if (at >= 0) {
    rule.id = w.rules[at].id;
    w.rules[at] = rule;
  } else {
    rule.id = `r${w.nextRuleId++}`;
    w.rules.push(rule);
  }
  return true;
}

export function removeRule(w, id) {
  const at = w.rules.findIndex((r) => r.id === id);
  if (at < 0) {
    w.message = 'No such rule.';
    return false;
  }
  w.rules.splice(at, 1);
  delete w.engine.st[id];
  w.message = '';
  return true;
}

export function setRoute(w, groupBy) {
  if (!GROUP_BYS.includes(groupBy) || groupBy === w.route.groupBy) return false;
  w.route.groupBy = groupBy;
  return true;
}

// The warm-up: classify a signal and pick what to do with it before graphing.
export function classify(w, index, type, fn) {
  const item = w.quiz.items[index];
  if (!item || w.quiz.done[index]) return false;
  if (item.type === type && item.fn === fn) {
    w.quiz.done[index] = true;
    w.message = '';
    return true;
  }
  w.quiz.wrong += 1;
  w.message = `Not quite: ${item.why}`;
  return true; // a wrong guess is still a move
}

// ---------------------------------------------------------------- the night

const refresh = (w) => {
  w.slo = Math.max(0, 100 * (1 - w.bad / w.level.budgetMin));
  w.health = Math.max(0, Math.round(Math.min(w.sleep, w.slo)));
};

function sleepCost(w, i, verdict) {
  const asleep = isAsleep(w, i);
  if (verdict === 'actionable') return asleep ? 5 : 1;
  if (verdict === 'duplicate') return asleep ? 4 : 1;
  return asleep ? 15 : 4;
}

function logNotification(w, ctx, i, { entry, inc, count, alerts }) {
  const at = clockOf(w, i);
  const times = count > 1 ? ` x${count}` : '';
  const what = `${entry.name}${alerts > 1 && count === 1 ? ` (${alerts} alerts grouped)` : ''}${count === 1 && entry.instance ? ` on ${entry.instance}` : ''}${times}`;
  if (entry.verdict === 'ticket') {
    ctx.log(`${at} Ticket: ${what} (warning). Nobody is woken; it waits for the morning.`, { kind: 'hint' });
  } else if (entry.verdict === 'actionable') {
    ctx.log(`${at} PAGE ${what}: a real incident. You have it fixed by ${clockOf(w, inc.resolveAt)}${dashSlow(w) ? ', slowly, because the dashboard will not load' : ''}.`, { kind: 'good' });
  } else if (entry.verdict === 'duplicate') {
    ctx.log(`${at} PAGE ${what}: the same incident again. Wasted sleep.`, { kind: 'warn' });
  } else {
    ctx.log(`${at} PAGE ${what}: nothing to do${entry.asleep ? ', and it woke you' : ''}. A false page.`, { kind: 'warn' });
  }
}

// Advance one hour (the engine's tick). Everything inside runs minute by minute.
export function tick(w, ctx) {
  const end = Math.min(w.now + 60, w.H + NIGHT_MIN);
  for (let i = w.now; i < end; i++) {
    for (const inc of w.incidents) {
      if (!inc.night) continue;
      if (!inc.started && i >= inc.start) {
        inc.started = true;
        if (inc.event === 'slow-dashboard') w.dashHeavy = true;
        ctx.fire(inc.event, clockOf(w, inc.start));
      }
    }
    const batch = new Map(); // notifications of this minute, folded into one log line per rule and verdict
    for (const n of stepEngine(w, w.engine, w.rules, w.route, i)) {
      const a = attribute(w, n, w.incidents.filter((x) => x.night));
      const entry = { ...n, verdict: n.severity === 'critical' ? a.kind : 'ticket', inc: a.inc && a.inc.urgent ? a.inc.id : null, asleep: isAsleep(w, i) };
      w.night.push(entry);
      if (n.severity !== 'critical') {
        w.stats.tickets += 1;
        if (a.inc && a.inc.urgent && a.inc.ticketAt === null) a.inc.ticketAt = i;
      } else {
        w.stats.pages += 1;
        if (entry.asleep) w.stats.asleepPages += 1;
        w.sleep = Math.max(0, w.sleep - sleepCost(w, i, a.kind));
        if (a.kind === 'actionable') {
          w.stats.actionable += 1;
          a.inc.pageAt = i;
          a.inc.resolveAt = i + a.inc.fixMin + (dashSlow(w) ? DASH_SLOW_EXTRA : 0);
        } else if (a.kind === 'duplicate') w.stats.duplicates += 1;
        else w.stats.falsePages += 1;
      }
      const key = `${n.rule}:${entry.verdict}`;
      const b = batch.get(key) || { entry, inc: a.inc, count: 0, alerts: 0 };
      b.count += 1;
      b.alerts += n.n;
      batch.set(key, b);
    }
    for (const b of batch.values()) logNotification(w, ctx, i, b);
    // Downtime: minutes in which an urgent incident is hurting users and nobody has fixed it yet.
    let hurting = false;
    for (const inc of w.incidents) {
      if (!inc.night || !inc.urgent) continue;
      if (i >= inc.impactStart && i < inc.impactEnd && (inc.resolveAt === null || i < inc.resolveAt)) {
        inc.bad += 1;
        hurting = true;
      }
    }
    if (hurting) w.bad += 1;
    for (const inc of w.incidents) {
      if (inc.night && inc.started && !inc.closed && i + 1 >= inc.end) {
        inc.closed = true;
        ctx.resolve(inc.event);
      }
    }
    w.now = i + 1;
    refresh(w);
    if (w.sleep <= 0) break;
  }
  if (nightOver(w)) finishNight(w, ctx);
  refresh(w);
}

function finishNight(w, ctx) {
  for (const inc of w.incidents) if (inc.night && inc.started && !inc.closed) {
    inc.closed = true;
    ctx.resolve(inc.event);
  }
  const reasons = [];
  const missed = w.incidents.filter((i) => i.night && i.urgent && i.pageAt === null);
  for (const inc of missed) reasons.push(`${inc.title} was never paged${inc.ticketAt !== null ? ' (a ticket is not a page)' : ''}.`);
  if (w.slo < w.level.sloTarget) reasons.push(`SLO ${Math.round(w.slo)}% is under the ${w.level.sloTarget}% target (${w.bad} minutes of user impact).`);
  if (w.sleep < w.level.minSleep) reasons.push(`Sleep ${Math.round(w.sleep)}% is under ${w.level.minSleep}%: too many pages that did not need you.`);
  if (w.dashHeavy && dashSlow(w)) reasons.push('The dashboard is still too slow to load: record the expensive query.');
  w.failReasons = reasons;
  w.passed = reasons.length === 0;
}

export function isLost(w) {
  if (w.sleep <= 0) return true;
  if (w.slo <= 0) return true;
  return nightOver(w) && !w.passed;
}
export function isWon(w) {
  return nightOver(w) && w.passed === true;
}

export function stars(w) {
  const slo = w.slo >= w.level.sloTarget;
  const quiet = w.stats.falsePages <= 1;
  const clean = w.stats.falsePages === 0 && w.stats.duplicates === 0;
  return { slo, quiet, clean, count: [slo, quiet, clean].filter(Boolean).length };
}

// ---------------------------------------------------------------- data for the dashboard

export const PANELS = [
  { id: 1, title: 'Request rate', type: 'timeseries', unit: 'req/s', expr: () => HEAVY_EXPR },
  { id: 2, title: 'Error ratio', type: 'timeseries', unit: '%', expr: () => valueExpr({ metric: 'err', fn: 'ratio', window: '5m' }) },
  { id: 3, title: 'p95 latency', type: 'timeseries', unit: 's', expr: () => valueExpr({ metric: 'lat', fn: 'quantile', q: 0.95, window: '5m' }) },
  { id: 4, title: 'CPU', type: 'timeseries', unit: '%', expr: () => 'process_cpu_usage' },
  { id: 5, title: 'Queue depth', type: 'gauge', unit: 'jobs', expr: () => 'job_queue_depth' },
];

export function panelValue(w, id, i) {
  switch (id) {
    case 1:
      return valueAt(w, { metric: 'req', fn: 'rate', window: '5m' }, i);
    case 2:
      return valueAt(w, { metric: 'err', fn: 'ratio', window: '5m' }, i) * 100;
    case 3:
      return valueAt(w, { metric: 'lat', fn: 'quantile', q: 0.95, window: '5m' }, i);
    case 4:
      return w.series.cpu[i] * 100;
    default:
      return w.series.queue[i];
  }
}

// Samples for one panel: the last `span` minutes up to now, one point every `step` minutes.
export function panelSeries(w, id, span = 360, step = 6) {
  const end = Math.min(w.now - 1, w.L - 1);
  const out = [];
  for (let i = end - span + 1 + ((span - 1) % step); i <= end; i += step) out.push({ i, v: panelValue(w, id, i) });
  return out;
}

export function panelExpr(w, id) {
  const p = PANELS.find((x) => x.id === id);
  if (id === 1 && recordedExpr(w)) return w.rules.find((r) => r.kind === 'record' && exprOf(r) === HEAVY_EXPR).name;
  return p.expr();
}
