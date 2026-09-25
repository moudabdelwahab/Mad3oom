-- ============================================================================
-- 057_inbox_owner_admin_context.sql
--   صندوق الرسائل: مالك المنصة في سياق «الإدارة» يشرف على الصندوق.
--
-- ════════════════════════════════════════════════════════════════════════════
-- المشكلة (بلاغ من الإنتاج، 2026-09-25)
-- ════════════════════════════════════════════════════════════════════════════
--   المالك دخل لوحة الإدارة (سياق 'admin') وحاول يرد في محادثة: 403 من
--   inbox_add_note / inbox_send_reply — «مش مسموحلك توصل للمحادثة دي».
--
--   السبب: 055 ربط الإشراف (رؤية كل المحادثات والتصرف فيها) بـ
--   has_elevated_authority()، وهي للمالك = owner_capability('owner_only')،
--   أي سياق 'owner' وحده. في سياق 'admin' المالك طاقم عادي
--   (is_platform_staff = true) فيرى المسند له فقط — وصفر مسند له. والقايمة
--   كانت بتعرض محادثاته هو كعميل (سياسة «جلساتي» القائمة)، فكل ضغطة ترجع 403.
--
--   السياق 'admin' موصوف في الواجهة بأنه «التشغيل اليومي»، والرد على العملاء
--   تشغيل يومي. والأدمن المرتفع (elevated_admin) يشرف على الصندوق بلا أي
--   سياق — فالمالك وهو يعمل كأدمن لا ينبغي أن يملك أقل منه.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الإصلاح — داخل الصندوق وحده
-- ════════════════════════════════════════════════════════════════════════════
--   _inbox_is_supervisor() = has_elevated_authority() أو owner_capability('admin')
--     • owner_capability('admin') صحيحة للمالك في سياق 'owner' أو 'admin' فقط
--       (context_allows)، وخاطئة في 'customer' و 'company_admin' ومعاينة
--       عضو الشركة، وبلا سياق سارٍ. لا تُمنح لغير المالك أبدًا.
--     • تحل محل has_elevated_authority() في الأماكن الخمسة اللي بتقرر الإشراف
--       في 055/056: inbox_is_agent، inbox_can_access، سحب ملاحظة زميل، إدارة
--       الفرق، حذف رد زميل.
--
--   inbox_my_access(): الواجهة تسأل الخادم عن إشراف **الجلسة الحالية** بدل ما
--   تستنتجه من صفوف platform_authority (اللي بتتجاهل السياق) — فمبقتش تعرض
--   أزرار مشرف لمستخدم القاعدة هترفضه.
--
-- ما لا يفعله
--   • لا يغيّر has_elevated_authority ولا owner_capability ولا context_allows
--     ولا أي سياسة خارج الصندوق — التذاكر والاشتراكات وغيرها كما هي.
--   • لا يغيّر سياسات chat_sessions/chat_messages: الرؤية الإضافية تأتي من
--     inbox_assigned_select القائمة (055) لأنها تسأل inbox_can_access.
--   • لا يلمس SIE ولا الويدجت.
--
-- التراجع: آخر الملف.
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regprocedure('public.inbox_edit_message(uuid, text)') is null then
    raise exception '057 يتطلب 056_inbox_attachments_reactions_edits';
  end if;
  if to_regprocedure('public.owner_capability(text)') is null
     or to_regprocedure('public.has_elevated_authority()') is null then
    raise exception '057 يتطلب owner_capability و has_elevated_authority (040/053)';
  end if;
end $$;


-- ============================================================================
-- 1) قرار الإشراف — مصدر واحد
-- ============================================================================
create or replace function public._inbox_is_supervisor()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.has_elevated_authority() or public.owner_capability('admin');
$$;
revoke all on function public._inbox_is_supervisor() from public, anon, authenticated;

comment on function public._inbox_is_supervisor() is
  'مشرف الصندوق: الأدمن المرتفع، أو المالك في سياق owner/admin. يرى كل المحادثات ويدير الفرق ويسحب/يحذف لزملائه.';


-- ============================================================================
-- 2) الأماكن الخمسة (نفس تعريفات 055/056 حرفيًا، إلا سطر الإشراف)
-- ============================================================================
-- inbox_is_agent: نفس النتيجة (المالك في admin طاقم أصلًا)، لكن الإشراف له
-- مصدر واحد — tests/sql/inbox-owner-context.test.sql (PASS 5) يفرض ده.
create or replace function public.inbox_is_agent()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.account_is_active()
     and (public.is_platform_staff() or public._inbox_is_supervisor());
$$;

create or replace function public.inbox_can_access(p_session uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_session is not null and (
       public._inbox_is_supervisor()
    or (public.is_platform_staff()
        and not public.preview_mode()
        and public._inbox_is_assigned(auth.uid(), p_session)));
$$;

comment on function public.inbox_can_access(uuid) is
  'D1=C: المشرف (الأدمن المرتفع، أو المالك في سياق owner/admin — 057) يرى كل المحادثات، وطاقم المنصة يرى المسندة له أو لفريقه فقط.';

create or replace function public.inbox_delete_note(p_note uuid)
returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_note public.inbox_notes;
begin
  select * into v_note from public.inbox_notes where id = p_note for update;
  if v_note.id is null then
    raise exception 'الملاحظة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_note.session_id);
  if v_note.author_id is distinct from auth.uid() and not public._inbox_is_supervisor() then
    raise exception 'مينفعش تسحب ملاحظة حد تاني' using errcode = '42501';
  end if;
  if v_note.deleted_at is not null then return; end if;

  update public.inbox_notes set body = '', deleted_at = now() where id = p_note;
  perform public._inbox_log(v_note.session_id, 'note_deleted', jsonb_build_object('note_id', p_note));
end;
$$;

create or replace function public._inbox_require_manager()
returns void language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not (public.account_is_active() and public._inbox_is_supervisor()) then
    raise exception 'إدارة الفرق لمشرفي الصندوق فقط' using errcode = '42501';
  end if;
end;
$$;

create or replace function public._inbox_own_reply(p_message uuid, p_allow_elevated boolean)
returns public.chat_messages
language plpgsql security definer set search_path to 'public' as $$
declare v public.chat_messages;
begin
  select * into v from public.chat_messages where id = p_message for update;
  if v.id is null then
    raise exception 'الرسالة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v.session_id);
  -- رسائل العميل والبوت و SIE سجل المحادثة وأثر التشخيص — لا تُلمس.
  if not coalesce(v.is_admin_reply, false) then
    raise exception 'التعديل والحذف لردود الدعم بس' using errcode = '42501';
  end if;
  if v.sender_id is distinct from auth.uid()
     and not (p_allow_elevated and public._inbox_is_supervisor()) then
    raise exception 'مينفعش تعدّل أو تحذف رد حد تاني' using errcode = '42501';
  end if;
  if v.deleted_at is not null then
    raise exception 'الرسالة دي اتحذفت' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- create or replace يُبقي الصلاحيات، لكن نثبّتها صراحة لأن الدوال الداخلية
-- يجب ألا تُكشف أبدًا.
revoke all on function public._inbox_require_manager() from public, anon, authenticated;
revoke all on function public._inbox_own_reply(uuid, boolean) from public, anon, authenticated;


-- ============================================================================
-- 3) الواجهة تسأل عن إشراف الجلسة الحالية
-- ============================================================================
create or replace function public.inbox_my_access()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'agent', public.inbox_is_agent(),
    'supervisor', public.inbox_is_agent() and public._inbox_is_supervisor());
$$;
revoke all on function public.inbox_my_access() from public, anon;
grant execute on function public.inbox_my_access() to authenticated;


-- ============================================================================
-- 4) تحقق
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['public._inbox_is_supervisor()', 'public._inbox_require_manager()',
                           'public._inbox_own_reply(uuid, boolean)'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '057: دالة داخلية مكشوفة: %', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.inbox_my_access()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.inbox_my_access()', 'EXECUTE') then
    raise exception '057: صلاحيات inbox_my_access خاطئة';
  end if;
  -- لا أثر باقٍ لـ has_elevated_authority في قرارات الإشراف.
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('inbox_is_agent', 'inbox_can_access', 'inbox_delete_note',
                                  '_inbox_require_manager', '_inbox_own_reply')
                and pg_get_functiondef(p.oid) like '%has_elevated_authority%') then
    raise exception '057: قرار إشراف ما زال يسأل has_elevated_authority مباشرة';
  end if;
  raise notice '057: المالك في سياق الإدارة مشرف على الصندوق';
end $$;

-- ============================================================================
-- التراجع:
--   أعد تعريف inbox_is_agent و inbox_can_access و inbox_delete_note و
--   _inbox_require_manager كما في 055 و _inbox_own_reply كما في 056 (القسم 6) — أي بـ
--   has_elevated_authority() مكان _inbox_is_supervisor() — ثم:
--   drop function if exists public.inbox_my_access(), public._inbox_is_supervisor();
--   (الواجهة تتعامل مع غياب inbox_my_access بالرجوع لسلوك ما قبل 057.)
-- ============================================================================
