# Resource limits and probes

Two things that matter in essentially every real Deployment, and are missing from every
other example in this topic on purpose — they're best understood on their own, once Pods
and Services already make sense (see `02-pods-and-workloads.md` and
`04-services-and-networking.md`).

## Resource requests and limits

```yaml
# examples/deployment/deployment-with-resources-and-probes.yaml
resources:
  requests:
    cpu: 100m
    memory: 64Mi
  limits:
    cpu: 250m
    memory: 128Mi
```

- **`requests`** is what the scheduler uses to place the Pod — it only schedules a Pod
  onto a node that has at least this much CPU/memory still unreserved. It's a
  reservation, not a cap.
- **`limits`** is the actual cap, enforced per-container at the kernel level, and CPU and
  memory are enforced differently:
  - Exceed the **CPU** limit → the container is throttled (slowed down), not killed.
  - Exceed the **memory** limit → the container is killed immediately (`OOMKilled`,
    visible in `kubectl describe pod` and `kubectl get pods` as a non-zero restart
    count) — memory can't be throttled the way CPU time can.
- `100m` = 100 millicpu = 0.1 of one CPU core. Memory suffixes are binary (`Mi` = 2^20
  bytes), not decimal (`M` = 10^6) — the two are close but not the same, and Kubernetes
  accepts both, so be deliberate about which one you write.

Omitting `resources` entirely (every other example in this topic does) means "no
reservation, no cap" — fine for a learning example, risky in a real cluster: one
misbehaving Pod with no limit can starve every other Pod on its node.

## Probes

```yaml
readinessProbe:
  httpGet:
    path: /
    port: 80
  initialDelaySeconds: 2
  periodSeconds: 5
livenessProbe:
  httpGet:
    path: /
    port: 80
  initialDelaySeconds: 5
  periodSeconds: 10
```

Both poll the same endpoint here, but they do different things on failure:

- **`readinessProbe`** failing removes the Pod from every Service's endpoints (see
  `04-services-and-networking.md`) — traffic stops routing to it — without touching the
  Pod itself. This is exactly what the `k8s-kind` CI job's `kubectl wait
  --for=condition=available` is waiting on: a Deployment isn't "available" until enough
  of its Pods report ready.
- **`livenessProbe`** failing restarts the container. Use it for "this process is wedged
  and a restart is the only fix" — a liveness probe with too short a timeout, or that
  depends on something outside the container's own control (a database being briefly
  unreachable), causes exactly the kind of restart-loop it was meant to prevent. Readiness
  failing is almost always the safer default; add liveness only when you've specifically
  seen the process hang in a way nothing but a restart recovers from.
- `initialDelaySeconds` matters most for liveness — too short, and a normal slow startup
  looks like a hang and gets restarted before it ever finishes starting.

## Try it

```bash
kubectl apply -f examples/deployment/deployment-with-resources-and-probes.yaml
kubectl get pods -l app=nginx-probed
kubectl describe pod -l app=nginx-probed | grep -A3 "Limits:\|Requests:"
kubectl get endpoints   # populated only once the readiness probe passes
```
