-- ============================================================================
-- 062_chat_message_authority — رد البوت ورد الدعم من الخادم بس (Phase 3، الجزء 2)
--
-- ⚠️ ترتيب النشر: بعد 061، وبعد نشر sie-api (بيكتب دور البوت بعميل الخادم)
--    والواجهة (بتستعمل chat_post_notice). لو اتطبّق قبلهم، ردود SIE على الموقع
--    ورسايل الترحيب/الأخطاء في المتصفح هتترفض.
--
-- المشكلة (مقيسة على الإنتاج، 2026-09-29):
--   ① سياسة chat_messages_insert_own_or_admin بتسمح لصاحب الجلسة يدرج أي صف
--      في جلسته بأي علم: رسالة بـ is_admin_reply = true تبان في الصندوق
--      والويدجت كرد من فريق الدعم، و is_bot_reply = true كرد بوت.
--   ② persist_bot_turn و create_ticket_with_message_and_session_update ممنوحين
--      لـ authenticated و anon: أي حد معاه توكن العميل ينادي RPC ويكتب أي نص
--      كرد بوت ومعاه أي bot_state (أو يفتح تذكرة بأي وصف).
--   ③ صاحب الجلسة يقدر يعدّل bot_state بتاعها مباشرة (سياسة التحديث على الصف
--      كله) — حالة التشخيص وتأكيد التذكرة المعلّق في إيده.
--
-- الحل:
--   ① العميل يدرج رسايله هو بس: sender_id = auth.uid()، ومن غير is_admin_reply
--      ولا is_bot_reply. الأدمن المرتفع (has_elevated_authority) زي ما هو.
--   ② الـ RPCين للخادم بس (service_role): sie-api بعميل الخادم، وتيليجرام أصلًا
--      service_role. جسمهم ماتغيرش (بياخدوا المالك من صف الجلسة لـ service_role).
--   ③ حارس: bot_state مايتغيرش من دور anon/authenticated (إنشاء جلسة بالقيمة
--      الافتراضية مسموح). الخادم (service_role) والدوال المالكة (SECURITY
--      DEFINER زي chat_post_notice) يعدّوا.
--
-- مفيش حذف بيانات. قابل لإعادة التشغيل. التراجع:
-- migrations/_rollback/062_chat_message_authority.down.sql (يرجّع السياسة
-- والصلاحيات حرفيًا ويشيل الحارس).
-- ============================================================================

-- ── ① إدراج العميل ─────────────────────────────────────────────────────────
drop policy if exists chat_messages_insert_own_or_admin on public.chat_messages;
create policy chat_messages_insert_own_or_admin on public.chat_messages
  for insert
  with check (
    public.has_elevated_authority()
    or (
      session_id in (select s.id from public.chat_sessions s where s.user_id = auth.uid())
      and sender_id = auth.uid()
      and coalesce(is_admin_reply, false) = false
      and coalesce(is_bot_reply, false) = false
    )
  );

-- ── ② دور البوت للخادم بس ─────────────────────────────────────────────────
revoke execute on function public.persist_bot_turn(uuid, integer, text, jsonb) from public, anon, authenticated;
revoke execute on function public.create_ticket_with_message_and_session_update(uuid, integer, text, jsonb, text, text, text)
  from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.persist_bot_turn(uuid, integer, text, jsonb) to service_role;
    grant execute on function public.create_ticket_with_message_and_session_update(uuid, integer, text, jsonb, text, text, text)
      to service_role;
  end if;
end $$;

-- ── ③ حارس bot_state ───────────────────────────────────────────────────────
-- SECURITY INVOKER عن قصد: current_user هو الدور الحقيقي للي بيكتب. جوه دالة
-- SECURITY DEFINER (chat_post_notice) بيبقى مالك الدالة فيعدّي.
create or replace function public.guard_bot_state()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.bot_state is null or new.bot_state = '{}'::jsonb then return new; end if;
  elsif new.bot_state is not distinct from old.bot_state then
    return new;
  end if;
  raise exception 'حالة المحادثة بتتكتب من الخادم بس'
    using errcode = '42501', hint = 'bot_state is written by SIE (server) and chat_post_notice';
end;
$$;

drop trigger if exists trg_guard_bot_state on public.chat_sessions;
create trigger trg_guard_bot_state
  before insert or update of bot_state on public.chat_sessions
  for each row execute function public.guard_bot_state();

-- ============================================================================
-- التحقق
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['public.persist_bot_turn(uuid, integer, text, jsonb)',
                           'public.create_ticket_with_message_and_session_update(uuid, integer, text, jsonb, text, text, text)'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '062: % لسه متاحة لعميل', f;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role')
       and not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '062: service_role مايقدرش ينادي %', f;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.chat_sessions'::regclass
                  and tgname = 'trg_guard_bot_state' and not tgisinternal) then
    raise exception '062: حارس bot_state ناقص';
  end if;
  if position('is_bot_reply' in (select pg_get_expr(polwithcheck, polrelid) from pg_policy
       where polrelid = 'public.chat_messages'::regclass and polname = 'chat_messages_insert_own_or_admin')) = 0 then
    raise exception '062: سياسة إدراج الرسايل مااتشدّدتش';
  end if;
  raise notice '062: رد البوت ورد الدعم من الخادم بس';
end $$;
