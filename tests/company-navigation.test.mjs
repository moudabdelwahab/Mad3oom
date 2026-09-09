/**
 * اختبارات تنقّل لوحة الشركة — القاعدة التي أرساها قرار المنتج:
 *
 *   بمجرد ارتباط الحساب بشركة تصبح لوحة الشركة لوحته الرسمية، فلا يوجد في
 *   مسارها أي انتقال إلى بوابة العميل ولا إلى لوحة الإدارة.
 *
 * الاختبارات هنا ثابتة (تفحص المصدر) وتُكمّل الاختبارات السلوكية في
 * tests/company-add-member.render.test.mjs التي تمرّن الأمر في متصفح فعلي.
 * الفصل مقصود: الضوابط الثابتة تكشف رابطًا مضافًا في مراجعة كود حتى لو لم
 * يمرّ عليه اختبار سلوكي.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** كل ما يُشكّل لوحة الشركة: الصفحة، قائمتها، ووحداتها. */
const COMPANY_SURFACE = [
    'company-dashboard/index.html',
    'assets/js/company/company-api.js',
    'assets/js/company/company-reports.js',
    'assets/js/company/company-activity.js',
    'assets/components/company-sidebar.html',
    'assets/js/company/company-dashboard.js',
    'assets/js/company/company-tickets.js',
    'assets/js/company/company-support.js',
    'assets/js/company/company-notifications.js',
    'assets/js/company/company-account.js',
    'assets/js/company/company-data.js',
    'assets/js/company/company-model.js',
    'assets/js/company/company-onboarding.js'
];

/** صفحات بوابة العميل — أي إشارة قابلة للتنقّل إليها من لوحة الشركة ممنوعة. */
const CUSTOMER_PAGES = [
    'customer-dashboard.html',
    'customer-subscriptions.html',
    'customer-security-settings.html',
    'customer-history.html',
    'knowledge-base.html',
    'chat-customer.html',
    'community.html',
    'roadmap.html',
    'rewards.html'
];

/**
 * الإشارات القابلة للتنقّل في ملف: href/src/action وقيم window.location.
 * ملفات الأنماط والسكربتات المستوردة ليست تنقّلًا — الفصل مقصود حتى لا
 * يمنع الاختبارُ إعادةَ استخدام نظام التصميم نفسه.
 */
function navigableTargets(src) {
    const targets = [];

    for (const m of src.matchAll(/(?:href|action)\s*=\s*["']([^"']+)["']/g)) targets.push(m[1]);
    for (const m of src.matchAll(/window\.location(?:\.href|\.replace\(|\.assign\()?\s*=?\s*['"`]([^'"`]+)['"`]/g)) {
        targets.push(m[1]);
    }
    // قيم مسارات مكتوبة صراحةً داخل نصوص (مثل goto: '/x.html')
    for (const m of src.matchAll(/['"`](\/[A-Za-z0-9._\-/]*\.html[^'"`]*)['"`]/g)) targets.push(m[1]);

    // استيراد الوحدات وملفات الأنماط ليست تنقّلًا
    return targets.filter(t => !/\.(css|js|mjs|png|svg|ico|woff2?)($|\?)/.test(t));
}

/* ── القاعدة الأساسية ───────────────────────────────────────────────────── */

test('لا رابط واحد في لوحة الشركة يذهب إلى بوابة العميل', () => {
    for (const rel of COMPANY_SURFACE) {
        for (const target of navigableTargets(read(rel))) {
            const hit = CUSTOMER_PAGES.find(page => target.includes(page));
            assert.equal(hit, undefined,
                `${rel} ينقل إلى صفحة من بوابة العميل: ${target}`);
        }
    }
});

test('لا رابط واحد في لوحة الشركة يذهب إلى /admin/ — بلا استثناء', () => {
    for (const rel of COMPANY_SURFACE) {
        for (const target of navigableTargets(read(rel))) {
            assert.ok(!target.includes('/admin/'),
                `${rel} ينقل إلى لوحة الإدارة: ${target}`);
        }
    }
});

test('كل روابط قائمة الشركة تبقى داخل /company-dashboard/', () => {
    const nav = read('assets/components/company-sidebar.html');
    const hrefs = [...nav.matchAll(/href\s*=\s*["']([^"']+)["']/g)].map(m => m[1]);

    assert.ok(hrefs.length >= 10, `عدد روابط القائمة أقل من المتوقع: ${hrefs.length}`);
    for (const href of hrefs) {
        const ok = href === '#' || href.startsWith('#') || href.startsWith('/company-dashboard/');
        assert.ok(ok, `رابط في قائمة الشركة يغادر اللوحة: ${href}`);
    }
});

/* ── كل وظيفة إما نُقلت أو استُبعدت بقرار ──────────────────────────────── */

/**
 * الجرد الكامل لما كانت قائمة بوابة العميل تقدّمه للوحة الشركة.
 * كل سطر إما `section` (نُقل إلى قسم في لوحة الشركة) أو `dropped` (لا معنى
 * له لحساب شركة، فحُذف بدل اختراع نسخة). لا يوجد سطر بلا قرار — وهذا هو
 * المطلوب في البند «كل وظيفة أصبحت متاحة أو تم تحديد أنها غير مناسبة».
 */
const FUNCTION_INVENTORY = [
    { name: 'نظرة عامة',        section: 'overview' },
    { name: 'مستخدمو الشركة',   section: 'members' },
    { name: 'الاشتراكات',       section: 'subscriptions' },
    { name: 'تذاكري مع مدعوم',  section: 'tickets' },
    { name: 'تذاكر العملاء',    section: 'customerTickets' },
    { name: 'مركز الدعم',       section: 'support' },
    { name: 'مقالات المساعدة',  section: 'support' },
    { name: 'حالة النظام',      section: 'support' },
    { name: 'الإشعارات',        section: 'notifications' },
    { name: 'الملف الشخصي',     section: 'profile' },
    { name: 'الأمان',           section: 'security' },
    { name: 'سجل الدخول',       section: 'security' },

    // مستوحاة من لوحة الإدارة بعد جرد أقسامها، بمقاييس تخصّ الشركة
    { name: 'API ومفاتيحه',     section: 'api' },
    { name: 'التقارير',         section: 'reports' },
    { name: 'النشاط',           section: 'activity' },

    { name: 'الاستهلاك والحدود', dropped: 'استهلاك فردي — استحقاقات الشركة تظهر في قسم الاشتراكات' },
    { name: 'المكافآت والنقاط',  dropped: 'برنامج ولاء فردي لا معنى له لكيان شركة' },
    { name: 'الشارات',           dropped: 'إنجازات فردية' },
    { name: 'مجتمع مدعوم',       dropped: 'مساحة مستخدمين أفراد' },
    { name: 'خارطة الطريق',      dropped: 'محتوى منتج عام، ليس وظيفة حساب' },
    { name: 'المحادثة الفورية',  dropped: 'قناة دعم فردية — دعم الشركة عبر التذاكر بأثر موثّق' }
];

/** الأقسام المعلَنة في موجّه لوحة الشركة. */
function declaredSections() {
    const src = read('assets/js/company/company-dashboard.js');
    const match = src.match(/const SECTIONS = \[([^\]]*)\]/);
    assert.ok(match, 'قائمة الأقسام غير موجودة في موجّه لوحة الشركة');
    // القائمة تحمل تعليقات توضّح كل مسار — نستخرج النصوص المقتبسة وحدها
    // بدل التقسيم على الفواصل، وإلا التقطنا نص التعليق مع اسم القسم.
    return [...match[1].matchAll(/['"]([A-Za-z][A-Za-z0-9_]*)['"]/g)].map(m => m[1]);
}

test('كل وظيفة في الجرد إما قسم حقيقي في لوحة الشركة أو استُبعدت بسبب معلن', () => {
    const sections = declaredSections();

    for (const entry of FUNCTION_INVENTORY) {
        assert.ok(entry.section || entry.dropped,
            `الوظيفة «${entry.name}» بلا قرار — لا قسم ولا سبب استبعاد`);

        if (entry.section) {
            assert.ok(sections.includes(entry.section),
                `الوظيفة «${entry.name}» تشير إلى قسم غير موجود: ${entry.section}`);
        } else {
            assert.ok(entry.dropped.length > 10,
                `الوظيفة «${entry.name}» استُبعدت بلا سبب مكتوب`);
        }
    }
});

test('كل قسم معلَن له حاوية في الصفحة ومُحمِّل أو محتوى ثابت', () => {
    const html = read('company-dashboard/index.html');
    const js = read('assets/js/company/company-dashboard.js');

    for (const section of declaredSections()) {
        assert.ok(html.includes(`id="${section}TabContent"`),
            `القسم ${section} معلَن في الموجّه لكن لا حاوية له في الصفحة`);
    }

    // الأقسام التي تُحمَّل عند الفتح لازم تكون مسجّلة في LOADERS
    for (const section of ['tickets', 'customerTickets', 'support', 'notifications',
                           'api', 'reports', 'activity', 'profile', 'security']) {
        assert.match(js, new RegExp(`${section}:\\s*\\(\\)\\s*=>`),
            `القسم ${section} بلا مُحمِّل — سيفتح فارغًا`);
    }
});

/* ── المنطق مشترك، الواجهة مستقلة ───────────────────────────────────────── */

test('أقسام الشركة تُبنى فوق الوحدات المشتركة، لا نسخة ثانية من المنطق', () => {
    const shared = {
        'assets/js/company/company-tickets.js': ['/tickets-service.js', 'ticket-view-model.js', 'fetchMemberTickets'],
        'assets/js/company/company-api.js': ['customer-data.js', 'fetchApiUsage'],
        'assets/js/company/company-reports.js': ['ticket-view-model.js', 'company-model.js'],
        'assets/js/company/company-activity.js': ['customer-data.js', 'activity-model.js'],
        'assets/js/company/company-support.js': ['/tickets-service.js', 'customer-data.js', 'service-status-model.js', 'help-data.js'],
        'assets/js/company/company-notifications.js': ['/notifications-service.js', 'notification-router.js'],
        'assets/js/company/company-account.js': ['/auth-client.js', 'customer-data.js', 'activity-model.js']
    };

    for (const [file, imports] of Object.entries(shared)) {
        const src = read(file);
        // نفصل كتلة الاستيراد عن جسم الملف: وجود الاسم في import وحده ليس
        // إعادة استخدام — الاستيراد الميت كان سيمرّ بلا ذلك.
        const lastImport = src.lastIndexOf("from '");
        const body = src.slice(src.indexOf('\n', lastImport) + 1);

        for (const dep of imports) {
            assert.ok(src.includes(dep), `${file} لا يستورد ${dep}`);
            if (/^[a-z][A-Za-z]*$/.test(dep)) {
                assert.ok(body.includes(dep), `${file} يستورد ${dep} ولا يستعمله`);
            }
        }
    }
});

test('قشرة البوابة واحدة تخدم اللوحتين — بلا ملف قائمة ثانٍ بنفس المنطق', () => {
    const shell = read('assets/js/customer-sidebar.js');
    assert.match(shell, /export function initCompanyShell/);
    assert.match(shell, /export function initCustomerSidebar/);

    // البيتان مختلفان صراحةً: هذا ما يمنع قائمة الشركة من إرسال المستخدم
    // إلى بوابة العميل
    assert.match(shell, /home:\s*'\/customer-dashboard\.html'/);
    assert.match(shell, /home:\s*'\/company-dashboard\/'/);

    // لا يوجد ملف قشرة ثانٍ يكرّر المنطق
    assert.equal(fs.existsSync(path.join(ROOT, 'assets/js/company/company-sidebar.js')), false,
        'ظهر ملف قشرة ثانٍ للشركة — المنطق يجب أن يبقى في قشرة واحدة');
});

/* ── قاعدة البيانات لم تتغيّر من أجل الواجهة ────────────────────────────── */

test('لا وحدة من وحدات لوحة الشركة تكتب في جداول القاعدة مباشرةً', () => {
    // الكتابة كلها عبر RPC (SECURITY DEFINER) أو Edge Function أو خدمة
    // مشتركة قائمة — فلا صلاحية جديدة ولا تعديل مخطط لمجرد تشغيل واجهة.
    // القراءة من كتالوج عام (subscription_plans) مسموحة: هي بيانات أسعار
    // معروضة للجميع، وليست بيانات مستأجر.
    const WRITE_OPS = /\.\s*(insert|update|upsert|delete)\s*\(/;
    const TENANT_TABLES = ['profiles', 'companies', 'tickets', 'notifications', 'whatsapp_subscriptions'];

    /**
     * استثناءات مُبرَّرة: كتابة مباشرة تكون سياسة RLS فيها **هي** التفويض
     * الدقيق، فلا حاجة لدالة وسيطة.
     *
     *   api_tokens.update ← السياسة على الإنتاج:
     *     USING/WITH CHECK (auth.uid() = user_id OR is_admin() OR is_owner_or_super_of(user_id))
     *   وهي بالضبط القاعدة المطلوبة: صاحب المفتاح أو مالك شركته.
     *
     * في المقابل tickets لا تُستثنى: حارسها (enforce_customer_ticket_update)
     * لا يقيّد مالك الشركة، فمنحه UPDATE كان سيفتح تغيير user_id — ولذلك
     * إجراءا الحالة هناك يمرّان بدالتَي القاعدة.
     */
    const RLS_AUTHORIZED_WRITES = new Set(['api_tokens.update']);

    for (const rel of COMPANY_SURFACE.filter(f => f.endsWith('.js'))) {
        const src = read(rel);

        for (const m of src.matchAll(/supabase\s*\.\s*from\s*\(\s*['"]([^'"]+)['"]\s*\)([\s\S]{0,160})/g)) {
            const [, table, tail] = m;
            assert.ok(!TENANT_TABLES.includes(table),
                `${rel} يصل إلى جدول مستأجر مباشرةً (${table}) — استخدم RPC`);

            const write = tail.match(WRITE_OPS);
            if (write) {
                assert.ok(RLS_AUTHORIZED_WRITES.has(`${table}.${write[1]}`),
                    `${rel} يكتب في ${table} مباشرةً بلا مبرّر — الكتابة عبر RPC أو Edge Function`);
            }
        }
    }
});

test('لم تُضَف أي ترحيلات مع هذا التغيير', () => {
    const migrations = fs.readdirSync(path.join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort();
    // اللقطة المرجعية: آخر ترحيل موجود قبل تعديل تنقّل لوحة الشركة.
    // تغيير واجهة لا يجوز أن يزيد هذا الرقم.
    // 033 أُضيف عمدًا: فصل مساري التذاكر كشف تسرّبًا في سياسة الردود لا
    // يمكن إصلاحه من الواجهة. أي ترحيل بعده يحتاج قرارًا صريحًا.
    assert.equal(migrations[migrations.length - 1], '034_explicit_ticket_reopen_and_close.sql',
        'ظهر ترحيل جديد غير مخطَّط له — راجع السبب');
});

/* ── قسم API: لا أسرار، ولا ثقة في الواجهة ─────────────────────────────── */

test('قسم API لا يقرأ ولا يعرض أي سرّ', () => {
    const src = read('assets/js/company/company-api.js');

    // secret_hash و bearer_token_hash و credentials_encrypted أعمدة سرّية:
    // لا تُطلب في أي select، فلا يمكن أن تصل للمتصفح أصلًا. نفحص محتوى
    // نداءات select وحدها — ذِكر اسم العمود في تعليق يشرح أنه محجوب مقصود.
    const selected = [...src.matchAll(/\.select\(\s*'([^']*)'/g)].map(m => m[1]).join(' ');
    for (const secret of ['secret_hash', 'bearer_token_hash', 'credentials_encrypted']) {
        assert.ok(!selected.includes(secret),
            `قسم API يقرأ عمودًا سرّيًا في select: ${secret}`);
    }

    // المعروض هو آخر أربع خانات فقط
    assert.match(src, /secret_last_four/);
});

test('قسم API لا يخترع مسار إنشاء مفاتيح — لا سياسة INSERT في القاعدة', () => {
    const src = read('assets/js/company/company-api.js');
    assert.doesNotMatch(src, /from\(\s*'api_tokens'\s*\)[\s\S]{0,120}\.insert\(/,
        'الواجهة تحاول إنشاء مفتاح، والقاعدة لا تسمح بذلك');
    // البديل الصحيح: الطلب عبر الدعم
    assert.match(src, /onRequestNewKey|onRequestKey/);
});

test('تغيير حالة التذكرة يمرّ بدوال القاعدة لا بـUPDATE من العميل', () => {
    const service = read('tickets-service.js');
    assert.match(service, /rpc\('reopen_ticket_in_my_scope'/);
    assert.match(service, /rpc\('close_ticket_in_my_scope'/);

    // لا وحدة من وحدات الشركة تحدّث جدول التذاكر مباشرةً
    for (const rel of ['assets/js/company/company-tickets.js']) {
        const src = read(rel);
        assert.doesNotMatch(src, /from\(\s*'tickets'\s*\)/,
            `${rel} يصل إلى جدول التذاكر مباشرةً`);
    }
});

test('الردّ لا يستدعي إعادة الفتح — الفعلان منفصلان في الكود', () => {
    const src = read('assets/js/company/company-tickets.js');
    // القصّ ينتهي عند الدالة التالية مباشرةً: onStatusAction هي التي تستدعي
    // reopenTicket شرعًا، وإدخالها في القصّ كان يقلب النتيجة.
    const onReply = src.slice(
        src.indexOf('async function onReply'),
        src.indexOf('async function onStatusAction')
    );
    assert.ok(!onReply.includes('reopenTicket'), 'دالة الردّ تستدعي إعادة الفتح');
    assert.match(src, /data-stream-action="new"|ReopenBtn/);
});

/* ── جرس الإشعارات ─────────────────────────────────────────────────────── */

test('الجرس يفتح نافذة منبثقة ولا يبدّل القسم في لوحة الشركة', () => {
    const shell = read('assets/js/customer-sidebar.js');
    const router = read('assets/js/company/company-dashboard.js');

    assert.match(router, /notificationsPopover:\s*true/,
        'لوحة الشركة لم تطلب النافذة المنبثقة');
    assert.match(shell, /if \(options\.notificationsPopover === true\)[\s\S]{0,120}toggleNotificationPopover/,
        'الجرس لا يفتح النافذة المنبثقة');

    // «عرض الكل» هو المسار الوحيد إلى القسم
    assert.match(shell, /onSeeAllNotifications/);
    assert.match(router, /onSeeAllNotifications: \(\) => showSection\('notifications'\)/);
});

test('النافذة المنبثقة تُبنى فوق خدمة الإشعارات القائمة لا نظام ثانٍ', () => {
    const shell = read('assets/js/customer-sidebar.js');
    const popover = shell.slice(shell.indexOf('async function fillNotificationPopover'));
    assert.match(popover, /import\('\/notifications-service\.js'\)/,
        'النافذة لا تستخدم خدمة الإشعارات المشتركة');
});
