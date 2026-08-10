/**
 * الاستخدام والتكلفة
 * --------------------------------------------------------
 * كل الأرقام مصدرها ai_usage_events التي يكتبها الـ Gateway وحده.
 * الواجهة لا تحسب شيئًا بنفسها ولا تسحب صفوفًا خامًا بالآلاف — تقرأ
 * ملخصًا مجمّعًا عبر RPC واحدة، وقائمة قصيرة بآخر الأحداث للتشخيص.
 */

import * as api from '../ai-service.js';
import { providerLabel } from '../provider-registry.js';
import {
    escapeHtml, icon, toast, loadingBlock, errorBlock, emptyBlock,
    formatNumber, formatCost, formatDate,
} from './shared.js';

let ctx = null;
let periodDays = 30;

export function init(sharedContext) { ctx = sharedContext; }

export function getPeriodDays() { return periodDays; }

export function setPeriod(days) {
    periodDays = Number(days) || 30;
    document.querySelectorAll('#aiUsagePeriodChips .mcp-chip').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.usagePeriod) === periodDays);
    });
    ctx.reload();
}

export function sinceIso() {
    return new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();
}

/** إجماليات الفترة كلها — تُحسب من نفس الملخص المجمّع. */
function totals(summary) {
    return summary.reduce((acc, r) => {
        acc.requests += Number(r.requests) || 0;
        acc.errors += Number(r.errors) || 0;
        acc.tokens += Number(r.total_tokens) || 0;
        acc.input += Number(r.input_tokens) || 0;
        acc.output += Number(r.output_tokens) || 0;
        acc.cost += Number(r.total_cost) || 0;
        if (r.avg_latency_ms) {
            acc.latencyWeighted += Number(r.avg_latency_ms) * (Number(r.requests) || 0);
            acc.latencyRequests += Number(r.requests) || 0;
        }
        return acc;
    }, { requests: 0, errors: 0, tokens: 0, input: 0, output: 0, cost: 0, latencyWeighted: 0, latencyRequests: 0 });
}

function kpi(iconName, value, label, extraClass = '') {
    return `
    <div class="stat-card ${extraClass}">
        <div class="stat-icon icon-tools">${icon(iconName, 22)}</div>
        <div class="stat-info"><div class="num">${value}</div><div class="lbl">${escapeHtml(label)}</div></div>
    </div>`;
}

export function render() {
    const kpiWrap = document.getElementById('aiUsageKpis');
    const tableWrap = document.getElementById('aiUsageTable');
    if (!kpiWrap || !tableWrap) return;

    const summary = ctx.usageSummary || [];

    if (!summary.length) {
        kpiWrap.innerHTML = '';
        tableWrap.innerHTML = emptyBlock({
            title: 'لا يوجد استخدام مسجّل في هذه الفترة',
            body: 'كل نداء يمر عبر الـ Gateway يُسجَّل هنا تلقائيًا (توكنات، تكلفة، زمن استجابة، أخطاء). جرّب جلسة من بيئة التطوير ثم عُد.',
        });
        renderRecent();
        return;
    }

    const t = totals(summary);
    const avgLatency = t.latencyRequests ? Math.round(t.latencyWeighted / t.latencyRequests) : 0;
    const errorRate = t.requests ? ((t.errors / t.requests) * 100).toFixed(1) : '0.0';

    kpiWrap.innerHTML = [
        kpi('activity', formatNumber(t.requests), 'إجمالي الطلبات'),
        kpi('cpu', formatNumber(t.tokens), 'إجمالي التوكنات'),
        kpi('dollar', formatCost(t.cost), 'إجمالي التكلفة'),
        kpi('clock', avgLatency ? `${avgLatency}ms` : '—', 'متوسط زمن الاستجابة'),
        kpi('alert', `${formatNumber(t.errors)} (${errorRate}%)`, 'الأخطاء'),
    ].join('');

    // تجميع حسب التكامل لعرض شجري: مزوّد ← موديلاته
    const byIntegration = new Map();
    for (const row of summary) {
        if (!byIntegration.has(row.integration_id)) byIntegration.set(row.integration_id, []);
        byIntegration.get(row.integration_id).push(row);
    }

    tableWrap.innerHTML = [...byIntegration.entries()].map(([integrationId, rows]) => {
        const integration = ctx.integrations.find((i) => i.id === integrationId);
        const sub = totals(rows);
        const subLatency = sub.latencyRequests ? Math.round(sub.latencyWeighted / sub.latencyRequests) : 0;

        return `
        <div class="mcp-card ai-usage-card">
            <div class="card-row">
                <div class="card-head">
                    <div class="card-icon">${icon('cpu', 20)}</div>
                    <div class="card-title-wrap">
                        <div class="card-title">${escapeHtml(integration?.display_name || 'تكامل محذوف')}</div>
                        <div class="card-subtitle">${escapeHtml(providerLabel(ctx.catalog, integration?.provider || rows[0].provider))}</div>
                    </div>
                </div>
            </div>
            <div class="ai-usage-strip ai-usage-strip-lg">
                <span>${icon('activity')} ${formatNumber(sub.requests)} طلب</span>
                <span>${icon('cpu')} ${formatNumber(sub.tokens)} توكن</span>
                <span class="ai-dim">إدخال ${formatNumber(sub.input)} • إخراج ${formatNumber(sub.output)}</span>
                <span>${icon('dollar')} ${formatCost(sub.cost)}</span>
                <span>${icon('clock')} ${subLatency ? subLatency + 'ms' : '—'}</span>
                ${sub.errors ? `<span class="ai-usage-errors">${icon('alert')} ${formatNumber(sub.errors)} خطأ</span>` : ''}
            </div>
            <table class="ai-usage-models">
                <thead>
                    <tr><th>الموديل</th><th>طلبات</th><th>توكنات</th><th>تكلفة</th><th>زمن</th><th>أخطاء</th><th>آخر استخدام</th></tr>
                </thead>
                <tbody>
                    ${rows.sort((a, b) => Number(b.requests) - Number(a.requests)).map((r) => `
                        <tr>
                            <td dir="ltr" class="ai-usage-model-cell">${escapeHtml(r.model_id || '—')}</td>
                            <td>${formatNumber(r.requests)}</td>
                            <td>${formatNumber(r.total_tokens)}</td>
                            <td>${formatCost(r.total_cost)}</td>
                            <td>${r.avg_latency_ms ? Math.round(r.avg_latency_ms) + 'ms' : '—'}</td>
                            <td class="${Number(r.errors) ? 'ai-usage-errors' : ''}">${formatNumber(r.errors)}</td>
                            <td>${formatDate(r.last_used_at)}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
    }).join('');

    renderRecent();
}

function renderRecent() {
    const list = document.getElementById('aiUsageRecent');
    if (!list) return;

    const events = ctx.usageEvents || [];
    if (!events.length) {
        list.innerHTML = '<div class="activity-empty">لا توجد أحداث بعد</div>';
        return;
    }

    const statusChipFor = (status) => ({
        success: '<span class="activity-tag act-connected">نجح</span>',
        error: '<span class="activity-tag act-error">خطأ</span>',
        fallback: '<span class="activity-tag act-updated">تحوّل لاحتياطي</span>',
    }[status] || '');

    list.innerHTML = events.map((e) => `
        <div class="activity-item">
            ${statusChipFor(e.status)}
            <span class="activity-name" dir="ltr">${escapeHtml(e.provider || '—')}/${escapeHtml(e.model_id || '—')}</span>
            <span class="activity-msg">
                ${e.mode ? `<span class="ai-chip-soft">${escapeHtml(e.mode)}</span> ` : ''}
                ${escapeHtml(e.source || '')}
                ${e.total_tokens ? ` • ${formatNumber(e.total_tokens)} توكن` : ''}
                ${e.latency_ms ? ` • ${e.latency_ms}ms` : ''}
                ${Number(e.cost) ? ` • ${formatCost(e.cost)}` : ''}
                ${e.attempt > 1 ? ` • محاولة ${e.attempt}` : ''}
                ${e.error_message ? `<div class="ai-note">${escapeHtml(e.error_message)}</div>` : ''}
            </span>
            <span class="activity-time">${formatDate(e.created_at)}</span>
        </div>`).join('');
}

export function renderPeriodChips() {
    const wrap = document.getElementById('aiUsagePeriodChips');
    if (!wrap || wrap.dataset.built) return;
    const options = [
        { days: 1, label: 'آخر 24 ساعة' },
        { days: 7, label: 'آخر 7 أيام' },
        { days: 30, label: 'آخر 30 يوم' },
        { days: 90, label: 'آخر 90 يوم' },
    ];
    wrap.innerHTML = options.map((o) => `
        <button class="mcp-chip ${o.days === periodDays ? 'active' : ''}" data-usage-period="${o.days}">${escapeHtml(o.label)}</button>`).join('');
    wrap.dataset.built = '1';
}
