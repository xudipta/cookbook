# MCP (Model Context Protocol)

Notes and example configs for **MCP** — the open protocol that lets an AI agent connect to
external tools and data through a uniform interface.

## What MCP connects

```mermaid
flowchart LR
    Host["Host app\n(Claude Code, an IDE, a desktop app)"] --> Client["MCP client\n(one per server)"]
    Client <-->|JSON-RPC 2.0| Server["MCP server"]
    Server --> External["external system\n(DB, API, filesystem, SaaS)"]
```

One host can run many clients at once, each talking to a different server — that's how
an agent ends up with tools spanning a database, a ticketing system, and your local
filesystem simultaneously, all through the same protocol.

**Play it:** [Patch Bay](../../docs/games/mcp/index.md) is a short game where you wire an agent
to MCP servers with `claude mcp` commands, read the JSON-RPC on the wire, and keep secrets and
untrusted servers out, using the same config these notes teach.

## Contents

- `notes/01-mcp-overview.md` — architecture, transports, and the three primitives.
- `notes/02-mcp-in-claude-code.md` — `.mcp.json`, config scopes, `claude mcp` commands.
- `notes/03-building-a-server.md` — a minimal server and the security checklist.
- `examples/config/` — sample client configuration files.

New here? Start with `notes/01-mcp-overview.md`, then `notes/02-mcp-in-claude-code.md`
alongside `examples/config/.mcp.json`.

## Quickstart

```bash
jq . topics/mcp/examples/config/.mcp.json    # pretty-print + validate a real client config
claude mcp list                               # see it recognized, if you're in Claude Code
```

## Validation

- `markdownlint` covers the notes.
- A `jq` syntax check runs on every JSON file under `examples/` (including the
  dot-prefixed `.mcp.json`).

```bash
find topics/mcp/examples -name '*.json' -o -name '.mcp.json' | xargs -I{} jq empty {}
```
