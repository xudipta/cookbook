# Images and Dockerfiles

A container image is a stack of read-only **layers** plus metadata (entrypoint, env,
exposed ports). `docker build` turns a `Dockerfile` into layers, one per instruction that
changes the filesystem; `docker run` adds a thin writable layer on top and starts a
process in it.

## Quick reference

```bash
docker build -t myapp:dev .          # build an image from ./Dockerfile
docker run --rm -p 8080:80 myapp:dev # run it, remove the container on exit
docker image ls                      # list local images
docker history myapp:dev             # inspect the layer stack and their sizes
docker exec -it <container> sh       # shell into a running container
docker system prune -f               # reclaim space (dangling images/containers/cache)
```

## Try it: `examples/hello-nginx`

```bash
cd topics/docker/examples/hello-nginx
docker build -t hello-nginx .
docker run --rm -p 8080:80 hello-nginx
curl localhost:8080   # -> index.html
```

Read the `Dockerfile` alongside `docker history hello-nginx` — each `RUN`/`COPY` line
maps to one layer.

## Dockerfile tips

- Pin base image tags (`nginx:1.27-alpine`, not `nginx:latest`) so builds are
  reproducible. A tag can still be re-pushed; for a fully immutable build pin the digest
  (`nginx:1.27-alpine@sha256:<digest>`, from `docker buildx imagetools inspect`).
- Order instructions least- to most-frequently-changing: dependency manifests before
  source code, so an edit to application code doesn't invalidate the (slow) dependency
  install layer.
- One `RUN` for a related set of commands; clean up (`rm -rf /var/lib/apt/lists/*`, etc.)
  in the **same** layer, or the deleted files still bloat the image (they only leave the
  *final* layer, not the intermediate one that created them).
- Prefer `COPY` over `ADD` unless you specifically need `ADD`'s tar-extraction or
  remote-URL behavior.
- Run as a non-root `USER` where possible; the base image's default is often `root`.
- Add a `.dockerignore` (`.git`, `node_modules`, build output) so the build context
  — and the layer cache — isn't invalidated by files the image doesn't need.

## Debugging a build

```bash
docker build --progress=plain --no-cache .   # full, uncached build log
docker run --rm -it <intermediate-layer-id> sh  # shell into a layer that failed
```

`hadolint` (this repo's Dockerfile linter) catches most of the above automatically —
run it locally before pushing:

```bash
docker run --rm -i hadolint/hadolint < Dockerfile
```
