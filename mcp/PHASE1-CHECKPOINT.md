# PHASE1-CHECKPOINT.md — Mad3oom MCP Architecture

**Status: implementation complete, NOT deployed.** Everything below is ready
for review. Nothing in this phase has touched production — no deploy call
was made, per explicit instruction.

---

## 1. Objectives vs. status

| Goal | Status |
|---|---|
| SSE transport | ✅ Implemented, tested against a real local HTTP+SSE server |
| stdio transport | ✅ Implemented, tested against a real subprocess — **but see §4, cannot run inside current Supabase Edge Functions** |
| Wire Legacy Bridge into `test-mcp-server` | ✅ Code ready (`deploy/test-mcp-server/`), gated OFF by default |
| Wire Legacy Bridge into `mcp-invoke-tool` | ✅ Code ready (`deploy/mcp-invoke-tool/`), gated OFF by default |
| Validate against real MCP servers (Supabase MCP, GitHub MCP) | ⚠️ **Not done** — see §5, this needs your environment or a deployed smoke test |
| Preserve backward compatibility | ✅ Gate defaults OFF; unmodified code paths untouched |
| No DB schema changes | ✅ None made. Gate uses a Project Secret (`MCP_BRIDGE_ENABLED_SERVER_IDS`), not a column |
| No modification to `mcp.js` / `mcp-service.js` / existing Edge Function *behavior* | ✅ Not touched (see §6 for why they turned out to be irrelevant to this integration) |

---

## 2. A discrepancy from Phase 0's own assumptions — found and fixed

Phase 0 could not see the real `test-mcp-server` / `mcp-invoke-tool` source (it
wasn't in the scaffold). Phase 1 pulled the actual production code from your
Supabase project to wire against it, and found two real contract mismatches
in the Phase 0 auth providers:

1. **`api_key` auth.** Phase 0's `auth/providers/api-key.js` assumed a
   configurable header name via a `connection.api_key_header` column that
   **does not exist** in `mcp_server_connections`. Production always sends
   `Authorization: Bearer <api_key>` (or `Bearer <api_key>.<api_secret>` if
   both are set). Fixed.
2. **`custom` auth.** Phase 0's `auth/providers/custom.js` expected
   `resolveSecret('custom_config')` to return `{ headers: {...} }`.
   Production's `custom_config_encrypted` decrypts to the headers object
   **directly** (`Object.assign(headers, JSON.parse(raw))`). Fixed.

Also found: `server.connector_type === 'oauth_connector'` (a REST connector
that went through OAuth, not a real MCP server) is a real, actively-checked
column in production — both Edge Functions branch on it before touching any
MCP protocol logic. The bridge integration checks this **before** even
asking `isBridgeEnabledFor()`, so it's structurally impossible for the new
architecture to run against an OAuth connector. `mergeTools`, and the
`oauth_connector` short-circuit itself, were left completely untouched.

None of this was a redesign — it's a contract correction discovered by
"validate against the real system," which is exactly what this phase asked
for. See the doc comment at the top of `bridge/legacy-bridge.js` for the
full technical note.

---

## 3. Files added / modified

### Inside the architecture package (source of truth — `mad3oom-arch/`)

| File | Change |
|---|---|
| `transport/transports/sse.js` | **Implemented.** Was a stub. Full legacy HTTP+SSE MCP transport: `GET` opens a stream, first `endpoint` event gives the POST target, responses are correlated back to requests by JSON-RPC `id` over the open stream (not the POST's own response body — with a fallback if a server *does* answer directly on POST), notifications with no `id` are relayed via `onMessage()`. |
| `transport/transports/stdio.js` | **Implemented.** Was a stub. Newline-delimited JSON-RPC over a subprocess's stdin/stdout, same id-correlation pattern as SSE, stderr piped to logging only. Feature-detects `Deno.Command` and fails with a clear, actionable error if it's unavailable — see §4. |
| `auth/providers/api-key.js` | **Fixed.** See §2.1. |
| `auth/providers/custom.js` | **Fixed.** See §2.2. |
| `bridge/legacy-bridge.js` | **Modified.** Removed the fictional `api_key_header` field; added the Phase 1 discrepancy note documented in §2. `discoverServerViaBridge` / `callToolViaBridge` / `isBridgeEnabledFor` signatures are unchanged from Phase 0. |
| Everything else (`bootstrap.js`, `auth/registry.js`, `auth/providers/{none,bearer,oauth2}.js`, `transport/{types,registry,negotiator}.js`, `transport/transports/streamable-http.js`, `capabilities/capability-registry.js`, `session/mcp-session.js`, `connection-manager/connection-manager.js`, `auth-manager/auth-manager.js`, `contracts/request-context.js`) | **Unchanged from Phase 0.** |

### Deployable Edge Function bundles (`deploy/` — not yet deployed)

| File | Change |
|---|---|
| `deploy/test-mcp-server/index.ts` | **Modified.** One gated branch added: when `server.connector_type !== 'oauth_connector'` **and** `isBridgeEnabledFor(server.id, ...)`, run `runTestViaBridge()` instead of the existing `runTest()`. Everything else — the `oauth_connector` path, `mergeTools`, persistence, response shape — is byte-for-byte the same as production. Added `makeResolveSecret()` (decrypts the same columns `buildAuthHeaders` already does, exposed as the `resolveSecret(name)` callback the bridge expects) and `runTestViaBridge()` (adapts the bridge's return shape to match `runTest()`'s). Response now includes a `via: "bridge" \| "legacy"` field for your own diagnostics — additive, doesn't change any existing field. |
| `deploy/test-mcp-server/_shared/mcp-crypto.ts`, `_shared/mcp-oauth.ts` | **Unchanged**, copied verbatim so the bundle is deployable as-is. |
| `deploy/test-mcp-server/_shared/mcp-arch/**` | **Added.** The architecture package from the table above, copied under this Edge Function so its relative imports resolve. |
| `deploy/mcp-invoke-tool/index.ts` | **Unchanged**, copied verbatim (the gate lives one layer down, in `mcp-client-core.ts`, so `index.ts` didn't need to change at all). |
| `deploy/mcp-invoke-tool/_shared/mcp-client-core.ts` | **Modified.** Same gate pattern: checked *after* the existing `oauth_connector` guard, *before* the existing manual `buildAuthHeaders` + `mcpCallTool` path. If enabled, calls `callToolViaBridge()` instead. |
| `deploy/mcp-invoke-tool/_shared/mcp-transport.ts`, `mcp-tool-registry.ts`, `mcp-crypto.ts`, `mcp-oauth.ts` | **Unchanged**, copied verbatim. |
| `deploy/mcp-invoke-tool/_shared/mcp-arch/**` | **Added**, same bundle as above. |

### Not touched at all

- `mcp.js`, `mcp-service.js` — per your instruction, and also because the
  real `test-mcp-server`/`mcp-invoke-tool` source doesn't import either file;
  they appear to be a separate frontend-facing layer, out of scope for a
  server-side protocol bridge.
- `mcp-server-info` — read-only status/info endpoint; no live JSON-RPC call
  in it, so there's no integration point for the bridge here.
- `mcp_servers` / `mcp_server_connections` schema — no migrations, no new
  columns. The rollout gate is a Project Secret, not a DB column.

---

## 4. stdio transport — real constraint found, not a design choice

`stdio.js` is fully implemented and tested (see §5) against a real
subprocess. But it **cannot run inside `test-mcp-server` or
`mcp-invoke-tool` today**: Supabase's Edge Runtime sandbox does not expose
`Deno.Command` (no subprocess spawning), which was confirmed both by
Supabase's own docs and by feature-detecting the object directly. The
transport checks for this and throws a clear error rather than failing
silently or hanging.

Practical consequence: enabling the bridge for any `mcp_servers` row with
`transport = 'stdio'` will fail cleanly with that message — it will not
silently do nothing. Until there's a separate always-on backend process
(outside Edge Functions), any stdio MCP server should keep being run through
an external `streamable_http`/`sse` proxy (e.g. `mcp-remote`) rather than
enabling the bridge for it.

---

## 5. Test results

### Done, passing (local, real protocol, not hand-mocked in-process)

**SSE transport** — real local HTTP+SSE server (separate Node process, real
sockets), full round trip:
- `initialize`, `tools/list`, `resources/list`, `prompts/list`, `tools/call` — all correlate correctly by JSON-RPC `id` over the SSE stream (not the POST response)
- Concurrent in-flight requests correlate independently, out of order
- Server-pushed notification (no `id`) delivered via `onMessage()`
- Clean `close()`

**stdio transport** — real subprocess (Node child process, via a
`Deno.Command`-shaped shim used only for testing outside Deno):
- Same round trip + notification + close behavior as SSE
- Confirmed clean, descriptive failure when `Deno.Command` is absent (the real Supabase Edge Function case)

**Full stack, end to end** — `bootstrap.js` → `legacy-bridge.js` →
`McpSession` → `ConnectionManager` → `AuthenticationManager` → `sse.js`,
against the same mock server:
- `discoverServerViaBridge()`: protocol version negotiated, tools array shaped correctly, `serverInfo` propagated
- `callToolViaBridge()`: `tools/call` end-to-end

**Auth provider fixes, unit-tested against the exact production wire format:**
- `api_key` with key only → `Authorization: Bearer <key>`
- `api_key` with key + secret → `Authorization: Bearer <key>.<secret>`
- `custom` → flat headers object applied directly (not `{headers:{...}}}`)

One real bug was caught and fixed *during* this testing: an early version of
the local mock server nulled out its "current SSE connection" pointer on a
delayed close event even after a newer connection had already replaced it —
a legitimate race a real MCP server implementation needs to guard against
too. Worth keeping in mind if you ever write your own SSE-based MCP server.

### Not done — needs your input

**Validation against the actual hosted Supabase MCP server and GitHub MCP
server**, as requested, was **not performed**. This sandbox's outbound
network is restricted to an allowlist (npm, pypi, github.com API, etc.) and
does not include `mcp.supabase.com`, `api.githubcopilot.com`, or any other
external MCP endpoint — so I could not make a real request to either from
here, and I'm not willing to fabricate results for a production integration
test. Two ways to actually get this done:

1. **You run it.** I can hand you a small, ready-to-run Deno/Node script that
   points `sse.js`/`streamable-http.js` at a real GitHub or Supabase MCP
   endpoint (with your own token) and prints the full `initialize` →
   `tools/list` → `tools/call` flow.
2. **A temporary Edge Function.** I deploy a throwaway smoke-test function
   (not `test-mcp-server` itself) that imports this same bridge and hits
   both real servers from Supabase's own network, report the output, then
   you decide whether to keep or delete it. This only happens if you ask for
   it explicitly — no Edge Function gets deployed without your go-ahead,
   per your instruction this round.

**OAuth2 provider against a real OAuth-secured MCP server** — reviewed and
unit-tested for correctness of the resolve/refresh logic, but not exercised
end-to-end against a live OAuth2-protected MCP server (same network
constraint as above).

---

## 6. Rollout mechanism (once you approve deployment)

No code change needed to enable a server — set a Project Secret on both
`test-mcp-server` and `mcp-invoke-tool`:

```
MCP_BRIDGE_ENABLED_SERVER_IDS=<server_id_1>,<server_id_2>
```

Both functions must have the **same value** — a server enabled in one but
not the other would test successfully but fail on tool calls (or vice
versa). Leaving it unset (default) means zero behavior change — every server
keeps using the exact legacy path it uses today.

Suggested rollout: pick one low-traffic `transport=streamable_http` or
`transport=sse` server with `auth_type=none` or `bearer` first (avoids the
stdio blocker in §4 and lets you compare `via: "bridge"` vs `via: "legacy"`
responses directly), confirm parity, then expand.

---

## 7. Remaining TODOs

1. Live validation against hosted Supabase MCP + GitHub MCP servers (§5) — needs your decision on which of the two options above.
2. End-to-end OAuth2 test against a real OAuth-protected MCP server.
3. Decide the first server ID(s) for `MCP_BRIDGE_ENABLED_SERVER_IDS` once you're ready to test in production.
4. `mcp-server-info` — confirmed no integration point exists (read-only status endpoint); revisit only if its behavior changes later.
5. stdio-transport MCP servers stay on the legacy/proxy path until a non-Edge-Function backend exists (§4) — no action needed unless you want to scope that work.
6. Database work (Phase 2, per your original constraints) — untouched, as instructed.

---

## 8. What to review before deploying

- `deploy/test-mcp-server/index.ts` — diff against your live version is the gated branch + `makeResolveSecret`/`runTestViaBridge` additions only; every other function (`buildAuthHeaders`, `runOauthConnectorCheck`, `mergeTools`, `runTest`) is byte-identical to production.
- `deploy/mcp-invoke-tool/_shared/mcp-client-core.ts` — same pattern, gated branch inserted after the existing `oauth_connector` guard.
- Both `_shared/mcp-arch/` bundles are identical copies of the same source-of-truth package in this delivery (`mad3oom-arch/`).
