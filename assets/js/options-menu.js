/**
 * options-menu.js — قائمة «خيارات» مشتركة لصفوف المستخدمين
 * (صفحة «المستخدمين» في الإدارة، و«المستخدمون» في لوحة الشركة).
 *
 * عنصر واحد ثابت الموضع على مستوى الصفحة يُبنى عند كل فتح من قائمة إجراءات
 * يمرّرها المستدعي؛ القائمة لا تعرف شيئًا عن الإجراءات نفسها ولا تقرر من يراها.
 *
 * actions: [{ group: 'عنوان' } | { id, label, danger?, current? }]
 *
 * السلوك: تحت الزر (أو فوقه إن لم يتسع) ومحاذاة حافة البداية في RTL، تتبع زرها
 * مع التمرير وتُغلق حين يخرج من الشاشة؛ الأسهم تتنقل، وEscape يغلق ويعيد التركيز
 * للزر، والنقر خارجها يغلقها. النصوص تُكتب بـ textContent دائمًا.
 */
export function createOptionsMenu({ id } = {}) {
    const el = document.createElement('div');
    el.className = 'opt-menu';
    if (id) el.id = id;
    el.setAttribute('role', 'menu');
    el.hidden = true;
    document.body.appendChild(el);

    let current = null; // { button, onSelect }

    function position() {
        const button = current?.button;
        if (!button || !button.isConnected) { close(); return; }
        const r = button.getBoundingClientRect();
        const vw = document.documentElement.clientWidth, vh = window.innerHeight;
        if (r.bottom < 0 || r.top > vh) { close(); return; }
        const w = el.offsetWidth, h = el.offsetHeight;
        const rtl = getComputedStyle(button).direction === 'rtl';
        const left = Math.min(Math.max(8, rtl ? r.right - w : r.left), vw - w - 8);
        let top = r.bottom + 6;
        if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    function close(returnFocus = false) {
        if (el.hidden) return;
        el.hidden = true;
        current?.button.setAttribute('aria-expanded', 'false');
        if (returnFocus) current?.button.focus();
        current = null;
    }

    function open(button, { title = '', subtitle = '', actions = [] } = {}, onSelect = () => {}) {
        close();
        current = { button, onSelect };

        const nodes = [];
        if (title || subtitle) {
            const head = document.createElement('div');
            head.className = 'opt-menu-head';
            const t = document.createElement('strong');
            t.textContent = title;
            head.append(t);
            if (subtitle) {
                const s = document.createElement('span');
                s.textContent = subtitle;
                head.append(s);
            }
            nodes.push(head);
        }
        for (const a of actions) {
            if (a.group) {
                const g = document.createElement('div');
                g.className = 'opt-menu-group';
                g.textContent = a.group;
                nodes.push(g);
                continue;
            }
            const item = document.createElement('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitem');
            item.className = 'opt-menu-item' + (a.danger ? ' is-danger' : '') + (a.current ? ' is-current' : '');
            item.dataset.action = a.id;
            item.textContent = a.label;
            if (a.current) {
                item.setAttribute('aria-current', 'true');
                const tag = document.createElement('small');
                tag.textContent = 'الحالية';
                item.append(tag);
            }
            item.addEventListener('click', () => {
                const select = current?.onSelect;
                close();
                select?.(a.id, a);
            });
            nodes.push(item);
        }
        el.replaceChildren(...nodes);
        el.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        position();
        el.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
    }

    const isOpenFor = (button) => !el.hidden && current?.button === button;

    document.addEventListener('click', (e) => {
        if (!el.hidden && !el.contains(e.target) && !current?.button.contains(e.target)) close();
    });
    // تتبع زرها مع التمرير وتغيير الحجم؛ تمرير القائمة نفسها (حين تطول) لا يحرّكها
    const follow = (e) => { if (!el.hidden && !el.contains(e?.target)) position(); };
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    el.addEventListener('keydown', (e) => {
        const items = [...el.querySelectorAll('[role="menuitem"]')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); close(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        else if (e.key === 'Tab') close();
    });

    return { open, close, isOpenFor, element: el };
}

/** زر «⋮ خيارات» لصف — نفس الزر في كل لوحة. */
export function optionsTrigger({ label, className = '' } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `opt-trigger ${className}`.trim();
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    if (label) btn.setAttribute('aria-label', label);
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg><span>خيارات</span>';
    return btn;
}
