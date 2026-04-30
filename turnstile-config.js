/**
 * Cloudflare Turnstile CAPTCHA Configuration
 * ==========================================
 * 
 * Testing Keys (للاختبار):
 * - Sitekey: 1x00000000000000000000AA
 * - Secret Key: 1x0000000000000000000000000000000AA
 * 
 * هذه المفاتيح مخصصة للاختبار فقط وتُرجع دائماً نتيجة ناجحة
 * للحصول على مفاتيح الإنتاج الخاصة بك، انظر الشرح في نهاية هذا الملف
 */

export const TURNSTILE_CONFIG = {
  // مفاتيح الاختبار (Testing Keys)
  SITEKEY: '1x00000000000000000000AA',
  SECRET_KEY: '1x0000000000000000000000000000000AA',
  
  // API Endpoints
  SITEVERIFY_URL: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  WIDGET_SCRIPT_URL: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
  
  // Widget Configuration
  WIDGET_THEME: 'light', // 'light' أو 'dark'
  WIDGET_SIZE: 'normal', // 'normal' أو 'compact'
  WIDGET_MODE: 'managed', // 'managed' (افتراضي) أو 'non-interactive'
};

/**
 * دالة للتحقق من صحة Turnstile Token على جانب العميل
 * (للتحقق الأساسي قبل الإرسال للخادم)
 */
export function getTurnstileToken() {
  return new Promise((resolve) => {
    if (window.turnstile) {
      const token = window.turnstile.getResponse();
      resolve(token || null);
    } else {
      resolve(null);
    }
  });
}

/**
 * دالة لإعادة تعيين Turnstile Widget
 */
export function resetTurnstile() {
  if (window.turnstile) {
    window.turnstile.reset();
  }
}

/**
 * دالة لإزالة Turnstile Widget
 */
export function removeTurnstile() {
  if (window.turnstile) {
    window.turnstile.remove();
  }
}

/**
 * دالة للتحقق من صحة Turnstile Token على جانب الخادم
 * يجب استدعاء هذه الدالة من Supabase Edge Function
 * 
 * @param {string} token - Turnstile token من العميل
 * @param {string} remoteIP - عنوان IP للعميل (اختياري)
 * @returns {Promise<object>} - نتيجة التحقق
 */
export async function verifyTurnstileToken(token, remoteIP = null) {
  try {
    const formData = new FormData();
    formData.append('secret', TURNSTILE_CONFIG.SECRET_KEY);
    formData.append('response', token);
    
    if (remoteIP) {
      formData.append('remoteip', remoteIP);
    }

    const response = await fetch(TURNSTILE_CONFIG.SITEVERIFY_URL, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Siteverify API returned status ${response.status}`);
    }

    const result = await response.json();
    
    return {
      success: result.success,
      challenge_ts: result.challenge_ts,
      hostname: result.hostname,
      error_codes: result.error_codes || [],
      score: result.score, // للـ Invisible mode
      score_reason: result.score_reason, // للـ Invisible mode
    };
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * شرح كيفية الحصول على مفاتيح الإنتاج من Cloudflare
 * ================================================
 * 
 * 1. توجه إلى لوحة تحكم Cloudflare:
 *    https://dash.cloudflare.com/
 * 
 * 2. اختر حسابك (Account) من القائمة الجانبية
 * 
 * 3. انتقل إلى: Turnstile (قد تجدها تحت "Security" أو البحث عنها مباشرة)
 *    الرابط المباشر: https://dash.cloudflare.com/?to=/:account/turnstile
 * 
 * 4. اضغط على "Create Site" أو "Add widget"
 * 
 * 5. ملء النموذج:
 *    - Name: اسم الـ Widget (مثل: "mad3oom-login" أو "mad3oom-signup")
 *    - Domains: أضف نطاقاتك (مثل: mad3oom.online, www.mad3oom.online)
 *    - Mode: اختر "Managed" (الوضع الافتراضي والموصى به)
 *    - Widget Mode: اختر "Turnstile" (أو Invisible إذا كنت تريد بدون تفاعل مرئي)
 * 
 * 6. بعد الإنشاء، ستحصل على:
 *    - Site Key (مفتاح عام - يمكن مشاركته)
 *    - Secret Key (مفتاح سري - احفظه بأمان ولا تشاركه)
 * 
 * 7. استبدل القيم في هذا الملف:
 *    SITEKEY: 'YOUR_PRODUCTION_SITEKEY'
 *    SECRET_KEY: 'YOUR_PRODUCTION_SECRET_KEY'
 * 
 * 8. للتحقق من الخادم، ستحتاج إلى:
 *    - إضافة SECRET_KEY إلى Supabase Edge Function
 *    - استدعاء Siteverify API من الخادم (انظر verifyTurnstileToken)
 * 
 * ملاحظات مهمة:
 * ===============
 * - مفاتيح الاختبار تعمل فقط للاختبار المحلي
 * - مفاتيح الإنتاج تتطلب تفاعل حقيقي من المستخدم
 * - يجب التحقق دائماً من الخادم، لا تعتمد على التحقق من جانب العميل وحده
 * - الـ Secret Key يجب أن يبقى سرياً ولا يُرسل للعميل
 */
