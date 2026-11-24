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
 * يقرأ رمز خطأ الخادم من نتيجة functions.invoke الفاشلة.
 *
 * supabase-js يحوّل أي رد غير 2xx إلى FunctionsHttpError، وجسم الرد
 * الأصلي يكون في error.context (Response في الإصدارات الحديثة، أو
 * كائن مفكوك في أخرى). يُرجع رمز الخطأ (مثال 'secret_not_configured')
 * أو null إن تعذّرت قراءته.
 */
export async function readFunctionErrorCode(error) {
  try {
    const ctx = error?.context;
    if (!ctx) return null;
    if (typeof ctx === 'object' && typeof ctx.error === 'string') return ctx.error;
    if (typeof ctx.json === 'function') {
      const body = await ctx.json();
      return typeof body?.error === 'string' ? body.error : null;
    }
    if (typeof ctx === 'string') {
      const body = JSON.parse(ctx);
      return typeof body?.error === 'string' ? body.error : null;
    }
  } catch {
    // جسم غير قابل للقراءة — يعامَل كخطأ عام.
  }
  return null;
}

/**
 * انتظار توكن الويدجت: في الوضع المُدار يُحلّ التحدي تلقائيًا خلال
 * ثوانٍ من تحميل الصفحة، فالانتظار القصير يغطي من يضغط «دخول» فورًا.
 * يُرجع { token, loaded } — loaded=false تعني سكربت Turnstile نفسه
 * لم يُحمَّل (شبكة/حجب)، لا أن المستخدم لم يكمل التحدي.
 */
export async function waitForTurnstileToken(timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    if (window.turnstile) {
      const token = await getTurnstileToken();
      if (token) return { token, loaded: true };
    }
    if (Date.now() - started > timeoutMs) return { token: null, loaded: !!window.turnstile };
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * بوابة تسجيل الدخول: تأخذ توكن الويدجت وتتحقق منه عبر دالة الحافة
 * verify-turnstile قبل أي محاولة دخول. تُستدعى من login.html مع
 * اعتماديات الصفحة (supabase, withTimeout, showToast) حتى تبقى قابلة
 * للاختبار في Node ببدائل وهمية.
 *
 * القاعدة: أي فشل تحقق يمنع الدخول، ما عدا حالة واحدة — السرّ غير
 * مضبوط في Supabase (secret_not_configured): تنبيه ظاهر والمتابعة
 * مؤقتًا حتى يُضبط، حتى لا يُقفل الدخول على الجميع بسبب خطأ إعداد.
 * ملاحظة: invoke يرمي FunctionsHttpError لأي رد غير 2xx، فالرمز
 * يُقرأ من جسم الخطأ (readFunctionErrorCode) لا من data.
 */
export async function verifyTurnstileBeforeLogin({ supabase, withTimeout, showToast, tokenTimeoutMs = 8000 }) {
  const { token, loaded } = await waitForTurnstileToken(tokenTimeoutMs);
  if (!loaded) {
    showToast('تعذّر تحميل التحقق الأمني — تحقق من الاتصال وأعد تحميل الصفحة');
    return false;
  }
  if (!token) {
    showToast('أكمل التحقق الأمني أولاً ثم حاول مرة أخرى');
    return false;
  }
  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('verify-turnstile', { body: { token } }),
      10000,
      'التحقق الأمني',
    );
    if (error) {
      const code = await readFunctionErrorCode(error);
      if (code === 'secret_not_configured') {
        console.warn('Turnstile secret is not configured on the server; continuing with a warning.');
        showToast('تنبيه: التحقق الأمني غير مفعّل على الخادم بعد — تمت المتابعة مؤقتًا، أبلغ المسؤول');
        return true;
      }
      console.error('Turnstile verify invoke error:', error);
      showToast('تعذّر التحقق الأمني الآن — حاول مرة أخرى');
      resetTurnstile();
      return false;
    }
    if (data?.success) return true;
    showToast('فشل التحقق الأمني — حاول مرة أخرى');
    resetTurnstile();
    return false;
  } catch (err) {
    console.error('Turnstile verify error:', err);
    showToast(err.message || 'تعذّر التحقق الأمني — حاول مرة أخرى');
    resetTurnstile();
    return false;
  }
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
