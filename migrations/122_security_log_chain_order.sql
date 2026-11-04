-- ============================================================================
-- 122 — ترتيب سلسلة سجل الأمان تحت القفل (إصلاح 121)
--
-- المشكلة: id في security_events يأخذه الصف من قيمته الافتراضية (identity) **قبل** المحفّز، والمحفّز
-- يأخذ القفل ثم يربط الصف بصاحب أكبر id. إضافتان متزامنتان قد تأخذان رقميهما بترتيب وتصلان إلى القفل
-- بالترتيب المعاكس، فيُربط الأقدم رقمًا بالأحدث وتتفرع السلسلة، وowner_verify_security_log() (تمشي بترتيب id)
-- تبلّغ عن عبث لم يحدث.
--
-- الإصلاح: المحفّز يأخذ رقم الصف من التسلسل نفسه **بعد** القفل. القفل يبقى حتى نهاية المعاملة، فلا يأخذ
-- صفٌّ رقمه قبل أن يُثبَّت الصف السابق: ترتيب id هو ترتيب الربط. الرقم الافتراضي يُهمل (فجوات في الأرقام فقط).
-- لا تغيير في الجدول ولا في صيغة البصمة ولا في التحقق؛ الصفوف القائمة كما هي.
--
-- المتطلبات: 121. التراجع: _rollback/122_security_log_chain_order.down.sql
-- ============================================================================

do $$
begin
  if to_regprocedure('public.guard_security_events()') is null or to_regclass('public.security_events') is null then
    raise exception '122 يتطلب 121';
  end if;
end $$;

create or replace function public.guard_security_events()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'سجل الأمان لا يُعدَّل ولا يُحذف' using errcode = '42501';
  end if;
  -- ترتيب السلسلة: إضافة واحدة في كل لحظة، ورقم الصف يُؤخذ تحت القفل (122)
  perform pg_advisory_xact_lock(hashtext('public.security_events'));
  new.id := nextval(pg_get_serial_sequence('public.security_events', 'id'));
  new.at := clock_timestamp();
  if new.source is null or new.source not in ('db', 'edge', 'client_report') then
    new.source := 'db';
  end if;
  new.details := coalesce(new.details, '{}'::jsonb);
  select e.hash into new.prev_hash from public.security_events e order by e.id desc limit 1;
  new.hash := public._security_event_hash(new);
  return new;
end;
$$;
revoke all on function public.guard_security_events() from public, anon, authenticated;
