/**
 * company-team-performance.js — أداء فريق الشركة (migrations/146).
 *
 * نداء واحد فقط: company_team_performance(p_from, p_to) — أعضاء الفريق
 * مجمّعين من القاعدة وإجماليات الشركة. لا استعلام مباشر عن
 * tickets/profiles/chat_sessions من هذا التبويب إطلاقًا.
 *
 * العرض يعيد استخدام نموذج الأداء المشترك كما هو
 * (team-performance-model.js في لوحة الإدارة): sortRows للفرز،
 * formatHours للأزمنة، initialsOf للأحرف — استيراد لا نسخ. و buildTeamPerformance
 * و dailyResolved لا يُستدعيان: يحتاجان صفوفًا خامًا لا يملكها التبويب،
 * فالتقييمات والشات إجمالي شركة فقط (انظر company-team-performance-model.js).
 */
import { fetchTeamPerformance } from '/assets/js/company/company-data.js';
import {
    teamPerformanceRows, teamPerformanceTotals, presetWindow, validateWindow
} from '/assets/js/company/company-team-performance-model.js';
import {
    sortRows, formatHours, initialsOf
} from '/assets/js/admin/team-performance-model.js';
import { escapeHtml, formatDate, renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

let wired = false;
let boxEl = null;
let bodyEl = null;

let windowSel = { preset: 30, from: null, to: null };
let payload = null;
let sort = { key: 'resolved', dir: 'desc' };

export function initCompanyTeamPerformance() { /* بلا تبعيات: نداء واحد للقاعدة */ }

/** يُحمَّل عند أول فتح لأداء الفريق فقط (LOADERS)؛ يرجّع false حين يفشل فيُعاد تحميله. */
export async function loadCompanyTeamPerformance() {
    const box = document.getElementById('companyTeamPerformance');
    if (!box) return false;
    if (!wired) wired = wire(box);
    if (!wired) return false;

    return reloadPerformance();
}

function wire(box) {
    boxEl = box;
    boxEl.innerHTML = `
        <p class="panel-subtitle">أداء أعضاء فريق شركتك في تذاكر الشركة — التقييمات والمحادثات
            إجمالي شركة فقط، لأن المحادثة بلا رابط تذكرة فلا إسناد صادق لعضو بعينه.</p>
        <div class="company-team-performance-toolbar">
            <div class="view-tabs" role="tablist" data-team-periods>
                ${[[7, '7 أيام'], [30, '30 يومًا'], [90, '90 يومًا']].map(([d, label]) => `
                    <button type="button" role="tab" class="view-tab" aria-selected="${d === 30}"
                        data-team-period="${d}">${escapeHtml(label)}</button>`).join('')}
            </div>
            <form data-team-custom>
                <label>من <input type="date" name="from" class="form-control"></label>
                <label>إلى <input type="date" name="to" class="form-control"></label>
                <button type="submit" class="btn btn-secondary btn-sm">عرض الفترة</button>
            </form>
        </div>
        <div id="companyTeamPerformanceBody"></div>`;
    bodyEl = boxEl.querySelector('#companyTeamPerformanceBody');
    boxEl.addEventListener('click', onClick);
    boxEl.addEventListener('submit', onSubmit);
    return true;
}

function currentWindow() {
    if (windowSel.preset) return presetWindow(windowSel.preset);
    return { from: windowSel.from, to: windowSel.to };
}

async function reloadPerformance() {
    const { from, to } = currentWindow();
    renderSkeletonLines(bodyEl, 4);
    const res = await fetchTeamPerformance(from, to);
    if (!res.ok) {
        renderState(bodyEl, {
            variant: 'error', title: 'تعذّر تحميل أداء الفريق',
            text: res.error || 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'teamPerformance', variant: 'btn-primary' }
        });
        return false;
    }
    if (!res.data) {
        payload = null;
        renderState(bodyEl, {
            variant: 'empty', title: 'أداء الفريق غير متاح لحسابك',
            text: 'هذه الصفحة لمدير الشركة والمشرف. إن كنت من الفريق وتحتاجها، اطلب دور المشرف.'
        });
        return true;
    }
    payload = res.data;
    renderPerformance();
    return true;
}

function renderPerformance() {
    const totals = teamPerformanceTotals(payload);
    const rows = sortRows(teamPerformanceRows(payload), sort.key, sort.dir);
    bodyEl.innerHTML = `
        <p class="panel-subtitle">الفترة: من ${escapeHtml(totals.from || '—')} إلى ${escapeHtml(totals.to || '—')}
            ${totals.generatedAt ? ` · حُسبت في ${escapeHtml(formatDate(totals.generatedAt))}` : ''}</p>
        <div class="company-team-totals">
            <span class="pill">أُنشئت: ${escapeHtml(String(totals.ticketsCreated))}</span>
            <span class="pill">حُلّت: ${escapeHtml(String(totals.ticketsResolved))}</span>
            <span class="pill">مفتوحة الآن: ${escapeHtml(String(totals.ticketsOpenNow))}</span>
            <span class="pill">متوسط أول رد: ${escapeHtml(formatHours(totals.avgFirstResponseHours))}</span>
            <span class="pill">متوسط الحل: ${escapeHtml(formatHours(totals.avgResolutionHours))}</span>
            <span class="pill">التقييمات: ${escapeHtml(String(totals.ratings.count))} · المتوسط ${escapeHtml(totals.ratings.avg === null ? '—' : String(totals.ratings.avg))}</span>
            <span class="pill">المحادثات: ${escapeHtml(String(totals.chat.sessions))} جلسة · ${escapeHtml(String(totals.chat.messages))} رسالة</span>
        </div>
        ${rows.length ? `
        <table class="company-team-table">
            <thead><tr>
                ${[['name', 'العضو', true], ['resolved', 'حلّ', true], ['ticketsCreated', 'أنشأ', false], ['firstResponse', 'متوسط أول رد', true],
                   ['resolution', 'متوسط الحل', true], ['replies', 'ردود علنية', true], ['notes', 'ملاحظات داخلية', false],
                   ['chats', 'محادثات', false], ['rating', 'التقييم', false]].map(([key, label, sortable]) => sortable ? `
                    <th><button type="button" data-team-sort="${key}" aria-sort="${sort.key === key ? sort.dir : 'none'}"
                        >${escapeHtml(label)}${sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`
                    : `<th>${escapeHtml(label)}</th>`).join('')}
            </tr></thead>
            <tbody>${rows.map(r => `
                <tr>
                    <td><span class="company-team-initials">${escapeHtml(initialsOf(r.name))}</span>
                        ${escapeHtml(r.name)} <span class="panel-subtitle">${escapeHtml(r.roleLabel || '')}</span></td>
                    <td>${escapeHtml(String(r.resolved))}</td>
                    <td>${escapeHtml(String(r.ticketsCreated))}</td>
                    <td>${escapeHtml(formatHours(r.firstResponseHours))}</td>
                    <td>${escapeHtml(formatHours(r.resolutionHours))}</td>
                    <td>${escapeHtml(String(r.replies))}</td>
                    <td>${escapeHtml(String(r.notes))}</td>
                    <td>—</td>
                    <td>—</td>
                </tr>`).join('')}</tbody>
        </table>
        <p class="panel-subtitle">«—» في عمودي المحادثات والتقييم: لا إسناد صادق لهما لعضو بعينه —
            إجمالياهما في الأعلى على مستوى الشركة. ولا عمود «مفتوحة» لكل عضو: الحزمة تعطي المفتوحة إجماليًا فقط.</p>`
            : '<p class="panel-subtitle">لا أعضاء في الفريق بعد — أضف فريقًا من قسم أعضاء الفريق.</p>'}`;
}

function onClick(event) {
    const period = event.target.closest('[data-team-period]');
    if (period) {
        windowSel = { preset: Number(period.getAttribute('data-team-period')), from: null, to: null };
        boxEl.querySelectorAll('[data-team-period]').forEach(b =>
            b.setAttribute('aria-selected', String(b === period)));
        reloadPerformance();
        return;
    }
    const sorter = event.target.closest('[data-team-sort]');
    if (sorter && payload) {
        const key = sorter.getAttribute('data-team-sort');
        if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else sort = { key, dir: key === 'name' || key === 'firstResponse' || key === 'resolution' ? 'asc' : 'desc' };
        renderPerformance();
    }
}

function onSubmit(event) {
    const form = event.target.closest('[data-team-custom]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const from = String(data.get('from') || '');
    const to = String(data.get('to') || '');
    const check = validateWindow(from, to);
    if (!check.ok) { ui?.showToast?.(check.error, 'error'); return; }
    windowSel = { preset: null, from, to };
    boxEl.querySelectorAll('[data-team-period]').forEach(b => b.setAttribute('aria-selected', 'false'));
    reloadPerformance();
}
