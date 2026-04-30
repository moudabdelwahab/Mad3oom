# دليل إعداد Cloudflare Turnstile CAPTCHA

## 📋 نظرة عامة

تم إضافة Cloudflare Turnstile CAPTCHA إلى صفحتي تسجيل الدخول وإنشاء الحساب في مشروع mad3oom.online. حالياً، يتم استخدام **مفاتيح الاختبار** (Testing Keys) التي تسمح بالاختبار المحلي دون الحاجة إلى تفاعل حقيقي.

## 🔑 المفاتيح الحالية (للاختبار فقط)

```
Sitekey (مفتاح عام):     1x00000000000000000000AA
Secret Key (مفتاح سري):  1x0000000000000000000000000000000AA
```

**ملاحظة مهمة:** هذه المفاتيح مخصصة للاختبار فقط وتُرجع دائماً نتيجة ناجحة. لا تستخدمها في الإنتاج!

## 📁 الملفات المعدلة

### 1. **turnstile-config.js** (ملف جديد)
- يحتوي على إعدادات Turnstile
- يتضمن دوال مساعدة للتحقق من التوكن
- يحتوي على شرح مفصل لكيفية الحصول على مفاتيح الإنتاج

### 2. **sign-in.html**
- تمت إضافة Turnstile widget إلى نموذج تسجيل الدخول
- يتم التحقق من التوكن قبل إرسال بيانات تسجيل الدخول

### 3. **sign-up-new.html**
- تمت إضافة Turnstile widget إلى نموذج إنشاء حساب الفرد
- تمت إضافة Turnstile widget إلى نموذج إنشاء حساب الشركة
- يتم التحقق من التوكن قبل إرسال بيانات التسجيل

### 4. **auth-client.js**
- تم تحديث دالة `signIn` لقبول Turnstile token

### 5. **auth-user-types.js**
- تم تحديث دالة `signUpIndividual` لقبول Turnstile token
- تم تحديث دالة `signUpCompany` لقبول Turnstile token

## 🚀 كيفية الحصول على مفاتيح الإنتاج

### الخطوة 1: توجه إلى لوحة تحكم Cloudflare

1. اذهب إلى: https://dash.cloudflare.com/
2. قم بتسجيل الدخول بحسابك على Cloudflare
3. إذا لم تكن لديك حساب، قم بإنشاء واحد (مجاني)

### الخطوة 2: انتقل إلى قسم Turnstile

1. من القائمة الجانبية اليسرى، ابحث عن **"Turnstile"**
2. أو استخدم الرابط المباشر: https://dash.cloudflare.com/?to=/:account/turnstile
3. قد تجدها تحت قسم **"Security"** أو **"Products"**

### الخطوة 3: إنشاء Turnstile Widget جديد

1. اضغط على زر **"Create Site"** أو **"Add widget"**
2. ملء النموذج بالمعلومات التالية:

   | الحقل | القيمة | ملاحظات |
   |-------|--------|---------|
   | **Name** | mad3oom-login | اسم وصفي للـ Widget (يمكنك استخدام أي اسم) |
   | **Domains** | mad3oom.online<br/>www.mad3oom.online | أضف جميع نطاقاتك |
   | **Mode** | Managed | الوضع الافتراضي والموصى به |
   | **Widget Mode** | Turnstile | اختر "Turnstile" (أو "Invisible" إذا كنت تريد بدون تفاعل مرئي) |
   | **Bot Fight Mode** | On (اختياري) | لتفعيل الحماية من الروبوتات |

3. اضغط على **"Create"**

### الخطوة 4: نسخ المفاتيح

بعد الإنشاء، ستحصل على صفحة تحتوي على:

```
Site Key:    YOUR_PRODUCTION_SITEKEY_HERE
Secret Key:  YOUR_PRODUCTION_SECRET_KEY_HERE
```

**انسخ هذه المفاتيح بعناية!**

## 🔄 استبدال مفاتيح الاختبار بمفاتيح الإنتاج

### في ملف `turnstile-config.js`:

```javascript
export const TURNSTILE_CONFIG = {
  // استبدل هذه القيم بمفاتيحك الخاصة
  SITEKEY: 'YOUR_PRODUCTION_SITEKEY_HERE',
  SECRET_KEY: 'YOUR_PRODUCTION_SECRET_KEY_HERE',
  // ... باقي الإعدادات
};
```

### في ملف `sign-in.html`:

ابحث عن:
```html
<div class="cf-turnstile" 
     data-sitekey="1x00000000000000000000AA"
     ...
</div>
```

واستبدل `data-sitekey` بـ:
```html
data-sitekey="YOUR_PRODUCTION_SITEKEY_HERE"
```

### في ملف `sign-up-new.html`:

ابحث عن جميع عناصر Turnstile (هناك اثنتان - واحدة للأفراد وواحدة للشركات):

```html
<div class="cf-turnstile" 
     data-sitekey="1x00000000000000000000AA"
     ...
</div>
```

واستبدل كل واحدة بـ:
```html
data-sitekey="YOUR_PRODUCTION_SITEKEY_HERE"
```

## 🔐 التحقق من جانب الخادم (Server-side Verification)

### ملاحظة مهمة:
التحقق من جانب العميل (Client-side) وحده **ليس كافياً**. يجب التحقق من التوكن على جانب الخادم.

### الخطوات:

1. **إنشاء Supabase Edge Function** للتحقق من Turnstile Token:

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY");

Deno.serve(async (req: Request) => {
  if (req.method === "POST") {
    const { token, remoteIP } = await req.json();

    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: TURNSTILE_SECRET,
          response: token,
          remoteip: remoteIP,
        }),
      }
    );

    const result = await response.json();
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }
});
```

2. **تخزين Secret Key بأمان**:
   - أضف `TURNSTILE_SECRET_KEY` إلى متغيرات البيئة في Supabase
   - لا تشارك هذا المفتاح في الكود العام

3. **استدعاء الدالة من العميل**:
```javascript
const response = await supabase.functions.invoke('verify-turnstile', {
  body: { 
    token: turnstileToken,
    remoteIP: userIP 
  }
});
```

## 📊 مراقبة الأداء

بعد استبدال المفاتيح، يمكنك مراقبة أداء Turnstile من لوحة التحكم:

1. توجه إلى Turnstile في Cloudflare Dashboard
2. اختر الـ Widget الذي أنشأته
3. انظر إلى الإحصائيات:
   - عدد التحديات
   - معدل النجاح
   - الأجهزة المختلفة

## 🧪 اختبار التكامل

### اختبار محلي (مع مفاتيح الاختبار):

1. افتح `http://localhost:3000/sign-in.html`
2. يجب أن ترى Turnstile widget
3. اضغط على الـ checkbox
4. يجب أن يتم التحقق تلقائياً (لأنها مفاتيح اختبار)

### اختبار الإنتاج (مع مفاتيح الإنتاج):

1. انشر التطبيق إلى النطاق الخاص بك
2. افتح صفحة تسجيل الدخول
3. يجب أن ترى Turnstile widget
4. قد يطلب منك إكمال تحدٍ (تحديد الصور، إلخ)
5. بعد النجاح، يجب أن تتمكن من المتابعة

## ⚠️ نصائح أمان مهمة

1. **لا تشارك Secret Key**: أبداً لا تضع Secret Key في الكود العام أو في الملفات المرسلة للعميل
2. **استخدم متغيرات البيئة**: خزن Secret Key في متغيرات البيئة الآمنة
3. **تحقق دائماً من الخادم**: لا تعتمد على التحقق من جانب العميل وحده
4. **راقب الأنشطة المريبة**: استخدم لوحة تحكم Cloudflare لمراقبة محاولات الاختراق

## 🔗 موارد إضافية

- [توثيق Cloudflare Turnstile الرسمية](https://developers.cloudflare.com/turnstile/)
- [دليل التكامل](https://developers.cloudflare.com/turnstile/get-started/)
- [التحقق من جانب الخادم](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

## 📞 الدعم

إذا واجهت أي مشاكل:

1. تحقق من أن النطاقات مضافة بشكل صحيح في Cloudflare
2. تأكد من أن المفاتيح صحيحة
3. تحقق من وحدة تحكم المتصفح للأخطاء
4. راجع توثيق Cloudflare الرسمية

---

**آخر تحديث:** 30 أبريل 2026
