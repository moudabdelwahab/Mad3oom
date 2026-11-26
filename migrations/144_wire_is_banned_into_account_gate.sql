-- ============================================================================
-- 144_wire_is_banned_into_account_gate.sql — تثبيت ربط الحظر ببوابة الحساب.
--
-- **هذا الترحيل توثيق/تثبيت، لا إصلاح سلوكي حي.** الدالة الحية
-- `account_is_active()` تستدعي `is_banned()` فعلًا منذ 2026-09-18 عبر ترحيل
-- مسجَّل في `supabase_migrations.schema_migrations` باسم
-- `h04_wire_is_banned_into_account_gate` (الإصدار `20260918134408`) **بلا أي
-- ملف في `migrations/`** — فملف المستودع `migrations/042_account_gate.sql`
-- (سطران 120-127) ما زال على النسخة القديمة بلا فحص حظر. هذا الترحيل ينقل
-- نص h04 حرفيًا إلى ملف ترحيل مُرقَّم، حتى لا يُفقد الربط عند إعادة تطبيق
-- 042 أو بناء بيئة جديدة من الملفات وحدها (بيئة كهذه تعيد إنتاج النسخة بلا
-- حظر، فيمرّ منها مستخدم محظور موثَّق الهاتف من كل البوابات).
--
-- الجسم أدناه **مطابق حرفيًا** لجسم h04 الحي (من `pg_get_functiondef`)،
-- ومطابق لنسخة الـ fixture في `tests/fixtures/prod-shape/50_functions_a.sql`
-- (سطران 442-451). أي صياغة بديلة — مثل وضع الحظر داخل فرع `OR`، أو إعفاء
-- المالك من الحظر — تغيّر السلوك الحي المعمول به منذ سبتمبر، فلا تبديل هنا:
--   • فحص الحظر فوق الإعفاء: `NOT is_banned AND (exempt OR …)` — فمالكٌ
--     محظورٌ افتراضًا يُمنع من المسارات المبوَّبة، وهو النمط القائم نفسه في
--     `_inbox_account_active` (058) و`conv_account_active` (067).
--   • فرع الإعفاء نفسه (`gate_is_exempt_account`) لا يُمسّ، ولا أي سياسة
--     `gate_account_active` (الـ 111 كلها تستدعي الدالة، فتعديل الدالة
--     وحدها يصلحها كلها دفعة واحدة).
--   • لا يُعدَّل ملف 042 إطلاقًا (تاريخ)؛ ولا يُمسّ `ban_status`، ولا
--     إبطال جلسات، ولا `my_account_gate()` (غياب فرع 'banned' فيها فجوة
--     عرض مؤجلة، خارج النطاق).
--
-- التسجيل: لا يسجّل أي ترحيل في هذا المستودع نفسه في `schema_migrations`
-- (منها 141)؛ التسجيل يتم بخطوة التطبيق كما حدث مع 136–141 — وهو الانجراف
-- نفسه الذي يجب ألا يتكرر مع 144: عند التطبيق الحي يُسجَّل هذا الملف
-- بالاسم `144_wire_is_banned_into_account_gate` في `schema_migrations`.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/144_wire_is_banned_into_account_gate.down.sql
-- (يعيد جسم 042 بلا فحص حظر — أي أنه يعيد إنتاج الانجراف؛ للطوارئ فقط).
-- ============================================================================

begin;

-- ── 0) الشروط المسبقة ────────────────────────────────────────────────────
-- الدوال الثلاث التي يبني عليها الترحيل يجب أن توجد قبل التعديل، وإلا فشل
-- واضح بدل تعريف دالة تستدعي ما لا وجود له.
do $$
begin
  if to_regprocedure('public.is_banned(uuid)') is null then
    raise exception '144 يتطلب public.is_banned(uuid) من الترحيل 029';
  end if;
  if to_regprocedure('public.account_is_active()') is null then
    raise exception '144 يتطلب public.account_is_active() من الترحيل 042';
  end if;
  if to_regprocedure('public.gate_is_exempt_account(uuid)') is null then
    raise exception '144 يتطلب public.gate_is_exempt_account(uuid) من الترحيل 042/053';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'ban_status') then
    raise exception '144 يتطلب العمود profiles.ban_status الذي تقرأه is_banned()';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'ban_until') then
    raise exception '144 يتطلب العمود profiles.ban_until الذي تقرأه is_banned()';
  end if;
end $$;

-- ── 1) الجسم — حرفيًا كما في h04 الحي (20260918134408) ───────────────────
create or replace function public.account_is_active()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select not public.is_banned(auth.uid())
     and coalesce(
           public.gate_is_exempt_account(auth.uid())
           or (public.account_is_whitelisted(auth.uid()) and public.account_verification_ok(auth.uid())),
           false);
$$;

comment on function public.account_is_active() is
  'بوابة الحساب: غير محظور، وموجود في القائمة البيضاء، ومتحقَّق منه. تُستعمل في سياسات gate_account_active الـRESTRICTIVE. فرع الحظر أُضيف في هذه الدفعة (H-04) بعد أن عرّف الترحيل 029 دالة is_banned وتركها غير مربوطة عمدًا.';

-- ── 2) المنح — كما في 042: السياسات تُقيَّم بصلاحيات المستعلِم ───────────
-- إعادة تعريف الدالة لا تسحب منحها، لكن إثباتها هنا يحفظ قابلية إعادة
-- التشغيل على قاعدة أُعيد فيها إنشاء الدالة بلا منح.
revoke execute on function public.account_is_active() from public, anon;
grant execute on function public.account_is_active() to authenticated;

-- ── 3) تحقق ذاتي ─────────────────────────────────────────────────────────
do $$
declare
  v_def text;
  v_volatile "char";
  v_secdef boolean;
  v_gate_policies integer;
begin
  -- (أ) التعريف الجديد يحوي فحص الحظر فعلًا، بالصيغة الحية نفسها.
  select pg_get_functiondef('public.account_is_active()'::regprocedure) into v_def;
  if v_def is null or v_def !~ 'is_banned' then
    raise exception '144: تعريف account_is_active() لا يحوي is_banned';
  end if;
  if v_def !~ 'not public\.is_banned\(auth\.uid\(\)\)' then
    raise exception '144: فحص الحظر ليس بالصيغة الحية (not public.is_banned(auth.uid()))';
  end if;
  if v_def !~ 'gate_is_exempt_account' then
    raise exception '144: فرع إعفاء المالك اختفى من account_is_active()';
  end if;

  -- (ب) خصائص الدالة لم تتغير: STABLE + SECURITY DEFINER كما في 042 وh04.
  select p.provolatile, p.prosecdef into v_volatile, v_secdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'account_is_active'
     and p.pronargs = 0;
  if v_volatile <> 's' then
    raise exception '144: account_is_active() لم تعد STABLE (%)', v_volatile;
  end if;
  if not v_secdef then
    raise exception '144: account_is_active() فقدت SECURITY DEFINER';
  end if;

  -- (ج) دالة الإعفاء ما زالت موجودة، وسياسات البوابة ما زالت قائمة:
  -- إعادة تعريف الدالة وحدها لا تحذف أي سياسة، فالصفر وحده هو ما يدل
  -- على انكسار (لا مقارنة قبل/بعد هنا؛ العدد الكامل يُثبت بالاختبار).
  if to_regprocedure('public.gate_is_exempt_account(uuid)') is null then
    raise exception '144: gate_is_exempt_account(uuid) اختفت بعد الترحيل';
  end if;
  select count(*) into v_gate_policies from pg_policies
   where policyname = 'gate_account_active' and permissive = 'RESTRICTIVE';
  -- في بيئة كاملة يجب أن تكون 110 حيًا / 111 في الملفات (الفرق جدول
  -- workspace_layouts غير الموجود حيًا)؛ وفي بيئة اختبار مصغرة (042 وحده)
  -- تكون 2 على الأقل. الصفر وحده هو ما يدل على انكسار.
  if v_gate_policies < 1 then
    raise exception '144: لا توجد أي سياسة gate_account_active بعد الترحيل';
  end if;

  raise notice 'OK 144: account_is_active() مربوطة بـ is_banned() (تثبيت h04 20260918134408) — سياسات البوابة: %', v_gate_policies;
end $$;

commit;
