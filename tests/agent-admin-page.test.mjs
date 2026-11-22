/**
 * اختبارات صفحة إدارة وكلاء الذكاء الاصطناعي (admin/agent.html).
 *
 * ما تحرسه هذه الاختبارات — كلها أعطال ظهرت فعلياً في لقطة 2026-11-22:
 *
 *  • النافذة المنبثقة كانت تُقصّ تحت القائمة الجانبية: z-index النافذة
 *    (500) كان تحت القائمة (1001/2000) والشريط العلوي (1000)، فالقائمة
 *    كانت ترسم فوق طرف النافذة والتبويبات. القيم الصحيحة هي نفسها في
 *    admin/mcp.html (نافذة 3000، تنبيهات 4000).
 *  • الحذف كان مخبأً في آخر تبويب («الإجراءات») خلف confirm() الأصلية
 *    للمتصفح. الآن زر حذف في كرت كل وكيل + نافذة تأكيد داخل الصفحة
 *    تعرض اسم الوكيل وتنبّه لو كان آخر وكيل.
 *  • وكيل بلا endpoint (مثل Muse عبر MCP) كان أي فحص اتصال له يرجع
 *    تنبيهاً أحمر كأنه خطأ. غياب الـ endpoint حالة عادية تُعرض
 *    كمعلومة محايدة، والنداءات التي تحتاجه تُتخطّى أصلاً.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    hasDirectEndpoint, isEndpointLessAgent,
    NO_ENDPOINT_MESSAGE, NO_ENDPOINT_CARD_NOTE,
} from '../assets/js/admin/agent-connection-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const agentHtml = () => read('admin/agent.html');
const agentJs = () => read('assets/js/admin/agent.js');

/* ─────────────────── حالة اتصال الوكيل ─────────────────── */

test('وكيل بلا endpoint = حالة عادية بلا اتصال مباشر، لا خطأ', () => {
    assert.equal(isEndpointLessAgent(null), true);
    assert.equal(isEndpointLessAgent({}), true);
    assert.equal(isEndpointLessAgent({ endpoint: '' }), true);
    assert.equal(isEndpointLessAgent({ endpoint: '   ' }), true);
    assert.equal(isEndpointLessAgent({ endpoint: null }), true);
});

test('وكيل فيه endpoint = اتصال مباشر', () => {
    assert.equal(hasDirectEndpoint({ endpoint: 'https://hermes.internal:8080' }), true);
    assert.equal(hasDirectEndpoint({ endpoint: 'http://127.0.0.1:8080/health' }), true);
    assert.equal(isEndpointLessAgent({ endpoint: 'https://hermes.internal:8080' }), false);
});

test('رسالة بلا endpoint محايدة وتفسّر الحالة بدل أن تتهمها', () => {
    assert.match(NO_ENDPOINT_MESSAGE, /بلا endpoint/);
    assert.match(NO_ENDPOINT_MESSAGE, /خارج مدعوم/);
    assert.match(NO_ENDPOINT_MESSAGE, /MCP/);
    assert.doesNotMatch(NO_ENDPOINT_MESSAGE, /خطأ/);
    assert.match(NO_ENDPOINT_CARD_NOTE, /بلا endpoint/);
});

/* ─────────── ترتيب الطبقات: النافذة فوق القائمة والشريط ─────────── */

function zIndexOf(css, selector) {
    const re = new RegExp(`${selector}\\{[^}]*z-index:\\s*(\\d+)`, 's');
    const m = css.match(re);
    assert.ok(m, `لم نجد z-index لـ ${selector}`);
    return Number(m[1]);
}

test('نافذة الإعدادات تعلو القائمة الجانبية والشريط العلوي', () => {
    const html = agentHtml();
    const modalZ = zIndexOf(html, '\\.modal-overlay');
    assert.equal(modalZ, 3000, 'نفس قيمة نوافذ admin/mcp.html');
    // القائمة الجانبية: 1001 في dashboard-layout.css و2000 في admin-style.css.
    // الشريط العلوي: 1000.
    assert.ok(modalZ > 2000, 'النافذة فوق القائمة الجانبية');
    assert.ok(modalZ > 1000, 'النافذة فوق الشريط العلوي');
});

test('التنبيهات تعلو القائمة الجانبية أيضاً', () => {
    const html = agentHtml();
    const toastZ = zIndexOf(html, '\\.toast-wrap');
    assert.equal(toastZ, 4000, 'نفس قيمة حاوية التنبيهات في admin/mcp.html');
    assert.ok(toastZ > 2000, 'التنبيه فوق القائمة الجانبية');
});

/* ─────────────────── تدفق الحذف ─────────────────── */

test('زر حذف في كرت كل وكيل، لا حذف مخبأ في التبويبات فقط', () => {
    const js = agentJs();
    assert.match(js, /data-quick-act="delete"/);
    assert.match(js, /title="حذف الوكيل"/);
});

test('الحذف يمر بنافذة تأكيد داخل الصفحة تعرض اسم الوكيل', () => {
    const html = agentHtml();
    const js = agentJs();
    assert.match(html, /id="deleteConfirmModal"/);
    assert.match(html, /id="deleteConfirmText"/);
    assert.match(html, /id="btnConfirmDelete"/);
    assert.match(js, /function openDeleteConfirm\(agentId\)/);
    assert.match(js, /سيتم حذف الوكيل/);
    // لا confirm() أصلية للمتصفح في مسار الحذف.
    assert.doesNotMatch(js, /confirm\('هل أنت متأكد من حذف/);
    // زر التأكيد يُعطَّل أثناء الحذف لمنع النقر المزدوج.
    assert.match(js, /btn\.disabled = true/);
});

test('تأكيد الحذف ينبّه لو كان الوكيل آخر وكيل في القائمة', () => {
    const html = agentHtml();
    const js = agentJs();
    assert.match(html, /id="deleteConfirmLastNote"/);
    assert.match(html, /آخر وكيل في القائمة/);
    assert.match(js, /deleteConfirmLastNote/);
    assert.match(js, /agentsCache\.length !== 1/);
});

test('حذف وكيل مفتوح في نافذة الإعدادات يغلق النافذة أيضاً', () => {
    const js = agentJs();
    assert.match(js, /const wasOpen = currentAgentId === id/);
    assert.match(js, /if \(wasOpen\) \{ currentAgentId = null; closeModal\(\); \}/);
});

/* ─────────────── وكيل بلا endpoint: معلومة لا خطأ ─────────────── */

test('فحص الاتصال والتحكم والحالة والسجلات تُتخطّى لوكيل بلا endpoint', () => {
    const js = agentJs();
    const uses = js.match(/isEndpointLessAgent\(/g) || [];
    // الكرت + quickAction + تبويب الإجراءات + تحديث الحالة + السجلات + فتح النافذة.
    assert.ok(uses.length >= 6, `توقعنا 6 استخدامات على الأقل، وجدنا ${uses.length}`);
    assert.match(js, /toast\(NO_ENDPOINT_MESSAGE, 'info'\)/);
});

test('تبويب الحالة يوضّح غياب الـ endpoint ويعطّل زر التحديث', () => {
    const html = agentHtml();
    const js = agentJs();
    assert.match(html, /id="noEndpointNote"/);
    assert.match(js, /noEndpointNote/);
    assert.match(js, /refreshBtn\.disabled = noEndpoint/);
});

/* ─────────────────── تبسيط الإعدادات ─────────────────── */

test('حقول Host/Port/Protocol والمهل مطوية في إعدادات متقدمة', () => {
    const html = agentHtml();
    assert.match(html, /<details class="advanced-details">/);
    assert.match(html, /إعدادات متقدمة/);
    // الـ Endpoint نفسه يبقى ظاهراً خارج القسم المطوي.
    const detailsAt = html.indexOf('<details class="advanced-details">');
    const endpointAt = html.indexOf('id="fEndpoint"');
    assert.ok(endpointAt !== -1 && endpointAt < detailsAt, 'حقل Endpoint قبل القسم المطوي');
});

test('تبويب التشغيل يظهر فقط للعمليات المحلية', () => {
    const js = agentJs();
    assert.match(js, /function updateRuntimeTabVisibility\(\)/);
    assert.match(js, /type === 'process' \|\| type === 'stdio'/);
    assert.match(js, /fConnectionType.*addEventListener\('change', updateRuntimeTabVisibility\)/s);
});

test('التبويب النشط يُمرَّر ليظهر داخل شريط التبويبات', () => {
    const js = agentJs();
    assert.match(js, /btn\.scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/);
});

test('نافذة الإعدادات تستخدم إدارة التركيز وقفل التمرير المشتركة', () => {
    const js = agentJs();
    assert.match(js, /import \* as modalA11y from '\/assets\/js\/admin\/modal-a11y\.js'/);
    assert.match(js, /modalA11y\.init\(\)/);
});

test('شبكتا الموارد والصلاحيات فيهما تحديد الكل وإلغاء التحديد', () => {
    const html = agentHtml();
    const js = agentJs();
    assert.match(html, /data-check-all="resourcesGrid"/);
    assert.match(html, /data-check-none="permissionsGrid"/);
    assert.match(js, /function setAllChecked\(containerId, checked\)/);
});

/* ─────────── كل id يقرأه الـ JS موجود فعلاً في الصفحة ─────────── */

test('كل عنصر يطلبه agent.js بالـ id موجود في agent.html', () => {
    const html = agentHtml();
    const js = agentJs();
    const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length > 30, `توقعنا عشرات الـ ids، وجدنا ${ids.length}`);
    // lastErrorNote يُنشأ ديناميكياً من JS نفسه، فليس في الصفحة أصلاً.
    const dynamic = new Set(['lastErrorNote']);
    const missing = [...new Set(ids)].filter((id) => !dynamic.has(id) && !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `عناصر مفقودة من الصفحة: ${missing.join(', ')}`);
});
