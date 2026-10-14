# Document scanner (ClamAV) — runbook

> **Not provisioned.** No infrastructure has been bought or created, and no files have been sent anywhere.
> Until a scanner is running and `DOCUMENT_SCAN_SECRET` is set, every uploaded company document stays `pending_scan`: it cannot be reviewed or downloaded.

## Shape

```
company-document-upload ──► private bucket (company-documents)
    │  SHA-256 computed from the uploaded bytes, then document_upload_commit_server (service role, 104 L3)
    ▼                                                              status: pending_scan
worker.mjs ── document_scan_queue  (service role; pending_scan, then scan_error with < 3 attempts; ≤ 100)
    │  download object, check SHA-256 against the database
    │  clamd INSTREAM (local network only — never a third-party scanning service)
    ▼
document-scan-callback  (HMAC-SHA256 over "<unix-ts>.<body>", ±5 min; the verified signature is a one-time nonce, 104 L5)
    ▼
document_scan_result(…, p_nonce)  clean → pending_review · infected → rejected (stays quarantined)
                                  · error → scan_error: re-queued until 3 attempts, then stays quarantined (`scan_gave_up` event, 104 L4)
```

## Requirements

- A host you control running `clamd` (ClamAV) with `freshclam` updates. `StreamMaxLength` must be at least 10M to match the 10 MB limit. The host is reachable only from the worker.
- Node 20+ for `tools/document-scanner/worker.mjs`, run on a schedule (for example every minute).
- Environment for the worker:
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
  - `DOCUMENT_SCAN_SECRET`: at least 32 random characters, with the same value set as an Edge Function secret;
  - `CLAMD_HOST`, `CLAMD_PORT`, and optionally `SCAN_ENGINE`.

## Enable (separate approval)

1. Provision clamd and the worker host. Verify with the EICAR test file that the worker reports `infected`.
2. Deploy `company-document-upload` (with 104 it commits through the service role) and the callback **without gateway JWT verification**: `supabase functions deploy document-scan-callback --no-verify-jwt`. It authenticates every request with its own HMAC signature, and the worker sends no JWT, so with JWT verification on the gateway rejects every result with 401 (fail-closed, but scanning never completes). Deployment needs your approval.
3. Set the Edge Function secret: `supabase secrets set DOCUMENT_SCAN_SECRET=...`. This is a production secret change and needs your approval.
4. Run the worker once. `document_scan_queue()` should drain. Check `company_document_events` for `scan_result` rows.

## Failure behaviour (fail closed)

| Situation | Effect |
|---|---|
| No secret | The callback answers 503; files stay `pending_scan`. |
| Wrong or old signature | 401; nothing recorded. |
| The same signed request sent again (replay) | 409 `replayed`; the nonce was already used (104 L5). A worker retrying after a lost response should treat `replayed` as delivered, or re-sign with a fresh timestamp. |
| Download error or SHA-256 mismatch | The result is `error` (`scan_error`). The version stays unreviewable and is re-queued; after 3 attempts it stays quarantined (`scan_gave_up`), and the company uploads a new version. |
| clamd down or timeout | `error`, same as above. |
| Infected | The version is rejected automatically, stays quarantined, and the company must upload a new version. |
