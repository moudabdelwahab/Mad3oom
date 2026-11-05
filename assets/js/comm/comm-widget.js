/**
 * comm-widget.js — ودجت التواصل الموحّد لكل اللوحات.
 *
 *   mountCommWidget({ surface: 'portal' | 'company' | 'admin' | 'owner', container? })
 *
 * وضعان للمكوّن نفسه: عائم (زر ثابت يفتح لوحة) في اللوحات، ومضمَّن (container) حين تكون المحادثات
 * قسمًا من الصفحة نفسها — كبوابة العميل، فلا تُرسم واجهتان لنفس المحادثات في صفحة واحدة.
 *
 * نفس الواجهة في كل مكان (قائمة، بحث، فلاتر، محادثة، مرفقات، حالة القراءة، إشعار غير المقروء)،
 * والسياق والصلاحيات من الخادم: comm_overview() يعطي المنادي «جانبه» في كل نطاق، والودجت يعرض
 * منها ما يخص اللوحة (comm-model.SURFACE_SCOPES). لا نطاق متاح ⇒ لا يُرسم شيء إطلاقًا.
 *
 * الأمان ليس هنا: كل نداء يعيد الخادم فيه حساب الجانب والشركة والصلاحية (migrations/123).
 * والنصوص كلها تُكتب بـ textContent — لا HTML من محتوى المستخدم.
 */
import {
    strings, scopesForSurface, totalUnread, filtersFor, scopeLabel, categoryLabel, CATEGORIES, PRIORITIES,
    validateStart, validateReply, checkFile, formatSize, errorMessage, ticketDescription, ticketCategoryFor,
    scopeFromUrl, timeLabel, LIMITS
} from './comm-model.js';
import * as api from './comm-data.js';

const STYLE_HREF = '/assets/css/comm-widget.css';
const POLL_OVERVIEW_MS = 60000;
const POLL_THREAD_MS = 15000;

let state = null;

/**
 * نتيجة آخر تركيب: 'mounted' | 'empty' (لا نطاق لهذه اللوحة) | 'unavailable' (المحرّك غير مثبَّت في القاعدة
 * بعد — 123 غير مطبَّق) | 'error' (فشل شبكة). البوابة ترجع لواجهة 102 القديمة حين لا يكون المحرّك متاحًا.
 */
export let lastMountStatus = null;

const MISSING_RPC = new Set(['PGRST202', '42883']);

const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'ar');
const T = () => strings(lang());

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
}

const ICON_CHAT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_CLIP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const svg = (markup) => { const s = document.createElement('span'); s.className = 'mcw-icon'; s.innerHTML = markup; return s; };

/**
 * ركّب الودجت في الصفحة. آمن للنداء أكثر من مرة (يُركَّب مرة واحدة).
 * @returns {Promise<boolean>} هل رُسم (يوجد نطاق متاح لهذه اللوحة)
 */
export async function mountCommWidget({ surface, container = null } = {}) {
    if (state || typeof document === 'undefined') return !!state;
    const overview = await api.fetchOverview();
    if (!overview.ok) {
        lastMountStatus = MISSING_RPC.has(overview.error?.code) || overview.error?.status === 404 ? 'unavailable' : 'error';
        return false;
    }
    // الدالة تعيد كائنًا دائمًا بعد 123؛ null = خادم بلا المحرّك
    if (!overview.data) { lastMountStatus = 'unavailable'; return false; }
    const entries = scopesForSurface(overview.data, surface);
    if (!entries.length) { lastMountStatus = 'empty'; return false; }
    lastMountStatus = 'mounted';

    ensureStyles();
    state = {
        surface, entries, attachments: overview.data.attachments === true, embedded: !!container,
        scope: entries[0].scope, view: 'list', filter: 'open', q: '',
        threads: [], listMeta: null, thread: null, files: [], busy: false,
        timers: [], root: null
    };
    buildShell(container);
    renderAll();

    // روابط الإشعارات: ?comm=<scope> تفتح الودجت على نطاقها
    const fromUrl = scopeFromUrl(window.location.search);
    if (state.embedded) openPanel(fromUrl && entries.some(e => e.scope === fromUrl) ? fromUrl : undefined, { focus: false });
    else if (fromUrl && entries.some(e => e.scope === fromUrl)) openPanel(fromUrl);

    state.timers.push(setInterval(() => { if (!document.hidden) refreshOverview(); }, POLL_OVERVIEW_MS));
    state.timers.push(setInterval(() => {
        if (document.hidden || !isOpen()) return;
        if (state.view === 'thread' && state.thread) loadThread(state.thread.id, { quiet: true });
        else if (state.view === 'list') loadList({ quiet: true });
    }, POLL_THREAD_MS));

    // تغيّر اللغة (language-manager يغيّر lang/dir على <html>)
    new MutationObserver(() => renderAll()).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

    window.mad3oomComm = { open: (scope) => openPanel(scope), close: closePanel };
    return true;
}

function ensureStyles() {
    if (document.querySelector(`link[href="${STYLE_HREF}"]`)) return;
    document.head.append(el('link', { rel: 'stylesheet', href: STYLE_HREF }));
}

function isOpen() { return state?.root?.dataset.open === 'true'; }

function buildShell(container) {
    const root = el('div', { class: 'mcw', id: 'commWidget', 'data-open': 'false', 'data-surface': state.surface,
                             'data-embedded': String(state.embedded) });
    const panel = el('section', { class: 'mcw-panel', id: 'commPanel', tabindex: '-1', hidden: true,
                                  role: state.embedded ? 'region' : 'dialog', 'aria-modal': state.embedded ? null : 'false' });
    if (state.embedded) {
        root.append(panel);
        container.append(root);
    } else {
        const launcher = el('button', {
            type: 'button', class: 'mcw-launcher', id: 'commLauncher', 'aria-expanded': 'false', 'aria-controls': 'commPanel',
            onclick: () => (isOpen() ? closePanel() : openPanel())
        });
        panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } });
        root.append(launcher, panel);
        document.body.append(root);
    }
    state.root = root;
}

function openPanel(scope, { focus = true } = {}) {
    if (!state) return;
    if (scope && state.entries.some(e => e.scope === scope) && scope !== state.scope) {
        state.scope = scope; state.view = 'list'; state.thread = null; state.filter = 'open'; state.q = '';
    }
    state.root.dataset.open = 'true';
    state.root.querySelector('#commLauncher')?.setAttribute('aria-expanded', 'true');
    state.root.querySelector('#commPanel').hidden = false;
    renderPanel();
    if (state.view === 'list') loadList();
    if (state.embedded) { if (focus) state.root.scrollIntoView({ block: 'nearest' }); }
    else if (focus) state.root.querySelector('#commPanel').focus?.();
}

function closePanel() {
    if (!state || state.embedded) return;
    state.root.dataset.open = 'false';
    state.root.querySelector('#commLauncher').setAttribute('aria-expanded', 'false');
    state.root.querySelector('#commPanel').hidden = true;
    state.root.querySelector('#commLauncher').focus();
}

async function refreshOverview() {
    const res = await api.fetchOverview();
    if (!res.ok || !res.data) return;
    const entries = scopesForSurface(res.data, state.surface);
    if (!entries.length) return;
    state.entries = entries;
    state.attachments = res.data.attachments === true;
    renderLauncher();
    renderTabs();
}

const entry = () => state.entries.find(e => e.scope === state.scope) || state.entries[0];

/* ── الرسم ─────────────────────────────────────────────────────────────── */

function renderAll() {
    if (!state) return;
    state.root.setAttribute('dir', document.documentElement.dir === 'ltr' ? 'ltr' : 'rtl');
    state.root.setAttribute('lang', lang());
    renderLauncher();
    if (isOpen()) renderPanel();
}

function renderLauncher() {
    const t = T();
    const launcher = state.root.querySelector('#commLauncher');
    if (!launcher) return;
    const unread = totalUnread(state.entries);
    launcher.replaceChildren(svg(ICON_CHAT), el('span', { class: 'mcw-launcher-label', text: t.launcher }));
    if (unread > 0) launcher.append(el('span', { class: 'mcw-badge', text: unread > 99 ? '99+' : String(unread), 'aria-hidden': 'true' }));
    launcher.setAttribute('aria-label', unread > 0 ? `${t.launcher} — ${t.unreadLabel(unread)}` : t.launcher);
}

function renderPanel() {
    const t = T();
    const panel = state.root.querySelector('#commPanel');
    state.root.dataset.view = state.view;
    const label = scopeLabel(state.scope, entry().side, lang());
    panel.setAttribute('aria-label', label.title);
    const head = el('header', { class: 'mcw-head' },
        state.view !== 'list'
            ? el('button', { type: 'button', class: 'mcw-iconbtn', 'aria-label': t.back, text: lang() === 'en' ? '←' : '→',
                             onclick: () => { state.view = 'list'; state.thread = null; renderPanel(); loadList(); } })
            : null,
        el('div', { class: 'mcw-head-text' },
            el('h2', { class: 'mcw-title', dir: 'auto', text: state.view === 'thread' && state.thread ? state.thread.subject : label.title }),
            el('p', { class: 'mcw-subtitle', text: state.view === 'thread' && state.thread ? threadSubtitle(state.thread) : label.subtitle })),
        state.embedded ? null : el('button', { type: 'button', class: 'mcw-iconbtn', 'aria-label': t.close, text: '×', onclick: closePanel }));
    const tabs = el('div', { class: 'mcw-tabs', role: 'tablist', id: 'commTabs', hidden: state.entries.length < 2 || state.view !== 'list' });
    const body = el('div', { class: 'mcw-body', id: 'commBody' });
    panel.replaceChildren(head, tabs, body);
    renderTabs();
    if (state.view === 'list') renderList();
    else if (state.view === 'new') renderNew();
    else renderThread();
}

function threadSubtitle(th) {
    const t = T();
    const parts = [];
    if (th.company_name && th.side === 'responder') parts.push(th.company_name);
    if (th.counterpart_name) parts.push(th.counterpart_name);
    if (th.category) parts.push(categoryLabel(th.category, lang()));
    parts.push(th.status === 'closed' ? t.statusClosed : t.statusOpen);
    return parts.join(' · ');
}

function renderTabs() {
    const tabs = state.root.querySelector('#commTabs');
    if (!tabs) return;
    tabs.replaceChildren(...state.entries.map(e => {
        const label = scopeLabel(e.scope, e.side, lang());
        const btn = el('button', {
            type: 'button', role: 'tab', class: 'mcw-tab', 'aria-selected': String(e.scope === state.scope),
            dataset: { scope: e.scope },
            onclick: () => { state.scope = e.scope; state.filter = 'open'; state.q = ''; state.view = 'list'; renderPanel(); loadList(); }
        }, el('span', { text: label.title }));
        if (e.unread > 0) btn.append(el('span', { class: 'mcw-badge mcw-badge-sm', text: String(e.unread) }));
        return btn;
    }));
}

function renderList() {
    const t = T();
    const body = state.root.querySelector('#commBody');
    const e = entry();
    const toolbar = el('div', { class: 'mcw-toolbar' });
    const search = el('input', {
        type: 'search', class: 'mcw-input mcw-search', placeholder: t.search, 'aria-label': t.search, value: state.q
    });
    let debounce = null;
    search.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { state.q = search.value.trim(); loadList(); }, 300);
    });
    toolbar.append(search);
    const filters = el('div', { class: 'mcw-filters', role: 'group', 'aria-label': t.filters.open });
    for (const f of filtersFor(state.scope, e.side)) {
        filters.append(el('button', {
            type: 'button', class: 'mcw-chip', 'aria-pressed': String(state.filter === f), text: t.filters[f],
            onclick: () => { state.filter = f; loadList(); }
        }));
    }
    const list = el('ul', { class: 'mcw-list', id: 'commList', 'aria-live': 'polite' });
    body.replaceChildren(toolbar, filters, list);
    if (e.canStart) {
        body.append(el('div', { class: 'mcw-footer' },
            el('button', { type: 'button', class: 'mcw-btn mcw-btn-primary', id: 'commNewBtn', text: t.newThread,
                           onclick: () => { state.view = 'new'; state.startKey = api.newKey(); renderPanel(); } })));
    }
    paintList();
}

function paintList() {
    const t = T();
    const list = state.root.querySelector('#commList');
    if (!list) return;
    if (state.listError) {
        list.replaceChildren(el('li', { class: 'mcw-state mcw-state-error' },
            el('p', { text: state.listError }),
            el('button', { type: 'button', class: 'mcw-btn', text: t.retry, onclick: () => loadList() })));
        return;
    }
    if (state.listLoading && !state.threads.length) {
        list.replaceChildren(...[0, 1, 2].map(() => el('li', { class: 'mcw-skeleton', 'aria-hidden': 'true' })));
        list.setAttribute('aria-busy', 'true');
        return;
    }
    list.removeAttribute('aria-busy');
    if (!state.threads.length) {
        list.replaceChildren(el('li', { class: 'mcw-state', text: state.q || state.filter !== 'open' ? t.emptyFiltered : t.empty }));
        return;
    }
    list.replaceChildren(...state.threads.map(th => {
        const meta = [];
        if (th.side === 'responder' && th.company_name) meta.push(th.company_name);
        if (th.counterpart_name) meta.push(th.counterpart_name);
        if (th.category) meta.push(categoryLabel(th.category, lang()));
        if (th.assignee_name) meta.push(`${t.assign}: ${th.assignee_name}`);
        const item = el('li', {},
            el('button', { type: 'button', class: 'mcw-item', 'data-unread': String(!!th.unread), dataset: { id: th.id },
                           onclick: () => { state.view = 'thread'; state.thread = { id: th.id, subject: th.subject, status: th.status, side: th.side }; renderPanel(); loadThread(th.id); } },
                el('span', { class: 'mcw-item-top' },
                    el('span', { class: 'mcw-item-subject', dir: 'auto', text: th.subject }),
                    el('time', { class: 'mcw-item-time', datetime: th.last_message_at, text: timeLabel(th.last_message_at, lang()) })),
                el('span', { class: 'mcw-item-meta' },
                    el('span', { class: `mcw-status mcw-status-${th.status}`, text: th.status === 'closed' ? t.statusClosed : t.statusOpen }),
                    th.priority && th.priority !== 'normal' ? el('span', { class: `mcw-prio mcw-prio-${th.priority}`, text: t.priorities[th.priority] }) : null,
                    th.ticket ? el('span', { class: 'mcw-tag', text: `#${th.ticket.number ?? ''}` }) : null,
                    el('span', { class: 'mcw-item-meta-text', text: meta.join(' · ') }))));
        return item;
    }));
}

async function loadList({ quiet = false } = {}) {
    const scope = state.scope;
    if (!quiet) { state.listLoading = true; state.listError = null; state.threads = []; if (state.view === 'list') renderList(); }
    const res = await api.fetchThreads(scope, state.filter, state.q);
    if (scope !== state.scope || state.view !== 'list') return;
    state.listLoading = false;
    if (!res.ok) { if (!quiet) { state.listError = errorMessage(res.error, lang()); paintList(); } return; }
    state.listError = null;
    state.threads = res.data?.threads || [];
    state.listMeta = res.data || null;
    paintList();
    // تحديث شارة النطاق من القائمة نفسها
    const e = entry();
    if (e && state.filter === 'open' && !state.q) {
        e.unread = state.threads.filter(x => x.unread).length;
        renderLauncher(); renderTabs();
    }
}

function renderNew() {
    const t = T();
    const body = state.root.querySelector('#commBody');
    const cats = CATEGORIES[state.scope] || [];
    const form = el('form', { class: 'mcw-form', id: 'commNewForm', novalidate: true });
    const field = (id, labelText, control, errKey) => el('div', { class: 'mcw-field' },
        el('label', { for: id, text: labelText }), control,
        el('p', { class: 'mcw-field-error', id: `${id}Error`, 'data-error-for': errKey, hidden: true }));
    form.append(field('commSubject', t.subject,
        el('input', { id: 'commSubject', class: 'mcw-input', maxlength: String(LIMITS.subjectMax), required: true, autocomplete: 'off' }), 'subject'));
    if (cats.length) {
        const sel = el('select', { id: 'commCategory', class: 'mcw-input', required: true },
            el('option', { value: '', text: '—' }),
            ...cats.map(c => el('option', { value: c, text: categoryLabel(c, lang()) })));
        form.append(field('commCategory', t.category, sel, 'category'));
        const prio = el('select', { id: 'commPriority', class: 'mcw-input' },
            ...PRIORITIES.map(p => el('option', { value: p, text: t.priorities[p] })));
        form.append(field('commPriority', t.priority, prio, 'priority'));
    }
    form.append(field('commMessage', t.message,
        el('textarea', { id: 'commMessage', class: 'mcw-input mcw-textarea', rows: '5', maxlength: String(LIMITS.bodyMax), required: true }), 'body'));
    const formError = el('p', { class: 'mcw-form-error', role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'mcw-btn mcw-btn-primary', id: 'commStartSubmit', text: t.start });
    form.append(formError, el('div', { class: 'mcw-form-actions' },
        el('button', { type: 'button', class: 'mcw-btn', text: t.cancel, onclick: () => { state.view = 'list'; renderPanel(); loadList(); } }),
        submit));
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const check = validateStart({
            scope: state.scope,
            subject: form.querySelector('#commSubject').value,
            body: form.querySelector('#commMessage').value,
            category: form.querySelector('#commCategory')?.value,
            priority: form.querySelector('#commPriority')?.value
        }, lang());
        form.querySelectorAll('[data-error-for]').forEach(p => {
            const msg = check.errors[p.dataset.errorFor];
            p.hidden = !msg; p.textContent = msg || '';
        });
        if (!check.ok) { form.querySelector('[data-error-for]:not([hidden])')?.previousElementSibling?.focus(); return; }
        submit.disabled = true; formError.hidden = true;
        const res = await api.startThread({ scope: state.scope, ...check.values, key: state.startKey });
        submit.disabled = false;
        if (!res.ok) { formError.textContent = errorMessage(res.error, lang()); formError.hidden = false; return; }
        state.startKey = api.newKey();
        toast(t.started, 'success');
        state.view = 'thread';
        state.thread = { id: res.data.thread_id, subject: check.values.subject, status: 'open', side: 'requester' };
        renderPanel();
        loadThread(res.data.thread_id);
        refreshOverview();
    });
    body.replaceChildren(form);
    form.querySelector('#commSubject').focus();
}

async function loadThread(id, { quiet = false } = {}) {
    const scope = state.scope;
    if (!quiet) { state.threadLoading = true; state.threadError = null; paintThread(); }
    const res = await api.fetchThread(scope, id);
    if (scope !== state.scope || state.view !== 'thread' || state.thread?.id !== id) return;
    state.threadLoading = false;
    if (!res.ok) { if (!quiet) { state.threadError = errorMessage(res.error, lang()); paintThread(); } return; }
    const prevCount = state.thread?.messages?.length ?? -1;
    state.thread = res.data;
    if (quiet && prevCount === state.thread.messages.length) return;   // لا جديد: لا إعادة رسم تمحو ما يُكتب
    const head = state.root.querySelector('.mcw-title');
    if (head) head.textContent = state.thread.subject;
    const sub = state.root.querySelector('.mcw-subtitle');
    if (sub) sub.textContent = threadSubtitle(state.thread);
    paintThread();
    const e = entry();
    if (e && e.unread > 0) refreshOverview();
}

function renderThread() {
    const body = state.root.querySelector('#commBody');
    body.replaceChildren(
        el('div', { class: 'mcw-actions', id: 'commActions' }),
        el('ol', { class: 'mcw-messages', id: 'commMessages', 'aria-live': 'polite' }),
        el('div', { class: 'mcw-composer-wrap', id: 'commComposer' }));
    paintThread();
}

function paintThread() {
    const t = T();
    const msgs = state.root.querySelector('#commMessages');
    if (!msgs) return;
    const th = state.thread;
    if (state.threadError) {
        msgs.replaceChildren(el('li', { class: 'mcw-state mcw-state-error' }, el('p', { text: state.threadError }),
            el('button', { type: 'button', class: 'mcw-btn', text: t.retry, onclick: () => loadThread(th.id) })));
        state.root.querySelector('#commActions').replaceChildren();
        state.root.querySelector('#commComposer').replaceChildren();
        return;
    }
    if (state.threadLoading || !th?.messages) {
        msgs.replaceChildren(...[0, 1].map(() => el('li', { class: 'mcw-skeleton', 'aria-hidden': 'true' })));
        return;
    }
    msgs.replaceChildren(...th.messages.map(m => {
        const who = m.mine ? t.you
            : (m.sender_name || (m.side === th.side ? '' : scopeLabel(th.scope, th.side, lang()).counterpart));
        const li = el('li', { class: `mcw-msg${m.mine ? ' is-mine' : ''}${m.is_internal ? ' is-internal' : ''}` },
            el('div', { class: 'mcw-msg-head' },
                el('span', { class: 'mcw-msg-who', text: who }),
                m.is_internal ? el('span', { class: 'mcw-tag mcw-tag-internal', text: t.internalBadge }) : null,
                el('time', { datetime: m.created_at, text: timeLabel(m.created_at, lang()) })),
            el('p', { class: 'mcw-msg-body', dir: 'auto', text: m.body }));
        if (m.attachments?.length) {
            li.append(el('ul', { class: 'mcw-files' }, ...m.attachments.map(a => el('li', {},
                el('button', { type: 'button', class: 'mcw-file', onclick: () => openAttachment(a) },
                    svg(ICON_CLIP), el('span', { class: 'mcw-file-name', dir: 'auto', text: a.name }),
                    el('span', { class: 'mcw-file-size', text: formatSize(a.size) }))))));
        }
        return li;
    }));
    msgs.scrollTop = msgs.scrollHeight;
    paintActions();
    paintComposer();
}

function paintActions() {
    const t = T();
    const th = state.thread;
    const bar = state.root.querySelector('#commActions');
    if (!bar) return;
    bar.replaceChildren();
    if (th.ticket) bar.append(el('span', { class: 'mcw-tag', text: `${t.ticketLinked} #${th.ticket.number ?? ''}` }));
    if (th.can_assign) {
        const assignees = state.listMeta?.assignees || [];
        if (assignees.length) {
            const sel = el('select', { class: 'mcw-input mcw-input-sm', 'aria-label': t.assign },
                el('option', { value: '', text: t.unassigned }),
                ...assignees.map(a => el('option', { value: a.id, text: a.name, selected: a.id === th.assigned_to })));
            sel.addEventListener('change', async () => {
                const res = await api.assignThread(th.scope, th.id, sel.value || null);
                if (!res.ok) { toast(errorMessage(res.error, lang()), 'error'); return; }
                loadThread(th.id, { quiet: false });
            });
            bar.append(el('label', { class: 'mcw-inline' }, el('span', { text: t.assign }), sel));
        }
    }
    if (th.can_close) {
        const closed = th.status === 'closed';
        bar.append(el('button', { type: 'button', class: 'mcw-btn mcw-btn-sm', text: closed ? t.reopenThread : t.closeThread,
            onclick: async (ev) => {
                ev.currentTarget.disabled = true;
                const res = await api.setThreadStatus(th.scope, th.id, closed ? 'open' : 'closed');
                if (!res.ok) { toast(errorMessage(res.error, lang()), 'error'); ev.currentTarget.disabled = false; return; }
                loadThread(th.id);
            } }));
    }
    if (th.can_link_ticket) {
        bar.append(el('button', { type: 'button', class: 'mcw-btn mcw-btn-sm', id: 'commToTicket', text: t.toTicket,
            onclick: async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                const res = await api.convertToTicket(th.scope, th.id, {
                    title: th.subject, description: ticketDescription(th, lang()), category: ticketCategoryFor(th.category)
                });
                btn.disabled = false;
                if (!res.ok) { toast(res.error?.code === 'ticket' && res.error.message ? res.error.message : errorMessage(res.error, lang()), 'error'); return; }
                toast(t.ticketCreated, 'success');
                loadThread(th.id);
            } }));
    }
}

function paintComposer() {
    const t = T();
    const th = state.thread;
    const wrap = state.root.querySelector('#commComposer');
    if (!wrap) return;
    if (!th.can_reply) {
        wrap.replaceChildren(el('p', { class: 'mcw-hint', text: th.status === 'closed' ? t.closedHint : t.readOnly }));
        return;
    }
    if (wrap.querySelector('form')) { paintFiles(); return; }   // حافظ على ما يُكتب
    state.files = [];
    const form = el('form', { class: 'mcw-composer', id: 'commComposerForm', novalidate: true });
    const text = el('textarea', { class: 'mcw-input mcw-textarea', id: 'commReply', rows: '2', maxlength: String(LIMITS.bodyMax),
                                  'aria-label': t.message, placeholder: t.message });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
    const fileInput = el('input', { type: 'file', multiple: true, hidden: true, id: 'commFile' });
    fileInput.addEventListener('change', () => {
        for (const f of fileInput.files) {
            const c = checkFile(f, lang());
            if (!c.ok) { toast(`${f.name}: ${c.error}`, 'error'); continue; }
            if (state.files.length >= LIMITS.filesPerMessage) { toast(t.errors.fileCount, 'error'); break; }
            state.files.push(f);
        }
        fileInput.value = '';
        paintFiles();
    });
    const row = el('div', { class: 'mcw-composer-row' });
    if (th.can_attach && state.attachments) {
        row.append(el('button', { type: 'button', class: 'mcw-iconbtn', 'aria-label': t.attach, title: t.attach,
                                  onclick: () => fileInput.click() }, svg(ICON_CLIP)));
    }
    const send = el('button', { type: 'submit', class: 'mcw-btn mcw-btn-primary mcw-send', 'aria-label': t.send }, svg(ICON_SEND));
    row.append(text, send);
    const opts = el('div', { class: 'mcw-composer-opts' });
    if (th.can_internal) {
        opts.append(el('label', { class: 'mcw-inline' }, el('input', { type: 'checkbox', id: 'commInternal' }), el('span', { text: t.internal })));
    }
    const err = el('p', { class: 'mcw-form-error', role: 'alert', hidden: true });
    form.append(el('ul', { class: 'mcw-pending', id: 'commPending' }), row, opts, err, fileInput);
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (state.busy) return;
        const check = validateReply({ body: text.value, files: state.files }, lang());
        if (!check.ok) { err.textContent = check.error; err.hidden = false; return; }
        err.hidden = true; state.busy = true; send.disabled = true;
        try {
            const ids = [];
            for (const f of state.files) {
                const up = await api.uploadAttachment(th.scope, th.id, f);
                if (!up.ok) { err.textContent = `${t.uploadFailed}: ${f.name}`; err.hidden = false; return; }
                ids.push(up.id);
            }
            const res = await api.postMessage({
                scope: th.scope, thread: th.id, body: check.body,
                internal: !!form.querySelector('#commInternal')?.checked, attachments: ids.length ? ids : null
            });
            if (!res.ok) { err.textContent = errorMessage(res.error, lang()); err.hidden = false; return; }
            text.value = ''; state.files = []; paintFiles();
            const internal = form.querySelector('#commInternal'); if (internal) internal.checked = false;
            await loadThread(th.id, { quiet: true });
            paintThread();
        } finally {
            state.busy = false; send.disabled = false;
        }
    });
    wrap.replaceChildren(form);
    paintFiles();
}

function paintFiles() {
    const ul = state.root.querySelector('#commPending');
    if (!ul) return;
    ul.replaceChildren(...state.files.map((f, i) => el('li', { class: 'mcw-pending-item' },
        el('span', { class: 'mcw-file-name', text: f.name }), el('span', { class: 'mcw-file-size', text: formatSize(f.size) }),
        el('button', { type: 'button', class: 'mcw-iconbtn mcw-iconbtn-sm', 'aria-label': `${T().cancel} ${f.name}`, text: '×',
                       onclick: () => { state.files.splice(i, 1); paintFiles(); } }))));
}

async function openAttachment(a) {
    // نافذة تُفتح فورًا (قبل انتظار الشبكة) حتى لا يحجبها المتصفح، ثم يُوجَّه إليها الرابط الموقّع
    const win = window.open('', '_blank');
    const url = await api.attachmentUrl(a.path);
    if (!url) { win?.close(); toast(T().errors.notFound, 'error'); return; }
    if (win) { win.opener = null; win.location.href = url; } else window.location.assign(url);
}

function toast(message, type = 'info') {
    import('/ui-service.js')
        .then(m => m.ui?.showToast?.(message, type))
        .catch(() => { /* بلا خدمة إشعارات: الرسالة ظاهرة في النموذج */ });
}

/** للاختبارات: إزالة الودجت وإيقاف المؤقتات. */
export function unmountCommWidget() {
    if (!state) return;
    state.timers.forEach(clearInterval);
    state.root?.remove();
    state = null;
    delete window.mad3oomComm;
}
