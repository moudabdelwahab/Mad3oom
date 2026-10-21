/**
 * template.js — بريد دعوة عميل الشركة (عربي، RTL). وحدة خالصة، مُختبَرة في tests/company-invite-function.test.mjs.
 * كل نص من خارج القالب (اسم الشركة) يُهرَّب؛ الرابط يبنيه handler.js من أصل الموقع ورمز سداسي عشري.
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** تاريخ الانتهاء بالعربية (UTC، بلا وقت). */
export function expiryLabel(expiresAt) {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** @returns {{ subject: string, html: string, text: string }} */
export function inviteEmail({ companyName, link, expiresAt }) {
    // اسم الشركة نص تكتبه الشركة: بلا محارف تحكم (سطر جديد في الموضوع) ولا أطول من 120
    const company = String(companyName || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) || 'شركة';
    const expires = expiryLabel(expiresAt);
    const subject = `دعوة للانضمام إلى ${company} على مدعوم`.slice(0, 200);
    const html = `<!doctype html>
<html lang="ar" dir="rtl"><body style="margin:0;background:#f4f6fa;font-family:Tahoma,Arial,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px" dir="rtl">
    <h1 style="margin:0 0 12px;font-size:20px">دعوة للانضمام إلى ${esc(company)}</h1>
    <p style="margin:0 0 16px;line-height:1.8">دعتك <strong>${esc(company)}</strong> لتكون من عملائها على منصة مدعوم،
      لتتابع تذاكرك ورسائلك معها من بوابة العملاء.</p>
    <p style="margin:24px 0;text-align:center">
      <a href="${esc(link)}" style="display:inline-block;background:#0077cc;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:8px">قبول الدعوة</a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#4b5563">ادخل بنفس هذا البريد الإلكتروني لتظهر لك الدعوة.
      ${expires ? `تنتهي صلاحية الدعوة في ${esc(expires)}.` : ''}</p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#4b5563">إن لم يعمل الزر، انسخ هذا الرابط إلى المتصفح:</p>
    <p style="margin:0 0 16px;font-size:12px;direction:ltr;text-align:left;word-break:break-all;color:#374151">${esc(link)}</p>
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="margin:0;font-size:12px;line-height:1.8;color:#6b7280">إن لم تكن تتوقع هذه الدعوة فتجاهل هذا البريد؛ لن يُضاف حسابك إلى أي شركة دون قبولك.</p>
  </div>
</body></html>`;
    const text = [
        `دعوة للانضمام إلى ${company}`,
        '',
        `دعتك ${company} لتكون من عملائها على منصة مدعوم.`,
        'لقبول الدعوة افتح الرابط وادخل بنفس هذا البريد الإلكتروني:',
        link,
        expires ? `تنتهي صلاحية الدعوة في ${expires}.` : '',
        '',
        'إن لم تكن تتوقع هذه الدعوة فتجاهل هذا البريد؛ لن يُضاف حسابك إلى أي شركة دون قبولك.'
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
    return { subject, html, text };
}
