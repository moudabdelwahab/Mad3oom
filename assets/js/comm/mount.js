/**
 * mount.js — نقطة تركيب واحدة لودجت التواصل في كل لوحة.
 *
 * تُنادى بعد أن يقبل حارس اللوحة الجلسة، ولا تنتظرها اللوحة: الودجت يُحمَّل عند الحاجة
 * (import ديناميكي) فلا يزيد وزن الصفحة لمن لا نطاق له، وفشله لا يُسقط اللوحة.
 * من لا جانب له في أي نطاق لهذه اللوحة لا يرى شيئًا (comm_overview في القاعدة يقرر).
 *
 * @param {'portal'|'company'|'admin'|'owner'} surface
 */
export function mountComm(surface) {
    return import('/assets/js/comm/comm-widget.js')
        .then(m => m.mountCommWidget({ surface }))
        .catch(err => { console.error('[Comm] widget:', err?.message || err); return false; });
}
