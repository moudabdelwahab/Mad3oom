/**
 * لوحة الأوامر (Ctrl/⌘ + K)
 * ---------------------------------------------------------------------------
 * مركز المطورين صار ثلاثة أقسام، لكل قسم تبويبات فرعية. المستخدم يعرف أن
 * "خادم فلان" أو "مفتاح فلان" موجود، لكنه لا يتذكّر في أي تبويب — فيتنقّل
 * يدويًا بين الأقسام يدور عليه. اللوحة تحلّ هذا: تكتب الاسم فتقفز إليه مباشرة.
 *
 * الوحدة مستقلة تمامًا عن محتوى الصفحة: تستقبل دالة تبني الفهرس من الحالة
 * الحيّة عند كل فتح، فلا تحتفظ بنسخة تتقادم، ولا تعرف شيئًا عن الأقسام.
 *
 * تبني عناصرها بنفسها بدل إضافتها إلى الـ HTML — عنصر واجهة مغلق لا يحتاج
 * أحد أن يعدّله من الصفحة، وإبقاؤه هنا يجعل الوحدة قابلة للاستخدام في أي صفحة.
 */

/* ====================  المطابقة  ==================== */

/**
 * توحيد النص العربي قبل المطابقة: الهمزات والألف المقصورة والتاء المربوطة
 * والتشكيل والتطويل. بدون هذا يفشل البحث عن "اعدادات" في "إعدادات"، وهو أشيع
 * خطأ إملائي في الكتابة السريعة بالعربية.
 */
function normalize(str) {
    return String(str ?? '')
        .toLowerCase()
        .replace(/[ً-ْـ]/g, '')   // تشكيل وتطويل
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/[ؤئ]/g, 'ء')
        .trim();
}

/**
 * درجة تطابق، أو ‎-1 لو لا يطابق.
 * التسلسل الجزئي (subsequence) يكفي — "مفت api" يجد "مفاتيح API" — مع مكافأة
 * للتطابق من بداية كلمة حتى تتقدّم النتائج البديهية على المتناثرة.
 */
function score(haystack, needle) {
    if (!needle) return 0;
    const h = normalize(haystack);
    const n = normalize(needle);
    if (!h) return -1;

    const direct = h.indexOf(n);
    if (direct === 0) return 1000;
    if (direct > 0) return 700 - Math.min(direct, 200) + (/[\s\-_/]/.test(h[direct - 1]) ? 120 : 0);

    // تسلسل جزئي: كل محارف البحث بالترتيب لكن غير متلاصقة
    let hi = 0;
    let points = 0;
    for (const ch of n) {
        const found = h.indexOf(ch, hi);
        if (found === -1) return -1;
        points += found === hi ? 6 : 2;
        hi = found + 1;
    }
    return points;
}

/* ====================  الحالة  ==================== */

let overlay = null;
let input = null;
let listEl = null;
let emptyEl = null;

let items = [];
let filtered = [];
let selected = 0;
let buildIndex = () => [];
let onOpenHook = null;
let lastFocused = null;
let isOpen = false;

/* ====================  البناء  ==================== */

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function buildDom() {
    overlay = document.createElement('div');
    overlay.className = 'cmdk';
    overlay.id = 'commandPalette';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'لوحة الأوامر');
    overlay.hidden = true;

    overlay.innerHTML = `
        <div class="cmdk-panel" role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-owns="cmdkList">
            <div class="cmdk-search">
                <svg viewBox="0 0 24 24" width="17" height="17" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input id="cmdkInput" type="text" autocomplete="off" spellcheck="false"
                       placeholder="ابحث عن خادم أو مفتاح أو تكامل أو موديل… أو نفّذ أمرًا"
                       aria-controls="cmdkList" aria-autocomplete="list">
                <kbd class="cmdk-esc">Esc</kbd>
            </div>
            <div class="cmdk-list" id="cmdkList" role="listbox" aria-label="النتائج"></div>
            <div class="cmdk-empty" id="cmdkEmpty" hidden>
                <p>لا توجد نتائج مطابقة</p>
                <small>جرّب اسمًا أقصر، أو ابحث بنوع العنصر مثل «خادم» أو «مفتاح» أو «موديل».</small>
            </div>
            <div class="cmdk-footer">
                <span><kbd>↑</kbd><kbd>↓</kbd> تنقّل</span>
                <span><kbd>Enter</kbd> فتح</span>
                <span><kbd>Esc</kbd> إغلاق</span>
            </div>
        </div>`;

    document.body.appendChild(overlay);

    input = overlay.querySelector('#cmdkInput');
    listEl = overlay.querySelector('#cmdkList');
    emptyEl = overlay.querySelector('#cmdkEmpty');

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    input.addEventListener('input', () => { refilter(); });
    input.addEventListener('keydown', onKeyDown);

    // النقر بالفأرة: يُختار العنصر عند المرور ثم يُنفَّذ عند الضغط
    listEl.addEventListener('mousemove', (e) => {
        const row = e.target.closest('[data-cmdk-idx]');
        if (!row) return;
        const idx = Number(row.dataset.cmdkIdx);
        if (idx !== selected) { selected = idx; paintSelection(); }
    });
    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('[data-cmdk-idx]');
        if (row) run(Number(row.dataset.cmdkIdx));
    });
}

/* ====================  العرض  ==================== */

function renderList() {
    if (!filtered.length) {
        listEl.innerHTML = '';
        emptyEl.hidden = false;
        return;
    }
    emptyEl.hidden = true;

    let html = '';
    let lastGroup = null;
    filtered.forEach((it, idx) => {
        if (it.group !== lastGroup) {
            html += `<div class="cmdk-group">${esc(it.group)}</div>`;
            lastGroup = it.group;
        }
        html += `
            <div class="cmdk-item" data-cmdk-idx="${idx}" role="option" id="cmdkItem${idx}" aria-selected="false">
                <span class="cmdk-icon">${it.icon || ''}</span>
                <span class="cmdk-text">
                    <span class="cmdk-title">${esc(it.title)}</span>
                    ${it.subtitle ? `<span class="cmdk-sub">${esc(it.subtitle)}</span>` : ''}
                </span>
                ${it.badge ? `<span class="cmdk-badge">${esc(it.badge)}</span>` : ''}
            </div>`;
    });
    listEl.innerHTML = html;
    paintSelection();
}

function paintSelection() {
    listEl.querySelectorAll('.cmdk-item').forEach((el, i) => {
        const on = i === selected;
        el.classList.toggle('is-selected', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
            el.scrollIntoView({ block: 'nearest' });
            input.setAttribute('aria-activedescendant', el.id);
        }
    });
}

function refilter() {
    const q = input.value.trim();

    if (!q) {
        // بلا بحث: الأوامر أولًا لأنها ما يُفتح من أجله الاختصار غالبًا
        filtered = items.filter((it) => it.kind === 'action').slice(0, 12);
    } else {
        filtered = items
            .map((it) => {
                const best = Math.max(
                    score(it.title, q),
                    score(it.subtitle || '', q) - 60,
                    score(it.keywords || '', q) - 90,
                    score(it.group, q) - 120,
                );
                return { it, s: best + (it.boost || 0) };
            })
            .filter((r) => r.s >= 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 40)
            .map((r) => r.it);
    }

    selected = 0;
    renderList();
}

/* ====================  التفاعل  ==================== */

function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filtered.length) { selected = (selected + 1) % filtered.length; paintSelection(); }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filtered.length) { selected = (selected - 1 + filtered.length) % filtered.length; paintSelection(); }
    } else if (e.key === 'Home') {
        e.preventDefault(); selected = 0; paintSelection();
    } else if (e.key === 'End') {
        e.preventDefault(); selected = Math.max(0, filtered.length - 1); paintSelection();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        run(selected);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();   // لا نترك Escape يصل لمعالج الصفحة فيغادر القسم أيضًا
        close();
    } else if (e.key === 'Tab') {
        e.preventDefault();    // حبس التركيز: اللوحة كلها حقل واحد وقائمة
    }
}

function run(idx) {
    const item = filtered[idx];
    if (!item) return;
    close();
    // بعد الإغلاق حتى يستقر التركيز قبل أي تنقّل أو فتح نافذة
    setTimeout(() => {
        try { item.run(); } catch (err) { console.error('[cmdk] فشل تنفيذ الأمر:', err); }
    }, 0);
}

function rebuild() {
    try { items = buildIndex() || []; } catch (err) { console.error('[cmdk] فشل بناء الفهرس:', err); items = []; }
}

/**
 * إعادة بناء الفهرس واللوحة مفتوحة — تُستدعى عندما تصل بيانات قسم كان
 * لم يُحمَّل بعد، فتظهر عناصره فورًا دون أن يُغلق المستخدم اللوحة ويعيد فتحها.
 * تحافظ على نص البحث والعنصر المختار قدر الإمكان.
 */
export function refreshIndex() {
    if (!isOpen) return;
    const keepTitle = filtered[selected]?.title;
    rebuild();
    refilter();
    if (keepTitle) {
        const idx = filtered.findIndex((it) => it.title === keepTitle);
        if (idx >= 0) { selected = idx; paintSelection(); }
    }
}

/** مؤشّر أن أقسامًا أخرى ما زالت تُحمَّل في الخلفية. */
export function setBusy(busy, label = 'يجري تحميل بقية الأقسام…') {
    if (!overlay) return;
    let note = overlay.querySelector('.cmdk-busy');
    if (busy) {
        if (!note) {
            note = document.createElement('span');
            note.className = 'cmdk-busy';
            overlay.querySelector('.cmdk-footer')?.appendChild(note);
        }
        note.textContent = label;
    } else {
        note?.remove();
    }
    overlay.querySelector('.cmdk-list')?.setAttribute('aria-busy', busy ? 'true' : 'false');
}

export function open() {
    if (!overlay) buildDom();
    if (isOpen) return;

    isOpen = true;
    lastFocused = document.activeElement;

    // الفهرس يُبنى عند كل فتح من الحالة الحيّة — لا نسخة تتقادم
    rebuild();
    onOpenHook?.();

    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    input.value = '';
    refilter();
    input.focus();
}

export function close() {
    if (!overlay || !isOpen) return;
    isOpen = false;
    overlay.classList.remove('is-open');
    input.setAttribute('aria-activedescendant', '');
    setTimeout(() => { if (!isOpen) overlay.hidden = true; }, 160);
    lastFocused?.focus?.();
}

export function isPaletteOpen() { return isOpen; }

export function toggle() { isOpen ? close() : open(); }

/**
 * @param {object}   options
 * @param {Function} options.buildIndex دالة تُستدعى عند كل فتح وترجّع مصفوفة عناصر:
 *   { kind:'action'|'entity', group, title, subtitle?, badge?, icon?, keywords?, boost?, run() }
 * @param {Function} [options.onOpen] تُستدعى بعد بناء الفهرس عند كل فتح — للتحميل
 *   المسبق لأقسام لم تُفتح بعد، ثم استدعاء refreshIndex عند وصول بياناتها.
 */
export function init({ buildIndex: builder, onOpen } = {}) {
    if (typeof builder === 'function') buildIndex = builder;
    if (typeof onOpen === 'function') onOpenHook = onOpen;
    if (!overlay) buildDom();
}
