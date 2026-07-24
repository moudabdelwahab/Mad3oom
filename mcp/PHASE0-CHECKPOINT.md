# Mad3oom MCP Client — Phase 0 Checkpoint

Status snapshot at the end of this work session. Read this before resuming —
it records what's real, what's still a stub, and exactly where to plug in
next, so a future session doesn't have to re-derive it from the diff.

This file sits alongside the original `README.md` (unchanged, describes the
scaffold as it was handed off) and documents everything added/changed since.

---

## Production status — read this first

**The new architecture is fully scaffolded and tested in isolation. It is
NOT wired into the production execution flow.**

- The production flow — `mcp.js` → `mcp-service.js` → `test-mcp-server` /
  `mcp-invoke-tool` / `mcp-server-info` Edge Functions — is still the one
  actually running. It is untouched (see §3) and has not been modified in
  any way by this session's work.
- `bridge/legacy-bridge.js` exists, is unit-tested against a mocked MCP
  server (see §4), and is ready to be called — but nothing calls it yet. No
  existing file imports `bridge/`, `session/`, `connection-manager/`,
  `auth-manager/`, `auth/`, `transport/`, or `bootstrap.js`. The new
  architecture currently has zero code paths reachable from production.
- **No existing runtime behavior has changed.** Every request a user
  triggers today still goes through exactly the same code it did before
  this session.
- This checkpoint is fully backward compatible and safe to merge as-is:
  merging it changes nothing observable in production, since nothing new is
  wired in yet. The risk profile of merging is "adds unused files," not
  "changes behavior."
- Flipping any of this on is a deliberate future step, gated per-server via
  `isBridgeEnabledFor()` (see §4's integration points) — not something that
  happens automatically by merging this checkpoint.

---

## 0. Discrepancy found before any code was written

The brief for this session listed **Transport Negotiator**, **Legacy
Bridge**, and **Edge Proxy Transport** as already implemented. None of the
three existed in the uploaded `mad3oom-arch.zip`. Concretely:

- `connection-manager.js` already contained `import { negotiateTransport }
  from '../transport/negotiator.js'` — a file that did not exist. The
  scaffold as uploaded would fail on import before any of this session's
  changes.
- No file anywhere imported the auth-provider or transport plugin files, so
  their self-registration side effects (`registerAuthProvider(...)`,
  `registerTransport(...)`) never ran. `resolveAuthProvider()` /
  `resolveTransport()` would throw "not registered" for every single call.
- No `bridge/` directory or file existed at all.
- No "Edge Proxy Transport" file existed. After reading `mcp-service.js` and
  `mcp.js`, the working theory is that `streamable-http.js`'s direct
  `fetch()` already *is* that role — it's designed to run server-side inside
  an Edge Function (Deno), talking directly to the target MCP server, which
  is exactly what `test-mcp-server` does today. There's no CORS/browser
  concern to proxy around in that runtime. **This is an assumption, not a
  confirmed fact** — flagging it again here in case "Edge Proxy Transport"
  meant something more specific (e.g. a transport that itself calls back
  into a Mad3oom Edge Function, for a hypothetical future browser-side
  session). No such file was invented — worth a one-line confirmation before
  Phase 1 starts.

Everything below was built to close these gaps, following the exact patterns
the scaffold itself already established (plugin file + one registration
line; JSDoc-only contract files; no new abstraction layer).

---

## 1. Files added

| File | Why |
|---|---|
| `transport/negotiator.js` | Was imported but missing; scaffold couldn't run without it. Reads `connection.transport`, delegates to the existing `transport/registry.js` — no new decision logic beyond what was already implied. |
| `bootstrap.js` | Composition root. Imports every auth provider and every transport module once, for their registration side effects. Nothing did this before; `AUTH_PROVIDERS`/`TRANSPORT_FACTORIES` were empty at runtime. Also exports `assertBootstrapped()` for a cheap startup sanity check. |
| `contracts/request-context.js` | The `RequestContext` typedef that `auth/types.js`, `transport/types.js`, and `streamable-http.js` already reference via JSDoc `@typedef` imports, but which was never actually committed. Pure JSDoc, no runtime code — matches the style of `auth/types.js`/`transport/types.js` exactly. |
| `bridge/legacy-bridge.js` | The Legacy Bridge named in the architecture but absent from the scaffold. Adapter between the existing Supabase-backed data shapes (`mcp_servers` + `mcp_server_connections` as already read/written by `mcp-service.js`) and the new `McpSession`/`ConnectionManager` stack. **Not wired into any existing Edge Function** — see §4. |
| `PHASE0-CHECKPOINT.md` | This file. |

No new top-level architectural layer was introduced. `bootstrap.js` and
`contracts/` are plumbing/typing, not new layers in the
UI→Session→ConnectionManager→AuthManager→AuthProvider chain.

## 2. Files modified

| File | What changed | What did not change |
|---|---|---|
| `session/mcp-session.js` | (a) Protocol version negotiation: was hardcoded to always assume the server accepts `2025-06-18` with zero validation of the actual response. Now requests `2025-06-18`, checks `result.protocolVersion` against a real supported-versions list (`2025-06-18`, `2025-03-26`, `2024-11-05`), throws a clear error on real mismatch, warns-and-assumes on a spec-non-compliant server that omits the field entirely. (b) Server→client notifications: added `onNotification()`, internal `_stale` flags for `tools`/`resources`/`prompts` driven by `notifications/*/list_changed`, cleared automatically on the next successful list fetch. (c) `dispose()` for clean unsubscription. | `toolsList`/`resourcesList`/`promptsList`/`toolsCall`/`discoverAll` signatures and behavior are unchanged and still capability-gated the same way. Still imports nothing from `auth/` or `transport/`. Still only talks to `connection.send(payload)`. |
| `connection-manager/connection-manager.js` | Added `setProtocolVersion()` (attaches `MCP-Protocol-Version` header to every `send()` after the session negotiates it — correctly *absent* on the `initialize` call itself, present from `notifications/initialized` onward) and `onNotification()` (relays any transport `onMessage` push with no `id` — i.e. a JSON-RPC notification — up to subscribers, without `ConnectionManager` or `McpSession` ever inspecting message *content*). | `send()`'s retry/reconnect/auth-resolution loop, `open()`/`close()`/`isOpen()` lifecycle, and the "Connection Manager knows nothing about JSON-RPC" boundary are all unchanged. |

`mcp.js`, `mcp-service.js`, and `mcp.html` are **byte-for-byte identical** to
the uploaded versions — verified with `diff` before packaging.

## 3. Files intentionally left untouched

- `mcp.js`, `mcp-service.js`, `mcp.html` — explicitly out of scope (brief
  items 5 and 6). Confirmed unmodified.
- `auth/types.js`, `transport/types.js`, `capabilities/capability-registry.js`,
  `auth/registry.js`, `transport/registry.js`, `auth-manager/auth-manager.js`
  — read in full, found already correct and internally consistent with the
  rest of the scaffold. No changes needed.
- `auth/providers/none.js`, `bearer.js`, `api-key.js`, `custom.js` — real
  implementations already, `_resolveSecret` placeholder hook intact as
  designed (decryption stays server-side).
- `auth/providers/oauth2.js` — the three-tier `dcr`/`platform_app`/`manual`
  `switch` is unchanged; `manual` still delegates to `_legacyStartOAuth`.
  `dcr` and `platform_app` remain `TODO`s tied to Phase 2/3, as originally
  scoped.
- `transport/transports/sse.js`, `stdio.js` — still contract-complete stubs;
  `send()` still throws `not implemented yet`. Not touched, since making
  them real is explicitly Phase 1+ work and doing it now would have meant
  guessing at EventSource endpoint-negotiation / subprocess-management
  behavior without a spec reference to verify against.

## 4. Current architecture status

```
UI  →  MCP Session  →  Connection Manager  →  Authentication Manager  →  Auth Provider
                              │
                              └────────────→  Transport
```

- **Runs, verified end-to-end.** Ran the actual module graph (bootstrap →
  bridge → session → connection-manager → auth-manager → auth provider →
  transport) against a mocked MCP server and confirmed: `initialize` →
  `notifications/initialized` → `tools/list` → `resources/list` →
  `prompts/list` sequencing; bearer-auth header injection; protocol-version
  header correctly withheld on `initialize` and correctly attached on every
  request after; rejection of a server that responds with an unsupported
  protocol version; `notifications/tools/list_changed` correctly marking
  `tools` stale and the flag clearing on the next successful `tools/list`;
  `tools/call` round-trip. Also confirmed unknown transport kind, missing
  `connection.transport`, and unknown `auth_type` all fail with a clear
  error instead of silently doing nothing.
- **Real for Phase 0:** `streamable_http` transport, `none`/`bearer`/
  `api_key`/`custom` auth providers, the full `McpSession` protocol surface,
  capability gating, protocol version negotiation, notification relay.
- **Stubbed, contract-complete, registered and reachable, but not
  functional:** `sse` and `stdio` transports; OAuth2 `dcr` and
  `platform_app` tiers; OAuth `refresh`/`revoke`.
- **Built but not connected to production:** `bridge/legacy-bridge.js`
  exists, is tested against a mock server, and exposes
  `discoverServerViaBridge()` / `callToolViaBridge()` with return shapes
  matched to what `mcp-service.js` already expects — but nothing calls it
  yet. It is not imported by `mcp.js`, `mcp-service.js`, or any Edge
  Function.

### Integration points for when Phase 1 (Edge Function wiring) begins

None of this was done yet — it requires the actual source of
`test-mcp-server`, `mcp-invoke-tool`, and `mcp-server-info`, which wasn't
part of this scaffold. When that source is available:

1. **`test-mcp-server`**: wrap the existing connect-and-discover logic in
   `if (isBridgeEnabledFor(server.id, { enabledServerIds })) { return discoverServerViaBridge({ server, connection, resolveSecret, legacyStartOAuth, hasPlatformApp }); } else { /* existing code, unchanged */ }`.
   `enabledServerIds` should come from an env var on the Edge Function, not
   a DB column (migrations are still off-limits — see §5). This is a
   one-line, fully reversible gate around the old code, not a replacement of
   it.
2. **`mcp-invoke-tool`**: same pattern with `callToolViaBridge()`. Note the
   original comment in `mcp-service.js` says this path goes through
   `can_use_mcp_client` permission checks — that check must stay in the Edge
   Function; the bridge does protocol execution only, no authorization.
3. **Shape verification needed**: `discoverServerViaBridge()`'s failure
   shape (`{ok:false, message, tools:0}`) is confirmed to match
   `testServer()`'s fallback path in `mcp-service.js` exactly. Its *success*
   shape (`{ok:true, message, tools:[...], capabilities, serverInfo,
   protocolVersion, resources, prompts}`) is a superset designed to be safe
   for old consumers reading `{ok, message, tools:Array}`, but was **not**
   verified against `test-mcp-server`'s actual current success response,
   since that source isn't in this scaffold. Confirm field-for-field before
   flipping the gate on for a real server.
4. Once a server is flipped on and stable, `connection.tools` (the
   `tools` jsonb column) can be written from `discoverResult.tools`
   directly — same column, same shape (`Array` of tool objects), no schema
   change needed.

## 5. Remaining implementation phases (unchanged from original scope, not started)

- **Immediate next validation step (before Phase 1 wiring)**: everything in
  §4 was verified against a *mocked* MCP server (hand-written `fetch` stub
  returning canned JSON-RPC responses). It has not been run against a real
  MCP server yet. Before wiring the bridge into any production Edge
  Function, run `discoverServerViaBridge()` / `callToolViaBridge()` against
  at least one real, independently-running MCP server — e.g. the Supabase
  MCP server and the GitHub MCP server — to catch anything a hand-written
  mock wouldn't (real SSE-flavored responses on `streamable_http`,
  auth-challenge edge cases, servers that omit `protocolVersion` or send
  extra unlisted capabilities, real network/timeout behavior). This is
  ordinary test-double risk: the mock proves the code paths are wired
  correctly, not that real servers behave the way the mock assumed.
- **Phase 1**: real `sse.js` (`EventSource` + endpoint negotiation, response
  correlation by `id`), real `stdio.js` (backend subprocess management),
  `mcp-provider-discover` wired into `oauth2.js`'s `discoverOAuth()`, first
  actual Edge Function wiring per §4 above.
- **Phase 2**: `platform_app` OAuth tier (`mcp_platform_oauth_apps` +
  PKCE).
- **Phase 3**: `dcr` OAuth tier (RFC 7591 dynamic client registration).
- **Phase 4**: scheduled OAuth token refresh (`mcp-refresh-tokens`),
  `revoke()`.
- **Database changes**: still explicitly not started — no new tables, no
  new columns, no migrations. `resources`/`prompts` caching into
  `mcp_server_connections` (mentioned in the original README) needs a
  schema decision before it can be implemented; today only `tools` has a
  column.

Nothing above was started in this session, per instruction.
