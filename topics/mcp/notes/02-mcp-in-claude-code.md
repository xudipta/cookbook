# MCP in Claude Code

## Config scopes

| Scope | Where | Committed? | Use |
| --- | --- | --- | --- |
| `local` | project entry in `~/.claude.json` | no | personal, machine-specific servers |
| `project` | `.mcp.json` at the repo root | yes | servers the whole team should have |
| `user` | user settings | no | servers you want in every project |

More specific scopes win when names collide. `project` servers prompt for approval the
first time, since the file is shared.

## `.mcp.json`

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "env": {}
    },
    "grafana": {
      "type": "http",
      "url": "https://grafana.example.com/mcp",
      "headers": { "Authorization": "Bearer ${GRAFANA_TOKEN}" }
    }
  }
}
```

- `command` + `args` → stdio server; `type: "http"` + `url` → remote server.
- `${VAR}` in `env`, `args`, `url`, and `headers` expands from the environment, so no
  secrets land in the committed file.

## Secrets and authentication

- **Tokens in headers or env.** Pass a bearer token with `headers` (`"Authorization": "Bearer
  ${GRAFANA_TOKEN}"`) or a stdio server's `env`, and keep the value in your shell, never in a
  committed `.mcp.json`. Quote `'${VAR}'` on the command line so your shell does not expand it
  before `claude mcp add` writes it down.
- **OAuth.** A hosted server that answers `401` with an authorization challenge is signed in
  from inside a session with `/mcp`.
- **Least privilege.** Give a server the narrowest token that does its job (a read-only,
  fine-grained token rather than an org-admin one).

## CLI

```bash
claude mcp add fs --scope project -- npx -y @modelcontextprotocol/server-filesystem ./
claude mcp add-json grafana '{"type":"http","url":"https://…/mcp"}' --scope local
claude mcp list
claude mcp get fs
claude mcp remove fs
```

## Using it in a session

- Tools appear as `mcp__<server>__<tool>`; approve them like any other tool.
- Resources: `@<server>:<uri>` to pull one in; some are offered for `/`-mention.
- Prompts exposed by a server show up as `/<server>:<prompt>` slash commands.
- `/mcp` shows connection status and lets you authenticate OAuth servers.
