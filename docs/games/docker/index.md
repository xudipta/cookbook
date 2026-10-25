# Layer Cake

A Dockerfile is a stack of cached layers. Arrange the cards, press **Build**, and watch which
layers are reused and which rebuild. A teammate keeps changing things between builds, and a good
order is the difference between a 9-second and a 47-second rebuild.

<div id="game" data-game="docker">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- Cards are Dockerfile lines. Drag them (or use Up / Down / Remove) and add more from the tray.
  `.dockerignore` and the `--cache-from` flag are cards too.
- The first build is free. Later builds cost budget in proportion to the seconds of layers that
  rebuild. A failed build costs a flat amount, so read the log before you rebuild.
- You win by completing the successful builds **and** meeting the level's goals (image size, no
  secrets, non-root, and so on). `b` builds; reading the log is free.

## Syntax worth remembering

```dockerfile
FROM node:20-alpine AS build            # name a stage
COPY package.json package-lock.json ./  # manifest first...
RUN npm ci                              # ...so the install stays cached
COPY . .                                # code last: changes here don't redo the install
FROM nginx:1.27-alpine                  # the last stage is what ships
COPY --from=build /app/dist /usr/share/nginx/html
```

```bash
docker build --cache-from registry.example/app:cache .   # reuse a cache on a fresh CI runner
docker history myapp:dev                                  # layers and their sizes
```

| Rule | Why |
| --- | --- |
| A layer is reused only if it **and everything before it** is unchanged | Put what changes least first |
| `COPY` is keyed on file content; `RUN` on its text | A code edit rebuilds `COPY . .` and all later layers |
| Deleting in a later layer doesn't shrink an earlier one | Clean up in the same `RUN` |
| Only the last stage ships | Build in one stage, run in a small one |
| `.dockerignore` filters the build context | Keeps secrets, `.git` and local dependencies out |

Notes behind it: [Images and Dockerfiles](../../../topics/docker/notes/01-images-and-dockerfiles.md)
and [Multi-stage builds and caching](../../../topics/docker/notes/02-multi-stage-builds-and-caching.md).
