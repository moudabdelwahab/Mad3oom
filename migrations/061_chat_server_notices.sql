-- ============================================================================
-- 061_chat_server_notices — رسايل البوت الثابتة بتتكتب من الخادم (Phase 3، الجزء 1)
--
-- المشكلة: الويدجت (chat-widget.js) وشات العميل (assets/js/chat-logic.js)
-- كانوا بيكتبوا رسايل البوت بنفسهم في chat_messages بعلم is_bot_reply:
-- الترحيب، «SIE مش متاح لحسابك»، «SIE واجه مشكلة»، «حصل خطأ»، و«بعتّ رسايل
-- كتير». ولأن سياسة الإدراج بتسمح بأي علم لصاحب الجلسة، أي حد معاه توكن العميل
-- يقدر يكتب أي نص كرد بوت — أو كرد دعم (is_admin_reply). 062 بيقفل ده؛ الملف
-- ده بيجهّز المسار البديل قبلها عشان الواجهة تتنقل عليه الأول.
--
-- chat_post_notice(p_session, p_kind, p_seconds): النص جوه الخادم، مش جاي من
-- المتصفح. المتصفح بيختار «نوع» الرسالة بس:
--   greeting        ترحيب أول محادثة: مرة واحدة بس (قفل الصف + مفيش رسايل
--                   قبله + علم greeted في bot_state). الترحيب من صف إعدادات
--                   شات الموقع العام (bot_settings.phone_number_id IS NULL)
--                   — نفس الصف اللي الويدجت كان بيقراه.
--   sie_unavailable السبب من sie_my_entitlement() نفسها؛ لو العميل عنده وصول
--                   فعلًا مفيش رسالة.
--   sie_error / error / rate_limited  نصوص ثابتة (rate_limited بعدد ثواني 1..3600).
-- قواعد مشتركة: صاحب الجلسة بس، المحادثة مش مقفولة، ومش مع فريق الدعم (البوت
-- مايتكلمش والإنسان ماسك — نفس روح 059). والرسايل غير الترحيب لازم ترد على
-- آخر رسالة من العميل: رسالة واحدة لكل رسالة عميل، فمفيش إغراق للمحادثة.
--
-- إضافة بس: دالة جديدة. مفيش تغيير في جدول أو سياسة. قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/061_chat_server_notices.down.sql
-- ============================================================================

create or replace function public.chat_post_notice(p_session uuid, p_kind text, p_seconds integer default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owner uuid;
  v_status text;
  v_manual boolean;
  v_state jsonb;
  v_last_customer_at timestamptz;
  v_text text;
  v_welcome text;
  v_ent jsonb;
  v_seconds integer;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('greeting', 'sie_unavailable', 'sie_error', 'error', 'rate_limited') then
    raise exception 'نوع رسالة غير معروف' using errcode = '22023';
  end if;

  -- نفس قفل صف الجلسة اللي بتاخده 059 (_handoff_set وحارس رد البوت): ترحيبين
  -- من تبويبين بيتسلسلوا، والتسليم للإنسان مايتداخلش مع الرسالة.
  select s.user_id, s.status, coalesce(s.is_manual_mode, false), coalesce(s.bot_state, '{}'::jsonb)
    into v_owner, v_status, v_manual, v_state
    from public.chat_sessions s where s.id = p_session for update;
  if not found or auth.uid() is null or v_owner is distinct from auth.uid() then
    raise exception 'مش مسموحلك تكتب في المحادثة دي' using errcode = '42501';
  end if;
  if v_status = 'closed' or v_manual then
    return null;
  end if;

  if p_kind = 'greeting' then
    if coalesce((v_state->>'greeted')::boolean, false)
       or exists (select 1 from public.chat_messages m where m.session_id = p_session) then
      return null;
    end if;
    select b.welcome_message into v_welcome
      from public.bot_settings b where b.phone_number_id is null
     order by b.updated_at desc nulls last limit 1;
    v_text := coalesce(nullif(btrim(v_welcome), ''), 'أهلاً بيك في منصة مدعوم! 👋')
              || E'\nاختار من الاختيارات دي 👇 أو اكتبلي طلبك بحريتك:';
    update public.chat_sessions
       set bot_state = v_state || jsonb_build_object('greeted', true)
     where id = p_session;
  else
    -- رسالة واحدة ترد على آخر رسالة من العميل: لازم يكون فيه رسالة عميل، ومفيش
    -- أي رسالة من غيره (بوت/دعم/غيره) في نفس لحظتها أو بعدها. «>=» مقصودة:
    -- التعادل في created_at (نفس المعاملة) بيرفض بدل ما يعتمد على ترتيب عشوائي.
    select max(m.created_at) into v_last_customer_at
      from public.chat_messages m
     where m.session_id = p_session and m.sender_id = v_owner;
    if v_last_customer_at is null or exists (
         select 1 from public.chat_messages m
          where m.session_id = p_session
            and m.sender_id is distinct from v_owner
            and m.created_at >= v_last_customer_at) then
      return null;
    end if;

    if p_kind = 'sie_unavailable' then
      begin
        v_ent := public.sie_my_entitlement();
      exception when others then
        v_ent := null;
      end;
      if coalesce((v_ent->>'has_access')::boolean, false) then
        return null;
      end if;
      v_text := case v_ent->>'reason'
          when 'disabled' then 'تم إيقاف محرك الدعم الذكي (SIE) لحسابك.'
          when 'expired' then 'انتهت صلاحية استخدامك لمحرك الدعم الذكي (SIE).'
          when 'quota_exceeded' then 'استهلكت كل رسائل محرك الدعم الذكي (SIE) المتاحة لحسابك.'
          when 'edition_monthly_limit' then 'وصلت لحد رسائل الشهر في خطتك الحالية.'
          else 'محرك الدعم الذكي (SIE) غير متاح لحسابك حاليًا.'
        end || ' رسالتك وصلت لفريق الدعم وهيرد عليك هنا في أقرب وقت.';
    elsif p_kind = 'sie_error' then
      v_text := 'محرك الدعم الذكي (SIE) واجه مشكلة مؤقتة في الرد على رسالتك. جرّب تبعتها تاني، ورسالتك وصلت لفريق الدعم كمان.';
    elsif p_kind = 'error' then
      v_text := 'عذراً، حدث خطأ بسيط أثناء معالجة طلبك. رسالتك وصلت لفريق الدعم وهيرد عليك هنا.';
    else -- rate_limited
      v_seconds := least(greatest(coalesce(p_seconds, 1), 1), 3600);
      v_text := E'بعتّ رسايل كتير في وقت قصير، فمحتاج أهدّي شوية [[icon:note]]\n'
                || 'استنى ' || v_seconds || ' ثانية وابعت تاني — رسالتك مش هتضيع.';
    end if;
  end if;

  insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply, is_bot_reply)
  values (p_session, null, v_text, false, true)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.chat_post_notice(uuid, text, integer) from public, anon;
grant execute on function public.chat_post_notice(uuid, text, integer) to authenticated;

-- ============================================================================
-- التحقق
-- ============================================================================
do $$
begin
  if to_regprocedure('public.chat_post_notice(uuid, text, integer)') is null then
    raise exception '061: chat_post_notice ناقصة';
  end if;
  if has_function_privilege('anon', 'public.chat_post_notice(uuid, text, integer)', 'EXECUTE') then
    raise exception '061: anon يقدر ينادي chat_post_notice';
  end if;
  raise notice '061: رسايل البوت الثابتة ليها مسار خادم';
end $$;
