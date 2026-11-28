-- ============================================================================
-- 152_company_members_display_name.down — تراجع 152
--   يعيد company_members() إلى نسخة 096 حرفيًا (الاسم من profiles فقط).
-- ============================================================================

create or replace function public.company_members()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
-- 085_company_members_privacy: القائمة الكاملة لمدير الشركة وحده. 096: المصدر العضويات النشطة.
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
             'name', coalesce(m.full_name, m.username, m.email),
             'email', m.email,
             'role', case when m.id = v_owner_id then 'company_admin' else 'company_user' end,
             'is_owner', (m.id = v_owner_id),
             'is_me', (m.id = auth.uid()),
             'created_at', m.created_at
           ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
      into v_members
      from public.profiles m
     where m.id = v_owner_id
        or exists (select 1 from public.company_memberships cm
                    where cm.company_id = v_company_id and cm.user_id = m.id and cm.status = 'active');
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'name', case when m.id = auth.uid() then coalesce(m.full_name, m.username, m.email)
                          else coalesce(m.full_name, m.username, 'مدير الشركة') end,
             'email', case when m.id = auth.uid() then m.email end,
             'role', case when m.id = v_owner_id then 'company_admin' else 'company_user' end,
             'is_owner', (m.id = v_owner_id),
             'is_me', (m.id = auth.uid()),
             'created_at', m.created_at
           ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
      into v_members
      from public.profiles m
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
