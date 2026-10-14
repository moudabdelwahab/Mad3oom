# H2 — Customer transfers, ticket carry and historical access (migration 101) — production install note

> **Status: NOT EXECUTED.** Nothing here has been applied to production or deployed.
> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. Requires 095–100.
> New switches ship **OFF**: `customer_transfers_enabled`, `ticket_carry_enabled`, `historical_access_enabled`.

## Decisions implemented

| Decision | Implementation |
|---|---|
| Q5: transfer approvals | The customer's request is their confirmation. Both company admins must approve; the destination and source decide independently. When both have approved, execution is immediate and atomic. Requests expire after 14 days. Only one request may be pending per customer, and an idempotency key makes replays return the same result. |
| Q5: owner exceptional transfer | `owner_transfer_exceptional` requires owner context, fresh step-up and a reason of at least 20 characters. It is idempotent, audited in `privileged_audit`, and its result is marked `exceptional`. |
| Safe default 2 | The old primary stays as a secondary only if the customer asked for it **and** the source admin allowed it. Otherwise the old membership ends with cause `transferred`. |
| Raw path | When `customer_transfers_enabled` is on, a raw `profiles.super_user_id` change from one company to another (outside the membership path) is refused with 42501. |
| Q6: customer chooses | `carry_candidates(source)` lists the customer's own tickets in a company with a manifest of what is included and excluded. `carry_tickets(source, destination, ids, key)` creates one new **unassigned** ticket per chosen ticket in the destination. The new ticket contains the customer's description and the customer's own non-internal messages. Originals stay in the source, untouched. |
| Safe default 3 | Staff replies, internal notes, staff identities, activity, assignment and ratings are never copied. |
| Safe default 4 | The source company admin is told how many tickets were carried, never where to. |
| Carry rules | A ticket is carried at most once per destination (unique constraint). Attachments are copied as **new objects** by a service-role worker (`ticket-carry-copy`); the original file is not shared. |
| No double billing | Carried tickets are excluded from `ticket_quota_status` and from the reconciliation's live count. The quota trigger is skipped for the carry insert, and the shadow ledger records them as `counter = none, units = 0`. Quota per account is proven identical before and after 101. |
| Q7 / safe default 5: historical access | A company admin asks for one customer with a purpose of at least 20 characters. The customer sees the request in the portal and either declines or chooses 1–50 of their own tickets in **other** companies. Only then can the owner approve (context + step-up, not their own request) for 1–168 hours. Reads go through `historical_ticket_view`, which returns the ticket title, description and the customer's own non-internal messages only, logs every call, and stops at expiry. |

## Fixes after the independent security review (2026-10-14)

| Finding | Fix | Test |
|---|---|---|
| HIGH: company columns referenced `companies`, so deleting a company owner's account was blocked by history rows | `from_company`, `to_company` and `requesting_company` have no FK. Readers use left joins and show "شركة محذوفة" (deleted company). | ⑥ catalog check: no FK to `companies` or `profiles` |
| HIGH: a customer could add a `ticket_attachments` row pointing at any path in the `tickets` bucket, and the carry worker would copy it | `_carry_attachment_ok` accepts only the customer's own upload, in their own `<customer>/<ticket>/` folder, with the storage object owned by them. The manifest uses the same rule. The worker also refuses a `source_path` outside the destination customer's folder. | ④ forged rows are never queued; worker test |
| HIGH: without isolation, moving `super_user_id` lets the destination owner read the old tickets through the legacy path | `customer_transfers_enabled` works only while `company_isolation_enforced` **and** `company_permissions_enabled` are on (`0A000 prerequisite_not_enabled`) | ③ |
| MEDIUM: `RAISE` after `UPDATE ... status` rolled the status back, so expired or cancelled requests stayed `pending` | Outcome is returned instead of raised. Stale pending requests expire on the customer's next request. | ③ expiry persists and frees the slot |
| MEDIUM: copy queue could starve, and the worker deleted objects after a lost confirmation | Ordered queue with `attempts`, failed after 5. The worker never deletes; an existing object at the server-generated path proceeds to confirmation. | worker tests |
| LOW: `service_role` kept execute on internal and authenticated functions | Revoked | — |

**Second review (of the fix diff, 2026-10-14).**

| Finding | Fix | Test |
|---|---|---|
| **HIGH:** isolation or 098 could be switched **off** after transfers completed, reviving the legacy `super_user_id` path to old tickets | Trigger `trg_guard_isolation_after_transfers` refuses (55000 `transfers_exist`) to disable `company_isolation_enforced` or `company_permissions_enabled` once any transfer is `completed`. **Consequence: after the first completed transfer, isolation and 098 are one-way.** Plan any rollback of them before enabling transfers. | ③ guard |
| MEDIUM: real app uploads (`<ticket>/<ts>_<name>`, `tickets-service.js`) were never carried | `_carry_attachment_ok` parses paths with `storage_ticket_id()`, as the storage policies do (028), still requiring the customer-owned object and the same ticket. The worker accepts that shape too. | ④ app-path file carried, forged rows still refused |
| MEDIUM: `expired`/`cancelled` outcomes were shown as success; the owner's exceptional transfer committed side effects and an audit row even when nothing moved | Company UI shows the real outcome (`transferDecisionMessage`). The exceptional transfer is all-or-nothing and raises unless `completed`. | `company-moves.test.mjs` |

**Third review (of the second-round delta): no HIGH or CRITICAL.** Follow-ups applied:
- **Carry** now needs `company_isolation_enforced` and `company_permissions_enabled`, like transfers. Without isolation, the source owner could see the destination team's replies on a carried ticket through the legacy path.
- The guard also covers **carried tickets** (any `ticket_carry_items` row), and refuses **DELETE or rename** of either switch row, not just `enabled = false`. TRUNCATE, `DISABLE TRIGGER` and `session_replication_role` need the database owner; no API role has table grants.
- `_carry_attachment_ok` accepts exactly the path shapes the worker accepts (lowercase UUIDs; 2 or 3 segments), so no queued item is doomed to fail.

**Operational consequences of the guard (read before enabling transfers or carry):**
1. After the first completed transfer or carried ticket, `company_isolation_enforced` and `company_permissions_enabled` **cannot be turned off** through any API path. The 097 and 098 rollbacks then refuse permanently; the 101 rollback already refuses once such data exists.
2. **Future migrations (103+)**: the pattern "self-check refuses if any switch is on" must allow these two switches to stay on.
3. **Break-glass** (only if isolation itself has a production bug): a database-owner session can `alter table public.platform_feature_switches disable trigger trg_guard_isolation_after_transfers`, flip the switch, and re-enable the trigger. Doing so **reopens** the legacy exposure of transferred and carried customers' older tickets to the destination or source owners. It needs the owner's explicit decision and a written record.

Residual, documented:
- **MEDIUM (pre-existing, 096).** With only `multi_company_memberships_enabled`, `set_primary_company` also moves `super_user_id`. With isolation off, the new company's owner then sees old tickets. Enable isolation before memberships, or extend the same guard to 096 primary changes.
- **LOW.** The copy queue's `SKIP LOCKED` lasts only for the RPC call, so overlapping worker runs may take the same item. That is harmless through the 409 → confirm path but uses up attempts. Run the worker as a single scheduled instance.

## Code that ships with 101 (not deployed)

- `migrations/101_customer_transfers_carry.sql`: tables `customer_transfers`, `ticket_carries`, `ticket_carry_items`, `ticket_carry_attachments`, `historical_access_requests`, `historical_access_audit`, all with RLS, no direct grants, the `gate_account_active` restrictive policy, no deletes and an append-only audit.
- `customer_id` in the three history tables has **no foreign key** to `profiles`, following the 086/096 convention. Deleting a customer account (from the Supabase dashboard) is not blocked, and the history stays with ids only. Company lists show such a customer as "حساب محذوف" (deleted account). Tested in ⑥.
- Patches four functions by exact one-occurrence replacement: `ticket_quota_status`, `enforce_ticket_quota`, `_usage_record_ticket`, `usage_reconciliation`.
- Widens the `company_membership_events.action` check with `transfer_requested`, `transferred_out` and `transferred_in`.
- `supabase/functions/ticket-carry-copy/`: thin `index.ts` plus a `handler.js` with the logic.
  - Called by a scheduler with `Authorization: Bearer <CARRY_COPY_SECRET>` (at least 32 characters). Without the secret it answers 503 and items stay `pending_copy`; the carried ticket's text is complete either way.
  - The worker validates the server-generated destination path, checks the size against the source row, uploads with `upsert: false`, and confirms with the SHA-256 hash.
  - Transient errors stay queued. If confirmation fails, it deletes the new object.
  - Tested in `tests/ticket-carry-copy.test.mjs`.
- Portal (`portal/index.html`, `assets/js/portal/portal-moves.js`, `portal-data.js`):
  - request a transfer to the current company, with an optional "keep old primary as secondary"; list and cancel requests;
  - carry selected tickets from another membership company, showing the manifest;
  - answer historical requests (`/portal/#history-requests`, the notification link).
- Company dashboard (`assets/js/company/company-moves.js`, members section), admin only: decide transfer requests (the source can allow the secondary membership the customer asked for); request historical access for a customer; view allowed tickets.
- Owner console, governance tab: a historical-access approval queue (hours 1–168) and the exceptional transfer form. `historical_access_enabled` joins the switches that ask for an extra confirmation before enabling.
- `h2_features()` tells the UI which of the three switches are on. It grants nothing.

## Rollout order (when approved)

1. 095–100 applied. `customer_transfers_enabled` now **refuses to work** until `company_isolation_enforced` and `company_permissions_enabled` are both on, so isolation's separate approval comes first. Without 098, the source company sees its old tickets only through the legacy `super_user_id` link, and a transfer moves that link. Under isolation this fails **closed**: the source loses sight of the customer's old tickets and nothing leaks. The test asserts both states.
2. Apply `migrations/101_customer_transfers_carry.sql`. It is re-runnable. It self-checks that every switch is off, the quota patches applied, and the reconciliation shows no mismatches.
3. Deploy the frontend files.
4. `ticket-carry-copy`: deploy with `--no-verify-jwt` (it authenticates with its own secret) only when `ticket_carry_enabled` is about to be turned on. Set `CARRY_COPY_SECRET` and schedule a POST every few minutes. Until then, carried tickets have no attachments.
5. Turning on any of the three switches is a separate, explicit decision.

## Verification after apply

```sql
select key, enabled from public.platform_feature_switches
 where key in ('customer_transfers_enabled', 'ticket_carry_enabled', 'historical_access_enabled');   -- all false
select public.usage_reconciliation() -> 'mismatches';                                              -- []
select count(*) from public.customer_transfers;                                                    -- 0
```

## Rollback

`migrations/_rollback/101_customer_transfers_carry.down.sql` restores the four patched functions byte-for-byte (as after 100), restores the membership-event check, and drops 101's objects. A schema digest proves the result equals the pre-101 state; the digest now covers functions with ACLs, policies, triggers, columns, grants, switches and **constraints**. It **refuses** when:

- any of the three switches is on;
- any transfer, carry, historical request or historical audit row exists;
- any membership event of a transfer type exists.

After a carry, rolling back would count carried tickets twice, so the history must not be discarded.

## Tests

`tests/sql/customer-transfers-carry.test.sql` (production-equivalent chain + 095–100, shared ticket fixtures):

- ① Objects, switches off, quota per account identical to before 101, internals closed.
- ①ب Rollback by schema digest; double re-apply.
- ② Switches off: no transfer, carry or historical access; `h2_features()` reports all off.
- ③ Transfers:
  - request, idempotent replay, one pending request;
  - the raw move is blocked;
  - decisions are admin-only and once per side; nothing moves until both approve;
  - atomic execution, with the source kept as secondary by choice and permission;
  - rejection leaves everything unchanged;
  - the owner's exceptional transfer requires a reason, is idempotent and audited;
  - company lists never show the other company, and only the source sees the customer's "keep secondary" wish.
- ④ Carry:
  - manifest counts;
  - the new ticket is unassigned in the destination and holds customer content only; the original is intact;
  - idempotent, once per destination, own tickets only, membership in the destination required;
  - the source is notified privately;
  - quota unchanged, ledger `none:0`, reconciliation explained;
  - isolation: fail-closed without 098, correct with 098;
  - attachment copy queue: service role only, needs the new object, drains.
- ⑤ Historical access:
  - admin-only request with a purpose; company and customer lists; eligible tickets are the customer's own tickets in other companies;
  - the owner cannot decide before consent; consent only on the customer's tickets elsewhere;
  - view: chosen tickets only, customer content only, admin of the requesting company only, audited, ids hidden after expiry;
  - decline.
- ⑥ Invariants: append-only, no deletes, no direct reads; deleting a customer account succeeds and keeps the history.
- ⑦ Rollback refused with data.

Plus:
- `tests/ticket-carry-copy.test.mjs` (5);
- `tests/portal-model.test.mjs` and `tests/portal.render.test.mjs` (101 cases);
- `tests/company-moves.test.mjs`;
- `tests/company-dashboard.render.test.mjs` (101 cases);
- `tests/owner-governance.render.test.mjs`;
- `tests/company-navigation.test.mjs` (101 is the newest migration).

## Known gaps

- A carry needs the customer to still be an active member of the destination. The source must be one of the customer's companies (the portal offers the customer's current memberships). Tickets in a company the customer has already left can still be carried through the RPC, but the portal does not offer it yet.
- Transfer expiry is enforced when a decision is attempted. There is no scheduled sweeper, so a stale pending request blocks a new one until someone tries to decide it, or the customer cancels it from the portal.
- There is no company-side carry notification UI beyond the standard notification row.
