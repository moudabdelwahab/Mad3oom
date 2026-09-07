-- ============================================================================
-- 018_admin_subscription_management.sql
--   إدارة فعلية للاشتراكات من لوحة الإدارة: تعديل، تعطيل، إعادة تفعيل،
--   تغيير باقة — مع إعادة حساب الامتيازات وسجل تدقيق.
--
-- المشاكل التي عولجت
--   1) "الامتيازات المشتقة" (profiles.whatsapp_enabled و role) بتتحسب في
--      أماكن متفرقة: confirmPurchaseTicket في الواجهة (JS)، و
--      expire_stale_subscriptions في القاعدة. مفيش مكان واحد بيقول
--      "الحالة الصحيحة لهذا المستخدم الآن". فلو الأدمن غيّر باقة العميل من
--      الشاملة إلى واتساب، رتبة super_user كانت هتفضل شغّالة.
--      => recompute_user_access(): مكان واحد يُعيد اشتقاق الحالة من
--         الاشتراكات الفعّالة، وتناديه كل عمليات الإدارة.
--
--   2) صفحة اشتراكات الإدارة كانت عرضًا فقط (قراءة من whatsapp_subscriptions
--      مباشرة)، ومفيش أي مسار آمن لتعديل اشتراك. أي تعديل كان هيتم بـUPDATE
--      خام من المتصفح بصلاحيات الأدمن، بلا تحقق ولا سجل.
--      => دوال RPC محدودة الصلاحية + سجل تدقيق append-only.
--
--   3) مفيش سجل يقول مين غيّر إيه. المشروع فيه نمط جاهز لده
--      (customer_sie_access_audit و aqar_admin_audit_log)، فاتبعناه بدل
--      اختراع نظام جديد.
--
-- ما الذي لم يتغيّر
--   * مفيش تعديل على أي سياسة RLS قائمة، ولا على مسار الاشتراك العادي.
--   * الأعمدة الحسّاسة (user_id, ticket_id, payment_*) غير قابلة للتعديل
--     من هذه الدوال إطلاقًا — التعديل محصور فيما يُعقل تعديله إداريًا.
-- ============================================================================

-- ── 1) إعادة اشتقاق حالة المستخدم من اشتراكاته ─────────────────────────────
-- نفس منطق expire_stale_subscriptions حرفيًا، لكن لمستخدم واحد وقابل للنداء
-- بعد أي تعديل إداري. ده المكان الوحيد اللي بيقرر "إيه اللي مفتوح للمستخدم ده".
create or replace function public.recompute_user_access(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_features   text[];
  v_whatsapp   boolean;
  v_support    boolean;
  v_role       text;
  v_role_note  text := null;
begin
  if p_user_id is null then
    return null;
  end if;

  v_features := public.owned_feature_keys(p_user_id);
  v_whatsapp := 'whatsapp_sender' = any(v_features);
  v_support  := 'support_tickets' = any(v_features);

  update public.profiles
     set whatsapp_enabled = v_whatsapp
   where id = p_user_id
     and whatsapp_enabled is distinct from v_whatsapp;

  select role into v_role from public.profiles where id = p_user_id;

  -- تنزيل الرتبة: يعمل دائمًا (الحارس لا يمنع العودة إلى 'user')
  if v_role = 'super_user' and not v_support then
    update public.profiles set role = 'user' where id = p_user_id;
    v_role := 'user';
  -- ترقية الرتبة: check_super_user_creation يقصرها على الأدمن الرئيسي.
  -- بنحاولها ونبتلع الرفض بدل ما نُفشل العملية الإدارية كلها، ونسجّل ملاحظة.
  elsif v_role = 'user' and v_support then
    begin
      update public.profiles set role = 'super_user' where id = p_user_id;
      v_role := 'super_user';
    exception when others then
      v_role_note := 'تعذّرت ترقية الرتبة إلى super_user (تتطلب الأدمن الرئيسي)';
    end;
  end if;

  return jsonb_build_object(
    'features', to_jsonb(v_features),
    'whatsapp_enabled', v_whatsapp,
    'role', v_role,
    'note', v_role_note
  );
end;
$function$;

comment on function public.recompute_user_access(uuid) is
  'يعيد اشتقاق whatsapp_enabled والرتبة من الاشتراكات الفعّالة. المصدر الوحيد لحالة الوصول بعد أي تغيير إداري.';

revoke all on function public.recompute_user_access(uuid) from public, anon, authenticated;


-- ── 2) سجل التدقيق ─────────────────────────────────────────────────────────
-- نفس شكل customer_sie_access_audit الموجود في المشروع: append-only، فيه
-- الفاعل والهدف والقيم قبل/بعد والسبب.
create table if not exists public.subscription_audit_log (
  id              bigserial primary key,
  subscription_id uuid,
  target_user_id  uuid,
  actor_user_id   uuid,
  actor_email     text,
  action          text not null,
  old_values      jsonb,
  new_values      jsonb,
  reason          text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_subscription_audit_subscription
  on public.subscription_audit_log(subscription_id, created_at desc);
create index if not exists idx_subscription_audit_target
  on public.subscription_audit_log(target_user_id, created_at desc);

comment on table public.subscription_audit_log is
  'سجل تدقيق append-only لكل تغيير إداري على الاشتراكات: من غيّر ماذا ومتى ولماذا.';

alter table public.subscription_audit_log enable row level security;

drop policy if exists "Admins read subscription audit" on public.subscription_audit_log;
create policy "Admins read subscription audit"
  on public.subscription_audit_log
  for select
  using (public.is_admin());

-- مفيش سياسة INSERT/UPDATE/DELETE عمدًا: الكتابة تتم داخل الدوال
-- SECURITY DEFINER فقط، فالسجل غير قابل للتزوير أو الحذف من أي عميل.


-- ── 3) عمليات الإدارة ──────────────────────────────────────────────────────
-- كل الدوال دي admin-only بالتحقق داخل الدالة نفسها (is_admin)، مش بالاعتماد
-- على إخفاء الأزرار. حتى لو نادى عميل الـRPC مباشرة، هيترفض.

-- الحقول القابلة للتعديل عمدًا: الباقة، الحالة، تاريخا البداية والانتهاء.
-- غير قابلة للتعديل: user_id (نقل اشتراك لعميل آخر يفسد التدقيق والفوترة)،
-- ticket_id، وبيانات الدفع (سجل تاريخي لما حدث فعلًا).
create or replace function public.admin_update_subscription(
  p_subscription_id uuid,
  p_plan            text default null,
  p_status          text default null,
  p_start_date      timestamptz default null,
  p_end_date        timestamptz default null,
  p_reason          text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_old      public.whatsapp_subscriptions%rowtype;
  v_new      public.whatsapp_subscriptions%rowtype;
  v_plan     text;
  v_status   text;
  v_start    timestamptz;
  v_end      timestamptz;
  v_access   jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select * into v_old from public.whatsapp_subscriptions where id = p_subscription_id;
  if v_old.id is null then
    raise exception 'الاشتراك غير موجود';
  end if;

  v_plan   := coalesce(p_plan, v_old.plan);
  v_status := coalesce(p_status, v_old.status);
  v_start  := coalesce(p_start_date, v_old.start_date);
  v_end    := coalesce(p_end_date, v_old.end_date);

  if not exists (select 1 from public.subscription_plans where key = v_plan) then
    raise exception 'باقة غير معروفة: %', v_plan;
  end if;

  if v_status not in ('active', 'pending', 'expired', 'rejected') then
    raise exception 'حالة غير معروفة: %', v_status;
  end if;

  -- حماية من الأخطاء البشرية: تواريخ غير منطقية
  if v_end is null then
    raise exception 'تاريخ الانتهاء مطلوب';
  end if;
  if v_start is not null and v_end <= v_start then
    raise exception 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية';
  end if;
  -- اشتراك "فعّال" بتاريخ انتهاء فات = تناقض؛ نمنعه بدل ما نخلق صفًا
  -- بيقول active والمنصة كلها بتعتبره منتهيًا.
  if v_status = 'active' and v_end <= now() then
    raise exception 'لا يمكن جعل الاشتراك فعّالًا وتاريخ انتهائه في الماضي';
  end if;

  update public.whatsapp_subscriptions
     set plan = v_plan, status = v_status,
         start_date = v_start, end_date = v_end, updated_at = now()
   where id = p_subscription_id
  returning * into v_new;

  -- الامتيازات تُعاد من الاشتراكات، فلا تبقى صلاحية باقة قديمة شغّالة
  v_access := public.recompute_user_access(v_old.user_id);

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email,
    action, old_values, new_values, reason
  ) values (
    p_subscription_id, v_old.user_id, auth.uid(),
    (select email from public.profiles where id = auth.uid()),
    'update',
    jsonb_build_object('plan', v_old.plan, 'status', v_old.status,
                       'start_date', v_old.start_date, 'end_date', v_old.end_date),
    jsonb_build_object('plan', v_new.plan, 'status', v_new.status,
                       'start_date', v_new.start_date, 'end_date', v_new.end_date),
    nullif(btrim(coalesce(p_reason, '')), '')
  );

  return jsonb_build_object('subscription_id', p_subscription_id, 'access', v_access);
end;
$function$;

comment on function public.admin_update_subscription(uuid, text, text, timestamptz, timestamptz, text) is
  'تعديل إداري لاشتراك (باقة/حالة/تواريخ) مع إعادة حساب الامتيازات وتسجيل التدقيق. admin-only.';

revoke all on function public.admin_update_subscription(uuid, text, text, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.admin_update_subscription(uuid, text, text, timestamptz, timestamptz, text) to authenticated;


-- تعطيل / إعادة تفعيل
-- دورة الحياة المسموح بها (مشتقة من الحالات الموجودة فعلًا في الجدول):
--   active  → expired   (تعطيل)
--   expired → active    (إعادة تفعيل، بشرط تاريخ انتهاء في المستقبل)
--   pending → rejected  (رفض طلب)
--   rejected/expired → لا يُعاد لـpending (الطلب انتهى، يُنشأ طلب جديد)
create or replace function public.admin_set_subscription_status(
  p_subscription_id uuid,
  p_status          text,
  p_reason          text default null,
  p_end_date        timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_old    public.whatsapp_subscriptions%rowtype;
  v_end    timestamptz;
  v_access jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select * into v_old from public.whatsapp_subscriptions where id = p_subscription_id;
  if v_old.id is null then
    raise exception 'الاشتراك غير موجود';
  end if;

  if v_old.status = p_status then
    raise exception 'الاشتراك بالفعل في هذه الحالة';
  end if;

  -- الانتقالات المسموح بها فقط
  if not (
       (v_old.status = 'active'  and p_status = 'expired')
    or (v_old.status = 'expired' and p_status = 'active')
    or (v_old.status = 'pending' and p_status in ('rejected', 'active'))
  ) then
    raise exception 'انتقال غير مسموح: % ← %', v_old.status, p_status;
  end if;

  v_end := coalesce(p_end_date, v_old.end_date);

  -- إعادة التفعيل بتاريخ منتهٍ تُنتج اشتراكًا "فعّالًا" لا يعمل فعليًا
  if p_status = 'active' and v_end <= now() then
    raise exception 'لإعادة التفعيل يجب تحديد تاريخ انتهاء في المستقبل';
  end if;

  update public.whatsapp_subscriptions
     set status = p_status, end_date = v_end, updated_at = now()
   where id = p_subscription_id;

  v_access := public.recompute_user_access(v_old.user_id);

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email,
    action, old_values, new_values, reason
  ) values (
    p_subscription_id, v_old.user_id, auth.uid(),
    (select email from public.profiles where id = auth.uid()),
    case when p_status = 'expired' then 'deactivate'
         when p_status = 'active'  then 'reactivate'
         else 'reject' end,
    jsonb_build_object('status', v_old.status, 'end_date', v_old.end_date),
    jsonb_build_object('status', p_status, 'end_date', v_end),
    nullif(btrim(coalesce(p_reason, '')), '')
  );

  return jsonb_build_object('subscription_id', p_subscription_id, 'access', v_access);
end;
$function$;

comment on function public.admin_set_subscription_status(uuid, text, text, timestamptz) is
  'تعطيل/إعادة تفعيل/رفض اشتراك ضمن الانتقالات المسموح بها فقط، مع إعادة حساب الامتيازات والتدقيق. admin-only.';

revoke all on function public.admin_set_subscription_status(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.admin_set_subscription_status(uuid, text, text, timestamptz) to authenticated;


-- ── 4) عرض الاشتراكات للإدارة ──────────────────────────────────────────────
-- نداء واحد يجمع ما كانت الصفحة تحاول تجميعه من عدة استعلامات، ويضيف ما لم
-- تكن تعرضه أصلًا: الشركة المرتبطة، والامتيازات الفعلية للعميل.
create or replace function public.admin_list_subscriptions()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(r order by r_created desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id', s.id,
               'user_id', s.user_id,
               'customer_name', coalesce(p.full_name, p.username, p.email, 'بدون اسم'),
               'customer_email', p.email,
               'customer_phone', p.phone,
               'company_id', c.id,
               'company_name', c.company_name,
               'plan', s.plan,
               'plan_name_ar', coalesce(sp.name_ar, sp.name, s.plan),
               'status', s.status,
               'billing_cycle', s.billing_cycle,
               'start_date', s.start_date,
               'end_date', s.end_date,
               'is_active', (s.status = 'active' and s.end_date > now()),
               'days_remaining', greatest(0, ceil(extract(epoch from (s.end_date - now())) / 86400))::int,
               'ticket_number', t.ticket_number,
               'payment_method', s.payment_method,
               'created_at', s.created_at,
               'effective_features', to_jsonb(public.owned_feature_keys(s.user_id))
             ) as r,
             s.created_at as r_created
        from public.whatsapp_subscriptions s
        left join public.profiles p on p.id = s.user_id
        left join public.subscription_plans sp on sp.key = s.plan
        left join public.companies c on c.id = s.company_id or c.user_id = s.user_id
        left join public.tickets t on t.id = s.ticket_id
    ) q;

  return v_rows;
end;
$function$;

comment on function public.admin_list_subscriptions() is
  'كل الاشتراكات مع العميل والشركة والباقة والامتيازات الفعلية. admin-only.';

revoke all on function public.admin_list_subscriptions() from public, anon;
grant execute on function public.admin_list_subscriptions() to authenticated;


-- سجل التدقيق لاشتراك بعينه (للعرض في شاشة التفاصيل)
create or replace function public.admin_subscription_audit(p_subscription_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  return (
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'action', a.action, 'actor_email', a.actor_email,
               'old_values', a.old_values, 'new_values', a.new_values,
               'reason', a.reason, 'created_at', a.created_at
             ) order by a.created_at desc), '[]'::jsonb)
      from public.subscription_audit_log a
     where a.subscription_id = p_subscription_id
  );
end;
$function$;

revoke all on function public.admin_subscription_audit(uuid) from public, anon;
grant execute on function public.admin_subscription_audit(uuid) to authenticated;
