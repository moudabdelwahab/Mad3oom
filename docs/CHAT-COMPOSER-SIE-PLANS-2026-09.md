# Chat composer + SIE plans — change record and deployment order

Branch `claude/compassionate-franklin-nh9b7p`, in this repo and in `moudabdelwahab/sie`.

**Nothing in this change has been applied to production or deployed.** The
frontend depends on two migrations. Ship them in the order below.

---

## Deployment order (atomic unit)

| # | Artifact | Repo | Action |
|---|---|---|---|
| 1 | `sie-integration/migrations/0011_sie_self_service.sql` | sie | apply **first** |
| 2 | `migrations/054_chat_composer_attachments.sql` | Mad3oom | apply **second** |
| 3 | `chat-widget.js`/`.css`, `chat-customer.html`, `chat-logic.js`, `chatbot-mode-selector.js`, `customer-settings-modal.*`, new `assets/js/{sie-plan-model,sie-plan-service,chat-attachments,voice-recorder}.js`; deletion of `chatbot-engine.js` and `chatbot-mode-service.js` | Mad3oom | publish **third** (merge) |
| 4 | SIE engine (`sie-api`, `sie-channel-telegram`) with the updated Pro pack | sie | redeploy **any time after 3** |

**Why the order matters.**

- **0011 must come before the frontend.** Before 0011, only 4 of the 33
  production users had a `customer_sie_access` row. The new frontend has no
  Traditional fallback, so the other 29 would see "SIE is not enabled for
  your account" on every message. 0011 backfills a Free row for every
  profile and provisions one on sign-up.
- **054 must come before the frontend.** It adds `chat_messages.attachment`.
  Without it, every attachment insert fails. Plain text messages still work.
- **054 is safe on the current frontend.** The column is nullable, the old
  pages never write it, and the trigger accepts the old `image_url` paths
  because they already sit in the sender's folder. The old settings dialog
  could still write `chatbot_mode = 'traditional'`; that write is refused
  once 054 lands, and saving shows an error there until step 3 ships.
- **Step 4 is independent.** It only changes the answers SIE gives about the
  old modes (see the SIE section below).

**Rollback.**

- Frontend: redeploy the previous commit. It needs neither migration.
- 054: drop the triggers `trg_guard_chat_message_attachment` and
  `trg_guard_chatbot_mode_value`, and the policy
  `chat_attachments_delete_own_unreferenced`. The column can stay; it is
  nullable and unused by old code.
- 0011: drop the trigger `trg_sie_provision_free_access` and the two RPCs,
  then restore the 0010 guard. The backfilled Free rows are harmless.

**Verify after step 3.**

1. A user who had no SIE row gets a SIE answer and sees «SIE المجاني» on the
   composer button.
2. A Max user sees «النزول إلى برو» and «النزول إلى المجاني»; a Free user sees
   neither.
3. A PDF, an image and a voice note each show up in the admin chat.
4. `PATCH /rest/v1/profiles?id=eq.<self>` with
   `{"chatbot_mode":"traditional"}` returns an error.

---

## What changed

**The composer (widget and full chat page)** is laid out as
`[attach][input][SIE · plan][mic/send]`. The widget has the mic; the full
chat page has no mic. The plan menu opens as a popover inside the composer:

- SIE is the only response mode;
- plan badge;
- usage: used, remaining, total, % and reset time;
- the downgrades the server offers.

Everything comes from `sie_my_entitlement()`. Nothing is kept in
localStorage.

**No hidden fallback bot.** When SIE can't answer, the customer is told the
server's reason, or plainly that there is a temporary problem, and the
message stays with the support team.

**Attachments** use the existing private `chat-attachments` bucket.

- Validation: MIME and extension must agree. Size limits: images 5 MB,
  files 10 MB, audio 10 MB. The bucket enforces 10 MB and a MIME allow-list.
- Behaviour: upload progress; cleanup when an upload or insert fails; signed
  URLs only.
- Admin view: shows images, audio and files.

**Removed** (frontend only; SIE and every database table are untouched):

- `chatbot-engine.js` (the Traditional engine);
- `chatbot-mode-service.js` (the Traditional / AI / Auto picker; AI and Auto
  had no engine behind them);
- the Traditional quick-reply flows and the `__attach_image__` flow.

## Tests

| Suite | Result |
|---|---|
| `tests/chat-composer-model.test.mjs` | 20/20 |
| `tests/chat-widget.render.test.mjs` | 21/21 (+1 visual, runs with `WIDGET_SHOTS=<dir>`) |
| `tests/chat-page.render.test.mjs` | 13/13 |
| `tests/sql/chat-attachments.test.sql` (054) | 22 checks |
| `npm test` (whole repo) | all pass except 3 environmental failures, which also fail without this change: `xlsx` not installed, and 2 checks that need full git history (the clone is shallow) |
| `npm run test:sql` | exit 0, 449 checks |
| SIE `self-service.test.sql` (0011) | 61 checks |
| SIE `scripts/test-migrations.sh` | 183 checks |
| SIE `npm test` | 1027/1027 |
| SIE `scripts/mutation-check.mjs` | 19/19 killed |
