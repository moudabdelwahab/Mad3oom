# Integrations Hub — setup and troubleshooting

## Who can do what
- **Company admin (owner)** with the `integrations_hub` entitlement: connects providers, sees health and the audit log, triages website requests, links customers, and sees order/invoice context on customer tickets.
- **Supervisors / agents** (086): nothing yet. They cannot see customer tickets today; when that access arrives, the per-connection setting *who sees this provider's data in tickets* applies (admin only / supervisors / all staff).
- **Customers, Mad3oom staff:** nothing.

## Connecting
| Provider | Steps | Shown once |
|---|---|---|
| WordPress | Integrations > WordPress > Connect > site URL (exact `https://` address the site answers on) → paste the pairing code in WordPress Settings > Mad3oom Support → Test connection | Pairing code |
| WooCommerce | Create a **Read** REST key → Integrations > WooCommerce > Connect (store URL, key, secret) → add two webhooks (Order created / Order updated, API v3) with the delivery URL and secret | Webhook secret |
| Salla | Integrations > Salla > Connect via Salla → approve → you come back **in the same tab** and it completes | — |
| Daftra | Create an API key → Integrations > Daftra > Connect (account name + key) | — |

Linking on a ticket: open the customer ticket → *External context* → choose the source → type the order/invoice number → *Link*. *Refresh* re-reads it; *Unlink* removes it from the ticket only.

Website requests: Integrations > *Support requests from your site* → choose the customer in your company → *Convert to ticket* (or *Dismiss*). If the request carried a WooCommerce order number, you can link it to the new ticket in one click.

## Error codes (card "last error", toasts, plugin diagnostics)
| Code | Meaning | What to do |
|---|---|---|
| `auth_failed` | Provider rejected the credentials | Check/recreate the key; for Salla, reconnect |
| `forbidden_scope` | Key lacks read permission | WooCommerce key must have Read; Daftra key must read invoices/clients |
| `api_not_found` | No REST API at that URL | Use the final https URL; enable pretty permalinks/REST |
| `redirect_refused` | The URL redirects | Enter the address after the redirect |
| `invalid_url` | Not https, internal, IP or has a port/query | Use the public https hostname |
| `rate_limited` / `provider_unavailable` / `timeout` | Temporary | Automatic retries; try *Test* later |
| `token_expired` / `app_uninstalled` | Salla authorization ended | Reconnect |
| `account_in_use` | That store/merchant/account is connected to another Mad3oom company | Disconnect it there first |
| `site_mismatch` | Plugin's site address ≠ registered URL | Disconnect and reconnect with the exact site URL |
| `state_invalid` | Salla flow expired, reused, or finished in another tab/browser | Start *Connect via Salla* again from this tab |
| `not_configured` | Platform secrets missing | Contact Mad3oom |
| `provider_disabled` | Provider switched off on the platform | Contact Mad3oom |

## WordPress plugin diagnostics
`unauthorized` → code rotated or connection removed: create a new pairing code. `network_error` → the server cannot reach the endpoint host shown under Diagnostics (outbound HTTPS/firewall). `connection_inactive` → connection disabled or needs attention in Mad3oom.

## Data kept
Only allowlisted summaries of records linked to tickets, refreshed by events or on demand; deleted 30 days after the last link is removed, or immediately on disconnect. Website requests: 180 days. Event inbox: 14–30 days, without payloads.
