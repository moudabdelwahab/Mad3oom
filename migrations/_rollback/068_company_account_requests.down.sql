-- ============================================================================
-- تراجع 068_company_account_requests
--
-- بيرجّع guard_profile_role_change و upsert_my_company لنص الإنتاج حرفيًا
-- (منقول آليًا من tests/fixtures/prod-shape، 2026-10-07)، وبيرجّع سياسة الإدراج
-- الذاتي على companies، وبيشيل جدول الطلبات ودواله.
--
-- بيسيب (عن قصد — مفيش حذف بيانات):
--   • الشركات اللي اتوافق عليها وأدوار company_admin المشتقة منها.
--   • profiles.user_type = 'company' لأصحابها.
--   • الإشعارات المرسلة.
-- ⚠️ بعده: الطلبات قيد المراجعة بتضيع مع الجدول (صدّرها الأول لو فيه طلبات)،
--    ونموذج «شركة» في صفحة الاشتراك يرجع يفشل زي ما كان قبل 068.
-- ============================================================================

drop function if exists public.admin_review_company_account_request(uuid, text, text);
drop function if exists public.admin_list_company_account_requests();
drop function if exists public.my_company_account_request();
drop function if exists public.submit_company_account_request(text, text, date, text, text, text, text);
drop table if exists public.company_account_requests;

drop policy if exists "Users can insert their own company" on public.companies;
create policy "Users can insert their own company" on public.companies
  as permissive for insert to public with check ((user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.guard_profile_role_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

revoke all on function public.guard_profile_role_change() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.upsert_my_company(p_company_name text, p_commercial_registration_number text, p_commercial_registration_expiry date, p_company_email text DEFAULT NULL::text, p_company_phone text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_tax_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid        uuid := auth.uid();
  v_name       text := nullif(btrim(coalesce(p_company_name, '')), '');
  v_cr         text := nullif(btrim(coalesce(p_commercial_registration_number, '')), '');
  v_existing   uuid;
  v_member_of  uuid;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا';
  end if;

  if v_name is null or char_length(v_name) < 2 then
    raise exception 'اسم الشركة مطلوب';
  end if;

  if v_cr is null or char_length(v_cr) < 3 then
    raise exception 'رقم السجل التجاري مطلوب';
  end if;

  if p_commercial_registration_expiry is null then
    raise exception 'تاريخ انتهاء السجل التجاري مطلوب';
  end if;

  select id into v_existing from public.companies where user_id = v_uid;

  if v_existing is null then
    -- عضو في شركة قائمة (مستخدم فرعي) لا ينشئ شركة موازية
    v_member_of := public.current_company_id();
    if v_member_of is not null then
      raise exception 'حسابك عضو في شركة قائمة بالفعل';
    end if;

    -- رقم السجل التجاري فريد على مستوى المنصة (قيد UNIQUE موجود أصلًا).
    -- الفحص هنا لإعطاء رسالة عربية واضحة بدل خطأ قاعدة بيانات خام.
    if exists (select 1 from public.companies where commercial_registration_number = v_cr) then
      raise exception 'رقم السجل التجاري مسجل بالفعل';
    end if;

    insert into public.companies (
      user_id, company_name, commercial_registration_number,
      commercial_registration_expiry, company_email, company_phone,
      address, city, country, tax_id
    ) values (
      v_uid, v_name, v_cr,
      p_commercial_registration_expiry, nullif(btrim(coalesce(p_company_email, '')), ''),
      nullif(btrim(coalesce(p_company_phone, '')), ''),
      nullif(btrim(coalesce(p_address, '')), ''),
      nullif(btrim(coalesce(p_city, '')), ''),
      nullif(btrim(coalesce(p_country, '')), ''),
      nullif(btrim(coalesce(p_tax_id, '')), '')
    )
    returning id into v_existing;

    return v_existing;
  end if;

  if exists (
    select 1 from public.companies
     where commercial_registration_number = v_cr and id <> v_existing
  ) then
    raise exception 'رقم السجل التجاري مسجل بالفعل';
  end if;

  update public.companies
     set company_name                   = v_name,
         commercial_registration_number = v_cr,
         commercial_registration_expiry = p_commercial_registration_expiry,
         company_email = coalesce(nullif(btrim(coalesce(p_company_email, '')), ''), company_email),
         company_phone = coalesce(nullif(btrim(coalesce(p_company_phone, '')), ''), company_phone),
         address       = coalesce(nullif(btrim(coalesce(p_address, '')), ''), address),
         city          = coalesce(nullif(btrim(coalesce(p_city, '')), ''), city),
         country       = coalesce(nullif(btrim(coalesce(p_country, '')), ''), country),
         tax_id        = coalesce(nullif(btrim(coalesce(p_tax_id, '')), ''), tax_id)
   where id = v_existing;

  return v_existing;
end;
$function$
;

comment on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) is
  'إنشاء أو تحديث شركة المستخدم الحالي. المالك فقط يعدّل؛ العضو الفرعي يُرفض. لا تأخذ معرّف شركة كمُعامل.';
revoke all on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) from public, anon;
grant execute on function public.upsert_my_company(text, text, date, text, text, text, text, text, text) to authenticated;
