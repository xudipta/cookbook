# Patch Bay

Wire an AI host to its MCP servers with `claude mcp`, serve each request the right way, and keep secrets and rogue servers out.

<div id="game" data-game="mcp">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- Type commands in the terminal (or use the quick buttons). Reading (`list`, `get`, `/mcp`, `cat`, the
  inspector) is free; every change and every serve is a move. Output is simulated.
- Serve the next request with **Call tool** (`t`), **Attach resource** (`a`) or **Run prompt** (`u`). A
  request that finds no connected server, or uses the wrong primitive, costs trust and does not advance.
- Win by serving every request with nothing left broken: no failing entry, no token in the committed
  file, no admin-scoped token, no stale or unvetted server. A compromise ends the run.
- A teammate's requests see only the project scope (`.mcp.json`). Entries you add yourself are
  approved; ones that arrive in a pull wait for your decision.

## Syntax worth remembering

```bash
claude mcp add fs --scope project -- npx -y @modelcontextprotocol/server-filesystem ./   # stdio
claude mcp add --transport http grafana https://grafana.example.com/mcp --scope project \
  --header 'Authorization: Bearer ${GRAFANA_TOKEN}'                                      # Streamable HTTP
claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN='${GITHUB_TOKEN}' -- npx -y @modelcontextprotocol/server-github
claude mcp list; claude mcp get fs; claude mcp remove fs --scope local
npx @modelcontextprotocol/inspector --cli node ./server.js --method tools/list
```

| Handshake and calls | Meaning |
| --- | --- |
| `initialize`, `notifications/initialized` | version and capability exchange |
| `tools/list`, `tools/call` | what the model can call, and a call |
| `resources/read`, `prompts/get` | data you attach (`@server:uri`), a template you run (`/server:name`) |

Single-quote `'${VAR}'` so your shell does not expand it before it is written down. The default scope is
`local`; `project` writes `.mcp.json`, and the more specific scope wins when names collide.

Notes behind it: [MCP overview](../../../topics/mcp/notes/01-mcp-overview.md),
[MCP in Claude Code](../../../topics/mcp/notes/02-mcp-in-claude-code.md) and
[Building an MCP server](../../../topics/mcp/notes/03-building-a-server.md).
