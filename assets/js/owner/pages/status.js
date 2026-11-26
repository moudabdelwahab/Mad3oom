/**
 * owner/status.html — حالة الخدمات لمالك المنصة.
 *
 * نفس عرض admin/status-page.html (البطاقات، الشارة العامة، بلاغات العملاء، سجل الحوادث)
 * لكن من دالتين للمالك (الترحيل 147):
 *   • owner_service_status() → {services, incidents, report_summary} — قراءة واحدة بدل ثلاث قراءات.
 *   • owner_set_service_status(p_service, p_status) — الكتابة عبر الدالة وحدها.
 * لا يُستخدم هنا مسار الكتابة المباشر في service-status.js (سياسته تشترط الرتبة الحرفية
 * 'admin'/'support' فيرفض المالك)، ولا get_service_report_summary() (نفس القيد).
 * قبل الترحيل 147 تظهر حالة «غير متاح بعد» بدل تفريغ خطأ — الدالة غير موجودة أصلًا.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, day, num, kpis, stateBlock, errorBlock,
    loadingBlock, friendlyError
} from '/assets/js/owner/owner-page.js';

const $ = (id) => document.getElementById(id);
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

const STATUS_OPTIONS = [
    ['operational', 'مستقر'],
    ['degraded', 'أداء منخفض'],
    ['partial_outage', 'عطل جزئي'],
    ['down', 'متوقف'],
    ['maintenance', 'صيانة مجدولة']
];
const STATUS_LABELS = Object.fromEntries(STATUS_OPTIONS);

let currentFilter = 'all';
let cache = { services: [], incidents: [], report_summary: [] };
let unavailable = false;

const statusBadgeClass = (status) => {
    if (status === 'operational') return 'status-resolved';
    if (status === 'down' || status === 'partial_outage') return 'status-danger';
    return 'status-pending';
};

/** الدالة غير موجودة على الخادم بعد (قبل 147): PostgREST يرد PGRST202، أو 42883 من القاعدة. */
function isMissingFunction(error) {
    if (!error) return false;
    if (error.code === 'PGRST202' || error.code === '42883') return true;
    return /does not exist|not found|PGRST202|42883/i.test(error.message || '');
}

function unavailableBlock() {
    return stateBlock({
        title: 'حالة الخدمات غير متاحة بعد',
        text: 'دالة المالك owner_service_status() لم تُنشر على الخادم بعد (الترحيل 147). تُفعَّل هذه الصفحة فور تطبيقه.'
    });
}

async function load() {
    $('servicesList').innerHTML = loadingBlock();
    $('customerReportsContainer').innerHTML = loadingBlock();
    $('incidentsContainer').innerHTML = loadingBlock();
    let data, error = null;
    try {
        ({ data, error } = await supabase.rpc('owner_service_status'));
    } catch (err) {
        error = err;
    }
    if (error) {
        if (isMissingFunction(error)) {
            unavailable = true;
            $('statusKpis').innerHTML = '';
            $('servicesList').innerHTML = unavailableBlock();
            $('customerReportsContainer').innerHTML = unavailableBlock();
            $('incidentsContainer').innerHTML = unavailableBlock();
            $('globalTitle').textContent = 'حالة الخدمات غير متاحة بعد';
            $('globalDesc').textContent = 'تُفعَّل مع الترحيل 147.';
            return;
        }
        unavailable = false;
        $('statusKpis').innerHTML = '';
        $('servicesList').innerHTML = errorBlock(friendlyError(error));
        $('customerReportsContainer').innerHTML = errorBlock(friendlyError(error));
        $('incidentsContainer').innerHTML = errorBlock(friendlyError(error));
        return;
    }
    unavailable = false;
    cache = {
        services: Array.isArray(data?.services) ? data.services : [],
        incidents: Array.isArray(data?.incidents) ? data.incidents : [],
        report_summary: Array.isArray(data?.report_summary) ? data.report_summary : []
    };
    renderAll();
}

function renderKpis() {
    const s = cache.services;
    const down = s.filter(x => x.status === 'down' || x.status === 'partial_outage').length;
    const degraded = s.filter(x => x.status === 'degraded').length;
    const maintenance = s.filter(x => x.status === 'maintenance').length;
    const operational = s.filter(x => x.status === 'operational').length;
    $('statusKpis').innerHTML = kpis([
        ['الخدمات', num(s.length), ''],
        ['تعمل', num(operational), operational ? 'kpi--success' : ''],
        ['أداء منخفض', num(degraded), degraded ? 'kpi--warning' : ''],
        ['متوقفة', num(down), down ? 'kpi--danger' : ''],
        ['صيانة مجدولة', num(maintenance), ''],
        ['حوادث مفتوحة', num(cache.incidents.filter(i => i.status !== 'resolved').length), '']
    ]);
}

function renderGlobal() {
    const s = cache.services;
    const down = s.filter(x => x.status === 'down' || x.status === 'partial_outage').length;
    const degraded = s.filter(x => x.status === 'degraded').length;
    const icon = $('globalIcon');
    const title = $('globalTitle');
    const desc = $('globalDesc');
    const ok = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
    const warn = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>';
    const bad = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
    if (down > 0) {
        icon.className = 'status-icon-wrapper bg-danger-light';
        icon.innerHTML = bad;
        title.textContent = 'انقطاع في بعض الخدمات';
        desc.textContent = 'نعمل حالياً على إصلاح المشاكل التقنية واستعادة استقرار النظام.';
    } else if (degraded > 0) {
        icon.className = 'status-icon-wrapper bg-warning-light';
        icon.innerHTML = warn;
        title.textContent = 'أداء بعض الأنظمة متأثر';
        desc.textContent = 'قد تواجه بعض الخدمات بطئاً في الاستجابة، جاري التحسين.';
    } else {
        icon.className = 'status-icon-wrapper bg-success-light';
        icon.innerHTML = ok;
        title.textContent = 'جميع الأنظمة تعمل بشكل مثالي';
        desc.textContent = 'نراقب الخدمات باستمرار لضمان أفضل تجربة مستخدم.';
    }
}

function renderServices() {
    const filtered = cache.services.filter(s => {
        if (currentFilter === 'all') return true;
        if (currentFilter === 'operational') return s.status === 'operational';
        if (currentFilter === 'issue') return s.status !== 'operational';
        return true;
    });
    if (!filtered.length) {
        $('servicesList').innerHTML = stateBlock({ text: cache.services.length ? 'لا توجد خدمات تطابق الفلتر المختار' : 'لا توجد خدمات مسجّلة.' });
        return;
    }
    // ملاحظة كما في صفحة الإدارة: لا شريط إتاحة ولا «99.9%» — كانا مرسومين من
    // بيانات ثابتة، والإتاحة الحقيقية تحتاج سجل service_status_history.
    $('servicesList').innerHTML = filtered.map(s => `
        <div class="service-status-card">
            <div class="service-card-header">
                <span class="service-title">${esc(s.name)}</span>
                <span class="status-badge ${statusBadgeClass(s.status)}">${esc(STATUS_LABELS[s.status] || s.status)}</span>
            </div>
            <p style="font-size: 0.95rem; color: var(--color-text-secondary); line-height: 1.5;">${esc(s.description || 'لا يوجد وصف متاح')}</p>
            <label class="visually-hidden" for="svc-${esc(s.id)}">تغيير حالة ${esc(s.name)}</label>
            <select class="form-control service-status-select" id="svc-${esc(s.id)}" data-service="${esc(s.id)}" data-previous="${esc(s.status)}">
                ${STATUS_OPTIONS.map(([value, label]) => `
                    <option value="${value}"${s.status === value ? ' selected' : ''}>${label}</option>`).join('')}
            </select>
            <div class="service-card-footer">
                <span>⏱️ ${s.response_time ? esc(String(s.response_time)) + 'ms' : '--'}</span>
                <span>${s.status_changed_at ? 'منذ ' + esc(day(s.status_changed_at)) : ''}</span>
            </div>
        </div>`).join('');
}

function renderReports() {
    const rows = cache.report_summary;
    if (!rows.length) {
        $('customerReportsContainer').innerHTML = `
            <div class="section-card" style="padding: 2rem; text-align: center;">
                <p style="color: var(--color-text-secondary); font-weight: 600;">لا توجد بلاغات عملاء مفتوحة</p>
                <p style="color: var(--color-text-secondary); font-size: 0.9rem;">عندما يبلّغ عميل عن عطل في خدمة سيظهر هنا مع عدد المتأثرين.</p>
            </div>`;
        return;
    }
    $('customerReportsContainer').innerHTML = rows.map(row => {
        const reporters = Array.isArray(row.reporters) ? row.reporters : [];
        return `
        <div class="incident-entry active">
            <div class="incident-entry-header">
                <span style="font-weight: 800; font-size: 1.1rem;">${esc(row.service_name)}</span>
                <span class="status-badge status-danger">${esc(num(row.report_count))} عميل متأثر</span>
            </div>
            <p style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 1rem;">
                أول بلاغ ${esc(when(row.first_reported))} · آخر بلاغ ${esc(when(row.last_reported))}
            </p>
            <ul style="margin: 0; padding-inline-start: 1.25rem; color: var(--color-text-secondary); font-size: 0.9rem;">
                ${reporters.slice(0, 10).map(r => `
                    <li>${esc(r.name)} — أبلغ ${esc(new Date(r.reported_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }))}</li>`).join('')}
                ${reporters.length > 10 ? `<li>و${reporters.length - 10} عميلاً آخر</li>` : ''}
            </ul>
        </div>`;
    }).join('');
}

function renderIncidents() {
    if (!cache.incidents.length) {
        $('incidentsContainer').innerHTML = `
            <div class="section-card" style="text-align: center; padding: 4rem;">
                <p style="color: var(--color-text-secondary); font-weight: 600;">لا توجد حوادث مسجلة حالياً</p>
            </div>`;
        return;
    }
    $('incidentsContainer').innerHTML = cache.incidents.map(inc => `
        <div class="incident-entry ${inc.status === 'resolved' ? 'resolved' : 'active'}">
            <div class="incident-entry-header">
                <span style="font-weight: 800; font-size: 1.1rem; color: var(--color-heading);">${esc(inc.title)}</span>
                <span class="status-badge status-${inc.status === 'resolved' ? 'resolved' : 'danger'}">
                    ${inc.status === 'resolved' ? 'تم الحل' : 'نشط'}
                </span>
            </div>
            <p style="font-size: 1rem; color: var(--color-text-secondary); margin-bottom: 1rem; line-height: 1.6;">${esc(inc.description || '')}</p>
            <div style="font-size: 0.85rem; color: #999; font-weight: 600;">🗓️ ${esc(when(inc.created_at))}</div>
        </div>`).join('');
}

function renderAll() {
    renderKpis();
    renderGlobal();
    renderServices();
    renderReports();
    renderIncidents();
}

async function setServiceStatus(select) {
    const previous = select.dataset.previous || '';
    const serviceId = select.dataset.service;
    const next = select.value;
    select.disabled = true;
    say('جارٍ تحديث حالة الخدمة…');
    let error = null;
    try {
        ({ error } = await supabase.rpc('owner_set_service_status', { p_service: serviceId, p_status: next }));
    } catch (err) {
        error = err;
    } finally {
        select.disabled = false;
    }
    if (error) {
        say(friendlyError(error), 'error');
        if (previous) select.value = previous;
        return;
    }
    say('تم تحديث حالة الخدمة.', 'success');
    load();
}

function subscribe() {
    // تحديث فوري كما في صفحة الإدارة (Realtime على الخدمات والحوادث).
    try {
        supabase.channel('owner-service-status')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'services' }, () => { if (!unavailable) load(); })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, () => { if (!unavailable) load(); })
            .subscribe();
    } catch (err) {
        console.error('[OwnerStatus] realtime:', err?.message || err);
    }
}

(async function init() {
    if (!await bootOwnerPage()) return;
    $('statusRefresh').addEventListener('click', load);
    document.querySelectorAll('.btn-filter').forEach(btn => btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderServices();
    }));
    $('servicesList').addEventListener('change', (e) => {
        const select = e.target.closest('.service-status-select');
        if (select) setServiceStatus(select);
    });
    subscribe();
    load();
})();
