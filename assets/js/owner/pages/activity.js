/**
 * owner/activity.html — سجل نشاط المنصة.
 *
 * القراءة: activity_logs_select_policy ← has_elevated_authority() (المالك في سياقه). السجل للقراءة وحدها:
 * لا سياسة تعديل ولا حذف عليه لأي دور، والصفحة لا تحاول.
 * الحمولة (details) كتبها غير المالك، فتُعرض نصًا مهرَّبًا لا HTML — صفحة الإدارة القديمة كانت تحقنها كما هي.
 */
import {
    supabase, bootOwnerPage, esc, when, table, errorBlock, loadingBlock, friendlyError, renderPager
} from '/assets/js/owner/owner-page.js';
import { ROLE_LABELS, ACTION_LABELS, label, searchTerm, pageRange, pagerText } from '/assets/js/owner/owner-labels.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;
let page = 0;
const people = new Map();

async function loadActions() {
    const { data } = await supabase.from('activity_logs').select('action')
        .order('created_at', { ascending: false }).limit(1000);
    const actions = [...new Set((data || []).map(r => r.action).filter(Boolean))].sort();
    const sel = $('activityAction');
    const current = sel.value;
    sel.innerHTML = '<option value="">كل الأحداث</option>' + actions
        .map(a => `<option value="${esc(a)}" ${a === current ? 'selected' : ''}>${esc(ACTION_LABELS[a] || a)}</option>`).join('');
}

async function userIds(term) {
    const { data, error } = await supabase.from('profiles').select('id, full_name, email')
        .or(`email.ilike.*${term}*,full_name.ilike.*${term}*`).limit(50);
    if (error) throw error;
    (data || []).forEach(p => people.set(p.id, p));
    return (data || []).map(p => p.id);
}

async function loadPeople(ids) {
    const missing = [...new Set(ids.filter(id => id && !people.has(id)))];
    if (!missing.length) return;
    const { data } = await supabase.from('profiles').select('id, full_name, email').in('id', missing);
    (data || []).forEach(p => people.set(p.id, p));
}

async function load() {
    const box = $('activityTable');
    box.innerHTML = loadingBlock();
    let q = supabase.from('activity_logs')
        .select('id, user_id, user_role, action, details, created_at, ip_address, device_info, location_info, session_duration', { count: 'exact' })
        .order('created_at', { ascending: false });
    const term = searchTerm($('activityUser').value);
    try {
        if (term) {
            const ids = await userIds(term);
            if (!ids.length) {
                box.innerHTML = table([], [], () => '', { empty: 'لا حساب يطابق هذا البحث.' });
                $('activityPager').hidden = true;
                return;
            }
            q = q.in('user_id', ids);
        }
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err));
        return;
    }
    if ($('activityAction').value) q = q.eq('action', $('activityAction').value);
    if ($('activityRole').value) q = q.eq('user_role', $('activityRole').value);
    if ($('activityFrom').value) q = q.gte('created_at', new Date(`${$('activityFrom').value}T00:00:00`).toISOString());
    if ($('activityTo').value) q = q.lte('created_at', new Date(`${$('activityTo').value}T23:59:59`).toISOString());

    const { data, error, count } = await q.range(...pageRange(page, PAGE_SIZE));
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); $('activityPager').hidden = true; return; }
    const rows = data || [];
    await loadPeople(rows.map(r => r.user_id));

    box.innerHTML = table(['الفاعل', 'الحدث', 'التفاصيل', 'الوقت'], rows, r => {
        const p = people.get(r.user_id);
        const place = r.location_info ? [r.location_info.city, r.location_info.country].filter(Boolean).join('، ') : '';
        const hasDetails = r.details && Object.keys(r.details).length;
        return `<tr>
            <td><div class="owner-account">
                <span class="owner-account-name">${esc(p?.full_name || p?.email || (r.user_id ? r.user_id.slice(0, 8) : 'زائر'))}</span>
                <span class="owner-account-email">${esc(label(ROLE_LABELS, r.user_role))}</span>
            </div></td>
            <td><span class="pill status-neutral">${esc(ACTION_LABELS[r.action] || r.action)}</span></td>
            <td>
                <span class="owner-cell-muted">${esc([r.device_info, place, r.ip_address].filter(Boolean).join(' · ') || '—')}</span>
                ${hasDetails ? `<details><summary class="panel-link">الحمولة</summary><pre class="owner-json">${esc(JSON.stringify(r.details, null, 2))}</pre></details>` : ''}
            </td>
            <td>${esc(when(r.created_at))}</td>
        </tr>`;
    }, { empty: 'لا أحداث مطابقة للتصفية.' });
    renderPager($('activityPager'), {
        page, size: PAGE_SIZE, total: count || 0, text: pagerText(page, PAGE_SIZE, count || 0),
        onPage: (p) => { page = p; load(); }
    });
}

(async function init() {
    if (!await bootOwnerPage()) return;
    const user = new URLSearchParams(location.search).get('user');
    if (user) $('activityUser').value = user;
    $('activityFilters').addEventListener('submit', (e) => { e.preventDefault(); page = 0; load(); });
    ['activityAction', 'activityRole', 'activityFrom', 'activityTo']
        .forEach(id => $(id).addEventListener('change', () => { page = 0; load(); }));
    $('activityRefresh').addEventListener('click', () => { loadActions(); load(); });
    loadActions();
    load();
})();
