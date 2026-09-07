/**
 * بديل اختباري (test double) لعميل Supabase.
 *
 * الهدف: تشغيل كود لوحة العميل الحقيقي بالكامل (customer-dashboard.js
 * والخدمات المستوردة منه) في متصفح فعلي، من غير أي اتصال بقاعدة بيانات
 * حقيقية. البديل ده بيقلّد الـquery builder اللي الخدمات بتستخدمه فعليًا
 * ويرجّع بيانات ثابتة من window.__FIXTURES__.
 *
 * ملاحظة: الملف ده اختباري فقط ولا يُستخدَم في الإنتاج.
 */

const FX = () => (window.__FIXTURES__ || {});

function resolveRows(table) {
    const rows = FX().tables?.[table];
    return Array.isArray(rows) ? rows.slice() : [];
}

/** query builder قابل للسلسلة (chainable) وقابل للانتظار (thenable). */
function builder(table, mode = 'select') {
    const state = {
        table, filters: [], notFilters: [], gtFilters: [],
        single: false, maybeSingle: false, head: false, countMode: null, range: null
    };

    const run = () => {
        let rows = resolveRows(table);
        for (const [col, value] of state.filters) {
            rows = rows.filter(r => {
                if (Array.isArray(value)) return value.includes(r[col]);
                return String(r[col]) === String(value);
            });
        }
        for (const [col, value] of state.notFilters) {
            rows = rows.filter(r => String(r[col]) !== String(value));
        }
        for (const [col, value] of state.gtFilters) {
            rows = rows.filter(r => Number(r[col]) > Number(value));
        }
        if (state.isNull) rows = rows.filter(r => r[state.isNull] === null || r[state.isNull] === undefined);

        // العدّ قبل الترقيم: بيقلّد سلوك count:'exact' مع range في PostgREST
        const count = rows.length;

        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
        if (state.limit != null) rows = rows.slice(0, state.limit);

        if (state.head) return { data: null, error: null, count };
        if (state.single || state.maybeSingle) {
            return { data: rows[0] ?? null, error: null, count };
        }
        return { data: rows, error: null, count };
    };

    const api = {
        select(_cols, opts) {
            if (opts?.head) state.head = true;
            if (opts?.count) state.countMode = opts.count;
            return api;
        },
        insert(payload) {
            const row = Array.isArray(payload) ? payload[0] : payload;
            state.inserted = { id: `new-${table}-${Date.now()}`, ticket_number: 9001, ...row };
            (FX().tables?.[table] || []).push(state.inserted);
            return api;
        },
        update(patch) { state.patch = patch; return api; },
        delete() { state.deleted = true; return api; },
        upsert(payload, opts) {
            const row = Array.isArray(payload) ? payload[0] : payload;
            const rows = FX().tables?.[table];
            const keys = String(opts?.onConflict || 'id').split(',').map(k => k.trim());
            const existing = Array.isArray(rows)
                ? rows.find(r => keys.every(k => String(r[k]) === String(row[k])))
                : null;
            if (existing) {
                Object.assign(existing, row);
                state.inserted = existing;
            } else {
                return api.insert(payload);
            }
            return api;
        },
        eq(col, value) { state.filters.push([col, value]); return api; },
        neq(col, value) { state.notFilters.push([col, value]); return api; },
        gt(col, value) { state.gtFilters.push([col, value]); return api; },
        gte() { return api; },
        lte() { return api; },
        lt() { return api; },
        in(col, values) { state.filters.push([col, values]); return api; },
        is(col) { state.isNull = col; return api; },
        or() { return api; },
        ilike() { return api; },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        range(from, to) { state.range = [from, to]; return api; },
        single() { state.single = true; return api; },
        maybeSingle() { state.maybeSingle = true; return api; },
        then(onFulfilled, onRejected) {
            let result;
            if (state.inserted) result = { data: state.inserted, error: null };
            else if (state.patch || state.deleted) result = { data: null, error: null };
            else result = run();
            return Promise.resolve(result).then(onFulfilled, onRejected);
        }
    };
    return api;
}

/**
 * دوال RPC اللي ليها منطق فعلي في القاعدة.
 *
 * ليه هنا مش في الـfixtures؟ لأن الـfixtures بتتمرّر عبر addInitScript،
 * والتمرير ده بيتسلسل (serialize) — فأي دالة في الكائن بتضيع. تقليد العقد
 * هنا بيخلي الاختبار يمرّن نفس السلوك اللي القاعدة بتنفّذه.
 */
const RPC_IMPLEMENTATIONS = {
    // يطابق search_help_articles: بحث في العنوان/المقتطف/المتن مرتّب بالصلة
    search_help_articles(args) {
        const rows = resolveRows('knowledge_base');
        const term = String(args?.p_query || '').trim().toLowerCase();
        const category = args?.p_category || null;
        const limit = Math.min(Math.max(Number(args?.p_limit) || 20, 1), 50);
        const offset = Math.max(Number(args?.p_offset) || 0, 0);

        return rows
            .filter(a => !category || a.category === category)
            .map(a => {
                if (!term) return { ...a, relevance: 0 };
                const title = String(a.title || '').toLowerCase();
                const excerpt = String(a.excerpt || '').toLowerCase();
                const content = String(a.content || '').toLowerCase();
                if (title.includes(term)) return { ...a, relevance: 3 };
                if (excerpt.includes(term)) return { ...a, relevance: 2 };
                if (content.includes(term)) return { ...a, relevance: 1 };
                return null;
            })
            .filter(Boolean)
            .sort((x, y) => y.relevance - x.relevance || (y.view_count || 0) - (x.view_count || 0))
            .slice(offset, offset + limit);
    },

    increment_article_view(args) {
        const row = resolveRows('knowledge_base').find(a => a.id === args?.p_article_id);
        const live = (FX().tables?.knowledge_base || []).find(a => a.id === args?.p_article_id);
        if (live) live.view_count = (live.view_count || 0) + 1;
        void row;
        return null;
    }
};

export const supabase = {
    from: (table) => builder(table),
    rpc: async (name, args) => {
        // الـfixture لها الأولوية: أي اختبار عايز يجبر نتيجة بعينها يقدر
        const handler = FX().rpc?.[name];
        if (typeof handler === 'function') return { data: handler(args), error: null };
        if (handler !== undefined && handler !== null) return { data: handler, error: null };
        if (RPC_IMPLEMENTATIONS[name]) return { data: RPC_IMPLEMENTATIONS[name](args), error: null };
        return { data: null, error: null };
    },
    auth: {
        getUser: async () => ({ data: { user: FX().user || null } }),
        getSession: async () => ({ data: { session: FX().user ? { user: FX().user, access_token: 'test' } : null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        updateUser: async () => ({ data: {}, error: null })
    },
    channel: () => {
        const chan = { on: () => chan, subscribe: () => chan, unsubscribe: () => {} };
        return chan;
    },
    removeChannel: () => {},
    storage: {
        from: () => ({
            upload: async () => ({ error: null }),
            getPublicUrl: (p) => ({ data: { publicUrl: `/uploads/${p}` } })
        })
    }
};

export function debugAuthError() {}
export async function supabaseRestFetch() { return new Response('[]', { status: 200 }); }
