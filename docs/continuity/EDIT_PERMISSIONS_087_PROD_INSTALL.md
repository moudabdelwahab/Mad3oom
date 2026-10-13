# Mad3oom Continuity: edit separated from read (087), production install note

> **Authorization:** "Complete Mad3oom Continuity — Fully Functional and Editable" (2026-10-12). It authorizes completing Continuity, merging it to `main` and deploying approved features after verification.
> **Decision E1 (from that brief):** "لا تسمح بالتعديل لمجرد أن المستخدم يستطيع رؤية السجل".
> **Effect:** E1 replaces P1/P2/T1 (Phase C, 2026-10-09), under which everyone who could read a record could also edit it.

## Rule
| Operation | Who, after 087 | Before 087 |
|---|---|---|
| Read the record, its list, history and closures | Unchanged: supervisor, owner, creator, record team | Same |
| Edit fields (`continuity_update`) | **Record owner or supervisor** | Anyone who can read (P1) |
| Attach, remove or restore messages | **Record owner or supervisor** | Anyone who can read (P2/T1) |
| Begin, commit, remove or restore attachments | **Record owner or supervisor** | Anyone who can read (080) |
| Status, close, reopen | Unchanged: owner or supervisor (079) | Same |
| Assign, reassign, claim, release | Unchanged: P3/P4 | Same |
| Permanent erase | Unchanged: platform owner (T2) | Same |

**Refusals:**
- **A reader who cannot edit** gets `42501 {"code":"forbidden","field":"record","reason":"not_owner"|"unassigned"}`. They can already see the record, so this reveals nothing.
- **Anyone who cannot read** gets the same `P0002 not_found` as before. They cannot tell whether the record exists.

**Unassigned records:** only a supervisor can edit one directly. Anyone who can see it can claim it first (P4), then edit.

**UI support (display only; the server still decides every call):** `_continuity_full` now also returns `permissions`:
`{ edit, sources, attachments, transition, assign, claim, release, handover, purge, reason }`.

## How 087 changes functions
087 does not rewrite any function. Each of these nine functions gets one line after a fixed anchor:
- `continuity_update`
- `continuity_attach_sources`
- `continuity_remove_source`
- `continuity_restore_source`
- `continuity_attachment_begin`
- `continuity_attachment_commit`
- `continuity_attachment_remove`
- `continuity_attachment_restore`
- `_continuity_full`

**Safety checks:**
- **Before patching:** the function's current `pg_get_functiondef` md5 must equal the production text captured on 2026-10-12, and the anchor must occur exactly once. Any mismatch stops the migration and changes nothing.
- **After patching:** removing the added line must give back the original md5.
- **Marker:** the added line carries `087_continuity_edit_gate`. A rerun is a no-op, and the rollback removes exactly that line.

## Recorded production md5s (before 087)
| Function | md5 |
|---|---|
| `continuity_update(uuid,jsonb,integer)` | `8664dd01b54c7fe44bfe43b5869318e9` |
| `continuity_attach_sources(uuid,jsonb,integer,boolean)` | `8b0cf81023896d21ee28acad1882962b` |
| `continuity_remove_source(uuid,integer)` | `73f66a8e26c2b6a3fb09fe66bab7c1b0` |
| `continuity_restore_source(uuid,integer)` | `a52bd9122c884da6b2c1c2516ba03d44` |
| `continuity_attachment_begin(uuid,text,text,bigint,text,uuid)` | `396ed3af4c08660ea47cbf8511b171da` |
| `continuity_attachment_commit(uuid,text)` | `70882cbc5a93711f5bbc146d146d9f68` |
| `continuity_attachment_remove(uuid,integer)` | `00c48245aa4482913c339d559dbc4bb7` |
| `continuity_attachment_restore(uuid,integer)` | `4a4b17273f34a3f4182d3d35220d3c5e` |
| `_continuity_full(uuid,boolean)` | `9db8e30bb926b96d312c7010872fba29` |

## Data impact, locks, access
- **Data:** no table, row or data change.
- **Locks:** `CREATE OR REPLACE FUNCTION` takes catalog locks for milliseconds. There are no table locks.
- **Grants:** unchanged on the eight public RPCs. The three new internal functions are revoked from `public`, `anon`, `authenticated` and `service_role`.

## Tests
**SQL:** `tests/sql/continuity-edit-permissions.test.sql`, on the production-shaped fixture, 073 → 081 → 087:

| Test | What it proves |
|---|---|
| E0 | Installed on the exact production texts; the internal functions are closed |
| E1 | Owner, supervisor and platform owner can edit. A team member and the creator (after reassignment) can read but get `42501` with the reason |
| E2 | An unassigned record must be claimed before editing; a supervisor edits it directly |
| E3 | Attach, remove and restore messages follow the same rule |
| E4 | Attachments (begin, commit, remove, restore) follow the same rule. Losing ownership between begin and commit blocks the commit. Erase stays owner-only |
| E5 | `permissions` is correct for each actor and for a closed record |
| E6 | A non-reader gets `P0002` with no reason, the same answer as for a nonexistent ID |
| E7 | The `relay_update` wrapper is gated; anon and customers are refused |
| E8 | List, assign, transition and read are unchanged (read only gains `permissions`) |
| RERUN | Running 087 again changes nothing |
| RB | The rollback restores all nine md5s exactly, and P1 behaviour returns; re-applying gives identical texts |

**Mutation checks** (each must fail the suite, and does):
- `_continuity_can_edit` reduced to read access → **E1 fails**.
- The commit gate removed → **E4 fails**.

**Render and Node tests:**
- `tests/continuity-phase-c.render.test.mjs` (087 cases):
  - read-only view with its reason;
  - claim;
  - issue fields;
  - refused save, with no false success;
  - new-record dialog: required fields, failure stays in the dialog, retry reuses the idempotency key;
  - issue creation;
  - readable history and paging;
  - 390 px RTL;
  - editable policies (diff only, confirmation, no success on version conflict).
- `tests/continuity-model.test.mjs`: the pure helpers.

## Apply (production)
1. Confirm the ledger ends at `086_company_staff` and the nine md5s above still match.
2. Apply `087_continuity_edit_permissions` through the release wrapper, pinned to the merge commit with an md5 check, like 077–086.
3. Verify:
   - 9 functions carry `087_continuity_edit_gate`, and the fingerprint matches the local rehearsal;
   - a read-only smoke test in a rolled-back transaction: owner `edit=true`, team member `edit=false`, non-reader `P0002`.

## Rollback / recovery
**Rollback:** `migrations/_rollback/087_continuity_edit_permissions.down.sql`. It removes the nine lines (proving each md5 returns to the table above) and drops the three helpers. It is safe at any time because 087 stores no data.
