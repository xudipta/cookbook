# Multi-stage builds and layer caching

## Why multi-stage

A multi-stage `Dockerfile` uses one stage to *build* the artifact (compilers, dev
dependencies, source) and a second, minimal stage to *run* it. Only the final stage ships
— the build tooling never reaches the image you deploy.

```dockerfile
# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime stage ---
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

Benefits:

- Smaller final image (no compiler, no package manager cache, no dev dependencies).
- Smaller attack surface — fewer binaries an attacker could use if the container is
  compromised.
- One `Dockerfile`, no separate build script needed to assemble a "clean" image.

You can also stop a build at an intermediate stage for debugging:

```bash
docker build --target build -t myapp:build-debug .
```

## How the layer cache works

Docker caches each instruction's result keyed on the instruction *and* its inputs. On a
rebuild, it reuses cached layers until it hits the first instruction whose input changed,
then rebuilds every layer after that point — even if a later layer's own input didn't
change.

```dockerfile
# Bad: any source change reinstalls dependencies
COPY . .
RUN npm ci

# Good: dependency layer only invalidates when the manifest changes
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
```

`COPY`/`ADD` are cache-busted by content hash of the copied files; `RUN` is cache-busted
only when the instruction text or an earlier layer changed — Docker does not know that
`apt-get update` output is stale, which is why it's paired with the install in the same
`RUN`.

## Build cache in CI

Each CI run typically starts from an empty cache. To carry a cache between runs:

```bash
# BuildKit inline cache: push the cache metadata alongside the image
docker build --cache-from myapp:main --build-arg BUILDKIT_INLINE_CACHE=1 -t myapp:main .

# or export/import a cache directory (docker/build-push-action's cache-to/cache-from
# in GitHub Actions does this for you — see topics/cicd/)
```
