-- ============================================================================
-- التراجع عن 142_cancel_refund
--   يحذف دوال التعويض وجدول طلبات التعويض، ويعيد resume_my_subscription
--   إلى نص 136 حرفيًا، ويحذف علامة هدية الـ14 يومًا.
--   ما لا يسترجعه هذا الملف وحده (موثّق عمدًا):
--   • طلبات التعويض نفسها تُحذف مع الجدول (لا نسخة احتياطية هنا) —
--     صدّرها أولًا إن احتجتها.
--   • إلغاء نهاية المدة الذي تمّ عند طلب التعويض يبقى كما هو (علَم
--     cancel_at_period_end من 136): التراجع لا يعيد الاشتراك ولا يلغي
--     الإلغاء — التراجع عنه من لوحة الشركة (resume_my_subscription).
--   • التذاكر المفتوحة للتعويض تبقى تذاكر عادية مفتوحة (بلا رابط طلب
--     بعد حذف الجدول) — أغلقها من لوحة التذاكر إن لزم.
--   • الإشعارات المرسلة تبقى في جدول notifications — سجلّ لا يُمسح.
--   • سجل التدقيق (subscription_audit_log / privileged_audit) يبقى.
--   • تمديد الـ14 يومًا الممنوح عند تراجع سابق يبقى في end_date —
--     التراجع لا يسحب الهدية ولا يعيد العلامة.
-- ============================================================================

-- الدوال أولًا (قبل الجدول الذي تشير إليه أجسامها)، ثم الجدول (قبل
-- مسنَدَي أيام العمل اللذين يشير إليهما افتراضي الجدول)، ثم العلامة،
-- ثم استعادة نص 136 للتراجع.
drop function if exists public.owner_mark_refund_paid(uuid, text, numeric);
drop function if exists public.owner_open_refund_ticket(uuid);
drop function if exists public.owner_decide_refund(uuid, text, text);
drop function if exists public.owner_list_refund_requests(text);
drop function if exists public.submit_refund_transfer_details(uuid, text, text);
drop function if exists public.my_refund_requests();
drop function if exists public.request_cancel_refund(uuid, text);
drop function if exists public.refund_quote(uuid);
drop function if exists public._notify_platform_owners(text, text, text, text, uuid);
drop function if exists public._refund_request_json(uuid, boolean);
drop function if exists public._refund_amount_paid(public.whatsapp_subscriptions);
drop function if exists public._refund_is_new_subscription(public.whatsapp_subscriptions);
drop function if exists public._refund_ticket_usage_limit(text);
drop function if exists public._refund_ticket_allowance(text);
drop function if exists public._refund_ticket_usage(uuid, timestamptz);
drop function if exists public._refund_sie_usage(uuid, timestamptz);
drop function if exists public.resume_my_subscription(uuid);

drop table if exists public.refund_requests;

drop function if exists public._refund_add_business_days(timestamptz, int);
drop function if exists public._refund_add_business_hours(timestamptz, int);

alter table public.whatsapp_subscriptions
  drop column if exists refund_gift_granted_for_start;

-- استعادة نص 136 حرفيًا لـ resume_my_subscription (بلا إضافتي 142).
create or replace function public.resume_my_subscription(p_subscription_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_sub public.whatsapp_subscriptions%rowtype;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  select * into v_sub from public.whatsapp_subscriptions
   where id = p_subscription_id for update;

  if v_sub.id is null then
    raise exception 'الاشتراك غير موجود' using errcode = 'P0002';
  end if;

  if v_sub.user_id is distinct from v_uid
     and not exists (select 1 from public.companies c
                      where c.id = v_sub.company_id and c.user_id = v_uid) then
    raise exception 'هذا الاشتراك لا يخص حسابك' using errcode = '42501';
  end if;

  if not v_sub.cancel_at_period_end then
    raise exception 'هذا الاشتراك غير ملغى أصلًا' using errcode = '42501';
  end if;

  if v_sub.status <> 'active' or v_sub.end_date <= now() then
    raise exception 'انتهت مدة الاشتراك بالفعل فلا يمكن التراجع عن إلغائه.'
      using errcode = '42501';
  end if;

  update public.whatsapp_subscriptions
     set cancel_at_period_end = false,
         cancelled_at = null,
         cancel_reason = null,
         updated_at = now()
   where id = v_sub.id;

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email,
    action, old_values, new_values, reason
  ) values (
    v_sub.id, v_sub.user_id, v_uid,
    (select email from public.profiles where id = v_uid),
    'cancel_revoked',
    jsonb_build_object('cancel_at_period_end', true, 'status', 'active'),
    jsonb_build_object('cancel_at_period_end', false, 'status', 'active',
                       'end_date', v_sub.end_date),
    'تراجع صاحب الاشتراك عن الإلغاء قبل نهاية المدة'
  );

  return jsonb_build_object(
    'subscription_id',      v_sub.id,
    'status',               'active',
    'end_date',             v_sub.end_date,
    'cancel_at_period_end', false
  );
end;
$function$;

comment on function public.resume_my_subscription(uuid) is
  'التراجع عن إلغاء نهاية المدة قبل انتهائها: يمسح العلَم والسبب. مالك الشركة أو صاحب الاشتراك وحدهما.';

revoke all on function public.resume_my_subscription(uuid) from public, anon;
grant execute on function public.resume_my_subscription(uuid) to authenticated;
