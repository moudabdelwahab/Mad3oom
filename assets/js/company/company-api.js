/**
 * company-api.js — قسم API داخل لوحة الشركة.
 *
 * القسم ده مبني على ما تسمح به البنية الحالية فعلًا، لا على نظام موازٍ.
 * قراءة السياسات على الإنتاج أعطت التصميم كاملًا:
 *
 *   api_tokens
 *     SELECT  auth.uid() = user_id  OR  is_admin() OR is_owner_or_super_of(user_id)
 *     UPDATE  auth.uid() = user_id  OR  is_admin() OR is_owner_or_super_of(user_id)
 *     DELETE  auth.uid() = user_id  OR  is_admin() OR is_owner_or_super_of(user_id)
 *     INSERT  **لا توجد سياسة** ← لا أحد يُنشئ مفتاحًا من العميل إطلاقًا
 *
 *   is_owner_or_super_of(x) = (auth.uid() = x) OR (x.super_user_id = auth.uid())
 *   أي «أنا أو عضو في شركتي» — نطاق الشركة مُنفَّذ في القاعدة أصلًا.
 *
 * وبناءً عليه:
 *   • الشركة **ترى** مفاتيحها ومفاتيح أعضائها.       ← مدعوم
 *   • الشركة **توقف/تفعّل** المفتاح، و**تسحبه**.      ← مدعوم
 *   • الشركة **لا تُنشئ** مفتاحًا ولا تُدوّره.        ← غير مدعوم في البنية،
 *     فالمسار الصحيح هو طلب من الدعم، وهو موجود: تذكرة. لا نخترع مسارًا.
 *
 * السرّ: العمود secret_hash لا يُقرأ هنا إطلاقًا، ولا يُعرض. المعروض هو
 * api_key (المعرّف العلني) وآخر أربع خانات فقط — نفس ما تعرضه بوابة العميل.
 * credentials_encrypted في التكاملات لا يُقرأ ولا يُعرض بأي حال.
 */

import { supabase } from '/api-config.js';
import { fetchApiTokens, fetchApiUsage } from '/assets/js/customer/customer-data.js';
import { escapeHtml, formatDate, timeAgo, renderState, renderSkeletonLines }
    from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

let container = null;
let onRequestKey = null;
let members = [];

export function initCompanyApi({ onRequestNewKey } = {}) {
    container = document.getElementById('companyApi');
    onRequestKey = onRequestNewKey || null;
}

/** أسماء الأعضاء لعرض «مفتاح مَن» — تُمرَّر من اللوحة، بلا استعلام إضافي. */
export function setCompanyApiMembers(list) {
    members = Array.isArray(list) ? list : [];
}

function ownerLabel(userId, selfId) {
    if (userId === selfId) return 'حساب الشركة';
    const member = members.find(m => m.id === userId);
    return member ? (member.name || member.email || 'عضو') : 'عضو في الشركة';
}

/** حالة المفتاح كما تُقرأ من الصف — لا اجتهاد في الواجهة. */
export function tokenState(token, now = Date.now()) {
    if (token?.revoked_at) return { key: 'revoked', label: 'مسحوب', tone: 'danger' };
    if (token?.is_active === false) return { key: 'disabled', label: 'موقوف', tone: 'neutral' };
    if (token?.expires_at && new Date(token.expires_at).getTime() <= now) {
        return { key: 'expired', label: 'منتهٍ', tone: 'warning' };
    }
    return { key: 'active', label: 'فعّال', tone: 'success' };
}

export async function loadCompanyApi({ selfId } = {}) {
    if (!container) return;
    renderSkeletonLines(container, 4);

    // الاستحقاق: نقرأ ما تسمح به القاعدة. لو رجعت فارغة فالحساب بلا مفاتيح،
    // وهذه حالة لا خطأ.
    const [tokensRes, usageRes] = await Promise.all([
        fetchCompanyScopedTokens(),
        fetchApiUsage(15)
    ]);

    if (!tokensRes.ok) {
        renderState(container, {
            variant: 'error',
            title: 'تعذّر تحميل بيانات API',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'api', variant: 'btn-primary' }
        });
        return;
    }

    const tokens = tokensRes.data || [];
    const usage = usageRes.ok ? (usageRes.data || []) : [];
    const active = tokens.filter(t => tokenState(t).key === 'active');
    const calls = tokens.reduce((sum, t) => sum + (Number(t.usage_count) || 0), 0);

    container.innerHTML = `
        <div class="kpi-grid">
            <div class="kpi ${active.length ? 'kpi--success' : ''}">
                <p class="kpi-label">مفاتيح فعّالة</p>
                <p class="kpi-value">${active.length}</p>
                <p class="kpi-hint">من ${tokens.length} مفتاحًا على حساب الشركة وأعضائها</p>
            </div>
            <div class="kpi">
                <p class="kpi-label">إجمالي النداءات</p>
                <p class="kpi-value">${calls}</p>
                <p class="kpi-hint">محسوبة على كل المفاتيح</p>
            </div>
            <div class="kpi">
                <p class="kpi-label">آخر استخدام</p>
                <p class="kpi-value">${escapeHtml(lastUsedLabel(tokens))}</p>
                <p class="kpi-hint">أحدث نداء موثّق</p>
            </div>
        </div>

        <section class="panel" aria-labelledby="companyKeysHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyKeysHeading">مفاتيح API</h2>
                    <p class="panel-subtitle">
                        السرّ لا يُعرض أبدًا — لا عند الإنشاء ولا بعده. المعروض هو المعرّف العلني وآخر أربع خانات.
                    </p>
                </div>
                <button type="button" class="panel-link" id="companyRequestKey">طلب مفتاح جديد</button>
            </div>
            <div id="companyKeysList"></div>
        </section>

        <section class="panel" aria-labelledby="companyApiUsageHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyApiUsageHeading">آخر النداءات</h2>
                    <p class="panel-subtitle">سجل تدقيق لآخر ما نُفِّذ بمفاتيح هذا الحساب</p>
                </div>
            </div>
            <div id="companyApiUsage"></div>
        </section>

        <section class="panel" aria-labelledby="companyApiGuideHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyApiGuideHeading">كيف تستخدم المفتاح</h2>
                    <p class="panel-subtitle">المصادقة نفسها المستخدمة في خدمات المنصة</p>
                </div>
            </div>
            <dl class="company-facts">
                <div class="company-fact">
                    <dt>رأس المصادقة</dt>
                    <dd><code>Authorization: Bearer &lt;api_key&gt;</code></dd>
                </div>
                <div class="company-fact">
                    <dt>الصلاحيات</dt>
                    <dd>محدّدة في <code>scopes</code> على كل مفتاح — النداء خارجها يُرفض من الخادم.</dd>
                </div>
                <div class="company-fact">
                    <dt>عند التسريب</dt>
                    <dd>أوقف المفتاح فورًا من القائمة أعلاه ثم اطلب بديلًا. الإيقاف يسري على الخادم مباشرةً.</dd>
                </div>
            </dl>
        </section>`;

    renderKeys(tokens, selfId);
    renderUsage(usage, tokens);

    document.getElementById('companyRequestKey')?.addEventListener('click', () => onRequestKey?.());
}

/** أحدث استخدام عبر كل المفاتيح. */
function lastUsedLabel(tokens) {
    const stamps = tokens.map(t => t.last_used_at).filter(Boolean).sort();
    return stamps.length ? timeAgo(stamps[stamps.length - 1]) : '—';
}

/**
 * مفاتيح الشركة وأعضائها.
 *
 * fetchApiTokens المشتركة تقيّد على user_id = أنا، وهو الصحيح لبوابة العميل.
 * هنا نحتاج نطاق الشركة الذي تسمح به السياسة أصلًا، فنقرأ بلا قيد user_id
 * ونترك RLS تحصر النتيجة. لا يمكن أن تعود صفوف خارج النطاق مهما عُدِّل الطلب.
 */
async function fetchCompanyScopedTokens() {
    try {
        const { data, error } = await supabase
            .from('api_tokens')
            .select('id, user_id, name, description, api_key, secret_last_four, bearer_last_four, is_active, created_at, last_used_at, revoked_at, usage_count, expires_at, scopes')
            .order('created_at', { ascending: false });
        if (error) throw error;
        return { ok: true, data: data || [], error: null };
    } catch (err) {
        console.error('[CompanyApi] tokens:', err?.message || err);
        return { ok: false, data: null, error: err?.message || 'تعذّر تحميل المفاتيح' };
    }
}

function renderKeys(tokens, selfId) {
    const box = document.getElementById('companyKeysList');
    if (!box) return;

    if (!tokens.length) {
        renderState(box, {
            variant: 'empty',
            title: 'لا توجد مفاتيح API على حساب شركتك',
            text: 'المفاتيح يصدرها فريق مدعوم عند الحاجة. اطلب مفتاحًا وسيصلك عبر تذكرة دعم.',
            action: { label: 'طلب مفتاح', act: 'request-api-key', variant: 'btn-primary' }
        });
        box.querySelector('[data-action="request-api-key"]')
            ?.addEventListener('click', () => onRequestKey?.());
        return;
    }

    box.innerHTML = `
        <ul class="company-sub-list">
            ${tokens.map(token => {
                const state = tokenState(token);
                const scopes = Array.isArray(token.scopes) ? token.scopes : [];
                const last4 = token.secret_last_four || token.bearer_last_four;
                return `
                <li class="company-sub">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${escapeHtml(token.name || 'مفتاح API')}</p>
                        <p class="company-sub-dates">
                            ${escapeHtml(ownerLabel(token.user_id, selfId))}
                            ${last4 ? ` · <code>••••${escapeHtml(last4)}</code>` : ''}
                            · أُنشئ ${escapeHtml(formatDate(token.created_at))}
                            · ${token.last_used_at ? `آخر استخدام ${escapeHtml(timeAgo(token.last_used_at))}` : 'لم يُستخدم بعد'}
                            · ${escapeHtml(String(token.usage_count || 0))} نداء
                        </p>
                        ${scopes.length ? `<p class="company-sub-dates">الصلاحيات: ${escapeHtml(scopes.join('، '))}</p>` : ''}
                        ${token.expires_at ? `<p class="company-sub-dates">ينتهي في ${escapeHtml(formatDate(token.expires_at))}</p>` : ''}
                    </div>
                    <div class="company-sub-side">
                        <span class="pill status-tone-${escapeHtml(state.tone)}">${escapeHtml(state.label)}</span>
                        ${state.key === 'revoked' ? '' : `
                        <button type="button" class="panel-link" data-api-toggle="${escapeHtml(token.id)}">
                            ${token.is_active === false ? 'تفعيل' : 'إيقاف'}
                        </button>`}
                    </div>
                </li>`;
            }).join('')}
        </ul>`;

    box.querySelectorAll('[data-api-toggle]').forEach(btn => {
        btn.addEventListener('click', () => toggleKey(btn.getAttribute('data-api-toggle'), tokens, selfId));
    });
}

/**
 * إيقاف/تفعيل مفتاح.
 *
 * الصلاحية تُفرَض في القاعدة (سياسة UPDATE أعلاه)؛ الواجهة ترسل الطلب وتعرض
 * نتيجته. لو كان المفتاح خارج النطاق فلن يتأثر أي صف — والرسالة تقول ذلك
 * بدل أن تدّعي نجاحًا.
 */
async function toggleKey(tokenId, tokens, selfId) {
    const token = tokens.find(t => t.id === tokenId);
    if (!token) return;
    const disabling = token.is_active !== false;

    const ok = await ui.showConfirm(
        disabling ? 'إيقاف المفتاح؟' : 'تفعيل المفتاح؟',
        disabling
            ? 'سيتوقف قبول أي نداء بهذا المفتاح فورًا. يمكنك تفعيله لاحقًا.'
            : 'سيُقبل استخدام هذا المفتاح مرة أخرى.',
        { confirmLabel: disabling ? 'إيقاف' : 'تفعيل', cancelLabel: 'تراجع', danger: disabling }
    );
    if (!ok) return;

    try {
        const { data, error } = await supabase
            .from('api_tokens')
            .update({ is_active: !disabling })
            .eq('id', tokenId)
            .select('id');
        if (error) throw error;
        if (!data || data.length === 0) {
            throw new Error('لا تملك صلاحية تعديل هذا المفتاح.');
        }
        ui?.showToast?.(disabling ? 'تم إيقاف المفتاح' : 'تم تفعيل المفتاح', 'success');
        await loadCompanyApi({ selfId });
    } catch (err) {
        ui?.showToast?.(err?.message || 'تعذّر تنفيذ الإجراء', 'error');
    }
}

function renderUsage(usage, tokens) {
    const box = document.getElementById('companyApiUsage');
    if (!box) return;

    if (!usage.length) {
        renderState(box, {
            variant: 'empty',
            title: 'لا توجد نداءات مسجّلة',
            text: 'سيظهر هنا سجل النداءات فور استخدام أحد المفاتيح.'
        });
        return;
    }

    const nameById = new Map(tokens.map(t => [t.id, t.name || 'مفتاح API']));

    box.innerHTML = `
        <div class="activity-timeline">
            ${usage.map(row => `
                <div class="activity-item">
                    <div>
                        <div class="activity-text">
                            <strong>${escapeHtml(String(row.method || '').toUpperCase())}</strong>
                            ${escapeHtml(row.endpoint || '')}
                            — <span class="pill ${row.status_code >= 400 ? 'status-tone-danger' : 'status-tone-success'}">${escapeHtml(String(row.status_code ?? '—'))}</span>
                        </div>
                        <div class="activity-time">
                            ${escapeHtml(timeAgo(row.created_at))}
                            ${row.token_id ? ` · ${escapeHtml(nameById.get(row.token_id) || 'مفتاح محذوف')}` : ''}
                        </div>
                    </div>
                </div>`).join('')}
        </div>`;
}
