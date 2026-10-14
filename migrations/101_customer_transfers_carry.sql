-- ============================================================================
-- 101_customer_transfers_carry.sql
--   H2 — نقل العميل بين الشركات، ونسخ تذاكره المختارة، وطلب الوصول التاريخي.
--
-- القرارات: السؤال 5 (النقل بموافقة مديري الشركتين وتأكيد العميل؛ للمالك نقل استثنائي بتحقق خطوتين
--   وسبب مسجَّل؛ ذري وغير قابل للتكرار)، والسؤال 6 و7 (العميل يختار ما يُنسخ؛ لا شيء يُنقل تلقائيًا؛
--   المنسوخ تذكرة جديدة في الوجهة بمحتوى العميل المسموح وحده؛ الوصول التاريخي بطلب يوافق عليه المالك).
--   القيم الافتراضية الآمنة: 2 (عضوية المصدر تبقى إضافية فقط باختيار العميل وإذن المصدر)، 3 (ردود موظفي
--   المصدر لا تُنسخ)، 4 (المصدر يُبلَّغ بلا كشف الوجهة)، 5 (الوصول التاريخي معلّق حتى موافقة العميل).
--
-- عمليات منفصلة (لا تختلط):
--   إضافة عضوية / إنهاؤها           096 (دعوة، مغادرة، إزالة)
--   تغيير الشركة الأساسية           customer_transfers  (هنا)
--   نسخ تذاكر مختارة                 ticket_carries      (هنا) — النسخ الأصلية تبقى في المصدر
--   الاطلاع على تاريخ في المصدر      historical_access_requests (هنا) — بموافقة العميل ثم المالك
--
-- لا فوترة مزدوجة: التذكرة المنسوخة لا تُحسب في الحصة الحية ولا في سجل الاستهلاك (counter = none).
--
-- المفاتيح (مطفأة): customer_transfers_enabled، ticket_carry_enabled، historical_access_enabled.
-- مع customer_transfers_enabled مفعّلًا: تغيير super_user_id الخام بين شركتين مرفوض — النقل بمساره وحده.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/101_customer_transfers_carry.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._feature_on(text)', 'public._membership_apply_mirror(uuid)', 'public._membership_event(uuid,uuid,text,jsonb)',
    'public._company_customer_active(uuid,uuid)', 'public._company_member_active(uuid,uuid)', 'public.company_staff_role()',
    'public.current_company_id()', 'public.owner_critical_ok()', 'public._reason_check(text)',
    'public.ticket_quota_status(uuid)', 'public.enforce_ticket_quota()', 'public._usage_record_ticket(public.tickets,text)',
    'public.usage_reconciliation(date)', 'public._attachment_reply_public(uuid)'] loop
    if to_regprocedure(f) is null then
      raise exception '101 يتطلب % (100 وما قبله)', f;
    end if;
  end loop;
end $$;

insert into public.platform_feature_switches (key, enabled, description) values
  ('customer_transfers_enabled', false, 'نقل الشركة الأساسية للعميل بموافقات (101). مفعّلًا: يُرفض تغيير super_user_id الخام بين شركتين.'),
  ('ticket_carry_enabled', false, 'نسخ تذاكر يختارها العميل من شركة إلى أخرى بمحتواه وحده (101).'),
  ('historical_access_enabled', false, 'اطلاع شركة على تذاكر عميل قديمة في شركة أخرى بموافقة العميل ثم المالك (101).')
on conflict (key) do nothing;

-- أحداث العضوية (096) تقبل أنواع النقل الثلاثة. السجل إلحاقي، فالقيد يتسع ولا يضيق.
alter table public.company_membership_events drop constraint if exists company_membership_events_action_check;
alter table public.company_membership_events add constraint company_membership_events_action_check
  check (action in ('joined', 'ended', 'primary_set', 'primary_unset',
                    'invited', 'invitation_accepted', 'invitation_declined',
                    'invitation_cancelled', 'context_set',
                    'transfer_requested', 'transferred_out', 'transferred_in'));

-- أداة ترقيع مؤقتة: تستبدل مقطعًا واحدًا بالضبط في تعريف دالة قائمة، وتفشل إن لم تجده.
create or replace function pg_temp._patch_function(p_fn regprocedure, p_old text, p_new text)
returns void
language plpgsql
as $$
declare
  v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_new in v_def) > 0 then
    return;  -- مطبَّق (إعادة تشغيل)
  end if;
  if (length(v_def) - length(replace(v_def, p_old, ''))) / greatest(length(p_old), 1) <> 1 then
    raise exception '101: المقطع المتوقع غير موجود مرة واحدة في % — راجع الترحيل', p_fn;
  end if;
  execute replace(v_def, p_old, p_new);
end $$;


-- ============================================================================
-- 1) نقل الشركة الأساسية
-- ============================================================================
create table if not exists public.customer_transfers (
  id                     uuid primary key default gen_random_uuid(),
  -- بلا مفتاح خارجي إلى الحساب عمدًا (كسجلات 086 و096): حذف الحساب لا يتعطل، والسجل يبقى بمعرّفات فقط
  customer_id            uuid not null,
  -- بلا مفاتيح خارجية إلى الشركات أيضًا: حذف حساب مالك الشركة (ومعه شركته) لا يتعطل بسجل نقل
  from_company           uuid not null,
  to_company             uuid not null,
  initiated_by           uuid not null,
  initiated_as           text not null check (initiated_as in ('customer', 'owner')),
  idempotency_key        uuid not null,
  status                 text not null default 'pending' check (status in ('pending', 'completed', 'rejected', 'cancelled', 'expired')),
  keep_source_secondary  boolean not null default false,
  customer_confirmed_at  timestamptz,
  source_decision        text check (source_decision in ('approved', 'rejected')),
  source_allows_secondary boolean,
  source_decided_by      uuid,
  source_decided_at      timestamptz,
  dest_decision          text check (dest_decision in ('approved', 'rejected')),
  dest_decided_by        uuid,
  dest_decided_at        timestamptz,
  owner_reason           text,
  created_at             timestamptz not null default now(),
  expires_at             timestamptz not null default now() + interval '14 days',
  completed_at           timestamptz,
  outcome                jsonb,
  constraint customer_transfers_distinct check (from_company <> to_company),
  unique (initiated_by, idempotency_key)
);
-- طلب نقل معلّق واحد لكل عميل: يمنع سباق نقلين متزامنين
create unique index if not exists customer_transfers_one_pending on public.customer_transfers (customer_id) where status = 'pending';

create or replace function public._transfers_require_enabled()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._feature_on('customer_transfers_enabled') then
    raise exception 'نقل العملاء بين الشركات غير مفعّل' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  -- بلا العزل وصلاحيات 098 يرى مالك الوجهة تذاكر العميل القديمة عبر super_user_id بعد النقل: لا نقل قبلهما
  if not (public._feature_on('company_isolation_enforced') and public._feature_on('company_permissions_enabled')) then
    raise exception 'النقل يتطلب تفعيل عزل الشركات وصلاحيات الفريق أولًا' using errcode = '0A000',
      detail = '{"code":"prerequisite_not_enabled"}';
  end if;
end $$;

-- التنفيذ الذري: يُنادى بعد اكتمال الموافقات (أو استثنائيًا من المالك). القفل على حساب العميل
-- يمنع أي تغيير متزامن في عضوياته (القبول والمغادرة يقفلانه أيضًا).
create or replace function public._transfer_execute(p_transfer uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  x public.customer_transfers;
  v_src uuid;
  v_dst uuid;
  v_keep boolean;
begin
  select * into x from public.customer_transfers where id = p_transfer for update;
  perform 1 from public.profiles where id = x.customer_id for update;
  select id into v_src from public.company_memberships
   where user_id = x.customer_id and company_id = x.from_company and status = 'active' and is_primary for update;
  if v_src is null or not public._company_customer_active(x.from_company, x.customer_id) then
    update public.customer_transfers set status = 'cancelled', outcome = jsonb_build_object('reason', 'source_changed') where id = x.id;
    return jsonb_build_object('transfer_id', x.id, 'status', 'cancelled', 'reason', 'source_changed');
  end if;
  select id into v_dst from public.company_memberships
   where user_id = x.customer_id and company_id = x.to_company and status = 'active' for update;
  if v_dst is null then
    if x.initiated_as <> 'owner' then
      update public.customer_transfers set status = 'cancelled', outcome = jsonb_build_object('reason', 'destination_changed') where id = x.id;
      return jsonb_build_object('transfer_id', x.id, 'status', 'cancelled', 'reason', 'destination_changed');
    end if;
    insert into public.company_memberships (company_id, user_id, is_primary, joined_via)
    values (x.to_company, x.customer_id, false, 'transfer') returning id into v_dst;
    perform public._membership_event(x.to_company, x.customer_id, 'joined', jsonb_build_object('via', 'transfer', 'transfer_id', x.id));
  end if;

  -- القيمة الافتراضية 2: المصدر يبقى إضافية فقط باختيار العميل وإذن المصدر (أو قرار المالك الاستثنائي)
  v_keep := x.keep_source_secondary and (x.initiated_as = 'owner' or coalesce(x.source_allows_secondary, false));
  if v_keep then
    update public.company_memberships set is_primary = false where id = v_src;
  else
    perform public._membership_end(v_src, 'transferred');
  end if;
  update public.company_memberships set is_primary = true where id = v_dst;
  delete from public.customer_company_context where user_id = x.customer_id;
  perform public._membership_apply_mirror(x.customer_id);
  perform public._membership_event(x.from_company, x.customer_id, 'transferred_out',
                                   jsonb_build_object('transfer_id', x.id, 'kept_secondary', v_keep));
  perform public._membership_event(x.to_company, x.customer_id, 'transferred_in', jsonb_build_object('transfer_id', x.id));
  update public.customer_transfers
     set status = 'completed', completed_at = now(),
         outcome = jsonb_build_object('kept_source_secondary', v_keep)
   where id = x.id;
  insert into public.notifications (user_id, title, message, type, category)
  values (x.customer_id, 'اكتمل نقل شركتك الأساسية', 'أصبحت شركتك الأساسية الجديدة فعّالة. تذاكرك السابقة بقيت في شركتها.', 'success', 'account');
  return jsonb_build_object('transfer_id', x.id, 'status', 'completed', 'kept_source_secondary', v_keep);
end $$;

-- العميل يطلب (= تأكيده): الوجهة شركة له فيها عضوية إضافية نشطة (الانضمام نفسه عملية 096 منفصلة).
-- حالة مفاتيح 101 للواجهة وحدها (لا تمنح شيئًا: كل دالة تتحقق من مفتاحها بنفسها).
create or replace function public.h2_features()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'transfers', public._feature_on('customer_transfers_enabled'),
    'carry', public._feature_on('ticket_carry_enabled'),
    'historical', public._feature_on('historical_access_enabled')) end;
$$;

create or replace function public.transfer_request(p_to_company uuid, p_keep_source_secondary boolean, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_from uuid;
  x public.customer_transfers;
begin
  perform public._transfers_require_enabled();
  if v_uid is null or not coalesce(public.account_is_active(), false) or coalesce(public.preview_mode(), true) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'مفتاح منع التكرار مطلوب' using errcode = '22023';
  end if;
  select * into x from public.customer_transfers where initiated_by = v_uid and idempotency_key = p_idempotency_key;
  if x.id is not null then
    return jsonb_build_object('transfer_id', x.id, 'status', x.status, 'replayed', true);
  end if;
  perform 1 from public.profiles where id = v_uid for update;
  -- طلب منتهي المهلة لا يحجز مكان الطلب المعلّق الوحيد
  update public.customer_transfers set status = 'expired' where customer_id = v_uid and status = 'pending' and expires_at <= now();
  select company_id into v_from from public.company_memberships where user_id = v_uid and status = 'active' and is_primary;
  if v_from is null or not public._company_customer_active(v_from, v_uid) then
    raise exception 'لا شركة أساسية لك كعميل — استخدم تعيين الأساسية' using errcode = '55000';
  end if;
  if p_to_company is null or p_to_company = v_from or not public._company_customer_active(p_to_company, v_uid) then
    raise exception 'لا عضوية نشطة لك في شركة الوجهة' using errcode = 'P0002';
  end if;
  insert into public.customer_transfers (customer_id, from_company, to_company, initiated_by, initiated_as, idempotency_key,
                                         keep_source_secondary, customer_confirmed_at)
  values (v_uid, v_from, p_to_company, v_uid, 'customer', p_idempotency_key, coalesce(p_keep_source_secondary, false), now())
  returning * into x;
  perform public._membership_event(v_from, v_uid, 'transfer_requested', jsonb_build_object('transfer_id', x.id));
  -- إشعار المديرين: المصدر لا يعرف هوية الوجهة (القيمة 4)، والوجهة لا تعرف المصدر
  insert into public.notifications (user_id, title, message, type, category)
  select c.user_id, 'طلب نقل عميل', case when c.id = v_from then 'عميل لديك طلب نقل شركته الأساسية إلى شركة أخرى — بانتظار قرارك.'
                                          else 'عميل لديك طلب جعل شركتك أساسية له — بانتظار قرارك.' end, 'info', 'account'
    from public.companies c where c.id in (v_from, p_to_company);
  return jsonb_build_object('transfer_id', x.id, 'status', 'pending');
exception when unique_violation then
  raise exception 'لديك طلب نقل معلّق' using errcode = '23505';
end $$;

-- قرار مدير شركة (المصدر أو الوجهة، بحسب شركته الحالية). اكتمال الموافقتين ⇒ تنفيذ ذري فورًا.
create or replace function public.transfer_decide(p_transfer uuid, p_approve boolean, p_allow_secondary boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  x public.customer_transfers;
  v_company uuid;
  v_side text;
begin
  perform public._transfers_require_enabled();
  if public.company_staff_role() is distinct from 'admin' then
    raise exception 'القرار لمدير الشركة' using errcode = '42501';
  end if;
  v_company := public.current_company_id();
  select * into x from public.customer_transfers where id = p_transfer for update;
  v_side := case when x.from_company = v_company then 'source' when x.to_company = v_company then 'destination' end;
  if x.id is null or v_side is null or x.status <> 'pending' then
    raise exception 'الطلب غير موجود أو لم يعد معلّقًا' using errcode = 'P0002';
  end if;
  if x.expires_at <= now() then
    update public.customer_transfers set status = 'expired' where id = x.id;
    return jsonb_build_object('transfer_id', x.id, 'status', 'expired');
  end if;
  if p_approve is null then
    raise exception 'القرار مطلوب' using errcode = '22023';
  end if;
  if v_side = 'source' then
    if x.source_decision is not null then raise exception 'سبق قرار المصدر' using errcode = '55000'; end if;
    update public.customer_transfers
       set source_decision = case when p_approve then 'approved' else 'rejected' end, source_decided_by = auth.uid(),
           source_decided_at = now(), source_allows_secondary = coalesce(p_allow_secondary, false)
     where id = x.id;
  else
    if x.dest_decision is not null then raise exception 'سبق قرار الوجهة' using errcode = '55000'; end if;
    update public.customer_transfers
       set dest_decision = case when p_approve then 'approved' else 'rejected' end, dest_decided_by = auth.uid(), dest_decided_at = now()
     where id = x.id;
  end if;
  if not p_approve then
    update public.customer_transfers set status = 'rejected' where id = x.id;
    insert into public.notifications (user_id, title, message, type, category)
    values (x.customer_id, 'لم يكتمل نقل شركتك الأساسية', 'رفضت إحدى الشركتين طلب النقل. لم يتغير شيء.', 'warning', 'account');
    return jsonb_build_object('transfer_id', x.id, 'status', 'rejected');
  end if;
  select * into x from public.customer_transfers where id = x.id;
  if x.source_decision = 'approved' and x.dest_decision = 'approved' and x.customer_confirmed_at is not null then
    return public._transfer_execute(x.id);
  end if;
  return jsonb_build_object('transfer_id', x.id, 'status', 'pending', 'waiting_for',
                            case when x.source_decision is null then 'source' else 'destination' end);
end $$;

create or replace function public.transfer_cancel(p_transfer uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.customer_transfers set status = 'cancelled'
   where id = p_transfer and customer_id = auth.uid() and status = 'pending';
  if not found then
    raise exception 'الطلب غير موجود أو لم يعد معلّقًا' using errcode = 'P0002';
  end if;
  return jsonb_build_object('transfer_id', p_transfer, 'status', 'cancelled');
end $$;

-- نقل استثنائي من المالك: بلا موافقات، بتحقق خطوتين وسبب (≥ 20 حرفًا)، مسجَّل، ذري، غير قابل للتكرار.
create or replace function public.owner_transfer_exceptional(p_customer uuid, p_to_company uuid, p_reason text,
                                                             p_keep_source_secondary boolean, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_from uuid;
  x public.customer_transfers;
  r jsonb;
begin
  perform public._transfers_require_enabled();
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'النقل الاستثنائي لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 20 then
    raise exception 'سبب النقل الاستثنائي مطلوب (20 حرفًا على الأقل)' using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'مفتاح منع التكرار مطلوب' using errcode = '22023';
  end if;
  select * into x from public.customer_transfers where initiated_by = auth.uid() and idempotency_key = p_idempotency_key;
  if x.id is not null then
    return jsonb_build_object('transfer_id', x.id, 'status', x.status, 'replayed', true);
  end if;
  select company_id into v_from from public.company_memberships where user_id = p_customer and status = 'active' and is_primary;
  if v_from is null or p_to_company is null or v_from = p_to_company
     or not exists (select 1 from public.companies where id = p_to_company)
     or exists (select 1 from public.companies where id = p_to_company and user_id = p_customer) then
    raise exception 'العميل أو شركة الوجهة غير صالح للنقل' using errcode = 'P0002';
  end if;
  update public.customer_transfers set status = 'cancelled', outcome = jsonb_build_object('reason', 'owner_exceptional')
   where customer_id = p_customer and status = 'pending';
  insert into public.customer_transfers (customer_id, from_company, to_company, initiated_by, initiated_as, idempotency_key,
                                         keep_source_secondary, owner_reason)
  values (p_customer, v_from, p_to_company, auth.uid(), 'owner', p_idempotency_key, coalesce(p_keep_source_secondary, false),
          btrim(p_reason))
  returning * into x;
  perform public.log_privileged('customer.transfer.exceptional', p_customer, jsonb_build_object('company_id', v_from),
                                jsonb_build_object('company_id', p_to_company, 'reason', btrim(p_reason), 'transfer_id', x.id));
  r := public._transfer_execute(x.id);
  if r ->> 'status' is distinct from 'completed' then
    -- كل شيء أو لا شيء: لا إلغاء لطلبات أخرى ولا سجل امتياز لنقل لم يحدث
    raise exception 'تعذّر النقل الاستثنائي: تغيّرت عضويات العميل (%)', coalesce(r ->> 'reason', r ->> 'status')
      using errcode = '55000';
  end if;
  return r || jsonb_build_object('exceptional', true);
end $$;

-- بعد نقل مكتمل صار super_user_id يشير إلى شركة الوجهة؛ إطفاء العزل أو 098 يعيد المسار القديم
-- (supervises / can_access_ticket) فيرى مالك الوجهة تذاكر العميل القديمة. لذلك لا يُطفآن بعد أي نقل مكتمل.
create or replace function public._guard_isolation_after_transfers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.key in ('company_isolation_enforced', 'company_permissions_enabled') and old.enabled
     and (tg_op = 'DELETE' or not new.enabled or new.key is distinct from old.key)
     and (exists (select 1 from public.customer_transfers where status = 'completed')
          or exists (select 1 from public.ticket_carry_items)) then
    raise exception 'لا يُطفأ % بعد نقل عملاء أو نسخ تذاكر: المسار القديم يكشف بيانات شركة لأخرى', old.key
      using errcode = '55000', detail = '{"code":"transfers_exist"}';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_guard_isolation_after_transfers on public.platform_feature_switches;
create trigger trg_guard_isolation_after_transfers before update or delete on public.platform_feature_switches
  for each row execute function public._guard_isolation_after_transfers();

-- قوائم: العميل يرى طلباته؛ المدير يرى ما يخص شركته بلا كشف الطرف الآخر.
create or replace function public.my_transfers()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'from', coalesce(f.company_name, 'شركة محذوفة'), 'to', coalesce(t.company_name, 'شركة محذوفة'), 'status', x.status,
                                               'source_decision', x.source_decision, 'dest_decision', x.dest_decision,
                                               'created_at', x.created_at, 'expires_at', x.expires_at) order by x.created_at desc), '[]'::jsonb)
    from public.customer_transfers x left join public.companies f on f.id = x.from_company left join public.companies t on t.id = x.to_company
   where x.customer_id = auth.uid();
$$;

create or replace function public.company_transfer_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  if public.company_staff_role() is distinct from 'admin' then
    return null;
  end if;
  v_company := public.current_company_id();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id, 'customer_name', coalesce(p.full_name, p.email, 'حساب محذوف'),
      'direction', case when x.from_company = v_company then 'outgoing' else 'incoming' end,
      'status', x.status, 'my_decision', case when x.from_company = v_company then x.source_decision else x.dest_decision end,
      'customer_wants_secondary', case when x.from_company = v_company then x.keep_source_secondary end,
      'created_at', x.created_at, 'expires_at', x.expires_at) order by x.created_at desc)
      from public.customer_transfers x left join public.profiles p on p.id = x.customer_id
     where (x.from_company = v_company or x.to_company = v_company) and x.initiated_as = 'customer'), '[]'::jsonb);
end $$;

-- تقييد المسار الخام: مع المفتاح مفعّلًا، تغيير super_user_id من شركة إلى أخرى خارج مسار العضويات مرفوض.
create or replace function public._guard_raw_company_move()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.super_user_id is not null and new.super_user_id is not null and new.super_user_id <> old.super_user_id
     and coalesce(current_setting('app.membership_sync', true), '') <> 'on'
     and public._feature_on('customer_transfers_enabled') then
    raise exception 'نقل العميل بين الشركات يتم عبر طلب النقل (موافقات + تأكيد العميل) أو النقل الاستثنائي للمالك'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_raw_company_move on public.profiles;
create trigger trg_guard_raw_company_move before update of super_user_id on public.profiles
  for each row execute function public._guard_raw_company_move();


-- ============================================================================
-- 2) نسخ التذاكر
-- ============================================================================
create table if not exists public.ticket_carries (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null,  -- بلا مفتاح خارجي عمدًا (انظر customer_transfers)
  source_company   uuid not null,
  dest_company     uuid not null,
  idempotency_key  uuid not null,
  created_at       timestamptz not null default now(),
  unique (customer_id, idempotency_key),
  constraint ticket_carries_distinct check (source_company <> dest_company)
);
create table if not exists public.ticket_carry_items (
  id             uuid primary key default gen_random_uuid(),
  carry_id       uuid not null references public.ticket_carries(id),
  source_ticket  uuid not null,
  new_ticket_id  uuid not null unique,
  manifest       jsonb not null,
  created_at     timestamptz not null default now(),
  unique (source_ticket, carry_id)
);
-- تذكرة المصدر تُنسخ إلى شركة وجهة مرة واحدة فقط
create unique index if not exists ticket_carry_items_once on public.ticket_carry_items (source_ticket, (manifest ->> 'dest_company'));
create table if not exists public.ticket_carry_attachments (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references public.ticket_carry_items(id),
  source_attachment  uuid not null,
  source_path        text not null,
  dest_path          text not null unique,
  file_name          text,
  mime_type          text,
  size_bytes         bigint,
  status             text not null default 'pending_copy' check (status in ('pending_copy', 'copied', 'failed')),
  sha256             text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  new_attachment_id  uuid,
  copied_at          timestamptz,
  error              text,
  attempts           integer not null default 0,
  created_at         timestamptz not null default now()
);

-- مرفق قابل للنسخ: رفعه العميل، على رد له غير داخلي (أو على التذكرة نفسها)، ومساره يعود لهذه التذكرة،
-- وكائن التخزين موجود ومالكه العميل (الضابط الحاسم: لا ينسخ العميل ملفًا لم يرفعه هو). صف ticket_attachments وحده لا يكفي: مساره نص يكتبه العميل.
create or replace function public._carry_attachment_ok(p_attachment uuid, p_customer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.ticket_attachments a
     where a.id = p_attachment and a.uploaded_by = p_customer and a.file_path is not null
       -- نفس تحليل سياسات التخزين (028): <التذكرة>/<ملف> أو <مستخدم>/<التذكرة>/<ملف>
       and public.storage_ticket_id(a.file_path) = a.ticket_id
       and position('..' in a.file_path) = 0
       -- نفس أشكال المسار التي يقبلها عامل النسخ (ticket-carry-copy/handler.js) — لا عنصر يُستنزف بلا جدوى
       and (a.file_path ~ '^[0-9a-f-]{36}/[^/]{1,200}$' or a.file_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]{1,200}$')
       and (a.reply_id is null or exists (select 1 from public.ticket_replies r where r.id = a.reply_id
                                            and r.user_id = p_customer and not coalesce(r.is_internal, false)))
       and exists (select 1 from storage.objects o where o.bucket_id = 'tickets' and o.name = a.file_path and o.owner = p_customer));
$$;

create or replace function public._carry_require_enabled()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._feature_on('ticket_carry_enabled') then
    raise exception 'نسخ التذاكر بين الشركات غير مفعّل' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  -- بلا العزل يرى مالك المصدر (عبر المسار القديم) ردود فريق الوجهة على التذكرة المنسوخة: لا نسخ قبلهما
  if not (public._feature_on('company_isolation_enforced') and public._feature_on('company_permissions_enabled')) then
    raise exception 'النسخ يتطلب تفعيل عزل الشركات وصلاحيات الفريق أولًا' using errcode = '0A000',
      detail = '{"code":"prerequisite_not_enabled"}';
  end if;
end $$;

-- ما يُنسخ من تذكرة: العنوان والوصف (كتبهما العميل) + ردوده غير الداخلية + مرفقاته على تلك الردود
-- أو على التذكرة نفسها. لا ملاحظات داخلية ولا ردود موظفين ولا هوياتهم ولا نشاط ولا إسناد (القيمة 3).
create or replace function public._carry_manifest(p_ticket uuid, p_customer uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'replies_included', (select count(*) from public.ticket_replies r
                          where r.ticket_id = p_ticket and r.user_id = p_customer and not coalesce(r.is_internal, false)),
    'replies_excluded_staff', (select count(*) from public.ticket_replies r
                                where r.ticket_id = p_ticket and r.user_id <> p_customer and not coalesce(r.is_internal, false)),
    'replies_excluded_internal', (select count(*) from public.ticket_replies r where r.ticket_id = p_ticket and coalesce(r.is_internal, false)),
    'attachments_included', (select count(*) from public.ticket_attachments a
                              where a.ticket_id = p_ticket and public._carry_attachment_ok(a.id, p_customer)),
    'attachments_excluded', (select count(*) from public.ticket_attachments a
                              where a.ticket_id = p_ticket and not public._carry_attachment_ok(a.id, p_customer)),
    'excluded_always', jsonb_build_array('internal_notes', 'staff_replies', 'staff_identities', 'activity', 'assignment', 'ratings'));
$$;

-- العميل: تذاكره في شركة (عضو فيها أو كان) — للاختيار
create or replace function public.carry_candidates(p_source_company uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'title', t.title, 'status', t.status,
                                               'created_at', t.created_at, 'manifest', public._carry_manifest(t.id, auth.uid()))
                            order by t.created_at desc), '[]'::jsonb)
    from public.tickets t
   where public._feature_on('ticket_carry_enabled')
     and t.user_id = auth.uid() and t.scope = 'company' and t.company_id = p_source_company;
$$;

-- النسخ: ذري وغير قابل للتكرار. كل تذكرة مختارة ⇒ تذكرة جديدة في الوجهة بمحتوى العميل وحده.
create or replace function public.carry_tickets(p_source_company uuid, p_dest_company uuid, p_ticket_ids uuid[], p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  c public.ticket_carries;
  t public.tickets;
  v_new uuid;
  v_item uuid;
  v_desc text;
  v_count integer := 0;
  a record;
begin
  perform public._carry_require_enabled();
  if v_uid is null or not coalesce(public.account_is_active(), false) or coalesce(public.preview_mode(), true) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_ticket_ids is null or cardinality(p_ticket_ids) not between 1 and 50 then
    raise exception 'اختر من 1 إلى 50 تذكرة، مع مفتاح منع التكرار' using errcode = '22023';
  end if;
  select * into c from public.ticket_carries where customer_id = v_uid and idempotency_key = p_idempotency_key;
  if c.id is not null then
    return jsonb_build_object('carry_id', c.id, 'replayed', true,
                              'tickets', (select jsonb_agg(new_ticket_id) from public.ticket_carry_items where carry_id = c.id));
  end if;
  if p_source_company = p_dest_company or not public._company_customer_active(p_dest_company, v_uid) then
    raise exception 'لا عضوية نشطة لك في شركة الوجهة' using errcode = 'P0002';
  end if;
  perform 1 from public.profiles where id = v_uid for update;
  insert into public.ticket_carries (customer_id, source_company, dest_company, idempotency_key)
  values (v_uid, p_source_company, p_dest_company, p_idempotency_key) returning * into c;

  for t in select * from public.tickets x
            where x.id = any (p_ticket_ids) order by x.created_at for update loop
    if t.user_id <> v_uid or t.scope <> 'company' or t.company_id <> p_source_company then
      raise exception 'تذكرة ليست لك في شركة المصدر' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.ticket_carry_items i where i.source_ticket = t.id and i.manifest ->> 'dest_company' = p_dest_company::text) then
      raise exception 'سبق نسخ التذكرة رقم % إلى هذه الشركة', t.ticket_number using errcode = '23505';
    end if;
    -- الوصف: نص العميل الأصلي + ردوده (بلا ردود الموظفين ولا أسمائهم)
    select t.description || coalesce(E'\n\n— ردودي السابقة —\n' || string_agg(
             to_char(r.created_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') || E'\n' || r.message, E'\n\n' order by r.created_at), '')
      into v_desc
      from public.ticket_replies r
     where r.ticket_id = t.id and r.user_id = v_uid and not coalesce(r.is_internal, false);
    perform set_config('app.ticket_carry', 'on', true);
    insert into public.tickets (user_id, title, description, status, priority, category, ticket_type, scope, company_id)
    values (v_uid, left(t.title, 190) || ' (منقولة)', coalesce(v_desc, t.description), 'open', 'medium', t.category, t.ticket_type,
            'company', p_dest_company)
    returning id into v_new;
    perform set_config('app.ticket_carry', 'off', true);
    insert into public.ticket_carry_items (carry_id, source_ticket, new_ticket_id, manifest)
    values (c.id, t.id, v_new, public._carry_manifest(t.id, v_uid) || jsonb_build_object('dest_company', p_dest_company,
                                                                                        'source_ticket_number', t.ticket_number))
    returning id into v_item;
    -- المرفقات المسموحة: نسخ ملف جديد (دالة طرفية بمفتاح الخدمة) — لا مشاركة للملف الأصلي
    for a in select x.* from public.ticket_attachments x
              where x.ticket_id = t.id and public._carry_attachment_ok(x.id, v_uid) loop
      insert into public.ticket_carry_attachments (item_id, source_attachment, source_path, dest_path, file_name, mime_type, size_bytes)
      values (v_item, a.id, a.file_path, v_uid || '/' || v_new || '/' || gen_random_uuid() || '-' || left(regexp_replace(coalesce(a.file_name, 'file'), '[^[:alnum:]._-]', '', 'g'), 80),
              a.file_name, a.mime_type, a.file_size);
    end loop;
    v_count := v_count + 1;
  end loop;
  if v_count <> cardinality(p_ticket_ids) then
    raise exception 'بعض التذاكر غير موجودة' using errcode = 'P0002';
  end if;
  -- القيمة 4: المصدر يُبلَّغ بلا كشف الوجهة
  insert into public.notifications (user_id, title, message, type, category)
  select co.user_id, 'نسخ تذاكر بطلب عميل', 'نسخ أحد عملائك ' || v_count || ' من تذاكره لمتابعتها في مكان آخر. التذاكر الأصلية باقية لديك.', 'info', 'account'
    from public.companies co where co.id = p_source_company;
  return jsonb_build_object('carry_id', c.id, 'tickets', (select jsonb_agg(new_ticket_id) from public.ticket_carry_items where carry_id = c.id),
                            'attachments_pending', (select count(*) from public.ticket_carry_attachments ca
                                                     join public.ticket_carry_items i on i.id = ca.item_id where i.carry_id = c.id));
end $$;

-- عامل نسخ المرفقات (مفتاح الخدمة): الطابور ثم التأكيد بعد التحقق من البصمة
create or replace function public.carry_copy_queue(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v jsonb;
begin
  -- بعد 5 محاولات يصير العنصر failed ظاهرًا للمالك، فلا يحجب الطابور غيره
  update public.ticket_carry_attachments set status = 'failed', error = 'too_many_attempts'
   where status = 'pending_copy' and attempts >= 5;
  with picked as (
    select id from public.ticket_carry_attachments
     where status = 'pending_copy'
     order by attempts, created_at, id
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked),
  bumped as (
    update public.ticket_carry_attachments a set attempts = a.attempts + 1
      from picked where a.id = picked.id
    returning a.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'bucket', 'tickets', 'source_path', b.source_path, 'dest_path', b.dest_path,
                                               'mime_type', b.mime_type, 'size_bytes', b.size_bytes) order by b.attempts, b.created_at), '[]'::jsonb)
    into v from bumped b;
  return v;
end $$;

create or replace function public.carry_copy_complete(p_item uuid, p_ok boolean, p_sha256 text, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  a public.ticket_carry_attachments;
  i public.ticket_carry_items;
  v_att uuid;
  v_customer uuid;
begin
  select * into a from public.ticket_carry_attachments where id = p_item for update;
  if a.id is null or a.status <> 'pending_copy' then
    raise exception 'غير موجود أو مكتمل' using errcode = 'P0002';
  end if;
  if not p_ok then
    update public.ticket_carry_attachments set status = 'failed', error = left(coalesce(p_error, 'copy_failed'), 200) where id = a.id;
    return jsonb_build_object('id', a.id, 'status', 'failed');
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or not exists (select 1 from storage.objects o where o.bucket_id = 'tickets' and o.name = a.dest_path) then
    raise exception 'النسخة غير موجودة أو بلا بصمة' using errcode = '55000';
  end if;
  select * into i from public.ticket_carry_items where id = a.item_id;
  select customer_id into v_customer from public.ticket_carries where id = i.carry_id;
  insert into public.ticket_attachments (ticket_id, reply_id, file_url, file_name, file_size, mime_type, uploaded_by, file_path)
  values (i.new_ticket_id, null, a.dest_path, a.file_name, a.size_bytes, a.mime_type, v_customer, a.dest_path)
  returning id into v_att;
  update public.ticket_carry_attachments
     set status = 'copied', sha256 = p_sha256, new_attachment_id = v_att, copied_at = now()
   where id = a.id;
  return jsonb_build_object('id', a.id, 'status', 'copied', 'attachment_id', v_att);
end $$;


-- ============================================================================
-- 3) الوصول التاريخي: الشركة الجديدة تطلب ← العميل يوافق ويختار ← المالك يقرر ← قراءة مسجَّلة
-- ============================================================================
create table if not exists public.historical_access_requests (
  id                  uuid primary key default gen_random_uuid(),
  requesting_company  uuid not null,  -- بلا مفتاح خارجي عمدًا (انظر customer_transfers)
  customer_id         uuid not null,  -- بلا مفتاح خارجي عمدًا (انظر customer_transfers)
  requested_by        uuid not null,
  purpose             text not null check (char_length(btrim(purpose)) between 20 and 1000),
  status              text not null default 'awaiting_customer'
                        check (status in ('awaiting_customer', 'awaiting_owner', 'approved', 'rejected', 'declined', 'cancelled')),
  ticket_ids          uuid[],
  customer_decided_at timestamptz,
  owner_decided_by    uuid,
  owner_decided_at    timestamptz,
  hours               integer check (hours is null or hours between 1 and 168),
  expires_at          timestamptz,
  created_at          timestamptz not null default now()
);
create table if not exists public.historical_access_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  request_id  uuid not null,
  actor_id    uuid,
  action      text not null,
  ticket_id   uuid,
  detail      jsonb not null default '{}'::jsonb
);

create or replace function public._historical_require_enabled()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._feature_on('historical_access_enabled') then
    raise exception 'الوصول التاريخي غير مفعّل' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
end $$;

create or replace function public.historical_access_request(p_customer uuid, p_purpose text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_id uuid;
begin
  perform public._historical_require_enabled();
  if public.company_staff_role() is distinct from 'admin' then
    raise exception 'الطلب لمدير الشركة' using errcode = '42501';
  end if;
  v_company := public.current_company_id();
  if not public._company_customer_active(v_company, p_customer) then
    raise exception 'العميل ليس من عملاء شركتك' using errcode = 'P0002';
  end if;
  if char_length(btrim(coalesce(p_purpose, ''))) < 20 then
    raise exception 'اكتب الغرض بوضوح (20 حرفًا على الأقل)' using errcode = '22023';
  end if;
  insert into public.historical_access_requests (requesting_company, customer_id, requested_by, purpose)
  values (v_company, p_customer, auth.uid(), btrim(p_purpose)) returning id into v_id;
  insert into public.historical_access_audit (request_id, actor_id, action) values (v_id, auth.uid(), 'requested');
  insert into public.notifications (user_id, title, message, type, link, category)
  values (p_customer, 'طلب اطلاع على تذاكرك السابقة', 'تطلب إحدى شركاتك الاطلاع على رسائلك في تذاكر قديمة. لا شيء يُعرض دون موافقتك واختيارك.',
          'info', '/portal/#history-requests', 'account');
  return jsonb_build_object('request_id', v_id, 'status', 'awaiting_customer');
end $$;

-- العميل: يرى الطلبات، ويختار التذاكر التي يسمح بها (من تذاكره في شركات أخرى) أو يرفض.
create or replace function public.my_historical_requests()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'company_id', r.requesting_company, 'company_name', coalesce(c.company_name, 'شركة محذوفة'),
                                               'purpose', r.purpose, 'status', r.status,
                                               'ticket_ids', r.ticket_ids, 'created_at', r.created_at,
                                               -- ما يمكن للعميل اختياره: تذاكره في شركات غير الطالبة (بياناته هو)
                                               'eligible', case when r.status = 'awaiting_customer' then coalesce((
                                                   select jsonb_agg(jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number,
                                                                                       'title', t.title, 'company_name', tc.company_name,
                                                                                       'created_at', t.created_at) order by t.created_at desc)
                                                     from public.tickets t join public.companies tc on tc.id = t.company_id
                                                    where t.user_id = auth.uid() and t.scope = 'company'
                                                      and t.company_id <> r.requesting_company), '[]'::jsonb) end)
                            order by r.created_at desc), '[]'::jsonb)
    from public.historical_access_requests r left join public.companies c on c.id = r.requesting_company
   where r.customer_id = auth.uid();
$$;

create or replace function public.historical_access_consent(p_request uuid, p_approve boolean, p_ticket_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r public.historical_access_requests;
begin
  perform public._historical_require_enabled();
  select * into r from public.historical_access_requests where id = p_request and customer_id = auth.uid() for update;
  if r.id is null or r.status <> 'awaiting_customer' then
    raise exception 'الطلب غير موجود أو لم يعد بانتظارك' using errcode = 'P0002';
  end if;
  if not coalesce(p_approve, false) then
    update public.historical_access_requests set status = 'declined', customer_decided_at = now() where id = r.id;
    insert into public.historical_access_audit (request_id, actor_id, action) values (r.id, auth.uid(), 'customer_declined');
    return jsonb_build_object('request_id', r.id, 'status', 'declined');
  end if;
  if p_ticket_ids is null or cardinality(p_ticket_ids) not between 1 and 50
     or exists (select 1 from unnest(p_ticket_ids) x(id)
                 where not exists (select 1 from public.tickets t where t.id = x.id and t.user_id = auth.uid() and t.scope = 'company'
                                     and t.company_id <> r.requesting_company)) then
    raise exception 'اختر من تذاكرك في شركات أخرى (1–50)' using errcode = '22023';
  end if;
  update public.historical_access_requests
     set status = 'awaiting_owner', ticket_ids = p_ticket_ids, customer_decided_at = now() where id = r.id;
  insert into public.historical_access_audit (request_id, actor_id, action, detail)
  values (r.id, auth.uid(), 'customer_consented', jsonb_build_object('tickets', cardinality(p_ticket_ids)));
  return jsonb_build_object('request_id', r.id, 'status', 'awaiting_owner');
end $$;

-- المالك: بعد موافقة العميل فقط (القيمة 5)، بتحقق خطوتين، ومدة محدودة.
create or replace function public.owner_decide_historical_access(p_request uuid, p_approve boolean, p_hours integer default 24)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r public.historical_access_requests;
  v_hours integer := least(greatest(coalesce(p_hours, 24), 1), 168);
begin
  perform public._historical_require_enabled();
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'القرار لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  select * into r from public.historical_access_requests where id = p_request for update;
  if r.id is null or r.status <> 'awaiting_owner' or r.customer_decided_at is null then
    raise exception 'الطلب غير موجود أو لا ينتظر قرارك (موافقة العميل أولًا)' using errcode = 'P0002';
  end if;
  if r.requested_by = auth.uid() then
    raise exception 'لا موافقة على طلبك أنت' using errcode = '42501';
  end if;
  update public.historical_access_requests
     set status = case when p_approve then 'approved' else 'rejected' end, owner_decided_by = auth.uid(), owner_decided_at = now(),
         hours = case when p_approve then v_hours end, expires_at = case when p_approve then now() + make_interval(hours => v_hours) end
   where id = r.id;
  insert into public.historical_access_audit (request_id, actor_id, action, detail)
  values (r.id, auth.uid(), case when p_approve then 'owner_approved' else 'owner_rejected' end, jsonb_build_object('hours', v_hours));
  perform public.log_privileged('historical_access.' || case when p_approve then 'approved' else 'rejected' end, r.customer_id, null,
                                jsonb_build_object('request_id', r.id, 'company_id', r.requesting_company, 'hours', v_hours));
  return jsonb_build_object('request_id', r.id, 'status', case when p_approve then 'approved' else 'rejected' end);
end $$;

-- القراءة: مدير الشركة الطالبة، للتذاكر المختارة وحدها، ضمن المدة، بمحتوى العميل وحده، وكل نداء مسجَّل.
create or replace function public.historical_ticket_view(p_request uuid, p_ticket uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r public.historical_access_requests;
  t public.tickets;
begin
  perform public._historical_require_enabled();
  select * into r from public.historical_access_requests where id = p_request;
  if r.id is null or r.status <> 'approved' or r.expires_at <= now()
     or public.company_staff_role() is distinct from 'admin' or public.current_company_id() <> r.requesting_company
     or not (p_ticket = any (r.ticket_ids)) then
    raise exception 'لا وصول سارٍ لهذه التذكرة' using errcode = '42501';
  end if;
  select * into t from public.tickets where id = p_ticket and user_id = r.customer_id;
  if t.id is null then
    raise exception 'التذكرة غير موجودة' using errcode = 'P0002';
  end if;
  insert into public.historical_access_audit (request_id, actor_id, action, ticket_id) values (r.id, auth.uid(), 'viewed', t.id);
  return jsonb_build_object(
    'ticket', jsonb_build_object('title', t.title, 'description', t.description, 'status', t.status, 'created_at', t.created_at),
    'customer_messages', coalesce((select jsonb_agg(jsonb_build_object('message', x.message, 'created_at', x.created_at) order by x.created_at)
                                     from public.ticket_replies x
                                    where x.ticket_id = t.id and x.user_id = r.customer_id and not coalesce(x.is_internal, false)), '[]'::jsonb),
    'expires_at', r.expires_at);
end $$;

-- مدير الشركة: طلباته. أرقام التذاكر تظهر فقط ما دام الوصول ساريًا (للقراءة عبر historical_ticket_view).
create or replace function public.company_historical_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  if public.company_staff_role() is distinct from 'admin' then
    return null;
  end if;
  v_company := public.current_company_id();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'customer_name', coalesce(p.full_name, p.email, 'حساب محذوف'), 'purpose', r.purpose, 'status', r.status,
      'ticket_ids', case when r.status = 'approved' and r.expires_at > now() then to_jsonb(r.ticket_ids) end,
      'created_at', r.created_at, 'expires_at', r.expires_at) order by r.created_at desc)
      from public.historical_access_requests r left join public.profiles p on p.id = r.customer_id
     where r.requesting_company = v_company), '[]'::jsonb);
end $$;

create or replace function public.owner_historical_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'company_name', coalesce(c.company_name, 'شركة محذوفة'), 'purpose', r.purpose, 'status', r.status,
                                                       'tickets', coalesce(cardinality(r.ticket_ids), 0), 'created_at', r.created_at,
                                                       'expires_at', r.expires_at) order by r.created_at desc)
                     from public.historical_access_requests r left join public.companies c on c.id = r.requesting_company), '[]'::jsonb);
end $$;


-- ============================================================================
-- 4) لا فوترة مزدوجة للتذاكر المنسوخة (ترقيع مقاطع محددة؛ الباقي حرفيًا كما هو)
-- ============================================================================
select pg_temp._patch_function('public.ticket_quota_status(uuid)'::regprocedure,
  E'     and t.created_at >= v_period_start;',
  E'     and t.created_at >= v_period_start\n     -- 101: التذكرة المنسوخة لا تُحسب مرة ثانية\n     and not exists (select 1 from public.ticket_carry_items ci where ci.new_ticket_id = t.id);');
select pg_temp._patch_function('public.enforce_ticket_quota()'::regprocedure,
  E'  if new.user_id is null\n',
  E'  -- 101: نسخ تذكرة بطلب العميل (carry_tickets) لا يستهلك حصة\n  if coalesce(current_setting(''app.ticket_carry'', true), '''') = ''on'' then\n    return new;\n  end if;\n  if new.user_id is null\n');
select pg_temp._patch_function('public._usage_record_ticket(public.tickets,text)'::regprocedure,
  E'  v_counter text := case when coalesce(p_ticket.category, \'\') = \'whatsapp_wallet_topup\' then \'billing\' else \'used\' end;',
  E'  v_counter text := case when coalesce(current_setting(\'app.ticket_carry\', true), \'\') = \'on\' then \'none\'  -- 101: منسوخة، لا تُفوتر\n                         when coalesce(p_ticket.category, \'\') = \'whatsapp_wallet_topup\' then \'billing\' else \'used\' end;');
select pg_temp._patch_function('public._usage_record_ticket(public.tickets,text)'::regprocedure,
  E'          v_counter, 1, public.ticket_account_owner(p_ticket.user_id),',
  E'          v_counter, case when v_counter = \'none\' then 0 else 1 end, public.ticket_account_owner(p_ticket.user_id),');
select pg_temp._patch_function('public.usage_reconciliation(date)'::regprocedure,
  E'       where t.created_at >= v_start and t.created_at < v_end\n',
  E'       where t.created_at >= v_start and t.created_at < v_end\n         and not exists (select 1 from public.ticket_carry_items ci where ci.new_ticket_id = t.id)  -- 101\n');


-- ============================================================================
-- 5) الحماية والصلاحيات
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['customer_transfers', 'ticket_carries', 'ticket_carry_items', 'ticket_carry_attachments',
                           'historical_access_requests', 'historical_access_audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all
                      using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;

create or replace function public._h2_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'سجل إلحاقي' using errcode = '23514';
end $$;
drop trigger if exists trg_h2_append_only on public.historical_access_audit;
create trigger trg_h2_append_only before update or delete on public.historical_access_audit
  for each row execute function public._h2_append_only();
do $$
declare t text;
begin
  foreach t in array array['customer_transfers', 'ticket_carries', 'ticket_carry_items', 'historical_access_requests'] loop
    execute format('drop trigger if exists trg_h2_no_delete on public.%I', t);
    execute format('create trigger trg_h2_no_delete before delete on public.%I for each row execute function public._h2_append_only()', t);
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public._transfers_require_enabled()', 'public._transfer_execute(uuid)', 'public._guard_raw_company_move()',
                           'public._carry_require_enabled()', 'public._carry_manifest(uuid,uuid)', 'public._carry_attachment_ok(uuid,uuid)',
                           'public._historical_require_enabled()', 'public._h2_append_only()',
                           'public._guard_isolation_after_transfers()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array['public.transfer_request(uuid,boolean,uuid)', 'public.transfer_decide(uuid,boolean,boolean)',
                           'public.transfer_cancel(uuid)', 'public.owner_transfer_exceptional(uuid,uuid,text,boolean,uuid)',
                           'public.my_transfers()', 'public.company_transfer_requests()', 'public.carry_candidates(uuid)',
                           'public.carry_tickets(uuid,uuid,uuid[],uuid)', 'public.historical_access_request(uuid,text)',
                           'public.my_historical_requests()', 'public.historical_access_consent(uuid,boolean,uuid[])',
                           'public.owner_decide_historical_access(uuid,boolean,integer)', 'public.historical_ticket_view(uuid,uuid)',
                           'public.company_historical_requests()', 'public.owner_historical_requests()', 'public.h2_features()'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.carry_copy_queue(integer)', 'public.carry_copy_complete(uuid,boolean,text,text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;


-- ============================================================================
-- 6) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where enabled) then
    raise exception '101: مفتاح مفعّل بعد الترحيل — يجب أن تكون كلها مطفأة';
  end if;
  if position('ticket_carry_items' in pg_get_functiondef('public.ticket_quota_status(uuid)'::regprocedure)) = 0
     or position('app.ticket_carry' in pg_get_functiondef('public.enforce_ticket_quota()'::regprocedure)) = 0 then
    raise exception '101: ترقيع الحصة لم يُطبَّق';
  end if;
  if jsonb_array_length(public.usage_reconciliation() -> 'mismatches') <> 0 then
    raise exception '101: سجل الظل لا يطابق الحساب الحالي بعد الترقيع';
  end if;
end $$;
