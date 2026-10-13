# Daftra (دفترة) — capability report and setup

**Status: read-only connector, implemented and tested with mocks only. Field mapping unverified. No webhooks, no sync, no writes.** Connector: `supabase/functions/_shared/integrations/daftra.js`.

## What could be verified
Only through web-search snippets of `docs.daftara.dev` (the host is blocked in this environment; no official SDK exists on npm or Packagist):
- API base `https://<subdomain>.daftra.com/api2`.
- API-key authentication with a key generated in account settings; the docs warn not to send an `Authorization` header together with the API key.
- `GET /clients/{id}` returns the client inside `Client`, with `business_name`.
- Invoice write payloads use an `Invoice` wrapper with `client_id` and `currency_code`.
- OAuth 2.0 is described as available, but its token endpoint and parameters were not found → **not implemented**.

## Unverified assumptions in the code (each must be confirmed with a trial account)
| Assumption | Where |
|---|---|
| Header name `APIKEY` | `get()` |
| Paths end in `.json` (`/clients.json?limit=1`, `/invoices/{id}.json`, `/clients/{id}.json`) | `verifyConnection`, `fetchInvoice`, `fetchCustomer` |
| Response wrapper `data.Invoice` / `data.Client` (also accepts top-level) | `mapInvoice`, `mapClient` |
| Invoice fields `no`, `date`, `summary_total`, `summary_paid`, `summary_unpaid`, `payment_status`, `client_business_name` | `mapInvoice` (each is dropped if it does not have the expected shape) |

## Policy
No invoice issuing, editing, payments or any accounting change (as requested). Only the support summary is stored: number, date, currency, total, paid, unpaid, payment-status code, client name and id; for clients, the business name only (no e-mail, phone or address).

## Setup (company)
Daftra > Settings > API keys > create a key (read access to invoices and clients if Daftra offers scoping). Mad3oom > Integrations > Daftra > Connect: the account name (`acme` from `acme.daftra.com`) and the key. Disconnect in Mad3oom, then delete the key in Daftra.

## Needed from Daftra / the product owner
Official API reference access (or allow `docs.daftara.dev`), a trial account, confirmation of the items above, whether webhooks or a `modified` filter exist (for future incremental refresh), and published rate limits.
