# الفاتورة PDF كاملة في التذكرة (072) على Production — 2026-10-09

الطلب: «محتاج ارفاقها ك pdf ضروري وتكون فاتوره كامله زي اللي بتكون موجوده في نظام المحاسبه».
الموافقة: «طبّق 072». المشروع: `srnelrdpqkcntbgudyto`. الملف:
`migrations/072_invoice_pdf_attachment.sql` (md5 `31ee8f01817411620282f562978ad5d5`) كما هو.

## BEFORE (قراءة فقط)

- السجل: آخر migration `20261009133459 073_relay_core`. اتطبّق من فرع Relay (#105) اللي ساب الرقمين
  071/072 للـ PR ده؛ 072 مش محجوز. و 073 مابيلمسش دوال الفواتير ولا المرفقات.
- البصمات **مطابقة حرفيًا** للنسخة المحلية (`prod-shape` + 070 + 071):
  - `ticket_invoice_status f3de8292…` (نص 051)، `attach_accounting_invoice 15f14cc4…`.
  - `record_accounting_invoice 91bd4879…`، `get_public_invoice 63ef2626…`، `is_platform_staff 100dfa78…`.
  - مفيش `ticket_invoice_document` ولا `attach_accounting_invoice_pdf`.
- البيانات: 4 فواتير (كلها مرفقة كرابط)، 10 مرفقات (2 PDF)، 28 رد، 7 ملفات في `tickets`.
  فاتورة #1121 مرفقة كرابط `text/html`.

## APPLIED

| الطريقة | الوقت (UTC) | السجل |
|---|---|---|
| `apply_migration` (الملف حرفيًا، من غير `DROP`) | 13:38:55 | `20261009133855 / 072_invoice_pdf_attachment`، md5 = الملف |

## VERIFIED

- **البصمات بعد التطبيق** مطابقة للنسخة المحلية بعد 072:
  - `ticket_invoice_status 273b5e4e…`، `ticket_invoice_document 0e5ebfce…`،
    `attach_accounting_invoice_pdf 8657c176…`.
  - الباقي من غير تغيير، و `attach_accounting_invoice` (051) زي ما هي.
  - التنفيذ `authenticated` بس، ومفيش `anon`.
- **فحص Production**: `scripts/prod-smoke/invoice-pdf-attachment.sql`، معاملة بترجع كلها، **PASS/PASS/PASS**:
  - بيانات #1121 الكاملة للأدمن: `INV-FY2026/27-0001`، 9999 EGP، بند «اشتراك الخطة المتقدمة — سنوي»
    من 2026-10-09 لـ 2027-10-09، العميل، ورابط التحقق.
  - الحالة `attached` و `has_pdf=false`، فالزر هيعرض «إرفاق نسخة PDF».
  - الحرّاس: ملف مش موجود ⇒ P0002، ومجلد تذكرة تانية ⇒ 22023.
  - العميل ⇒ 42501 على البيانات وعلى الإرفاق.
- **بعد الفحص**: نفس الأعداد (4/4/10/2/28/7)، مفيش معاملات معلّقة، والسجلات من غير أخطاء.

## TESTS

- `tests/sql/invoice-pdf-attachment.test.sql`:
  - الخلل قبل 072، والفاتورة الكاملة.
  - حرّاس الملف، والإرفاق الأول، وترقية رابط 051.
  - التراجع وإعادة التطبيق.
- `tests/invoice-pdf.render.test.mjs` (Chromium):
  - PDF حقيقي صفحة A4 فيه كل عناصر فاتورة acc ورابطين قابلين للضغط.
  - الرفع في مجلد التذكرة ونداء الربط بنفس المسار.
  - رفض القاعدة يوقف الرفع.
  - مسار التخزين بيعدّي فحص القاعدة.

## ما تبقّى

1. دمج PR #104. الزر الجديد بيعتمد على 072، و 072 بقى على الإنتاج.
2. في #1121: «إرفاق نسخة PDF». المرفق الحالي (الرابط) بيتحوّل للـ PDF على نفس الرد.

## ROLLBACK

`migrations/_rollback/072_invoice_pdf_attachment.down.sql`:
- بيرجّع `ticket_invoice_status` لنص 051 ويشيل الدالتين.
- مرفقات الـ PDF اللي اتعملت بتفضل للعميل.
- مش مطلوب.
