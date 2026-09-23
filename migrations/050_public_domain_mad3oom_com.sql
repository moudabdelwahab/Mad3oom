-- 050: روابط الفواتير العامة على mad3oom.com
--
-- النطاق mad3oom.online انتهى ويحوّل إلى mad3oom.com، لكن رابط التحقق من
-- الفاتورة (رمز الـ QR ورسالة التذكرة) كان يُبنى من إعداد وقيم افتراضية
-- مثبّتة على .online، وget_public_invoice تُعلن issuer_domain = mad3oom.online.
--
-- الدالتان تُعاد كتابتهما من تعريفهما الحي نفسه (pg_get_functiondef) مع
-- استبدال النطاق فقط، فلا يضيع أي تعديل لاحق على جسميهما.

update public.advanced_settings
   set value = jsonb_set(value, '{public_invoice_base_url}', to_jsonb('https://mad3oom.com/invoice.html'::text))
 where key = 'accounting_integration'
   and value->>'public_invoice_base_url' like '%mad3oom.online%';

do $$
declare v_def text;
begin
  for v_def in
    select replace(pg_get_functiondef(p.oid), 'mad3oom.online', 'mad3oom.com')
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('get_public_invoice', 'record_accounting_invoice')
  loop
    execute v_def;
  end loop;
end
$$;
