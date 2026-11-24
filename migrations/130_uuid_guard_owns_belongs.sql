-- ============================================================================
-- 130_uuid_guard_owns_belongs.sql
--   P0 — إغلاق ثغرة عزل المستأجرين في owns_a_company() وbelongs_to_a_company().
--
-- ما كان قائمًا (035_company_roles.sql، السطور ~159-192):
--   owns_a_company(p_user_id uuid default auth.uid()) و
--   belongs_to_a_company(p_user_id uuid default auth.uid())، كلتاهما
--   SECURITY DEFINER وممنوحتان لـ authenticated، وتعيدان علاقة **أي** مستخدم
--   يُمرَّر لهما. فأي مستخدم موثَّق كان يستطيع تمرير أي UUID واستكشاف:
--   هل يملك هذا الحساب شركة؟ وهل هو عضو في شركة؟ — أي استكشاف وجود علاقات
--   حسابات أخرى، مع أن الدالتين هما اللبنة التي تُبنى عليها الرتب (035:
--   is_company_admin / is_company_member) ونوع الحساب (095/096).
--   هذه هي المتابعة المنفصلة التي نصّ عليها 127 صراحةً («خارج نطاق هذا
--   الترحيل؛ تُرفَعان كمتابعة منفصلة»).
--
-- لماذا ليس نسخة حرفية من 127 — ما كشفه تدقيق المستدعين قبل الكتابة:
--   عكس company_of()، لهاتين الدالتين مستدعون حيّون يمرّرون معرّف مستخدم
--   غير المتصل، ولو وُضع حارس 127 عليهما حرفيًا لانكسروا بصمت:
--   • company_invite_customer (112، ثم 096): ‏`not owns_a_company(p.id)`‏
--     حيث p.id هو المدعوّ المرشَّح، والمتصل مدير شركة (ليس مالك منصة ولا
--     إداريًا) — الحارس الساذج كان سيعيد false دائمًا فيصفّي شرط الاستبعاد،
--     فيصير مالك شركة قابلًا للدعوة عضوًا في شركة أخرى.
--   • محفّزا المزامنة (035): ‏sync_company_role (owns_a_company(new.id))‏
--     وsync_company_owner_role (owns_a_company(old.user_id)) و
--     guard_profile_role_change (068) — new.id / old.user_id هما الحساب
--     محل الكتابة، لا المتصل بالضرورة (إدخال شركة من جلسة مالك، أو إنشاء
--     ملف من service_role بلا JWT) — الحارس الساذج كان سيُسقط رتبة
--     company_admin إلى user عند مزامنة الملف.
--   • _hierarchy_eligible (099): ‏owns_a_company(p_user)‏ حيث p_user هو
--     المرشَّح لدور إداري، ويُستدعى من محفّزات (099/103) ومن مراجعة (100).
--   أما المستدعون عن النفس (095/096 my_account_kind، 038/040، 068
--   submit، 096/112 قبول الدعوة، 035 is_company_admin/member) فيمرّرون
--   auth.uid() نفسه، فيمرّون عبر الحارس بلا تغيير — لا حاجة لمسّهم.
--
-- ما يفعله
--   1) دالتان داخليتان جديدتان _owns_a_company(uuid) و
--      _belongs_to_a_company(uuid) بالمنطق الأصلي من 035 حرفيًا، بلا منح
--      لـ authenticated (revoke من public وanon وauthenticated) — فلا
--      يستدعيهما إلا كود الخادم (دوال SECURITY DEFINER ومحفّزاتها).
--   2) الدالتان العامتان بحارس 127 نفسه: السؤال عن مستخدم آخر يعيد false
--      بصمت — لا يُكشَف وجود العلاقة ولا يُرفَع خطأ يسرّب معلومات — ما لم
--      يكن المتصل مالك المنصة (is_platform_owner()) أو إداريًا (is_admin())
--      أو service_role. الدعم ليس إداريًا هنا عمدًا، كما في 127. السؤال عن
--      النفس (أو بلا مُعامل) بلا أي تغيير في السلوك — نفس الاستعلام حرفيًا.
--   3) إعادة تعريف المستدعين العابرين للحسابات الخمسة على الداخليتين،
--      بأجسامهم الأصلية حرفيًا عدا اسم الدالة المستدعاة:
--      sync_company_role وsync_company_owner_role (035)،
--      guard_profile_role_change (068، آخر تعريف لها)،
--      company_invite_customer (112، آخر تعريف لها؛ 096 سبقته)،
--      _hierarchy_eligible (099).
--      الاستدعاءات عن النفس في باقي الترحيلات لا تُمسّ.
--
-- ما لا يفعله
--   • لا يغيّر التوقيع ولا المنح ولا التقلّب (stable) ولا SECURITY DEFINER
--     للدالتين العامتين.
--   • لا يمسّ is_company_admin() / is_company_member() — تناديان عن النفس.
--   • لا يمسّ admin_review_company_account_request (068): تبدأ بـ
--     is_admin() أصلًا، فالمراجِع إداري ويمرّ عبر الاستثناء.
--   • لا ينشئ مسار تجاوز عامًا: الداخليتان بلا منح لـ authenticated،
--     فلا يستدعيهما مستخدم من PostgREST مباشرةً.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/130_uuid_guard_owns_belongs.down.sql
--   (يعيد تعريف 035 حرفيًا — أي يعيد الثغرة؛ يُستعمل فقط للتراجع الطارئ).
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regprocedure('public.is_platform_owner()') is null then
    raise exception '130 يتطلب public.is_platform_owner() (038)';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception '130 يتطلب public.is_admin() (040)';
  end if;
  if to_regprocedure('public.owns_a_company(uuid)') is null then
    raise exception '130 يتطلب public.owns_a_company(uuid) (035)';
  end if;
  if to_regprocedure('public.belongs_to_a_company(uuid)') is null then
    raise exception '130 يتطلب public.belongs_to_a_company(uuid) (035)';
  end if;
end $$;


-- ============================================================================
-- 1) الداخليتان — منطق 035 حرفيًا، بلا منح للمستخدمين الموثَّقين
-- ============================================================================
create or replace function public._owns_a_company(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and exists (select 1 from public.companies c where c.user_id = p_user_id);
$$;

comment on function public._owns_a_company(uuid) is
  '130: داخلية — منطق owns_a_company الأصلي (035) بلا حارس. للمستدعين '
  'من كود الخادم فقط (محفّزات ودوال SECURITY DEFINER)؛ بلا منح لـ authenticated.';

revoke all on function public._owns_a_company(uuid) from public, anon, authenticated;

create or replace function public._belongs_to_a_company(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and exists (
           select 1
             from public.profiles p
             join public.companies c on c.user_id = p.super_user_id
            where p.id = p_user_id
         );
$$;

comment on function public._belongs_to_a_company(uuid) is
  '130: داخلية — منطق belongs_to_a_company الأصلي (035) بلا حارس. '
  'للمستدعين من كود الخادم فقط؛ بلا منح لـ authenticated.';

revoke all on function public._belongs_to_a_company(uuid) from public, anon, authenticated;


-- ============================================================================
-- 2) الدالتان العامتان — حارس المتصل قبل الرد عن مستخدم آخر
-- ============================================================================
--
-- القاعدة: عن النفس (أو بلا مُعامل) كما كان؛ عن غيرك false ما لم تكن مالك
-- المنصة أو إداريًا أو service_role. false بصمت لا خطأ: الخطأ نفسه يسرّب
-- أن المستخدم المستهدَف موجود وله علاقة شركة.
create or replace function public.owns_a_company(p_user_id uuid default auth.uid())
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if p_user_id is null then
    return false;
  end if;

  -- is distinct from: يتعامل مع auth.uid() الفارغ (anon بلا JWT) كتمايز،
  -- فلا يمرّ مجهول الهوية بسؤال عن غيره.
  if p_user_id is distinct from auth.uid()
     and not coalesce(public.is_platform_owner(), false)
     and not coalesce(public.is_admin(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    return false;
  end if;

  -- الاستعلام الأصلي من 035 حرفيًا.
  return (
    select p_user_id is not null
       and exists (select 1 from public.companies c where c.user_id = p_user_id)
  );
end;
$$;

comment on function public.owns_a_company(uuid) is
  '130: هل يملك هذا الحساب شركة؟ عن النفس (أو بلا مُعامل) كما كان؛ عن '
  'مستخدم آخر false بصمت ما لم يكن المتصل مالك المنصة (is_platform_owner) '
  'أو إداريًا (is_admin) أو service_role. كود الخادم العابر للحسابات '
  'يستدعي _owns_a_company.';

-- المنح كما هي في 035 بلا تغيير.
revoke all on function public.owns_a_company(uuid) from public, anon;
grant execute on function public.owns_a_company(uuid) to authenticated;

create or replace function public.belongs_to_a_company(p_user_id uuid default auth.uid())
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if p_user_id is null then
    return false;
  end if;

  if p_user_id is distinct from auth.uid()
     and not coalesce(public.is_platform_owner(), false)
     and not coalesce(public.is_admin(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    return false;
  end if;

  -- الاستعلام الأصلي من 035 حرفيًا.
  return (
    select p_user_id is not null
       and exists (
             select 1
               from public.profiles p
               join public.companies c on c.user_id = p.super_user_id
              where p.id = p_user_id
           )
  );
end;
$$;

comment on function public.belongs_to_a_company(uuid) is
  '130: هل هذا الحساب عضو في شركة؟ عن النفس (أو بلا مُعامل) كما كان؛ عن '
  'مستخدم آخر false بصمت ما لم يكن المتصل مالك المنصة أو إداريًا أو '
  'service_role. كود الخادم العابر للحسابات يستدعي _belongs_to_a_company.';

-- المنح كما هي في 035 بلا تغيير.
revoke all on function public.belongs_to_a_company(uuid) from public, anon;
grant execute on function public.belongs_to_a_company(uuid) to authenticated;


-- ============================================================================
-- 3) محفّزا المزامنة (035) — على الداخليتين، والجسم كما كان حرفيًا عدا ذلك
-- ============================================================================
create or replace function public.sync_company_role()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_target text;
begin
  -- رتب المنصة لا تُمسّ إطلاقًا: أدمن يملك شركة يظل أدمن.
  if coalesce(new.role, '') in ('platform_owner', 'admin', 'support') then
    return new;
  end if;

  if public._owns_a_company(new.id) then
    v_target := 'company_admin';
  elsif new.super_user_id is not null
        and exists (select 1 from public.companies c where c.user_id = new.super_user_id) then
    v_target := 'company_user';
  elsif coalesce(new.role, '') in ('company_admin', 'company_user') then
    -- انقطعت العلاقة: الدور يسقط معها، ولا يبقى دور شركة بلا شركة.
    v_target := 'user';
  else
    return new;
  end if;

  new.role := v_target;
  return new;
end;
$$;

revoke all on function public.sync_company_role() from public, anon, authenticated;

create or replace function public.sync_company_owner_role()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.profiles
     set role = 'company_admin'
   where id = new.user_id
     and coalesce(role, '') not in ('platform_owner', 'admin', 'support')
     and coalesce(role, '') is distinct from 'company_admin';

  -- نُقل المِلك من حساب لآخر: المالك السابق يفقد الدور إن لم يعد يملك شيئًا.
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    update public.profiles
       set role = 'user'
     where id = old.user_id
       and coalesce(role, '') = 'company_admin'
       and not public._owns_a_company(old.user_id);
  end if;

  return new;
end;
$$;

revoke all on function public.sync_company_owner_role() from public, anon, authenticated;

-- ============================================================================
-- 4) حارس تغيير الرتب (068، آخر تعريف له) — على الداخليتين
-- ============================================================================
create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;
  if auth.uid() is null then
    return new;
  end if;
  if exists (select 1 from public.platform_authority a
              where a.user_id = new.id and a.level = 'owner') then
    raise exception 'رتبة مالك المنصة ثابتة ولا تُغيَّر من جلسة'
      using errcode = '42501';
  end if;
  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;
  if new.role = 'platform_owner' then
    raise exception 'رتبة مالك المنصة لا تُمنح من أي جلسة' using errcode = '42501';
  end if;
  if new.role in ('company_admin', 'company_user') then
    if pg_trigger_depth() > 1
       and new.role = (case
                         when public._owns_a_company(new.id)       then 'company_admin'
                         when public._belongs_to_a_company(new.id) then 'company_user'
                       end) then
      return new;
    end if;
    raise exception 'أدوار الشركة تُشتق من العلاقة بالشركة ولا تُمنَح يدويًا'
      using errcode = '42501';
  end if;
  if new.role = 'admin' or old.role = 'admin'
     or exists (select 1 from public.platform_authority a where a.user_id = new.id) then
    if public.owner_critical_ok() then return new; end if;
    raise exception 'منح رتبة الإدارة أو سحبها لمالك المنصة وحده بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if new.role = 'support' or old.role = 'support' then
    if public.owner_critical_ok() or public.has_capability('staff.support') then
      return new;
    end if;
    raise exception 'إدارة فريق الدعم تتطلب تفويضًا من مالك المنصة' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_profile_role_change() from public, anon, authenticated;

-- ============================================================================
-- 5) دعوة العميل (112، آخر تعريف لها) — على الداخلية
-- ============================================================================
create or replace function public.company_invite_customer(p_email text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_invitee uuid;
  v_inv     uuid;
  v_name    text;
begin
  perform public._membership_require_multi();
  v_company := public._company_staff_require_manager();
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 320 then
    raise exception 'بريد إلكتروني غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if (select count(*) from public.company_membership_invitations
       where company_id = v_company and status = 'pending') >= 200 then
    raise exception 'دعوات معلّقة كثيرة — ألغِ بعضها أولًا' using errcode = '54000';
  end if;
  -- 112: الدعوة المعلّقة نفسها للبريد نفسه (لا صف ثانٍ؛ إعادة الإرسال تمر بها)
  select id into v_inv from public.company_membership_invitations
   where company_id = v_company and lower(invited_email) = v_email and status = 'pending'
     and expires_at > now();
  if v_inv is not null then
    return jsonb_build_object('status', 'pending', 'invitation_id', v_inv, 'existing', true);
  end if;
  -- معلّقة منتهية: تُغلق فتُفسح للفهرس الفريد دعوة جديدة
  update public.company_membership_invitations set status = 'expired', responded_at = now()
   where company_id = v_company and lower(invited_email) = v_email and status = 'pending' and expires_at <= now();

  select p.id into v_invitee from public.profiles p
   where lower(p.email) = v_email
     and coalesce(p.role, '') not in ('platform_owner', 'admin', 'support')
     and not public._owns_a_company(p.id)
     and not public._company_member_active(v_company, p.id)
   limit 1;

  insert into public.company_membership_invitations (company_id, invited_email, invitee_user_id, invited_by)
  values (v_company, v_email, v_invitee, auth.uid())
  returning id into v_inv;

  if v_invitee is not null then
    select company_name into v_name from public.companies where id = v_company;
    perform public._membership_event(v_company, v_invitee, 'invited', jsonb_build_object('invitation_id', v_inv));
    insert into public.notifications (user_id, title, message, type, link, category)
    values (v_invitee, 'دعوة للانضمام إلى شركة',
            'دعتك شركة «' || coalesce(v_name, '') || '» لتكون من عملائها. راجع الدعوة في بوابة العملاء.',
            'info', '/portal/#invitations', 'account');
  end if;
  return jsonb_build_object('status', 'pending', 'invitation_id', v_inv, 'existing', false);
end
$function$;

-- المنح كما هي في 112 بلا تغيير.
revoke all on function public.company_invite_customer(text) from public, anon;
grant execute on function public.company_invite_customer(text) to authenticated;


-- ============================================================================
-- 6) أهلية الدور الإداري (099) — على الداخلية
-- ============================================================================
create or replace function public._hierarchy_eligible(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user is not null
     and exists (select 1 from public.profiles p where p.id = p_user and p.role in ('admin', 'support')
                   and coalesce(p.ban_status, 'none') = 'none')
     and not coalesce(public._owns_a_company(p_user), false)
     and not exists (select 1 from public.company_memberships m where m.user_id = p_user and m.status = 'active')
     and not exists (select 1 from public.company_staff s where s.user_id = p_user and s.revoked_at is null);
$$;

-- ============================================================================
-- 7) تحقق ذاتي — بنيوي فقط (بلا بيانات بذور هنا)
-- ============================================================================
-- السلوك يُثبَت في tests/sql/uuid-guard-owns-belongs.test.sql. هنا نثبّت فقط
-- أن الحارس والداخليتين وإعادة التوجيه موجودة في التعريفات، وأن الخصائص
-- البنيوية لم تتغير.
do $$
declare
  v_def text;
begin
  -- الحارس في الدالتين العامتين.
  v_def := pg_get_functiondef('public.owns_a_company(uuid)'::regprocedure);
  if v_def not like '%is distinct from auth.uid()%' then
    raise exception '130: حارس التمايز عن auth.uid() غائب من owns_a_company()';
  end if;
  if v_def not like '%is_platform_owner()%' or v_def not like '%is_admin()%' then
    raise exception '130: استثناء الامتياز (owner/admin) غائب من owns_a_company()';
  end if;
  if v_def not like '%service_role%' then
    raise exception '130: مسار service_role غائب من owns_a_company()';
  end if;
  v_def := pg_get_functiondef('public.belongs_to_a_company(uuid)'::regprocedure);
  if v_def not like '%is distinct from auth.uid()%' then
    raise exception '130: حارس التمايز عن auth.uid() غائب من belongs_to_a_company()';
  end if;
  if v_def not like '%is_platform_owner()%' or v_def not like '%is_admin()%' then
    raise exception '130: استثناء الامتياز (owner/admin) غائب من belongs_to_a_company()';
  end if;

  -- الداخليتان بلا حارس (منطق 035 حرفيًا) وبلا منح لـ authenticated.
  v_def := pg_get_functiondef('public._owns_a_company(uuid)'::regprocedure);
  if v_def like '%is distinct from auth.uid()%' then
    raise exception '130: _owns_a_company() يجب أن تبقى بلا حارس (لكود الخادم)';
  end if;
  if has_function_privilege('authenticated', 'public._owns_a_company(uuid)', 'EXECUTE') then
    raise exception '130: _owns_a_company() ممنوحة لـ authenticated — يجب سحبها';
  end if;
  if has_function_privilege('authenticated', 'public._belongs_to_a_company(uuid)', 'EXECUTE') then
    raise exception '130: _belongs_to_a_company() ممنوحة لـ authenticated — يجب سحبها';
  end if;

  -- المستدعون العابرون للحسابات أُعيد توجيههم إلى الداخليتين.
  if pg_get_functiondef('public.sync_company_role()'::regprocedure) not like '%_owns_a_company(new.id)%' then
    raise exception '130: sync_company_role() لم تُعَد إلى _owns_a_company()';
  end if;
  if pg_get_functiondef('public.sync_company_owner_role()'::regprocedure) not like '%_owns_a_company(old.user_id)%' then
    raise exception '130: sync_company_owner_role() لم تُعَد إلى _owns_a_company()';
  end if;
  if pg_get_functiondef('public.guard_profile_role_change()'::regprocedure) not like '%_owns_a_company(new.id)%'
     or pg_get_functiondef('public.guard_profile_role_change()'::regprocedure) not like '%_belongs_to_a_company(new.id)%' then
    raise exception '130: guard_profile_role_change() لم تُعَد إلى الداخليتين';
  end if;
  if pg_get_functiondef('public.company_invite_customer(text)'::regprocedure) not like '%_owns_a_company(p.id)%' then
    raise exception '130: company_invite_customer() لم تُعَد إلى _owns_a_company()';
  end if;
  if pg_get_functiondef('public._hierarchy_eligible(uuid)'::regprocedure) not like '%_owns_a_company(p_user)%' then
    raise exception '130: _hierarchy_eligible() لم تُعَد إلى _owns_a_company()';
  end if;

  -- الخصائص البنيوية للدالتين العامتين كما كانت.
  if not (select prosecdef from pg_proc where oid = 'public.owns_a_company(uuid)'::regprocedure) then
    raise exception '130: owns_a_company() لم تعد SECURITY DEFINER';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.belongs_to_a_company(uuid)'::regprocedure) then
    raise exception '130: belongs_to_a_company() لم تعد SECURITY DEFINER';
  end if;
  if (select provolatile from pg_proc where oid = 'public.owns_a_company(uuid)'::regprocedure) <> 's' then
    raise exception '130: owns_a_company() لم تعد STABLE';
  end if;
  if (select provolatile from pg_proc where oid = 'public.belongs_to_a_company(uuid)'::regprocedure) <> 's' then
    raise exception '130: belongs_to_a_company() لم تعد STABLE';
  end if;
end $$;
