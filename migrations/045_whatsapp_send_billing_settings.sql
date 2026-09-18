-- ============================================================================
-- 045_whatsapp_send_billing_settings.sql
--   إعدادات فوترة مسار الإرسال المباشر (send-whatsapp و MCP).
--
-- ════════════════════════════════════════════════════════════════════════════
-- الخلفية (H-03 في FULL_PROJECT_AUDIT.md)
-- ════════════════════════════════════════════════════════════════════════════
-- بنية المحفظة موجودة وصحيحة ومُستعمَلة بالفعل — لكن من مسار واحد فقط:
--
--   integrations-api → wa_wallet_check_sufficient → Graph → wa_wallet_charge_message  ✅
--   send-whatsapp    → Graph                                                          ❌ بلا فحص وبلا خصم
--   mcp (send_whatsapp tool) → Graph                                                   ❌ بلا فحص وبلا خصم
--
-- أي أن مسارين من ثلاثة يرسلان بلا قياس وبلا خصم. وقياس الإنتاج قبل هذا
-- الترحيل: 294 رسالة صادرة في التاريخ كله، مقابل **10 عمليات خصم فقط**.
--
-- ════════════════════════════════════════════════════════════════════════════
-- لماذا «قياس أولًا» لا «حظر فورًا»
-- ════════════════════════════════════════════════════════════════════════════
-- قياس الإنتاج: 3 محافظ، **واحدة مموَّلة** فقط (إجمالي 48.04 ج.م)، و91 رسالة
-- صادرة في آخر 30 يومًا. تفعيل الحظر فورًا كان سيوقف إرسال مستأجرَين من ثلاثة
-- في نفس اللحظة — أي انقطاع خدمة لعملاء حاليين بسبب إصلاح محاسبي.
--
-- فالقرار (من مالك المشروع صراحةً): يُربط الخصم ويُقاس كل إرسال الآن، ويبقى
-- الحظر **خلف علَم** يُرفع بصفّ واحد بعد تمويل المحافظ.
--
--   wallet_enforce_send = false → نقص الرصيد يُسجَّل تحذيرًا ولا يمنع الإرسال
--   wallet_enforce_send = true  → نقص الرصيد يمنع الإرسال (402)
--
-- للتفعيل لاحقًا:
--   update public.integration_settings set value = 'true'::jsonb
--    where key = 'wallet_enforce_send';
--
-- ════════════════════════════════════════════════════════════════════════════
-- التسعير — منقول من المسار القائم لا مخترَع
-- ════════════════════════════════════════════════════════════════════════════
-- `template_charge_egp` موجود بالفعل (0.282) وتستعمله integrations-api. يُعاد
-- استعماله كما هو لرسائل القوالب في المسارين الجديدين، فالسعر واحد في كل
-- المسارات ولا يتفرّع.
--
-- `text_charge_egp` يبدأ **صفرًا** عمدًا: رسائل الخدمة داخل نافذة الـ24 ساعة
-- لا تُفوتر كالقوالب، والمسار القائم (integrations-api) لا يحاسب عليها أصلًا.
-- تحديد سعر لها قرار تجاري يخص مالك المنصة، لا يُخمَّن هنا. والصفر يعني:
-- تُسجَّل ولا تُخصم.
--
-- ROLLBACK
--   delete from public.integration_settings
--    where key in ('wallet_enforce_send','text_charge_egp');
-- ============================================================================

insert into public.integration_settings (key, value)
values ('wallet_enforce_send', 'false'::jsonb)
on conflict (key) do nothing;

insert into public.integration_settings (key, value)
values ('text_charge_egp', '0'::jsonb)
on conflict (key) do nothing;

-- ============================================================================
-- تحقق ذاتي
-- ============================================================================
do $$
declare v_enforce jsonb; v_text jsonb; v_tmpl jsonb;
begin
  select value into v_enforce from public.integration_settings where key='wallet_enforce_send';
  select value into v_text    from public.integration_settings where key='text_charge_egp';
  select value into v_tmpl    from public.integration_settings where key='template_charge_egp';

  if v_enforce is null then raise exception 'wallet_enforce_send لم يُضَف'; end if;
  if v_text    is null then raise exception 'text_charge_egp لم يُضَف';    end if;
  if v_tmpl    is null then raise exception 'template_charge_egp مفقود — مسار الفوترة القائم معطوب'; end if;

  raise notice '045: الفوترة في وضع القياس (enforce=%), سعر القالب=%, سعر النص=%',
    v_enforce, v_tmpl, v_text;
end $$;
