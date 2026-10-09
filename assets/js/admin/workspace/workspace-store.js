/**
 * workspace-store.js — حفظ ترتيب مساحة العمل واستعادته
 * ---------------------------------------------------------------------------
 * طبقتان:
 *
 *   محلية (دائمًا): localStorage لكل مستخدم، تُكتب فورًا مع كل تغيير، فالتحديث
 *     يستعيد الترتيب لحظيًا حتى لو لم يصل الحفظ للخادم بعد.
 *
 *   الخادم (إن وُجدت ترحيلة 075): workspace_get_layout / workspace_save_layout،
 *     بتأخير ~1.5 ثانية وتفريغ عند مغادرة الصفحة. تجعل الترتيب يتبع الموظف
 *     لجهاز آخر. لو الدالة غير منشورة يتوقف المزامنة للجلسة بصمت — مساحة
 *     العمل لا تتعطل بغيابها.
 *
 * ما يُحفظ: البنية وأنواع اللوحات ومعرّفات السجلات فقط (serializeLayout). لا
 * أسماء ولا نصوص ولا رموز جلسة. وما يُستعاد يمرّ كله على parseLayout
 * (مُدخل غير موثوق) ثم على التحقق من الوصول قبل أي عرض.
 *
 * التعارض (نافذتان لنفس الموظف): آخر من يكتب يكسب، صراحةً. الخادم يرجّع
 * conflict = true لو كانت النسخة التي بنينا عليها قديمة، فنعرف ونُبلغ مرة.
 */

const PREFIX = 'mad3oom.workspace.v1.';
const MISSING_CODES = new Set(['PGRST202', '42883', 'PGRST404']);

function readLocal(key) {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function writeLocal(key, value) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false; // وضع خاص أو مساحة ممتلئة: نكمل بالذاكرة والخادم
    }
}

const isMissing = (error) => !!error && (MISSING_CODES.has(error.code) || error.status === 404);
/** 42501: المعاينة للقراءة فقط أو الحساب ليس من جمهور الصندوق — لا فائدة من إعادة المحاولة في هذه الجلسة. */
const isRefused = (error) => error?.code === '42501';
const one = (data) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

/**
 * @param {{userId: string, client: {rpc: Function}, debounceMs?: number,
 *          onStatus?: (status: 'saved'|'local'|'error'|'conflict') => void}} options
 */
export function createStore({ userId, client, debounceMs = 1500, onStatus = () => {} }) {
    const key = PREFIX + userId;
    let server = client ? 'unknown' : 'off'; // unknown | ok | off
    let revision = null;
    let timer = null;
    let pending = null;
    let inFlight = null;
    let conflictNoted = false;

    async function fetchServer() {
        if (server === 'off') return null;
        const { data, error } = await client.rpc('workspace_get_layout');
        if (error) {
            if (isMissing(error) || isRefused(error)) server = 'off';
            return null;
        }
        server = 'ok';
        const row = one(data);
        if (!row?.layout) return null;
        revision = row.revision ?? null;
        return row.layout;
    }

    async function send() {
        timer = null;
        if (!pending || server === 'off') return;
        const payload = pending;
        pending = null;
        inFlight = (async () => {
            const { data, error } = await client.rpc('workspace_save_layout', { p_layout: payload, p_base_revision: revision });
            if (error) {
                if (isMissing(error) || isRefused(error)) { server = 'off'; onStatus('local'); return; }
                pending = pending || payload; // نعيد المحاولة مع التغيير التالي
                onStatus('error');
                return;
            }
            server = 'ok';
            const row = one(data);
            if (row?.revision != null) revision = row.revision;
            if (row?.conflict && !conflictNoted) { conflictNoted = true; onStatus('conflict'); return; }
            onStatus('saved');
        })().catch(() => { onStatus('error'); }).finally(() => { inFlight = null; });
        await inFlight;
    }

    return {
        /**
         * يرجّع أحدث ترتيب محفوظ (محليًا أو على الخادم) كما هو — خامًا.
         * التحقق مسؤولية المستدعي (parseLayout).
         */
        async load({ timeoutMs = 4000 } = {}) {
            const local = readLocal(key);
            let remote = null;
            try {
                remote = await Promise.race([
                    fetchServer(),
                    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
                ]);
            } catch {
                remote = null;
            }
            const localAt = Number(local?.savedAt) || 0;
            const remoteAt = Number(remote?.savedAt) || 0;
            if (remote && remoteAt > localAt) return { raw: remote, source: 'server' };
            if (local?.layout) return { raw: local.layout, source: 'local' };
            return { raw: null, source: 'none' };
        },

        /** @param {object} serialized ناتج serializeLayout() */
        save(serialized) {
            const savedAt = Date.now();
            writeLocal(key, { savedAt, layout: serialized });
            if (server === 'off') { onStatus('local'); return; }
            pending = { ...serialized, savedAt };
            clearTimeout(timer);
            timer = setTimeout(send, debounceMs);
        },

        /** عند مغادرة الصفحة: محاولة أخيرة بلا انتظار. */
        flush() {
            if (!pending) return;
            clearTimeout(timer);
            send();
        },

        clearLocal() {
            try { window.localStorage.removeItem(key); } catch { /* لا شيء */ }
        },

        get serverState() { return server; },
        get busy() { return !!inFlight || !!timer; }
    };
}
