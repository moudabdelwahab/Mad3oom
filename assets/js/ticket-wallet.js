/**
 * ticket-wallet.js — أيقونة «محفظة التذاكر» في الشريط العلوي لبوابة العميل
 * ولوحة الشركة.
 *
 * الرقم من my_ticket_wallet() (migrations/063) — نفس الدالة التي يمنع بها
 * محفّز tickets_enforce_quota إنشاء تذكرة بعد نفاد الرصيد، فالمعروض هنا هو
 * بالضبط ما ستطبّقه القاعدة.
 */
import { supabase } from '/api-config.js';
import { walletView, resetText } from '/assets/js/plan-pricing-model.js';

const STYLE_ID = 'ticketWalletStyles';
const CSS = `
.ticket-wallet{position:relative;display:inline-flex;}
.ticket-wallet-btn{position:relative;}
.ticket-wallet-count{position:absolute;top:-4px;inset-inline-start:-6px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;
  display:inline-flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:800;line-height:1;color:#fff;
  background:var(--color-success,#22C58B);border:2px solid var(--color-surface,#0D1622);font-family:inherit;}
.ticket-wallet-count.is-warn{background:var(--color-warning,#F5A623);}
.ticket-wallet-count.is-empty{background:var(--color-danger,#FF6B6B);}
.ticket-wallet-panel{position:absolute;top:calc(100% + 10px);inset-inline-end:0;width:min(330px,calc(100vw - 24px));z-index:1200;
  background:var(--color-surface,#0D1622);color:var(--color-text,#F3F6FB);border:1px solid var(--color-border,rgba(255,255,255,.1));
  border-radius:14px;box-shadow:0 24px 60px -18px rgba(0,8,25,.55);padding:1rem 1.1rem;text-align:start;}
.ticket-wallet-panel[hidden]{display:none;}
.tw-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.8rem;}
.tw-title{font-weight:800;font-size:.95rem;}
.tw-plan{font-size:.72rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;background:rgba(77,163,255,.14);color:var(--color-accent,#0077CC);white-space:nowrap;}
.tw-big{font-size:1.45rem;font-weight:800;line-height:1.3;}
.tw-big small{font-size:.8rem;font-weight:600;color:var(--color-text-secondary,#94A6C2);}
.tw-bar{height:8px;border-radius:999px;background:rgba(127,127,127,.18);overflow:hidden;margin:.6rem 0 .45rem;}
.tw-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#4DA3FF,#0077CC);}
.tw-bar.is-warn span{background:linear-gradient(90deg,#F5C623,#F5A623);}
.tw-bar.is-empty span{background:linear-gradient(90deg,#FF8A8A,#FF6B6B);}
.tw-sub{font-size:.78rem;color:var(--color-text-secondary,#94A6C2);line-height:1.7;}
.tw-note{font-size:.74rem;color:var(--color-text-secondary,#94A6C2);margin-top:.45rem;padding:.45rem .6rem;border-radius:8px;background:rgba(127,127,127,.08);}
.tw-actions{display:flex;gap:.5rem;margin-top:.9rem;}
.tw-actions a{flex:1;text-align:center;font-size:.8rem;font-weight:700;padding:.55rem .6rem;border-radius:9px;text-decoration:none;
  border:1px solid var(--color-border,rgba(255,255,255,.12));color:inherit;}
.tw-actions a.is-primary{background:var(--color-accent,#0077CC);border-color:var(--color-accent,#0077CC);color:#fff;}
`;

const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7H5a2 2 0 0 1 0-4h13v4"></path><path d="M3 5v14a2 2 0 0 0 2 2h15V7"></path><path d="M16 14h.01"></path></svg>';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function fetchTicketWallet() {
    const { data, error } = await supabase.rpc('my_ticket_wallet');
    if (error) throw error;
    return data || null;
}

/** محتوى لوحة المحفظة — مشترك بين الأيقونة وصفحة «اشتراكي». */
export function renderWalletPanel(view) {
    const tone = view.tone === 'ok' ? '' : ` is-${view.tone}`;
    const amount = view.unlimited
        ? `<div class="tw-big">∞ <small>تذاكر غير محدودة</small></div>`
        : `<div class="tw-big">${view.remaining} <small>تذكرة متبقية من ${view.limit}</small></div>`;
    const canUpgrade = view.planKey !== 'ultimate' && !view.unlimited;
    return `
        <div class="tw-head">
            <span class="tw-title">رصيد التذاكر</span>
            <span class="tw-plan">${esc(view.planLabel)}</span>
        </div>
        ${amount}
        ${view.unlimited ? '' : `<div class="tw-bar${tone}"><span style="width:${view.percent}%"></span></div>`}
        <div class="tw-sub">${esc(view.sub)}${view.daysToReset !== null && !view.unlimited ? ` · ${esc(resetText(view.daysToReset))}` : ''}</div>
        ${view.shared ? '<div class="tw-note">الرصيد مشترك لكل الحساب: أنت وباقي أعضاء الحساب.</div>' : ''}
        <div class="tw-actions">
            <a href="/my-subscription.html">تفاصيل اشتراكي</a>
            ${canUpgrade ? '<a href="/customer-subscriptions.html" class="is-primary">ترقية الخطة</a>' : ''}
        </div>`;
}

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

/**
 * يركّب الأيقونة في #ticketWallet (موجودة في customer-sidebar.html و
 * company-sidebar.html). يبقى مخفيًا لو تعذّر القراءة — لا رقم مضلّل.
 */
export async function mountTicketWallet() {
    const root = document.getElementById('ticketWallet');
    const btn = document.getElementById('ticketWalletBtn');
    const panel = document.getElementById('ticketWalletPanel');
    const count = document.getElementById('ticketWalletCount');
    if (!root || !btn || !panel || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    ensureStyles();

    let view = null;
    const refresh = async () => {
        try {
            view = walletView(await fetchTicketWallet());
        } catch (err) {
            console.warn('[TicketWallet]', err?.message || err);
            view = null;
        }
        if (!view) { root.hidden = true; return; }
        root.hidden = false;
        count.textContent = view.unlimited ? '∞' : String(view.remaining);
        count.className = 'ticket-wallet-count' + (view.tone === 'ok' ? '' : ` is-${view.tone}`);
        btn.title = `محفظة التذاكر — ${view.headline}`;
        btn.setAttribute('aria-label', `محفظة التذاكر: ${view.headline}`);
        if (!panel.hidden) panel.innerHTML = renderWalletPanel(view);
    };

    const close = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!panel.hidden) { close(); return; }
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        if (view) panel.innerHTML = renderWalletPanel(view);
        await refresh();
    });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // تذكرة جديدة من أي مكان في الصفحة (tickets-service) تحدّث الرقم فورًا.
    window.addEventListener('mad3oom:tickets-changed', refresh);

    await refresh();
}
