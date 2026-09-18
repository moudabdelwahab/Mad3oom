-- ============================================================================
-- 044_site_errors_status_integrity.sql
--   إغلاق مسار XSS مخزَّن من مجهول إلى لوحة الإدارة.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الثغرة (C-06 في FULL_PROJECT_AUDIT.md)
-- ════════════════════════════════════════════════════════════════════════════
-- `site_errors` مفتوح للإدراج من `anon` بالتصميم (متتبّع الأخطاء في المتصفح
-- يبلّغ قبل تسجيل الدخول). والسياسة تقيّد ثلاثة حقول فقط:
--
--   char_length(message) <= 2000
--   stack_trace IS NULL OR char_length(stack_trace) <= 8000
--   type IS NULL OR type IN ('js','network','promise','resource','console','unhandled')
--
-- وعمود `status` **غير مقيَّد** — لا في السياسة ولا بقيد CHECK على الجدول.
--
-- وفي لوحة الإدارة (admin/errors.html) تُبنى البطاقة هكذا:
--
--   <div class="error-card ${err.status} ..." id="error-${cardId}">
--
-- أي أن `status` يُدرَج **بلا هروب** داخل قيمة سمة محدَّدة بعلامتَي اقتباس، ثم
-- يُسنَد الناتج عبر innerHTML. بقية الحقول مهروبة بـescapeHtml، و`type` تحرسه
-- قائمة السياسة — فالمنفذ الوحيد هو `status`، وهو مفتوح تمامًا.
--
-- أُثبت على الإنتاج داخل معاملة انتهت بـROLLBACK: إدراج بهوية `anon` بقيمة
--   status = 'x"><img src=x onerror=...>'
-- نجح وخُزِّن حرفيًا.
--
-- الأثر: تنفيذ JavaScript داخل جلسة الأدمن على أصل التطبيق ⇒ سرقة access_token
-- من localStorage ⇒ استيلاء كامل على حساب الإدارة. ونقطة البداية **مجهول بلا
-- حساب**، فهذا أقصر مسار تصعيد في المشروع.
--
-- ════════════════════════════════════════════════════════════════════════════
-- العلاج — طبقتان، ولا واحدة منهما تكفي وحدها
-- ════════════════════════════════════════════════════════════════════════════
--   ① قيد CHECK على العمود      → الحقيقة عند التخزين، تحمي أي مستهلك مستقبلي
--   ② تضييق سياسة الإدراج        → المجهول يبلّغ بحالة 'new' وحدها
--   ③ هروب في admin/errors.html  → (خارج هذا الملف) الطبقة الأخيرة عند العرض
--
-- القيم الثلاث هي بالضبط ما تستعمله اللوحة في تبويباتها
-- (data-status="new|resolved|archived")، وما يكتبه errorService.updateStatus.
--
-- البيانات القائمة فُحصت قبل إضافة القيد: 922 صفًّا 'new' و507 'resolved'،
-- و**صفر** صف بقيمة أخرى. فالقيد يُضاف بلا إعادة كتابة صف واحد.
--
-- ROLLBACK
--   alter table public.site_errors drop constraint site_errors_status_check;
--   -- ولإعادة السياسة السابقة، احذف شرط status من WITH CHECK أدناه.
-- ============================================================================

-- ── ① القيد ────────────────────────────────────────────────────────────────
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from public.site_errors
   where status is null or status not in ('new','resolved','archived');

  if v_bad > 0 then
    raise exception 'توقف: % صفًّا يحمل status خارج القائمة — راجعها قبل إضافة القيد', v_bad;
  end if;
end $$;

alter table public.site_errors drop constraint if exists site_errors_status_check;
alter table public.site_errors
  add constraint site_errors_status_check
  check (status in ('new','resolved','archived'));

-- ── ② السياسة ──────────────────────────────────────────────────────────────
-- محفوظة حرفيًا كما كانت، ويُضاف إليها شرط واحد: البلاغ المجهول يبدأ 'new'.
-- متتبّع الأخطاء (error-tracker.js:69) يرسل status:'new' صراحةً، والعمود
-- افتراضه 'new' أيضًا، فلا ينكسر أي مسار قائم.
drop policy if exists "Allow public insert for errors" on public.site_errors;
create policy "Allow public insert for errors" on public.site_errors
  for insert
  with check (
        char_length(message) <= 2000
    and (stack_trace is null or char_length(stack_trace) <= 8000)
    and (type is null or type = any (array['js','network','promise','resource','console','unhandled']))
    and status = 'new'
  );

-- ============================================================================
-- تحقق ذاتي
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.site_errors'::regclass
       and conname  = 'site_errors_status_check'
  ) then
    raise exception 'قيد status لم يُضَف';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname='public' and tablename='site_errors'
       and policyname='Allow public insert for errors'
       and with_check like '%status%'
  ) then
    raise exception 'سياسة الإدراج لا تقيّد status';
  end if;

  raise notice '044: status مقيَّد في الجدول وفي السياسة';
end $$;
