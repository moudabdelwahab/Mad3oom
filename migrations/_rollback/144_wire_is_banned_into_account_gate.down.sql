-- تراجع 144_wire_is_banned_into_account_gate.sql: يعيد جسم 042
-- (migrations/042_account_gate.sql:120-127) بلا فحص حظر.
--
-- تحذير: هذا التراجع يعيد إنتاج الانجراف الذي جاء 144 ليغلقه — بيئة تُبنى
-- من الملفات وحدها بعد هذا التراجع تعود للنسخة بلا حظر، فيمرّ منها مستخدم
-- محظور موثَّق الهاتف من كل البوابات. للطوارئ فقط، ويُعاد تطبيق 144 فور
-- زوال سبب التراجع. لا يحذف أي سجل ولا يمسّ أي سياسة.
create or replace function public.account_is_active()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    public.gate_is_exempt_account(auth.uid())
    or (public.account_is_whitelisted(auth.uid()) and public.account_verification_ok(auth.uid())),
    false);
$$;

comment on function public.account_is_active() is
  'بوابة الحساب: موجود في القائمة البيضاء، ومتحقَّق منه. تُستعمل في سياسات gate_account_active الـRESTRICTIVE. (نسخة ما قبل H-04: بلا فحص حظر — أعيدت هنا بالتراجع عن 144 فقط.)';

revoke execute on function public.account_is_active() from public, anon;
grant execute on function public.account_is_active() to authenticated;
