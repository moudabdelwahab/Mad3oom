/**
 * mcp-connected-apps.js — التطبيقات الخارجية المتصلة بمدعوم
 * ------------------------------------------------------------
 * الاتجاه هنا **معاكس** لبقية قسم MCP في اللوحة:
 *
 *   بقية القسم  →  مدعوم **عميل** يتصل بخوادم خارجية ليستخدم أدواتها.
 *   هذا الملف   →  مدعوم **خادم** تتصل به تطبيقات خارجية (Claude،
 *                  ChatGPT، أي عميل MCP) عبر OAuth لتستخدم أدواته.
 *
 * خلط الاتجاهين في شاشة واحدة كان سيجعل «فصل» تعني شيئين مختلفين في
 * نفس الصفحة، فله تبويب فرعي مستقلّ.
 *
 * ما يستطيعه المستخدم هنا: يرى ما هو متصل فعلًا، ويضيّق صلاحياته،
 * ويحدّد مدة للاتصال، ويفصله. كل ذلك مفروض على الخادم في
 * supabase/functions/oauth-connected-apps — والواجهة عرض لا حارس.
 */
import { supabase } from '/api-config.js';
import { describeScope } from '/assets/js/company/api-token-model.js';
import { openModal, closeModal, toast } from '/assets/js/admin/mcp-integrations.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let apps = [];
let container = null;

/* ══════════════════ أدوات عرض ══════════════════ */

function relTime(iso) {
    if (!iso) return 'لم يُستخدم بعد';
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '—';
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'الآن';
    if (m < 60) return `منذ ${m} دقيقة`;
    const h = Math.floor(m / 60);
    if (h < 24) return `منذ ${h} ساعة`;
    const d = Math.floor(h / 24);
    return d < 30 ? `منذ ${d} يوم` : new Date(iso).toLocaleDateString('ar-EG');
}

/** المدة المتبقية للاتصال — هذه هي التي تهمّ المستخدم، لا انتهاء التوكن القصير. */
function untilText(iso) {
    if (!iso) return 'بلا انتهاء';
    const diff = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(diff)) return '—';
    if (diff <= 0) return 'انتهى';
    const d = Math.floor(diff / 86400000);
    if (d >= 1) return `${d} يوم متبقٍ`;
    const h = Math.floor(diff / 3600000);
    if (h >= 1) return `${h} ساعة متبقية`;
    return `${Math.max(1, Math.floor(diff / 60000))} دقيقة متبقية`;
}

function appInitial(name) {
    return esc((name || '?').trim().charAt(0).toUpperCase() || '?');
}

/* ══════════════════ نداء الخادم ══════════════════ */

async function call(action, extra = {}) {
    const { data, error } = await supabase.functions.invoke('oauth-connected-apps', {
        body: { action, ...extra },
    });
    if (error) throw new Error(error.message);
    if (data?.error) throw new Error(data.error);
    return data;
}

/* ══════════════════ الشبكة ══════════════════ */

/**
 * يرسم قائمة التطبيقات المتصلة.
 * @param {HTMLElement} el
 */
export async function renderConnectedApps(el) {
    container = el || container;
    if (!container) return;

    container.innerHTML = '<div class="state-block"><div class="spinner"></div><p>جاري قراءة التطبيقات المتصلة...</p></div>';

    try {
        const res = await call('list');
        apps = Array.isArray(res.apps) ? res.apps : [];
    } catch (err) {
        container.innerHTML = `<div class="state-block empty"><p>${esc(err.message || 'تعذّر قراءة التطبيقات المتصلة.')}</p></div>`;
        return;
    }

    const countEl = document.getElementById('caCount');
    if (countEl) countEl.textContent = String(apps.length);

    if (!apps.length) {
        container.innerHTML = `
          <div class="mi-empty">
            <div class="mi-empty-ic">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            </div>
            <h3>لا توجد تطبيقات متصلة</h3>
            <p>عندما يربط تطبيق خارجي — مثل Claude أو ChatGPT — حسابك على مدعوم عبر OAuth، سيظهر هنا ويمكنك التحكّم في صلاحياته ومدّته.</p>
          </div>`;
        return;
    }

    container.innerHTML = `<div class="ca-list">${apps.map(cardHtml).join('')}</div>`;
}

function cardHtml(app) {
    const priv = Array.isArray(app.privileged_scopes) ? app.privileged_scopes : [];
    const scopes = Array.isArray(app.scopes) ? app.scopes : [];

    const meta = [
        `<span class="mi-tag">${scopes.length} صلاحية</span>`,
        `<span class="mi-tag">${esc(untilText(app.session_expires_at))}</span>`,
    ];
    if (priv.length) {
        meta.push(`<span class="ca-tag-warn">${priv.length} مرتفعة</span>`);
    }

    return `<div class="ca-card${priv.length ? ' has-priv' : ''}">
        <div class="ca-top">
            <span class="ca-logo">${appInitial(app.client_name)}</span>
            <div class="ca-id">
                <div class="ca-name">${esc(app.client_name)}</div>
                <div class="ca-sub">آخر استخدام: ${esc(relTime(app.last_used_at))} · ${app.usage_count} طلب</div>
            </div>
            <span class="ca-live">متصل</span>
        </div>
        <div class="ca-meta">${meta.join('')}</div>
        <div class="ca-acts">
            <button class="mi-btn" data-ca="scopes" data-id="${esc(app.api_token_id)}">الصلاحيات</button>
            <button class="mi-btn" data-ca="expiry" data-id="${esc(app.api_token_id)}">المدة</button>
            <button class="mi-btn ghost danger" data-ca="revoke" data-id="${esc(app.api_token_id)}" style="margin-inline-start:auto">فصل</button>
        </div>
    </div>`;
}

const findApp = (id) => apps.find((a) => a.api_token_id === id);

/* ══════════════════ إدارة الصلاحيات ══════════════════ */

function scopesPanel(id) {
    const app = findApp(id);
    if (!app) return;
    const scopes = Array.isArray(app.scopes) ? app.scopes : [];

    // التبويب بالعربي من نفس مصدر شاشة الموافقة، فلا اسمان لصلاحية واحدة.
    const groups = new Map();
    for (const key of scopes) {
        const d = describeScope(key);
        const g = d.group || 'صلاحيات أخرى';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(d);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
        const aHi = a[1].some((d) => d.privileged) ? 0 : 1;
        const bHi = b[1].some((d) => d.privileged) ? 0 : 1;
        return aHi - bHi;
    });

    openModal(`
      <div class="mi-mhead">
        <span class="ca-logo">${appInitial(app.client_name)}</span>
        <div><p class="mi-mtitle">صلاحيات ${esc(app.client_name)}</p><p class="mi-msub">أزل ما لا تريد منحه</p></div>
        <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
      </div>
      <div class="mi-mbody">
        <div class="ca-note">
          يمكنك <strong>إزالة</strong> صلاحيات فقط. إضافة صلاحية جديدة تحتاج أن يطلبها
          التطبيق من جديد وتوافق عليها — وهذا ما يمنع أي تطبيق من توسيع صلاحياته بنفسه.
        </div>
        <div class="oc-bulk">
          <button type="button" id="caNone">إلغاء الكل</button>
          <span class="oc-count" id="caSelCount"></span>
        </div>
        ${ordered.map(([g, items]) => `
          <div class="oc-group">
            <div class="oc-group-t">${esc(g)}</div>
            <ul class="oc-list">
              ${items.map((d) => `
                <li class="oc-item${d.danger ? ' danger' : ''}">
                  <input type="checkbox" class="ca-cb" value="${esc(d.key)}" checked
                         aria-label="${esc(d.known ? d.label : d.key)}">
                  <span>${d.known ? esc(d.label) : `<code>${esc(d.key)}</code>`}</span>
                </li>`).join('')}
            </ul>
          </div>`).join('')}
      </div>
      <div class="mi-mfoot">
        <button class="mi-btn" data-mi-close>إلغاء</button>
        <button class="mi-btn primary" id="caSaveScopes" style="margin-inline-start:auto">حفظ</button>
      </div>`);

    const picked = () => [...document.querySelectorAll('.ca-cb:checked')].map((c) => c.value);
    const saveBtn = document.getElementById('caSaveScopes');
    const countEl = document.getElementById('caSelCount');

    function sync() {
        const n = picked().length;
        if (countEl) countEl.textContent = `${n} من ${scopes.length}`;
        // صفر صلاحية ليس تضييقًا بل فصلًا، والخادم يرفضه — فالأوضح توجيه
        // المستخدم إلى «فصل» بدل تركه يضغط زرًّا سيفشل.
        saveBtn.disabled = n === 0;
        saveBtn.title = n === 0 ? 'لإزالة كل الصلاحيات استخدم «فصل»' : '';
    }
    document.querySelectorAll('.ca-cb').forEach((c) => c.addEventListener('change', sync));
    document.getElementById('caNone')?.addEventListener('click', () => {
        document.querySelectorAll('.ca-cb').forEach((c) => { c.checked = false; });
        sync();
    });
    sync();

    saveBtn.onclick = async () => {
        const next = picked();
        if (!next.length) return;
        saveBtn.disabled = true; saveBtn.textContent = 'جاري الحفظ…';
        try {
            const res = await call('update_scopes', { api_token_id: id, scopes: next });
            closeModal();
            const removed = Array.isArray(res.removed) ? res.removed.length : 0;
            toast(removed ? `تم سحب ${removed} صلاحية` : 'لم يتغيّر شيء', 'success');
            await renderConnectedApps();
        } catch (err) {
            saveBtn.disabled = false; saveBtn.textContent = 'حفظ';
            toast(err.message || 'تعذّر حفظ الصلاحيات', 'error');
        }
    };
}

/* ══════════════════ المدة ══════════════════ */

const EXPIRY_PRESETS = [
    { label: 'يوم واحد', days: 1 },
    { label: '7 أيام', days: 7 },
    { label: '30 يومًا', days: 30 },
    { label: '90 يومًا', days: 90 },
    { label: 'سنة', days: 365 },
];

function expiryPanel(id) {
    const app = findApp(id);
    if (!app) return;

    openModal(`
      <div class="mi-mhead">
        <span class="ca-logo">${appInitial(app.client_name)}</span>
        <div><p class="mi-mtitle">مدة اتصال ${esc(app.client_name)}</p><p class="mi-msub">متى يتوقف الوصول تلقائيًا</p></div>
        <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
      </div>
      <div class="mi-mbody">
        <div class="mi-rows">
          <div class="mi-row"><span class="mi-k">الحالي</span><span class="mi-v">${esc(untilText(app.session_expires_at))}</span></div>
          <div class="mi-row"><span class="mi-k">ينتهي في</span><span class="mi-v">${app.session_expires_at ? esc(new Date(app.session_expires_at).toLocaleString('ar-EG')) : '—'}</span></div>
        </div>
        <p class="oc-sec" style="margin-top:1rem">اختر مدة جديدة تبدأ من الآن:</p>
        <div class="ca-presets">
          ${EXPIRY_PRESETS.map((p) => `<button type="button" class="ca-preset" data-days="${p.days}">${esc(p.label)}</button>`).join('')}
        </div>
        <div class="ca-note" style="margin-top:.9rem">
          التوكن نفسه قصير العمر ويتجدّد تلقائيًا؛ هذه المدة تحكم متى يتوقف
          التجديد — أي العمر الحقيقي للاتصال. لإنهائه الآن استخدم «فصل».
        </div>
      </div>
      <div class="mi-mfoot">
        <button class="mi-btn" data-mi-close>إلغاء</button>
      </div>`);

    document.querySelectorAll('.ca-preset').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const days = Number(btn.dataset.days);
            document.querySelectorAll('.ca-preset').forEach((b) => { b.disabled = true; });
            btn.textContent = 'جاري الحفظ…';
            try {
                const at = new Date(Date.now() + days * 86400000).toISOString();
                await call('set_expiry', { api_token_id: id, expires_at: at });
                closeModal();
                toast('تم ضبط مدة الاتصال', 'success');
                await renderConnectedApps();
            } catch (err) {
                document.querySelectorAll('.ca-preset').forEach((b) => { b.disabled = false; });
                btn.textContent = EXPIRY_PRESETS.find((p) => p.days === days)?.label || 'مدة';
                toast(err.message || 'تعذّر ضبط المدة', 'error');
            }
        });
    });
}

/* ══════════════════ الفصل ══════════════════ */

function revokePanel(id) {
    const app = findApp(id);
    if (!app) return;

    openModal(`
      <div class="mi-mhead">
        <span class="ca-logo">${appInitial(app.client_name)}</span>
        <div><p class="mi-mtitle">فصل ${esc(app.client_name)}؟</p><p class="mi-msub">إجراء فوري لا رجعة فيه</p></div>
        <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
      </div>
      <div class="mi-mbody">
        <div class="ca-warn">
          سيفقد <strong>${esc(app.client_name)}</strong> الوصول إلى حسابك فورًا، ولن يستطيع
          تجديد جلسته. لإعادة الربط لاحقًا سيحتاج أن يطلب التفويض من جديد وتوافق عليه.
        </div>
      </div>
      <div class="mi-mfoot">
        <button class="mi-btn" data-mi-close>تراجع</button>
        <button class="mi-btn danger-solid" id="caConfirmRevoke" style="margin-inline-start:auto">نعم، افصله</button>
      </div>`);

    const btn = document.getElementById('caConfirmRevoke');
    btn.onclick = async () => {
        btn.disabled = true; btn.textContent = 'جاري الفصل…';
        try {
            await call('revoke', { api_token_id: id });
            closeModal();
            toast('تم فصل التطبيق', 'success');
            await renderConnectedApps();
        } catch (err) {
            btn.disabled = false; btn.textContent = 'نعم، افصله';
            toast(err.message || 'تعذّر الفصل', 'error');
        }
    };
}

/* ══════════════════ الأحداث ══════════════════ */

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-ca]');
    if (!el) return;
    e.preventDefault();
    const id = el.dataset.id;
    if (el.dataset.ca === 'scopes') scopesPanel(id);
    else if (el.dataset.ca === 'expiry') expiryPanel(id);
    else if (el.dataset.ca === 'revoke') revokePanel(id);
});

window.mcpConnectedApps = { renderConnectedApps };
