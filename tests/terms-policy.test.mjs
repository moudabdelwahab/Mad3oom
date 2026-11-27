/**
 * شروط الاستخدام: قسم سياسة الإلغاء والاسترداد.
 *
 * ما تحرسه هذه الاختبارات:
 *   • الشروط 11 قسمًا، وفهرسها يطابق الأقسام 1:1 وبالترتيب.
 *   • قسم الإلغاء والاسترداد (§6) موجود بنصه المعتمد: المهل والمبالغ وقاعدة الـ10%.
 *   • روابط صفحة السياسة وقسم الاشتراكات داخل حساب الشركة موجودة.
 *   • ختم «آخر تحديث: نوفمبر 2026» في موضعيه.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'terms.html'), 'utf8');

const SECTION_IDS = [
    'service-description', 'whatsapp-meta', 'user-responsibility', 'prohibited-use',
    'subscriptions-payment', 'cancellation-refund', 'third-party-services', 'suspension',
    'liability', 'modifications', 'contact'
];

function policySection() {
    const start = html.indexOf('id="cancellation-refund"');
    const end = html.indexOf('id="third-party-services"', start);
    assert.ok(start !== -1 && end !== -1, 'قسم الإلغاء والاسترداد غير موجود');
    return html.slice(start, end);
}

test('الشروط 11 قسمًا بعناوين مرقّمة 1–11 بالترتيب', () => {
    const sections = [...html.matchAll(/<section class="legal-section" id="([^"]+)">\s*<h2>([^<]+)<\/h2>/g)];
    assert.equal(sections.length, 11);
    assert.deepEqual(sections.map(m => m[1]), SECTION_IDS);
    sections.forEach((m, i) => {
        assert.ok(m[2].startsWith(`${i + 1}.`), `العنوان ${i + 1} بلا ترقيم صحيح: ${m[2]}`);
    });
    assert.equal(sections[5][2], '6. سياسة الإلغاء والاسترداد');
});

test('فهرس المحتويات يطابق الأقسام 1:1 وبالترتيب', () => {
    const toc = [...html.matchAll(/<li><a href="#([^"]+)">/g)].map(m => m[1]);
    assert.deepEqual(toc, SECTION_IDS);
    assert.equal(toc[5], 'cancellation-refund');
});

test('قسم الإلغاء والاسترداد يحمل نص السياسة المعتمد', () => {
    const section = policySection();
    for (const phrase of [
        'مبلغ الاسترداد = المبلغ المدفوع × الأيام المتبقية ÷ إجمالي أيام المدة',
        '666.33', 'أول 7 أيام', '10%', '30 تذكرة', 'تذكرتان',
        '48 ساعة', '14 يوم عمل', '3 أيام عمل', 'الأحد–الخميس',
        'لا يوجد في مدعوم أي استرداد آلي', 'Pi Network مخفي مؤقتًا',
        'SIE', 'مرة واحدة لكل مدة اشتراك', 'نقاط ما زالت مفتوحة',
        'كيف يُطلب الإلغاء والاسترداد؟'
    ]) assert.ok(section.includes(phrase), `عبارة مفقودة في قسم السياسة: ${phrase}`);
});

test('قسم السياسة يربط صفحة السياسة وقسم الاشتراكات داخل حساب الشركة', () => {
    const section = policySection();
    assert.ok(section.includes('href="/company-dashboard/#refundPolicy"'), 'لا رابط لصفحة السياسة في حساب الشركة');
    assert.ok(section.includes('href="/company-dashboard/#subscriptions"'), 'لا رابط لقسم الاشتراكات');
    // لا خروج من الشروط إلى لوحة أخرى: الرابطان داخل حساب الشركة وحده
    assert.doesNotMatch(section, /href="\/admin\/|href="\/owner\//);
});

test('ختم «آخر تحديث: نوفمبر 2026» في موضعيه', () => {
    assert.equal(html.split('نوفمبر 2026').length - 1, 2);
});
