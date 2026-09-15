/**
 * فحص ربط (link check) لنسخ mcp-arch المرفقة داخل الـEdge Functions.
 *
 * سبب وجود هذا الملف:
 *
 *   كان mcp-invoke-tool معطّلًا في الإنتاج بالكامل — لا بسبب منطق خاطئ،
 *   بل بسبب سطر استيراد واحد:
 *
 *       auth/providers/api-key.js:1
 *       - import { registerTransport }   from '../registry.js';   ← غير موجود
 *       + import { registerAuthProvider } from '../registry.js';
 *
 *   في ESM هذا ليس خطأ وقت تشغيل يظهر عند استخدام الميزة، بل خطأ ربط
 *   يفشل عند تحميل الوحدة. وبما أن index.ts ← mcp-client-core.ts ←
 *   legacy-bridge.js ← bootstrap.js ← api-key.js كلها استيرادات ساكنة،
 *   كانت الدالة تسقط عند أول استدعاء مهما كان المطلوب منها.
 *
 *   لا اختبار ولا build كان يمرّ على هذه الملفات، فبقي العطل منشورًا.
 *
 * ما يحرسه هذا الملف: أن كل نسخة mcp-arch مرفقة **تُحمَّل فعلًا**، وأن
 * كل provider وtransport يسجّل نفسه كما يفترض bootstrap.
 *
 * ملاحظة: الاستيراد هنا ديناميكي عمدًا. استيراد ساكن كان سيُفشل الملف
 * كله عند الجمع (collection) فتضيع رسالة الخطأ المفيدة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = path.join(repoRoot, 'supabase', 'functions');

/** كل دالة تحمل نسخة خاصة من mcp-arch — نفحصها جميعًا لا واحدة منها. */
function bootstrapPaths() {
    if (!fs.existsSync(functionsDir)) return [];
    return fs.readdirSync(functionsDir)
        .map((fn) => path.join(functionsDir, fn, '_shared', 'mcp-arch', 'bootstrap.js'))
        .filter((p) => fs.existsSync(p));
}

const found = bootstrapPaths();

test('توجد نسخة mcp-arch واحدة على الأقل لفحصها', () => {
    assert.ok(found.length > 0, 'لم يُعثر على أي bootstrap.js — هل تغيّر مسار الدوال؟');
});

for (const bootstrapPath of found) {
    const label = path.relative(functionsDir, bootstrapPath);

    test(`[${label}] يُحمَّل ويسجّل كل providers وtransports`, async () => {
        // لو فشل الربط، ترمي import ويظهر اسم الملف والتصدير المفقود.
        const mod = await import(pathToFileURL(bootstrapPath).href);
        assert.equal(typeof mod.assertBootstrapped, 'function', 'bootstrap لا يصدّر assertBootstrapped');

        const { authTypes, transports } = mod.assertBootstrapped();
        for (const t of ['none', 'api_key', 'bearer', 'oauth2', 'custom']) {
            assert.ok(authTypes.includes(t), `auth provider غير مسجَّل: ${t}`);
        }
        for (const t of ['streamable_http', 'sse', 'stdio']) {
            assert.ok(transports.includes(t), `transport غير مسجَّل: ${t}`);
        }
    });
}

test('نسخ mcp-arch المرفقة متطابقة بين الدوال', () => {
    // انحراف نسخة عن أخرى هو بالضبط ما أنتج العطل: نسخة test-mcp-server
    // كانت سليمة ونسخة mcp-invoke-tool مكسورة، والفرق سطر واحد.
    const trees = found.map((p) => path.dirname(p));
    if (trees.length < 2) return;

    const snapshot = (root) => {
        const out = new Map();
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else out.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
            }
        };
        walk(root);
        return out;
    };

    const [baseRoot, ...rest] = trees;
    const base = snapshot(baseRoot);
    for (const otherRoot of rest) {
        const other = snapshot(otherRoot);
        const label = `${path.relative(functionsDir, baseRoot)} ↔ ${path.relative(functionsDir, otherRoot)}`;
        assert.deepEqual(
            [...other.keys()].sort(), [...base.keys()].sort(),
            `قوائم الملفات مختلفة بين ${label}`
        );
        for (const [name, content] of base) {
            assert.equal(other.get(name), content, `الملف مختلف بين ${label}: ${name}`);
        }
    }
});
