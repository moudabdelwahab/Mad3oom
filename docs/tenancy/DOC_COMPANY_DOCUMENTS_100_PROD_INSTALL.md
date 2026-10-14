# DOC — Company documents (migration 100) — production install note

> **Status: NOT EXECUTED.** Nothing here has been applied to production or deployed. No scanner is provisioned.
> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. Requires 095–099.
> New switch `company_documents_enabled` ships **OFF**.

## What 100 does

| Part | Detail |
|---|---|
| Catalogs | 4 document types: commercial registration, authorization letter, contract proof, tax card. Each type sets allowed files (PDF, PNG, JPEG), a 10 MB maximum and whether it has an expiry date. Company kinds are configurable; only `company` is seeded (safe default 1). Per-kind requirements: CR and tax card required, the other two optional, all owner-configurable through `owner_set_document_requirement`. |
| Storage | New **private** bucket `company-documents` (10 MB, PDF/PNG/JPEG) with **no storage policy at all**: browsers cannot read or write it. Only Edge Functions (service role) access it, after a database decision. Paths are server-generated: `<company>/<document>/<random>.<ext>`. |
| Upload | `document_upload_begin` (company admin + switch + type/size + idempotency) → Edge Function `company-document-upload` checks the declared type and size, reads the body with a hard cap, checks the magic bytes, computes SHA-256, and uploads to the generated path → `document_upload_commit` checks that the stored object exists with the declared size and records the hash. |
| Quarantine | Every committed version is `pending_scan`. **No download and no review for anyone until a clean scan result arrives.** Results come only through `document_scan_result` (service role) from `document-scan-callback`, which verifies an HMAC signature and a timestamp no older than 5 minutes. Results are final, and an infected file is rejected automatically. **Without a deployed scanner, every file stays quarantined.** |
| Download | `document_download_authorize` allows the company admin, the platform owner, or the assigned reviewer, for clean versions only. Every authorization is logged. `company-document-download` then returns a **60-second** signed URL. |
| Review | By the platform owner (context + step-up) or the assigned reviewer. A reviewer needs a `documents.review` delegation covering the company's unit, and `delegation_enabled`. Reviews apply to the current clean version only. The uploader cannot review their own file. A rejection needs a reason. Types with an expiry need a date at approval. Decisions are final; corrections require a new version. The company admin is notified. |
| Owner metadata | `owner_document_metadata`: keys `number`, `issuer`, `issued_on`, `expires_on` and `notes` only. Every change is logged with before and after values. File contents never change. |
| Expiry | `document_expiry_scan` marks approved documents past their date as `expired`, sends one notice 30 days before expiry, and notifies the company. It is **not scheduled**; scheduling it is a separate decision. |
| Retention | Policies are flagged `legally_approved = false` (the proposed durations are not legal advice). Legal holds are supported. `owner_retention_dry_run` lists what *would* be deleted, excludes held items and current versions, and logs each run. **There is no deletion function.** |
| History | `company_document_events` and `retention_runs` are append-only. Documents, versions and holds cannot be deleted. |

## Code that ships with 100 (not deployed)

- `supabase/functions/_shared/company-documents.js`: shared rules (types, 10 MB, magic bytes, name cleaning, scan signature, clamd reply parsing).
- `supabase/functions/company-document-upload/`, `company-document-download/`, `document-scan-callback/`: thin `index.ts` files plus `handler.js` with the logic. Tested in `tests/company-documents-functions.test.mjs`.
- `tools/document-scanner/worker.mjs`: reference ClamAV worker (not deployed, no infrastructure). See `DOCUMENT_SCANNER_RUNBOOK.md`.
- `company-dashboard/index.html` and `assets/js/company/company-documents.js`: "Company documents" panel. It is visible to the company admin only, and only when the switch is on.
- Owner dashboard: a "Company documents" review queue and the retention dry-run button.

## Apply (when approved)

1. Confirm 099 is applied.
2. Apply `migrations/100_company_documents.sql`. It is re-runnable. It self-checks that the switch is off, the bucket is private, no storage policy mentions the bucket, and no retention deletion function exists.
3. Deploy the three Edge Functions (`supabase functions deploy company-document-upload company-document-download document-scan-callback`). **Do not set `DOCUMENT_SCAN_SECRET`** until a real scanner exists. Without it, the callback answers 503 and files stay quarantined.
4. Deploy the frontend files.
5. Enabling `company_documents_enabled` is a separate decision. Before a scanner is live, uploads would work but nothing could be reviewed or downloaded.

## Rollback

`migrations/_rollback/100_company_documents.down.sql` drops 100's objects (100 changes no existing function or policy), including the bucket. This is proven by a schema digest that includes buckets. It **refuses** when:
- the switch is on;
- any document, version, event, legal hold, retention run or company-kind assignment exists;
- any object exists in the bucket.

## Tests

- `tests/sql/company-documents.test.sql`:
  - ① Objects and isolation of the bucket.
  - ①ب Rollback and re-apply.
  - ② Switch off.
  - ③ Upload rules: admin only, type, size, idempotency, stored object and size, hash.
  - ④ Quarantine:
    - no download or review before scan, even for the owner;
    - scan results through the service role only, idempotent and final;
    - scan queue.
  - ⑤ Download and review:
    - roles and 60 seconds;
    - other company, unassigned admin and company staff refused;
    - expiry required; content and decision immutable;
    - an infected replacement is rejected and quarantined;
    - no self-review.
  - ⑥ Assigned reviewer through delegation: sees only the assigned document and its current version; revocation takes effect immediately.
  - ⑦ Metadata history; expiry and one-time notice; legal hold excludes items from the dry run; nothing deleted; append-only.
  - ⑧ Rollback refused once data exists.
- `tests/company-documents-functions.test.mjs`: upload, download and callback handlers, signature checks, and the scanner framing.
- `tests/company-dashboard.render.test.mjs` (documents panel) and `tests/owner-governance.render.test.mjs` (review queue).
