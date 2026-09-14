/**
 * report-export.js — تصدير تقارير التذاكر إلى CSV و XLSX و PDF.
 *
 * التصميم: كل شيء يبدأ من **مصفوفة صفوف واحدة** (array of arrays) تبنيها
 * دالة خالصة، ثم يتفرّع منها التنسيق الثلاثة. الفائدة أن نطاق البيانات
 * يُحدَّد مرة واحدة — فلا يمكن لتنسيق أن يصدّر أكثر مما يعرضه غيره.
 *
 * ── العربية في كل تنسيق ───────────────────────────────────────────────────
 *
 *   CSV   ترميز UTF-8 مسبوقًا بـBOM (﻿). بدونه يفتح Excel على ويندوز
 *         الملف بترميز النظام فتظهر العربية «ØªØ°ÙƒØ±Ø©». ونهايات الأسطر
 *         CRLF لأن Excel يتوقعها.
 *
 *   XLSX  العربية تعمل أصلًا (النص Unicode داخل الملف)، والمضاف هنا:
 *         اتجاه الورقة من اليمين (Workbook.Views[].RTL) وعرض أعمدة محسوب
 *         فلا تتكسّر الأعمدة، والأرقام والتواريخ كقيم قابلة للفرز لا كنص.
 *
 *   PDF   عبر محرك طباعة المتصفح، لا عبر مكتبة PDF.
 *         السبب تقني لا كسل: توليد PDF بالعربية من JS يتطلب (١) تضمين خط
 *         عربي كاملًا داخل الملف، و(٢) محرّك تشكيل (shaping) يصل الحروف
 *         ويعكس ترتيبها ثنائي الاتجاه. jsPDF وأمثالها لا تفعل الثانية،
 *         فتخرج الحروف منفصلة ومقلوبة — وهو بالضبط «نص مشوّه». محرك
 *         المتصفح يفعل الاثنين بشكل صحيح لأنه نفس المحرك الذي يرسم الصفحة.
 *         فنبني مستند طباعة RTL بخط Cairo ونترك المتصفح يُخرج PDF.
 *
 * ── حقن الصيغ (CSV/XLSX injection) ────────────────────────────────────────
 *   عنوان تذكرة يبدأ بـ = أو + أو - أو @ يصير **صيغة تنفيذية** عند فتح
 *   الملف في Excel. والعناوين هنا يكتبها عملاء الشركة. فنُسبَق هذه القيم
 *   بفاصلة عليا فتُقرأ نصًّا. هذه ليست مبالغة: الملف يُفتح على جهاز موظف.
 */

/** أنماط بداية القيم التي يفسّرها Excel كصيغة. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** يحيّد أي قيمة قد تُقرأ كصيغة، ويترك الباقي كما هو. يُرجع نصًّا دائمًا. */
export function neutralizeFormula(value) {
    const text = value == null ? '' : String(value);
    return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

/**
 * نسخة تحافظ على **نوع** الخلية.
 *
 * الأرقام والتواريخ تمرّ كما هي، وإلا حُفظت في XLSX كنص فلا تُفرَز ولا
 * تُجمَع — وهو ما يُفرغ «قابلة للفرز والاستخدام» من معناها. والتحييد
 * يلزم النصوص وحدها، فهي وحدها ما يفسّره Excel صيغةً.
 */
export function neutralizeCell(value) {
    if (typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
        return value;
    }
    if (value == null) return '';
    return neutralizeFormula(value);
}

/** تهريب قيمة واحدة لـCSV: اقتباس دائم، والاقتباس الداخلي مُضاعَف. */
export function csvCell(value) {
    return `"${neutralizeFormula(value).replace(/"/g, '""')}"`;
}

/**
 * مصفوفة صفوف → نص CSV جاهز لـExcel.
 * BOM + CRLF: الاثنان مطلوبان معًا، وغياب أيّهما يكسر الفتح على ويندوز.
 */
export function toCsv(rows) {
    const body = (rows || []).map(row => row.map(csvCell).join(',')).join('\r\n');
    return `﻿${body}\r\n`;
}

/** عرض عمود مناسب لأطول قيمة فيه — فلا تتكسّر الأعمدة عند الفتح. */
export function columnWidths(rows, { min = 8, max = 48 } = {}) {
    const widths = [];
    for (const row of rows || []) {
        row.forEach((cell, i) => {
            const len = String(cell == null ? '' : cell).length;
            widths[i] = Math.max(widths[i] || 0, len);
        });
    }
    return widths.map(w => ({ wch: Math.min(max, Math.max(min, w + 2)) }));
}

/**
 * يبني كائن الورقة لـSheetJS من مصفوفة الصفوف.
 * مفصول عن التنزيل عمدًا حتى يُختبَر في node بحزمة xlsx نفسها الموجودة في
 * package.json — فما يُختبَر هو ما يُنتَج فعلًا.
 */
export function buildWorkbook(XLSX, sheets) {
    const wb = XLSX.utils.book_new();

    // اتجاه المصنّف من اليمين — الورقة تُفتح كما يقرؤها المستخدم
    wb.Workbook = { Views: [{ RTL: true }] };

    for (const { name, rows } of sheets) {
        const safeRows = (rows || []).map(row => row.map(neutralizeCell));
        const ws = XLSX.utils.aoa_to_sheet(safeRows);
        ws['!cols'] = columnWidths(safeRows);
        // تجميد صف العناوين ليبقى ظاهرًا أثناء التمرير
        ws['!freeze'] = { xSplit: 0, ySplit: 1 };
        // أسماء أوراق Excel محدودة بـ31 محرفًا ولا تقبل : \ / ? * [ ]
        XLSX.utils.book_append_sheet(wb, ws, String(name).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31));
    }
    return wb;
}

/** تهريب HTML لمستند الطباعة. */
function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * مستند الطباعة — RTL كامل بخط عربي، وجداول لا تتكسّر عبر الصفحات.
 *
 * دالة خالصة تُرجع HTML، فيمكن التأكد من صحتها في node بلا متصفح.
 */
export function buildPrintDocument({ title, subtitle, meta = [], sections = [] }) {
    const metaRow = meta.length
        ? `<dl class="meta">${meta.map(([k, v]) =>
            `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
        : '';

    const body = sections.map(section => {
        const [head, ...rest] = section.rows || [];
        if (!head) return '';
        return `
        <section class="block">
            <h2>${esc(section.name)}</h2>
            <table>
                <thead><tr>${head.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
                <tbody>${rest.map(r =>
                    `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
            </table>
        </section>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  /* حجم صفحة وهوامش صريحة: بدونها يختلف الناتج بين المتصفحات */
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: Cairo, 'Segoe UI', Tahoma, sans-serif;
    direction: rtl; text-align: right;
    color: #111; background: #fff; margin: 0; font-size: 11px; line-height: 1.7;
  }
  h1 { font-size: 18px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
  .sub { color: #555; margin: 0 0 10px; font-size: 11px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 0 0 14px;
          padding: 8px 10px; background: #f6f7f9; border-radius: 4px; }
  .meta div { display: flex; gap: 5px; }
  .meta dt { font-weight: 700; margin: 0; }
  .meta dd { margin: 0; color: #333; }
  /* break-inside يمنع انقسام الجدول القصير بين صفحتين */
  .block { margin-bottom: 16px; break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; table-layout: auto; }
  /* تكرار رأس الجدول في كل صفحة عند الطباعة */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { border: 1px solid #d8dbe0; padding: 4px 6px; text-align: right;
           vertical-align: top; word-break: break-word; }
  th { background: #eef1f5; font-weight: 700; }
  tbody tr:nth-child(even) td { background: #fafbfc; }
  .foot { margin-top: 14px; color: #777; font-size: 10px; border-top: 1px solid #ddd; padding-top: 6px; }
  @media print { .noprint { display: none !important; } }
</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
  ${metaRow}
  ${body}
  <p class="foot">هذا التقرير محصور ببيانات شركتك وحدها. صدر من لوحة الشركة — منصة مدعوم.</p>
</body>
</html>`;
}

/* ── التنزيل (تأثيرات جانبية، معزولة عن كل ما سبق) ───────────────────────── */

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // الإلغاء بعد مهلة قصيرة: بعض المتصفحات تقرأ الـURL بعد النقرة
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(rows, filename) {
    downloadBlob(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8;' }), filename);
}

const XLSX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

/**
 * تحميل SheetJS عند الطلب فقط — نفس الإصدار والمصدر المستخدمين في لوحة
 * الإدارة (admin/dashboard.html)، فلا نُدخل مكتبة جديدة على المشروع.
 * المشروع بلا خطوة بناء، فالحزمة في package.json تخدم الاختبارات في node
 * بينما المتصفح يأخذ نفس الإصدار من الشبكة.
 */
let xlsxPromise = null;
export function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxPromise) return xlsxPromise;

    xlsxPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = XLSX_CDN;
        script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX لم تُحمَّل'));
        script.onerror = () => { xlsxPromise = null; reject(new Error('تعذّر تحميل مكتبة XLSX')); };
        document.head.appendChild(script);
    });
    return xlsxPromise;
}

export async function downloadXlsx(sheets, filename) {
    const XLSX = await loadXlsx();
    XLSX.writeFile(buildWorkbook(XLSX, sheets), filename);
}

/**
 * فتح مستند الطباعة في نافذة مستقلة.
 * نافذة جديدة لا iframe: الطباعة من iframe تلتقط أنماط الصفحة الأم في بعض
 * المتصفحات فيخرج التقرير بألوان اللوحة الداكنة.
 */
export function printReport(documentHtml) {
    const win = window.open('', '_blank');
    if (!win) return false;   // مانع النوافذ — المنادي يعرض رسالة

    win.document.open();
    win.document.write(documentHtml);
    win.document.close();

    // الانتظار حتى يُحمَّل الخط، وإلا طُبع التقرير بخط بديل
    const start = () => setTimeout(() => { win.focus(); win.print(); }, 350);
    if (win.document.readyState === 'complete') start();
    else win.addEventListener('load', start);
    return true;
}
