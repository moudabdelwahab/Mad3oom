/* ============================================================================
   قسم «Pi Network» في لوحة المالك.

   يعرض ويحرّر، ولا يقرّر: كل كتابة محكومة بـRLS على is_platform_owner()
   (migrations/115). ومفتاحا Pi API سرّان في Edge Functions لا يمرّان بهذه
   الصفحة أبدًا — القسم يسأل pi-payments هل هما مضبوطان فقط:
     PI_API_KEY          تطبيق Testnet (mad3oom.com)
     PI_API_KEY_MAINNET  تطبيق Mainnet (mainnet.mad3oom.com)
============================================================================ */
import { announce } from '/assets/js/owner/owner-workspace.js';

const STATUS = Object.freeze({
    approved:  ['بانتظار الإتمام', 'status-open'],
    completed: ['مكتملة',          'status-resolved'],
    cancelled: ['ملغاة',           'status-neutral'],
    failed:    ['فشلت',            'status-rejected']
});

const fmtPi = (n) => n == null || n === ''
    ? '—'
    : `${Number(n).toLocaleString('ar-EG', { maximumFractionDigits: 7 })} π`;

export function initPiIntegration({ supabase, $, esc, when, table, td, errorBlock, rows }) {
    const say = (text, tone = 'info') => announce($('piStatus'), text, tone);
    let loaded = false;
    let filter = 'all';
    let lastSettings = null;

    const friendly = (error) => error?.code === '42501'
        ? 'القاعدة رفضت الطلب: هذا القسم لمالك المنصة وحده.'
        : (error?.message || 'حدث خطأ غير متوقع.');

    const missingTables = (error) => error?.code === '42P01'
        || /pi_settings|pi_payments|pi_plan_prices/.test(error?.message || '') && /exist|schema cache/.test(error?.message || '');

    // ── الملخّص وحالة الاتصال ────────────────────────────────────────────────
    async function renderSummary(settings, payments) {
        const linked = rows.filter(p => p.pi_uid).length;
        const done = payments.filter(p => p.status === 'completed');
        const total = done.reduce((s, p) => s + Number(p.amount || 0), 0);

        let fn = null;
        try {
            const { data, error } = await supabase.functions.invoke('pi-payments', { body: { action: 'status' } });
            fn = error ? { error } : data;
        } catch (e) { fn = { error: e }; }

        // حالة كل شبكة: التفعيل من القاعدة، والمفتاح من الدالة
        const netState = (n) => {
            const enabled = settings[`${n}_enabled`] === true;
            const k = fn?.[n];
            if (fn?.error) return ['الدالة غير منشورة', 'kpi--warning'];
            if (!k?.key_configured) return [enabled ? 'مفعّل بلا مفتاح' : 'لا مفتاح', 'kpi--warning'];
            if (k.key_valid === false) return ['المفتاح مرفوض', 'kpi--danger'];
            return enabled ? ['يعمل', 'kpi--success'] : ['جاهز — متوقف', ''];
        };
        const sum = (n) => done.filter(p => p.network === n).reduce((a, p) => a + Number(p.amount || 0), 0);
        const [tLabel, tTone] = netState('testnet');
        const [mLabel, mTone] = netState('mainnet');

        $('piKpis').innerHTML = [
            ['حسابات مربوطة بـPi', linked, ''],
            ['Testnet · mad3oom.com', tLabel, tTone],
            ['Mainnet · mainnet.mad3oom.com', mLabel, mTone],
            ['مدفوعات مكتملة', done.length, ''],
            ['المحصَّل — Mainnet', fmtPi(sum('mainnet')), sum('mainnet') ? 'kpi--success' : ''],
            ['المحصَّل — Testnet (تجريبي)', fmtPi(sum('testnet')), '']
        ].map(([label, value, tone]) => `
            <div class="kpi ${tone}">
                <p class="kpi-label">${esc(label)}</p>
                <p class="kpi-value">${esc(value)}</p>
            </div>`).join('');
    }

    // ── الإعدادات ─────────────────────────────────────────────────────────────
    function renderSettings(settings) {
        $('piTestnetEnabled').checked = settings.testnet_enabled === true;
        $('piMainnetEnabled').checked = settings.mainnet_enabled === true;
        const by = settings.updated_by ? rows.find(p => p.id === settings.updated_by) : null;
        $('piSettingsMeta').textContent = settings.updated_by
            ? `آخر تغيير ${when(settings.updated_at)}${by ? ` — ${by.full_name || by.email}` : ''}`
            : 'لم تُغيَّر بعد';
        $('piSettingsForm').hidden = false;
    }

    $('piSettingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const testnet_enabled = $('piTestnetEnabled').checked;
        const mainnet_enabled = $('piMainnetEnabled').checked;
        if (mainnet_enabled && !lastSettings?.mainnet_enabled && !window.confirm(
            'تفعيل الدفع على Mainnet: أي دفعة جديدة على mainnet.mad3oom.com ستكون بعملة Pi حقيقية. متابعة؟')) return;
        const btn = $('piSettingsSave');
        btn.disabled = true;
        say('جارٍ الحفظ…');
        // select() بعد التعديل: RLS لا تُرجع خطأ حين ترفض، بل صفرًا من الصفوف
        const { data, error } = await supabase.from('pi_settings')
            .update({ testnet_enabled, mainnet_enabled }).eq('id', true).select('id');
        btn.disabled = false;
        if (error || !data?.length) { say(error ? friendly(error) : 'لم يُحفظ — القاعدة لم تسمح بالتعديل.', 'error'); return; }
        say('تم حفظ الإعدادات.', 'success');
        load({ force: true });
    });

    // ── أسعار الخطط بالـPi ───────────────────────────────────────────────────
    function renderPrices(plans, prices) {
        const byPlan = new Map(prices.map(p => [p.plan_id, p]));
        const input = (planId, field, value) => `<input class="form-control pi-price-input" type="number"
            inputmode="decimal" min="0" step="0.0000001" dir="ltr" placeholder="—"
            data-plan="${esc(planId)}" data-field="${field}" value="${value ?? ''}"
            aria-label="${field === 'price_monthly_pi' ? 'السعر الشهري' : 'السعر السنوي'} بالـPi">`;

        $('piPricesBody').innerHTML = table(['الخطة', 'السعر الحالي', 'شهري (π)', 'سنوي (π)'], plans, plan => {
            const p = byPlan.get(plan.id);
            return `<tr>
                ${td(`<span class="owner-account-name">${esc(plan.name_ar || plan.name)}</span>`)}
                ${td(`<span class="owner-cell-muted">${esc(`${plan.price_monthly} ${plan.currency} / شهر`)}</span>`)}
                ${td(input(plan.id, 'price_monthly_pi', p?.price_monthly_pi))}
                ${td(input(plan.id, 'price_yearly_pi', p?.price_yearly_pi))}
            </tr>`;
        });
        $('piPricesForm').hidden = !plans.length;
    }

    $('piPricesForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const byPlan = new Map();
        for (const el of $('piPricesBody').querySelectorAll('.pi-price-input')) {
            const v = el.value.trim();
            if (v !== '' && !(Number(v) > 0)) {
                say('السعر لازم يكون رقمًا أكبر من صفر، أو اتركه فارغًا.', 'error');
                el.focus();
                return;
            }
            const row = byPlan.get(el.dataset.plan) ?? { plan_id: el.dataset.plan };
            row[el.dataset.field] = v === '' ? null : Number(v);
            byPlan.set(el.dataset.plan, row);
        }
        const btn = $('piPricesSave');
        btn.disabled = true;
        say('جارٍ حفظ الأسعار…');
        const { data, error } = await supabase.from('pi_plan_prices')
            .upsert([...byPlan.values()], { onConflict: 'plan_id' }).select('plan_id');
        btn.disabled = false;
        if (error || !data?.length) { say(error ? friendly(error) : 'لم تُحفظ الأسعار.', 'error'); return; }
        say('تم حفظ الأسعار.', 'success');
    });

    // ── سجل المعاملات ─────────────────────────────────────────────────────────
    let allPayments = [];
    let planNames = new Map();

    function renderPayments() {
        const list = filter === 'all' ? allPayments : allPayments.filter(p => p.status === filter);
        const account = (id) => {
            const u = rows.find(p => p.id === id);
            return `<span class="owner-account-name">${esc(u?.full_name || u?.email || id)}</span>`;
        };
        $('piPaymentsBody').innerHTML = table(
            ['الحساب', 'الخطة', 'المبلغ', 'الشبكة', 'الحالة', 'التاريخ', 'المعاملة', 'التسوية'], list, p => {
                const [label, cls] = STATUS[p.status] || [p.status, 'status-neutral'];
                return `<tr>
                    ${td(account(p.user_id))}
                    ${td(esc(`${planNames.get(p.plan_id) || '—'}${p.billing_cycle ? ` · ${p.billing_cycle === 'yearly' ? 'سنوي' : 'شهري'}` : ''}`))}
                    ${td(`<span dir="ltr">${esc(fmtPi(p.amount))}</span>`)}
                    ${td(esc(p.network === 'mainnet' ? 'Mainnet' : 'Testnet'))}
                    ${td(`<span class="pill ${cls}">${esc(label)}</span>${p.error ? `<span class="owner-cell-muted" dir="ltr"> ${esc(p.error)}</span>` : ''}`)}
                    ${td(when(p.created_at))}
                    ${td(p.txid ? `<code class="owner-cell-muted" dir="ltr" title="${esc(p.txid)}">${esc(p.txid.slice(0, 10))}…</code>` : '—')}
                    ${td(settlementCell(p))}
                </tr>`;
            });
    }

    /** التسوية: تذكرة + تفعيل + فاتورة (pi-payments → migrations/116). */
    function settlementCell(p) {
        if (p.status !== 'completed') return '<span class="owner-cell-muted">—</span>';
        if (p.settled_at && p.invoice_attached_at) {
            return `<a class="pill status-resolved" href="/admin/tickets.html?ticket_id=${esc(p.ticket_id)}">تذكرة مؤكَّدة + فاتورة</a>`;
        }
        const what = p.settled_at ? 'إرفاق الفاتورة' : 'إكمال التسوية';
        return `<button type="button" class="btn btn-outline btn-sm" data-settle="${esc(p.pi_payment_id)}">${what}</button>
            ${p.settle_error ? `<span class="owner-cell-muted" title="${esc(p.settle_error)}"> ⚠</span>` : ''}`;
    }

    $('piPaymentsBody').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-settle]');
        if (!btn) return;
        btn.disabled = true;
        say('جارٍ التسوية…');
        try {
            const { data, error } = await supabase.functions.invoke('pi-payments', {
                body: { action: 'settle', paymentId: btn.dataset.settle }
            });
            if (error) throw error;
            if (!data?.settled) throw new Error(data?.error || 'تعذّرت التسوية');
            say(data.invoice === 'attached' || data.invoice === 'already_attached'
                ? `تمت التسوية: تذكرة #${data.ticket_number ?? '—'} وفاتورة ${data.invoice_number ?? ''}.`
                : `الاشتراك مفعّل (تذكرة #${data.ticket_number ?? '—'})، والفاتورة لم تصدر بعد — جرّب تاني بعد قليل.`,
                data.invoice === 'pending' ? 'error' : 'success');
        } catch (err) {
            say(friendly(err), 'error');
        }
        load({ force: true });
    });

    $('piPaymentsFilter').addEventListener('change', (e) => { filter = e.target.value; renderPayments(); });

    // ── التحميل ──────────────────────────────────────────────────────────────
    async function load({ force = false } = {}) {
        if (loaded && !force) return;
        loaded = true;

        const [settings, plans, prices, payments] = await Promise.all([
            supabase.from('pi_settings').select('testnet_enabled, mainnet_enabled, updated_at, updated_by').eq('id', true).maybeSingle(),
            supabase.from('subscription_plans').select('id, name, name_ar, price_monthly, currency, sort_order')
                .eq('is_active', true).order('sort_order'),
            supabase.from('pi_plan_prices').select('plan_id, price_monthly_pi, price_yearly_pi'),
            supabase.from('pi_payments')
                .select('id, pi_payment_id, user_id, plan_id, billing_cycle, amount, network, status, txid, error, created_at, ticket_id, settled_at, invoice_attached_at, settle_error')
                .order('created_at', { ascending: false }).limit(200)
        ]);

        if (missingTables(settings.error)) {
            $('piSetupNotice').hidden = false;
            $('piKpis').innerHTML = '';
            for (const id of ['piPricesBody', 'piPaymentsBody']) $(id).innerHTML = '';
            loaded = false;
            return;
        }
        $('piSetupNotice').hidden = true;

        if (settings.error || !settings.data) {
            $('piKpis').innerHTML = errorBlock(settings.error?.message || 'لا يوجد صف إعدادات.');
            loaded = false;
            return;
        }

        allPayments = payments.data || [];
        planNames = new Map((plans.data || []).map(p => [p.id, p.name_ar || p.name]));

        lastSettings = settings.data;
        renderSettings(settings.data);
        if (plans.error || prices.error) $('piPricesBody').innerHTML = errorBlock((plans.error || prices.error).message);
        else renderPrices(plans.data || [], prices.data || []);
        if (payments.error) $('piPaymentsBody').innerHTML = errorBlock(payments.error.message);
        else renderPayments();
        await renderSummary(settings.data, allPayments);
    }

    $('piRefresh').addEventListener('click', () => { say(''); load({ force: true }); });

    return { load };
}
