# Common kubectl commands

Useful `kubectl` commands for creating, editing, extracting, inspecting, and redeploying
resource definitions.

## Create resources

Create a new resource (fails if it already exists):

```bash
kubectl create -f <file>.yaml
```

Create or update a resource to match the file (idempotent — safe to re-run):

```bash
kubectl apply -f <file>.yaml
```

`apply` is what you want in almost every case, including CI — see how this repo's own
validation applies `examples/` with it.

## Edit resources

```bash
kubectl edit <resource-type> <resource-name>
# e.g. kubectl edit deployment my-deployment
```

Opens the live object in `$EDITOR`; saving applies the change immediately. Prefer
editing the source YAML and re-`apply`ing when the change should be reproducible.

## Extract an existing definition

```bash
kubectl get pod <pod-name> -o yaml > pod-definition.yaml
```

Useful for capturing a resource's *actual* state (including fields the API server
defaulted for you) as a starting point for a manifest.

## Redeploy from an extracted definition

```bash
kubectl delete pod <pod-name>
kubectl apply -f pod-definition.yaml
```

## Inspecting resources

```bash
kubectl get pods                                   # list pods
kubectl get pods -o wide                            # + node, IP
kubectl get all                                      # pods, services, deployments, replicasets in the namespace
kubectl describe <resource-type> <resource-name>    # full detail + recent Events (start here when debugging)
kubectl logs <pod-name>                             # container logs
kubectl logs <pod-name> -c <container> --previous    # a specific container's logs from before its last restart
kubectl exec -it <pod-name> -- sh                    # shell into a running container
```

`kubectl describe` is usually the fastest path to "why isn't this working" — the
**Events** section at the bottom shows scheduling failures, image pull errors, and probe
failures in plain English.

## Scaling and rollouts

```bash
kubectl scale deployment/<name> --replicas=5
kubectl rollout status deployment/<name>            # watch a rollout finish
kubectl rollout history deployment/<name>            # past revisions
kubectl rollout undo deployment/<name>                # roll back to the previous revision
kubectl rollout restart deployment/<name>             # recreate all Pods (e.g. to pick up a changed Secret)
```

## Port-forwarding and resource usage

```bash
kubectl port-forward pod/<name> 8080:80    # reach a Pod's port 80 at localhost:8080
kubectl port-forward svc/<name> 8080:80    # same, via a Service
kubectl top pods                            # CPU/memory usage (needs metrics-server)
```

## Namespaces

```bash
kubectl get pods -n kube-system              # -n / --namespace targets one namespace
kubectl config set-context --current --namespace=my-ns   # change the default for this context
kubectl create namespace sample-namespace     # imperative — fine for throwaway/local use
kubectl apply -f examples/namespace/sample-namespace.yaml   # declarative — the same object, tracked as a manifest
```

A resource with no `metadata.namespace` in its manifest is created in whatever namespace
`kubectl` is currently pointed at (`default`, unless changed as above) —
`examples/configs/sample-configmap.yaml` sets `namespace: default` explicitly; every
other example in this topic relies on that default. `examples/namespace/sample-namespace.yaml`
is the plain object itself — a `Namespace` has almost no spec, it's just a name other
resources' `metadata.namespace` can point at.
