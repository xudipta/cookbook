# Chaos Monkey Cluster

Keep a Service healthy while a chaos monkey breaks the cluster. Every failure leaves clues in `kubectl`.

<div id="game" data-game="kubernetes">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- A Service needs a fixed amount of capacity. Requests that find too few ready pods fail and burn
  your **error budget**. Stay above the minimum for the whole timer, **and** leave nothing broken:
  open problems extend the game.
- Reading is free and works while paused: `get`, `describe`, `logs`, or click a pod. Changing the
  cluster costs score, so look before you act. Not every event needs an action.
- Pause (`p`) and restart (`r`) work any time. Click the game once to give it keyboard focus.

## Commands

```bash
kubectl get pods -o wide                 # status, restarts, node, IP
kubectl get endpoints                    # what the Service actually routes to
kubectl describe pod <name>              # state, limits, and the Events at the bottom
kubectl describe deploy web              # template, strategy, readiness probe
kubectl describe nodes                   # memory requests per node
kubectl logs <pod>
kubectl scale deploy/web --replicas=5
kubectl rollout undo deploy/web          # back to the previous revision
kubectl set image deploy/web web=web:1.0
kubectl set resources deploy/web --limits=memory=500Mi
kubectl edit deploy/web                  # opens a form for the pod template
```

## What it teaches

| Failure | Look at | Concept |
| --- | --- | --- |
| A pod dies | `get pods` | ReplicaSets self-heal; bare Pods don't |
| `ImagePullBackOff` | `describe pod` Events | Rollouts stall, `rollout undo` |
| `CreateContainerConfigError` | `describe pod` (not `logs`) | ConfigMap keys, `runAsNonRoot` |
| `OOMKilled` | `describe pod` | Memory limits kill, CPU limits throttle |
| Pods run but no traffic | `get endpoints` | Service selectors match labels |
| `Pending` | `describe pod`, `describe nodes` | The scheduler uses requests |
| Failures after every rollout | `describe deploy` | Readiness probes |

Notes behind it: [Pods, ReplicaSets and Deployments](../../../topics/kubernetes/notes/02-pods-and-workloads.md),
[Services](../../../topics/kubernetes/notes/04-services-and-networking.md),
[Probes and resources](../../../topics/kubernetes/notes/07-probes-and-resources.md).
