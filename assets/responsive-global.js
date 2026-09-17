/* =====================================================================
   MAD3OOM — Global Responsive Helper
   ---------------------------------------------------------------------
   سكربت صغير يُحمَّل في كل صفحة. مهمته الوحيدة: لفّ الجداول العريضة
   داخل حاوية قابلة للتمرير الأفقي حتى لا تمدّ الصفحة على الجوال.

   يعمل على الجداول الموجودة عند التحميل وعلى أي جدول يُضاف لاحقاً
   عبر JavaScript (لوحات التحكم تبني جداولها ديناميكياً).
   ===================================================================== */
(function () {
  'use strict';

  var WRAPPER_CLASS = 'table-responsive';

  function wrap(table) {
    if (!table || !table.parentNode) return;
    // ملفوف بالفعل؟
    var p = table.parentNode;
    if (p.classList && (p.classList.contains(WRAPPER_CLASS) ||
                        p.classList.contains('mad3oom-table-scroll'))) return;
    // جداول داخل حاوية تمرير جاهزة
    if (p.closest && p.closest('.' + WRAPPER_CLASS)) return;

    var box = document.createElement('div');
    box.className = WRAPPER_CLASS;
    p.insertBefore(box, table);
    box.appendChild(table);
  }

  function wrapAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var tables = scope.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) wrap(tables[i]);
  }

  function init() {
    wrapAll(document);

    // الجداول التي تُبنى ديناميكياً بعد جلب البيانات
    if (typeof MutationObserver === 'function') {
      var mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'TABLE') { wrap(n); continue; }
            if (n.querySelectorAll) wrapAll(n);
            // الصفوف التي تصل بعد جلب البيانات: الجدول نفسه قد يكون رُسم
            // فارغاً من قبل ولم يُلفّ بعد، فنصعد إليه من الصف المُضاف.
            if (n.closest) {
              var owner = n.closest('table');
              if (owner) wrap(owner);
            }
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
