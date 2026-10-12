# Internal namespace rename: `relay` → `continuity` (migration 077)

> **Status:** implemented and tested locally on a production-shaped database. **Not applied to production, not merged, not deployed.** Applying 077, merging and deploying each need Mahmoud's explicit approval.
> **Request:** Mahmoud, 2026-10-12. "Rename the internal database namespace from `relay` to `continuity` … through a new forward-only Supabase migration without modifying previously applied migrations or losing existing data, permissions, or audit history … Preserve backward compatibility where required and document any exceptions."
> **Product names (decision B1):** «مدعوم — الاستمرارية» / "Mad3oom Continuity". From now on, internal identifiers use `continuity_*`.

---

## 1. What was audited

Production was read-only on 2026-10-12. The repository was read at `origin/main` `b2a45ce`.

| Kind | Production inventory | Handled by |
|---|---|---|
| Tables | 6: `relay_workspaces`, `relay_records`, `relay_sources`, `relay_source_snapshots`, `relay_events`, `relay_assigners` | `alter table … rename` |
| Sequence | `relay_events_id_seq` | `alter sequence … rename` |
| Constraints | 83 (PK, FK, CHECK, UNIQUE) | `alter table … rename constraint` (also renames the backing index) |
| Stand-alone indexes | 14 | `alter index … rename` |
| Triggers | 11 named `trg_relay_*` (plus 6 `trg_preview_read_only`, unchanged) | `alter trigger … rename` |
| Functions | 57 (44 plpgsql, 13 sql): 19 RPCs granted to `authenticated`, 38 internal and revoked | `alter function … rename`, then `create or replace` with bodies that use the new names |
| RLS policies | 6 × `gate_account_active` (restrictive) | No change: they follow the table |
| Comments | 2 table comments, 1 column comment | Re-written with the new wording |
| Array types | `_relay_*` (one per table) | Follow the table automatically |
| `pg_cron` | `relay-retention-sweep` (`17 3 * * *`) | Unscheduled and re-scheduled as `continuity-retention-sweep` (same time) |
| Storage buckets, Realtime publications, views, other schemas | none | — |
| Functions outside Relay that reference `relay_*` | none (`prosrc` scan) | — |
| JWT claim | `relay_client` (read by `_relay_via_api`). No producer exists: `relay-api` was never built | Renamed to `continuity_client` |
| Settings | `relay.rollback_discard_data` (historical rollback scripts only) | Unchanged in the historical files (exception E3) |
| Frontend | `assets/js/relay/*` (7 modules), `admin/relay.html`, `assets/css/relay.css`, inbox and sidebar integration, `rl-` CSS/id prefix | Moved and renamed (§3) |
| Tests | 3 node files, 3 SQL files | §4 |

`auth.saml_relay_states` belongs to Supabase Auth. It is unrelated and not touched.

## 2. Database changes (`migrations/077_continuity_namespace.sql`)

**Name mapping:**
- `relay_X` → `continuity_X`
- `_relay_X` → `_continuity_X`
- `trg_relay_X` → `trg_continuity_X`
- Constraint and index names change the same way.

**Function bodies.** These are stored as text, so renaming a function does not update the functions that call it. The migration therefore:
1. renames each function, which keeps its ACL, owner, `SECURITY DEFINER` and `search_path`;
2. replaces its body (`create or replace`, which also keeps the ACL and owner).

**How the bodies were produced:**
- They were **generated from `pg_get_functiondef` of a database with 073 + 074 + 076 applied**, which is the production state, and committed as static SQL so they can be reviewed.
- **Only three kinds of edit were made:**
  - identifiers `relay_` → `continuity_`;
  - the claim key `'relay_client'` → `'continuity_client'`;
  - internal error and comment text "Relay" → «الاستمرارية». One message was re-worded for grammar: «الاستمرارية غير مفعّلة لهذه المساحة».
- **Proof:** `tests/sql/continuity-namespace.test.sql` (N2) maps every new definition back and requires it to equal the pre-077 definition byte for byte.

**Backward compatibility:**
- **The 19 public RPCs keep their old names** as thin wrappers: `relay_create`, `relay_get`, … `relay_purge_removed`.
- **How the wrappers are built:**
  - they are `SECURITY INVOKER` and executable by `authenticated` only;
  - each one is a single `select public.continuity_X(…)` statement;
  - each carries a deprecation comment.
- **Why they exist:** the frontend currently deployed calls `relay_*`. The wrappers keep it working between applying 077 and deploying the new frontend.
- **Authorization is unchanged:** every check runs inside `continuity_*` with the caller's identity.
- Internal `_relay_*` helpers get **no** wrappers, because nothing outside the database calls them.

**Re-runnable:**
- Every rename is conditional.
- Bodies and wrappers use `create or replace`.
- The cron step unschedules both names before scheduling the new one.

**Verification block (aborts the transaction on failure):**
- no `public` relation, constraint or trigger named `relay`;
- exactly 57 `continuity` functions;
- exactly 19 `relay_*` functions, all wrappers, none `SECURITY DEFINER`;
- no `continuity` body mentions `relay`;
- the 041/042 conventions on all 6 tables;
- no permissive policy and no direct table grant;
- exactly 38 functions executable by `authenticated` (19 + 19 wrappers);
- nothing executable by `anon` or `service_role`;
- `search_path` pinned;
- the cron job moved.

## 3. Application changes
| Before | After |
|---|---|
| `assets/js/relay/relay-{composer,contract,data,dialog,icons,model,page}.js` | `assets/js/continuity/continuity-*.js` |
| `admin/relay.html` | `admin/continuity.html` (title and heading «الاستمرارية») |
| `assets/css/relay.css`, classes `rl-*`, ids `rl*` | `assets/css/continuity.css`, `ct-*`, `ct*` |
| RPC calls `relay_*` | `continuity_*` |
| `RelayError`, `mapRelayError`, `loadRelayAccess`, `openRelayComposer`, `relayConfirm`, `relayPrompt`, `RELAY_ICONS`, … | `ContinuityError`, `mapContinuityError`, `loadContinuityAccess`, `openContinuityComposer`, `continuityConfirm`, `continuityPrompt`, `CONTINUITY_ICONS`, … |
| Inbox `#relayBtn`, `state.relay` | `#continuityBtn`, `state.continuity` |
| Sidebar `#relayLink` «Relay» → `/admin/relay.html` | `#continuityLink` «الاستمرارية» → `/admin/continuity.html` |
| — | `vercel.json` redirect `/admin/relay.html` → `/admin/continuity.html` (query string kept, so `?record=…` links keep working) |

## 4. Exceptions (intentional remaining `relay` references)
| # | Where | Why |
|---|---|---|
| E1 | `migrations/073_relay_core.sql`, `074_relay_phase_c.sql`, `076_relay_trash_owner.sql` and their rollbacks | Applied to production. They must not be edited, and their file names are in the migration ledger |
| E2 | `tests/sql/relay-core.test.sql`, `relay-phase-c.test.sql`, `relay-trash-owner.test.sql` | They test those immutable migrations as written, by applying them to a fresh database. They stay green because they never apply 077. The current names are covered by `tests/sql/continuity-namespace.test.sql` |
| E3 | `relay.rollback_discard_data` in the historical rollback scripts | Part of E1. New rollbacks use `continuity.rollback_discard_data` |
| E4 | The 19 `relay_*` wrapper functions in the database | Backward compatibility (§2). To be dropped by a later migration, after the new frontend is deployed and verified; that needs its own approval |
| E5 | `vercel.json` redirect | Old links and bookmarks |
| E6 | `docs/relay/` | The decision log and install notes, recorded with the names that were applied. New documents go in `docs/continuity/` |
| E7 | Comments and static checks that cite E1/E2 files: `tests/continuity-contract.test.mjs` and `tests/continuity-model.test.mjs` read 073/074 as written; `tests/company-navigation.test.mjs` holds the migration ledger | Historical references |
| E8 | `mcp/*.md` | The English word "relay" ("notification relay"), unrelated |
| E9 | `auth.saml_relay_states` | Supabase Auth |
| E10 | The claim `relay_client` is no longer read | It had no producer in production. A token carrying it would be treated as the native path, but none exists. The future `continuity-api` will set `continuity_client` |

`tests/continuity-namespace.test.mjs` enforces this list: any new `relay` reference outside it fails the build.

## 5. Deploy order (each step needs approval)
1. **Apply 077** (Supabase `apply_migration`, one transaction). The deployed frontend keeps working through the wrappers, and the cron job moves.
2. **Deploy the frontend** from this PR. It calls `continuity_*`, and the old URL redirects.
3. **Verify** (§6).
4. **Later, separately approved:** a migration that drops the 19 wrappers, once no client calls them. Check the PostgREST logs for `rpc/relay_` first.

**If the frontend were deployed before 077:** `continuity_my_access` would not exist. The inbox button, sidebar link and page would then hide themselves (the same tolerance pattern as 074/076). Continuity would be unavailable, but nothing would be exposed. So apply 077 first.

## 6. Production checks (read-only, after step 1)
```sql
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like '%continuity%';                        -- 57
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'relay\_%' and not p.prosecdef;        -- 19 wrappers
select jobname, schedule, active from cron.job where jobname like '%retention-sweep'; -- continuity-retention-sweep only
select (select count(*) from public.continuity_records), (select count(*) from public.continuity_events); -- same as before
```
Then run `get_advisors` (security) and confirm there is no new finding.

## 7. Rollback
- `migrations/_rollback/077_continuity_namespace.down.sql` runs in one transaction.
- **What it does:**
  - drops the wrappers;
  - renames everything back;
  - restores every function to its pre-077 text, byte for byte (tested);
  - restores the comments and the cron job name.
- **It deletes no rows.** It refuses to run if a later `continuity` migration is installed; roll that one back first.
- **If the new frontend is already deployed,** roll it back first. Without the wrappers, it would call missing `continuity_*` functions and hide Continuity.

## 8. Validation performed (local)
Commands and totals are in the PR description.

Key results of `tests/sql/continuity-namespace.test.sql`, on the prod-shape fixture with data in every table (sources in trash, erased, redacted, assign grants):
- **Data and catalog identical:** every row is identical; the 57 functions are equivalent; ACLs, owners, `SECURITY DEFINER` and `search_path` are identical; and so are the 83 constraints, the indexes, the 17 triggers, the policies and the comments.
- **No leftovers:** no leftover `relay` object.
- **Wrappers:** for every persona (customers, support, admin, supervisor, owner, banned), the reads through the new names **and** through the wrappers equal the pre-077 reads.
- **Rules unchanged:** idempotency works across both names; the sequence continues; P3, version checks, T2 and immutability are unchanged.
- **Lifecycle of the migration:** re-run is a no-op; rollback is identical to before; re-apply works.
- **The equivalence check is real:** changing a single constant in one generated body makes N2 fail.
