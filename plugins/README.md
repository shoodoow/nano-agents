# MCP plugins (per account)

Each account connects **HTTP Streamable MCP** servers. Tool names in chat are `{slug}_{tool}` (e.g. `crm_search`).

## API

- `GET /accounts/:accountId/mcp` — list connectors (URL, tools cache, last error; no secrets)
- `PUT /accounts/:accountId/mcp` — create/update (`slug`, `url`, optional `secret` bearer, optional `enabled`)
- `DELETE /accounts/:accountId/mcp/:slug`

Secrets are sealed like provider keys. On save, core connects once, refreshes `tools_cache`, and reuses live sessions during turns.

## Sample stdio server (local dev)

For testing the MCP protocol locally, run the in-repo echo server (stdio — not addable via the account API):

[`apps/core/src/mcp/servers/echo.ts`](../apps/core/src/mcp/servers/echo.ts)

Expose it with any Streamable HTTP wrapper you use in dev, or point an account MCP URL at your hosted endpoint.

## In-process tools

Optional code-only tools still use [`registerPluginTool`](../apps/core/src/turn/plugins/registry.ts) (no sample shipped). Prefer MCP for anything account-specific.

See [GUIDE.md](../apps/core/src/turn/GUIDE.md).
