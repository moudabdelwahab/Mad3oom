-- تراجع 129_owner_account_transfer_details.sql: إسقاط الدوال الثلاث والدالة الداخلية.
-- لا جداول جديدة في 129، ولا حذف لأي سجل: سجلات النقل والتدقيق التي كتبتها الدوال تبقى.
drop function if exists public.owner_account_transfer(uuid, uuid, text, boolean, uuid);
drop function if exists public.owner_account_details(uuid);
drop function if exists public.owner_update_account_profile(uuid, text, text, text);
drop function if exists public._owner_transfer_safety_ok();
