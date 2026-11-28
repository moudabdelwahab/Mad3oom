-- ============================================================================
-- 153_hr_settings_employee_number_next
--   • hr_settings_update() (143): معامل جديد p_employee_number_next
--     (يُلحق في النهاية حتى تبقى الاستدعاءات الموضعية القديمة صالحة) يضبط
--     عدّاد الترقيم التلقائي الذي يقرأه hr_employee_create. بدونه كان نموذج
--     «يبدأ الترقيم من» في لوحة الشركة يرسل p_start_from — معامل غير موجود
--     — فيفشل الحفظ كله بخطأ PostgREST «Could not find the function»، وكان
--     يقرأ s.employee_number_start_from الذي لا يرجعه hr_settings_get أصلًا.
--     القيمة 1 حدًا أدنى (CHECK في الجدول)؛ null تعني «بلا تغيير».
--   • لا يمس أي دالة أخرى ولا الجداول ولا الامتيازات؛ توقيع 143 الأصلي
--     بأربعة معاملات ما زال يعمل كما هو (المعامل الجديد افتراضي null).
--     إسقاط توقيع 143 أولًا لأن CREATE OR REPLACE لا يستبدل توقيعًا مختلفًا
--     بل ينشئ نسخة ثانية، فيصبح الاستدعاء الموضعي القصير ملتبسًا
--     («function ... is not unique»)؛ والمنح يُعاد على التوقيع الجديد كما
--     في 143 (authenticated وحده).
--   • التراجع: migrations/_rollback/153_hr_settings_employee_number_next.down.sql
--     (يسقط التوقيع الخماسي ثم يعيد نسخة 143 حرفيًا مع منحها).
-- ============================================================================

-- إسقاط توقيع 143 (4 معاملات) قبل إنشاء التوقيع الجديد (5 معاملات).
drop function if exists public.hr_settings_update(text, integer, integer, jsonb);

create or replace function public.hr_settings_update(p_employee_number_prefix text default null,
                                                    p_default_probation_months integer default null,
                                                    p_audit_retention_months integer default null,
                                                    p_settings jsonb default null,
                                                    p_employee_number_next integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  s         public.hr_settings;
  v_prefix  text;
  v_prob    int;
  v_ret     int;
  v_set     jsonb;
  v_next    int;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.settings.manage') then
    raise exception 'لا تملك صلاحية إعدادات الموارد البشرية' using errcode = '42501';
  end if;
  insert into public.hr_settings (company_id) values (v_company)
    on conflict (company_id) do nothing;
  select * into s from public.hr_settings where company_id = v_company;
  v_prefix := case when p_employee_number_prefix is null then s.employee_number_prefix else btrim(p_employee_number_prefix) end;
  v_prob := coalesce(p_default_probation_months, s.default_probation_months);
  v_ret := coalesce(p_audit_retention_months, s.audit_retention_months);
  v_set := case when p_settings is null then s.settings else s.settings || p_settings end;
  v_next := coalesce(p_employee_number_next, s.employee_number_next);
  if char_length(v_prefix) > 10 then
    raise exception 'بادئة الرقم الوظيفي 10 أحرف حدًا أقصى' using errcode = '22023';
  end if;
  if v_prob < 0 or v_prob > 12 then
    raise exception 'فترة التجربة الافتراضية بين 0 و12 شهرًا' using errcode = '22023';
  end if;
  if v_ret < 6 or v_ret > 120 then
    raise exception 'مدة الاحتفاظ بالسجل بين 6 و120 شهرًا' using errcode = '22023';
  end if;
  if v_next < 1 then
    raise exception 'الترقيم يبدأ من 1 على الأقل' using errcode = '22023';
  end if;
  update public.hr_settings set
    employee_number_prefix = v_prefix, default_probation_months = v_prob,
    audit_retention_months = v_ret, settings = v_set, employee_number_next = v_next,
    updated_by = auth.uid()
  where company_id = v_company;
  perform public._hr_audit(v_company, 'settings.changed', 'settings', v_company, null,
    jsonb_build_object('employee_number_prefix', s.employee_number_prefix,
      'default_probation_months', s.default_probation_months, 'audit_retention_months', s.audit_retention_months,
      'employee_number_next', s.employee_number_next),
    jsonb_build_object('employee_number_prefix', v_prefix,
      'default_probation_months', v_prob, 'audit_retention_months', v_ret,
      'employee_number_next', v_next), null);
  return public.hr_settings_get();
end $$;

-- المنح كما في 143 §13: authenticated وحده (الإسقاط أزال منح التوقيع القديم).
revoke all on function public.hr_settings_update(text, integer, integer, jsonb, integer) from public, anon;
grant execute on function public.hr_settings_update(text, integer, integer, jsonb, integer) to authenticated;
