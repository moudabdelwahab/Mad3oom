/**
 * Cloudflare Turnstile — إعداد الواجهة (المفتاح العام وحده)
 * =========================================================
 *
 * ⚠️ تحذير أمني تاريخي — اقرأه قبل تعديل هذا الملف
 * -------------------------------------------------
 * كان هذا الملف يحمل `SECRET_KEY` مكتوبًا بنصّه، ودالة `verifyTurnstileToken`
 * التي تُرسله إلى Cloudflare **من المتصفح**. والمشروع يُنشَر على Vercel كملفات
 * ثابتة، أي أن أي زائر كان يقدر يفتح:
 *
 *     https://<domain>/turnstile-config.js
 *
 * ويقرأ السرّ كاملًا. وكان تعليق الملف نفسه يقول: «الـ Secret Key يجب أن يبقى
 * سريًا ولا يُرسل للعميل».
 *
 * (H-08 في FULL_PROJECT_AUDIT.md.)
 *
 * ملاحظة مخفِّفة واحدة، ولا تلغي الخطر: الملف لم يكن مستوردًا من أي مكان —
 * صفر مرجع في كل المستودع — فأثره الوظيفي كان معدومًا. لكن السرّ كان مكشوفًا
 * فعلًا على الإنترنت، وما زال في تاريخ Git.
 *
 * ⛔ إجراء إلزامي: **المفتاح القديم يجب اعتباره مخترَقًا ويجب تدويره**
 *    من لوحة Cloudflare (Turnstile → الويدجت → Rotate Secret). حذفه من هنا
 *    لا يُبطله، ولا يمحوه من تاريخ المستودع.
 *
 * القاعدة من الآن: السرّ لا يدخل هذا الملف ولا أي ملف يُخدَم للمتصفح إطلاقًا.
 * التحقق من التوكن يتم في دالة حافة تقرأ `TURNSTILE_SECRET_KEY` من
 * `Deno.env` — نفس نمط بقية أسرار المشروع (RESEND_API_KEY، WHATSAPP_TOKEN،
 * MCP_ENC_KEY …).
 */

export const TURNSTILE_CONFIG = {
  // المفتاح العام (Site Key) — يُعرض في HTML بطبيعته، وليس سرًّا.
  SITEKEY: '0x4AAAAAADnzinuKMCVrMqHi',

  // عنوان سكربت الويدجت
  WIDGET_SCRIPT_URL: 'https://challenges.cloudflare.com/turnstile/v0/api.js',

  // إعدادات العرض
  WIDGET_THEME: 'light', // 'light' أو 'dark'
  WIDGET_SIZE: 'normal', // 'normal' أو 'compact'
  WIDGET_MODE: 'managed',
};

/** توكن الويدجت الحالي من المتصفح، أو null. */
export function getTurnstileToken() {
  return new Promise((resolve) => {
    if (window.turnstile) {
      resolve(window.turnstile.getResponse() || null);
    } else {
      resolve(null);
    }
  });
}

/** إعادة تعيين الويدجت. */
export function resetTurnstile() {
  if (window.turnstile) window.turnstile.reset();
}

/** إزالة الويدجت. */
export function removeTurnstile() {
  if (window.turnstile) window.turnstile.remove();
}

/**
 * التحقق من التوكن — **لا يقع هنا**.
 *
 * الدالة السابقة بهذا الاسم كانت تُرسل السرّ من المتصفح، وهي سبب التسريب.
 * أي تحقق حقيقي يجب أن يجري في دالة حافة على الخادم:
 *
 *   // supabase/functions/<name>/index.ts
 *   const form = new FormData();
 *   form.append('secret', Deno.env.get('TURNSTILE_SECRET_KEY')!);
 *   form.append('response', token);
 *   form.append('remoteip', req.headers.get('x-forwarded-for') ?? '');
 *   const res = await fetch(
 *     'https://challenges.cloudflare.com/turnstile/v0/siteverify',
 *     { method: 'POST', body: form },
 *   );
 *   const { success } = await res.json();
 *
 * التحقق من جانب العميل وحده لا قيمة أمنية له على أي حال: من يتجاوز الويدجت
 * يتجاوز الفحص الذي يجري في متصفحه هو.
 */
