/**
 * page-guard.js — حارس الصفحة الموحّد لكل بوابات المنصة.
 *
 * القاعدة الوحيدة التي يفرضها هذا الملف:
 *
 *     التحويل إلى صفحة الدخول مسموح **فقط** حين لا توجد جلسة.
 *
 * أي حالة أخرى — جلسة سليمة بلا صلاحية، أو حساب موقوف — تُرسم كرسالة في
 * مكانها **بلا أي تنقّل**. ولأن مفيش تنقّل، حلقة التحويل مستحيلة بنيويًا:
 *
 *   قبل:  company-dashboard → صفحة محمية → login → company-dashboard → …
 *   بعد:  company-dashboard → صفحة محمية → رسالة «غير مصرّح» + زر يدوي
 *
 * الأزرار في الرسالة كلها بفعل المستخدم؛ مفيش redirect تلقائي في أي مسار.
 *
 * ملاحظة أمنية: ده حارس **عرض**. الحماية الحقيقية للبيانات في RLS ودوال
 * SECURITY DEFINER في القاعدة، ولا تعتمد على أي شيء هنا.
 */

import { resolveAccess, ACCESS } from '/auth-client.js';
import { accessMessageFor } from '/assets/js/access-policy.js';
import { resolveAccountHome, DESTINATIONS } from '/assets/js/account-destination.js';

const LOGIN_PATH = '/login.html';
const PANEL_ID = 'accessDeniedPanel';

/**
 * حارس صفحة.
 *
 * @param {string|null} requiredRole 'admin' | 'user' | null
 * @param {{ onDenied?: (access) => void }} options
 *        onDenied يسمح للصفحة برسم رفضها بنفسها بدل اللوحة الافتراضية.
 * @returns {Promise<object|null>} المستخدم لو مسموح، وإلا `null` **بعد** أن
 *          يكون الحارس تكفّل بعرض السبب أو التحويل. المستدعي يكتفي بـ`return`.
 */
export async function guardPage(requiredRole = null, options = {}) {
    let access;
    try {
        access = await resolveAccess(requiredRole);
    } catch (err) {
        // فشل غير متوقع (شبكة/تهيئة): ما نحوّلش لصفحة الدخول — الجلسة ممكن
        // تكون سليمة تمامًا، والتحويل هنا هو بالظبط ما كان يصنع الحلقة.
        console.error('[PageGuard] resolveAccess failed:', err?.message || err);
        renderAccessDenied({ status: ACCESS.FORBIDDEN, reason: 'guard-error', user: null }, options);
        return null;
    }

    if (access.status === ACCESS.AUTHORIZED) return access.user;

    // الحالة الوحيدة التي يجوز فيها التحويل إلى صفحة الدخول.
    if (access.status === ACCESS.ANONYMOUS) {
        window.location.replace(LOGIN_PATH);
        return null;
    }

    if (typeof options.onDenied === 'function') {
        options.onDenied(access);
        return null;
    }

    renderAccessDenied(access, options);
    return null;
}

/**
 * لوحة «غير مصرّح» — تحلّ محل محتوى الصفحة بلا أي تنقّل.
 * الأنماط مضمّنة عمدًا: الصفحة قد تكون في قشرة العميل أو قشرة الإدارة،
 * والرسالة لازم تظهر صح في الاتنين بلا اعتماد على ملف أنماط بعينه.
 */
export function renderAccessDenied(access, options = {}) {
    const message = accessMessageFor(access?.reason);

    document.getElementById(PANEL_ID)?.remove();

    const style = document.createElement('style');
    style.textContent = `
        #${PANEL_ID} {
            position: fixed; inset: 0; z-index: 99999;
            display: flex; align-items: center; justify-content: center;
            padding: 1.5rem; background: #0b1220; color: #e6edf7;
            font-family: Cairo, system-ui, -apple-system, sans-serif;
            direction: rtl; text-align: center;
        }
        #${PANEL_ID} .ad-card {
            max-width: 32rem; width: 100%;
            background: #131c2b; border: 1px solid #24314a;
            border-radius: 1rem; padding: 2rem 1.75rem;
            box-shadow: 0 24px 60px rgba(0,0,0,.45);
        }
        #${PANEL_ID} h1 { margin: 0 0 .75rem; font-size: 1.15rem; font-weight: 800; }
        #${PANEL_ID} p  { margin: 0 0 1.5rem; font-size: .95rem; line-height: 1.8; color: #9fb0c9; }
        #${PANEL_ID} .ad-actions { display: flex; flex-wrap: wrap; gap: .625rem; justify-content: center; }
        #${PANEL_ID} button {
            font: inherit; font-weight: 700; cursor: pointer;
            padding: .65rem 1.25rem; border-radius: .625rem; border: 1px solid #24314a;
            background: transparent; color: #e6edf7;
        }
        #${PANEL_ID} button.ad-primary { background: #2f6df6; border-color: #2f6df6; color: #fff; }
        @media (prefers-color-scheme: light) {
            #${PANEL_ID} { background: #eef2f8; color: #16203a; }
            #${PANEL_ID} .ad-card { background: #fff; border-color: #d8e0ec; }
            #${PANEL_ID} p { color: #55637d; }
            #${PANEL_ID} button { border-color: #d8e0ec; color: #16203a; }
        }`;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'alert');

    const card = document.createElement('div');
    card.className = 'ad-card';

    const title = document.createElement('h1');
    title.textContent = message.title;

    const text = document.createElement('p');
    text.textContent = message.text;

    const actions = document.createElement('div');
    actions.className = 'ad-actions';

    // الوجهة الصحيحة لهذا الحساب — زر يدوي، لا تحويل تلقائي.
    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'ad-primary';
    homeBtn.id = 'accessDeniedHome';
    homeBtn.textContent = 'الذهاب إلى لوحتي';
    homeBtn.addEventListener('click', async () => {
        homeBtn.disabled = true;
        window.location.href = await accountHomeFrom(access?.user);
    });

    const outBtn = document.createElement('button');
    outBtn.type = 'button';
    outBtn.id = 'accessDeniedSignOut';
    outBtn.textContent = 'تسجيل الخروج';
    outBtn.addEventListener('click', async () => {
        outBtn.disabled = true;
        try {
            const { logout } = await import('/auth-client.js');
            await logout();
        } catch (err) {
            console.error('[PageGuard] logout failed:', err?.message || err);
        }
        window.location.replace(LOGIN_PATH);
    });

    actions.append(homeBtn, outBtn);
    card.append(title, text, actions);
    panel.append(style, card);
    document.body.appendChild(panel);

    if (options.onRendered) options.onRendered(panel);
    return panel;
}

/** وجهة هذا الحساب الفعلية (نفس قاعدة ما بعد الدخول). */
async function accountHomeFrom(user) {
    try {
        const { supabase } = await import('/api-config.js');
        return await resolveAccountHome(supabase, user?.profile || null);
    } catch (err) {
        console.error('[PageGuard] home lookup failed:', err?.message || err);
        return DESTINATIONS.customer;
    }
}
