-- 027_legacy_security_closure.sql
-- إغلاق مسارات السلطة القديمة قبل بناء المعمارية الجديدة
-- ============================================================================
--
-- هذه المرحلة **لا** تنشئ رتبة جديدة ولا تعيد تصميم الأدوار. كل بند هنا يغلق
-- ثغرة **مُثبَتة** على الإنتاج بمحاولة فعلية انتهت بـ ALLOWED، ولكل بند اختبار
-- سلبي يثبت أن المحاولة نفسها تصير DENIED بعد الترحيل.
--
-- ترتيب التطبيق: بعد 024 (تعرّف is_platform_staff) و 025.
-- لا علاقة له بـ 026 الموقوف.

do $$
begin
  if to_regprocedure('public.is_platform_staff()') is null then
    raise exception 'يجب تطبيق migrations/024 أولًا (is_platform_staff غير معرَّفة)';
  end if;
end $$;

-- ============================================================================
-- 1) N9 — التفويض يتوقف عن القراءة من عمود يكتبه المستخدم
-- ============================================================================
--
-- ما ثبت على الإنتاج
--   `profiles.email` قابل للكتابة من العميل: محاولة
--       update profiles set email='...' where id = auth.uid()
--   رجعت ALLOWED (1 row). وليست نظرية: صف حقيقي في الإنتاج يحمل اليوم
--   email = '' بينما auth.users.email يحمل عنوانًا صحيحًا، و updated_at
--   بعد created_at — أي أن مستخدمًا فعليًا مرّ من هذا الباب.
--
--   و 13 موضعًا كان يقرأ هذا العمود ليقرر السلطة، منها is_admin ذاتها.
--   المانع الوحيد اليوم أن العنوانين المميّزين محجوزان، فترتد المحاولة
--   بخطأ 23505 (تعارض مفتاح) لا بخطأ تفويض. هذا حظّ لا حاجز.
--
-- المزامنة — فُحصت قبل أي تعديل، كما طُلب
--   المزامنة الوحيدة القائمة هي handle_new_user: محفّز AFTER INSERT على
--   auth.users ينسخ new.email مرة واحدة عند التسجيل. **لا يوجد محفّز UPDATE
--   على auth.users** — فتغيير البريد لاحقًا لا ينعكس على profiles أصلًا.
--   أي أن profiles.email لقطة قديمة لا مرآة. لذلك قفل الكتابة من العميل
--   لا يكسر مزامنة قائمة: لا توجد مزامنة ليكسرها. والمصدر الموثوق
--   auth.users.email يبقى كما هو ولا يُمَس.

-- ── 1أ) الدوال: نفس السلطة، من مصدر لا يكتبه المستخدم ──────────────────────
--
-- is_main_admin() تقرأ auth.users.email وهي غير قابلة للكتابة من العميل،
-- فتصير هي فرع البريد الوحيد. لا رتبة جديدة، ولا توسيع صلاحية: الحسابان
-- المميّزان يحملان role='admin' في الإنتاج فعلًا، ففرع البريد احتياطي بحت.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
      or public.is_main_admin();
$$;

-- is_support_user() كانت تقرأ profiles.email، وهي تحرس «قراءة كل البروفايلات»
-- (سياسة Support can view all profiles). أي أن الثغرة كانت تفتح كل الحسابات.
create or replace function public.is_support_user()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
      or public.is_main_admin();
$$;

-- is_platform_staff() عُرّفت في 024 بفرع profiles.email — أي أنها كانت تنقل
-- نفس ضعف N9 إلى الـ22 سياسة التي وحّدتها. تُصحَّح هنا لنفس السبب.
create or replace function public.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin','support')
  ) or public.is_main_admin();
$$;

revoke all on function public.is_admin()           from public, anon;
revoke all on function public.is_support_user()    from public, anon;
revoke all on function public.is_platform_staff()  from public, anon;
grant execute on function public.is_admin()          to authenticated;
grant execute on function public.is_support_user()   to authenticated;
grant execute on function public.is_platform_staff() to authenticated;

-- is_admin_user(uuid) كانت تخلط المصدرين: البريد من auth.users (سليم) والرتبة
-- من profiles (سليم). تُترك كما هي عدا تثبيت أنها لا تلمس profiles.email.
create or replace function public.is_admin_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null and (
       coalesce((select u.email in ('support@mad3oom.online','info@mad3oom.online')
                   from auth.users u where u.id = p_user_id), false)
    or coalesce((select p.role = 'admin' from public.profiles p where p.id = p_user_id), false)
  );
$$;

-- ── 1ب) السياسات الثماني التي كانت تقرأ profiles.email مباشرة ──────────────
--
-- محفوظة حرفيًا عدا استبدال شرط الهوية بالدالة المصحّحة. لا قراءة تتوسّع.

drop policy if exists "Admins can view all api_keys" on public.api_keys;
create policy "Admins can view all api_keys" on public.api_keys
  for select using (public.is_admin());

drop policy if exists "Admins can view all bot_api_keys" on public.bot_api_keys;
create policy "Admins can view all bot_api_keys" on public.bot_api_keys
  for select using (public.is_admin());

drop policy if exists "Admins can view all bot_settings" on public.bot_settings;
create policy "Admins can view all bot_settings" on public.bot_settings
  for select using (public.is_admin());

drop policy if exists "Admins can view all integrations" on public.integrations;
create policy "Admins can view all integrations" on public.integrations
  for select using (public.is_admin());

drop policy if exists "Support can view all integrations" on public.integrations;
create policy "Support can view all integrations" on public.integrations
  for select using (public.is_platform_staff());

drop policy if exists "Admins can manage mcp_servers" on public.mcp_servers;
create policy "Admins can manage mcp_servers" on public.mcp_servers
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins can manage mcp_server_connections" on public.mcp_server_connections;
create policy "Admins can manage mcp_server_connections" on public.mcp_server_connections
  for all using (public.is_admin()) with check (public.is_admin());

-- ── 1ج) اختيار المستلِم في الإشعارات — يُحَل من auth.users ─────────────────
--
-- ليست سلطة بل عنونة، لكن قراءتها من عمود كان يكتبه المستخدم تعني أن
-- إشعارات الإدارة كان يمكن توجيهها لغير الإدارة. نفس النتيجة، مصدر موثوق.

create or replace function public.notify_admin_on_new_subscription()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_admin_id uuid; v_customer_name text; v_plan_label text;
begin
  select u.id into v_admin_id from auth.users u
   where u.email = 'support@mad3oom.online' limit 1;
  if v_admin_id is null then return new; end if;

  select coalesce(full_name, email, 'عميل') into v_customer_name
    from public.profiles where id = new.user_id;

  v_plan_label := case new.plan
      when 'whatsapp' then 'واتساب بيزنس'
      when 'support'  then 'الدعم الفني'
      when 'bundle'   then 'الباقة الشاملة'
      else new.plan end;

  insert into public.notifications (user_id, title, message, type, link)
  values (v_admin_id, 'اشتراك جديد',
          format('قام العميل "%s" بطلب اشتراك في باقة %s.', v_customer_name, v_plan_label),
          'success', '/admin/subscriptions.html');
  return new;
end $$;

create or replace function public.notify_support_on_ticket_rejected()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_admin_id uuid; v_staff_name text;
begin
  if new.status <> 'rejected' or old.status is not distinct from new.status then
    return new;
  end if;

  select u.id into v_admin_id from auth.users u
   where u.email = 'support@mad3oom.online' limit 1;
  if v_admin_id is null then return new; end if;

  select coalesce(full_name, email, 'موظف الدعم') into v_staff_name
    from public.profiles where id = new.last_updated_by;

  insert into public.notifications (user_id, title, message, type, link)
  values (v_admin_id, 'تم رفض تذكرة',
          format('قام %s برفض التذكرة #%s ("%s").',
                 coalesce(v_staff_name,'أحد الموظفين'),
                 coalesce(new.ticket_number::text,'---'), new.title),
          'error', '/admin/tickets.html');
  return new;
end $$;

-- ============================================================================
-- 2) قفل الأعمدة التي تقرر سلطة أو استحقاقًا أو حالة حساب
-- ============================================================================
--
-- ما ثبت على الإنتاج (كلها رجعت ALLOWED من حساب عميل عادي على صفّه هو):
--   whatsapp_enabled=true       → has_chatbot_entitlement() تصير true: ميزة مدفوعة بلا دفع
--   is_verified=true            → شارة توثيق مزوّرة
--   ban_status=null,is_locked=false,failed_login_attempts=0
--                               → فك حظر النفس وتصفير عدّاد محاولات الدخول
--   email='...'                 → ثغرة N9 أعلاه
--   pi_uid='...'                → حجز هوية Pi لشخص آخر (العمود UNIQUE)
--
-- الرتبة والنقاط والتبعية محروسة أصلًا بمحفّزات قائمة، فلا تُكرَّر هنا.
-- المحفّز يرفض **التغيير** لا الكتابة، فنموذج «أرسل الصف كله» في الواجهة
-- يظل يعمل ما دامت القيم كما هي.

create or replace function public.guard_profile_protected_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_changed text[] := '{}';
begin
  -- المسار الشائع أولًا: لا شيء من هذه الأعمدة تغيّر
  if  new.email                 is not distinct from old.email
  and new.whatsapp_enabled      is not distinct from old.whatsapp_enabled
  and new.is_verified           is not distinct from old.is_verified
  and new.ban_status            is not distinct from old.ban_status
  and new.ban_until             is not distinct from old.ban_until
  and new.ban_reason            is not distinct from old.ban_reason
  and new.is_locked             is not distinct from old.is_locked
  and new.failed_login_attempts is not distinct from old.failed_login_attempts
  and new.custom_role_id        is not distinct from old.custom_role_id
  and new.pi_uid                is not distinct from old.pi_uid
  then
    return new;
  end if;

  -- auth.uid() فارغ = service_role أو مهمة خلفية، لا مستخدم عبر الـAPI.
  -- هذا هو المخرج الذي تستعمله Edge Functions وpi-auth وhandle_new_user.
  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.email                 is distinct from old.email                 then v_changed := v_changed || 'email'::text; end if;
  if new.whatsapp_enabled      is distinct from old.whatsapp_enabled      then v_changed := v_changed || 'whatsapp_enabled'::text; end if;
  if new.is_verified           is distinct from old.is_verified           then v_changed := v_changed || 'is_verified'::text; end if;
  if new.ban_status            is distinct from old.ban_status            then v_changed := v_changed || 'ban_status'::text; end if;
  if new.ban_until             is distinct from old.ban_until             then v_changed := v_changed || 'ban_until'::text; end if;
  if new.ban_reason            is distinct from old.ban_reason            then v_changed := v_changed || 'ban_reason'::text; end if;
  if new.is_locked             is distinct from old.is_locked             then v_changed := v_changed || 'is_locked'::text; end if;
  if new.failed_login_attempts is distinct from old.failed_login_attempts then v_changed := v_changed || 'failed_login_attempts'::text; end if;
  if new.custom_role_id        is distinct from old.custom_role_id        then v_changed := v_changed || 'custom_role_id'::text; end if;
  if new.pi_uid                is distinct from old.pi_uid                then v_changed := v_changed || 'pi_uid'::text; end if;

  raise exception 'هذه الحقول لا تُعدَّل من حساب المستخدم: %', array_to_string(v_changed, ', ')
    using errcode = '42501';
end $$;

drop trigger if exists guard_profile_protected_columns on public.profiles;
create trigger guard_profile_protected_columns
  before update on public.profiles
  for each row execute function public.guard_profile_protected_columns();

-- نفس الأعمدة عند الإنشاء: user_insert_self تسمح بإدراج صف الحساب نفسه،
-- ولا شرط فيها على أي عمود. handle_new_user يعمل بلا auth.uid() فلا يتأثر.
create or replace function public.guard_profile_protected_columns_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if coalesce(new.whatsapp_enabled,false) or coalesce(new.is_verified,false)
     or new.custom_role_id is not null or new.pi_uid is not null
     or new.ban_status is not null then
    raise exception 'لا يمكن تعيين حقول الاستحقاق أو حالة الحساب عند الإنشاء'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists guard_profile_protected_columns_insert on public.profiles;
create trigger guard_profile_protected_columns_insert
  before insert on public.profiles
  for each row execute function public.guard_profile_protected_columns_insert();

-- ============================================================================
-- 3) بقية سلطة الرتبة القديمة — المواضع التي لم يغطها 025
-- ============================================================================
--
-- 025 عالج 22 سياسة تذكر 'super_user' نصًّا. لكن المسح الكامل كشف سلطة
-- إضافية تمر عبر **دالتين وسيطتين**، فلا تظهر في نص أي سياسة:
--
--   is_landing_admin()  → 3 سياسات: landing_config, landing_services, landing_leads
--                         (landing_leads = بيانات العملاء المحتملين)
--   wf_is_staff()       → 6 سياسات: wf_workflows, wf_workflow_versions,
--                         wf_node_types, wf_runs, wf_run_steps, wf_leads
--
-- وثالثة مباشرة وأخطرها لأنها تحذف بيانات:
--   run_data_retention_cleanup() → بوابتها role IN ('admin','super_user')

create or replace function public.is_landing_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$ select public.is_admin(); $$;

create or replace function public.wf_is_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$ select public.is_platform_staff(); $$;

-- تنظيف بيانات مدمّر كان متاحًا لمالك شركة. للأدمن وحده.
do $$
declare v_src text;
begin
  select regexp_replace(pg_get_functiondef(p.oid),
           'role IN \(''admin'',''super_user''\)|role IN \(''admin'', ''super_user''\)',
           $r$role = 'admin'$r$, 'g')
    into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_data_retention_cleanup' and p.prokind = 'f';

  if v_src is null then
    raise notice 'run_data_retention_cleanup غير موجودة — تخطٍّ';
  elsif v_src ~ 'super_user' then
    raise exception 'لم يُستبدل شرط الرتبة في run_data_retention_cleanup — راجع النص يدويًا';
  else
    execute v_src;
  end if;
end $$;

-- تنبيهات تيليجرام كانت تُرسَل لمن يحمل super_user: عناوين تذاكر كل العملاء
-- وأرقامها تصل لمالك شركة. المستلمون: الطاقم فقط.
do $$
declare r record; v_src text;
begin
  for r in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.prokind='f'
       and p.proname in ('check_sla_breaches','notify_admins_on_urgent_ticket','track_first_response')
  loop
    v_src := regexp_replace(pg_get_functiondef(r.oid),
               $r$role IN \('admin','super_user'\)$r$,
               $r$role IN ('admin','support')$r$, 'g');
    v_src := regexp_replace(v_src,
               $r$v_role IN \('admin', ?'super_user'\)$r$,
               $r$v_role IN ('admin','support')$r$, 'g');
    if v_src ~ '''super_user''' then
      raise exception 'بقي ذكر للرتبة القديمة في %', r.proname;
    end if;
    execute v_src;
  end loop;
end $$;

-- ============================================================================
-- 4) المحفظة والمال
-- ============================================================================
--
-- ما ثبت: مستخدم بلا صف محفظة يستطيع إنشاء صفّه بنفسه بأي رصيد.
--   insert into user_wallets(user_id,total_points,available_points,is_pro,membership_level)
--   values (<نفسه>, 9999999, 9999999, true, 'ملكي')  → ALLOWED
-- و 6 حسابات في الإنتاج بلا صف محفظة اليوم، وكل تسجيل جديد كذلك.
-- الصف موجود؟ محمي بـ UNIQUE فقط — أي حظّ لا حاجز، تمامًا كـ N9.
--
-- الإصلاح: يظل بإمكانه إنشاء محفظته (المسار المشروع) لكن **صفرية**.

drop policy if exists "wallet_insert_self" on public.user_wallets;
create policy "wallet_insert_self" on public.user_wallets
  for insert with check (
    auth.uid() = user_id
    and coalesce(total_points,0)     = 0
    and coalesce(available_points,0) = 0
    and coalesce(pending_points,0)   = 0
    and coalesce(is_pro,false)       = false
    and coalesce(is_frozen,false)    = false
  );

-- ما ثبت: طلب شحن رصيد يُدرَج بحالة 'approved' جاهزة من العميل.
-- لا محفّز يصرف المال منه اليوم (wa_wallet_adjust تتطلب طاقمًا)، لكن الطلب
-- يدخل طابور المراجعة وهو يبدو مُوافَقًا عليه بالفعل. الحالة تُقرَّر خادميًّا.
drop policy if exists "Users can create their own wallet topup requests" on public.whatsapp_wallet_topup_requests;
create policy "Users can create their own wallet topup requests" on public.whatsapp_wallet_topup_requests
  for insert with check (
    auth.uid() = user_id
    and coalesce(status,'pending') = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and rejection_reason is null
    and (ticket_id is null or exists (
          select 1 from public.tickets t
           where t.id = whatsapp_wallet_topup_requests.ticket_id
             and t.user_id = auth.uid()))
  );

-- ============================================================================
-- 5) التخزين
-- ============================================================================
--
-- ما ثبت على الإنتاج:
--   (أ) سياسة اسمها "Allow authenticated users to upload" شرطها
--       (bucket_id = 'chat-attachments') فقط، وممنوحة لـPUBLIC — أي أن
--       **زائرًا غير مسجَّل** يرفع ملفًا. جرّبناها بدور anon: ALLOWED.
--       والمستودع عام وبلا حد حجم ولا قيد نوع.
--   (ب) عميل يرفع ملفًا داخل مسار عميل آخر في tickets: ALLOWED.
--
-- ملاحظة على المسارات: مستودع tickets يحوي عرفين مختلفين معًا —
--   <ticket_id>/<file>            (عمق 2، أغلب الملفات)
--   <user_id>/<ticket_id>/<file>  (عمق 3)
-- فقاعدة «الجزء الأول = auth.uid()» وحدها كانت ستكسر العرف الأول.
-- الشرط أدناه يقبل الاثنين ولا يقبل مسار شخص آخر.

do $$
begin
  -- (أ) رفع مجهول الهوية
  -- الشرط الوحيد المطلوب هنا هو **هوية مسجَّلة**: assets/js/chat-logic.js يرفع
  -- إلى `<user_id>/<session>-<ts>.<ext>`، بينما ملفات `chat-media/…` القائمة
  -- كتبتها Edge Function بدور الخدمة (يتجاوز RLS فلا يحتاج سياسة). قصر
  -- المسار على `chat-media` كان سيكسر رفع العملاء من الواجهة.
  drop policy if exists "Allow authenticated users to upload" on storage.objects;
  create policy "Allow authenticated users to upload" on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'chat-attachments'
      and (storage.foldername(name))[1] = auth.uid()::text
    );

  -- (ب) الرفع داخل مسار عميل آخر
  drop policy if exists "Allow authenticated uploads" on storage.objects;
  create policy "Allow authenticated uploads" on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'tickets'
      and (
            (storage.foldername(name))[1] = auth.uid()::text
        or  exists (select 1 from public.tickets t
                     where t.id::text = (storage.foldername(name))[1]
                       and t.user_id  = auth.uid())
        or  public.is_platform_staff()
      )
    );

  drop policy if exists "Allow Authenticated Insert" on storage.objects;
  create policy "Allow Authenticated Insert" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'avatars');
exception
  when insufficient_privilege then
    raise warning 'لا صلاحية لتعديل سياسات storage.objects بهذا الدور — طبّقها بدور مالك التخزين';
end $$;

-- ============================================================================
-- 6) تحقق بعد التنفيذ
-- ============================================================================
do $$
declare v text;
begin
  -- لا دالة تفويض تقرأ profiles.email بعد الآن
  select string_agg(p.proname, ', ')
    into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.prokind='f'
     and p.proname in ('is_admin','is_support_user','is_platform_staff','is_landing_admin','wf_is_staff')
     and pg_get_functiondef(p.oid) ~* 'profiles[^$]*email';
  if v is not null then
    raise exception 'دوال تفويض ما زالت تقرأ profiles.email: %', v;
  end if;

  -- لا سياسة تقرأ profiles.email
  select string_agg(c.relname||'.'||pol.polname, ', ')
    into v
    from pg_policy pol join pg_class c on c.oid=pol.polrelid
    join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public'
     and (coalesce(pg_get_expr(pol.polqual,pol.polrelid),'')
        ||coalesce(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) ~* 'mad3oom\.online';
  if v is not null then
    raise exception 'سياسات ما زالت تقارن بريدًا من profiles: %', v;
  end if;

  -- لا دالة وسيطة تمنح سلطة للرتبة القديمة
  select string_agg(p.proname, ', ')
    into v
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prokind='f'
     and p.proname in ('is_landing_admin','wf_is_staff','run_data_retention_cleanup',
                       'check_sla_breaches','notify_admins_on_urgent_ticket','track_first_response')
     and pg_get_functiondef(p.oid) ~ '''super_user''';
  if v is not null then
    raise exception 'دوال ما زالت تمنح سلطة للرتبة القديمة: %', v;
  end if;

  -- المحفّزان مركّبان
  if not exists (select 1 from pg_trigger where tgname='guard_profile_protected_columns' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgname='guard_profile_protected_columns_insert' and not tgisinternal) then
    raise exception 'محفّز حماية أعمدة البروفايل غير مركّب';
  end if;

  raise notice '027: المسارات القديمة مغلقة';
end $$;
