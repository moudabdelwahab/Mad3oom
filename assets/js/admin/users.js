/**
 * users.js — صفحة «المستخدمين» الموحّدة.
 *
 * تبويبان من هذه الصفحة نفسها: «كل المستخدمين» و«المحظورون» (نفس القائمة
 * مُفلترة)، ببحث وفلاتر وقائمة «خيارات» لكل صف تجمع كل الإجراءات القائمة.
 * وباقي التبويبات (العملاء، Super Users، مستخدميني، الطلبات، قائمة الانتظار)
 * صفحاتها القائمة نفسها مستضافة في إطار (وضع التضمين، embed-early.js) —
 * بأدواتها وحراسها ودوالها كما هي، بلا نسخة ثانية من منطقها.
 *
 * من يرى أي تبويب: visibleHubTabs() بنفس قواعد روابط القائمة الجانبية القديمة.
 * والإجراءات نفسها (الاستعلامات والتأكيدات والشروط) منقولة كما كانت حرفيًا؛
 * الفرض الحقيقي في RLS والدوال، لا في إخفاء زر.
 */
import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar, getAdminAccess } from './sidebar.js';
import { impersonateUser } from './admin-utils.js';
import { isCurrentUserSieAdmin, getSieAccessStatus, adminSetAccess, adminResetUsage } from '/assets/js/sie-client.js';
import { visibleHubTabs, resolveHubTab, filterUsers, userActions, roleLabel, isBanned } from './users-hub-model.js';

const $ = (id) => document.getElementById(id);

let user = null;
let currentOptionsUserId = null;
let isSieAdmin = false; // من is_sie_admin() فقط — نفس القاعدة اللي هتتفرض في RLS/RPC، مفيش تكرار للشرط هنا
let currentSieAccess = null; // صف customer_sie_access الخاص بالمستخدم اللي فاتح له نافذة SIE دلوقتي

let tabs = [];
let activeTab = null;
let allUsers = [];
let walletMap = new Map(); // user_id → is_frozen
const filters = { q: '', role: '', status: '', from: '', to: '', sort: 'newest' };

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    const access = await getAdminAccess();
    tabs = visibleHubTabs(access || {});
    renderTabs();

    isSieAdmin = await isCurrentUserSieAdmin(supabase);
    injectSiePanel();
    bindFilters();
    initOptionsMenu();

    if (tabs.some(t => t.id === 'all' || t.id === 'banned')) {
        await loadUsers();
        // تفعيل التحديث اللحظي لجدول المستخدمين
        supabase
            .channel('public:profiles')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadUsers())
            .subscribe();
    }

    window.addEventListener('hashchange', () => showTab(resolveHubTab(location.hash, tabs), { fromHash: true }));
    showTab(resolveHubTab(location.hash, tabs), { fromHash: true });
}

/* ── التبويبات ─────────────────────────────────────────────────────────── */

function renderTabs() {
    const nav = $('uhTabs');
    nav.replaceChildren(...tabs.map(t => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'uh-tab';
        b.id = `uhTab-${t.id}`;
        b.setAttribute('role', 'tab');
        b.dataset.tab = t.id;
        b.textContent = t.label;
        b.addEventListener('click', () => showTab(t.id));
        return b;
    }));
    // الأسهم بين التبويبات (RTL: السهم الأيسر للتالي)
    nav.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        const i = tabs.findIndex(t => t.id === activeTab);
        const rtl = getComputedStyle(nav).direction === 'rtl';
        const step = (e.key === 'ArrowLeft') === rtl ? 1 : -1;
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + step + tabs.length) % tabs.length;
        e.preventDefault();
        showTab(tabs[next].id);
        $(`uhTab-${tabs[next].id}`)?.focus();
    });
    if (!tabs.length) {
        $('uhFrames').innerHTML = '<p class="uh-empty">لا توجد أقسام متاحة لحسابك هنا.</p>';
    }
}

function showTab(id, { fromHash = false } = {}) {
    if (!id) return;
    activeTab = id;
    const tab = tabs.find(t => t.id === id);
    if (!fromHash && location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);

    document.querySelectorAll('.uh-tab').forEach(b => {
        const on = b.dataset.tab === id;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
    });

    const listPanel = $('uhListPanel');
    const isList = !tab.src;
    listPanel.hidden = !isList;
    listPanel.setAttribute('aria-labelledby', `uhTab-${id}`);
    document.querySelectorAll('.uh-frame').forEach(f => { f.hidden = f.dataset.tab !== id; });

    if (isList) {
        // «المحظورون» = نفس القائمة بحالة ثابتة؛ فلتر الحالة لا معنى له فيها
        $('uhStatusField').hidden = id === 'banned';
        renderUsers();
    } else {
        ensureFrame(tab);
    }
}

/** الصفحة المستضافة تُحمَّل عند أول فتح لتبويبها، وتبقى حيّة بعدها. */
function ensureFrame(tab) {
    if (document.querySelector(`.uh-frame[data-tab="${tab.id}"]`)) return;
    const frame = document.createElement('iframe');
    frame.className = 'uh-frame';
    frame.dataset.tab = tab.id;
    frame.title = tab.label;
    frame.setAttribute('aria-labelledby', `uhTab-${tab.id}`);
    frame.src = `${tab.src}?embed=1`;
    $('uhFrames').appendChild(frame);
}

/* ── القائمة والفلاتر ──────────────────────────────────────────────────── */

function bindFilters() {
    const map = { uhQuery: 'q', uhRole: 'role', uhStatus: 'status', uhFrom: 'from', uhTo: 'to', uhSort: 'sort' };
    let timer = null;
    for (const [id, key] of Object.entries(map)) {
        const el = $(id);
        el.addEventListener(id === 'uhQuery' ? 'input' : 'change', () => {
            filters[key] = el.value;
            clearTimeout(timer);
            timer = setTimeout(renderUsers, id === 'uhQuery' ? 150 : 0);
        });
    }
    $('uhReset').addEventListener('click', () => {
        Object.assign(filters, { q: '', role: '', status: '', from: '', to: '', sort: 'newest' });
        for (const [id, key] of Object.entries(map)) $(id).value = filters[key];
        renderUsers();
        $('uhQuery').focus();
    });
}

async function loadUsers() {
    const { data: users, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        $('usersBody').innerHTML = '<tr><td colspan="8" class="uh-empty">تعذّر تحميل المستخدمين.</td></tr>';
        console.error('[Users] load failed:', error.message);
        return;
    }
    allUsers = users || [];

    // حالة تجميد المحفظة (كما كانت تُقرأ لزر التجميد)
    const { data: wallets } = await supabase.from('user_wallets').select('user_id, is_frozen');
    walletMap = new Map(wallets?.map(w => [w.user_id, w.is_frozen]) || []);
    renderUsers();
}

function cell(text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    return td;
}

function badge(text, tone) {
    const s = document.createElement('span');
    s.className = `status-badge ${tone}`;
    s.textContent = text;
    return s;
}

function renderUsers() {
    if (activeTab !== 'all' && activeTab !== 'banned') return;
    const body = $('usersBody');
    const effective = activeTab === 'banned' ? { ...filters, status: 'banned' } : filters;
    const rows = filterUsers(allUsers, effective, walletMap);
    const base = activeTab === 'banned' ? allUsers.filter(isBanned).length : allUsers.length;

    $('uhCount').textContent = `عرض ${rows.length.toLocaleString('ar-EG')} من ${base.toLocaleString('ar-EG')} ${activeTab === 'banned' ? 'محظور' : 'مستخدم'}`;

    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="8" class="uh-empty">${activeTab === 'banned' && !base ? 'لا يوجد مستخدمين محظورين' : 'لا توجد نتائج مطابقة'}</td></tr>`;
        return;
    }

    body.replaceChildren(...rows.map(u => {
        const tr = document.createElement('tr');
        const name = cell(u.full_name || 'بدون اسم', 'uh-name');
        const email = cell(u.email || '—', 'uh-ltr');
        const phone = cell(u.phone || u.whatsapp_phone || '—', 'uh-ltr');

        const roleTd = document.createElement('td');
        roleTd.append(badge(roleLabel(u.role), `status-${u.role || 'user'}`));

        // الشارات في غلاف مرن داخل الخلية — الخلية نفسها تبقى table-cell، وإلا
        // انهار حساب عرض الجدول تحت min-width:max-content (responsive-global.css)
        const statusTd = document.createElement('td');
        const statusWrap = document.createElement('div');
        statusWrap.className = 'uh-status';
        statusWrap.append(isBanned(u) ? badge('محظور', 'status-danger') : badge('نشط', 'status-resolved'));
        if (walletMap.get(u.id)) statusWrap.append(badge('رصيد مجمّد', 'status-pending'));
        statusTd.append(statusWrap);

        const points = cell((Number(u.points) || 0).toLocaleString('ar-EG'));
        const joined = cell(u.created_at ? new Date(u.created_at).toLocaleDateString('ar-EG') : '—');

        const optsTd = document.createElement('td');
        optsTd.className = 'uh-actions-cell';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'uh-options-btn';
        btn.dataset.userId = u.id;
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-label', `خيارات ${u.full_name || u.email || ''}`);
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg><span>خيارات</span>';
        optsTd.append(btn);

        tr.append(name, email, phone, roleTd, statusTd, points, joined, optsTd);
        return tr;
    }));
}

/* ── قائمة «خيارات» ────────────────────────────────────────────────────── */

let menuEl = null;
let menuFor = null; // { user, button }

function initOptionsMenu() {
    menuEl = document.createElement('div');
    menuEl.className = 'uh-menu';
    menuEl.id = 'uhMenu';
    menuEl.setAttribute('role', 'menu');
    menuEl.hidden = true;
    document.body.appendChild(menuEl);

    $('usersBody').addEventListener('click', (e) => {
        const btn = e.target.closest('.uh-options-btn');
        if (!btn) return;
        e.stopPropagation();
        const target = allUsers.find(u => u.id === btn.dataset.userId);
        if (!target) return;
        if (menuFor?.button === btn && !menuEl.hidden) closeMenu();
        else openMenu(target, btn);
    });

    document.addEventListener('click', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu(); });
    // القائمة تتبع زرها مع التمرير وتغيير الحجم، وتُغلق فقط حين يخرج الزر من الشاشة.
    // (تمرير القائمة نفسها حين تطول لا يحرّكها)
    const follow = (e) => { if (!menuEl.hidden && !menuEl.contains(e?.target)) positionMenu(); };
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    menuEl.addEventListener('keydown', (e) => {
        const items = [...menuEl.querySelectorAll('[role="menuitem"]')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        else if (e.key === 'Tab') closeMenu();
    });
}

function openMenu(target, button) {
    closeMenu();
    menuFor = { user: target, button };
    const actions = userActions(target, {
        viewer: { id: user?.id, role: user?.profile?.role, email: user?.email },
        isSieAdmin,
        frozen: !!walletMap.get(target.id)
    });

    const head = document.createElement('div');
    head.className = 'uh-menu-head';
    const n = document.createElement('strong');
    n.textContent = target.full_name || 'بدون اسم';
    const m = document.createElement('span');
    m.textContent = target.email || '';
    m.dir = 'ltr';
    head.append(n, m);

    const nodes = [head];
    for (const a of actions) {
        if (a.group) {
            const g = document.createElement('div');
            g.className = 'uh-menu-group';
            g.textContent = a.group;
            nodes.push(g);
            continue;
        }
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.className = 'uh-menu-item' + (a.danger ? ' is-danger' : '') + (a.current ? ' is-current' : '');
        item.textContent = a.label;
        if (a.current) {
            item.setAttribute('aria-current', 'true');
            const tag = document.createElement('small');
            tag.textContent = 'الحالية';
            item.append(tag);
        }
        item.addEventListener('click', () => {
            const u = menuFor.user;
            closeMenu();
            runAction(a.id, u);
        });
        nodes.push(item);
    }
    menuEl.replaceChildren(...nodes);
    menuEl.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    positionMenu();
    menuEl.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
}

/** تحت الزر (أو فوقه إن لم يتسع) داخل حدود النافذة، ومحاذاة حافة البداية في RTL. */
function positionMenu() {
    const button = menuFor?.button;
    if (!button || !button.isConnected) { closeMenu(); return; }
    const r = button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh) { closeMenu(); return; }
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    const rtl = getComputedStyle(button).direction === 'rtl';
    const left = Math.min(Math.max(8, rtl ? r.right - w : r.left), vw - w - 8);
    let top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
}

function closeMenu(returnFocus = false) {
    if (!menuEl || menuEl.hidden) return;
    menuEl.hidden = true;
    menuFor?.button.setAttribute('aria-expanded', 'false');
    if (returnFocus) menuFor?.button.focus();
    menuFor = null;
}

/** تنفيذ الإجراء — نفس الاستعلامات والتأكيدات والشروط التي كانت في الصفحة. */
async function runAction(id, target) {
    const userId = target.id;

    if (id === 'view') {
        await impersonateUser(userId);
        return;
    }

    if (id === 'points') {
        const newPoints = prompt(`إدخال النقاط الجديدة للمستخدم: ${target.full_name || target.email}`);
        if (newPoints === null) return;
        const points = parseInt(newPoints);
        if (isNaN(points)) {
            alert('يرجى إدخال رقم صحيح');
            return;
        }
        const { error } = await supabase.from('profiles').update({ points: points }).eq('id', userId);
        if (error) alert('خطأ في تحديث النقاط: ' + error.message);
        else {
            // تحديث المحفظة أيضاً لضمان التزامن
            await supabase.from('user_wallets').update({ total_points: points, available_points: points }).eq('user_id', userId);
            alert('تم تحديث النقاط بنجاح');
            loadUsers();
        }
        return;
    }

    if (id.startsWith('role:')) {
        const newRole = id.slice(5);
        // حماية إضافية: Super User لا يقدر يغيّر رتبته الخاصة حتى لو فُتح الزر بأي طريقة
        const isSelf = !!user && userId === user.id;
        if (isSelf && user?.profile?.role === 'super_user') return;

        const labels = { user: 'عضو', super_user: 'Super User', admin: 'Admin' };
        if (confirm(`هل أنت متأكد من تغيير صلاحية هذا المستخدم إلى "${labels[newRole]}"؟`)) {
            const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId);
            if (error) alert('خطأ في تغيير الصلاحية: ' + error.message);
            else loadUsers();
        }
        return;
    }

    if (id === 'ban') {
        // ملحوظة: تنفيذ الحظر/تغيير الصلاحية لمستخدم آخر محكوم بسياسات RLS في Supabase.
        if (confirm('هل أنت متأكد من حظر هذا المستخدم؟')) {
            const { error } = await supabase.from('profiles').update({ status: 'banned' }).eq('id', userId);
            if (error) alert('خطأ في الحظر: ' + error.message);
            else loadUsers();
        }
        return;
    }

    if (id === 'unban') {
        if (confirm('هل أنت متأكد من إلغاء حظر هذا المستخدم؟')) {
            const { error } = await supabase.from('profiles').update({ status: 'active' }).eq('id', userId);
            if (error) alert('خطأ في إلغاء الحظر: ' + error.message);
            else loadUsers();
        }
        return;
    }

    if (id === 'freeze') {
        const isFrozen = !!walletMap.get(userId);
        const action = isFrozen ? 'unfreeze' : 'freeze';
        const actionLabel = isFrozen ? 'إلغاء تجميد' : 'تجميد';
        if (confirm(`هل أنت متأكد من ${actionLabel} رصيد هذا المستخدم؟`)) {
            const { data, error } = await supabase.rpc('manage_user_points', {
                target_user_email: target.email,
                amount_change: 0,
                action_type: action
            });
            if (error) alert('خطأ: ' + error.message);
            else {
                alert(data.message);
                loadUsers();
            }
        }
        return;
    }

    if (id === 'sie') {
        await openSiePanel(userId, target.full_name, target.email);
        return;
    }

    if (id === 'copyEmail') {
        try {
            await navigator.clipboard.writeText(target.email);
            flash('تم نسخ البريد الإلكتروني');
        } catch {
            prompt('انسخ البريد الإلكتروني:', target.email);
        }
    }
}

function flash(text) {
    const count = $('uhCount');
    const prev = count.textContent;
    count.textContent = text;
    setTimeout(() => { if (count.textContent === text) count.textContent = prev; }, 1600);
}

/* ── نافذة محرك الدعم الذكي (SIE) ──────────────────────────────────────────
   نفس النافذة المنزلقة السابقة؛ الحظر وتغيير الصلاحية انتقلا إلى قائمة «خيارات». */

function injectSiePanel() {
    const overlay = document.createElement('div');
    overlay.className = 'options-overlay';
    overlay.id = 'optionsOverlay';

    const panel = document.createElement('div');
    panel.className = 'options-panel';
    panel.id = 'optionsPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'optUserName');
    panel.innerHTML = `
        <div class="options-panel-header">
            <div class="opt-user-name" id="optUserName"></div>
            <div class="opt-user-email" id="optUserEmail"></div>
        </div>

        <div class="options-group-label" id="sieSectionLabel">محرك الدعم الذكي (SIE)</div>
        <div class="options-panel-body" id="sieSection">
            <label class="sie-field">
                <span>تفعيل SIE لهذا العميل</span>
                <input type="checkbox" id="sieEnabledToggle">
            </label>

            <label class="sie-field">
                <span>نوع الحد</span>
                <select id="sieAccessMode">
                    <option value="unlimited">بدون حد (طالما مفعّل)</option>
                    <option value="quota">حد رسائل</option>
                    <option value="expiration">تاريخ انتهاء</option>
                </select>
            </label>

            <label class="sie-field" id="sieQuotaRow" style="display:none;">
                <span>حد الرسائل</span>
                <input type="number" id="sieMessageQuota" min="1" step="1">
            </label>

            <label class="sie-field" id="sieExpiryRow" style="display:none;">
                <span>تاريخ الانتهاء</span>
                <input type="datetime-local" id="sieExpiresAt">
            </label>

            <label class="sie-field">
                <span>ملاحظة (اختياري)</span>
                <input type="text" id="sieNotes" placeholder="سبب التفعيل مثلاً">
            </label>

            <div class="sie-usage" id="sieUsageDisplay">—</div>

            <div style="display:flex; gap:6px;">
                <button class="btn btn-primary btn-sm" id="sieSaveBtn">حفظ إعدادات SIE</button>
                <button class="btn btn-secondary btn-sm" id="sieResetUsageBtn">تصفير الاستخدام</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    overlay.addEventListener('click', closeSiePanel);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('active')) closeSiePanel();
    });

    // الأزرار دي أصلاً مخفية عن أي حد is_sie_admin() بترجعله false (شوف userActions)،
    // لكن is_sie_admin() في الـ RPC/RLS هي اللي بتمنع فعليًا، مش الإخفاء ده.
    $('sieAccessMode').addEventListener('change', (e) => {
        const mode = e.target.value;
        $('sieQuotaRow').style.display = mode === 'quota' ? '' : 'none';
        $('sieExpiryRow').style.display = mode === 'expiration' ? '' : 'none';
    });

    $('sieSaveBtn').addEventListener('click', async () => {
        if (!currentOptionsUserId) return;
        const isEnabled = $('sieEnabledToggle').checked;
        const accessMode = $('sieAccessMode').value;
        const quotaRaw = $('sieMessageQuota').value;
        const expiryRaw = $('sieExpiresAt').value;
        const notes = $('sieNotes').value.trim() || null;

        const messageQuota = accessMode === 'quota' && quotaRaw ? parseInt(quotaRaw, 10) : null;
        const expiresAt = accessMode === 'expiration' && expiryRaw ? new Date(expiryRaw).toISOString() : null;

        if (accessMode === 'quota' && (!messageQuota || messageQuota < 1)) {
            alert('من فضلك أدخل حد رسائل صحيح (رقم أكبر من صفر)');
            return;
        }
        if (accessMode === 'expiration' && !expiresAt) {
            alert('من فضلك اختر تاريخ انتهاء');
            return;
        }

        const { error } = await adminSetAccess(supabase, {
            userId: currentOptionsUserId,
            isEnabled,
            accessMode,
            messageQuota,
            expiresAt,
            notes
        });

        if (error) alert('خطأ في حفظ إعدادات SIE: ' + error.message);
        else {
            alert('تم حفظ إعدادات SIE');
            await loadSieAccessIntoPanel(currentOptionsUserId);
        }
    });

    $('sieResetUsageBtn').addEventListener('click', async () => {
        if (!currentOptionsUserId) return;
        if (!confirm('تصفير عداد الاستخدام لهذا العميل؟')) return;
        const { error } = await adminResetUsage(supabase, currentOptionsUserId);
        if (error) alert('خطأ في تصفير الاستخدام: ' + error.message);
        else await loadSieAccessIntoPanel(currentOptionsUserId);
    });
}

/**
 * يجيب صف customer_sie_access الحالي للعميل ده ويملأ بيه النافذة.
 * بيتنادى أول ما النافذة تتفتح، وتاني كل مرة الأدمن يحفظ/يصفّر عشان القيم المعروضة تفضل حقيقية.
 */
async function loadSieAccessIntoPanel(userId) {
    currentSieAccess = await getSieAccessStatus(supabase, userId);

    const enabled = currentSieAccess?.is_enabled || false;
    const mode = currentSieAccess?.access_mode || 'unlimited';

    $('sieEnabledToggle').checked = enabled;
    $('sieAccessMode').value = mode;
    $('sieMessageQuota').value = currentSieAccess?.message_quota ?? '';
    $('sieExpiresAt').value = currentSieAccess?.expires_at
        ? new Date(currentSieAccess.expires_at).toISOString().slice(0, 16)
        : '';
    $('sieNotes').value = currentSieAccess?.notes || '';
    $('sieQuotaRow').style.display = mode === 'quota' ? '' : 'none';
    $('sieExpiryRow').style.display = mode === 'expiration' ? '' : 'none';

    const usageEl = $('sieUsageDisplay');
    if (!currentSieAccess) {
        usageEl.textContent = 'لسه معملوش تفعيل لهذا العميل';
    } else if (mode === 'quota') {
        usageEl.textContent = `الاستخدام: ${currentSieAccess.messages_used} / ${currentSieAccess.message_quota}`;
    } else if (mode === 'expiration') {
        usageEl.textContent = `رسايل مُرسَلة: ${currentSieAccess.messages_used} — ينتهي في ${new Date(currentSieAccess.expires_at).toLocaleString('ar-EG')}`;
    } else {
        usageEl.textContent = `رسايل مُرسَلة: ${currentSieAccess.messages_used}`;
    }
}

async function openSiePanel(userId, name, email) {
    if (!isSieAdmin) return;
    currentOptionsUserId = userId;
    $('optUserName').textContent = name || 'بدون اسم';
    $('optUserEmail').textContent = email || '';
    await loadSieAccessIntoPanel(userId);
    $('optionsOverlay').classList.add('active');
    $('optionsPanel').classList.add('active');
    $('sieEnabledToggle').focus();
}

function closeSiePanel() {
    currentOptionsUserId = null;
    currentSieAccess = null;
    $('optionsOverlay').classList.remove('active');
    $('optionsPanel').classList.remove('active');
}

init();
