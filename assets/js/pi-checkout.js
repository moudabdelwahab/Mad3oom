/* ============================================================================
   الدفع بعملة Pi لاشتراكات المنصة (U2A).

   الواجهة لا تقرّر شيئًا: المبلغ يُقرأ من pi_plan_prices للعرض فقط، والموافقة
   والإتمام في دالة pi-payments التي تقرأ الدفعة من Pi نفسها وتطابق المبلغ
   والشبكة وصاحب الحساب. بعد الإتمام يسوّي الخادم الدفعة وحده: تذكرة + تفعيل
   + فاتورة (pi_settle_payment).

   Pi.createPayment يعمل داخل Pi Browser وحده، فالخيار لا يظهر خارجه.
============================================================================ */
import { supabase } from '/api-config.js';
import { currentPiNetwork } from '/assets/js/pi-network.js';

const SDK_URL = 'https://sdk.minepi.com/pi-sdk.js';

export const isPiBrowser = () => /PiBrowser/i.test(navigator.userAgent || '');

let sdkPromise = null;
function loadSdk() {
    sdkPromise ??= new Promise((resolve, reject) => {
        // Pi.init ترجع Promise ولازم تكتمل قبل authenticate/createPayment
        // (توثيق SDK الرسمي) — من غير انتظارها الطلب بيعلّق بلا رد.
        const ready = async () => {
            try { await window.Pi.init({ version: '2.0', sandbox: false }); resolve(window.Pi); }
            catch (err) { sdkPromise = null; reject(err); }
        };
        if (window.Pi) { ready(); return; }
        const s = document.createElement('script');
        s.src = SDK_URL;
        s.async = true;
        s.onload = ready;
        s.onerror = () => { sdkPromise = null; reject(new Error('تعذّر تحميل Pi SDK')); };
        document.head.appendChild(s);
    });
    return sdkPromise;
}

async function callServer(body) {
    // الشبكة من النطاق: mainnet.mad3oom.com ← تطبيق Mainnet، وغيره ← Testnet
    const { data, error } = await supabase.functions.invoke('pi-payments', {
        body: { ...body, network: currentPiNetwork() }
    });
    if (error) {
        let message = error.message;
        try { message = (await error.context?.json())?.error || message; } catch (_) { /* نص الخطأ الأصلي */ }
        throw new Error(message);
    }
    return data;
}

/**
 * هل الدفع بـPi متاح لهذه الخطة الآن؟ لا يرمي أبدًا: أي فشل = غير متاح.
 * @returns {Promise<{available: boolean, reason?: string, amount?: number, planId?: string}>}
 */
export async function getPiOffer(planKey, billingCycle) {
    if (!isPiBrowser()) return { available: false, reason: 'not_pi_browser' };
    try {
        const [config, plan] = await Promise.all([
            callServer({ action: 'config' }),
            supabase.from('subscription_plans').select('id').eq('key', planKey).maybeSingle()
        ]);
        if (!config?.available) return { available: false, reason: 'disabled' };
        if (!plan.data?.id) return { available: false, reason: 'no_plan' };

        const { data: price } = await supabase.from('pi_plan_prices')
            .select('price_monthly_pi, price_yearly_pi').eq('plan_id', plan.data.id).maybeSingle();
        const amount = Number(billingCycle === 'yearly' ? price?.price_yearly_pi : price?.price_monthly_pi);
        if (!amount) return { available: false, reason: 'no_price' };
        if (!config.pi_linked) return { available: false, reason: 'not_linked', amount };

        return { available: true, amount, planId: plan.data.id };
    } catch (err) {
        console.warn('[pi-checkout] offer:', err?.message || err);
        return { available: false, reason: 'error' };
    }
}

/** دفعة سابقة لم تكتمل: نكملها من الخادم إن كان لها txid، وإلا نتركها. */
function onIncompletePaymentFound(payment) {
    const txid = payment?.transaction?.txid;
    if (!payment?.identifier || !txid) return;
    callServer({ action: 'complete', paymentId: payment.identifier, txid })
        .catch(err => console.warn('[pi-checkout] incomplete payment:', err?.message || err));
}

/**
 * يشغّل تدفق الدفع كاملًا ويُرجع { paymentId, txid } بعد الإتمام على الخادم.
 * يرمي Error برسالة عربية عند الإلغاء أو الفشل.
 */
export async function payWithPi({ planId, planLabel, billingCycle, amount }) {
    const Pi = await loadSdk();
    // نفس مهلة صفحة الدخول: authenticate قد لا يرد أبدًا لو Pi Browser لم يتعرّف على التطبيق
    await Promise.race([
        Pi.authenticate(['username', 'payments'], onIncompletePaymentFound),
        new Promise((_, reject) => setTimeout(() => reject(new Error(
            'انتهت المهلة: Pi Browser لم يرد على طلب الدفع. اقفل Pi Browser بالكامل وافتحه وحاول تاني.')), 45000))
    ]);

    return new Promise((resolve, reject) => {
        let paymentId = null;
        Pi.createPayment({
            amount,
            memo: `اشتراك مدعوم — ${planLabel} (${billingCycle === 'yearly' ? 'سنوي' : 'شهري'})`,
            metadata: { planId, billingCycle }
        }, {
            onReadyForServerApproval: (id) => {
                paymentId = id;
                callServer({ action: 'approve', paymentId: id, planId, cycle: billingCycle })
                    .catch(err => reject(new Error(`رُفضت الدفعة: ${err.message}`)));
            },
            onReadyForServerCompletion: (id, txid) => {
                // الخادم يتم الدفعة ويسوّيها: تذكرة + تفعيل + فاتورة (pi_settle_payment)
                callServer({ action: 'complete', paymentId: id, txid })
                    .then((settlement) => resolve({ paymentId: id, txid, settlement }))
                    .catch(err => reject(new Error(
                        `وصلت الدفعة للبلوكتشين لكن تعذّر تأكيدها (${err.message}). احتفظ بالرقم ${id} وتواصل مع الدعم.`)));
            },
            onCancel: (id) => {
                callServer({ action: 'cancel', paymentId: id }).catch(() => {});
                reject(new Error('تم إلغاء الدفع.'));
            },
            onError: (error, payment) => {
                if (payment?.identifier || paymentId) {
                    callServer({ action: 'cancel', paymentId: payment?.identifier || paymentId }).catch(() => {});
                }
                reject(new Error(error?.message || 'حدث خطأ في محفظة Pi.'));
            }
        });
    });
}
