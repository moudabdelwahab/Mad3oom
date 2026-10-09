# Mad3oom Dockable Workspace — Architecture and Implementation Report

> Status: implemented on branch `claude/beautiful-mendel-mu5ev2` (not merged, not deployed).
> Migration `074_workspace_layouts.sql` is written and tested against the local production-shape
> database only. It is **not applied to production**; the workspace works without it (see §7).
> Section §12 records what is implemented, what is tested, and what is still pending.

---

## 0. Verified baseline (2026-10-09)

Labels: **[repo]** read in this checkout, **[prod]** read-only against Supabase project
`srnelrdpqkcntbgudyto`, **[gh]** GitHub API.

| Item | Evidence | Value |
|---|---|---|
| Branch | [repo] `git status -sb` | `claude/beautiful-mendel-mu5ev2` = `origin/main` (`e8065a6`), clean tree |
| Open PRs | [gh] `list_pull_requests state=open` | none |
| Last migration in repo | [repo] `ls migrations` | `073_relay_core.sql` |
| Last migrations in prod | [prod] `list_migrations` | `072_invoice_pdf_attachment`, `073_relay_core`; **no `074`** |
| Node test suite on `main` | [repo] `npm run test:node` | 855 tests: 816 pass, 2 skipped, **37 fail — all environmental** (below) |
| SQL/RLS suite on `main` | [repo] `npm run test:sql` | 46 files, exit 0, no `FAIL`/`ERROR` lines |

The 37 baseline failures are not code defects and are unrelated to this feature:
36 come from `tests/chat-page.render.test.mjs` and `tests/chat-widget.render.test.mjs`, which call
`chromium.launch()` without the `resolveChromium()` fallback the other render tests use, so they need
Playwright's pinned Chromium 1148 (this container ships 1194; CI runs `npx playwright install`).
1 comes from `tests/remediation-static.test.mjs:400`, which needs the parent of commit `ec90185`,
absent from this clone's history.

## 1. What the repository actually is

* **Static multi-page site, no bundler, no framework.** Plain HTML pages, ES modules loaded directly
  by the browser, `@supabase/supabase-js` imported from jsDelivr in `api-config.js`, deployed on
  Vercel (`vercel.json` holds only redirects/rewrites). There is no build step and no bundle.
* **Routing** = one HTML file per screen. Admin pages share the top nav + off-canvas sidebar
  injected by `assets/js/admin/sidebar.js` from `assets/components/sidebar.html`.
* **Auth guard** = `checkAdminAuth()` → `guardPage('admin')` (`assets/js/page-guard.js`) →
  `resolveAccess()` (`auth-client.js`). 2FA is enforced at sign-in (`auth-client.js` login flow),
  not per page. The guard is explicitly a *display* guard; authorization lives in RLS and
  `SECURITY DEFINER` RPCs.
* **The three modules the workspace must host are page-level singletons:**

| Module | Files | Shape | Deep link before this change |
|---|---|---|---|
| Conversations (helpdesk inbox) | `admin/inbox.html`, `assets/js/admin/inbox.js` (1858 lines), `inbox-data.js`, `inbox-model.js` | one module-level `state`, ~80 fixed element IDs, realtime channel `admin-inbox` on 9 tables | `?session=<uuid>` |
| Tickets | `admin/tickets.html`, `assets/js/admin/tickets.js` (1736 lines), `tickets-service.js` | module-level `let` state, details panel re-rendered by `innerHTML`, channels `public:tickets` + `admin-tickets-notification-channel` (plays sound) | **none** — `customer-history.js` already links to `/admin/tickets.html?ticket_id=…`, which the page ignored |
| Customer profile | `customer-history.html`, `customer-history.js` | module-level state, no realtime | `?customer_id=<uuid>` |

* **Drafts.** The inbox keeps per-conversation drafts in an in-memory `Map`; the ticket reply box
  lives inside the details panel's `innerHTML` and is wiped whenever another ticket is opened.
  Nothing is persisted, and no page has a `beforeunload` guard.
* **CSS/RTL.** `styles.css` defines colour tokens for light/dark (`[data-theme]`),
  `assets/js/admin/design-tokens.css` adds elevation/motion/focus tokens. Admin pages are
  `lang="ar" dir="rtl"`; `language-manager.js` flips `dir` for English. The inbox already uses
  logical properties (`inset-inline-start`, `margin-inline-start`).
* **Database conventions** (055 → 073): every new table gets RLS, the RESTRICTIVE
  `gate_account_active` policy (042) and the statement trigger `trg_preview_read_only` (041);
  newest tables (073) have **no** direct grants and are reached only through `SECURITY DEFINER`
  RPCs that check `auth.uid()`; every migration has a `_rollback/*.down.sql` and a
  `tests/sql/*.test.sql` run against `tests/fixtures/prod-shape` (a schema snapshot of production).
  `saved_ticket_filters` is the existing precedent for a per-user JSON preference.
* **Tests.** `node --test` for pure models (`*-model.js`) and Playwright render tests that run the
  real page code against `tests/fixtures/supabase-double.js` / `auth-client-double.js`;
  SQL/RLS tests on a throwaway local Postgres (`tests/run-sql-tests.sh`); `scripts/drift-check.mjs`
  inventories migrations/functions. CI: `.github/workflows/tests.yml`, `drift.yml`, `codeql.yml`.
* **Existing docking/tab code:** none. `assets/js/admin/command-palette.js` is a synchronous,
  index-based Ctrl+K palette for the MCP page; its matching (`normalize`/`score`) is not exported.

## 2. The central constraint and the integration decision

The inbox and tickets screens cannot be mounted twice in one document: they own global element IDs
and module-level state. Making them mountable means rewriting ~3,600 lines of working, heavily
tested helpdesk code — exactly what the brief forbids ("host existing functionality rather than
create parallel implementations").

**Decision: each workspace tab hosts the existing page in a same-origin `<iframe>` running in an
explicit *embed mode*.** The page keeps 100% of its logic — guard, RLS-backed queries, RPC writes,
realtime, drafts, keyboard shortcuts — and embed mode only removes the global chrome and narrows the
view (one conversation, one ticket, one customer). A tab therefore behaves exactly like a browser tab
of that page, which is already a supported way to use Mad3oom (supabase-js coordinates token refresh
across same-origin contexts with the Web Locks API and storage events).

**Iframes are never moved in the DOM.** Re-parenting an iframe reloads it, which would discard an
unsent reply when a tab is dragged to another group. All frames live in one overlay layer and are
*positioned* over the content box of the group that shows them (the same technique VS Code uses for
webviews). Moving, docking, splitting and resizing only change coordinates; the document inside keeps
running. A render test asserts that a value typed into a panel survives moving and docking the tab.

## 3. Docking engine evaluation

Registry metadata fetched 2026-10-09 from `registry.npmjs.org`:

| Candidate | Latest | Released | Licence | Deps | Fit with this repo |
|---|---|---|---|---|---|
| `flexlayout-react` | 0.11.1 | 2026-09-26 | MIT | peer `react`, `react-dom` | **Rejected.** No React and no build step here; adopting it means introducing both for one page. |
| `golden-layout` | 2.6.0 | **2022-09-26** | MIT | none | **Rejected.** No release in four years; RTL is not supported; its DOM-reparenting component model reloads iframes unless run in "virtual" mode. |
| `dockview-core` | 8.4.1 | 2026-10-05 | MIT | none | Viable, actively maintained, vanilla. **Not chosen**: it would be imported from a CDN at runtime on the admin critical path (5.5 MB unpacked package; no bundler to tree-shake or pin with integrity), RTL is not a documented feature, and it would still need our frame host, registry, restore validation, dirty protocol and persistence — it would replace only the tree/tab code. |
| **Custom `dock-model.js`** | — | — | — | none | **Chosen.** ~600 lines of pure functions (tested under `node --test` like the repo's other `*-model.js` files) plus a DOM renderer. Logical `start`/`end` edges make RTL correct by construction (flexbox mirrors the row), and it has no supply-chain or bundle cost. |

If the custom engine ever becomes a maintenance burden, `dockview-core` is the documented fallback:
the registry, frame host, bridge and persistence layers are engine-independent.

## 4. Architecture

```
admin/workspace.html                       (guardPage('admin'), sidebar, theme)
└─ assets/js/admin/workspace/
   ├─ dock-model.js       A. layout engine — pure: tree, tabs, dock, split, resize, normalize,
   │                         serialize, parse/validate untrusted layouts
   ├─ panel-registry.js   B. panel types → existing pages; param validation; URL allowlist;
   │                         dedupe keys; parses in-page links back into panels (pure)
   ├─ workspace.js        C. state manager — owns the layout, MRU, recently closed, dirty flags,
   │                         titles, open/close policies, persistence scheduling
   ├─ workspace-view.js      renderer — split containers, dividers, tab bars, drop zones,
   │                         context menu, compact (small-screen) mode
   ├─ frame-host.js          iframe overlay — lazy creation, positioning, live cap, messaging
   ├─ workspace-store.js     persistence — localStorage + optional server RPC (074)
   ├─ workspace-data.js      shell-side reads: access revalidation + titles, quick-open search
   ├─ quick-open.js          Ctrl+K dialog (open panels, records, commands)
   ├─ embed-early.js         classic <head> script: sets embed classes before first paint
   └─ embed-bridge.js        imported by the embedded pages: postMessage protocol, link
                             interception, title/dirty reporting, theme sync
D. Existing modules (unchanged ownership): inbox.js, tickets.js, customer-history.js
```

### 4.1 Layout model (`dock-model.js`)

```
Layout = { version: 1, root: Node|null, panels: { [id]: {id, type, params} }, activeGroup, seq }
Node   = { kind:'group', id, tabs:[panelId…], active:panelId }
       | { kind:'split', id, dir:'row'|'column', children:[Node…], sizes:[fraction…] }
```
* Edges are **logical**: `start | end | top | bottom | center`. The renderer maps a physical drop
  zone to a logical edge using the document direction (in RTL the right edge is `start`).
* `normalize()` runs after every operation: removes empty groups, hoists single-child splits,
  flattens same-direction nesting, re-normalises sizes, repairs `active`/`activeGroup`.
* Limits: 40 panels, 12 groups, depth 6, minimum pane fraction 0.12 (also a CSS min size).
* `parseLayout()` treats input as hostile: rebuilds every object from known fields only, checks id
  formats, node kinds, sizes, depth, that every panel is referenced exactly once, and asks the registry
  to validate each panel's type and params. Malformed structure → rejected (default layout);
  individually invalid panels → dropped.

### 4.2 Panel registry (`panel-registry.js`)

| Type | Params | URL (built only from validated params) | Dedupe |
|---|---|---|---|
| `inbox` | — | `/admin/inbox.html?embed=1` | singleton |
| `tickets` | — | `/admin/tickets.html?embed=1` | singleton |
| `customers` | — | `/customer-history.html?embed=1` | singleton |
| `conversation` | `sessionId` (uuid) | `/admin/inbox.html?embed=1&view=thread&session=…` | one per session |
| `ticket` | `ticketId` (uuid) | `/admin/tickets.html?embed=1&view=ticket&ticket_id=…` | one per ticket |
| `customer` | `customerId` (uuid) | `/customer-history.html?embed=1&view=customer&customer_id=…` | one per customer |

Params are validated against a strict UUID pattern and URLs are built from a fixed template, so a
restored or messaged panel can never inject other query parameters (e.g. `impersonate`, which
`resolveAccess()` honours). New modules (knowledge base, reports…) register a type without touching
the engine.

### 4.3 Embed mode and the bridge protocol

* Embed mode activates only when **all** hold: `?embed=1`, the page is framed, and the parent is the
  same origin (reading `parent.location.origin` throws otherwise). Framed by anyone else, the page
  renders normally.
* Embedded pages skip the sidebar/notification bootstrap and hide the nav and page header via
  `html.ws-embedded` CSS. View narrowing: `ws-view-thread`, `ws-view-ticket`, `ws-view-customer`.
* Messages are `{ ns:'mad3oom-ws', v:1, type, … }` via `postMessage(…, location.origin)`.
  The shell accepts a message only if `event.origin === location.origin` **and** `event.source` is the
  `contentWindow` of a frame it created — the panel identity comes from the frame, never from the
  payload, so a panel cannot impersonate another.

| Child → shell | Meaning |
|---|---|
| `ready` | page booted |
| `title {title}` | tab title (≤ 120 chars, rendered as text) |
| `dirty {dirty}` | unsent input exists (tab shows a dot) |
| `open {panel, side}` | user followed a link to another record → open/focus it as a tab |
| `changed {entity, id, customerId}` | the record shown changed (from realtime) → relay hint |
| `unavailable {reason}` | record missing/forbidden |
| `shortcut {name}` | Ctrl/⌘+K pressed inside the frame |

| Shell → child | Meaning |
|---|---|
| `theme {theme}` | keep `data-theme` in sync |
| `refresh {entity, id}` | related record changed; the page refreshes only if it has no unsent input |

At close time the shell asks the frame synchronously (`contentWindow.__mad3oomEmbed.isDirty()`,
same origin) so a stale `dirty` message can never let a draft be discarded.

## 5. Data integrity rules (enforced in code, covered by tests)

1. Tab moves/docks/splits never reload or re-create a frame (overlay host, §2).
2. Closing a tab, "close others", "close to the end", resetting the layout, and leaving the page all
   check dirty state first and ask for confirmation; the live-frame cap never discards a dirty panel.
3. The workspace never calls a write API. Every write still happens inside the existing page through
   its existing RPC/queries, so no submission can be duplicated by the shell.
4. Restore never trusts saved data: structure validated (§4.1), every record panel re-checked
   against RLS before its frame is created (§6), and the embedded page runs its own guard anyway.
5. If persistence fails, the workspace keeps working with the in-memory layout; pages remain usable
   on their own URLs exactly as before.

## 6. Cross-panel context and synchronisation

* **Source of truth stays the existing realtime subscriptions** in each page (inbox: chat + inbox
  tables; tickets: `tickets`). The shell adds no subscription of its own.
* In embedded single-record views the subscriptions are narrowed: the inbox thread view subscribes
  with `session_id=eq.<id>` filters (`subscribeInbox(handlers, { sessionId })`) and loads one session
  instead of all; the ticket view loads one ticket and does not open the notification-sound channel
  (the tickets-list panel, a singleton, keeps it).
* When a single-record view sees its record change (realtime), it posts `changed`; the shell relays
  `refresh` to customer panels (which have no realtime). Refreshes are skipped while the target has
  unsent input — the ticket view shows an "updated" bar instead of re-rendering over a draft.
* **Opening related records:** the bridge intercepts clicks on links the registry recognises
  (`/customer-history.html?customer_id=`, `/admin/tickets.html?ticket_id=`, `/admin/inbox.html?session=`)
  and asks the shell to open them. Policy: focus the tab if it is already open; otherwise open it in
  the most recently used *other* group, or dock it to the `end` side when there is only one group —
  so the source stays visible beside the target.
* **Revalidation:** before a record frame is created (open or restore), `workspace-data.js` asks the
  database for the record through the user's own RLS (`chat_sessions`, `tickets`, `profiles`) and gets
  the title the same way (`inbox_customer_profiles` for conversation names). A definitive "not
  visible" marks the tab *unavailable* (no frame is created). Network errors are not treated as
  denial; the frame's own guard decides.
* Layout data contains only panel types and record UUIDs — no names, emails, message text or tokens.
  Titles are resolved live after authorization and never persisted.

## 7. Persistence

* **Local (always):** `localStorage['mad3oom.workspace.v1.<userId>']` = `{ savedAt, layout }`, written
  synchronously on every change, so a refresh restores instantly.
* **Server (when 074 is installed):** `workspace_get_layout()` / `workspace_save_layout(p_layout,
  p_base_revision)`, debounced (1.5 s), flushed on `pagehide`. On load, the newer of local/server wins.
  Missing RPC (`PGRST202`/`42883`) disables server sync for the session without errors; preview mode is
  refused server-side and the client stays local.
* **Conflicts** (two windows): last writer wins, explicitly; the server reports `conflict = true` when the
  base revision was stale, and the client notes it once.
* **Migration 074** (`workspace_layouts`): one row per user, `layout jsonb` (object, `version` 1–999,
  ≤ 64 KB), `revision`, `updated_at`; RLS on, `gate_account_active`, `trg_preview_read_only`, **no**
  direct grants to `anon`/`authenticated`/`service_role`; RPCs are `SECURITY DEFINER`, check
  `auth.uid()` and `inbox_is_agent()` (the inbox audience), refuse preview mode, and can only touch
  the caller's row. Rollback: `migrations/_rollback/074_workspace_layouts.down.sql`.

## 8. Performance

* Frames are created lazily — only when a tab is first shown. Restoring ten tabs boots one page per
  visible group, not ten.
* Live-frame cap (6): the least recently shown, **clean** frame beyond the cap is unloaded and reloads
  when shown again. Dirty frames are never unloaded.
* Thread/ticket views load one record instead of the whole inbox/ticket list, and subscribe narrowly.
* The shell adds no realtime socket. Each live frame owns one supabase-js client/socket — the same cost
  as one browser tab of that page; the cap bounds it.
* No dependency added; no bundle exists, so "bundle size" = bytes of new modules (§11).

## 9. Accessibility, responsive, RTL

* Tab bars: `role="tablist"`, tabs `role="tab"` with `aria-selected`/`aria-controls`, roving tabindex,
  ←/→ (direction-aware), Home/End, Delete to close, Shift+F10 / context-menu key for the tab menu,
  Alt+Shift+←/→ to reorder. Panels: `role="tabpanel"`, frames carry a `title`.
* Keyboard alternative to drag-and-drop: tab menu → *Move to new group on the right / left / above /
  below* (labels are physical, as the agent sees the screen; the view maps them to logical edges for
  the current direction), *Move to group…*, *Close*, *Close others*, *Close tabs after this*,
  *Reload panel*, *Reopen last closed tab*.
* Dividers: `role="separator"` with `aria-orientation`, `aria-valuenow`; arrow keys resize by 5 %.
* Focus ring uses `--focus-ring` from `design-tokens.css`; motion uses `--dur-*` tokens.
* Below 900 px the workspace switches to *compact mode*: one strip with every tab, one panel at a time,
  docking disabled; the saved split layout is untouched and returns on a wider screen.
* RTL: logical edges and flexbox order; divider drag deltas are mirrored in RTL; tab insertion index is
  computed against visual order.

## 10. Risks and dependencies

| Risk | Mitigation / status |
|---|---|
| Memory/sockets grow with open frames | lazy creation + live cap; documented |
| Embedded pages' own shortcuts (`/`, `j`, `k`, `?`) only act inside the focused frame | intended; Ctrl/⌘+K is forwarded to the shell |
| A page change that breaks embed mode | render tests boot each page embedded |
| Same agent in two windows | LWW + conflict flag (§7) |
| Migration 074 not installed | workspace is local-only; no error surfaced to agents |

| `production-drift` CI job lists `074_workspace_layouts.sql` as unapplied | expected until 074 is installed; the baseline is deliberately **not** widened to hide it (§13) |

Pre-existing issues observed during reconnaissance (**not changed here**, reported for follow-up):
* `customer-history.js` builds a PostgREST `.or()` filter by string-interpolating the search input
  (the workspace's own search strips `, ( ) " ' \ * %` before building its filter).
* `assets/js/admin/sidebar.js` renders notification `title`/`message` through `innerHTML` unescaped.
* `data-i18n="sidebar_inbox"` has no entry in `language-manager.js`, so after switching language the
  inbox link shows the raw key. (The new `sidebar_workspace` key is added in both languages.)
* `styles.css` resets `margin: 0` on every element, which un-centres native modal `<dialog>`s; the
  workspace restores `margin: auto` on its own dialogs.
* Two render test files bypass `resolveChromium()` (§0).

## 11. Test and validation results (this branch, 2026-10-09)

| Command | Result |
|---|---|
| `node --test tests/workspace-dock-model.test.mjs` | 28/28 pass — engine (groups, tabs, dedupe, move, dock ×4 edges + centre, nested splits, flattening, resize clamps, close/collapse, open-beside policy) and registry (URL allowlist, link parsing, roles); serialize→parse round trip; hostile layouts rejected or sanitised |
| `node --test tests/workspace.render.test.mjs` | 21/21 pass — real Chromium, real page code on the Supabase test doubles (list in §11.1) |
| `npm run test:node` (full suite) | 904 tests: **865 pass**, 2 skipped, 37 fail — the **same 37** environment-only failures as `main` (§0), compared test-by-test; 0 new failures |
| `npm run test:sql` (full SQL/RLS suite, local Postgres 16) | 47 files (46 existing + `workspace-layouts.test.sql`, 11 checks), exit 0, no `FAIL`/`ERROR`; CI sentinels for platform-owner context and conversation-core gate present |
| `node scripts/drift-check.mjs` + `node --test tests/drift-check.test.mjs` | repo inventory OK (74 migrations, 294 functions); 9/9 pass |

### 11.1 What the render tests prove

Starter layout and chrome-less embedding · quick open with live titles and dedupe · drag to the bottom
(nested column split), to the physical right in RTL (= `start`), and to the centre (= move into group),
with **the same document and the same unsent reply** after every move and no send RPC · close with
unsent text asks (button and Delete key), cancel keeps, confirm discards, clean tabs close silently,
reopen-closed works · starter layouts never reuse old panel IDs · keyboard: direction-aware arrows,
Enter, Alt+Shift reorder, Shift+F10 menu → split below, divider arrows with focus kept, full keyboard
quick open · mouse divider drag persists and frames follow · reload restores the nested tree and active
tabs, titles never persisted · tampered layout: unknown types and non-UUID params dropped, frame URLs
carry only `embed/view/session/ticket_id/customer_id` · corrupt layout → default + notice · restored
record not visible under RLS → *unavailable* tab with no frame · server persistence: newer server layout
wins, saves send structure only with the base revision · ticket → customer link opens beside, customer →
ticket link focuses the existing tab · ticket change refreshes the customer panel unless a note is being
written · forged messages (from the page itself, unknown types, path-like IDs, HTML titles) ignored or
rendered as text · lazy frames, live cap of 6, dirty frame never unloaded, unloaded frame reloads on
show · LTR/English mirroring · compact mode at 700 px with no horizontal overflow and the split layout
preserved · non-staff refused by the shared guard · `embed=1` outside the workspace changes nothing ·
plain tickets page honours `?ticket_id=`.

### 11.2 Measurements

* New code, gzip -9: **46.2 KB** for the whole workspace (13 files, 147 KB raw). Only the workspace page
  loads it. Pages that can be embedded load **7.5 KB** more (embed-early.js, workspace-embed.css,
  embed-bridge.js, panel-registry.js). No dependency added.
* Engine at the limit (40 panels, 10 groups), Node 22: dock 0.20 ms, move 0.15 ms, resize 0.11 ms,
  parse+validate 0.10 ms per operation; serialized layout 5.4 KB.
* Synchronous re-render on tab switch, Chromium: typical layout (6 tabs, 3 groups) median **9.3 ms**
  (p90 15.5); at the limit (40 tabs, 8 groups) median **32.6 ms** (p90 44.8).

## 12. Implementation status

**Implemented and tested:** everything in §§2–9: workspace page and sidebar entry (admin/support, same
audience as the inbox); dock engine; registry with six panel types over the existing inbox, tickets and
customer-history pages; embed mode in those three pages; drag-and-drop docking on four edges + centre,
nested splits, resizable dividers; tab menu, keyboard alternatives, quick open, starter layouts, reset,
reopen-closed; dirty-text protection; cross-panel links and change relay; local persistence; server
persistence RPCs (074, local Postgres only); access revalidation on restore; compact mode; RTL/LTR; dark
mode via the shell's theme.

**Behaviour changes to existing pages (all additive):** `admin/tickets.html` now honours
`?ticket_id=` (customer history already linked to it), and the ticket details panel gains a
"سجل العميل ←" link; both apply outside the workspace too. Everything else is gated on embed mode.

**Not done / limitations:**
* Migration 074 is **not applied to production** (no authorization was given). Until it is, layouts
  persist per device only; the `production-drift` CI job lists 074 as unapplied.
* A panel is a full page instance: each live panel has its own supabase-js client and realtime socket
  (bounded by the live cap). A shared-client architecture would require refactoring the inbox and
  tickets pages and was out of scope.
* Moving the inbox's open conversation to its own tab (the "open as tab" button) does not carry the draft
  typed in the inbox panel; the draft stays in the inbox panel.
* Embedded pages keep their existing Arabic-only text; the workspace chrome follows the language switch.
* No automated axe/contrast audit was run (none is set up in the repository); a11y is covered by the
  ARIA/keyboard assertions above.
* Touch drag-and-drop is not supported (HTML5 DnD); small screens use compact mode instead.

## 13. Deployment and rollback

**Deploy (frontend):** merge the branch; Vercel serves the new static files. No build step, no
environment variables, no feature flag needed — the page is reachable from the sidebar for admin/support.

**Deploy (optional server persistence) — requires explicit authorization:**
1. Apply `migrations/074_workspace_layouts.sql` to production (its post-check block raises on any
   deviation and prints `074: ترتيب مساحة العمل جاهز`).
2. Verify read-only: `select to_regprocedure('public.workspace_save_layout(jsonb,bigint)')` is not null and
   `has_table_privilege('authenticated','public.workspace_layouts','SELECT')` is false.
3. Record it in the ledger the same way as 068 (`scripts/ledger/`) if it was applied outside the migration tool.
   No client change is needed: the workspace starts using the RPCs on the next page load.

**Rollback:**
* Frontend: revert the merge. Embedded pages fall back to their pre-change behaviour (embed mode is never
  entered outside the workspace); bookmarks to `/admin/workspace.html` 404.
* Server: run `migrations/_rollback/074_workspace_layouts.down.sql`. It drops only the layout table and
  its two functions; the client detects the missing RPC (`PGRST202`/`42883`) and continues locally. No
  support data (conversations, tickets, customers) is touched by either step.
