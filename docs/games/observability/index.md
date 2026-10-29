# Quiet Hours

Write the alerting rules before your shift, then live through the night: page you for real incidents, and let you sleep through the rest.

<div id="game" data-game="observability">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- Build each rule from blocks (metric, function, window, comparison, threshold, `for:`, severity). The editor
  shows the real PromQL and replays the **last 7 days**: how often the rule would have paged, and whether
  those pages were real. Changing a rule or the route costs a move; time is free.
- Some levels open with a **warm-up**: a graph per signal. Read its shape, pick its type and what to do with it
  before you graph or alert on it, and see what a wrong choice would have done. Tabs switch between **Rules**,
  **Charts** (one at a time: slide to read a point, and the numbers are written under the chart), **Tonight**, the
  **Route** and the **Replay**.
- **Next hour** (`h`) plays an hour of the night. A `critical` alert **pages** you; a `warning` alert only opens
  a ticket. A false page at night costs **Sleep**; a real incident left unfixed burns the **SLO**.
- Win by reaching 07:00 with every real incident paged, SLO and Sleep above the level's lines, and nothing left
  broken (a slow dashboard counts). Stars: SLO met, at most one false page, every page actionable.

## Syntax worth remembering

```yaml
- alert: HighErrorRatio
  expr: sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05
  for: 5m              # pending, then firing only if it holds on every evaluation
  labels:
    severity: critical # Alertmanager routes on this: critical pages, warning opens a ticket
```

```promql
rate(http_requests_total[5m])                     # a counter: always rate() it
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
predict_linear(node_filesystem_avail_bytes[1h], 4 * 3600) < 0   # where the disk is heading
```

```yaml
route:
  group_by: [alertname, job]   # one page per incident, not one per instance
```

```yaml
- record: job:http_requests:rate5m   # level:metric:operations, a precomputed series
  expr: sum(rate(http_requests_total[5m])) by (job)
```

Notes behind it: [Prometheus basics](../../../topics/observability/notes/01-prometheus-basics.md) and
[Alerting and rules](../../../topics/observability/notes/02-alerting-and-rules.md).
