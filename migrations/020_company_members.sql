-- ============================================================================
-- 020_company_members.sql
--   قسم "مستخدمو الشركة" داخل لوحة الشركة.
--
-- السياق
--   بعد أن توقفت رتبة super_user عن التحويل التلقائي إلى لوحة الإدارة
--   (الترحيل السابق أعاد توجيه أصحاب الشركات إلى لوحة شركتهم)، فقد مسؤول
--   الشركة مدخله إلى admin/my-users.html. الحل هنا: نفس الوظيفة داخل لوحة
--   الشركة، بلا رتبة جديدة وبلا نظام صلاحيات موازٍ.
--
-- العزل
--   الدالة لا تأخذ معرّف شركة كمُعامل — الشركة تُشتق من auth.uid() عبر
--   current_company_id()، فلا يمكن لمستخدم شركة أن يقرأ أعضاء شركة أخرى
--   مهما عدّل الطلب.
--
-- الصلاحية
--   القراءة: أي عضو في الشركة (المالك أو مستخدم فرعي تابع له).
--   الإدارة: المالك فقط، وبشرط أن تملك الشركة امتياز sub_users عبر اشتراك
--   فعّال — وهو معرَّف في plan_features لباقتَي الدعم والشاملة. أي أن الإدارة
--   مربوطة بنموذج الامتيازات نفسه، لا بقائمة أسماء باقات في الكود.
--
--   إنشاء المستخدم الفرعي نفسه يظل عبر Edge Function اسمها create-sub-user،
--   وهي تشتق التبعية من هوية المنادي ولا تقبلها من الطلب.
-- ============================================================================

create or replace function public.company_members()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_company_id uuid;
  v_owner_id   uuid;
  v_is_owner   boolean;
  v_can_manage boolean;
  v_members    jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;

  v_company_id := public.current_company_id();
  if v_company_id is null then
    return null;
  end if;

  select user_id into v_owner_id from public.companies where id = v_company_id;
  v_is_owner := (v_owner_id = auth.uid());

  -- الإدارة للمالك فقط، ومشروطة بامتياز فعلي لا باسم باقة
  v_can_manage := v_is_owner and public.company_has_feature('sub_users');

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',         m.id,
               'name',       coalesce(m.full_name, m.username, m.email),
               'email',      m.email,
               'is_owner',   (m.id = v_owner_id),
               'is_me',      (m.id = auth.uid()),
               'created_at', m.created_at
             ) order by (m.id = v_owner_id) desc, m.created_at
           ),
           '[]'::jsonb
         )
    into v_members
    from public.profiles m
   where m.id = v_owner_id
      or m.super_user_id = v_owner_id;

  return jsonb_build_object(
    'company_id', v_company_id,
    'is_owner',   v_is_owner,
    'can_manage', v_can_manage,
    'members',    v_members
  );
end;
$function$;

comment on function public.company_members() is
  'أعضاء شركة المستخدم الحالي (المالك + المستخدمين الفرعيين). بلا مُعاملات — الشركة تُشتق من auth.uid()، فلا وصول لأعضاء شركة أخرى.';

revoke all on function public.company_members() from public, anon;
grant execute on function public.company_members() to authenticated;
