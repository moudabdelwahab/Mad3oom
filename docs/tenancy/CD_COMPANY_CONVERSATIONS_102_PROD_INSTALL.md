# C + D — Company conversations and Company Inbox (migration 102) — production install note

> **Status: NOT EXECUTED.** Nothing here has been applied to production or deployed.
> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. Requires 095–101.
> New switch ships **OFF**: `company_inbox_enabled`.

## Why new tables instead of `chat_sessions`

The existing chat (`chat_sessions`, `chat_messages`, migrations 055–067) is **Mad3oom's** helpdesk:

- `has_elevated_authority()` reads every session, and platform staff read through `inbox_can_access`;
- it carries the bot, hand-off, scheduled replies and external channels (WhatsApp, Telegram);
- Continuity sources come from it.

Adding a `company_id` to it would inherit all of those platform-wide paths. Phase C therefore uses new tables that are **company-private from inception**, as the order requires.

## What 102 does

| Part | Detail |
|---|---|
| Tables | `company_conversations`, `company_conversation_messages`, `company_conversation_events` (append-only, no FKs so it survives deletions) and `company_conversation_reads`. They have **no table grants** for `anon`, `authenticated` or `service_role`, no permissive policy (only the restrictive `gate_account_active`), and are not in the Realtime publication. The migration self-checks all three. |
| No platform path | No policy or function lets platform staff, elevated authority or the platform owner read a conversation. The owner in owner context with a fresh step-up gets "not found" (tested). The 097 access grants cover tickets only, so Mad3oom support has no route here at all (Q8). |
| Customer ("message your company") | `company_conversation_start(subject, body, key)` creates the conversation in the company of the customer's **server-checked context** (096). The company is stamped and immutable. Starting is idempotent by key. `my_company_conversations()` lists conversations with the current company. The customer always reads their own conversations, but writes only while an active customer of that company. After leaving, a conversation is read-only. |
| Company team | Access goes through the 098 catalog with new keys `conversations.view`, `view_assigned`, `reply`, `internal_notes`, `assign` and `close`. Defaults: supervisor all; agent view_assigned, reply, internal_notes and close. The company admin always has access. Employees additionally need `company_permissions_enabled`; without it they have no inbox (fail-closed, like tickets). `company_inbox_summary()` and `company_inbox_list(filter)` return null when there is no access. Assignment is to eligible team members only. |
| Privacy toward the customer | Internal notes are never returned to the customer. Staff names are hidden from the customer: replies show as "the company", and `assigned_to` / `assignee_name` are null in the customer's view. Notifications carry no message text. |
| Abuse limits | 5 new conversations per hour per customer; 20 messages per 5 minutes per customer. |
| Suspension | With `company_suspension_enforced` (099), a suspended company's inbox closes for its team and its customers. |
| Integrity | Messages cannot be edited or deleted directly, the event log is append-only, and a conversation's company, customer and key are immutable. Deleting a customer account deletes that customer's conversations and keeps the events. Deleting a staff account keeps their messages with the sender cleared. Neither deletion is blocked (tested). |

## Code that ships with 102 (not deployed)

- Portal: `portal/index.html` (`#messages`, the notification link target), `assets/js/portal/portal-messages.js`, and `portal-data.js` (`fetchMyConversations`, `validateConversation`, `startConversation`, `fetchConversationThread`, `replyToConversation`).
- Company dashboard:
  - new section `inbox` (`#inboxTabContent`) and `assets/js/company/company-inbox.js`;
  - filters (open / unassigned / mine / closed / all), thread view, public reply or internal note, assignment, and close/reopen, each shown only when the database says the viewer may use it;
  - the sidebar link appears only when `company_inbox_summary()` returns a value, and shows an unread badge.
- Tests: `tests/sql/company-conversations.test.sql`, `tests/company-inbox.test.mjs`, the 102 cases in `tests/portal-model.test.mjs`, `tests/portal.render.test.mjs` and `tests/company-dashboard.render.test.mjs`, `tests/company-add-member.render.test.mjs` (inbox navigation), and `tests/company-navigation.test.mjs`.

## Apply (when approved)

1. Confirm 101 is applied.
2. Apply `migrations/102_company_conversations.sql`. It is re-runnable. It self-checks that the switch is off, there are no grants, no permissive policy, and no Realtime publication.
3. Deploy the frontend files. With the switch off, nothing new is visible: the portal section and the sidebar link stay hidden.
4. Enable `company_permissions_enabled` (098) **before** `company_inbox_enabled` if employees should use the inbox. Without it only company admins can.
5. Turning on `company_inbox_enabled` is a separate decision.

Verification after apply:

```sql
select enabled from public.platform_feature_switches where key = 'company_inbox_enabled';           -- false
select count(*) from public.company_permission_catalog where key like 'conversations.%';           -- 6
select count(*) from information_schema.role_table_grants
 where table_schema = 'public' and table_name like 'company_conversation%'
   and grantee in ('anon', 'authenticated', 'service_role');                                       -- 0
```

## Rollback

`migrations/_rollback/102_company_conversations.down.sql` drops 102's objects (102 changes no existing function or policy) and restores the 098 catalog. A schema digest (functions with ACLs, policies, triggers, columns, grants, switches, constraints) proves the result equals the pre-102 state. It **refuses** when:
- the switch is on;
- any conversation or conversation event exists;
- any company has configured a `conversations.*` permission.

## Known gaps (documented, not hidden)

- **No live updates.** The tables are deliberately outside Realtime (Realtime needs table grants). The UI refreshes on actions and through the refresh button. A future step can add Realtime with RLS policies that mirror the RPC rules, after its own isolation tests.
- **No attachments** in conversations yet. Files would need the 100 pattern (private bucket, server-generated paths, scan quarantine). Customers needing files should use tickets.
- **No anonymous website widget.** Website visitors already reach a company through the Integrations Hub intake (088, `ihub_intake_requests` → `ihub_intake_convert`). An embeddable anonymous chat needs separate decisions on guest identity, an origin allowlist, abuse controls and spam handling. "Company widget mode" here is the authenticated portal channel.
- **No conversation-to-ticket conversion.** It would be a straightforward follow-up using the 097 stamping rules.
- **No company inbox in MCP or external APIs.** None was added, and none can reach these tables (no grants, no service-role path).
