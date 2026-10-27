/* «وضع Pi» قبل أول رسم: على نطاق تطبيق Mainnet يُعلَّم <html data-pi-mode>،
   والأنماط تخفي كل ما يخالف شروط إدراج Mainnet (دخول غير Pi، ودفع غير Pi)
   بلا وميض. سكربت عادي متزامن في <head> عمدًا — لا module. المصدر الوحيد لاسم
   النطاق في الوحدات هو assets/js/pi-network.js؛ وهذا الملف يكرّره لأنه يعمل
   قبل تحميل أي module. */
(function () {
    if (location.hostname === 'mainnet.mad3oom.com') {
        document.documentElement.setAttribute('data-pi-mode', '');
    }
})();
