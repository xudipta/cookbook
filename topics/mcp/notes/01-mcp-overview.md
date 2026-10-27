# MCP overview

The **Model Context Protocol** is an open, JSON-RPC 2.0 based protocol for connecting AI
applications to external capabilities. It standardizes the wire format so any compliant
client can talk to any compliant server — "USB-C for AI tools".

## Architecture

```text
Host application (Claude Code, an IDE, a desktop app)
  └── MCP client  ──stdio / HTTP──  MCP server ── external system
      (one per server)                            (DB, API, filesystem, SaaS)
```

- **Host** — the AI app the user runs. It embeds one **client** per connected server.
- **Server** — a small adapter process exposing one system's capabilities over MCP.
- Servers are meant to be narrow and composable; a host typically connects several.

## Transports

| Transport | Shape | Use |
| --- | --- | --- |
| **stdio** | host launches the server as a subprocess, talks over stdin/stdout | local servers, CLI tools |
| **Streamable HTTP** | host connects to a URL; server streams responses (SSE) | remote / hosted servers, shared services |

Older docs mention a separate "HTTP+SSE" transport; it has been folded into Streamable
HTTP.

## The handshake

Every connection starts with the same short exchange. The client sends `initialize` (the
protocol version it speaks, its capabilities and `clientInfo`); the server answers with its own
version, capabilities and `serverInfo`; the client confirms with a `notifications/initialized`
notification. Only then does it ask what the server offers: `tools/list`, plus `resources/list`
and `prompts/list` for the capabilities the server declared. Later calls are `tools/call`,
`resources/read` and `prompts/get`.

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.0.0"}}}
```

If the process cannot start, exits early or answers the first request with an error, the
client reports the server as failed (a stdio process that died shows up as
`MCP error -32000: Connection closed`) and none of its tools exist for the model.

## The three primitives

A server can expose any of:

1. **Tools** — model-invoked functions with a JSON-Schema input (`list_issues`,
   `run_query`). These are what most people mean by "MCP tools".
2. **Resources** — read-only data the host can pull in, addressed by URI
   (`file:///…`, `db://orders/42`). App- or user-selected, not model-invoked.
3. **Prompts** — parameterized prompt templates the user can invoke (often as slash
   commands in the host).

Servers may also request **sampling** (ask the host's model to complete something) and
**elicitation** (ask the user for input) mid-call.

## Trust

An MCP server is code you run and a channel that returns text the model will act on.
Treat tool descriptions and tool results as untrusted input, install servers only from
sources you trust, and scope credentials to the minimum the server needs. See
`03-building-a-server.md`.
