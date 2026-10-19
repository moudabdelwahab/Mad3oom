# Isolation readiness (107) — production install note

> **Status: NOT applied.** No switch is changed. Full context: `ACCOUNT_REQUEST_EXECUTION_106.md` §3 (prerequisite matrix) and §4 (release checklist).

## Why

A read-only production audit on 2026-10-19 found three things that would let a company owner reach a customer's personal Mad3oom data **after** `company_isolation_enforced` is turned on:

| # | Gap | Fix | Where |
|---|---|---|---|
| 1 | The deployed `mcp` v34 predates 097: no `mcp_ticket_tenancy` filter, and subscription tickets are created without `category: 'subscription'` | Redeploy `mcp` from the merge commit (separate approval) | deployment |
| 2 | MCP subscriptions (list, get, cancel) admitted the company owner through `super_user_id` | `subscription-access.js`: owner of the row or admin, the same rule as the `whatsapp_subscriptions` policies | `supabase/functions/mcp/_shared/` |
| 3 | `ticket_in_my_scope` and `can_access_ticket` are SECURITY DEFINER, so `tenant_isolation` does not apply inside them. With isolation on, the company owner could close or reopen a customer's personal ticket by id, and the different errors revealed whether it existed and its status | When isolation is on, both also require `_ticket_id_visible` (the 097 rule) | migration 107 |

Everything else the audit checked is safe with isolation on: chats, notifications, API tokens and integrations, continuity, and every other service-role function.

## Apply

1. Ledger head is 106 (or 105 when this ships alone), and isolation is off.
2. Apply `107_isolation_readiness` with the release wrapper.
3. Verify:

```sql
select count(*) from pg_proc where proname in ('ticket_in_my_scope','can_access_ticket') and prosrc ~ '_ticket_id_visible';  -- 2
select public._isolation_on();                                                                                              -- false
```

With isolation off, both functions behave exactly as before (tested).

## Rollback

`psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/107_isolation_readiness.down.sql`

This restores the exact production definitions. It refuses while isolation is on, because rolling back would reopen the bypass.
