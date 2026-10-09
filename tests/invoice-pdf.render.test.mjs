/**
 * الفاتورة ملف PDF كامل في التذكرة (072) — assets/js/admin/invoice-pdf.js في متصفح فعلي.
 *
 * الطلب: «محتاج ارفاقها ك pdf ضروري وتكون فاتوره كامله زي اللي بتكون موجوده في
 * نظام المحاسبه». العقد اللي بنثبّته:
 *   • الملف PDF فعلي (صفحة A4)، وفيه كل عناصر فاتورة acc: الترويسة، بيانات الفاتورة،
 *     العميل وشركته، البند بفترته، الإجماليات، والتحقق (QR + رابط قابل للضغط).
 *   • الإرفاق: بيانات من القاعدة ← PDF ← رفع في مجلد التذكرة نفسها (مستودع
 *     tickets) ← attach_accounting_invoice_pdf بنفس المسار. ورفض القاعدة يوقف كل ده.
 *   • اسم الملف في التخزين يعدّي فحص القاعدة لأي رقم فاتورة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};
const BLANK = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body></body></html>';

function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/__blank.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(BLANK); return;
        }
        const filePath = path.join(ROOT, urlPath);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function resolveChromium() {
    try {
        const p = chromium.executablePath();
        if (p && fs.existsSync(p)) return p;
    } catch { /* لا تنزيل افتراضي */ }
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root && fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium')).sort().reverse()) {
            for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
                const candidate = path.join(root, dir, rel);
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

const TICKET = '62b06a5f-9edd-4ae5-b85d-4a1d997de87a';
const TOKEN = 'a'.repeat(48);
const DOC = {
    invoice_number: 'INV-FY2026/27-0001',
    issue_date: '2026-10-09',
    due_date: '2027-10-09',
    status: 'sent',
    subtotal: 9999,
    tax_amount: 0,
    total: 9999,
    currency: 'EGP',
    ticket_number: 1121,
    public_url: `https://mad3oom.com/invoice.html?t=${TOKEN}`,
    customer: {
        name: 'حسين شاكر',
        email: 'customer@example.com',
        phone: '+201000000051',
        company: { name: 'شركة التجربة', commercial_register: 'CR-7788', tax_id: 'TAX-123', address: 'شارع النصر، القاهرة' }
    },
    items: [{
        description: 'اشتراك الخطة المتقدمة — سنوي',
        period_start: '2026-10-09', period_end: '2027-10-09',
        quantity: 1, unit_price: 9999, line_total: 9999
    }]
};

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات فاتورة الـ PDF لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/**
 * صفحة فاضية من نفس الأصل، والقاعدة بديل اختباري. التخزين بيسجّل كل رفع
 * (المستودع، المسار، النوع، وأول بايتات الملف) عشان نتأكد إنه PDF حقيقي.
 */
async function open(fx) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8')
        .replace('from: () => ({\n            upload: async () => ({ error: null }),',
            `from: (bucket) => ({
            upload: async (p, file, opts) => {
                const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, 5).arrayBuffer()));
                (window.__UPLOADS__ = window.__UPLOADS__ || []).push({ bucket, path: p, type: opts?.contentType, upsert: opts?.upsert, size: file.size, head });
                return { error: null };
            },`);
    assert.ok(doubleSupabase.includes('window.__UPLOADS__'), 'بديل التخزين اتعدّل');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/__blank.html`);
    return { page, context, errors };
}

test('الفاتورة PDF كامل بعناصر فاتورة النظام المحاسبي', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open({});
    const out = await page.evaluate(async (doc) => {
        const m = await import('/assets/js/admin/invoice-pdf.js');
        const host = document.createElement('div');
        host.innerHTML = m.buildInvoiceHtml(doc, { qrDataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' });
        const blob = await m.renderInvoicePdf(doc);
        // الـ PDF كنص بايتات (latin1): الكائنات والروابط فيه نص صريح
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let raw = '';
        for (const b of bytes) raw += String.fromCharCode(b);
        return {
            text: host.textContent.replace(/\s+/g, ' '),
            type: blob.type,
            pdf: {
                size: bytes.length,
                head: raw.slice(0, 5),
                pages: (raw.match(/\/Type \/Page\b/g) || []).length,
                links: raw.match(/\/URI \([^)]*\)/g) || [],
                images: (raw.match(/\/Subtype \/Image/g) || []).length,
                title: (raw.match(/\/Title \(([^)]*)\)/) || [])[1] || null
            },
            leftovers: document.querySelectorAll('.mi-inv').length
        };
    }, DOC);

    // عناصر فاتورة acc كلها في التصميم
    for (const piece of [
        'منصة مدعوم', 'mad3oom.com', 'فاتورة', 'INV-FY2026/27-0001', 'مُرسلة',
        'بيانات الفاتورة', 'تاريخ الإصدار', '2026-10-09', 'تاريخ الاستحقاق', '2027-10-09', '#1121',
        'فاتورة إلى', 'حسين شاكر', 'شركة التجربة', 'CR-7788', 'TAX-123', 'شارع النصر، القاهرة',
        'customer@example.com', '+201000000051',
        'الوصف', 'الكمية', 'سعر الوحدة', 'الإجمالي', 'اشتراك الخطة المتقدمة — سنوي', 'الفترة',
        'الإجمالي الفرعي', 'الضريبة', 'الإجمالي المستحق', '9,999.00 EGP', '0.00',
        'فاتورة صادرة عن منصة مدعوم', 'امسح الرمز للتحقق', DOC.public_url
    ]) {
        assert.ok(out.text.includes(piece), `الفاتورة فيها «${piece}»`);
    }

    // الملف نفسه: PDF صفحة A4 واحدة، صورة الفاتورة، ورابط التحقق قابل للضغط (QR + الرابط)
    assert.equal(out.type, 'application/pdf');
    assert.equal(out.pdf.head, '%PDF-');
    assert.equal(out.pdf.pages, 1);
    assert.ok(out.pdf.images >= 1, 'صورة الفاتورة جوّه الملف');
    assert.ok(out.pdf.size > 30_000, `حجم معقول لفاتورة مرسومة (${out.pdf.size})`);
    assert.deepEqual(out.pdf.links, [`/URI (${DOC.public_url})`, `/URI (${DOC.public_url})`]);
    assert.equal(out.pdf.title, DOC.invoice_number);
    assert.equal(out.leftovers, 0, 'عنصر الرسم المؤقت اتشال من الصفحة');
    assert.deepEqual(errors, []);
    await context.close();
});

test('فرد من غير شركة ولا QR: الفاتورة مكتملة من غير خانات فاضية', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open({});
    const doc = { ...DOC, public_url: null, customer: { name: 'عميل فرد', email: 'one@example.com', phone: null, company: null } };
    const text = await page.evaluate(async (d) => {
        const m = await import('/assets/js/admin/invoice-pdf.js');
        const host = document.createElement('div');
        host.innerHTML = m.buildInvoiceHtml(d);
        return { text: host.textContent, qr: host.querySelectorAll('.mi-inv__qr').length };
    }, doc);
    assert.match(text.text, /عميل فرد/);
    for (const absent of ['الشركة', 'السجل التجاري', 'الرقم الضريبي', 'الهاتف', 'null', 'undefined']) {
        assert.ok(!text.text.includes(absent), `مفيش «${absent}»`);
    }
    assert.equal(text.qr, 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('الإرفاق: بيانات الفاتورة ← PDF ← مجلد التذكرة ← attach_accounting_invoice_pdf بنفس المسار', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open({
        rpc: {
            ticket_invoice_document: DOC,
            attach_accounting_invoice_pdf: { status: 'upgraded', reply_id: 'r-1', attachment_id: 'a-1' }
        }
    });
    const result = await page.evaluate(async (ticket) => {
        const m = await import('/assets/js/admin/invoice-pdf.js');
        return m.attachInvoicePdf(ticket);
    }, TICKET);
    const uploads = await page.evaluate(() => window.__UPLOADS__ || []);
    const calls = await page.evaluate(() => window.__RPC_ARGS__ || []);

    assert.deepEqual(result, { status: 'upgraded', reply_id: 'r-1', attachment_id: 'a-1' });
    assert.equal(uploads.length, 1);
    const [up] = uploads;
    assert.equal(up.bucket, 'tickets');
    assert.equal(up.type, 'application/pdf');
    assert.equal(up.upsert, false);
    assert.equal(up.head, '%PDF-');
    assert.ok(up.size > 30_000);
    // نفس الشكل اللي القاعدة بتقبله: داخل مجلد التذكرة، invoice-…pdf، من غير «..»
    assert.match(up.path, new RegExp(`^${TICKET}/invoice-[A-Za-z0-9._-]+\\.pdf$`));
    assert.ok(!up.path.includes('..'));
    assert.match(up.path, /\/invoice-INV-FY2026_27-0001-\d+\.pdf$/);

    assert.deepEqual(calls.map(([n]) => n), ['ticket_invoice_document', 'attach_accounting_invoice_pdf']);
    assert.deepEqual(calls[0][1], { p_ticket_id: TICKET });
    assert.deepEqual(calls[1][1], { p_ticket_id: TICKET, p_file_path: up.path, p_file_url: `/uploads/${up.path}` });
    assert.deepEqual(errors, []);
    await context.close();
});

test('رفض القاعدة لبيانات الفاتورة ⇒ لا ملف يترفع ولا إرفاق، والرسالة توصل', { skip: !chromiumPath }, async () => {
    const { page, context } = await open({
        rpcErrors: { ticket_invoice_document: 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد' }
    });
    const message = await page.evaluate(async (ticket) => {
        const m = await import('/assets/js/admin/invoice-pdf.js');
        try { await m.attachInvoicePdf(ticket); return 'no error'; } catch (e) { return e.message; }
    }, TICKET);
    assert.equal(message, 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد');
    assert.deepEqual(await page.evaluate(() => window.__UPLOADS__ || []), []);
    assert.deepEqual((await page.evaluate(() => window.__RPC_ARGS__ || [])).map(([n]) => n), ['ticket_invoice_document']);
    await context.close();
});

test('مسار التخزين يعدّي فحص القاعدة لأي رقم فاتورة', { skip: !chromiumPath }, async () => {
    const { page, context } = await open({});
    const paths = await page.evaluate(async (ticket) => {
        const m = await import('/assets/js/admin/invoice-pdf.js');
        return ['INV-FY2026/27-0001', 'INV-2026-0008', 'فاتورة ١٢', '../../etc', 'a..b', '', null]
            .map(n => m.invoiceStoragePath(ticket, n, 1791532901380));
    }, TICKET);
    for (const p of paths) {
        assert.match(p, new RegExp(`^${TICKET}/invoice-[A-Za-z0-9._-]+\\.pdf$`), p);
        assert.ok(!p.includes('..'), p);
    }
    assert.equal(paths[0], `${TICKET}/invoice-INV-FY2026_27-0001-1791532901380.pdf`);
    await context.close();
});
