/**
 * company-support.js — مركز الدعم داخل لوحة الشركة.
 *
 * ثلاث وظائف كانت تستدعي مغادرة اللوحة إلى بوابة العميل، وصارت هنا:
 *   • فتح تذكرة دعم        (كانت customer-dashboard.html#support)
 *   • حالة النظام والأعطال (كانت نفس القسم)
 *   • مقالات المساعدة      (كانت knowledge-base.html)
 *
 * وكلها فوق نفس الوحدات المشتركة، بلا نسخ للمنطق:
 *   tickets-service.js                         إنشاء التذكرة
 *   assets/js/customer/customer-data.js        حالة النظام + الاستحقاقات
 *   assets/js/customer/service-status-model.js ترتيب وتصفية الخدمات (خالصة)
 *   assets/js/customer/help-data.js            مقالات المساعدة
 */

import { createTicket } from '/tickets-service.js';
import { fetchSystemStatus, fetchAccountStatus, fetchWhatsappSubscription, fetchSieAccess }
    from '/assets/js/customer/customer-data.js';
import { entitlementsFrom, impairedForCustomer, orderForCustomer, statusInfo, incidentForService }
    from '/assets/js/customer/service-status-model.js';
import { fetchArticles, searchArticles } from '/assets/js/customer/help-data.js';
import { escapeHtml, renderState, renderSkeletonLines, timeAgo }
    from '/assets/js/customer/portal-ui.js';

let container = null;
let onTicketCreated = null;

export function initCompanySupport({ onCreated } = {}) {
    container = document.getElementById('companySupport');
    onTicketCreated = onCreated || null;
}

export async function loadCompanySupport() {
    if (!container) return;

    container.innerHTML = `
        <section class="panel" aria-labelledby="companyNewTicketHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyNewTicketHeading">فتح تذكرة دعم</h2>
                    <p class="panel-subtitle">تُفتح باسم هذا الحساب وتظهر في «تذاكر الشركة»</p>
                </div>
            </div>
            <form id="companyTicketForm" class="company-form" novalidate>
                <div class="form-grid">
                    <div class="form-field is-full">
                        <label for="fTicketTitle">عنوان المشكلة <span aria-hidden="true">*</span></label>
                        <input type="text" id="fTicketTitle" class="form-control" required>
                        <p class="field-error" data-ticket-error-for="title" hidden></p>
                    </div>
                    <div class="form-field is-full">
                        <label for="fTicketCategory">التصنيف</label>
                        <select id="fTicketCategory" class="form-control">
                            <option value="">— اختر —</option>
                            <option value="subscription">اشتراك</option>
                            <option value="whatsapp">واتساب</option>
                            <option value="tickets">تذاكر</option>
                            <option value="login">تسجيل دخول</option>
                            <option value="other">أخرى</option>
                        </select>
                    </div>
                    <div class="form-field is-full">
                        <label for="fTicketBody">وصف المشكلة <span aria-hidden="true">*</span></label>
                        <textarea id="fTicketBody" class="form-control" rows="4" required></textarea>
                        <p class="field-error" data-ticket-error-for="description" hidden></p>
                    </div>
                </div>
                <p class="field-error" id="companyTicketFormError" role="alert" hidden></p>
                <div class="company-form-actions">
                    <button type="submit" class="btn btn-primary" id="companyTicketSubmit">إرسال التذكرة</button>
                </div>
            </form>
        </section>

        <section class="panel" aria-labelledby="companyStatusHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyStatusHeading">حالة الخدمات</h2>
                    <p class="panel-subtitle">الخدمات التي تخصّ اشتراكات شركتك أولًا</p>
                </div>
            </div>
            <div id="companyServiceStatus"></div>
        </section>

        <section class="panel" aria-labelledby="companyHelpHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyHelpHeading">مقالات المساعدة</h2>
                    <p class="panel-subtitle">إجابات جاهزة قبل فتح تذكرة</p>
                </div>
            </div>
            <div class="form-field">
                <label class="visually-hidden" for="companyHelpSearch">ابحث في المساعدة</label>
                <input type="search" id="companyHelpSearch" class="form-control" placeholder="ابحث في مقالات المساعدة…">
            </div>
            <div id="companyHelpArticles"></div>
        </section>`;

    document.getElementById('companyTicketForm')?.addEventListener('submit', onCreateTicket);

    const search = document.getElementById('companyHelpSearch');
    let debounce;
    search?.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => loadArticles(search.value.trim()), 250);
    });

    // القسمان يُحمّلان بالتوازي؛ فشل أحدهما لا يوقف الآخر
    await Promise.all([loadServiceStatus(), loadArticles('')]);
}

/* ── فتح تذكرة ──────────────────────────────────────────────────────────── */

/** تحقّق خالص — نفس ما ترفضه createTicket في الخدمة المشتركة. */
export function validateTicketForm(values) {
    const errors = {};
    if (String(values?.title || '').trim().length < 3) errors.title = 'عنوان المشكلة مطلوب';
    if (String(values?.description || '').trim().length < 10) {
        errors.description = 'اشرح المشكلة في 10 أحرف على الأقل';
    }
    return { isValid: Object.keys(errors).length === 0, errors };
}

async function onCreateTicket(event) {
    event.preventDefault();

    document.querySelectorAll('[data-ticket-error-for]').forEach(el => { el.hidden = true; el.textContent = ''; });
    const box = document.getElementById('companyTicketFormError');
    box.hidden = true;
    box.textContent = '';

    const values = {
        title: document.getElementById('fTicketTitle').value,
        description: document.getElementById('fTicketBody').value,
        category: document.getElementById('fTicketCategory').value || null
    };

    const validation = validateTicketForm(values);
    if (!validation.isValid) {
        for (const [field, message] of Object.entries(validation.errors)) {
            const el = document.querySelector(`[data-ticket-error-for="${field}"]`);
            if (el) { el.textContent = message; el.hidden = false; }
        }
        return;
    }

    const btn = document.getElementById('companyTicketSubmit');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ الإرسال…';

    try {
        const ticket = await createTicket(values);
        document.getElementById('companyTicketForm').reset();
        // النتيجة تظهر في قسم التذاكر داخل نفس اللوحة — بلا مغادرة
        if (onTicketCreated) onTicketCreated(ticket);
    } catch (err) {
        box.textContent = err?.message || 'تعذّر إنشاء التذكرة. حاول مرة أخرى.';
        box.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

/* ── حالة الخدمات ───────────────────────────────────────────────────────── */

async function loadServiceStatus() {
    const box = document.getElementById('companyServiceStatus');
    if (!box) return;
    renderSkeletonLines(box, 3);

    const [status, account, waSub, sie] = await Promise.all([
        fetchSystemStatus(), fetchAccountStatus(), fetchWhatsappSubscription(), fetchSieAccess()
    ]);

    if (!status.ok) {
        renderState(box, { variant: 'error', title: 'تعذّر تحميل حالة الخدمات', text: '' });
        return;
    }

    // الاستحقاقات تحدّد أي الخدمات تخصّ هذا الحساب — نفس الدالة الخالصة
    // المستخدمة في بوابة العميل، بلا إعادة تعريف.
    // نفس شكل اللقطة الذي تبنيه بوابة العميل — المفاتيح جزء من العقد
    const entitlements = entitlementsFrom({ account, waSub, sie });
    const services = orderForCustomer(status.data?.services || [], entitlements);
    const impaired = impairedForCustomer(status.data, entitlements);
    const incidents = status.data?.incidents || [];

    if (!services.length) {
        renderState(box, { variant: 'empty', title: 'لا توجد خدمات مسجّلة', text: '' });
        return;
    }

    box.innerHTML = `
        ${impaired.length ? `
        <p class="company-notice company-notice--danger">
            ${escapeHtml(impaired.length === 1
                ? 'خدمة واحدة من خدمات شركتك متأثرة حاليًا.'
                : `${impaired.length} من خدمات شركتك متأثرة حاليًا.`)}
        </p>` : ''}
        <ul class="company-sub-list">
            ${services.map(service => {
                const info = statusInfo(service);
                const incident = incidentForService(service, incidents);
                return `
                <li class="company-sub">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${escapeHtml(service.name_ar || service.name || '—')}</p>
                        <p class="company-sub-dates">
                            ${incident
                                ? escapeHtml(`${incident.title || 'عطل قائم'} — ${timeAgo(incident.started_at || incident.created_at)}`)
                                : escapeHtml(service.description || '')}
                        </p>
                    </div>
                    <div class="company-sub-side">
                        <span class="pill status-tone-${escapeHtml(info.tone || 'neutral')}">${escapeHtml(info.label || '')}</span>
                    </div>
                </li>`;
            }).join('')}
        </ul>`;
}

/* ── مقالات المساعدة ────────────────────────────────────────────────────── */

async function loadArticles(term) {
    const box = document.getElementById('companyHelpArticles');
    if (!box) return;
    renderSkeletonLines(box, 3);

    const result = term ? await searchArticles(term, { limit: 8 }) : await fetchArticles({ limit: 8 });

    if (!result.ok) {
        renderState(box, { variant: 'error', title: 'تعذّر تحميل المقالات', text: '' });
        return;
    }

    // العقدان مختلفان عمدًا في الوحدة المشتركة: القائمة { items, total }،
    // والبحث مصفوفة مرتّبة بالصلة من search_help_articles.
    const articles = Array.isArray(result.data) ? result.data : (result.data?.items || []);
    if (!articles.length) {
        renderState(box, {
            variant: 'empty',
            title: term ? 'لا توجد مقالات مطابقة' : 'لا توجد مقالات منشورة',
            text: term ? 'جرّب كلمة أخرى، أو افتح تذكرة دعم.' : ''
        });
        return;
    }

    box.innerHTML = `
        <ul class="company-sub-list">
            ${articles.map(article => `
                <li class="company-sub">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${escapeHtml(article.title || '')}</p>
                        <p class="company-sub-dates">${escapeHtml(article.excerpt || '')}</p>
                    </div>
                </li>`).join('')}
        </ul>`;
}
