-- ============================================================================
-- 161_whatsapp_ticket_links.down.sql — تراجع 161.
--
-- يسقط الدالة والجدول والأعمدة، ويعيد enforce_ticket_quota إلى نسخة
-- الإنتاج الحية بلا فرع واتساب (069 + سطر carry 101 — حرفيًا كما في
-- pg_get_functiondef على srnelrdpqkcntbgudyto قبل 161). بيانات
-- التذاكر نفسها لا تُحذف: التذاكر التي أنشأتها عقدة واتساب تبقى،
-- لكن source/source_ref يُسقطان فتفقد علامة مصدرها؛ وصفوف الربط
-- تُحذف مع الجدول. للطوارئ فقط.
-- ============================================================================

begin;

drop function if exists public.wa_create_ticket_from_flow(uuid, text, uuid, timestamptz, text, text, text, text, text);

drop table if exists public.whatsapp_ticket_links;

alter table public.messages drop column if exists ticket_id;

alter table public.tickets drop column if exists source_ref;
alter table public.tickets drop column if exists source;

create or replace function public.enforce_ticket_quota()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status jsonb;
begin
  -- 101: نسخ تذكرة بطلب العميل (carry_tickets) لا يستهلك حصة
  if coalesce(current_setting('app.ticket_carry', true), '') = 'on' then
    return new;
  end if;
  if new.user_id is null
     or public.is_admin()
     or exists (select 1 from public.profiles p
                 where p.id = new.user_id and p.role in ('admin', 'support', 'platform_owner')) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ticket_quota:' || public.ticket_account_owner(new.user_id)::text, 0));

  v_status := public.ticket_quota_status(new.user_id);

  -- 069: تذكرة الفوترة المعفاة = طلب يُنشئه النظام (العلم يضعه
  -- submit_subscription_request/upgrade وحدهما)، أو شحن محفظة واتساب.
  -- تذكرة 'subscription' بلا علم = تذكرة دعم عادية تُفحص من الرصيد.
  if coalesce(new.category, '') = 'whatsapp_wallet_topup'
     or (new.category = 'subscription'
         and coalesce(current_setting('mad3oom.billing_request_ticket', true), '') = 'on') then
    if (v_status->>'billing_used')::int >= (v_status->>'billing_limit')::int then
      raise exception 'وصلت للحد الأقصى من طلبات الاشتراك والفوترة هذا الشهر (% طلبات). لو محتاج مساعدة تواصل مع الدعم عبر المحادثة.',
        v_status->>'billing_limit'
        using errcode = 'P0001', hint = 'billing_quota_exceeded';
    end if;
    return new;
  end if;

  if (v_status->>'unlimited')::boolean is not true
     and (v_status->>'used')::int >= (v_status->>'monthly_limit')::int then
    raise exception 'وصلت للحد الأقصى من التذاكر في %: % تذكرة شهريًا. رقّي خطتك من صفحة الاشتراكات، أو انتظر تجدّد الرصيد أول الشهر.',
      v_status->>'plan_name_ar', v_status->>'monthly_limit'
      using errcode = 'P0001', hint = 'ticket_quota_exceeded';
  end if;
  return new;
end;
$function$;

do $$
begin
  if to_regprocedure('public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)') is not null then
    raise exception 'تراجع 161: الدالة ما زالت موجودة';
  end if;
  if to_regclass('public.whatsapp_ticket_links') is not null then
    raise exception 'تراجع 161: الجدول ما زال موجودًا';
  end if;
  if pg_get_functiondef('public.enforce_ticket_quota()'::regprocedure) like '%whatsapp_flow%' then
    raise exception 'تراجع 161: فرع واتساب ما زال في enforce_ticket_quota()';
  end if;
  raise notice 'OK تراجع 161: الدالة والجدول والأعمدة سقطت، وenforce_ticket_quota عاد لنسخة الإنتاج بلا فرع واتساب';
end $$;

commit;
