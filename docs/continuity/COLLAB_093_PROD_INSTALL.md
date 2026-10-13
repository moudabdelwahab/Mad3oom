# Mad3oom Continuity: collaborative sharing actions 082b (093), production install note

> **Design:** `SCOPED_HANDOVER_DESIGN.md` §4.3, §5.4 (#125). Decision S-3 put these actions in 082b; decision S-8 sets who sees which notes.
> **Builds on:** 091 (scoped handover, in production since 2026-10-13).
> **Numbering:** production already has `092_company_feature_overrides`, so this is **093**.

## What 093 adds
A **collab** share can now allow, besides viewing, any of these actions. The owner picks them explicitly; none are pre-selected.

| Action | What the recipient can do | Checks on top of the 091 gate |
|---|---|---|
| `note` | Write in the **thread of their own share** | 1–2000 characters. The event holds a hash of the text only |
| `propose` | Propose values for the allowed fields | Same validation as `continuity_update`. At most 20 pending per share. The owner or a supervisor applies the proposal **through `continuity_update`** (with its version check) or rejects it. The proposer can withdraw it |
| `edit_fields` | Edit the allowed fields directly | Allowed fields only: `next_action`, `summary`, `due`, `priority`. Same validation, version check and follow-up rule. Owner, team, status and sources can never be changed. The event records the share ID |
| `add_source` | Add inbox messages and upload files | Messages need the recipient's **own** conversation access (`_continuity_attach` unchanged). What they add is visible to **their share only** (`continuity_grant_items`). A message already in the record but excluded from the share stays excluded. Uploads go through the same edge function with `X-Continuity-Shared: 1`, with the same type, size and signature checks |

**Notes (S-8):**
- **The recipient** sees only their share's thread: their own notes, plus replies from the owner or a supervisor in that thread.
- **Anyone who can read the record** sees every note.
- **Record-level notes and thread replies** can be written only by people who can edit the record (owner or supervisor).

**Switch:** `delegation_allow_collab`, **off by default**, set by the platform owner in Continuity settings.
- **Off:**
  - no new collab request with actions;
  - every shared write (note, propose, edit, add) is refused with `feature_not_enabled`;
  - existing shares stay **view only**;
  - nothing is lost.
- **On:** writes resume for shares that are still active.

**Every write re-runs the 091 gate:** state, expiry, session, eligibility, grantor authority, record status, action, and the handovers switch. A revoke, a narrowed scope, a reassignment or a closed record stops writes at once. Pending proposals stay for the owner to decide.

## How 093 changes existing functions
Anchored text patches, the same method as 087 and 091. Each runs only if the function's md5 equals the production text after 091 (verified on 2026-10-13), and the reverse replacement must restore it. The marker is `093_continuity_collab_actions`.

| Function | md5 before | Patch |
|---|---|---|
| `_continuity_scope_resolve(continuity_records,jsonb,text)` | `8de00f350f1d53135982585bb007e8a0` | `collab` accepts actions (when the switch is on) and resolves `editable_fields` |
| `_continuity_scope_narrower(…)` | `31907f5d77f8d02a5f9c7b2f30fa8611` | Fields count when comparing narrowing |
| `continuity_handover_amend_scope(uuid,jsonb)` | `0e263e8cab490069c1a43e8ae8810a31` | The immediate intersection includes fields |
| `_continuity_scope_source_ids(…)` | `d631cd54d1b7a45825f3363a6e9412d9` | Adds the share's own grant items |
| `_continuity_scope_attachment_ids(…)` | `402a356cef9a1bbbf921b4f4ed69db54` | Same |
| `continuity_shared_get(uuid)` | `4f8f6485f0b4a932755819d6f306209a` | Adds the share's thread, its proposals, and `collab` (`enabled`, `editable_fields`) |
| `continuity_handover_scope(uuid)` | `3dbfaf64d76f59f5912c392bc0cf6d9e` | Lists the fields |
| `continuity_set_policies(jsonb,integer)` | `4f8aa4bcf5674837224432a72fd0e7b0` | Accepts `delegation_allow_collab` |

**Unchanged:** the gate, the normal read, list and edit RPCs, full transfer, the storage policy, and realtime.

## Data, locks, access
- **Schema:**
  - one policy column, with a constant default;
  - three new append-only tables: `continuity_notes`, `continuity_change_proposals`, `continuity_grant_items`;
  - every row is checked to belong to the same record and workspace.
- **Data:** no existing row changes.
- **Access:**
  - the new tables have RLS, no policy, no direct privileges for any role, and the 041/042 conventions;
  - 10 internal functions are closed to everyone;
  - 11 RPCs are executable by `authenticated` only;
  - the verification block asserts no permissive policy, no anon access, a fixed `search_path`, 8 patches, and an unchanged storage policy count.
- **Edge function:** `continuity-attachment-upload` gains the `X-Continuity-Shared` branch and must be redeployed. Without the header it calls exactly the same RPCs as before.

## Tests
**SQL:** `tests/sql/continuity-collab-actions.test.sql`, on the production-shaped fixture, 073 → 081 → 087 → 089 → 091 → 093:

| Test | What it proves |
|---|---|
| K0 | Install |
| K1 | Switch off by default, turned on from the policies |
| K2 | Request rules |
| K3 | Notes, S-8 threads |
| K4 | Proposals: validation, apply through `continuity_update` with stale-version conflict, reject, withdraw, readers cannot decide |
| K5 | Direct edit: allowed fields only, version check, follow-up rule, no normal read or update |
| K6 | Adding messages: own access only, visible to this share only, an excluded message stays excluded |
| K7 | Attachment upload through the shared path |
| K8 | Switch off: every write refused, view kept |
| K9 | Narrowing and revoke stop writes at once; a pending proposal stays for the owner |
| K10 | Immutability and cross-record refusal |
| K11 | Real concurrency: a revoke while the recipient's edit waits on the row lock means no write |
| RERUN | Running 093 again changes nothing |
| RB | The rollback refuses without consent; with consent it restores all 8 md5s and 091 behaviour returns; re-applying works |

**Mutation checks** (each fails the suite):
- fields check removed;
- grant items leak to other shares;
- switch check removed;
- version check removed;
- thread filter removed;
- edit check removed from notes;
- edit check removed from rejecting a proposal;
- attachment not linked to the share.

Removing the second gate after the lock leaves the write refused anyway, because the final `continuity_shared_get` re-runs the gate and rolls it back. K11 covers the race.

**Node:**
- the upload handler's shared branch;
- model helpers;
- 6 render cases: owner dialog with collaboration; recipient edit, propose, note and withdraw; switch-off and refusal; owner notes, proposals and thread reply; reader view and before-093; inbox composer through a share.

## Apply (production), after merge
1. Confirm:
   - the ledger contains `091_continuity_scoped_handover`;
   - the 8 md5s above match;
   - `continuity_notes` does not exist;
   - no migration named `093_*` is already in the ledger.
2. Apply `093_continuity_collab_actions` through the release wrapper, pinned to the merge commit with an md5 check.
3. Redeploy `continuity-attachment-upload` (`verify_jwt = true`, as before).
4. Verify:
   - the marker count is 8 and the fingerprint matches the local rehearsal;
   - a smoke test in a rolled-back transaction: a collab share with every action, then note, propose, apply, edit and revoke;
   - the switch is still off.
5. **Enable** by setting `delegation_allow_collab = true` through `continuity_set_policies` (recorded in the policy history). Roll back the enablement by setting it to `false`.

## Rollback
`migrations/_rollback/093_continuity_collab_actions.down.sql`.
- It refuses if notes, proposals, grant items or live collab shares with actions exist, unless the session sets `continuity.rollback_discard_data = 'on'`.
- With consent it:
  - revokes live collab shares that have actions (cause `policy`);
  - drops the three tables and the 093 functions;
  - reverses the 8 patches, proving each md5;
  - drops the policy column.
- Messages and attachments the recipient added stay in the record, and events stay.
