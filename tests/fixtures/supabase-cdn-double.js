/**
 * بديل اختباري لسكربت supabase-js المُحمَّل من CDN.
 *
 * صفحة admin/subscriptions.html لا تستخدم /api-config.js: هي سكربت كلاسيكي
 * ينشئ العميل من الكائن العام window.supabase الذي يضعه سكربت الـCDN. فبديل
 * الوحدات (supabase-double.js) لا يلتقطها، ولذلك يوجد هذا البديل المنفصل.
 *
 * يسجّل كل نداء RPC في window.__RPC_CALLS__ حتى يتأكد الاختبار أن الإجراء
 * ذهب فعلًا إلى دالة القاعدة، لا أن الواجهة اكتفت برسالة نجاح.
 *
 * ملاحظة: اختباري فقط ولا يُستخدَم في الإنتاج.
 */
(function () {
    const FX = () => (window.__FIXTURES__ || {});
    window.__RPC_CALLS__ = [];

    function createClient() {
        return {
            rpc: async (name, args) => {
                window.__RPC_CALLS__.push([name, args ?? null]);
                const fixture = FX().rpc?.[name];
                if (fixture !== undefined && fixture !== null) return { data: fixture, error: null };
                return { data: null, error: null };
            },
            auth: {
                getUser: async () => ({ data: { user: FX().user || null } }),
                getSession: async () => ({ data: { session: FX().user ? { user: FX().user } : null } }),
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
            }
        };
    }

    window.supabase = { createClient };
})();
