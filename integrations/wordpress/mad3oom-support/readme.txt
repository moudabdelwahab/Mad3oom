=== Mad3oom Support ===
Contributors: mad3oom
Tags: support, helpdesk, woocommerce, tickets
Requires at least: 6.0
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connect your site to your company's Mad3oom workspace: a support request form, a portal link, and a "Request support" action on WooCommerce orders.

== Description ==

* **Pairing** — paste the one-time pairing code from Mad3oom (Company dashboard > Integrations > WordPress). The secret stays on this server; it is never shown again and never sent to visitors' browsers.
* **Support form** — `[mad3oom_support_form]`. Submissions are signed on the server and arrive in Mad3oom as *support requests* that your company admin reviews and converts into a ticket for an existing customer. No JavaScript, a nonce, a honeypot and a per-visitor rate limit.
* **Portal link** — `[mad3oom_portal_link label="..."]` links to your Mad3oom customer portal (HTTPS only).
* **WooCommerce** — adds "Request support" to each order in My Account > Orders. The order number is attached only when the order belongs to the logged-in customer (checked on the server twice).

Order details shown to your agents in Mad3oom come from the separate WooCommerce connection (read-only REST keys you create), not from this plugin.

= What this plugin does not do =

* It does not create Mad3oom accounts for visitors and never merges WordPress users with Mad3oom customers.
* It does not send order contents, addresses, payment details or your WooCommerce keys to Mad3oom.
* It does not show Mad3oom tickets to site visitors (no secure identity link exists for that yet).

== Installation ==

1. Upload the ZIP in Plugins > Add New > Upload Plugin, then activate.
2. In Mad3oom: Company dashboard > Integrations > WordPress > Connect, enter this site's URL and copy the pairing code.
3. Here: Settings > Mad3oom Support > paste the code > Pair with Mad3oom > Test connection.
4. Create a page with `[mad3oom_support_form]`, enable the form, and (for WooCommerce) set the Support page URL.

== Frequently Asked Questions ==

= The test says Mad3oom rejected the signature =
The code was rotated or the site was disconnected in Mad3oom. Create a new pairing code and pair again.

= The test says Mad3oom could not be reached =
Your server must be able to make outbound HTTPS requests to the Mad3oom endpoint shown under Diagnostics.

= Uninstalling =
Deleting the plugin removes every option it stored, including the secret. Also disconnect the site in Mad3oom.

== Changelog ==

= 0.1.0 =
* First release. Not yet verified on a live WordPress/WooCommerce site.
