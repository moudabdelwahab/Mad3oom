/**
 * chat-icons.js
 * ------------------------------------------------------------
 * مصدر واحد لتحويل الرموز [[icon:name]] (اللي بترجع من chatbot-engine.js
 * وقوالب SIE في sie/dialogue/templates/*.js) إلى أيقونات SVG حقيقية.
 *
 * ده كان في الأصل موجود بس كنسخة محلية جوه chat-logic.js (وده اللي خلى
 * chat-widget.js - اللي بيستخدم نفس الرموز بالظبط - يعرض النص خام زي
 * "[[icon:inquiry]] عندي استفسار" من غير ما يتحول لأيقونة). دلوقتي أي ملف
 * محتاج يعرض رسائل بوت أو خيارات سريعة يستورد iconize() من هنا بدل ما
 * يكرر تعريف الخريطة.
 *
 * لازم iconize() يتستخدم دايمًا بعد escapeHtml() (النص بعد التنقية لسه
 * فيه [[icon:...]] عادي لأن التنقية مبتلمسش الأقواس المربعة أو النقطتين).
 */
export const ICON_SVG_MAP = {
    inquiry: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1.4.9-1.4 1.9"></path><circle cx="12" cy="17" r="0.5" fill="currentColor"></circle></svg>',
    problem: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l10 18H2z"></path><path d="M12 10v4"></path><circle cx="12" cy="17" r="0.5" fill="currentColor"></circle></svg>',
    cancel: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M9 9l6 6M15 9l-6 6"></path></svg>',
    whatsapp: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20l1.4-4.2A8 8 0 1 1 8.6 19L4 20z"></path><path d="M9 10s.5 3 3 4"></path></svg>',
    ticket: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="10" rx="1.5"></rect><path d="M9 7v10" stroke-dasharray="2 2"></path></svg>',
    subscription: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path></svg>',
    login: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"></path><path d="M10 8l4 4-4 4"></path><path d="M14 12H3"></path></svg>',
    other: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>',
    attach: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.5l-8.5 8.5a4 4 0 1 1-5.7-5.7l9-9a2.7 2.7 0 1 1 3.8 3.8l-8.5 8.5a1.3 1.3 0 1 1-1.9-1.9l7.4-7.4"></path></svg>',
    skip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l7 7-7 7"></path><path d="M13 5l7 7-7 7"></path></svg>',
    gift: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="9" width="18" height="12" rx="1"></rect><path d="M3 9h18v4H3z"></path><path d="M12 9v12"></path><path d="M12 9c-1.5-4-6-4-6-1s4.5 1 6 1c1.5 0 6.5 2 6-1s-4.5-3-6 1z"></path></svg>',
    growth: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l5-5 4 4 7-7"></path><path d="M15 8h5v5"></path></svg>',
    star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3l2.6 5.9 6.4.6-4.9 4.2 1.5 6.3L12 16.9 6.4 20l1.5-6.3-4.9-4.2 6.4-.6z"></path></svg>',
    briefcase: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="12" rx="1.5"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.5 2.5L16 9"></path></svg>',
    note: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v0.5"></path><path d="M12 11v5"></path></svg>',
    smile: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><path d="M8.5 9.5h.5M15 9.5h.5"></path></svg>',
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="M20 20l-4.6-4.6"></path></svg>',
    percent: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 19L19 5"></path><circle cx="7" cy="7" r="2"></circle><circle cx="17" cy="17" r="2"></circle></svg>',
    'dot-yellow': '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#eab308;"></span>',
    'dot-blue': '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;"></span>',
    'dot-green': '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;"></span>',
    'dot-red': '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;"></span>'
};

/**
 * @param {string} text - نص بعد ما يكون اتعمله escapeHtml بالفعل
 * @returns {string} نفس النص لكن رموز [[icon:name]] بقت SVG حقيقي (أو
 *   اتشالت لو الاسم مش معروف، عشان محدش يشوف رمز خام في الشات)
 */
export function iconize(text) {
    if (!text) return '';
    return String(text).replace(/\[\[icon:([a-z-]+)\]\]/g, (match, name) => {
        const svg = ICON_SVG_MAP[name];
        return svg ? `<span style="display:inline-flex;vertical-align:middle;margin:0 2px;">${svg}</span>` : '';
    });
}
