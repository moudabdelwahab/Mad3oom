/**
 * template.js — رسائل company-member-admin (عربي، RTL). وحدة خالصة، مُختبَرة في
 * tests/company-member-admin-function.test.mjs. كل نص من خارج القالب (اسم الشركة) يُهرَّب.
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** اسم الشركة نص تكتبه الشركة: بلا محارف تحكم (سطر جديد في الموضوع) ولا أطول من 120. */
const companyLabel = (name) => String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) || 'شركتك';

const FIELD_LABELS = Object.freeze({ full_name: 'الاسم', phone: 'رقم الجوال', email: 'البريد الإلكتروني' });

const frame = (title, body) => `<!doctype html>
<html lang="ar" dir="rtl"><body style="margin:0;background:#f4f6fa;font-family:Tahoma,Arial,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px" dir="rtl">
    <h1 style="margin:0 0 12px;font-size:20px">${esc(title)}</h1>
${body}
  </div>
</body></html>`;

/** @returns {{ subject: string, html: string, text: string }} */
export function passwordResetEmail({ companyName, link }) {
    const company = companyLabel(companyName);
    const subject = 'إعادة تعيين كلمة مرور حسابك على مدعوم';
    const html = frame('إعادة تعيين كلمة المرور', `
    <p style="margin:0 0 16px;line-height:1.8">طلبت <strong>${esc(company)}</strong> إرسال رابط لإعادة تعيين كلمة مرور حسابك على منصة مدعوم.</p>
    <p style="margin:24px 0;text-align:center">
      <a href="${esc(link)}" style="display:inline-block;background:#0077cc;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:8px">تعيين كلمة مرور جديدة</a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#4b5563">الرابط لك وحدك ويعمل مرة واحدة لمدة قصيرة. لا ترسله لأحد؛ الشركة لا ترى الرابط ولا كلمة مرورك.</p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#4b5563">إن لم يعمل الزر، انسخ هذا الرابط إلى المتصفح:</p>
    <p style="margin:0 0 16px;font-size:12px;direction:ltr;text-align:left;word-break:break-all;color:#374151">${esc(link)}</p>
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="margin:0;font-size:12px;line-height:1.8;color:#6b7280">إن لم تطلب ذلك فتجاهل هذا البريد؛ كلمة مرورك الحالية تبقى كما هي.</p>`);
    const text = [
        'إعادة تعيين كلمة المرور',
        '',
        `طلبت ${company} إرسال رابط لإعادة تعيين كلمة مرور حسابك على منصة مدعوم.`,
        'افتح الرابط لتعيين كلمة مرور جديدة (لك وحدك، ويعمل مرة واحدة لمدة قصيرة):',
        link,
        '',
        'إن لم تطلب ذلك فتجاهل هذا البريد؛ كلمة مرورك الحالية تبقى كما هي.'
    ].join('\n');
    return { subject, html, text };
}

/** إشعار أمني بتغيير بيانات الدخول: يُرسل للبريد القديم (وللجديد إن تغيّر). بلا القيم الجديدة. */
export function accountChangedEmail({ companyName, fields }) {
    const company = companyLabel(companyName);
    const list = (Array.isArray(fields) ? fields : []).map(f => FIELD_LABELS[f]).filter(Boolean);
    const what = list.length ? list.join('، ') : 'بيانات الحساب';
    const subject = 'تغيّرت بيانات حسابك على مدعوم';
    const html = frame('تغيّرت بيانات حسابك', `
    <p style="margin:0 0 16px;line-height:1.8">حدّثت <strong>${esc(company)}</strong> بيانات حسابك على منصة مدعوم: ${esc(what)}.</p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#4b5563">إن تغيّر البريد الإلكتروني فادخل من الآن بالبريد الجديد؛ كلمة المرور لم تتغير.</p>
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="margin:0;font-size:12px;line-height:1.8;color:#6b7280">إن لم تتوقع هذا التغيير فتواصل مع ${esc(company)} أو مع دعم مدعوم فورًا.</p>`);
    const text = [
        'تغيّرت بيانات حسابك',
        '',
        `حدّثت ${company} بيانات حسابك على منصة مدعوم: ${what}.`,
        'إن تغيّر البريد الإلكتروني فادخل من الآن بالبريد الجديد؛ كلمة المرور لم تتغير.',
        '',
        `إن لم تتوقع هذا التغيير فتواصل مع ${company} أو مع دعم مدعوم فورًا.`
    ].join('\n');
    return { subject, html, text };
}
