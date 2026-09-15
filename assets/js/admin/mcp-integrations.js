/**
 * mcp-integrations.js — تجربة ربط MCP المبسّطة
 * ------------------------------------------------------------
 * المشكلة التي يحلّها هذا الملف:
 *
 *   نموذج إضافة خادم MCP الحالي (admin/mcp.html) فيه 21 حقل إدخال —
 *   نوع النقل، أمر التشغيل، الوسائط، Client ID، Client Secret، روابط
 *   OAuth الأربعة، ترويسات JSON خام، متغيّرات بيئة JSON… ليربط المستخدم
 *   حسابه على GitHub كان عليه أن يفهم OAuth أولًا.
 *
 *   هنا المسار كله: اختر الخدمة ← شخصي/مشترك ← اتصل ← وافق ← متصل.
 *   لا يُطلب من المستخدم أي تفصيل تقني إلا ما تفرضه الخدمة نفسها فعلًا،
 *   وعندها يُطلب ذلك الحقل وحده لا النموذج كاملًا.
 *
 * حدود هذا الملف (مقصودة):
 *  - لا يستبدل النموذج المتقدّم: تبويب «إعدادات متقدّمة» في نفس الصفحة
 *    يبقى كما هو بالحرف، لكل حالة تحتاج تحكّمًا كاملًا.
 *  - لا يعرف قاعدة البيانات ولا يلمس أي Edge Function: كل عملياته تمرّ
 *    عبر دوال mcp-service.js القائمة (createServer / saveCredentials /
 *    startOAuth / testServer / disconnectServer / setToolEnabled).
 *  - لا يخزّن ولا يقرأ أي سرّ. الاعتماد يُرسَل مرة واحدة إلى
 *    saveCredentials ولا يُعاد قراءته أبدًا — نفس عقد الصفحة الحالي.
 *
 * ملاحظة على «مشترك»:
 *   لا يوجد في القاعدة عمود owner_scope ولا جدول منح ولا سياسات RLS
 *   تفرضهما. لذلك يظهر الخيار في التصميم لكنه **معطّل صراحةً** وموسوم
 *   بأنه يحتاج خطوة الـbackend. عرض خيار يبدو فعّالًا وهو لا يفرض شيئًا
 *   أسوأ من عدم عرضه إطلاقًا.
 */
import { UI_STATES, STATE_LABEL, deriveUiState, explainError, validateCredential } from '/assets/js/admin/mcp-ui-state.js';
import {
    MCP_CLIENT_CATALOG,
    MCP_CATALOG_CATEGORIES,
    createServer,
    saveCredentials,
    startOAuth,
    testServer,
    disconnectServer,
    setToolEnabled,
    findConnectedServerForCatalogEntry,
} from '/mcp-service.js';

/* ══════════════════ حالات العرض وترجمة الأخطاء ══════════════════ */

/* المنطق الخالص يعيش في وحدة بلا تبعيات ليمكن اختباره خارج المتصفح
 * (tests/mcp-ui-state.test.mjs). نعيد تصديره هنا ليبقى سطح الوحدة واحدًا. */
export { UI_STATES, STATE_LABEL, deriveUiState, explainError, validateCredential } from '/assets/js/admin/mcp-ui-state.js';

/* ══════════════════ أدوات عرض ══════════════════ */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function iconMarkup(entry) {
    if (entry?.icon) {
        return `<svg viewBox="0 0 24 24" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">${entry.icon}</svg>`;
    }
    return esc(entry?.initial || '?');
}

function statePill(state) {
    const spinner = state === UI_STATES.CONNECTING;
    const mark = spinner ? '<span class="mi-spin"></span>' : '<span class="mi-dot"></span>';
    return `<span class="mi-pill s-${state}">${mark}${esc(STATE_LABEL[state] || state)}</span>`;
}

function relTime(iso) {
    if (!iso) return '—';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '—';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'الآن';
    if (mins < 60) return `قبل ${mins} دقيقة`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `قبل ${hrs} ساعة`;
    const days = Math.round(hrs / 24);
    return days === 1 ? 'أمس' : `قبل ${days} يومًا`;
}

function authLabel(t) {
    return { oauth2: 'OAuth', bearer: 'رمز وصول', api_key: 'مفتاح API', custom: 'ترويسات مخصّصة', none: 'بلا مصادقة' }[t] || t || '—';
}

/* ══════════════════ الحالة الداخلية ══════════════════ */

/** الخوادم كما مرّرها مضيف الصفحة (mcp.js). مصدر الحقيقة يبقى هناك. */
let servers = [];
/** ردّ نداء يطلب من المضيف إعادة تحميل البيانات بعد أي تغيير. */
let onChanged = async () => {};
/** معرّفات الخوادم التي لها عملية جارية الآن — لعرض «جارٍ الربط». */
const busy = new Set();

/* ══════════════════ النافذة المنبثقة ══════════════════ */

function closeModal() {
    document.getElementById('miLayer')?.remove();
}

function openModal(html) {
    closeModal();
    const layer = document.createElement('div');
    layer.id = 'miLayer';
    layer.innerHTML = `<div class="mi-scrim" id="miScrim"><div class="mi-modal" role="dialog" aria-modal="true">${html}</div></div>`;
    document.body.appendChild(layer);
    layer.querySelector('#miScrim').addEventListener('click', (e) => {
        if (e.target.id === 'miScrim') closeModal();
    });
    layer.querySelectorAll('[data-mi-close]').forEach((b) => b.addEventListener('click', closeModal));
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function toast(msg, type) {
    if (typeof window.mcpToast === 'function') return window.mcpToast(msg, type);
    console[type === 'error' ? 'error' : 'log']('[MCP]', msg);
}

/* ══════════════════ الشبكة ══════════════════ */

/** بطاقة موحّدة — تُبنى من عنصر كتالوج أو من خادم مضاف يدويًا. */
function tileBody({ entry, server, isCatalog }) {
    const state = busy.has(server?.id) ? UI_STATES.CONNECTING : deriveUiState(server);
    const isOauthConnector = (server?.connector_type || entry?.connector_type) === 'oauth_connector';
    const toolCount = !isOauthConnector && Array.isArray(server?.tools) ? server.tools.length : 0;
    const isOn = state === UI_STATES.CONNECTED;

    const meta = [statePill(state)];
    if (server?.connection_id) meta.push('<span class="mi-tag">شخصي</span>');
    if (isOn && !isOauthConnector) meta.push(`<span class="mi-tag">${toolCount} أداة</span>`);
    if (isOauthConnector) meta.push('<span class="mi-tag">تفويض فقط</span>');

    let acts;
    if (state === UI_STATES.CONNECTING) {
        acts = '<button class="mi-btn" disabled>جارٍ الربط…</button>';
    } else if (isOn) {
        acts = `<button class="mi-btn" data-mi="detail" data-id="${esc(server.id)}">إدارة</button>
                <button class="mi-btn ghost" data-mi="test" data-id="${esc(server.id)}">اختبار</button>`;
    } else if (state === UI_STATES.ERROR) {
        acts = `<button class="mi-btn primary" data-mi="error" data-id="${esc(server.id)}">عرض المشكلة</button>
                <button class="mi-btn ghost" data-mi="detail" data-id="${esc(server.id)}">إدارة</button>`;
    } else if (state === UI_STATES.AUTH_REQUIRED) {
        acts = `<button class="mi-btn primary" data-mi="authorize" data-id="${esc(server.id)}">إكمال التفويض</button>
                <button class="mi-btn ghost" data-mi="detail" data-id="${esc(server.id)}">إدارة</button>`;
    } else if (isCatalog) {
        acts = `<button class="mi-btn primary" data-mi="connect" data-key="${esc(entry.key)}">ربط</button>`;
    } else {
        acts = `<button class="mi-btn primary" data-mi="test" data-id="${esc(server.id)}">ربط</button>
                <button class="mi-btn ghost" data-mi="detail" data-id="${esc(server.id)}">إدارة</button>`;
    }

    const name = isCatalog ? entry.name : server.name;
    const desc = isCatalog ? (entry.description || '') : (server.description || 'خادم مخصّص مُضاف يدويًا');
    const color = isCatalog ? (entry.brandColor || '#666') : '#64748b';
    const glyph = isCatalog ? iconMarkup(entry) : esc((server.name || '?').trim().charAt(0).toUpperCase());

    return `<div class="mi-tile ${isOn ? 'is-connected' : ''}">
        <div class="mi-tile-top">
            <div class="mi-logo" style="background:${esc(color)}">${glyph}</div>
            <div style="min-width:0">
                <div class="mi-name">${esc(name)}</div>
                <div class="mi-desc">${esc(desc)}</div>
            </div>
        </div>
        <div class="mi-meta">${meta.join('')}</div>
        <div class="mi-acts">${acts}</div>
    </div>`;
}


/**
 * يرسم شبكة التكاملات داخل الحاوية المعطاة.
 *
 * تعرض الشبكة مصدرين، تمامًا كما كانت تفعل النسخة السابقة:
 *   • عناصر الكتالوج (الخدمات الجاهزة)
 *   • أي خادم أُضيف يدويًا من النموذج المتقدّم ولا يطابق عنصر كتالوج —
 *     حذفها كان سيُخفي خوادم قائمة عن أصحابها.
 *
 * @param {HTMLElement} container
 * @param {{servers: Array, search?: string, category?: string, onChanged?: Function}} ctx
 */
export function renderIntegrations(container, ctx) {
    if (!container) return;
    servers = ctx.servers || [];
    if (typeof ctx.onChanged === 'function') onChanged = ctx.onChanged;

    const q = (ctx.search || '').trim().toLowerCase();
    const cat = ctx.category || 'all';

    // «تكاملاتك» = ما لهذا المستخدم اتصال به فعلًا. باقي صفوف mcp_servers
    // تعريفات أنشأها غيره ولم يربطها هو بعد، فمكانها نافذة الإضافة لا هنا.
    const mine = servers.filter((s) => s.connection_id);
    const shown = mine.filter((s) => {
        const entry = catalogEntryFor(s);
        if (cat !== 'all' && (entry?.category || 'custom') !== cat) return false;
        if (!q) return true;
        return `${s.name || ''} ${s.description || ''}`.toLowerCase().includes(q);
    });

    if (!shown.length) {
        container.classList.remove('mi-grid');
        container.innerHTML = mine.length
            ? '<div class="state-block empty"><p>لا يوجد تكامل مطابق لبحثك.</p></div>'
            : `<div class="mi-empty">
                 <div class="mi-empty-ic">
                   <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>
                 </div>
                 <h3>لا توجد تكاملات بعد</h3>
                 <p>اربط خدمة لتستخدم أدواتها داخل مدعوم. الربط لا يتطلّب منك أي إعداد تقني.</p>
                 <button class="mi-btn primary" data-mi="add">+ إضافة تكامل</button>
               </div>`;
        return;
    }

    container.classList.add('mi-grid');
    container.innerHTML = shown
        .map((s) => {
            const entry = catalogEntryFor(s);
            return tileBody({ entry, server: s, isCatalog: Boolean(entry) });
        })
        .join('');
}

/** يطابق صف خادم بعنصر الكتالوج الذي يمثّله (بالرابط ثم بالاسم)، أو null لخادم مخصّص. */
function catalogEntryFor(server) {
    if (!server) return null;
    for (const entry of MCP_CLIENT_CATALOG) {
        if (entry.isCustomBlank) continue;
        if (findConnectedServerForCatalogEntry(entry, [server])) return entry;
    }
    return null;
}

/* ══════════════════ نافذة اختيار الخدمة ══════════════════ */

/**
 * الخطوة الأولى في المسار: «إضافة تكامل» ← اختيار الخدمة.
 *
 * فصلها عن الشبكة الرئيسية مقصود: الصفحة صارت تعرض «تكاملاتك» فقط، وما
 * يمكن إضافته يعيش هنا. قبل ذلك كانت الصفحة تعرض الكتالوج كاملًا فيختلط
 * ما ربطه المستخدم بما لم يربطه، ولا يظهر له سؤال «ماذا لديّ؟» أبدًا.
 */
export function openServicePicker() {
    let query = '';
    let category = 'all';

    const render = () => {
        const q = query.trim().toLowerCase();
        const claimed = new Set(servers.filter((s) => s.connection_id).map((s) => s.id));

        const cards = [];
        for (const entry of MCP_CLIENT_CATALOG) {
            if (entry.isCustomBlank) continue;
            if (category !== 'all' && entry.category !== category) continue;
            if (q && !`${entry.name} ${entry.description}`.toLowerCase().includes(q)) continue;
            const existing = findConnectedServerForCatalogEntry(entry, servers);
            const already = existing && claimed.has(existing.id);
            cards.push(pickerCard({
                key: entry.key, name: entry.name, desc: entry.description,
                color: entry.brandColor, glyph: iconMarkup(entry), already,
            }));
        }

        // تعريفات خوادم موجودة في القاعدة لم يربطها هذا المستخدم بعد.
        if (category === 'all' || category === 'custom') {
            for (const s of servers) {
                if (s.connection_id || catalogEntryFor(s)) continue;
                if (q && !`${s.name || ''} ${s.description || ''}`.toLowerCase().includes(q)) continue;
                cards.push(pickerCard({
                    serverId: s.id, name: s.name, desc: s.description || 'خادم مخصّص مُضاف يدويًا',
                    color: '#64748b', glyph: esc((s.name || '?').trim().charAt(0).toUpperCase()), already: false,
                }));
            }
        }

        const body = document.getElementById('miPickBody');
        if (body) {
            body.innerHTML = cards.length
                ? `<div class="mi-pickgrid">${cards.join('')}</div>`
                : '<div class="state-block empty"><p>لا توجد خدمة مطابقة. يمكنك إضافة خادم مخصّص بالأسفل.</p></div>';
        }
        document.querySelectorAll('#miPickCats .mi-chip').forEach((b) => {
            b.classList.toggle('active', b.dataset.cat === category);
        });
    };

    openModal(`
      <div class="mi-mhead">
        <div>
          <p class="mi-mtitle">إضافة تكامل</p>
          <p class="mi-msub">اختر الخدمة التي تريد ربطها.</p>
        </div>
        <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
      </div>
      <div class="mi-mbody">
        <input class="mi-input" id="miPickSearch" type="search" placeholder="ابحث عن خدمة…" autocomplete="off">
        <div class="mi-chips" id="miPickCats">
          ${MCP_CATALOG_CATEGORIES.map((c) => `<button type="button" class="mi-chip" data-cat="${esc(c.key)}">${esc(c.label)}</button>`).join('')}
        </div>
        <div id="miPickBody"></div>
      </div>
      <div class="mi-mfoot">
        <button class="mi-btn" data-mi="custom">إضافة خادم MCP مخصّص</button>
        <button class="mi-btn ghost" data-mi-close style="margin-inline-start:auto">إلغاء</button>
      </div>`);

    render();
    const search = document.getElementById('miPickSearch');
    search?.addEventListener('input', (e) => { query = e.target.value; render(); });
    document.getElementById('miPickCats')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.mi-chip');
        if (!btn) return;
        category = btn.dataset.cat;
        render();
    });
    search?.focus();
}

function pickerCard({ key, serverId, name, desc, color, glyph, already }) {
    const attrs = already
        ? 'disabled'
        : key ? `data-mi="pick" data-key="${esc(key)}"` : `data-mi="pick-server" data-id="${esc(serverId)}"`;
    return `<button type="button" class="mi-pick" ${attrs}>
        <span class="mi-logo" style="background:${esc(color || '#666')}">${glyph}</span>
        <span class="mi-pick-txt">
            <span class="mi-pick-n">${esc(name)}${already ? ' <span class="mi-badge-soon">مربوط</span>' : ''}</span>
            <span class="mi-pick-d">${esc(desc || '')}</span>
        </span>
    </button>`;
}

/* ══════════════════ مسار الربط ══════════════════ */

/** ما الذي تحتاجه هذه الخدمة فعلًا من المستخدم؟ أقل شيء ممكن. */
function credentialAsk(entry, server) {
    const auth = entry.auth_type || 'none';
    const serviceKey = entry.key;

    if (auth === 'oauth2') {
        // لو تطبيق OAuth مسجَّل بالفعل **وقيمته صالحة**، فلا شيء يُطلب إطلاقًا.
        // شرط الصلاحية ليس زائدًا: اتصال حُفظ بمعرّف خاطئ كان سيتخطّى السؤال
        // إلى الأبد، فيعيد المستخدم المحاولة كل مرة على نفس القيمة المكسورة
        // بلا أي طريق لتصحيحها من هذه الواجهة.
        if (server?.oauth_client_id && !validateCredential(serviceKey, 'oauth_client_id', server.oauth_client_id)) return null;
        const uuidish = entry.key === 'supabase';
        return {
            kind: 'oauth_app',
            serviceKey,
            title: 'هذه الخدمة تحتاج تطبيق OAuth خاص بك',
            hint: entry.setup_note || 'سجّل تطبيق OAuth من لوحة الخدمة، ثم الصق المعرّف والسر هنا. لن نطلبهما مرة أخرى.',
            fields: [
                {
                    id: 'miOauthId', name: 'oauth_client_id', label: 'Client ID', type: 'text',
                    // الشكل المتوقّع معروض في الحقل نفسه: أرخص وسيلة لمنع لصق
                    // رابط المشروع مكان معرّف التطبيق.
                    placeholder: uuidish ? '123e4567-e89b-12d3-a456-426614174000' : 'معرّف التطبيق كما تعرضه الخدمة',
                },
                { id: 'miOauthSecret', name: 'oauth_client_secret', label: 'Client Secret', type: 'password', placeholder: 'السر الذي عرضته الخدمة مرة واحدة' },
            ],
        };
    }
    if (auth === 'bearer') {
        return {
            kind: 'bearer',
            serviceKey,
            title: 'الصق رمز الوصول',
            hint: entry.setup_note || 'أنشئ رمز وصول شخصيًا من إعدادات الخدمة والصقه هنا.',
            fields: [{ id: 'miBearer', name: 'bearer_token', label: 'رمز الوصول (Access Token)', type: 'password', placeholder: 'الرمز نفسه، لا رابط الصفحة' }],
        };
    }
    if (auth === 'api_key') {
        return {
            kind: 'api_key',
            serviceKey,
            title: 'الصق مفتاح API',
            hint: entry.setup_note || 'انسخ المفتاح من إعدادات الخدمة.',
            fields: [{ id: 'miApiKey', name: 'api_key', label: 'API Key', type: 'password', placeholder: 'المفتاح نفسه، لا رابط الصفحة' }],
        };
    }
    return null; // none/custom عبر المسار المتقدّم
}

/**
 * يعرض خطأ كل حقل تحته ويعيد true فقط لو كانت كل القيم مقبولة.
 * @returns {boolean}
 */
function showFieldErrors(ask, values) {
    let firstBad = null;
    for (const f of ask.fields) {
        const msg = validateCredential(ask.serviceKey, f.name, values[f.id]);
        const slot = document.getElementById(`${f.id}Err`);
        const input = document.getElementById(f.id);
        if (slot) {
            slot.textContent = msg || '';
            slot.hidden = !msg;
        }
        input?.classList.toggle('is-bad', Boolean(msg));
        if (msg && !firstBad) firstBad = input;
    }
    firstBad?.focus();
    return !firstBad;
}

function typeChooserHtml() {
    return `<div class="mi-choice" id="miType">
        <label class="mi-opt" data-selected="1" data-value="personal">
            <input type="radio" name="miTypeRadio" value="personal" checked>
            <div>
                <div class="mi-opt-t">شخصي</div>
                <div class="mi-opt-d">أنت وحدك من يستطيع استخدام هذا الاتصال.</div>
            </div>
        </label>
        <label class="mi-opt" data-value="shared" data-disabled="1" title="يحتاج تنفيذ الصلاحيات في الـbackend">
            <input type="radio" name="miTypeRadio" value="shared" disabled>
            <div>
                <div class="mi-opt-t">مشترك <span class="mi-badge-soon">غير مفعّل بعد</span></div>
                <div class="mi-opt-d">
                    يستخدمه من تصرّح لهم في الشركة بأدوارهم أو بأسمائهم.
                    التصميم جاهز، لكن فرض الصلاحيات يحتاج خطوة قاعدة بيانات لم تُنفَّذ بعد —
                    فلا نعرضه كأنه يعمل.
                </div>
            </div>
        </label>
    </div>`;
}

function connectFlow(catalogKey) {
    const entry = MCP_CLIENT_CATALOG.find((c) => c.key === catalogKey);
    if (!entry) return;

    const server = findConnectedServerForCatalogEntry(entry, servers);
    const ask = credentialAsk(entry, server);

    const fieldsHtml = ask
        ? `<div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--color-border,#eee)">
             <div class="mi-label" style="margin-bottom:.5rem">${esc(ask.title)}</div>
             ${ask.fields.map((f) => `
               <div class="mi-field">
                 <label class="mi-label" for="${f.id}">${esc(f.label)}</label>
                 <input class="mi-input" id="${f.id}" type="${f.type}" dir="ltr" autocomplete="off"
                        placeholder="${esc(f.placeholder || '')}" aria-describedby="${f.id}Err">
                 <p class="mi-fielderr" id="${f.id}Err" hidden></p>
               </div>`).join('')}
             <div class="mi-hint">${esc(ask.hint)}${entry.docs_url ? ` <a href="${esc(entry.docs_url)}" target="_blank" rel="noopener">فتح التوثيق ↗</a>` : ''}</div>
           </div>`
        : `<div class="mi-note">لن نطلب منك أي إعداد تقني. سنفتح لك صفحة ${esc(entry.name)} لتوافق، ثم نكتشف الأدوات تلقائيًا.</div>`;

    openModal(`
      <div class="mi-mhead">
        <div class="mi-logo" style="background:${esc(entry.brandColor || '#666')}">${iconMarkup(entry)}</div>
        <div>
          <p class="mi-mtitle">ربط ${esc(entry.name)}</p>
          <p class="mi-msub">من يستطيع استخدام هذا الاتصال؟</p>
        </div>
        <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
      </div>
      <div class="mi-mbody">
        ${typeChooserHtml()}
        ${fieldsHtml}
      </div>
      <div class="mi-mfoot">
        <button class="mi-btn primary" id="miGo">متابعة الربط</button>
        <button class="mi-btn" data-mi-close>إلغاء</button>
      </div>`);

    document.getElementById('miGo').addEventListener('click', () => runConnect(entry, ask));
}

/**
 * ينفّذ الربط فعليًا عبر دوال mcp-service القائمة:
 * إنشاء الخادم (إن لزم) ← حفظ الاعتماد ← إما تحويل OAuth أو اكتشاف مباشر.
 */
async function runConnect(entry, ask) {
    const values = {};
    (ask?.fields || []).forEach((f) => { values[f.id] = document.getElementById(f.id)?.value?.trim() || ''; });

    // نفحص قبل أن نرسل المستخدم إلى المزوّد: قيمة خاطئة تُرفض هناك برسالة
    // إنجليزية على صفحة أخرى، بعد أن يكون قد غادر المنصّة.
    if (ask && !showFieldErrors(ask, values)) return;

    const steps = ask?.kind === 'oauth_app' || entry.auth_type === 'oauth2'
        ? ['نحفظ الإعداد', 'نفتح صفحة التفويض']
        : ['نحفظ الإعداد', 'نتصل بالخدمة', 'نكتشف الأدوات'];

    openModal(`
      <div class="mi-mhead">
        <div class="mi-logo" style="background:${esc(entry.brandColor || '#666')}">${iconMarkup(entry)}</div>
        <div><p class="mi-mtitle">ربط ${esc(entry.name)}</p><p class="mi-msub" id="miStepMsg">جارٍ التنفيذ…</p></div>
      </div>
      <div class="mi-mbody">
        <ul class="mi-steps" id="miSteps">
          ${steps.map((s, i) => `<li data-state="${i === 0 ? 'doing' : 'wait'}"><span class="mi-ic">${i + 1}</span><span>${esc(s)}</span></li>`).join('')}
        </ul>
      </div>`);

    const mark = (i, state) => {
        const li = document.getElementById('miSteps')?.children[i];
        if (!li) return;
        li.dataset.state = state;
        if (state === 'done') li.querySelector('.mi-ic').textContent = '✓';
        if (state === 'fail') li.querySelector('.mi-ic').textContent = '!';
        const next = document.getElementById('miSteps')?.children[i + 1];
        if (state === 'done' && next) next.dataset.state = 'doing';
    };

    let serverId = findConnectedServerForCatalogEntry(entry, servers)?.id || null;

    try {
        // 1) تعريف الخادم — يُنشأ مرة واحدة فقط لكل خدمة.
        if (!serverId) {
            const created = await createServer({
                name: entry.name,
                transport: entry.transport || 'streamable_http',
                url: entry.url || '',
                description: entry.description || '',
                category: entry.category || 'general',
                connector_type: entry.connector_type === 'oauth_connector' ? 'oauth_connector' : 'mcp_server',
                enabled: true,
            });
            serverId = created.id;
        }

        // 2) الاعتماد — يُرسل مرة واحدة ولا يُقرأ مرة أخرى أبدًا.
        const creds = { auth_type: entry.auth_type || 'none' };
        if (ask?.kind === 'oauth_app') {
            creds.oauth_client_id = values.miOauthId;
            creds.oauth_client_secret = values.miOauthSecret;
            creds.oauth_authorize_url = entry.oauth_authorize_url || '';
            creds.oauth_token_url = entry.oauth_token_url || '';
            creds.oauth_scope = entry.oauth_scope || '';
        } else if (ask?.kind === 'bearer') {
            creds.bearer_token = values.miBearer;
        } else if (ask?.kind === 'api_key') {
            creds.api_key = values.miApiKey;
        }
        await saveCredentials(serverId, creds);
        mark(0, 'done');

        // 3a) OAuth: نحوّل المتصفح. اكتشاف الأدوات يحدث عند العودة
        //     (يتكفّل به مضيف الصفحة عبر finishOAuthReturn أدناه).
        if ((entry.auth_type || 'none') === 'oauth2') {
            const { authorize_url } = await startOAuth(serverId);
            window.location.href = authorize_url;
            return;
        }

        // 3b) غير OAuth: نتصل ونكتشف الأدوات في نفس الدورة.
        const result = await testServer(serverId);
        mark(1, result.ok ? 'done' : 'fail');
        if (!result.ok) throw new Error(result.message || 'فشل الاتصال');
        mark(2, 'done');

        await onChanged();
        showConnected(entry, serverId);
    } catch (err) {
        const info = explainError(err?.message);
        openModal(`
          <div class="mi-mhead">
            <div class="mi-logo" style="background:${esc(entry.brandColor || '#666')}">${iconMarkup(entry)}</div>
            <div><p class="mi-mtitle">${esc(entry.name)}</p><p class="mi-msub">لم يكتمل الربط</p></div>
            <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
          </div>
          <div class="mi-mbody">
            <div class="mi-err">
              <p class="mi-err-t">${esc(info.title)}</p>
              <p class="mi-err-m">${esc(info.message)}</p>
            </div>
            <details class="mi-details"><summary>عرض التفاصيل التقنية</summary><pre>${esc(info.detail)}</pre></details>
          </div>
          <div class="mi-mfoot">
            <button class="mi-btn primary" data-mi="connect" data-key="${esc(entry.key)}">${esc(info.action)}</button>
            <button class="mi-btn" data-mi-close>إغلاق</button>
          </div>`);
        await onChanged();
    }
}

function showConnected(entry, serverId) {
    const server = servers.find((s) => s.id === serverId);
    const count = Array.isArray(server?.tools) ? server.tools.length : 0;
    openModal(`
      <div class="mi-mhead">
        <div class="mi-logo" style="background:${esc(entry.brandColor || '#666')}">${iconMarkup(entry)}</div>
        <div><p class="mi-mtitle">تم الربط ✓</p><p class="mi-msub">${esc(entry.name)} جاهز للاستخدام.</p></div>
        <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
      </div>
      <div class="mi-mbody">
        <div class="mi-rows">
          <div class="mi-row"><span class="mi-k">الحالة</span><span class="mi-v">${statePill(UI_STATES.CONNECTED)}</span></div>
          <div class="mi-row"><span class="mi-k">النوع</span><span class="mi-v">شخصي</span></div>
          <div class="mi-row"><span class="mi-k">الأدوات</span><span class="mi-v">${count} أداة مكتشفة</span></div>
        </div>
        <div class="mi-note">اكتُشفت الأدوات تلقائيًا ضمن دورة الربط.</div>
      </div>
      <div class="mi-mfoot">
        <button class="mi-btn primary" data-mi="detail" data-id="${esc(serverId)}">عرض الأدوات</button>
        <button class="mi-btn" data-mi-close>تم</button>
      </div>`);
}

/* ══════════════════ لوحة التفاصيل ══════════════════ */

function detailPanel(serverId) {
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    const entry = MCP_CLIENT_CATALOG.find((c) => c.name === server.name) || {};
    const state = deriveUiState(server);
    const tools = Array.isArray(server.tools) ? server.tools : [];

    openModal(`
      <div class="mi-mhead">
        <div class="mi-logo" style="background:${esc(entry.brandColor || '#666')}">${iconMarkup(entry)}</div>
        <div><p class="mi-mtitle">${esc(server.name)}</p><p class="mi-msub">إدارة الاتصال</p></div>
        <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
      </div>
      <div class="mi-mbody">
        <div class="mi-rows">
          <div class="mi-row"><span class="mi-k">الحالة</span><span class="mi-v">${statePill(state)}</span></div>
          <div class="mi-row"><span class="mi-k">الخدمة</span><span class="mi-v">${esc(server.name)}</span></div>
          <div class="mi-row"><span class="mi-k">النوع</span><span class="mi-v">شخصي</span></div>
          <div class="mi-row"><span class="mi-k">طريقة الدخول</span><span class="mi-v">${esc(authLabel(server.auth_type))}</span></div>
          <div class="mi-row"><span class="mi-k">الأدوات</span><span class="mi-v">${tools.length} أداة</span></div>
          <div class="mi-row"><span class="mi-k">آخر اتصال</span><span class="mi-v">${esc(relTime(server.last_checked_at))}</span></div>
        </div>

        ${tools.length ? `<div class="mi-tools">${tools.map((t) => `
          <div class="mi-tool">
            <input type="checkbox" ${t.enabled === false ? '' : 'checked'}
                   data-mi="toggle" data-conn="${esc(server.connection_id)}" data-tool="${esc(t.name)}"
                   aria-label="تفعيل ${esc(t.name)}">
            <span class="mi-tool-n">${esc(t.name)}</span>
            <span class="mi-tool-d">${esc(t.description || '')}</span>
          </div>`).join('')}</div>`
          : '<div class="mi-note">لا أدوات مكتشفة بعد. جرّب «اختبار الاتصال».</div>'}

        <details class="mi-details">
          <summary>إعدادات متقدّمة</summary>
          <pre>${esc(JSON.stringify({
              transport: server.transport,
              url: server.url,
              connector_type: server.connector_type,
              auth_type: server.auth_type,
              status: server.status,
              last_error: server.last_error || null,
          }, null, 2))}</pre>
          <div class="mi-hint">للتحكّم الكامل — الرابط، نوع النقل، الترويسات، متغيّرات البيئة، أوامر التشغيل — افتح الإعدادات الكاملة.</div>
          <button class="mi-btn" data-mi="edit" data-id="${esc(server.id)}" style="margin-top:.6rem">فتح الإعدادات الكاملة</button>
        </details>
      </div>
      <div class="mi-mfoot">
        <button class="mi-btn" data-mi="test" data-id="${esc(server.id)}">اختبار الاتصال</button>
        ${state === UI_STATES.AUTH_REQUIRED || state === UI_STATES.ERROR
            ? `<button class="mi-btn" data-mi="authorize" data-id="${esc(server.id)}">إعادة الربط</button>` : ''}
        <button class="mi-btn ghost danger" data-mi="disconnect" data-id="${esc(server.id)}" style="margin-inline-start:auto">فصل</button>
      </div>`);
}

function errorPanel(serverId) {
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;
    const entry = MCP_CLIENT_CATALOG.find((c) => c.name === server.name) || {};
    const info = explainError(server.last_error);

    openModal(`
      <div class="mi-mhead">
        <div class="mi-logo" style="background:${esc(entry.brandColor || '#666')}">${iconMarkup(entry)}</div>
        <div><p class="mi-mtitle">${esc(server.name)}</p><p class="mi-msub">آخر محاولة: ${esc(relTime(server.last_checked_at))}</p></div>
        <button class="mi-x" data-mi-close aria-label="إغلاق">&times;</button>
      </div>
      <div class="mi-mbody">
        <div class="mi-err">
          <p class="mi-err-t">${esc(info.title)}</p>
          <p class="mi-err-m">${esc(info.message)}</p>
        </div>
        <details class="mi-details"><summary>عرض التفاصيل التقنية</summary><pre>${esc(info.detail)}</pre></details>
      </div>
      <div class="mi-mfoot">
        <button class="mi-btn primary" data-mi="authorize" data-id="${esc(server.id)}">${esc(info.action)}</button>
        <button class="mi-btn" data-mi="detail" data-id="${esc(server.id)}">تفاصيل الاتصال</button>
      </div>`);
}

/* ══════════════════ الإجراءات ══════════════════ */

async function doTest(serverId) {
    busy.add(serverId);
    await onChanged();
    try {
        const result = await testServer(serverId);
        if (result.ok) {
            toast(`تم الاتصال — ${result.tools ?? 0} أداة`, 'success');
        } else {
            toast(explainError(result.message).title, 'error');
        }
    } catch (err) {
        toast(explainError(err?.message).title, 'error');
    } finally {
        busy.delete(serverId);
        await onChanged();
    }
}

async function doAuthorize(serverId) {
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    // OAuth بإعداد محفوظ صالح: نذهب مباشرة لصفحة الموافقة. لو كان المحفوظ
    // مكسورًا نسقط إلى مسار الربط أدناه ليُسأل عنه من جديد.
    const entryForServer = MCP_CLIENT_CATALOG.find((c) => c.name === server.name);
    const storedIdOk = server.oauth_client_id
        && !validateCredential(entryForServer?.key, 'oauth_client_id', server.oauth_client_id);
    if (server.auth_type === 'oauth2' && storedIdOk) {
        try {
            const { authorize_url } = await startOAuth(serverId);
            window.location.href = authorize_url;
            return;
        } catch (err) {
            toast(explainError(err?.message).title, 'error');
            return;
        }
    }

    // غير ذلك: نعيد فتح مسار الربط لنطلب ما ينقص أو ما يحتاج تصحيحًا.
    if (entryForServer) connectFlow(entryForServer.key);
    else doTest(serverId);
}

async function doDisconnect(serverId) {
    const server = servers.find((s) => s.id === serverId);
    if (!confirm(`فصل ${server?.name || 'هذا الاتصال'}؟ بيانات الدخول المحفوظة ستتوقف عن العمل.`)) return;
    try {
        await disconnectServer(serverId);
        toast('تم الفصل', 'success');
        closeModal();
        await onChanged();
    } catch (err) {
        toast(err?.message || 'تعذّر الفصل', 'error');
    }
}

async function doToggleTool(connectionId, toolName, enabled) {
    try {
        await setToolEnabled(connectionId, toolName, enabled);
        await onChanged();
    } catch (err) {
        toast(err?.message || 'تعذّر تحديث الأداة', 'error');
    }
}

/* ══════════════════ الأحداث ══════════════════ */

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-mi]');
    if (!el) return;
    const act = el.dataset.mi;
    if (act === 'toggle') return; // يُعالَج في change لا click

    e.preventDefault();
    const id = el.dataset.id;
    if (act === 'edit') {
        // التعديل الكامل يبقى للنموذج المتقدّم القائم — لا نكرّر 21 حقلًا هنا.
        closeModal();
        if (typeof window.mcpEdit === 'function') window.mcpEdit(id);
        else toast('النموذج المتقدّم غير متاح في هذه الصفحة', 'error');
    } else if (act === 'add') openServicePicker();
    else if (act === 'pick') { closeModal(); connectFlow(el.dataset.key); }
    else if (act === 'pick-server') {
        // تعريف خادم موجود بلا اتصال لهذا المستخدم: نحاول الاتصال مباشرة.
        // ما ينقص من اعتماد يظهر كحالة «يحتاج تفويض» على بطاقته بعدها.
        closeModal();
        doTest(el.dataset.id);
    } else if (act === 'custom') {
        // الإعداد اليدوي يبقى مسؤولية النموذج المتقدّم القائم كما هو.
        closeModal();
        if (typeof window.mcpAdd === 'function') window.mcpAdd();
        else toast('النموذج المتقدّم غير متاح في هذه الصفحة', 'error');
    } else if (act === 'connect') connectFlow(el.dataset.key);
    else if (act === 'detail') detailPanel(id);
    else if (act === 'error') errorPanel(id);
    else if (act === 'test') doTest(id);
    else if (act === 'authorize') doAuthorize(id);
    else if (act === 'disconnect') doDisconnect(id);
});

document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-mi="toggle"]');
    if (!el) return;
    doToggleTool(el.dataset.conn, el.dataset.tool, el.checked);
});

// اختيار النوع داخل نافذة الربط
document.addEventListener('click', (e) => {
    const opt = e.target.closest('#miType .mi-opt');
    if (!opt || opt.dataset.disabled === '1') return;
    opt.parentElement.querySelectorAll('.mi-opt').forEach((o) => o.removeAttribute('data-selected'));
    opt.setAttribute('data-selected', '1');
    const radio = opt.querySelector('input');
    if (radio) radio.checked = true;
});

/* ══════════════════ العودة من OAuth ══════════════════ */

/**
 * يُستدعى من mcp.js بعد عودة المتصفح من مزوّد OAuth بنجاح.
 *
 * هذه هي الخطوة التي كانت ناقصة: الـcallback يضع الحالة «متصل» ثم يعيد
 * التوجيه، فيبقى عدد الأدوات صفرًا حتى يضغط المستخدم «اختبار» يدويًا.
 * هنا نشغّل الاكتشاف فورًا ضمن نفس الدورة — بلا أي تعديل في الـEdge Function.
 *
 * @param {string} serverId
 */
export async function finishOAuthReturn(serverId) {
    if (!serverId) return;
    busy.add(serverId);
    await onChanged();
    try {
        const result = await testServer(serverId);
        if (result.ok) toast(`تم الربط — ${result.tools ?? 0} أداة متاحة`, 'success');
        else toast(explainError(result.message).title, 'error');
    } catch (err) {
        toast(explainError(err?.message).title, 'error');
    } finally {
        busy.delete(serverId);
        await onChanged();
    }
}

/* يتيح لـmcp.js استدعاء الوحدة دون استيراد دائري. */
window.mcpIntegrations = { renderIntegrations, openServicePicker, finishOAuthReturn, deriveUiState, explainError };
