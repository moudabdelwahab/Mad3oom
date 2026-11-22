/**
 * owner/muse-activity-log.html — سجل نشاط الوكيل (Muse الداخلي).
 *
 * القراءة: agent_activity_log وحدها — لا جدول آخر. الأحدث أولًا، وكل صف
 * يُرسم كما سُجّل: لا صفوف مخترعة، ولا «أحداث متوقعة». التفاصيل (details)
 * حمولة كتبها الوكيل أو الجسر، فتُعرض نصًا مهرَّبًا داخل <details> لا HTML.
 *
 * سياسات السجل: قراءة للمالك والإداري (is_admin) أو لمالك الجلسة المرتبطة؛
 * كتابة للإداري فقط؛ لا تحديث ولا حذف لأي دور — السجل للقراءة وحدها.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, table, errorBlock, loadingBlock, friendlyError, renderPager
} from '/assets/js/owner/owner-page.js';
import {
    LOG_COLUMNS, LOG_PAGE_SIZE, actionLabel, modelLabel, shortId, formatDetails
} from '/assets/js/owner/muse-agent-activity-state.js';

const $ = (id) => document.getElementById(id);
let page = 0;

const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

async function loadActions() {
    // انقطاع الشبكة يرمي: بلا التقاط تتوقف init كلها فلا يعمل التصفية ولا الجدول.
    let data = null;
    try {
        ({ data } = await supabase.from('agent_activity_log').select('action')
            .order('created_at', { ascending: false }).limit(1000));
    } catch (err) {
        console.error('[MuseActivityLog] loadActions:', err?.message || err);
        return;
    }
    const actions = [...new Set((data || []).map(r => r.action).filter(Boolean))].sort();
    const sel = $('museLogAction');
    const current = sel.value;
    sel.innerHTML = '<option value="">كل الأحداث</option>' + actions
        .map(a => `<option value="${esc(a)}" ${a === current ? 'selected' : ''}>${esc(actionLabel(a))}</option>`).join('');
}

async function load() {
    const box = $('museLogTable');
    box.innerHTML = loadingBlock();
    let q = supabase.from('agent_activity_log').select(LOG_COLUMNS, { count: 'exact' })
        .order('created_at', { ascending: false });
    if ($('museLogAction').value) q = q.eq('action', $('museLogAction').value);
    if ($('museLogModel').value) q = q.eq('model_id', $('museLogModel').value);
    if ($('museLogFrom').value) q = q.gte('created_at', new Date(`${$('museLogFrom').value}T00:00:00`).toISOString());
    if ($('museLogTo').value) q = q.lte('created_at', new Date(`${$('museLogTo').value}T23:59:59`).toISOString());

    const from = page * LOG_PAGE_SIZE;
    // انقطاع الشبكة يرمي: بلا التقاط يبقى الهيكل العظمي بلا تفسير.
    let data, error, count;
    try {
        ({ data, error, count } = await q.range(from, from + LOG_PAGE_SIZE - 1));
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err));
        $('museLogPager').hidden = true;
        return;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); $('museLogPager').hidden = true; return; }
    const rows = data || [];

    box.innerHTML = table(['الحدث', 'النموذج', 'الجلسة', 'التفاصيل', 'الوقت'], rows, r => {
        const details = formatDetails(r.details);
        return `<tr>
            <td><span class="pill status-neutral">${esc(actionLabel(r.action))}</span></td>
            <td>${esc(modelLabel(r.model_id))}</td>
            <td><span class="owner-cell-muted">${esc(shortId(r.session_id))}</span></td>
            <td>${details === '—'
                ? '<span class="owner-cell-muted">—</span>'
                : `<details class="muse-log-details"><summary class="panel-link">الحمولة</summary><pre class="owner-json">${esc(details)}</pre></details>`}</td>
            <td>${esc(when(r.created_at))}</td>
        </tr>`;
    }, { empty: 'لا أحداث مسجّلة بعد — السجل يعرض فقط ما سجّله الوكيل فعلًا.' });
    const total = count || 0;
    const shownFrom = total ? from + 1 : 0;
    const shownTo = Math.min(total, from + rows.length);
    renderPager($('museLogPager'), {
        page, size: LOG_PAGE_SIZE, total,
        text: total ? `${shownFrom}–${shownTo} من ${total}` : '',
        onPage: (p) => { page = p; load(); }
    });
}

(async function init() {
    if (!await bootOwnerPage()) return;
    $('museLogFilters').addEventListener('submit', (e) => { e.preventDefault(); page = 0; load(); });
    ['museLogAction', 'museLogModel', 'museLogFrom', 'museLogTo']
        .forEach(id => $(id).addEventListener('change', () => { page = 0; load(); }));
    $('museLogRefresh').addEventListener('click', () => { loadActions(); load(); say('تم التحديث.'); });
    loadActions();
    load();
})();
