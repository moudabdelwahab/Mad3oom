/**
 * owner-context.js — واجهة السياق، وكلها نداءات إلى الخادم.
 *
 * القاعدة التي يلتزم بها هذا الملف حرفيًا:
 *
 *     لا يُشتق أي قرار سلطة في المتصفح. يُسأل الخادم، ويُعرَض جوابه.
 *
 * فلا قائمة سياقات مكتوبة هنا كمصدر، ولا شرط «هل يستحق؟»، ولا تخزين للسياق
 * في localStorage أو cookie أو query-parameter. السياق حالة في القاعدة، وكل
 * ما تفعله هذه الوحدة أن تقرأها وتعرضها.
 *
 * ولو تلاعب أحد بهذا الملف في متصفحه فلن يكسب شيئًا: القاعدة تُعيد فحص المنح
 * عند كل استعلام (owner_capability)، فأقصى ما يبلغه أن يرى واجهة تَعِد بما
 * لا تُعطيه — صفحة فارغة، لا بيانات.
 */

import { supabase } from '/api-config.js';

/**
 * العرض فقط: الاسم والوصف والأيقونة لكل مفتاح سياق.
 *
 * الخادم يظل مصدر **أي** السياقات موجودة و**من** يستحقها (available_contexts).
 * هذه الخريطة لا تقرر شيئًا — لو ظهر مفتاح لا تعرفه، يُعرض بلصيقة الخادم.
 * سبب وجودها أن نصوص الواجهة شأن منتج يتغير بلا ترحيل قاعدة بيانات.
 */
export const CONTEXT_PRESENTATION = {
    owner: {
        name: 'مالك المنصة',
        desc: 'سلطة المنصة والمنح وسجل تبديل السياق.',
        icon: 'owner'
    },
    admin: {
        name: 'الإدارة',
        desc: 'التشغيل اليومي: المستخدمون والتذاكر والاشتراكات والإعدادات.',
        icon: 'admin'
    },
    company_admin: {
        name: 'الشركة',
        desc: 'إدارة شركتك وأعضائها واشتراكها ضمن حدود باقتها.',
        icon: 'company'
    },
    company_user_preview: {
        name: 'الشركة — منظور العضو',
        desc: 'ترى ما يراه عضو شركتك، بلا صلاحيات مالك.',
        icon: 'preview',
        readOnly: true
    },
    customer: {
        name: 'العميل',
        desc: 'بوابتك كعميل: تذاكرك واشتراكاتك وحدها.',
        icon: 'customer'
    }
};

/** السياقات المتاحة كما يحسبها الخادم — مع راية granted لكل واحد. */
export async function loadContexts() {
    const { data, error } = await supabase.rpc('available_contexts');
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data : [];
}

/** حالة السياق الحالية: هل هو مالك؟ أي سياق سارٍ؟ متى ينتهي؟ */
export async function contextStatus() {
    const { data, error } = await supabase.rpc('owner_context_status');
    if (error) throw new Error(error.message);
    return data || {};
}

/**
 * الدخول إلى سياق.
 *
 * الدالة في القاعدة تُرجع نتيجة مُهيكَلة عند الرفض بدل استثناء — لأن الاستثناء
 * كان يُلغي صف التدقيق المكتوب قبله بسطر. فنفحص `allowed` هنا صراحةً.
 */
export async function enterContext(key) {
    const { data, error } = await supabase.rpc('enter_context', { p_context: key });
    if (error) throw new Error(error.message);
    if (!data?.allowed) {
        throw new Error(data?.reason === 'grant_missing'
            ? 'لا تملك منح هذه الواجهة'
            : 'اختيار الواجهة متاح لمالك المنصة وحده');
    }
    return data;
}

/** الخروج — عودة إلى الحالة المغلقة (لا سياق = لا صلاحية). */
export async function exitContext() {
    const { data, error } = await supabase.rpc('exit_context');
    if (error) throw new Error(error.message);
    return data;
}

/* ═══════════════════════════════════════════════════════════════════════════
   مبدّل السياق في الشريط العلوي
   ═══════════════════════════════════════════════════════════════════════════

   يُركَّب في **الشريط العلوي القائم** لا كشريط فوق الصفحة: القشرات الثلاث
   (الإدارة والشركة والعميل) كلها تحمل `.admin-nav > … > .nav-left`، فالحقن
   هناك يجعل المبدّل جزءًا من الواجهة لا شيئًا ملصوقًا عليها.

   وفي لوحة المالك يوجد الزر في ملف القائمة أصلًا (#contextSwitchBtn)، فنصله
   بدل أن نحقن ثانيًا — فلا يتكرر عنصر تنقّل.
   ═══════════════════════════════════════════════════════════════════════════ */

const STYLESHEET = '/assets/css/owner-dashboard.css';

/** صفحات الإدارة لا تُحمّل نظام التصميم، فنضمن ورقة الأنماط قبل الحقن. */
function ensureStylesheet() {
    if (document.querySelector(`link[href="${STYLESHEET}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLESHEET;
    document.head.appendChild(link);
}

const ICONS = {
    owner:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 12 2 2 4-4"></path>',
    admin:    '<rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect>',
    company:  '<path d="M3 21h18"></path><path d="M5 21V7l8-4v18"></path><path d="M19 21V11l-6-4"></path>',
    preview:  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>',
    customer: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
    grid:     '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>'
};

const svg = (name, size = 16) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" stroke="currentColor" stroke-width="2"
          fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.grid}</svg>`;

/** الزر: إمّا الموجود في قائمة المالك، وإمّا محقون في الشريط العلوي. */
function resolveSwitcher() {
    const existing = document.getElementById('contextSwitchBtn');
    if (existing) {
        return {
            btn: existing,
            menu: document.getElementById('contextSwitchMenu'),
            label: document.getElementById('contextSwitchLabel'),
            current: document.getElementById('contextMenuCurrent'),
            list: document.getElementById('contextMenuList')
        };
    }

    const navLeft = document.querySelector('.admin-nav .nav-left');
    if (!navLeft) return null;

    document.getElementById('ctxSwitchWrap')?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'portal-menu-wrap ctx-wrap';
    wrap.id = 'ctxSwitchWrap';
    wrap.innerHTML = `
        <button type="button" class="nav-btn context-switch-btn" id="contextSwitchBtn"
                aria-haspopup="true" aria-expanded="false" aria-label="تبديل الواجهة">
            ${svg('grid', 17)}
            <span class="context-switch-label" id="contextSwitchLabel">الواجهة</span>
        </button>
        <div class="portal-menu portal-menu-context" id="contextSwitchMenu" role="menu" hidden>
            <div class="portal-menu-head">
                <span class="portal-menu-name">الواجهة الحالية</span>
                <span class="portal-menu-email" id="contextMenuCurrent">—</span>
            </div>
            <div id="contextMenuList"></div>
        </div>`;
    navLeft.insertBefore(wrap, navLeft.firstChild);

    return {
        btn: wrap.querySelector('#contextSwitchBtn'),
        menu: wrap.querySelector('#contextSwitchMenu'),
        label: wrap.querySelector('#contextSwitchLabel'),
        current: wrap.querySelector('#contextMenuCurrent'),
        list: wrap.querySelector('#contextMenuList')
    };
}

/** شريط المعاينة: تذكير دائم بأن الكتابة مغلقة، فلا يحتار المستخدم عند الرفض. */
function renderPreviewStrip(active) {
    document.getElementById('ctxPreviewStrip')?.remove();
    if (active !== 'company_user_preview') return;

    const host = document.querySelector('main') || document.body;
    const strip = document.createElement('div');
    strip.id = 'ctxPreviewStrip';
    strip.className = 'preview-strip';
    strip.innerHTML = `${svg('preview', 15)}<span>أنت في منظور عضو الشركة — العرض للقراءة فقط.</span>`;
    host.insertBefore(strip, host.firstChild);
}

/**
 * يركّب مبدّل الواجهات.
 *
 * يخرج صامتًا لغير مالك المنصة: contextStatus تسأل الخادم أولًا، فلا يرى أي
 * حساب آخر أثرًا لهذه الآلية. ولا يُسقط الصفحة إن فشل النداء.
 */
export async function mountContextBar() {
    let status;
    try {
        status = await contextStatus();
    } catch {
        return null;
    }
    if (!status?.is_platform_owner) return null;

    ensureStylesheet();
    const ui = resolveSwitcher();
    if (!ui?.btn) return null;

    const active = status.active_context;
    const p = CONTEXT_PRESENTATION[active] || {};
    ui.label.textContent = p.name || 'اختر واجهة';
    if (ui.current) ui.current.textContent = p.name || 'لا واجهة مفعّلة';
    ui.btn.setAttribute('title', `أنت تستخدم: ${p.name || 'لا واجهة'}`);

    renderPreviewStrip(active);

    let contexts = [];
    try {
        contexts = await loadContexts();
    } catch { /* القائمة تبقى فارغة، والزر يعرض الحالة وحدها */ }

    ui.list.innerHTML = '';
    for (const c of contexts) {
        const pres = CONTEXT_PRESENTATION[c.key] || {};
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'portal-menu-item';
        item.setAttribute('role', 'menuitem');
        if (c.key === active) item.setAttribute('aria-current', 'true');
        item.disabled = c.granted !== true;
        item.innerHTML = `
            <span class="context-mi-icon">${svg(pres.icon, 15)}</span>
            <span></span>
            ${pres.readOnly ? '<span class="context-mi-preview">قراءة فقط</span>' : ''}`;
        item.querySelector('span:nth-child(2)').textContent = pres.name || c.label || c.key;

        item.addEventListener('click', async () => {
            if (c.key === active) { window.location.href = c.destination; return; }
            item.disabled = true;
            try {
                const res = await enterContext(c.key);
                window.location.href = res.destination;
            } catch (err) {
                item.disabled = false;
                console.error('[OwnerContext] enter_context failed:', err.message);
                window.location.href = '/owner-contexts.html';
            }
        });
        ui.list.appendChild(item);
    }

    const all = document.createElement('a');
    all.className = 'portal-menu-item';
    all.setAttribute('role', 'menuitem');
    all.href = '/owner-contexts.html';
    all.innerHTML = `<span class="context-mi-icon">${svg('grid', 15)}</span><span>واجهة اللوحات</span>`;
    ui.list.appendChild(all);

    // الفتح والإغلاق: نفس سلوك بقية القوائم في الشريط (نقر خارجها يغلقها).
    const toggle = (force) => {
        const open = force ?? ui.menu.hidden;
        ui.menu.hidden = !open;
        ui.btn.setAttribute('aria-expanded', String(open));
    };
    ui.btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', (e) => {
        if (!ui.menu.hidden && !ui.menu.contains(e.target) && e.target !== ui.btn) toggle(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });

    return ui.btn;
}
