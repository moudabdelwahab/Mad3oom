/**
 * الفاتورة ملف PDF كامل — بتصميم النظام المحاسبي (acc)
 *
 * طلب صاحب المنصة: «محتاج ارفاقها ك pdf ضروري وتكون فاتوره كامله زي اللي
 * بتكون موجوده في نظام المحاسبه».
 *
 * الفاتورة بتترسم هنا بنفس عناصر عرضها في acc (js/invoices.js): ترويسة الشعار،
 * بيانات الفاتورة، جدول البنود بإجمالياته، وقسم التحقق برمز QR — وبألوانه
 * (css/main.css). وبعدين بتتحوّل PDF في المتصفح نفسه:
 *   • المتصفح هو اللي بيشكّل الحروف العربية ويرتّبها. مكتبات PDF على الخادم
 *     ماتعملش ده من غير خطوط ومعالجة إضافية، والنتيجة كانت هتبقى حروف مفكّكة.
 *   • html2canvas بيصوّر الفاتورة، و jsPDF بيحطّها صفحة A4 ويضيف رابط التحقق
 *     قابل للضغط فوق الـ QR.
 * المكتبات الثلاث محلية في assets/vendor (من غير CDN)، وبتتحمّل عند أول إرفاق بس.
 *
 * البيانات من ticket_invoice_document (072، للطاقم بس)، والربط بالتذكرة من
 * attach_accounting_invoice_pdf اللي بتتأكد من الملف في التخزين قبل ما تربطه.
 */
import { supabase } from '/api-config.js';

const VENDOR = {
    html2canvas: '/assets/vendor/html2canvas-1.4.1.min.js',
    jspdf: '/assets/vendor/jspdf-2.5.1.umd.min.js',
    qrcode: '/assets/vendor/qrcode-generator-1.4.4.js'
};

/** عرض صفحة A4 بالبكسل (96dpi) — الفاتورة بتترسم بالمقاس ده بالظبط. */
const PAGE_WIDTH_PX = 794;

/** نفس تسميات acc (js/utils.js → STATUS_BADGES). */
export const INVOICE_STATUS_LABELS = {
    draft: 'مسودة',
    sent: 'مُرسلة',
    paid: 'مدفوعة',
    partially_paid: 'مدفوعة جزئياً',
    overdue: 'متأخرة',
    cancelled: 'ملغاة'
};

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/** acc formatAmount: أرقام لاتينية بفاصل آلاف وخانتين عشريتين. */
function amount(value, decimals = 2) {
    const n = Number(value);
    if (value === null || value === undefined || !Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** acc formatDate: YYYY-MM-DD. */
function day(value) {
    if (!value) return '—';
    return String(value).slice(0, 10);
}

function row(label, value, { num = false } = {}) {
    if (value === null || value === undefined || value === '') return '';
    return `<dt>${esc(label)}</dt><dd${num ? ' class="num"' : ''}>${esc(value)}</dd>`;
}

/** اسم الملف كما يظهر للعميل في التذكرة (وتكتبه القاعدة بنفس الشكل). */
export function invoiceFileName(invoiceNumber) {
    return `فاتورة ${invoiceNumber}.pdf`;
}

/**
 * مسار الملف داخل مجلد التذكرة في مستودع tickets. القاعدة بتقبل بس
 * `<ticket>/invoice-[A-Za-z0-9._-]+.pdf`، فرقم الفاتورة بيتنضّف (INV-FY2026/27-0001
 * ← INV-FY2026_27-0001)، والطابع الزمني بيمنع التصادم لو اتعاد التوليد.
 */
export function invoiceStoragePath(ticketId, invoiceNumber, now = Date.now()) {
    const safe = String(invoiceNumber || 'invoice').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
    return `${ticketId}/invoice-${safe}-${now}.pdf`;
}

/**
 * HTML الفاتورة. كل الأنماط جوّه العنصر نفسه (مش من صفحة اللوحة) عشان الملف
 * يطلع بنفس الشكل مهما كانت الصفحة اللي اتولّد منها.
 */
export function buildInvoiceHtml(doc, { qrDataUrl = '', logoUrl = '/logo.png' } = {}) {
    const currency = doc.currency || '';
    const customer = doc.customer || {};
    const company = customer.company || null;
    const statusLabel = INVOICE_STATUS_LABELS[doc.status] || doc.status || '—';

    const items = (doc.items || []).map((it, i) => {
        const period = it.period_start && it.period_end
            ? `<div class="mi-inv__period">الفترة: <span class="num">${esc(day(it.period_start))}</span> إلى <span class="num">${esc(day(it.period_end))}</span></div>`
            : '';
        return `<tr>
            <td class="num">${i + 1}</td>
            <td><div class="mi-inv__desc">${esc(it.description || '—')}</div>${period}</td>
            <td class="num">${esc(amount(it.quantity, 0))}</td>
            <td class="num">${esc(amount(it.unit_price))}</td>
            <td class="num">${esc(amount(it.line_total))}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" class="mi-inv__muted">— لا توجد بنود —</td></tr>';

    return `
<div class="mi-inv" dir="rtl" lang="ar">
  <style>
    .mi-inv { box-sizing: border-box; width: ${PAGE_WIDTH_PX}px; min-height: 1123px; padding: 44px 48px 36px;
      background: #fff; color: #1D2939; font-family: "Segoe UI", Tahoma, "IBM Plex Sans Arabic", "Noto Kufi Arabic", Arial, sans-serif;
      font-size: 13px; line-height: 1.7; }
    .mi-inv * { box-sizing: border-box; }
    /* letter-spacing صغيرة عمدًا: html2canvas بيقسّم القيم عند الشرطة ويرسم كل جزء
       لوحده فيطلع «INV- FY2026/27- 0001» والتواريخ مقلوبة. معاها بيرسم حرف حرف
       في مكانه المحسوب من المتصفح بالظبط. على الأرقام واللاتيني بس (العربي
       بيتشكّل كلمة كاملة)، ومن غير tabular-nums: الـ canvas مابيطبّقهاش فكانت
       بتعمل فراغات بين الأرقام. */
    .mi-inv .num { direction: ltr; unicode-bidi: isolate; letter-spacing: .2px; }
    .mi-inv .end { text-align: left; }
    .mi-inv__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px;
      padding-bottom: 18px; margin-bottom: 22px; border-bottom: 2px solid #D9E6EF; }
    .mi-inv__brand { display: flex; align-items: center; gap: 12px; }
    .mi-inv__logo { width: 56px; height: 56px; object-fit: contain; }
    .mi-inv__name { font-weight: 700; font-size: 19px; color: #2F658C; }
    .mi-inv__domain { font-size: 12px; color: #667085; direction: ltr; text-align: right; }
    .mi-inv__title { text-align: left; }
    .mi-inv__title-text { font-size: 26px; font-weight: 700; color: #2F658C; line-height: 1.2; }
    .mi-inv__number { font-size: 14px; font-weight: 600; margin-top: 4px; }
    .mi-inv__badge { display: inline-block; margin-top: 6px; padding: 2px 12px; border-radius: 999px;
      background: #EAF5FC; color: #2F658C; font-size: 12px; font-weight: 600; }
    .mi-inv__parties { display: flex; gap: 16px; margin-bottom: 22px; }
    .mi-inv__box { flex: 1; border: 1px solid #D9E6EF; border-radius: 10px; padding: 14px 16px; background: #F8FBFD; }
    .mi-inv__box h3 { margin: 0 0 8px; font-size: 13px; color: #2F658C; }
    .mi-inv__box dl { display: grid; grid-template-columns: 110px 1fr; row-gap: 4px; column-gap: 12px; margin: 0; }
    .mi-inv__box dt { color: #667085; }
    .mi-inv__box dd { margin: 0; font-weight: 500; word-break: break-word; }
    .mi-inv__box dd.num { text-align: right; }
    .mi-inv__table { width: 100%; border-collapse: collapse; margin-bottom: 22px; }
    .mi-inv__table th { text-align: right; font-size: 12px; font-weight: 600; color: #667085; background: #F8FBFD;
      padding: 8px 12px; border-bottom: 1px solid #D9E6EF; }
    .mi-inv__table td { padding: 10px 12px; border-bottom: 1px solid #D9E6EF; vertical-align: top; }
    .mi-inv__table th.end, .mi-inv__table td.num { text-align: left; white-space: nowrap; }
    .mi-inv__table th:first-child, .mi-inv__table td:first-child { width: 36px; text-align: center; }
    .mi-inv__desc { font-weight: 600; }
    .mi-inv__period { font-size: 12px; color: #667085; }
    .mi-inv__table tfoot td { border-bottom: none; padding: 6px 12px; }
    .mi-inv__table tfoot tr:first-child td { padding-top: 12px; }
    .mi-inv__table tfoot td:first-child { width: auto; text-align: left; color: #667085; }
    .mi-inv__table tfoot .grand td { font-weight: 700; font-size: 15px; color: #2F658C; border-top: 2px solid #D9E6EF; padding-top: 10px; }
    .mi-inv__muted { color: #98A2B3; text-align: center; }
    .mi-inv__verify { display: flex; align-items: center; gap: 18px; padding: 16px; border: 1px solid #D9E6EF;
      border-radius: 10px; background: #F8FBFD; }
    .mi-inv__qr { width: 120px; height: 120px; flex-shrink: 0; image-rendering: pixelated; background: #fff; padding: 6px;
      border: 1px solid #D9E6EF; border-radius: 6px; }
    .mi-inv__verify-title { font-weight: 700; }
    .mi-inv__verify p { margin: 2px 0 6px; color: #667085; font-size: 12px; }
    .mi-inv__url { font-size: 11px; color: #2F658C; direction: ltr; text-align: left; word-break: break-all; }
    .mi-inv__foot { margin-top: 26px; padding-top: 12px; border-top: 1px solid #D9E6EF; text-align: center;
      font-size: 11px; color: #98A2B3; }
  </style>

  <header class="mi-inv__head">
    <div class="mi-inv__brand">
      <img class="mi-inv__logo" src="${esc(logoUrl)}" alt="شعار منصة مدعوم">
      <div>
        <div class="mi-inv__name">منصة مدعوم</div>
        <div class="mi-inv__domain">mad3oom.com</div>
      </div>
    </div>
    <div class="mi-inv__title">
      <div class="mi-inv__title-text">فاتورة</div>
      <div class="mi-inv__number num">${esc(doc.invoice_number || '—')}</div>
      <span class="mi-inv__badge">${esc(statusLabel)}</span>
    </div>
  </header>

  <section class="mi-inv__parties">
    <div class="mi-inv__box">
      <h3>بيانات الفاتورة</h3>
      <dl>
        ${row('رقم الفاتورة', doc.invoice_number, { num: true })}
        ${row('تاريخ الإصدار', day(doc.issue_date), { num: true })}
        ${row('تاريخ الاستحقاق', day(doc.due_date), { num: true })}
        ${row('الحالة', statusLabel)}
        ${row('رقم التذكرة', doc.ticket_number ? '#' + doc.ticket_number : '', { num: true })}
        ${row('العملة', currency)}
      </dl>
    </div>
    <div class="mi-inv__box">
      <h3>فاتورة إلى</h3>
      <dl>
        ${row('العميل', customer.name || '—')}
        ${company ? row('الشركة', company.name) : ''}
        ${company ? row('السجل التجاري', company.commercial_register, { num: true }) : ''}
        ${company ? row('الرقم الضريبي', company.tax_id, { num: true }) : ''}
        ${company ? row('العنوان', company.address) : ''}
        ${row('البريد الإلكتروني', customer.email, { num: true })}
        ${row('الهاتف', customer.phone, { num: true })}
      </dl>
    </div>
  </section>

  <table class="mi-inv__table">
    <thead>
      <tr><th>#</th><th>الوصف</th><th class="end">الكمية</th><th class="end">سعر الوحدة</th><th class="end">الإجمالي</th></tr>
    </thead>
    <tbody>${items}</tbody>
    <tfoot>
      <tr><td colspan="4">الإجمالي الفرعي</td><td class="num">${esc(amount(doc.subtotal))}</td></tr>
      <tr><td colspan="4">الضريبة</td><td class="num">${esc(amount(doc.tax_amount))}</td></tr>
      <tr class="grand"><td colspan="4">الإجمالي المستحق</td><td class="num">${esc(amount(doc.total))} ${esc(currency)}</td></tr>
    </tfoot>
  </table>

  <section class="mi-inv__verify">
    ${qrDataUrl ? `<img class="mi-inv__qr" data-pdf-link src="${esc(qrDataUrl)}" alt="رمز التحقق من الفاتورة">` : ''}
    <div>
      <div class="mi-inv__verify-title">فاتورة صادرة عن منصة مدعوم</div>
      <p>امسح الرمز للتحقق من الفاتورة على <span class="num">mad3oom.com</span>.</p>
      <div class="mi-inv__url" data-pdf-link>${esc(doc.public_url || '')}</div>
    </div>
  </section>

  <footer class="mi-inv__foot">صدرت هذه الفاتورة من النظام المحاسبي لمنصة مدعوم — mad3oom.com</footer>
</div>`;
}

function loadScript(src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => (ready() ? resolve() : reject(new Error('تعذّر تحميل مكتبة الفاتورة')));
        s.onerror = () => reject(new Error('تعذّر تحميل مكتبة الفاتورة'));
        document.head.appendChild(s);
    });
}

async function loadLibraries() {
    await Promise.all([
        loadScript(VENDOR.html2canvas, () => typeof window.html2canvas === 'function'),
        loadScript(VENDOR.jspdf, () => typeof window.jspdf?.jsPDF === 'function'),
        loadScript(VENDOR.qrcode, () => typeof window.qrcode === 'function')
    ]);
}

function qrDataUrlFor(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(6, 0);
}

/**
 * الفاتورة PDF (Blob). بترسمها خارج الشاشة، تصوّرها بدقة مضاعفة، وتحطّها في
 * صفحات A4 — وفوق الـ QR والرابط رابط قابل للضغط لصفحة التحقق.
 */
export async function renderInvoicePdf(doc) {
    await loadLibraries();

    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = `position:fixed; top:0; left:-${PAGE_WIDTH_PX * 3}px; width:${PAGE_WIDTH_PX}px; pointer-events:none;`;
    host.innerHTML = buildInvoiceHtml(doc, { qrDataUrl: doc.public_url ? qrDataUrlFor(doc.public_url) : '' });
    document.body.appendChild(host);

    try {
        const page = host.querySelector('.mi-inv');
        await Promise.all([...page.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
        if (document.fonts?.ready) await document.fonts.ready;

        const canvas = await window.html2canvas(page, {
            scale: 2,
            backgroundColor: '#ffffff',
            useCORS: true,
            logging: false,
            windowWidth: PAGE_WIDTH_PX
        });

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
        const pageW = pdf.internal.pageSize.getWidth();
        const pageH = pdf.internal.pageSize.getHeight();
        const imgH = canvas.height * pageW / canvas.width;
        const image = canvas.toDataURL('image/jpeg', 0.92);

        pdf.addImage(image, 'JPEG', 0, 0, pageW, imgH, undefined, 'FAST');
        for (let offset = pageH; offset < imgH - 0.5; offset += pageH) {
            pdf.addPage();
            pdf.addImage(image, 'JPEG', 0, -offset, pageW, imgH, undefined, 'FAST');
        }

        if (doc.public_url) {
            const mmPerPx = pageW / page.offsetWidth;
            const origin = page.getBoundingClientRect();
            for (const el of page.querySelectorAll('[data-pdf-link]')) {
                const r = el.getBoundingClientRect();
                const top = (r.top - origin.top) * mmPerPx;
                const pageIndex = Math.floor(top / pageH);
                pdf.setPage(pageIndex + 1);
                pdf.link((r.left - origin.left) * mmPerPx, top - pageIndex * pageH,
                    r.width * mmPerPx, r.height * mmPerPx, { url: doc.public_url });
            }
            pdf.setPage(1);
        }

        pdf.setProperties({ title: String(doc.invoice_number || 'Invoice'), subject: 'Invoice', author: 'Mad3oom', creator: 'mad3oom.com' });
        return pdf.output('blob');
    } finally {
        host.remove();
    }
}

/**
 * زر «إرفاق فاتورة PDF»: بيانات الفاتورة ← PDF ← رفع في مجلد التذكرة ← ربط بالتذكرة.
 * القاعدة بترفض أي ملف مش PDF، أو برّه مجلد التذكرة، أو رفعه حساب تاني.
 *
 * @returns {Promise<{status: 'attached'|'upgraded'|'already_attached', reply_id: string, attachment_id: string}>}
 */
export async function attachInvoicePdf(ticketId) {
    const { data: doc, error: docError } = await supabase.rpc('ticket_invoice_document', { p_ticket_id: ticketId });
    if (docError) throw new Error(docError.message);
    if (!doc) throw new Error('تعذّر قراءة بيانات الفاتورة');

    const blob = await renderInvoicePdf(doc);

    const path = invoiceStoragePath(ticketId, doc.invoice_number);
    const bucket = supabase.storage.from('tickets');
    const { error: uploadError } = await bucket.upload(path, blob, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: false
    });
    if (uploadError) throw new Error('تعذّر رفع ملف الفاتورة: ' + uploadError.message);

    // file_url بالشكل العام (العمود NOT NULL)؛ العرض بيمر دايمًا بتوقيع file_path
    const { data: { publicUrl } } = bucket.getPublicUrl(path);

    const { data: result, error: attachError } = await supabase.rpc('attach_accounting_invoice_pdf', {
        p_ticket_id: ticketId,
        p_file_path: path,
        p_file_url: publicUrl
    });
    if (attachError) throw new Error(attachError.message);
    return result;
}
