-- ============================================================================
-- 124 — تقييمات المحادثة: نجوم صفحة العميل تُحفَظ فعلًا
--
-- المشكلة: نجوم التقييم في chat-customer.html كانت بصرية فقط — اختيار نجمة
-- يُضيئها على الشاشة ثم يختفي التقييم بإغلاق النافذة. لا جدول ولا نقطة
-- نهاية ولا أي مكان يُقرأ منه رأي العميل لاحقًا.
--
-- الإصلاح: جدول public.chat_ratings يسجّل كل تقييم مع جلسته، ونجمة واحدة
-- لكل جلسة (قيد فريد على session_id)، والتقييم غير قابل للتعديل بعد حفظه
-- (لا سياسة UPDATE ولا DELETE — التقييم سجل، لا مسودة).
--
-- الأعمدة:
--   session_id  الجلسة المقيَّمة (مرجع إلى chat_sessions مع حذف متتابع)
--   user_id     صاحب الجلسة (لأغراض الصلاحيات؛ يطابق chat_sessions.user_id)
--   rating      من 1 إلى 5 نجوم
--   comment     تعليق اختياري
--   created_at  وقت التقييم
--
-- الصلاحيات — مطابقة لقواعد chat_messages نفسها، لا قواعد جديدة:
--   * الإدراج: صاحب الجلسة (user_id = auth.uid() والجلسة له) أو صاحب
--     صلاحية مرتفعة (has_elevated_authority()).
--   * القراءة: صاحبها أو صاحب صلاحية مرتفعة، أو موظف صندوق وارد مكلَّف
--     بالجلسة (inbox_can_access) — كما في chat_messages.
--   * بوابة الحساب النشط (gate_account_active) كما في جداول الشات.
-- ملاحظة: جدول ratings القديم (conversation_id bigint وrating نصًا) لا
-- يصلح هنا — بلا رابط جلسة uuid ولا نطاق نجوم رقمي، ولا يستعمله أي كود.
-- يبقى كما هو ولا يُلمس.
--
-- المتطلبات: chat_sessions، وhas_elevated_authority()‎، وaccount_is_active()‎،
-- وis_platform_staff()‎، وinbox_can_access().
-- التراجع: drop table public.chat_ratings (يحذف التقييمات المحفوظة).
-- ============================================================================

do $$
begin
  if to_regclass('public.chat_sessions') is null
     or to_regprocedure('public.has_elevated_authority()') is null
     or to_regprocedure('public.account_is_active()') is null
     or to_regprocedure('public.is_platform_staff()') is null
     or to_regprocedure('public.inbox_can_access(uuid)') is null then
    raise exception '124 يتطلب chat_sessions و has_elevated_authority و account_is_active و is_platform_staff و inbox_can_access';
  end if;
end $$;

create table if not exists public.chat_ratings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  user_id uuid not null,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  constraint chat_ratings_one_per_session unique (session_id)
);

create index if not exists chat_ratings_user_id_idx
  on public.chat_ratings (user_id, created_at desc);

alter table public.chat_ratings enable row level security;

create policy chat_ratings_insert_own_or_admin
  on public.chat_ratings
  as permissive for insert to public
  with check ((
    has_elevated_authority()
    or (
      (session_id in (select s.id from public.chat_sessions s where s.user_id = auth.uid()))
      and (user_id = auth.uid())
    )
  ));

create policy chat_ratings_select_own_or_admin
  on public.chat_ratings
  as permissive for select to public
  using ((
    has_elevated_authority()
    or (user_id = auth.uid())
    or (session_id in (select s.id from public.chat_sessions s where s.user_id = auth.uid()))
  ));

create policy inbox_assigned_select
  on public.chat_ratings
  as permissive for select to authenticated
  using (((select is_platform_staff() as is_platform_staff) and inbox_can_access(session_id)));

create policy gate_account_active
  on public.chat_ratings
  as restrictive for all to authenticated
  using (account_is_active())
  with check (account_is_active());

-- ============================================================================
-- تحقق ذاتي: الجدول والقيد الفريد والسياسات الأربع موجودة.
-- ============================================================================
do $$
declare
  v_policies int;
begin
  if to_regclass('public.chat_ratings') is null then
    raise exception '124: chat_ratings غير موجود';
  end if;
  select count(*) into v_policies
  from pg_policies
  where schemaname = 'public' and tablename = 'chat_ratings';
  if v_policies <> 4 then
    raise exception '124: سياسات chat_ratings = % لا 4', v_policies;
  end if;
end $$;
