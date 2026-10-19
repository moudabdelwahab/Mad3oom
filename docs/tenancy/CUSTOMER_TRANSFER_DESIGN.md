# Customer transfer: readiness and design (direct platform customer → company)

> **Status: implemented in migration 106** (`ACCOUNT_REQUEST_EXECUTION_106.md`). This page is kept as the design record.
> 106 executes the owner-approved transfer in one transaction. Execution stays behind `account_request_execution_enabled` + company isolation + 098 permissions, all OFF. No real customer was transferred.
> **Differences from the proposal below:**
> - **Subscriptions:** they stay with the customer. An active or pending personal subscription **blocks** execution instead of a billing rule moving it.
> - **Failures:** they are recorded on the request, which stays pending and can be retried.
> - **Customer consent:** still an open decision.

## What exists

| Operation | Where | Semantics | Fits direct → company? |
|---|---|---|---|
| Change primary company (company A → company B) | 101 `customer_transfers`, `transfer_request` / `transfer_decide` / `owner_transfer_exceptional` | Needs a **source company** with an active primary membership, admin approvals on both sides and customer confirmation (or an owner exceptional transfer with step-up and a reason ≥ 20). It moves the 096 primary membership and mirror. Billing, tickets and subscriptions do not move | **No.** A direct customer has no source company, and 101 never touches the platform relationship or billing |
| Add a membership | 096 invitations; 105 approved `add_to_company` | A new company relationship; history stays with the customer | It is the *first step* of a transfer, not a transfer |
| Copy chosen tickets | 101 `ticket_carries` | The customer chooses; only the customer's own content is copied; originals stay | A building block |
| Historical access | 101 `historical_access_requests` | Company asks, customer agrees, owner decides; reads are logged | A building block |
| Raw `profiles.super_user_id` update | legacy (`check_super_user_creation`, `is_main_admin()`) | Instantly makes the company owner see **every** earlier ticket through `supervises()` / legacy `can_access_ticket` | **Must not be used.** 101 blocks it between companies while `customer_transfers_enabled` is on |

## What a complete transfer must mean

A direct customer becomes a customer **owned by** a company:
1. The platform direct relationship ends (`platform_direct_customers.end_cause = 'transferred'`).
2. A primary company membership starts (096), and the mirror is set.
3. **Billing and subscriptions:** decide per subscription whether it moves under the company (`whatsapp_subscriptions.company_id`), continues as the customer's own until expiry, or is cancelled and prorated. This needs a billing decision; no rule exists today.
4. **Account manager:** platform scope ends; a company-scope manager may be assigned by the company (reserved in 105).
5. **History:** earlier tickets, conversations and documents stay **private to the customer**. They are not visible to the company unless the customer chooses to carry them (101 carry) or approves historical access (101 + owner).
6. **Credentials:** unchanged. No auth email change, no password reset, no API tokens moved (095 keeps account secrets with the owner).

## Required safety properties

- Requires `company_isolation_enforced` and `company_permissions_enabled` (the same reason as 101 and the 105 add path). Both become one-way afterwards; the 105 guard already counts approved requests.
- Customer consent: either the customer confirms (101 model), or the owner uses an exceptional path with step-up, reason and audit. **Decision pending** (see `ACCOUNT_HIERARCHY_105.md` §8).
- Atomic, in one transaction: end the direct relationship, add the membership, set the mirror, apply the subscription rule, end the manager scope, mark approved. Any failure rolls everything back (the 105 pattern).
- Revalidate at approval:
  - the email is unchanged;
  - the customer is still direct and active;
  - the company is active;
  - no pending 101 transfer or other request;
  - the subscription state matches the snapshot.
- No replay: a final request and a row lock (the 105 pattern). Idempotent per requester key.
- Audit `privileged_audit` + 096 events + the account-request outcome. Notify the customer and the company admin generically.
- A rollback path is documented, but a completed transfer is never auto-reverted. A reverse transfer is a new request.

## Proposed implementation (a future migration, after the decisions)

1. `_account_request_execution('transfer_direct_to_company')` returns available only when:
   - `customer_transfers_enabled`, isolation and 098 are on;
   - a new `direct_transfer_billing_rule` setting is chosen.
2. In `owner_decide_account_request`, add a `transfer_direct_to_company` branch that reuses the 105 membership insert, ends the direct row with `transferred`, applies the billing rule and ends the platform-scope manager row.
3. Extend `CHECK_LABELS` and the impact summary with subscriptions and the billing rule.
4. Tests: everything in `tests/sql/account-hierarchy-customers.test.sql` ⑦, plus the billing rule, plus history staying private.

Until then the transfer type remains request and review only.
