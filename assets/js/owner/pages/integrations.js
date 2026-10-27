/**
 * owner/integrations.html — وصول الأنظمة الخارجية تحت إشراف المالك.
 *
 *   • api_tokens: «Admin can view/update any api token» ← is_admin() (المالك في سياقه). الكتابة هنا الإيقاف
 *     والتفعيل وحدهما (is_active/revoked_at)؛ أعمدة الاعتماد مرفوضة لكل JWT بحارس 110 مهما أُرسل.
 *   • api_token_usage_logs: القراءة ← is_admin().
 *   • external_integrations: القراءة لنطاق platform للجميع، والتحديث لنطاق platform ← is_admin(). الأعمدة
 *     مسمّاة: credentials_encrypted لا تُطلب أبدًا.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock,
    writeResult, friendlyError
} from '/assets/js/owner/owner-page.js';
import { ROLE_LABELS, label, searchTerm } from '/assets/js/owner/owner-labels.js';

const $ = (id) => document.getElementById(id);
let tokens = [];
const people = new Map();
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

async function loadPeople(ids) {
    const missing = [...new Set(ids.filter(id => id && !people.has(id)))];
    if (!missing.length) return;
    const { data } = await supabase.from('profiles').select('id, full_name, email, role').in('id', missing);
    (data || []).forEach(p => people.set(p.id, p));
}

const tokenLive = (t) => t.is_active && !t.revoked_at && (!t.expires_at || new Date(t.expires_at) > new Date());

async function loadTokens() {
    $('tokensTable').innerHTML = loadingBlock();
    const { data, error } = await supabase.from('api_tokens')
        .select('id, user_id, name, description, is_active, revoked_at, expires_at, created_at, last_used_at, usage_count, credential_type, created_by_role, secret_last_four')
        .order('created_at', { ascending: false });
    if (error) { $('tokensTable').innerHTML = errorBlock(friendlyError(error)); tokens = []; return; }
    tokens = data || [];
    await loadPeople(tokens.map(t => t.user_id));
    renderTokens();
}

function renderTokens() {
    const term = searchTerm($('tokensSearch').value).toLowerCase();
    const state = $('tokensState').value;
    const rows = tokens.filter(t => {
        if (state === 'active' && !tokenLive(t)) return false;
        if (state === 'inactive' && tokenLive(t)) return false;
        if (!term) return true;
        const p = people.get(t.user_id);
        return [t.name, p?.full_name, p?.email].some(v => String(v || '').toLowerCase().includes(term));
    });
    const box = $('tokensTable');
    box.innerHTML = table(['المفتاح', 'صاحبه', 'النوع', 'الحالة', 'الاستخدام', 'آخر استخدام', ''], rows, t => {
        const p = people.get(t.user_id);
        const live = tokenLive(t);
        const expired = t.expires_at && new Date(t.expires_at) <= new Date();
        return `<tr>
            <td><div class="owner-account">
                <span class="owner-account-name">${esc(t.name || '—')}</span>
                ${t.secret_last_four ? `<span class="owner-account-email owner-mono">••••${esc(t.secret_last_four)}</span>` : ''}
            </div></td>
            <td><div class="owner-account">
                <span class="owner-account-name">${esc(p?.full_name || p?.email || t.user_id)}</span>
                <span class="owner-account-email">${esc(label(ROLE_LABELS, p?.role))}</span>
            </div></td>
            <td>${esc(t.credential_type || '—')}</td>
            <td>${live ? '<span class="pill status-resolved">فعّال</span>'
                : expired ? '<span class="pill status-neutral">منتهٍ</span>'
                : '<span class="pill status-rejected">موقوف</span>'}</td>
            <td>${esc(num(t.usage_count || 0))}</td>
            <td>${esc(when(t.last_used_at))}</td>
            <td>${expired ? '' : t.is_active && !t.revoked_at
                ? `<button type="button" class="btn btn-outline btn-sm" data-token="${esc(t.id)}" data-active="false">إيقاف</button>`
                : `<button type="button" class="btn btn-primary btn-sm" data-token="${esc(t.id)}" data-active="true">تفعيل</button>`}</td>
        </tr>`;
    }, { empty: tokens.length ? 'لا مفاتيح مطابقة.' : 'لا مفاتيح API على المنصة.' });

    box.querySelectorAll('[data-token]').forEach(b => b.addEventListener('click', () =>
        setToken(tokens.find(t => t.id === b.dataset.token), b.dataset.active === 'true', b)));
    renderKpis();
}

async function setToken(token, active, btn) {
    if (!token) return;
    const owner = people.get(token.user_id);
    const question = active
        ? `إعادة تفعيل المفتاح «${token.name}»؟ سيعود صاحبه (${owner?.email || ''}) للوصول به.`
        : `إيقاف المفتاح «${token.name}»؟ كل نظام يستعمله يفقد الوصول فورًا.`;
    if (!window.confirm(question)) return;
    btn.disabled = true;
    const patch = active ? { is_active: true, revoked_at: null } : { is_active: false, revoked_at: new Date().toISOString() };
    const result = writeResult(await supabase.from('api_tokens').update(patch).eq('id', token.id).select('id'));
    if (!result.ok) { btn.disabled = false; say(result.message, 'error'); return; }
    say(active ? 'تم تفعيل المفتاح.' : 'تم إيقاف المفتاح.', 'success');
    loadTokens();
}

let platform = [];
async function loadPlatform() {
    $('platformIntegrations').innerHTML = loadingBlock();
    const { data, error } = await supabase.from('external_integrations')
        .select('id, provider, display_name, protocol, is_active, last_tested_at, last_test_status, last_test_message, last_used_at, priority')
        .eq('owner_scope', 'platform').order('priority', { ascending: true });
    if (error) { $('platformIntegrations').innerHTML = errorBlock(friendlyError(error)); platform = []; renderKpis(); return; }
    platform = data || [];
    const box = $('platformIntegrations');
    box.innerHTML = table(['التكامل', 'البروتوكول', 'الحالة', 'آخر اختبار', 'آخر استخدام', ''], platform, i => `<tr>
        <td><div class="owner-account">
            <span class="owner-account-name">${esc(i.display_name || i.provider)}</span>
            <span class="owner-account-email">${esc(i.provider)}</span>
        </div></td>
        <td>${esc(i.protocol || '—')}</td>
        <td>${i.is_active ? '<span class="pill status-resolved">مفعّل</span>' : '<span class="pill status-neutral">معطّل</span>'}</td>
        <td>${i.last_tested_at
            ? `<span class="pill ${i.last_test_status === 'success' || i.last_test_status === 'ok' ? 'status-resolved' : 'status-rejected'}">${esc(i.last_test_status || '—')}</span>
               <span class="owner-cell-muted">${esc(when(i.last_tested_at))}</span>`
            : '<span class="owner-cell-muted">لم يُختبر</span>'}</td>
        <td>${esc(when(i.last_used_at))}</td>
        <td><button type="button" class="btn btn-sm ${i.is_active ? 'btn-outline' : 'btn-primary'}" data-integration="${esc(i.id)}" data-active="${i.is_active ? 'false' : 'true'}">${i.is_active ? 'تعطيل' : 'تفعيل'}</button></td>
    </tr>`, { empty: 'لا تكاملات بنطاق المنصة.' });
    box.querySelectorAll('[data-integration]').forEach(b => b.addEventListener('click', async () => {
        const item = platform.find(i => i.id === b.dataset.integration);
        const active = b.dataset.active === 'true';
        if (!window.confirm(`${active ? 'تفعيل' : 'تعطيل'} «${item?.display_name || item?.provider}» لكل المنصة؟`)) return;
        b.disabled = true;
        const result = writeResult(await supabase.from('external_integrations').update({ is_active: active }).eq('id', item.id).select('id'));
        if (!result.ok) { b.disabled = false; say(result.message, 'error'); return; }
        say(active ? 'تم تفعيل التكامل.' : 'تم تعطيل التكامل.', 'success');
        loadPlatform();
    }));
    renderKpis();
}

async function loadUsage() {
    $('usageTable').innerHTML = loadingBlock();
    const { data, error } = await supabase.from('api_token_usage_logs')
        .select('id, token_id, user_id, endpoint, method, status_code, ip_address, created_at')
        .order('created_at', { ascending: false }).limit(50);
    if (error) { $('usageTable').innerHTML = errorBlock(friendlyError(error)); return; }
    const rows = data || [];
    await loadPeople(rows.map(r => r.user_id));
    $('usageTable').innerHTML = table(['الطلب', 'النتيجة', 'الحساب', 'IP', 'الوقت'], rows, r => {
        const p = people.get(r.user_id);
        const ok = Number(r.status_code) < 400;
        return `<tr>
            <td><span class="owner-mono">${esc(r.method || '')} ${esc(r.endpoint || '')}</span></td>
            <td><span class="pill ${ok ? 'status-resolved' : 'status-rejected'}">${esc(r.status_code ?? '—')}</span></td>
            <td>${esc(p?.full_name || p?.email || '—')}</td>
            <td dir="ltr">${esc(r.ip_address || '—')}</td>
            <td>${esc(when(r.created_at))}</td>
        </tr>`;
    }, { empty: 'لا استدعاءات مسجّلة بعد.' });
}

function renderKpis() {
    const live = tokens.filter(tokenLive).length;
    const usedWeek = tokens.filter(t => t.last_used_at && new Date(t.last_used_at) > new Date(Date.now() - 7 * 864e5)).length;
    const failing = platform.filter(i => i.is_active && i.last_test_status && !['success', 'ok'].includes(i.last_test_status)).length;
    $('integrationsKpis').innerHTML = kpis([
        ['مفاتيح API فعّالة', num(live), 'kpi--success'],
        ['موقوفة أو منتهية', num(tokens.length - live), ''],
        ['استُخدمت خلال 7 أيام', num(usedWeek), 'kpi--info'],
        ['تكاملات المنصة المفعّلة', num(platform.filter(i => i.is_active).length), ''],
        ['آخر اختبار فاشل', num(failing), failing ? 'kpi--danger' : '']
    ]);
}

(async function init() {
    if (!await bootOwnerPage()) return;
    $('tokensFilters').addEventListener('submit', (e) => { e.preventDefault(); renderTokens(); });
    $('tokensSearch').addEventListener('input', renderTokens);
    $('tokensState').addEventListener('change', renderTokens);
    $('integrationsRefresh').addEventListener('click', () => { loadTokens(); loadPlatform(); loadUsage(); });
    loadTokens();
    loadPlatform();
    loadUsage();
})();
