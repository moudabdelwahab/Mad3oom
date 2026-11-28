-- ============================================================================
-- 152_company_members_display_name
--   • company_members() (096): اسم كل عضو يفضّل «اسم العرض» المحلي للشركة
--     (company_member_profiles.display_name) على اسم الحساب، فيسقط على
--     profiles.full_name ثم username ثم البريد كما قبل.
--     كان التفاصيل (company_member_details, 113) تعرض اسم العرض بينما القائمة
--     (#users) لا تعرفه أصلًا — فتعديل «اسم العرض» و«المسمى» من التفاصيل لا
--     يظهر في القائمة أبدًا حتى بعد إعادة القراءة. الربط على الشركتين معًا
--     (company_id + user_id) حتى لا يتسرب اسم عرض من شركة أخرى للعضو نفسه.
--   • لا يمس أي دالة أخرى ولا الجداول ولا الامتيازات ولا نطاق الرؤية (v_full
--     كما هو في 096/085): غير المدير ما زال يرى نفسه ومديره فقط، وبنفس
--     إخفاء البريد. اسم العرض بيانات تضعها الشركة نفسها، فعرضه على أعضائها
--     من نفس فئة عرض full_name.
--   • التراجع: migrations/_rollback/152_company_members_display_name.down.sql
--     (يعيد نسخة 096 حرفيًا).
-- ============================================================================

create or replace function public.company_members()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
-- 085_company_members_privacy: القائمة الكاملة لمدير الشركة وحده. 096: المصدر العضويات النشطة.
-- 152: الاسم يفضّل اسم العرض المحلي للشركة (company_member_profiles.display_name).
declare
  v_company_id uuid;
  v_owner_id   uuid;
  v_full       boolean;
  v_members    jsonb;
begin
  if auth.uid() is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select user_id into v_owner_id from public.companies where id = v_company_id;

  v_full := v_owner_id = auth.uid()
        and coalesce(public.is_company_admin(), false)
        and coalesce(public.account_is_active(), false)
        and not coalesce(public.preview_mode(), true);

  -- الدور نسبةً لهذه الشركة لا رتبة الحساب: رتبة company_user لعضو إضافي كانت ستكشف أن له
  -- شركة أساسية أخرى. القيم نفسها لكل عضو قبل 096 (مالك = company_admin، تابع = company_user).
  if v_full then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'name', coalesce(cp.display_name, m.full_name, m.username, m.email),
             'email', m.email,
             'role', case when m.id = v_owner_id then 'company_admin' else 'company_user' end,
             'is_owner', (m.id = v_owner_id),
             'is_me', (m.id = auth.uid()),
             'created_at', m.created_at
           ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
      into v_members
      from public.profiles m
      left join public.company_member_profiles cp
        on cp.company_id = v_company_id and cp.user_id = m.id
     where m.id = v_owner_id
        or exists (select 1 from public.company_memberships cm
                    where cm.company_id = v_company_id and cm.user_id = m.id and cm.status = 'active');
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'name', case when m.id = auth.uid() then coalesce(cp.display_name, m.full_name, m.username, m.email)
                          else coalesce(cp.display_name, m.full_name, m.username, 'مدير الشركة') end,
             'email', case when m.id = auth.uid() then m.email end,
             'role', case when m.id = v_owner_id then 'company_admin' else 'company_user' end,
             'is_owner', (m.id = v_owner_id),
             'is_me', (m.id = auth.uid()),
             'created_at', m.created_at
           ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
      into v_members
      from public.profiles m
      left join public.company_member_profiles cp
        on cp.company_id = v_company_id and cp.user_id = m.id
     where m.id = v_owner_id
        or (m.id = auth.uid()
            and exists (select 1 from public.company_memberships cm
                         where cm.company_id = v_company_id and cm.user_id = m.id and cm.status = 'active'));
  end if;

  return jsonb_build_object(
    'company_id', v_company_id,
    'company_role', public.company_role(),
    'is_owner', (v_owner_id = auth.uid()),
    'can_manage', public.can_manage_company_members(),
    'scope', case when v_full then 'full' else 'self' end,
    'members', v_members);
end;
$$;
