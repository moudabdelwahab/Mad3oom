/* ============================================================================
   شبكة Pi حسب النطاق — مصدر واحد لكل الصفحات.

   تطبيقا Pi منفصلان في Developer Portal (الشبكة لا تتغيّر بعد التسجيل، ورابط
   Testnet لا يساوي رابط Mainnet):
     mainnet.mad3oom.com → تطبيق Mainnet (Pi حقيقي) + «وضع Pi»
     أي نطاق آخر        → تطبيق Testnet

   «وضع Pi» يطبّق شروط إدراج Mainnet على هذا النطاق وحده: دخول بحساب Pi فقط،
   ودفع بالـPi فقط. الموقع العادي يبقى كما هو لبقية العملاء.

   الشبكة هنا للعرض والتوجيه فقط: الخادم يختار مفتاح API حسبها، ومفتاح شبكة
   خاطئة لا يقرأ دفعة الشبكة الأخرى أصلًا — فلا قرار مالي يُبنى على قيمة العميل.
============================================================================ */

export const PI_MAINNET_HOST = 'mainnet.mad3oom.com';

/** @returns {'mainnet'|'testnet'} */
export function currentPiNetwork() {
    return location.hostname === PI_MAINNET_HOST ? 'mainnet' : 'testnet';
}

/** نطاق Mainnet: الدخول والدفع بـPi وحدهما. */
export function isPiMode() {
    return currentPiNetwork() === 'mainnet';
}
