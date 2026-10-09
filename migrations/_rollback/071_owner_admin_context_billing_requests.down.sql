-- ============================================================================
-- تراجع 071_owner_admin_context_billing_requests
--
-- بيرجّع شرطي السياستين لنص الإنتاج حرفيًا (tests/fixtures/prod-shape،
-- 60_triggers_rls_policies.sql). بعده يرجع المالك في سياق admin مايشوفش أزرار
-- تأكيد/رفض الاشتراك وشحن الرصيد (يدخل سياق owner أو يأكّد من حساب أدمن).
-- و admin_recompute_user_access بتتشال (ماكانتش موجودة على الإنتاج قبل 071).
-- مفيش بيانات بتتأثر.
-- ============================================================================

begin;

alter policy "Admins can manage all subscriptions" on public.whatsapp_subscriptions
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));

alter policy "Admins can manage all wallet topup requests" on public.whatsapp_wallet_topup_requests
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));

drop function if exists public.admin_recompute_user_access(uuid);

commit;
