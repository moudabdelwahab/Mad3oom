-- ============================================================================
-- 060_inbox_handoff_close_lock — التسليم والإقفال مايتداخلوش
--
-- المشكلة (مراجعة 059): inbox_take_over / inbox_return_to_ai كانوا بيقروا
-- status من غير قفل، وبعدين _handoff_set ياخد قفل الصف. inbox_close لو
-- اتكمّل بين الخطوتين، «رجّع للبوت» كان يرجّع محادثة اتقفلت للتو للبوت،
-- وحارس رد البوت بيبص على is_manual_mode بس.
--
-- الحل: القفل قبل الفحص. نفس القفل (FOR UPDATE على صف الجلسة) اللي
-- _handoff_set بياخده بعدها في نفس المعاملة، فمفيش قفل جديد ولا ترتيب
-- أقفال جديد: الإقفال والتسليم على نفس المحادثة بيتسلسلوا، واللي ييجي
-- تاني يشوف نتيجة الأول.
--
-- باقي السلوك زي 059 حرفيًا. قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/060_inbox_handoff_close_lock.down.sql
-- ============================================================================

create or replace function public.inbox_take_over(p_session uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_status text;
begin
  perform public._inbox_require(p_session);
  select s.status into v_status from public.chat_sessions s where s.id = p_session for update;
  if v_status = 'closed' then
    raise exception 'المحادثة مقفولة' using errcode = '22023';
  end if;
  return public._handoff_set(p_session, true, coalesce(nullif(btrim(p_reason), ''), 'manual_takeover'), 'inbox', auth.uid());
end;
$$;

create or replace function public.inbox_return_to_ai(p_session uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_status text;
begin
  perform public._inbox_require(p_session);
  select s.status into v_status from public.chat_sessions s where s.id = p_session for update;
  if v_status = 'closed' then
    raise exception 'المحادثة مقفولة — مفيش حد يرد عليه البوت' using errcode = '22023';
  end if;
  return public._handoff_set(p_session, false, coalesce(nullif(btrim(p_reason), ''), 'returned_by_agent'), 'inbox', auth.uid());
end;
$$;

-- create or replace بيحافظ على الصلاحيات، والتأكيد هنا للأمان.
do $$
declare f text;
begin
  foreach f in array array['public.inbox_take_over(uuid, text)',
                           'public.inbox_return_to_ai(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- التحقق
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['public.inbox_take_over(uuid, text)',
                           'public.inbox_return_to_ai(uuid, text)'] loop
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '060: anon يقدر ينادي %', f;
    end if;
    if position('for update' in (select prosrc from pg_proc where oid = f::regprocedure)) = 0 then
      raise exception '060: % مش بياخد قفل الصف قبل فحص الإقفال', f;
    end if;
  end loop;
  raise notice '060: التسليم والإقفال بيتسلسلوا';
end $$;
