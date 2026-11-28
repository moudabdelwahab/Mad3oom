-- ============================================================================
-- 153_hr_settings_employee_number_next.down — تراجع 153
--   يعيد hr_settings_update() إلى نسخة 143 حرفيًا (بلا معامل عدّاد الترقيم).
--   يسقط التوقيع الخماسي أولًا ثم يعيد إنشاء الرباعي مع منحه، وإلا بقي
--   توقيعان (التراجع نفسه كان سيترك الغموض قائمًا).
-- ============================================================================

-- إسقاط توقيع 153 (5 معاملات) قبل إعادة إنشاء توقيع 143 (4 معاملات).
drop function if exists public.hr_settings_update(text, integer, integer, jsonb, integer);

create or replace function public.hr_settings_update(p_employee_number_prefix text default null,
                                                    p_default_probation_months integer default null,
                                                    p_audit_retention_months integer default null,
                                                    p_settings jsonb default null)
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
  if char_length(v_prefix) > 10 then
    raise exception 'بادئة الرقم الوظيفي 10 أحرف حدًا أقصى' using errcode = '22023';
  end if;
  if v_prob < 0 or v_prob > 12 then
    raise exception 'فترة التجربة الافتراضية بين 0 و12 شهرًا' using errcode = '22023';
  end if;
  if v_ret < 6 or v_ret > 120 then
    raise exception 'مدة الاحتفاظ بالسجل بين 6 و120 شهرًا' using errcode = '22023';
  end if;
  update public.hr_settings set
    employee_number_prefix = v_prefix, default_probation_months = v_prob,
    audit_retention_months = v_ret, settings = v_set, updated_by = auth.uid()
  where company_id = v_company;
  perform public._hr_audit(v_company, 'settings.changed', 'settings', v_company, null,
    jsonb_build_object('employee_number_prefix', s.employee_number_prefix,
      'default_probation_months', s.default_probation_months, 'audit_retention_months', s.audit_retention_months),
    jsonb_build_object('employee_number_prefix', v_prefix,
      'default_probation_months', v_prob, 'audit_retention_months', v_ret), null);
  return public.hr_settings_get();
end $$;

-- المنح كما في 143 §13: authenticated وحده.
revoke all on function public.hr_settings_update(text, integer, integer, jsonb) from public, anon;
grant execute on function public.hr_settings_update(text, integer, integer, jsonb) to authenticated;
