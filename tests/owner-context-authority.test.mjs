/**
 * فحوص ساكنة على حدود التفويض من الواجهة إلى Edge Functions.
 *
 * ما تحرسه هذه الفحوص ليس أسلوبًا بل خاصيتين لا يجوز أن تنكسرا بصمت:
 *
 *   ① لا بريد كآلية تفويض في أي طبقة.
 *      البريد في الواجهة كان `email === 'support@mad3oom.online'`، وفي القاعدة
 *      كان `profiles.email IN (...)` — والعمود قابل للكتابة من العميل. أي
 *      عودة لهذا النمط تعيد ثغرة انتحال هوية كاملة.
 *
 *   ② لا تثق دالة طرفية بسياق يرسله العميل.
 *      السياق حالة في القاعدة. أي دالة تقرأه من body أو header تكون قد حوّلته
 *      من حالة إلى **مُدخَل**، وعندها يصير تزويره تصعيدًا حقيقيًا.
 *
 * والفحوص تنظر إلى الكود بلا تعليقاته عمدًا: شرح الثغرة يذكر اسمها، ولا يجوز
 * أن يُسقط الاختبار.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('--'))
        .join('\n');
}

const EDGE_DIR = path.join(ROOT, 'supabase/functions');
const EDGE_FNS = fs.readdirSync(EDGE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(n => fs.existsSync(path.join(EDGE_DIR, n, 'index.ts')));

/* ── ① لا بريد كآلية تفويض ───────────────────────────────────────────────── */

test('ملفات قرار الوصول في الواجهة لا تقارن بريدًا لتقرير صلاحية', () => {
    for (const rel of ['assets/js/access-policy.js',
                       'assets/js/account-destination.js',
                       'assets/js/admin/sidebar.js']) {
        const code = codeOnly(read(rel));
        assert.doesNotMatch(code, /email\s*===\s*['"][^'"]*@mad3oom/,
            `${rel} يقارن بريدًا لتقرير صلاحية`);
        assert.doesNotMatch(code, /MAIN_ADMIN_EMAIL/,
            `${rel} ما زال يعرّف أو يستعمل بريد الأدمن الرئيسي`);
    }
});

test('الترحيلات الجديدة لا تُبقي البريد أساسًا لأي مُسنَد تفويض', () => {
    // 039 وحده يُستثنى: البريد فيه **محدِّد بيانات** يُقيَّم مرة واحدة داخل
    // ترحيل بمراجعة بشرية، ونتيجته معرّف يُخزَّن — لا مُسنَد يُقيَّم كل طلب.
    const code = codeOnly(read('migrations/040_context_aware_authority.sql'));
    assert.doesNotMatch(code, /profiles\.email/,
        '040 ما زال يقرأ profiles.email في التفويض');
    assert.doesNotMatch(code, /@mad3oom\.(online|com)/,
        '040 ما زال يحمل عناوين بريد محروقة');

    const seed = codeOnly(read('migrations/039_authority_seed.sql'));
    assert.match(seed, /auth\.users/,
        '039 يجب أن يقرأ auth.users لا public.profiles — الثاني يكتبه العميل');
    assert.doesNotMatch(seed, /public\.profiles\s+\w*\s*where[^;]*email/i,
        '039 يبحث بالبريد في profiles بدل auth.users');
});

test('سلطة المنصة تشترط الرتبة والصف معًا — لا أحدهما', () => {
    const code = codeOnly(read('migrations/038_platform_authority.sql'));
    const fn = code.slice(code.indexOf('function public.is_platform_owner()'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    assert.match(body, /platform_authority/, 'is_platform_owner لا تقرأ جدول السلطة');
    assert.match(body, /role\s*=\s*'platform_owner'/, 'is_platform_owner لا تشترط الرتبة');
});

/* ── ② لا سياق من العميل ─────────────────────────────────────────────────── */

test('لا دالة طرفية تقرأ سياق تفويض من الطلب', () => {
    const FORBIDDEN = [
        /body\s*[.?]\s*(active_)?context\b/,
        /body\s*\[\s*["']context["']\s*\]/,
        /headers\s*\.\s*get\(\s*["'][xX]-[^"']*context[^"']*["']/,
        /searchParams\s*\.\s*get\(\s*["'](active_)?context["']/,
        /body\s*[.?]\s*(is_admin|is_owner|platform_owner|elevated)\b/
    ];
    for (const name of EDGE_FNS) {
        const code = codeOnly(read(`supabase/functions/${name}/index.ts`));
        for (const re of FORBIDDEN) {
            assert.doesNotMatch(code, re,
                `${name} يقرأ سياق/صلاحية من الطلب — السياق حالة في القاعدة لا مُدخَل`);
        }
    }
});

test('لا دالة طرفية تقرّر صلاحية بعميل service_role', () => {
    // service_role يتجاوز RLS كليًا. سؤاله عن الصلاحية يعني سؤال حسابٍ يملك
    // كل شيء «هل تملك؟» — والجواب نعم دائمًا. السؤال يكون بعميل المنادي.
    for (const name of EDGE_FNS) {
        const code = codeOnly(read(`supabase/functions/${name}/index.ts`));
        assert.doesNotMatch(
            code,
            /(admin|service)Client\s*\.\s*rpc\(\s*["'](is_admin|is_platform_staff|is_platform_owner|has_elevated_authority|in_context|is_company_admin|owner_capability)["']/,
            `${name} يسأل عن الصلاحية بعميل service_role`);
    }
});

test('فحوص الصلاحية في الدوال الطرفية تمرّ بدوال القاعدة لا بمقارنة رتبة محلية', () => {
    const code = codeOnly(read('supabase/functions/manage-external-integration/index.ts'));
    assert.match(code, /userClient\s*\.\s*rpc\(\s*["']is_admin["']\s*\)/,
        'التفويض لا يُسأل عنه بهوية المنادي');
    // owner_id يأتي من الطلب — وهذا مقبول ما دام يُتحقَّق منه في القاعدة.
    assert.match(code, /userClient\s*\.\s*rpc\(\s*["']is_owner_or_super_of["']/,
        'owner_id المرسَل من العميل لا يُتحقَّق منه في القاعدة');
});

/* ── خريطة القدرات: الواجهة والقاعدة لا يفترقان ─────────────────────────── */

test('خريطة قدرات السياق في الواجهة مطابقة لنظيرتها في القاعدة', async () => {
    const { CONTEXT_CAPABILITIES, OWNER_CONTEXTS } =
        await import('../assets/js/access-policy.js');

    const sql = read('migrations/038_platform_authority.sql');
    const fn = sql.slice(sql.indexOf('function public.context_allows'));
    const body = fn.slice(0, fn.indexOf('$$;'));

    // كل قدرة في الواجهة يجب أن تُذكر للسياق نفسه في القاعدة، وبالعكس.
    for (const ctx of OWNER_CONTEXTS) {
        assert.ok(CONTEXT_CAPABILITIES[ctx],
            `السياق ${ctx} بلا قدرات في الواجهة`);
    }

    const pairs = [
        ['owner_only',     ['owner']],
        ['admin',          ['owner', 'admin']],
        ['staff',          ['owner', 'admin']],
        ['company_admin',  ['owner', 'company_admin']],
        ['company_member', ['company_user_preview']],
        ['customer',       ['owner', 'customer']]
    ];
    for (const [cap, contexts] of pairs) {
        for (const ctx of OWNER_CONTEXTS) {
            const inJs  = (CONTEXT_CAPABILITIES[ctx] || []).includes(cap);
            const inSql = contexts.includes(ctx);
            assert.equal(inJs, inSql,
                `اختلاف في القدرة ${cap} للسياق ${ctx}: الواجهة ${inJs} والقاعدة ${inSql}`);
        }
        // وأن القاعدة فعلًا تحمل هذا السطر
        assert.ok(body.includes(`'${cap}'`),
            `القدرة ${cap} غير معرّفة في context_allows بالقاعدة`);
    }
});
