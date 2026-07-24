# Mad3oom MCP Client — Phase 0 Scaffold

Implements the layering agreed on:

```
UI  →  MCP Session  →  Connection Manager  →  Authentication Manager  →  Auth Provider
                              │
                              └────────────→  Transport
```

## Where each rule lives

| Rule | Enforced by |
|---|---|
| MCP Layer knows nothing about auth | `session/mcp-session.js` imports only `capabilities/`. No import of `auth/` or `transport/` anywhere in the file. |
| MCP Layer never calls an AuthProvider directly | `session/mcp-session.js` only calls `connectionManager.send(payload)`. |
| Connection Manager has no protocol knowledge | `connection-manager/connection-manager.js` never mentions `initialize`, `tools/list`, etc. — it only knows `send(payload)`, `open()`, `close()`, retry/reconnect. |
| Connection Manager doesn't call AuthProvider directly | It only calls `this.authManager.resolveContext()` / `.handleAuthFailure()` — never `auth/registry.js`. Only `auth-manager/auth-manager.js` is allowed to import `auth/registry.js`. |
| Auth independent of Transport | `auth/types.js` — `AuthContext.applyToRequest()` returns generic `{ headers }`, no transport-specific shape. Any `Transport` implementation accepts the same shape. |
| Transport independent of Auth | `transport/types.js` — `Transport.send(payload, { headers })` takes headers as opaque input; a transport never decides what goes in them. |
| Capability-based, no `if provider==` / `if authType==` after discovery | `capabilities/capability-registry.js` is the only place capability flags are computed (`parseMcpCapabilities`, `canRun`). `mcp-session.js` uses `canRun(this.capabilities, 'resources')`, never a provider/vendor name. |
| New auth method = plugin, zero MCP changes | Add `auth/providers/whatever.js` implementing the `AuthProvider` contract + `registerAuthProvider(...)`. Nothing in `session/` or `connection-manager/` changes. |
| New transport = plugin, zero MCP/Auth changes | Add `transport/transports/whatever.js` implementing `Transport` + `registerTransport(...)`. |

## What's stubbed vs. real in this phase

- `transport/transports/streamable-http.js` — real `fetch`-based implementation, usable now.
- `sse.js`, `stdio.js` — registered, contract-complete, `send()` throws `not implemented yet` (Phase 1 / backend-only for stdio).
- `auth/providers/none.js`, `bearer.js`, `api-key.js`, `custom.js` — real, but `_resolveSecret` is a placeholder hook: actual secret decryption stays server-side, exactly as in the current `mcp-service.js` (`"لا تشفير أو فك تشفير هنا إطلاقًا"`). This scaffold is written to run in the same trust boundary as today's Edge Functions, not in the browser.
- `auth/providers/oauth2.js` — contract-complete; the three tiers (`dcr` / `platform_app` / `manual`) are internal `switch` branches inside this one file only, per your requirement — nothing outside this file knows tiers exist. `manual` already delegates to the existing `saveCredentials`/`startOAuth` functions for backward compatibility; `dcr`/`platform_app` are `TODO`s tied to Phase 2/3 from the architecture report.

## Spec-compliance boundary

`mcp-session.js` sends only what MCP's official spec defines (`initialize`, `notifications/initialized`, `tools/list`, `resources/list`, `prompts/list`, `tools/call`, JSON-RPC 2.0 envelope, `protocolVersion` negotiation). Nothing Mad3oom-specific is injected into the wire messages. Mad3oom-specific behavior (caching `resources`/`prompts` into `mcp_server_connections`, health/heartbeat, platform-owned OAuth apps) lives entirely in the storage/auth layers *around* this file, never inside the protocol messages themselves — so any compliant official MCP server works against this client unmodified.

## Explicitly out of scope for Phase 0

- No changes to `mcp.html` / `mcp.js` / `mcp-service.js` — they keep working exactly as today.
- No new DB tables/columns created yet (that's still Phase 0 work item #2, pending your go-ahead on the Supabase migration itself).
- No Edge Functions touched or created yet.
