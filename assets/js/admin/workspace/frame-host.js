/**
 * frame-host.js — طبقة الإطارات فوق مساحة العمل
 * ---------------------------------------------------------------------------
 * لماذا طبقة منفصلة بدل وضع الإطار داخل مجموعته؟
 *
 *   نقل <iframe> في الـ DOM (من مجموعة لأخرى) يعيد تحميله من الصفر في كل
 *   المتصفحات — فسحب تبويب محادثة لمجموعة أخرى كان سيمسح الرد المكتوب فيها
 *   ويعيد تشغيل الصفحة. هنا لا يتحرك الإطار أبدًا: كل الإطارات أبناء طبقة
 *   واحدة، وكل ما يتغير عند السحب والإرساء وتغيير الحجم هو إحداثياته فوق
 *   «جسم» المجموعة التي تعرضه. (نفس أسلوب VS Code مع الـ webviews.)
 *
 * الإطار يُنشأ أول مرة يظهر فيها تبويبه (تحميل كسول)، ويبقى حيًّا مخفيًّا
 * عند التبديل. فوق الحد (maxLive) يُفرَّغ أقدم إطار مخفي **نظيف** فقط؛ الإطار
 * الذي فيه كلام لم يُرسل لا يُفرَّغ أبدًا.
 */

const ALLOW = 'microphone; clipboard-write; autoplay';

export class FrameHost {
    /**
     * @param {HTMLElement} layer
     * @param {{maxLive?: number, isDirty: (panelId) => boolean, onCreate?: (panelId, frame) => void}} options
     */
    constructor(layer, { maxLive = 6, isDirty, onCreate } = {}) {
        this.layer = layer;
        this.maxLive = maxLive;
        this.isDirtyFn = isDirty || (() => false);
        this.onCreate = onCreate || (() => {});
        /** panelId → { el, url, body: HTMLElement|null, shownAt } */
        this.frames = new Map();
        this.frame = null;
        this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.schedule()) : null;
        window.addEventListener('resize', () => this.schedule());
    }

    /**
     * يطابق الإطارات مع الحالة.
     * @param {Array<{panelId: string, url: string|null, title: string, body: HTMLElement|null}>} entries
     *        body ≠ null ⇒ اللوحة ظاهرة فوق هذا العنصر.
     */
    sync(entries) {
        const wanted = new Set(entries.map((e) => e.panelId));
        for (const panelId of [...this.frames.keys()]) {
            if (!wanted.has(panelId)) this.destroy(panelId);
        }

        this.observer?.disconnect();
        if (this.observer) this.observer.observe(this.layer);

        for (const entry of entries) {
            let item = this.frames.get(entry.panelId);
            // نفس المعرّف لسجل آخر: الإطار القديم لا يخص هذه اللوحة.
            if (item && entry.url && item.url !== entry.url) { this.destroy(entry.panelId); item = null; }
            if (!item && entry.body && entry.url) item = this.create(entry.panelId, entry.url);
            if (!item) continue;
            item.el.title = entry.title || '';
            item.body = entry.body;
            if (entry.body) {
                item.shownAt = performance.now();
                this.observer?.observe(entry.body);
            }
        }
        this.position();
        this.enforceCap();
    }

    create(panelId, url) {
        const el = document.createElement('iframe');
        el.className = 'ws-frame';
        el.dataset.panel = panelId;
        el.setAttribute('allow', ALLOW);
        el.referrerPolicy = 'same-origin';
        el.src = url;
        const item = { el, url, body: null, shownAt: 0 };
        this.frames.set(panelId, item);
        this.layer.appendChild(el);
        this.onCreate(panelId, el);
        return item;
    }

    destroy(panelId) {
        const item = this.frames.get(panelId);
        if (!item) return;
        if (item.body) this.observer?.unobserve(item.body);
        item.el.remove();
        this.frames.delete(panelId);
    }

    /** يعيد تحميل اللوحة (زر «إعادة تحميل»): الإطار القديم يُزال ويُنشأ جديد عند الرسم. */
    reload(panelId) {
        const item = this.frames.get(panelId);
        if (!item) return;
        const { url, body } = item;
        this.destroy(panelId);
        if (body) { const fresh = this.create(panelId, url); fresh.body = body; fresh.shownAt = performance.now(); }
        this.position();
    }

    schedule() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => { this.frame = null; this.position(); });
    }

    /** يضع كل إطار ظاهر فوق جسم مجموعته، ويخفي الباقي بلا تفريغ. */
    position() {
        const base = this.layer.getBoundingClientRect();
        for (const item of this.frames.values()) {
            const { el, body } = item;
            const rect = body?.isConnected ? body.getBoundingClientRect() : null;
            if (!rect || rect.width < 1 || rect.height < 1) {
                if (!el.classList.contains('is-hidden')) {
                    el.classList.add('is-hidden');
                    el.inert = true;
                    el.setAttribute('aria-hidden', 'true');
                    el.tabIndex = -1;
                }
                continue;
            }
            el.style.left = `${rect.left - base.left}px`;
            el.style.top = `${rect.top - base.top}px`;
            el.style.width = `${rect.width}px`;
            el.style.height = `${rect.height}px`;
            if (el.classList.contains('is-hidden')) {
                el.classList.remove('is-hidden');
                el.inert = false;
                el.removeAttribute('aria-hidden');
                el.removeAttribute('tabindex');
            }
        }
    }

    enforceCap() {
        const live = [...this.frames.entries()];
        if (live.length <= this.maxLive) return;
        const candidates = live
            .filter(([id, item]) => !item.body && !this.isDirtyFn(id))
            .sort((a, b) => a[1].shownAt - b[1].shownAt);
        for (const [id] of candidates.slice(0, live.length - this.maxLive)) this.destroy(id);
    }

    /** أثناء السحب أو تغيير الحجم: الإطارات لا تبتلع أحداث المؤشر. */
    setPassive(passive) {
        this.layer.classList.toggle('is-passive', passive);
    }

    has(panelId) {
        return this.frames.has(panelId);
    }

    panelForSource(source) {
        for (const [id, item] of this.frames) {
            if (item.el.contentWindow === source) return id;
        }
        return null;
    }

    /**
     * سؤال مباشر للصفحة (نفس الأصل) — أدق من آخر رسالة وصلت.
     * @returns {boolean|null} null = لا يمكن السؤال (لم تُحمَّل بعد أو لا جسر فيها).
     */
    askDirty(panelId) {
        const item = this.frames.get(panelId);
        try {
            const api = item?.el.contentWindow?.__mad3oomEmbed;
            return api ? !!api.isDirty() : null;
        } catch {
            return null;
        }
    }

    post(panelId, message) {
        const win = this.frames.get(panelId)?.el.contentWindow;
        win?.postMessage(message, window.location.origin);
    }

    broadcast(message, { except = null } = {}) {
        for (const id of this.frames.keys()) if (id !== except) this.post(id, message);
    }

    focus(panelId) {
        const el = this.frames.get(panelId)?.el;
        if (!el) return false;
        el.focus();
        try { el.contentWindow?.focus(); } catch { /* لا شيء */ }
        return true;
    }
}
