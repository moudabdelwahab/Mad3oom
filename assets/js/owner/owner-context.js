/**
 * owner-context.js — واجهة السياق، وكلها نداءات إلى الخادم.
 *
 * القاعدة التي يلتزم بها هذا الملف حرفيًا:
 *
 *     لا يُشتق أي قرار سلطة في المتصفح. يُسأل الخادم، ويُعرَض جوابه.
 *
 * فلا قائمة سياقات مكتوبة هنا، ولا شرط «هل يستحق؟»، ولا تخزين للسياق في
 * localStorage أو cookie أو query-parameter. السياق حالة في القاعدة، وكل ما
 * تفعله هذه الوحدة أن تقرأها وتعرضها.
 *
 * ولو تلاعب أحد بهذا الملف في متصفحه فلن يكسب شيئًا: القاعدة تُعيد فحص المنح
 * عند كل استعلام (owner_capability)، فأقصى ما يبلغه أن يرى واجهة تَعِد بما
 * لا تُعطيه — صفحة فارغة، لا بيانات.
 */

import { supabase } from '/api-config.js';

/** السياقات المتاحة كما يحسبها الخادم — خمسة عناصر بـraya granted لكل واحد. */
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
 * ترجع الدالة في القاعدة نتيجة مُهيكَلة عند الرفض بدل استثناء — لأن الاستثناء
 * كان يُلغي صف التدقيق المكتوب قبله بسطر. فنفحص `allowed` هنا صراحةً.
 */
export async function enterContext(key) {
    const { data, error } = await supabase.rpc('enter_context', { p_context: key });
    if (error) throw new Error(error.message);
    if (!data?.allowed) {
        throw new Error(data?.reason === 'grant_missing'
            ? 'لا تملك منح هذا السياق'
            : 'اختيار السياق متاح لمالك المنصة وحده');
    }
    return data;
}

/** الخروج — عودة إلى الحالة المغلقة (لا سياق = لا صلاحية). */
export async function exitContext() {
    const { data, error } = await supabase.rpc('exit_context');
    if (error) throw new Error(error.message);
    return data;
}

const LABELS = {
    owner: 'لوحة المالك',
    admin: 'إدارة المنصة',
    company_admin: 'الشركة — مدير',
    company_user_preview: 'معاينة عضو الشركة',
    customer: 'بوابة العميل'
};

/**
 * شريط السياق الدائم.
 *
 * يُركَّب في كل لوحة يدخلها المالك، فيكون السياق الساري **ظاهرًا دائمًا** لا
 * مستنتَجًا من شكل الصفحة. وبلا هذا الشريط يسهل أن ينسى المالك أنه داخل
 * معاينة للقراءة فقط فيحتار لماذا تُردّ كتاباته.
 *
 * ولا يُركَّب لغير المالك: contextStatus ترجع is_platform_owner=false فنخرج.
 */
export async function mountContextBar() {
    let status;
    try {
        status = await contextStatus();
    } catch {
        return null;
    }
    if (!status?.is_platform_owner) return null;

    document.getElementById('ownerContextBar')?.remove();

    const ctx = status.active_context;
    const preview = status.preview_mode === true;

    const bar = document.createElement('div');
    bar.id = 'ownerContextBar';
    bar.dir = 'rtl';
    bar.style.cssText = `
        position: sticky; top: 0; z-index: 9998;
        display: flex; gap: .75rem; align-items: center; flex-wrap: wrap;
        padding: .55rem 1rem; font: 500 .82rem/1.4 system-ui, -apple-system, sans-serif;
        background: ${preview ? '#7c2d12' : '#0b1220'}; color: #e6edf7;
        border-bottom: 1px solid ${preview ? '#c2410c' : '#1e293b'};
    `;

    const label = document.createElement('span');
    label.textContent = ctx
        ? `أنت داخل سياق: ${LABELS[ctx] || ctx}`
        : 'لا سياق مفعَّل — صلاحياتك معطّلة';
    bar.appendChild(label);

    if (preview) {
        const ro = document.createElement('span');
        ro.textContent = 'قراءة فقط';
        ro.style.cssText = 'padding:.1rem .5rem;border-radius:999px;background:#c2410c;font-size:.72rem;';
        bar.appendChild(ro);
    }

    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1 1 auto;';
    bar.appendChild(spacer);

    const switchBtn = document.createElement('a');
    switchBtn.href = '/owner-contexts.html';
    switchBtn.id = 'ownerSwitchBoardsBtn';
    switchBtn.textContent = 'واجهة اللوحات';
    switchBtn.style.cssText = `
        color:#e6edf7; text-decoration:none; padding:.3rem .8rem;
        border:1px solid #334155; border-radius:.45rem;
    `;
    bar.appendChild(switchBtn);

    const out = document.createElement('button');
    out.type = 'button';
    out.textContent = 'خروج من السياق';
    out.style.cssText = `
        color:#e6edf7; background:transparent; cursor:pointer;
        padding:.3rem .8rem; border:1px solid #334155; border-radius:.45rem;
    `;
    out.addEventListener('click', async () => {
        out.disabled = true;
        try {
            await exitContext();
            window.location.href = '/owner-contexts.html';
        } catch (err) {
            out.disabled = false;
            alert(err.message);
        }
    });
    bar.appendChild(out);

    document.body.insertBefore(bar, document.body.firstChild);
    return bar;
}
