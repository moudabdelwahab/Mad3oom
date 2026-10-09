/**
 * embed-early.js — علامات وضع التضمين قبل أول رسم
 * ---------------------------------------------------------------------------
 * سكربت كلاسيكي صغير في <head> الصفحات التي تستضيفها مساحة العمل (الصندوق،
 * التذاكر، سجل العميل). الوحدات (type=module) مؤجلة بطبيعتها، فلو تُركت هذه
 * العلامات لها لظهر شريط التنقل وعنوان الصفحة لحظةً داخل التبويب ثم اختفى.
 *
 * وضع التضمين لا يُفعَّل إلا بثلاثة شروط معًا: ?embed=1، والصفحة داخل إطار،
 * والإطار الأب من نفس الأصل. قراءة parent.location.origin من أصل آخر ترمي
 * استثناءً، فلو أطّر موقع غريب الصفحة بـ embed=1 تُرسم كاملةً كالمعتاد.
 *
 * لا يغيّر سلوكًا ولا صلاحية: يضيف أصنافًا على <html> تخفي الإطار العام
 * (assets/css/workspace-embed.css)، ويأخذ سمة الألوان من مساحة العمل.
 */
(function () {
    'use strict';
    try {
        var params = new URLSearchParams(window.location.search);
        if (params.get('embed') !== '1' || window.parent === window) return;
        if (window.parent.location.origin !== window.location.origin) return;

        var root = document.documentElement;
        root.classList.add('ws-embedded');
        var view = params.get('view');
        if (view === 'thread' || view === 'ticket' || view === 'customer') root.classList.add('ws-view-' + view);

        var theme = window.parent.document.documentElement.getAttribute('data-theme');
        if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    } catch (e) {
        /* أب من أصل آخر: صفحة عادية */
    }
})();
