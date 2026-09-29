-- ============================================================================
-- تراجع 061_chat_server_notices
--   ⚠️ بعد تراجع 062 وبعد رجوع الواجهة للنسخة القديمة (اللي بتكتب رسايل البوت
--   بنفسها) — الواجهة الجديدة بتنادي chat_post_notice.
--   مابيحذفش أي رسالة اتكتبت من خلالها.
-- ============================================================================
drop function if exists public.chat_post_notice(uuid, text, integer);

do $$
begin
  if to_regprocedure('public.chat_post_notice(uuid, text, integer)') is not null then
    raise exception 'تراجع 061: chat_post_notice لسه موجودة';
  end if;
  raise notice 'تراجع 061: تم';
end $$;
