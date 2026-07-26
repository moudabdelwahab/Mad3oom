/**
 * Wallet Top-up Approval Service
 *
 * Structural mirror of /whatsapp-subscription-service.js's
 * confirmPurchaseTicket() / rejectPurchaseTicket() pair, applied to
 * whatsapp_wallet_topup_requests instead of whatsapp_subscriptions.
 *
 * This module intentionally contains NO new balance-adjustment logic and NO
 * new RPCs. Crediting the wallet is delegated entirely to the existing
 * WalletService.adjustBalance() wrapper (services/wallet-service.js), which
 * itself calls the existing wa_wallet_adjust RPC. This file only:
 *   - flips the ticket + the linked whatsapp_wallet_topup_requests row,
 *   - triggers the existing wallet credit for approvals,
 *   - notifies the customer via the existing notification service,
 * exactly as the subscription service does for ticket + whatsapp_subscriptions
 * + profiles + notification.
 *
 * NOTE on import paths: this file lives in the WhatsApp module repo (same
 * repo as services/wallet-service.js), unlike whatsapp-subscription-service.js
 * which lives in the Core Platform repo and imports '/api-config.js' and
 * '/notifications-service.js' as Core Platform root-relative modules. Since
 * tickets.js (Core Platform) imports this file cross-origin from
 * 'https://wa.mad3oom.com/whatsapp-wallet-topup-service.js', this file needs
 * its own Supabase client and its own notification-insert call — it cannot
 * import Core Platform's '/api-config.js' or '/notifications-service.js'
 * across origins. See TODOs below for the two spots this affects.
 *
 * Idempotency / ordering guard: identical in shape to confirmPurchaseTicket().
 * The credit-triggering update is conditioned on .eq('status', 'pending') in
 * the same query, so a second call against an already-approved/rejected
 * request matches zero rows and safely no-ops (returns a clear error)
 * instead of crediting the wallet twice.
 */

// TODO(cross-repo import): whatsapp-subscription-service.js imports its
// Supabase client from Core Platform's '/api-config.js'. This file is served
// from the WhatsApp repo instead (see supabase-config.js / supabase-integration.js
// in this repo), so it must initialize its own client the same way
// supabase-integration.js does, rather than assuming a '/api-config.js' path
// that only exists in the other repo.
import { SupabaseIntegration } from './supabase-integration.js';
import { WalletService } from './services/wallet-service.js';
import { WalletPricing } from './services/wallet-pricing.js';

/**
 * Confirm a wallet top-up request: credits the wallet via the existing
 * WalletService.adjustBalance() wrapper (-> existing wa_wallet_adjust RPC,
 * which itself enforces "team only" server-side — no new authorization
 * check is added here), marks the request + ticket as approved, and
 * notifies the customer. Mirrors confirmPurchaseTicket() exactly:
 *
 *   1. Fetch the whatsapp_wallet_topup_requests row linked to ticket_id.
 *      If none exists, stop immediately (ticket left untouched) — same
 *      "no linked row -> no-op with a clear error" guard as the
 *      subscription service.
 *   2. Flip the request row to 'approved' conditioned on .eq('status',
 *      'pending') in the same update — the idempotency guard. If the
 *      update matches zero rows (already reviewed), return an error
 *      without touching the wallet, the ticket, or sending a notification.
 *   3. Only once step 2 confirms exactly one row flipped: credit the
 *      wallet via WalletService.adjustBalance({ type: 'topup', ... }).
 *      If the credit throws, the request row is reverted back to
 *      'pending' (best-effort) so a retry is possible instead of leaving
 *      an 'approved' request with no credit applied.
 *   4. Flip the ticket to 'confirmed' (mirrors the subscription service's
 *      ticket status naming exactly, since tickets.js/STATUS_MAP already
 *      renders 'confirmed' → "مؤكدة" for this flow).
 *   5. Notify the customer (best-effort, non-blocking — same pattern as
 *      the subscription service).
 *
 * @param {string} ticketId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function confirmWalletTopupTicket(ticketId) {
    try {
        const supabase = await SupabaseIntegration.initializeSupabase();
        const { data: { user: adminUser } } = await supabase.auth.getUser();
        const now = new Date();
        const nowIso = now.toISOString();

        // Step 1 — same "no linked row -> stop, don't touch the ticket" guard
        // as confirmPurchaseTicket().
        const { data: topupRequest, error: fetchError } = await supabase
            .from('whatsapp_wallet_topup_requests')
            .select('*')
            .eq('ticket_id', ticketId)
            .maybeSingle();

        if (fetchError) throw fetchError;

        if (!topupRequest) {
            console.error('confirmWalletTopupTicket: no whatsapp_wallet_topup_requests row linked to ticket', ticketId);
            return {
                success: false,
                error: 'لا يوجد طلب شحن رصيد مرتبط بهذه التذكرة (whatsapp_wallet_topup_requests). لم يتم تأكيد التذكرة.'
            };
        }

        // Step 2 — idempotency guard: update conditioned on current status
        // still being 'pending', exactly like confirmPurchaseTicket()'s
        // .eq('status', 'pending') on the same query.
        const { data: approvedRequest, error: reqUpdateError } = await supabase
            .from('whatsapp_wallet_topup_requests')
            .update({
                status: 'approved',
                reviewed_by: adminUser ? adminUser.id : null,
                reviewed_at: nowIso,
            })
            .eq('id', topupRequest.id)
            .eq('status', 'pending')
            .select()
            .maybeSingle();

        if (reqUpdateError) throw reqUpdateError;

        if (!approvedRequest) {
            return {
                success: false,
                error: `لا يمكن تأكيد طلب الشحن هذا لأن حالته الحالية "${topupRequest.status}" وليست "pending". لم يتم تنفيذ أي تعديل (لا على الرصيد ولا على التذكرة) لتفادي تكرار الشحن.`
            };
        }

        // Step 3 — credit the wallet via the existing wrapper. No new
        // balance-adjustment logic here: this is the same
        // WalletService.adjustBalance() call other approved flows use,
        // reusing the existing wa_wallet_adjust RPC and its existing
        // server-side team-only authorization check.
        try {
            await WalletService.adjustBalance({
                userId: approvedRequest.user_id,
                amount: Number(approvedRequest.amount),
                type: 'topup',
                description: `شحن رصيد بمبلغ ${WalletPricing.formatAmount(approvedRequest.amount)} ${approvedRequest.currency || 'EGP'}`,
                ticketId,
            });
        } catch (creditError) {
            console.error('confirmWalletTopupTicket: wallet credit failed, reverting request to pending:', creditError);
            // Revert the request back to 'pending' so a retry doesn't see it
            // stuck as 'approved' with no actual credit applied.
            await supabase
                .from('whatsapp_wallet_topup_requests')
                .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
                .eq('id', approvedRequest.id)
                .eq('status', 'approved');
            return {
                success: false,
                error: 'تم تأكيد الطلب لكن فشل شحن الرصيد فعلياً. تم التراجع عن التأكيد، حاول مرة أخرى.'
            };
        }

        // Step 4 — flip the ticket, same shape as confirmPurchaseTicket().
        const { error: ticketUpdateError } = await supabase
            .from('tickets')
            .update({
                status: 'confirmed',
                last_updated_by: adminUser ? adminUser.id : null,
                last_updated_at: nowIso,
            })
            .eq('id', ticketId);

        if (ticketUpdateError) throw ticketUpdateError;

        // Step 5 — notify the customer, best-effort/non-blocking, same
        // pattern as confirmPurchaseTicket()'s createNotification() call.
        //
        // TODO(cross-repo import): whatsapp-subscription-service.js calls
        // Core Platform's createNotification() from '/notifications-service.js'.
        // That module isn't available to this repo (different origin). Until
        // a shared/cross-origin notification helper exists, insert directly
        // into the same `notifications` table shape every createNotification()
        // call in tickets-service.js already uses (user_id, title, message,
        // type, link) rather than duplicating that service's internals.
        try {
            await supabase.from('notifications').insert({
                user_id: approvedRequest.user_id,
                title: '✓ تم شحن رصيدك',
                message: `تم تأكيد طلب شحن رصيد واتساب بمبلغ ${WalletPricing.formatAmount(approvedRequest.amount)} ${approvedRequest.currency || 'EGP'} وإضافته لرصيدك.`,
                type: 'success',
                link: '/dashboard.html?page=wallet&tab=history',
            });
        } catch (notifyError) {
            console.error('confirmWalletTopupTicket: notification failed (non-blocking):', notifyError);
        }

        return { success: true };
    } catch (error) {
        console.error('Error confirming wallet topup ticket:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Reject a wallet top-up request. Mirrors rejectPurchaseTicket() exactly:
 * no wallet mutation ever happens on this path.
 *
 * @param {string} ticketId
 * @param {string} [reason]
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function rejectWalletTopupTicket(ticketId, reason = '') {
    try {
        const supabase = await SupabaseIntegration.initializeSupabase();
        const { data: { user: adminUser } } = await supabase.auth.getUser();
        const nowIso = new Date().toISOString();

        const { error: updateTicketError } = await supabase
            .from('tickets')
            .update({
                status: 'rejected',
                last_updated_by: adminUser ? adminUser.id : null,
                last_updated_at: nowIso,
            })
            .eq('id', ticketId);

        if (updateTicketError) throw updateTicketError;

        const { data: topupRequest, error: reqUpdateError } = await supabase
            .from('whatsapp_wallet_topup_requests')
            .update({
                status: 'rejected',
                rejection_reason: reason || null,
                reviewed_by: adminUser ? adminUser.id : null,
                reviewed_at: nowIso,
            })
            .eq('ticket_id', ticketId)
            .select()
            .maybeSingle();

        if (reqUpdateError) {
            console.error('Failed to update wallet topup request on rejection:', reqUpdateError);
        }

        if (topupRequest) {
            try {
                await supabase.from('notifications').insert({
                    user_id: topupRequest.user_id,
                    title: 'تم رفض طلب شحن الرصيد',
                    message: reason
                        ? `تم رفض طلب شحن رصيد واتساب الخاص بك. السبب: ${reason}`
                        : 'تم رفض طلب شحن رصيد واتساب الخاص بك. تواصل مع الدعم لمزيد من التفاصيل.',
                    type: 'error',
                    link: '/dashboard.html?page=wallet&tab=history',
                });
            } catch (notifyError) {
                console.error('rejectWalletTopupTicket: notification failed (non-blocking):', notifyError);
            }
        }

        return { success: true };
    } catch (error) {
        console.error('Error rejecting wallet topup ticket:', error);
        return { success: false, error: error.message };
    }
}
