/**
 * team-performance.js — شاشة «أداء الفريق» (admin/team-performance.html).
 *
 * القراءة فقط: الأرقام كلها من team-performance-model.js على صفوف يراها
 * الطاقم عبر RLS. والتحديث لحظي: أي تغيير في التذاكر أو ردودها أو تقييماتها
 * أو ردود المحادثات يعيد الحساب.
 */
import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { fetchSupportAgents } from '/tickets-service.js';
import { ICONS } from './ticket-icons.js';
import {
    PERIODS, DEFAULT_PERIOD, periodStart, buildTeamPerformance, sortRows, NATURAL_DIR,
    formatHours, formatPercent, slaTone, dailyResolved, isOverdue, OPEN_STATUSES, initialsOf
} from './team-performance-model.js';

const PAGE = 1000;               // حد PostgREST الافتراضي للصفوف في الطلب الواحد
const PERIOD_KEY = 'mad3oom_team_perf_period';
const TICKET_COLS = 'id, ticket_number, title, status, priority, assigned_to, created_at, first_response_at, resolved_at, last_updated_at, sla_resolution_due_at';

const state = {
    period: DEFAULT_PERIOD,
    sort: { key: 'resolved', dir: 'desc' },
    agents: [], tickets: [], replies: [], ratings: [], chatReplies: [],
    failed: new Set(),
    perf: null,
    selected: null,
    loading: false,
    reloadTimer: null
};

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function agentColor(id) {
    const palette = ['#4DA3FF', '#22C58B', '#F5A623', '#B45FE0', '#FF6B6B', '#25D366'];
    let hash = 0;
    for (const ch of String(id || '')) hash = (hash * 31 + ch.charCodeAt(0)) % palette.length;
    return palette[hash];
}

function readPeriod() {
    const fromUrl = new URLSearchParams(location.search).get('period');
    if (fromUrl && PERIODS[fromUrl]) return fromUrl;
    try { const saved = localStorage.getItem(PERIOD_KEY); if (saved && PERIODS[saved]) return saved; } catch { /* تخزين غير متاح */ }
    return DEFAULT_PERIOD;
}

/** يقرأ كل صفوف الاستعلام على دفعات — بدون كده الأرقام بتقف عند أول 1000 صف. */
async function fetchAll(build) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await build().range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE) return rows;
    }
}

async function safeLoad(name, fn) {
    try { const rows = await fn(); state.failed.delete(name); return rows; }
    catch (err) { console.error(`[TeamPerformance] ${name}:`, err?.message || err); state.failed.add(name); return []; }
}

async function loadData() {
    if (state.loading) return;
    state.loading = true;
    const since = periodStart(state.period).toISOString();
    const [agents, tickets, replies, ratings, chatReplies] = await Promise.all([
        safeLoad('agents', () => fetchSupportAgents()),
        safeLoad('tickets', () => fetchAll(() => supabase.from('tickets').select(TICKET_COLS).order('created_at', { ascending: false }))),
        safeLoad('replies', () => fetchAll(() => supabase.from('ticket_replies').select('user_id, is_internal, created_at').gte('created_at', since).order('created_at', { ascending: false }))),
        safeLoad('ratings', () => fetchAll(() => supabase.from('ticket_ratings').select('ticket_id, rating, created_at').gte('created_at', since).order('created_at', { ascending: false }))),
        safeLoad('chats', () => fetchAll(() => supabase.from('chat_messages').select('sender_id, created_at').eq('is_admin_reply', true).gte('created_at', since).order('created_at', { ascending: false })))
    ]);
    Object.assign(state, { agents, tickets, replies, ratings, chatReplies });
    state.loading = false;
    compute();
}

function compute() {
    state.perf = buildTeamPerformance({
        agents: state.agents, tickets: state.tickets, replies: state.replies, ratings: state.ratings,
        chatReplies: state.chatReplies, since: periodStart(state.period), now: Date.now()
    });
    renderTeam();
    renderBoard();
    if (state.selected) renderDrawer(state.selected);
    $('lastUpdated').textContent = 'آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ==================== أرقام الفريق ==================== */

function stars(avg) {
    if (avg === null) return '';
    const full = Math.round(avg);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function renderTeam() {
    const t = state.perf.team;
    const sla = slaTone(t.sla.rate);
    const cards = [
        { icon: ICONS.check, cls: 'ok', label: 'التذاكر المحلولة', value: t.resolved, sub: PERIODS[state.period].label },
        { icon: ICONS.message, cls: '', label: 'متوسط أول رد', value: formatHours(t.firstResponseHours), sub: 'من فتح التذكرة' },
        { icon: ICONS.clock, cls: 'warn', label: 'متوسط زمن الحل', value: formatHours(t.resolutionHours), sub: 'من فتح التذكرة لحلها' },
        { icon: ICONS.alertTriangle, cls: sla === 'bad' ? 'danger' : sla === 'warn' ? 'warn' : 'ok', label: 'الالتزام بالـ SLA', value: formatPercent(t.sla.rate), sub: t.sla.total ? `${t.sla.met} من ${t.sla.total} في الموعد` : 'لا توجد تذاكر بموعد' },
        { icon: ICONS.star, cls: 'star', label: 'رضا العملاء', value: t.rating.average === null ? '—' : t.rating.average.toFixed(1), sub: t.rating.count ? `${t.rating.count} تقييم` : 'لا توجد تقييمات' },
        { icon: ICONS.userQuestion, cls: t.unassigned ? 'danger' : 'ok', label: 'مفتوحة بدون مسؤول', value: t.unassigned, sub: t.overdue ? `${t.overdue} متأخرة عن الـ SLA` : 'لا توجد تذاكر متأخرة' }
    ];
    $('teamStats').innerHTML = cards.map(c => `
        <div class="stat-card glass-card">
            <div class="stat-icon ${c.cls}">${c.icon}</div>
            <div class="stat-info">
                <div class="stat-label">${esc(c.label)}</div>
                <div class="stat-value">${esc(c.value)}</div>
                <div class="stat-sub">${esc(c.sub)}</div>
            </div>
        </div>`).join('');
}

/* ==================== جدول الموظفين ==================== */

function renderBoard() {
    const body = $('perfBody');
    const rows = sortRows(state.perf.rows, state.sort.key, state.sort.dir);
    document.querySelectorAll('table.perf th[data-sort]').forEach(th => {
        const on = th.dataset.sort === state.sort.key;
        th.classList.toggle('sorted', on);
        th.querySelector('.arrow')?.remove();
        if (on) th.insertAdjacentHTML('beforeend', `<span class="arrow">${state.sort.dir === 'asc' ? '▲' : '▼'}</span>`);
    });

    if (state.failed.has('tickets')) {
        body.innerHTML = `<tr><td colspan="10" class="empty-state">تعذّر تحميل التذاكر. جرّب التحديث.</td></tr>`;
        return;
    }
    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="10" class="empty-state">لا يوجد موظفو دعم بعد. أضف موظفًا برتبة «دعم فني» من صفحة المستخدمين.</td></tr>`;
        return;
    }

    const maxResolved = Math.max(1, ...rows.map(r => r.resolved));
    const na = (name) => state.failed.has(name);
    body.innerHTML = rows.map((r, i) => {
        const tone = slaTone(r.sla.rate);
        return `
        <tr data-agent="${esc(r.id)}" class="${state.selected === r.id ? 'selected' : ''}">
            <td class="rank">${i + 1}</td>
            <td>
                <div class="agent-cell">
                    <span class="avatar" style="background:${agentColor(r.id)}">${esc(initialsOf(r.name))}</span>
                    <div><div class="agent-name">${esc(r.name)}</div><div class="agent-role">${esc(r.roleLabel)}</div></div>
                </div>
            </td>
            <td>
                <span class="num">${r.openCount}</span>
                ${r.overdue ? `<span class="pill tone-bad" style="margin-inline-start:.4rem">${r.overdue} متأخرة</span>` : ''}
            </td>
            <td>
                <div class="bar-cell">
                    <span class="num" style="min-width:1.6rem">${r.resolved}</span>
                    <span class="bar-track"><span class="bar-fill" style="width:${Math.round(r.resolved / maxResolved * 100)}%"></span></span>
                </div>
            </td>
            <td class="num ${r.firstResponseHours === null ? 'muted' : ''}">${formatHours(r.firstResponseHours)}</td>
            <td class="num ${r.resolutionHours === null ? 'muted' : ''}">${formatHours(r.resolutionHours)}</td>
            <td><span class="pill tone-${tone}">${formatPercent(r.sla.rate)}</span>${r.sla.total ? `<span class="muted" style="font-size:.72rem; margin-inline-start:.4rem">${r.sla.met}/${r.sla.total}</span>` : ''}</td>
            <td class="num">${na('replies') ? '—' : r.replies}</td>
            <td class="num">${na('chats') ? '—' : r.chatReplies}</td>
            <td>${na('ratings') || r.rating.average === null ? '<span class="muted">—</span>'
                : `<span class="stars">${stars(r.rating.average)}</span> <span class="num">${r.rating.average.toFixed(1)}</span> <span class="muted" style="font-size:.72rem">(${r.rating.count})</span>`}</td>
        </tr>`;
    }).join('');
}

/* ==================== تفاصيل الموظف ==================== */

const STATUS_LABEL = { open: 'مفتوحة', 'in-progress': 'قيد المعالجة' };

function renderDrawer(agentId) {
    const r = state.perf.rows.find(x => x.id === agentId);
    if (!r) { closeDrawer(); return; }

    $('drawerHead').innerHTML = `
        <span class="avatar" style="background:${agentColor(r.id)}">${esc(initialsOf(r.name))}</span>
        <div>
            <h3>${esc(r.name)}</h3>
            <div class="agent-role">${esc(r.roleLabel)}${r.email ? ' · ' + esc(r.email) : ''}</div>
        </div>
        <button class="icon-btn drawer-close" id="drawerClose" aria-label="إغلاق">${ICONS.close}</button>`;

    const trend = dailyResolved(state.tickets, r.id, { days: 14 });
    const peak = Math.max(1, ...trend.map(d => d.count));
    const fmtDay = (d) => d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
    const now = Date.now();
    const open = state.tickets
        .filter(t => t.assigned_to === r.id && OPEN_STATUSES.includes(t.status))
        .sort((a, b) => Number(isOverdue(b, now)) - Number(isOverdue(a, now)) || new Date(a.created_at) - new Date(b.created_at));

    $('drawerBody').innerHTML = `
        <div class="mini-grid">
            <div class="mini"><div class="v">${r.resolved}</div><div class="l">محلولة · ${esc(PERIODS[state.period].label)}</div></div>
            <div class="mini"><div class="v">${r.openCount}</div><div class="l">الحِمل الحالي</div></div>
            <div class="mini"><div class="v">${formatPercent(r.sla.rate)}</div><div class="l">الالتزام بالـ SLA</div></div>
            <div class="mini"><div class="v">${formatHours(r.firstResponseHours)}</div><div class="l">متوسط أول رد</div></div>
            <div class="mini"><div class="v">${formatHours(r.resolutionHours)}</div><div class="l">متوسط زمن الحل</div></div>
            <div class="mini"><div class="v">${r.rating.average === null ? '—' : r.rating.average.toFixed(1) + ' ★'}</div><div class="l">${r.rating.count} تقييم</div></div>
        </div>

        <p class="section-label">التذاكر المحلولة يوميًا (آخر 14 يوم)</p>
        <div class="trend">
            ${trend.map(d => `<div class="col" title="${esc(fmtDay(d.day))}: ${d.count}"><div class="b ${d.count ? '' : 'zero'}" style="height:${d.count ? Math.max(8, Math.round(d.count / peak * 100)) : 4}%"></div></div>`).join('')}
        </div>
        <div class="trend-axis"><span>${esc(fmtDay(trend[0].day))}</span><span>اليوم</span></div>

        <p class="section-label">النشاط في الفترة</p>
        <div class="mini-grid" style="grid-template-columns:repeat(3,1fr)">
            <div class="mini"><div class="v">${r.replies}</div><div class="l">رد على التذاكر</div></div>
            <div class="mini"><div class="v">${r.notes}</div><div class="l">ملاحظة داخلية</div></div>
            <div class="mini"><div class="v">${r.chatReplies}</div><div class="l">رد في المحادثات</div></div>
        </div>

        <p class="section-label">التذاكر المسندة الآن (${open.length})</p>
        ${open.length ? open.map(t => `
            <a class="ticket-row" href="/admin/tickets.html">
                <div style="min-width:0">
                    <div class="t-title">#${esc(t.ticket_number ?? '')} ${esc(t.title || 'تذكرة')}</div>
                    <div class="t-meta">${esc(new Date(t.created_at).toLocaleDateString('ar-EG'))}</div>
                </div>
                <div style="display:flex; gap:.35rem; flex-shrink:0">
                    ${isOverdue(t, now) ? '<span class="pill tone-bad">تجاوز SLA</span>' : ''}
                    <span class="pill status-${esc(t.status)}">${esc(STATUS_LABEL[t.status] || t.status)}</span>
                </div>
            </a>`).join('') : '<div class="empty-state" style="padding:1.2rem">لا توجد تذاكر مفتوحة مسندة لهذا الموظف</div>'}`;

    $('drawerClose').addEventListener('click', closeDrawer);
}

function openDrawer(agentId) {
    state.selected = agentId;
    renderDrawer(agentId);
    $('agentDrawer').classList.add('open');
    $('agentDrawer').setAttribute('aria-hidden', 'false');
    $('drawerOverlay').classList.add('open');
    renderBoard();
}

function closeDrawer() {
    state.selected = null;
    $('agentDrawer').classList.remove('open');
    $('agentDrawer').setAttribute('aria-hidden', 'true');
    $('drawerOverlay').classList.remove('open');
    if (state.perf) renderBoard();
}

/* ==================== التحكم والتحديث اللحظي ==================== */

function renderPeriodPicker() {
    $('periodPicker').innerHTML = Object.entries(PERIODS).map(([key, p]) =>
        `<button type="button" role="tab" data-period="${key}" class="${key === state.period ? 'active' : ''}" aria-selected="${key === state.period}">${esc(p.label)}</button>`).join('');
}

function setupControls() {
    renderPeriodPicker();
    $('periodPicker').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-period]');
        if (!btn || btn.dataset.period === state.period) return;
        state.period = btn.dataset.period;
        try { localStorage.setItem(PERIOD_KEY, state.period); } catch { /* تخزين غير متاح */ }
        renderPeriodPicker();
        loadData();
    });

    $('refreshBtn').innerHTML = `${ICONS.refresh} تحديث`;
    $('refreshBtn').addEventListener('click', () => loadData());

    document.querySelectorAll('table.perf th[data-sort]').forEach(th => th.addEventListener('click', () => {
        const key = th.dataset.sort;
        state.sort = state.sort.key === key
            ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
            : { key, dir: NATURAL_DIR[key] || 'desc' };
        renderBoard();
    }));

    $('perfBody').addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-agent]');
        if (tr) openDrawer(tr.dataset.agent);
    });
    $('drawerOverlay').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDrawer(); });
}

function scheduleReload() {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(() => loadData(), 1200);
}

function setLive(on) {
    $('liveBadge').classList.toggle('off', !on);
    $('liveText').textContent = on ? 'تحديث لحظي' : 'التحديث اللحظي متوقف';
}

function subscribeLive() {
    supabase.channel('team-performance')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, scheduleReload)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ticket_replies' }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ticket_ratings' }, scheduleReload)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: 'is_admin_reply=eq.true' }, scheduleReload)
        .subscribe((status) => setLive(status === 'SUBSCRIBED'));
    // أزمنة الـ SLA بتتغير مع الوقت حتى لو مفيش كتابة جديدة.
    setInterval(() => { if (state.perf && !state.loading) compute(); }, 60000);
}

async function init() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    updateAdminUI(user);

    state.period = readPeriod();
    setupControls();
    await loadData();
    subscribeLive();
}

init();
