# Mad3oom Continuity: scoped handover and delegated access (design, not implemented)

> **Status:** design for review, 2026-10-12. **Nothing is implemented.** No migration, no RPC and no UI change is in this PR.
> - **Builds on:** #124 (081 handover), stacked on #123 → #121 → #119 → #118 → #117 → #116.
> - **Target:** migration **082** in a separate implementation PR, after you approve this design and decide the open questions in §12.
> - **Production boundary:** no merge, deploy, production migration or enablement without your explicit approval.

---

## 0. Summary
- **One system, not two.** The existing handover (081, `continuity_handovers`) gains a **mode**:
  - `transfer`: today's behaviour. Ownership moves on acceptance.
  - `review`: partial, view-only access to selected content. The owner is unchanged.
  - `collab`: temporary collaborative review with a few permitted actions. The owner is unchanged.

  All three share the same request, acceptance, cancellation, audit and concurrency code.
- **Effective access = approved scope ∩ the recipient's own current permissions ∩ the record's current state.**
  - A grant only *narrows* what the recipient can see through Continuity. It never substitutes for conversation access.
  - A selected message from a conversation the recipient cannot open stays hidden. This is §3 of your brief, enforced the same way excerpts are enforced today (C3).
- **The scope is an explicit, immutable, versioned list.**
  - It holds source IDs, attachment IDs, an optional message time range, actions, expiry and a reason.
  - It is resolved when the request is created, so later additions to the record are never included silently.
  - Narrowing applies immediately. Any expansion is a new scope version that the recipient must accept.
- **Every protected read and write re-checks the grant on the server:** state, expiry, bound session, recipient eligibility, grantor authority and record state.
  - Attachments shared through a grant are **not** readable through the bucket policy at all. They are signed only by a server function, with a TTL capped at the grant's remaining life.
- **Acceptance when the record changes:**
  - The recipient's last review is recorded as a version plus a **material digest**.
  - Ordinary edits (wording, priority) never block acceptance; the recipient is told what changed (field names only).
  - Material changes (status, owner, team, kind, due date, or anything in the approved scope) require a fresh review before acceptance.
  - This **replaces** 081's exact-version check, which made *any* edit force a re-review.

---

## 1. What exists today (inspected)
| Area | Current behaviour | Where |
|---|---|---|
| **Handover** | A request is `pending` / `accepted` / `declined` / `cancelled` / `expired`. Ownership changes only on accept. Pending grants **no** access: the recipient reads a package with descriptive fields and counts only. One pending request per record. A record trigger cancels it on reassign or close. Acceptance requires `p_expected_version = current version` | `migrations/081_continuity_handovers.sql` (#124) |
| **Record access** | `continuity_can_access(record)`: an active member who is supervisor, owner, creator or team member | 077 |
| **Sources** | One source = one chat message. An immutable **snapshot** holds `excerpt` (≤4000), `sender_label`, `original_created_at`, `origin_session_id` and redaction fields | 073 (`relay_sources`, `relay_source_snapshots`) |
| **Excerpt visibility (C3)** | `_continuity_source_view` returns an excerpt only if the caller can access the record **and** `_continuity_can_read_conversation(origin_session)` is true now (→ `inbox_can_access`). It also handles redaction and retention | 077 |
| **Conversation access** | `inbox_can_access(session)`: a supervisor, or platform staff (not in preview mode) assigned to the session | prod-shape `51_functions_b.sql` |
| **Attachments** | Private bucket. The one `SELECT` policy calls `_continuity_attachment_readable(name)`: active attachment, record access, capability on, retention not expired. 300 s signed URLs. No write policy | 080 (#121) |
| **Audit** | Append-only `continuity_events`. Free text appears only as hashes (`_continuity_hash`) | 073 / 077 |
| **Realtime** | **No** Continuity table is in `supabase_realtime`. Only `inbox_*` tables were added (055, 056, 058) | migrations |
| **Exports, search, notes, proposals** | None exist for Continuity. List and search go through `continuity_list` (own records only) | — |
| **Tenancy** | Only the `platform` workspace is enabled. Platform staff (`admin`, `support`, `platform_owner`) and company roles (`company_admin`, `company_user`) are strictly separate authority domains (035). Eligible recipients are `_continuity_is_eligible_owner` = `_inbox_is_eligible_agent` + an active account | 035, 077 |
| **Session identity** | `_jwt_session_id()` reads `request.jwt.claims ->> 'session_id'`. It is already used for owner step-up, so a one-session grant is enforceable on the server | 053 |

**What this means for the design:**
- **Message-level selection is natural,** because a source *is* a message.
- **Sub-message excerpt ranges are not supported.** Snapshots are whole-message copies, truncated to 4000 characters (decision **S-5**).
- **Date ranges filter on `snapshot.original_created_at`.**

---

## 2. Principles (from your brief, made testable)
1. **No new privilege.**
   - **Recipient eligibility:** the recipient must be eligible staff in the record's workspace, on every check.
   - **Excerpts:** each excerpt still needs the recipient's own conversation access at read time (C3).
   - **Attachments:** each attachment still needs to be active, inside retention and in scope.
2. **The server is the boundary.** Every new RPC re-validates the grant. The UI only reflects what the server returns.
3. **What is excluded does not exist** for the recipient: no counts, positions, IDs, titles, metadata, error variants or notifications.
4. **Scope never grows by itself.** Explicit ID lists are resolved at request time. Expansion is a new scope version the recipient must accept.
5. **Terminal is terminal.** `declined`, `cancelled`, `expired` and `revoked` grants never come back: not by reopening the record, reassigning it back, or reusing a URL.

---

## 3. Modes
| | `transfer` (full handover) | `review` (partial review) | `collab` (temporary collaborative review) |
|---|---|---|---|
| **Ownership** | Moves to the recipient on acceptance | Never | Never |
| **Scope** | The whole record (fixed) | Selected sources and attachments, optional time range | Same as review |
| **Allowed actions** | — (they become the owner) | `view` only | `view` plus any of: `note`, `propose`, `edit_fields`, `add_source` |
| **Expiry** | — | Required: finite by default | Required: finite, capped by policy |
| **Before acceptance** | Package only (descriptive fields and counts) | Scope preview (counts and kinds, no content) | Same as review |
| **After acceptance** | Normal owner access (C3 still applies per source) | Read-only scoped view | Scoped view plus the permitted actions |
| **Who may request** | Owner, supervisor, assigner (081 rule) | **Owner only**, or a supervisor/assigner acting for the owner (decision **S-4**) | Same as review |

**Least-privilege defaults:**
- **Scope:** for `review` and `collab`, the dialog starts on **selected content** with nothing pre-selected.
- **Actions:** `view` only.
- **Expiry:** **4 hours** (policy `delegation_default_minutes`).
- **Ongoing access** is offered only when the policy `delegation_allow_ongoing` is `true` (default **false**).

---

## 4. Data model (migration 082)
### 4.1 `continuity_handovers` (extended; existing rows keep today's meaning)
| Column | Type / rule |
|---|---|
| `mode` | `transfer` \| `review` \| `collab`, default `transfer` (existing rows) |
| `scope_version` | int: the currently **active** scope version (null for `transfer`) |
| `reviewed_version`, `reviewed_digest`, `reviewed_at` | The recipient's last review (§7) |
| `expires_at` | timestamptz: absolute end of access (null only for `ongoing`) |
| `bound_session_id` | text: set at acceptance when expiry kind is `session` |
| `revoked_at`, `revoked_by`, `revoke_cause` | `owner` \| `grantor` \| `supervisor` \| `record_closed` \| `reassigned` \| `grantor_lost_authority` \| `recipient_ineligible` \| `scope_superseded` |
| `state` | adds `revoked`. Keeps `expired` (now also used for time and session expiry, with `cancel_cause` = `target_ineligible` \| `time` \| `session`) |

**State machine:**
```
pending ──accept──▶ accepted ──(review/collab)──▶ revoked | expired     (terminal)
   │                   └─(transfer)── terminal (owner changed)
   ├──decline──▶ declined
   ├──cancel───▶ cancelled
   └──recipient ineligible / record closed / reassigned ──▶ cancelled | expired
```

**Activity is computed on every call,** not only through the sweep. A `review` or `collab` grant is **active** iff **all** of these hold:
- `state = 'accepted'`;
- `now() < expires_at`, or the expiry is ongoing and allowed by the current policy;
- if session-bound, `bound_session_id = _jwt_session_id()`;
- the recipient is still eligible and active;
- the record is active;
- the grantor still holds authority.

An hourly sweep only *materialises* `expired` and `revoked` states and their events, for audit and listing.

### 4.2 `continuity_handover_scopes` (new; immutable and versioned)
| Column | Notes |
|---|---|
| `handover_id`, `version` | `UNIQUE (handover_id, version)` |
| `status` | `proposed` \| `approved` \| `superseded` \| `rejected` |
| `source_ids uuid[]` | **Resolved** list. "Entire record" is stored as the list of active sources at request time |
| `attachment_ids uuid[]` | Resolved the same way. Exclusions are absent from the list |
| `range_from`, `range_to` | timestamptz, half-open `[from, to)`. Applied **in addition** to `source_ids` |
| `range_tz` | IANA zone. Display only; the instants are absolute |
| `actions text[]` | ⊆ `{view, note, propose, edit_fields, add_source}`. Must include `view` |
| `editable_fields text[]` | ⊆ `{next_action, summary, due, priority, waiting_on}`. Only with `edit_fields` |
| `expiry_kind` | `session` \| `duration` \| `until` \| `ongoing` |
| `duration_minutes`, `until_at` | According to `expiry_kind` |
| `reason` | Required, ≤1000 characters. Shown to the recipient. Hashed in events |
| `created_by`, `created_at` | |

**Constraints:**
- The arrays may contain only IDs of the **same record and workspace**. A trigger checks every element.
- Rows are immutable apart from the `status` transitions.
- `transfer` requests have no scope row.

### 4.3 For `collab` actions (decision **S-3**: in 082 or a follow-up, 082b)
- **`continuity_notes`** (`record_id`, `author_id`, `handover_id` null, `body` ≤2000, `created_at`):
  - append-only;
  - visible to anyone who can access the record, and to the grant that wrote it;
  - an event holds the hash only.
- **`continuity_change_proposals`** (`record_id`, `handover_id`, `patch jsonb` limited to the permitted fields, `state` `pending`/`applied`/`rejected`, `decided_by`, `decided_at`): the owner applies or rejects through the normal `continuity_update` path, with its version check.

### 4.4 `continuity_policies` (extended)
| Column | Default |
|---|---|
| `delegation_default_minutes` | 240 |
| `delegation_max_minutes` | 10 080 (7 days) |
| `delegation_session_max_minutes` | 720 (a hard cap even for session grants) |
| `delegation_allow_ongoing` | `false` |

They change through the owner-only `continuity_set_policies`, with history, like the existing policy columns.

---

## 5. Enforcement points
### 5.1 One gate
`_continuity_active_grant(p_record uuid, p_action text) returns continuity_handovers`, `SECURITY DEFINER`, revoked from everyone. It refuses (`P0002 not_found`, one message for every cause) unless **all** of these hold:
- the caller is `to_owner` and `_continuity_is_member()`;
- the caller is still `_continuity_is_eligible_owner`;
- the capability `handovers_enabled` is on;
- the grant is active (§4.1) and `p_action = ANY(actions)` of the approved scope;
- the record is active, in the same workspace, and the platform workspace is enabled.

It also re-checks **grantor authority**: the grantor must still be the owner, or a supervisor or assigner who can access the record. If not, it revokes the grant in place (`grantor_lost_authority`, with an event) and refuses.

### 5.2 Reads
**`continuity_shared_get(p_record)`** returns a **scoped view**:

| Part | What the recipient gets |
|---|---|
| **Record** | Core fields only: kind, title, summary, next action, status, priority, category, due, version |
| **Not returned at all** | Owner and team IDs, closures, events, assigners, handover history, trash, policy |
| **Sources** | Only those in `source_ids` **and** inside the range. **Renumbered** `1..n`, so original positions do not reveal what is excluded. Each one passes through a refactored `_continuity_source_view` whose record-access test is replaced by "this grant is active and includes this source". **C3 still applies:** no conversation access means `excerpt: null` with the same `no_conversation_access` marker as today |
| **Attachments** | Only those in `attachment_ids`, active and inside retention. Metadata only; files via §5.3 |

**`continuity_shared_with_me()`:** active grants, each with the record title, mode, expiry and actions. Nothing else.

**Unchanged,** so shared records never leak into them: `continuity_list`, `continuity_get`, `continuity_events_for` and search. Unknown or out-of-scope IDs give the same `P0002` as nonexistent ones.

### 5.3 Attachments shared through a grant
- **The bucket's `SELECT` policy is not widened.** Grant holders cannot sign URLs themselves.
- **Edge Function `continuity-shared-attachment-url`:**
  - verifies the user's JWT;
  - calls `continuity_shared_attachment_check(p_attachment)` **as the user** (the §5.1 gate, plus scope membership), which returns the path;
  - signs with the service role, with **TTL = min(60 s, `expires_at` − now)**.
- **Revocation or expiry** therefore cuts new URLs immediately, and an existing URL lives at most 60 s (decision **S-7**).

### 5.4 Writes (`collab` only, per permitted action)
| RPC | Gate action | Checks on top of the gate |
|---|---|---|
| `continuity_shared_add_note` | `note` | Length limit. Event holds a hash only |
| `continuity_shared_propose` | `propose` | Patch keys ⊆ `editable_fields`. Creates a proposal; the owner decides |
| `continuity_shared_update` | `edit_fields` | Patch keys ⊆ `editable_fields`. Same validation and version check as `continuity_update`. Cannot touch owner, team, status or sources |
| `continuity_shared_attach_sources` | `add_source` | The recipient's **own** conversation access, exactly as `_continuity_attach` checks today. New sources are added to **this grant's** visibility only as "added by grantee". Never to other grants |
| Attachment upload (080 path) | `add_source` | `continuity_attachment_begin` gains a grant-aware branch. The new attachment is visible to the grantee and the record viewers |

Each write records the grant ID in its event payload.

### 5.5 Channels you listed
| Channel | Status |
|---|---|
| **Normal requests / RPC** | §5.1–5.4 |
| **Direct RPC that bypasses the UI** | The same functions; there is no UI-only check |
| **Realtime** | No Continuity table is published. 082's verification block will **assert** that no `continuity_*` table is in `supabase_realtime`, so a later change cannot add one silently |
| **Exports** | None exist. Any future export must use the shared view functions (stated in the migration header) |
| **Signed URLs** | §5.3 |
| **Notifications** | The scheduler increment is still to come. Templates carry only IDs, mode and expiry; never titles from out-of-scope content and never excerpts |
| **Search / counts / errors** | §5.2. One `not_found` for every refusal cause, as 077 already does |

---

## 6. Lifecycle rules (explicit)
| Event | `transfer` | `review` / `collab` |
|---|---|---|
| **Decline** | `declined`; nothing changes | `declined`; no access ever existed |
| **Cancel** (requester, supervisor, assigner) | `cancelled` | Pending: `cancelled`. Accepted: **`revoked`** (`owner` / `supervisor`) |
| **Revoke** (owner, grantor, supervisor) | — | `revoked`, effective on the next call; URLs ≤ 60 s |
| **Record closed** (resolve/cancel) | Pending → `cancelled record_closed` (081 trigger) | Pending → `cancelled`; accepted → `revoked record_closed` |
| **Record reassigned** (owner or team change) | Pending → `cancelled reassigned` (081) | Pending → `cancelled`; accepted → `revoked reassigned`. Whether a *supervisor-issued* grant survives a reassignment is decision **S-4** |
| **Record reopened** | — | **Nothing is restored.** Terminal grants stay terminal; a new request is needed |
| **Time / session expiry** | — | `expired time` / `expired session`: computed on every call, materialised by the sweep |
| **Recipient no longer eligible** | Pending → `expired target_ineligible` | Accepted → `revoked recipient_ineligible` |
| **In-scope source removed, redacted or purged** | — | It disappears from the view immediately. The scope row is unchanged, as history |
| **Feature switched off** | Request, decide and read blocked; cancel allowed (081) | Every shared read and write blocked; grants are frozen, not lost. Switching back on resumes only grants still within expiry |

**Reusing a stale link or page:**
- Every protected call re-runs the gate.
- An open page receives `not_found` on its next call. The UI also clears the scoped view at `expires_at` (cosmetic only).
- Attachment URLs are capped at 60 s.

---

## 7. Acceptance when the record changes (all modes)
**The problem with 081 today:** acceptance requires the exact current version. Any edit makes the recipient re-fetch, so acceptance is never *permanently* blocked, but every edit, however minor, forces a re-review.

**Design:**
1. **`continuity_handover_review(p_handover)`** (recipient only, pending only):
   - returns the package (transfer) or the scope preview (review/collab), with **no protected content**;
   - returns the current `version` and a **material digest**;
   - stores `reviewed_version`, `reviewed_digest` and `reviewed_at`, with event `handover_reviewed`.
2. **The material digest** is the SHA-256 of a canonical JSON made of:
   - the record's `status`, `owner_id`, `team_id`, `kind`, `category`, `due_at` and `due_tz`;
   - for review/collab, the **approved scope's** current state: for each in-scope source and attachment, whether it is still active (not removed, redacted, purged, or out of retention);
   - for transfer, the number of active sources and attachments.

   **Ordinary changes** are not in the digest: `title`, `summary`, `next_action`, `problem`, `priority`, `waiting_on`.
3. **`continuity_handover_decide(…, p_reviewed_digest)`** replaces `p_expected_version`. Inside one locked transaction (record, then request, then scope):
   - **Re-check:** recipient eligibility; record active; owner and team unchanged (otherwise the 081 trigger already cancelled it); grantor authority; mode-specific scope validity.
   - **If the current material digest ≠ `p_reviewed_digest`:** `40001 material_change`, with the list of changed **categories** (`status`, `due`, `scope_items_removed`, …). No values, no content. The recipient must review again.
   - **If only the version moved:** acceptance proceeds. The response carries `changed_since_review: [field names]`, so the UI can tell the recipient what changed.
4. **The scope is never re-resolved at acceptance.** New sources added to the record while the request is pending are **not** included.
5. **UI:**
   - When `version ≠ reviewed_version`, the incoming request shows «اتعدّل السجل بعد مراجعتك» with the changed field names.
   - When the change is material, «قبول» becomes «راجع التغييرات» until a fresh review.

---

## 8. Scope changes after acceptance
| Change | Effect |
|---|---|
| **Narrowing:** remove items, shorten expiry, remove actions | Owner or grantor applies it **immediately**. A new scope version is approved without recipient consent (least privilege). Event `scope_narrowed` |
| **Expansion:** add items, extend the range or expiry, add actions | A new scope version in `proposed`. The **current approved scope stays in force** until the recipient explicitly accepts; then the old version is `superseded`. Events `scope_proposed` / `scope_accepted` / `scope_rejected` |
| **Mixed** | Treated as an expansion. The narrowing part is applied at once, the expansion part waits |
| **Content added to the record** | Never added to an existing grant automatically |

---

## 9. Expiry options
| Kind | Enforcement |
|---|---|
| **`session`** | Bound to the recipient's JWT `session_id` at acceptance. Every call compares it with `_jwt_session_id()`. A new sign-in, a different device or a refreshed session with a new ID ends access. It is also hard-capped by `delegation_session_max_minutes` |
| **`duration`** | `expires_at = accepted_at + duration`. The clock starts at **acceptance**, not at request time (decision **S-1**) |
| **`until`** | An absolute instant. Must be in the future at request and at acceptance, and ≤ now + `delegation_max_minutes` |
| **`ongoing`** | Allowed only while `delegation_allow_ongoing` is true. If the policy is later switched off, ongoing grants stop at the next call, then are materialised as `revoked` with cause `policy` |

---

## 10. Tenancy and cross-company attempts
- **Recipient:** must satisfy `_continuity_is_eligible_owner`: platform staff `admin` / `support` / `platform_owner`, not banned, account active. **`company_admin` and `company_user` can never be recipients** (035 separation).
- **Same workspace:** grant, scope items and record must be in the same workspace, enforced by constraint and trigger.
- **Future company workspaces:** a grant can never cross workspaces.
- **Tests:**
  - a company admin as target → `not_eligible`;
  - a company user calling every shared RPC → `42501`;
  - a forged scope with a source or attachment ID from another record → rejected by the trigger.

---

## 11. UX
### 11.1 Request dialog (owner), Arabic RTL with English labels
Six steps, in one dialog with sections:

| Step | What it offers |
|---|---|
| 1. **Recipient** | Eligible staff; the current owner is excluded |
| 2. **Mode** | Three cards: «تسليم كامل» Full handover / «مراجعة جزئية» Partial review / «مراجعة مشتركة مؤقتة» Temporary collaborative review, each with a one-line explanation |
| 3. **Scope** (review/collab) | «السجل كله» Entire record, or «محتوى مختار» Selected content: a checklist of sources (sender label, time, excerpt preview **visible to the owner only**) and attachments. A time range with a zone selector. "Select all except" is supported, but the server stores the resolved list |
| 4. **Actions** | Checkboxes; `view` is fixed. Available actions depend on mode |
| 5. **Expiry** | Duration (default 4 h), until a date/time, this session only, or ongoing (only if the policy allows) |
| 6. **Reason** | Required |

**Preview panel «المستلم هيشوف / مش هيشوف»** (Will see / Won't see):
- counts per kind;
- for each selected source, whether the **recipient** will actually see the excerpt. This is computed on the server by a dry-run RPC that evaluates `inbox_can_access` *for the recipient*; it returns booleans only, to the owner, who already sees these sources;
- out-of-scope items listed as "won't see".

### 11.2 Recipient
- **Pending:**
  - the **same approved scope** as a preview: mode, actions, expiry, reason, a count per kind, the time range;
  - "N items you can't open because you have no access to the conversation";
  - **no excerpts, no names, no file names**.
- **Accepted:** the scoped view; a countdown to expiry; the actions available.
- **States:** «بانتظار القبول» Pending · «مقبول/نشط» Accepted/Active · «مرفوض» Declined · «منتهي» Expired · «ملغى/مسحوب» Revoked, with a cause line. Labels come from one dictionary (`ar` / `en`).

### 11.3 English (decision **S-6**)
The admin is Arabic-only today. 082 ships the labels for this feature in both languages, behind the existing locale. A full English admin is out of scope.

---

## 12. Decisions needed before implementation
| # | Decision | Recommendation |
|---|---|---|
| S-1 | When the clock starts for `duration` | At acceptance. Pending requests keep no access |
| S-2 | Limits | Default 4 h, maximum 7 days, session cap 12 h. Ongoing off |
| S-3 | `note` and `propose` (new tables) in 082 or a follow-up | **082a:** modes, scope, view, expiry, revocation, material-change acceptance. **082b:** notes, proposals, `edit_fields`, `add_source`. Two reviewable PRs |
| S-4 | Who may grant review/collab; do supervisor-issued grants survive reassignment | Owner, supervisor, assigner may grant. **Every** reassignment revokes grants (simplest and safest) |
| S-5 | Sub-message excerpt ranges | Not supported: a message is the smallest unit. Snapshots are whole-message copies |
| S-6 | English | Labels for this feature only |
| S-7 | Signed URL TTL for grant holders | 60 s, capped at the remaining grant life |
| S-8 | Should a grant holder see other grantees' notes | No: only their own notes, plus notes by record viewers |

---

## 13. Migration 082: contents and recovery
**Forward (one transaction, re-runnable):**
- Alter `continuity_handovers` (§4.1). Existing rows become `mode = 'transfer'`; their meaning is unchanged.
- Create `continuity_handover_scopes`, plus (082b) `continuity_notes` and `continuity_change_proposals`. Each gets the 041/042 conventions, guards, no grants, and FK `ON DELETE SET NULL` on actors (the #118 lesson).
- Extend `continuity_policies` (§4.4).
- Refactor `_continuity_source_view` into an internal `_continuity_source_view_as(source, authorised boolean)`. The existing function keeps its exact behaviour and calls it with `continuity_can_access`; a byte-for-byte equivalence test proves the existing output is unchanged.
- Replace the 081 RPCs:
  - `request` gains mode and scope;
  - `decide` takes the reviewed digest;
  - `cancel` revokes;
  - `get` and `mine` return the scope preview.
- Add the new RPCs: `review`, `revoke`, `amend_scope`, `respond_scope`, `shared_get`, `shared_with_me`, `shared_attachment_check`, `preview_recipient_visibility`, and (082b) the write RPCs.
- Extend the 081 record trigger: on close or reassign, revoke accepted grants too.
- Hourly sweep `continuity_grant_sweep`: materialises expiry, with events.
- Edge Function `continuity-shared-attachment-url`. Deployment needs approval.
- **Verification block:**
  - the existing checks;
  - no `continuity_*` table in `supabase_realtime`;
  - no permissive policy;
  - the authenticated-function count;
  - the bucket still has exactly one policy.

**Rollback (`_rollback/082_*.down.sql`):**
- Refuses while any review/collab request or scope row exists, unless `continuity.rollback_discard_data = 'on'`.
- Restores the 081 function texts byte for byte and drops the new objects.
- Keeps transfer history: `mode` is dropped only after confirming every row is `transfer`.
- 081's rollback is updated to refuse while 082 is installed.

**Operational recovery without rollback:** set `handovers_enabled = false`. Every shared read and write stops at once, and nothing is lost.

---

## 14. Test plan (each item maps to your list)
| Requirement | Test (SQL on the production-shaped fixture unless marked) |
|---|---|
| **Partial message/source access** | Grant 2 of 5 sources: `shared_get` returns exactly 2, renumbered 1–2. The other 3 are absent from every field, count and position. Direct `_continuity_source_view` with an out-of-scope ID → hidden |
| **Date range + timezone boundaries** | Range `[10:00, 12:00) Africa/Cairo`: messages at 09:59:59, 10:00:00, 11:59:59 and 12:00:00 local, plus a DST-transition day. Only the half-open interval is visible. The same instants given in another `range_tz` give the same result |
| **Attachment authorization** | In-scope attachment: the function signs with TTL ≤ min(60, remaining). Out of scope, removed, purged, or past retention → `not_found`. The grantee's direct `storage.objects` read → 0 rows (bucket policy not widened) |
| **Expiry and revocation** | Duration passes (simulated clock), until passes, session ID changes, policy turns ongoing off, owner revokes. Each refuses the **next** read and write, with an event. The sweep materialises the state |
| **Direct RPC bypassing the UI** | Every shared RPC called directly by: a recipient without a grant; a recipient with a declined, cancelled or expired grant; a recipient with a `review` grant attempting `note`, `edit_fields` or `add_source`; a non-recipient; anon; the API client → refused |
| **Cross-company attempts** | `company_admin` and `company_user` as target → `not_eligible`. As caller → `42501`. Scope with IDs from another record or workspace → rejected |
| **Scope changes after acceptance** | Narrowing applies immediately. Expansion stays `proposed`, the old scope still governs, and access changes only after recipient acceptance. Rejecting keeps the old scope |
| **Concurrency** (two real sessions, dblink) | accept vs cancel; accept vs reassign; accept vs record close; accept vs a material edit (digest changes between review and accept); accept vs ordinary edit (succeeds); revoke vs shared write; expansion-accept vs narrowing |
| **Reopen after expiry** | Grant expires, record is resolved then reopened: the grant stays `expired` and `shared_get` → `not_found`. The same for `revoked` |
| **Unselected messages/attachments never visible** | Exhaustive: for every RPC the grantee can call, the JSON never contains an excluded source ID, excerpt hash, attachment ID or path. Error texts are identical for excluded and nonexistent IDs |
| **Acceptance with record changes** | Edit the title → acceptance OK, with `changed_since_review` = `[title]`. Change the due date → `40001 material_change [due]`; after re-review, OK. Remove an in-scope source → material; add a source to the record → **not** included in scope. Reassign while pending → cancelled (081 rule) |
| **No new privilege** | A recipient who loses conversation access after acceptance sees `excerpt: null` (C3). A recipient who becomes banned or ineligible → revoked |
| **Unchanged behaviour** | `_continuity_source_view`, `continuity_get`, `continuity_list`, `continuity_assign` and `continuity_transition` give byte-identical results for non-grant callers (equivalence tests). The 081 tests H0–H12 still pass, with the transfer mode as default |
| **UI** (Playwright) | The dialog's least-privilege defaults; the preview "will / won't see" computed by the server; the recipient's pending preview contains no excerpt or file name; the changed-since-review banner; expiry clears the view; 390 px; RTL. AR and EN labels |
| **Mutation checks** | Remove each gate condition (expiry, session, action, scope membership, grantor authority, C3 in the scoped view, renumbering): each must make a test fail |

---

## 15. Increments
1. **082a:** modes, scope model, view-only shared access (`review`, and `collab` with `view`), expiry (all four kinds), revocation, lifecycle triggers, material-change acceptance for **all** modes (including `transfer`), the attachment-URL function, UI and tests.
2. **082b:** `collab` actions: notes, proposals, `edit_fields`, `add_source`; plus their UI and tests.

Each is a separate PR stacked on #124, with a migration, a rollback, an install note and test evidence. Neither is applied, deployed or enabled without your approval.
