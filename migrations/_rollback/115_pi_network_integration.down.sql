-- التراجع عن 115 — يحذف جداول Pi الثلاثة ودالة الختم. سجل المدفوعات يُفقد.
drop table if exists public.pi_payments;
drop table if exists public.pi_plan_prices;
drop table if exists public.pi_settings;
drop function if exists public.pi_stamp_updated();
