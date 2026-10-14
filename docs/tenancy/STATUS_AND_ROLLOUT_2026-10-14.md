# Multi-tenant architecture & security — status and rollout (2026-10-14)

> Branch `claude/dazzling-hypatia-lh1o9i`. **Production was not changed.** Every migration and function here is unapplied and undeployed, and every switch below ships **OFF**. Each production step needs your separate, explicit approval.
> Production was checked read-only on 2026-10-14:
> - ledger head `093_continuity_collab_actions`;
> - none of the 095–102 objects exist;
> - no `company-documents` bucket;
> - 39 tickets;
> - none of the new functions deployed.

## Phases → migrations → notes

| Phase | Migration | Switches (all OFF) | Install note |
|---|---|---|---|
| 0 Baseline | prod-shape chain to 093 (tests) | — | `tests/fixtures/prod-shape/` |
| A1 Account boundaries | `095_account_boundaries` | — (routing and secrets ownership; behaviour equal for existing accounts) | `A1_ACCOUNT_BOUNDARIES_095_PROD_INSTALL.md` |
| M Memberships | `096_company_memberships` | `multi_company_memberships_enabled` | `M_COMPANY_MEMBERSHIPS_096_PROD_INSTALL.md` |
| A2 Isolation + grants | `097_ticket_scope_isolation` | `company_isolation_enforced`, `data_access_grants_enabled` | `A2_TICKET_SCOPE_ISOLATION_097_PROD_INSTALL.md` |
| B Permissions + ledger | `098_company_permissions_usage_ledger` | `company_permissions_enabled` | `B_COMPANY_PERMISSIONS_LEDGER_098_PROD_INSTALL.md` |
| H1 Hierarchy | `099_admin_hierarchy` | `delegation_enabled`, `company_suspension_enforced` | `H1_ADMIN_HIERARCHY_099_PROD_INSTALL.md` |
| DOC Documents | `100_company_documents` | `company_documents_enabled` | `DOC_COMPANY_DOCUMENTS_100_PROD_INSTALL.md`, `DOCUMENT_SCANNER_RUNBOOK.md` |
| H2 Transfers / carry / history | `101_customer_transfers_carry` | `customer_transfers_enabled`, `ticket_carry_enabled`, `historical_access_enabled` | `H2_CUSTOMER_TRANSFERS_CARRY_101_PROD_INSTALL.md` |
| C + D Conversations + Inbox | `102_company_conversations` | `company_inbox_enabled` | `CD_COMPANY_CONVERSATIONS_102_PROD_INSTALL.md` |
| E Company Continuity | — (not implemented; fail-closed today) | — | `E_I_CONTINUITY_INTEGRATIONS_ASSESSMENT.md` |
| I Integrations | — (already company-scoped: 088 + 096–099) | — | `E_I_CONTINUITY_INTEGRATIONS_ASSESSMENT.md` |

Every migration:
- uses the next free number (094 belongs to PR #133, now merged into `main` and into this branch);
- is re-runnable;
- self-checks that all switches are off;
- has a rollback in `migrations/_rollback/`.

Each rollback was proven in a disposable database by apply → rollback → schema digest equal to the pre-migration state → re-apply twice. Since H2, the digest also covers constraints. Each rollback **refuses** while its switches are on or once it holds history that a rollback would destroy.

## Production approvals needed (in order; none executed)

1. **094** (Continuity reminders, PR #133): through its own note `docs/continuity/REMINDERS_094_PROD_INSTALL.md`.
2. **095 → 102**, one at a time, each through its install note: apply, then the verification SELECTs listed in the note. All switches stay off.
3. **Frontend deploy** of this branch's files. With the switches off there is no visible change, except the A1 routing and the permanent fixes listed below.
4. **Edge Functions.** Each is a separate approval:
   - `mcp` (097 isolation rule in MCP);
   - `company-document-upload`, `company-document-download` and `document-scan-callback` (100). Do not set `DOCUMENT_SCAN_SECRET` until a real scanner exists.
   - `ticket-carry-copy` (101). Set `CARRY_COPY_SECRET` only when carry is enabled.
   - `manage-external-integration`. The fix is committed; the deployed v22 still has the bug.
5. **Switch activations**, each with its own approval and owner step-up. Recommended order:
   1. `multi_company_memberships_enabled`
   2. `company_permissions_enabled`
   3. `company_isolation_enforced`. Needs your **separate, explicit approval** (Q17). Before it, review the deployed functions without source in this repository (`sie-api`, `integrations-api`, …).
   4. `data_access_grants_enabled`
   5. `delegation_enabled`, `company_suspension_enforced`
   6. `company_documents_enabled` (after a scanner exists)
   7. `customer_transfers_enabled`, `ticket_carry_enabled`, `historical_access_enabled` (after 098)
   8. `company_inbox_enabled`

## Permanent fixes that apply with the migration (no switch)

- 097: attachments on internal replies (table rows and files) are no longer readable by the ticket owner. Production has 0 such attachments today.
- 095: account secrets (API tokens and their logs, personal integrations, IP and device, points) are restricted to their owners.

## Infrastructure not provisioned

- **ClamAV scanner** for 100. A reference worker is in `tools/document-scanner/worker.mjs`, and the runbook covers deployment. Until it runs, every document stays quarantined (`pending_scan`).
- **Scheduler** for `ticket-carry-copy` (101) and for `document_expiry_scan` (100). Neither is scheduled.
- No files were sent to any third-party scanner. No credentials were created or changed.

## Known decisions left to you

- Deleting an account or company is refused while it holds governance history created by 097 (data-access grants), 099 (unit membership, delegations) or 100 (documents, legal holds), because those rows are append-only and cascade from it. The error is loud, and the deletion simply does not happen. The 101 and 102 tables follow the 086/096 convention instead: history keeps ids, and the deletion is not blocked. Decide whether 097, 099 and 100 should switch to that convention.
- `mcp_admin_update_ticket` likely always fails in production (service role with no user JWT). This is pre-existing and was left unchanged.
- Phase E (company Continuity): implementation plan and dependency order are in the assessment note.

## Test commands

```bash
npm run test:node                 # node + Playwright render tests
npm run test:sql                  # tests/sql/*.test.sql on a throwaway local Postgres (CI runner)
```

Results for this branch are in the PR description and the final report.
