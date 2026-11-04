# SecurityContext

`securityContext` controls the privilege and access-control settings a container (or a
whole Pod's containers) runs with. It exists at two levels, and both are shown side by
side in `examples/pod/pod-with-security-context.yaml`:

```yaml
spec:
  securityContext:        # Pod-level — applies to every container in the Pod
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
  containers:
    - name: secure-container
      image: nginx:1.27
      securityContext:     # container-level — overrides the Pod-level setting for this container only
        allowPrivilegeEscalation: false
```

```bash
kubectl apply -f examples/pod/pod-with-security-context.yaml
kubectl exec pod-with-security-context -- id     # confirm uid=1000 gid=3000
```

## The fields that matter most

| Field | Level | Effect |
| --- | --- | --- |
| `runAsUser` / `runAsGroup` | both | UID/GID the container process runs as, instead of whatever the image's `USER`/default is |
| `runAsNonRoot: true` | both | kubelet **refuses to start** the container if it would run as UID 0 — a cheap guardrail against an image that defaults to root |
| `fsGroup` | Pod only | GID applied to mounted volumes' files, so a non-root process can still read/write them |
| `allowPrivilegeEscalation: false` | container | blocks a process from gaining more privileges than its parent (e.g. via a setuid binary) |
| `readOnlyRootFilesystem: true` | container | mounts the container's root filesystem read-only; pair with an explicit `emptyDir` volume for any path that must be writable |
| `capabilities.drop: ["ALL"]` | container | drops all Linux capabilities; add back only the specific ones needed (`capabilities.add: [...]`) |

## Why the Deployment example uses a different image

```yaml
# examples/deployment/deployment-with-security-context.yaml
spec:
  template:
    spec:
      securityContext:
        runAsUser: 101
        runAsGroup: 101
        fsGroup: 101
      containers:
        - name: secure-container
          image: nginxinc/nginx-unprivileged:1.27
          ports:
            - containerPort: 8080   # this image listens on 8080, not 80
          securityContext:
            allowPrivilegeEscalation: false
```

The stock `nginx` image (any tag, `nginx:1.27` here) binds port 80, which needs root (`CAP_NET_BIND_SERVICE` for a port
below 1024) — forcing a non-root `runAsUser` against that image would crash-loop. The
`nginxinc/nginx-unprivileged` image is built to listen on `8080` instead specifically so
it can run as a non-root UID; a Service or Ingress in front of it maps external `80` to
`targetPort: 8080` (see `04-services-and-networking.md`).

## Practical guidance

- Prefer an image built to run non-root (like the unprivileged nginx image here) over
  forcing `runAsUser` on an image that assumes root — the latter works only if the image's
  own files/ports don't require root.
- `runAsNonRoot: true` + a specific `runAsUser` is the strongest combination: it fails
  fast at Pod creation instead of a container silently running as root.
- `kubectl describe pod <name>` shows a clear error in Events if a securityContext setting
  prevents the container from starting — check there first if a secured Pod won't run.
