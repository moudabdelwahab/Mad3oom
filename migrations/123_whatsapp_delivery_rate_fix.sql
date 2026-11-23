-- ============================================================================
-- 123 — تثبيت إصلاح معدل تسليم واتساب في الترحيلات
--
-- المشكلة: دالة public.get_whatsapp_dashboard_stats() كانت تحسب الرسائل
-- المسلَّمة بشرط status = 'delivered'، لكن عمود messages.status لا يأخذ
-- هذه القيمة أبدًا (القيم الفعلية: received / sent / failed) — فكان معدل
-- التسليم في لوحة واتساب صفرًا دائمًا مهما وُصلت رسائل. الحالة الحقيقية
-- للتسليم تعيش في delivery_status ('sent' / 'delivered' / 'read' / 'failed').
--
-- الإصلاح: السطر الوحيد الذي يتغير هو شرط العدّ:
--   status = 'delivered'  ←  delivery_status = 'delivered'
-- وكل شيء آخر (نافذة sent_today، صيغة المعدل، SECURITY DEFINER، مسار
-- البحث، المفاتيح المُرجعة) مطابق لتعريف الدالة كما يعمل حيًا.
--
-- المصدر والتحقق: الإصلاح طُبِّق حيًا على Supabase في 2026-11-22 بعد موافقة
-- مالك المشروع، وتُحقِّق منه في مصدر الدالة بعد التطبيق. هذا الترحيل ينقل
-- التعريف المصحَّح نفسه إلى تاريخ الترحيلات، حتى لا تعيد إعادة بناء قاعدة
-- البيانات من الصفر النسخة القديمة المغلوطة. جسم الدالة هنا مطابق حرفيًا
-- لما ترجعه pg_get_functiondef للدالة الحية.
--
-- لم يُغيَّر عمدًا:
--   * active_templates يبقى 0 — لا يوجد جدول قوالب في Supabase، فلا يوجد
--     عدّ صادق بعد. لا يُستبدل بعدّ حملات — ذلك رقم مختلف.
--   * 'read' لا تُحسب كمُسلَّمة. الرسالة المقروءة مسلَّمة بالضرورة، لكن
--     الوصفة المعتمدة هي 'delivered' فقط.
--
-- المتطلبات: لا شيء (الدالة تُنشأ من جديد بـ CREATE OR REPLACE).
-- التراجع: إعادة إنشاء الدالة بشرط status = 'delivered' — أي عكس هذا
-- الترحيل؛ وهو تراجع مقصود إرجاع الخطأ، فلا ملف تراجع منفصل.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_whatsapp_dashboard_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid;
    v_sent_today bigint;
    v_delivered_today bigint;
    v_active_templates bigint;
    v_delivery_rate numeric;
BEGIN
    v_user_id := auth.uid();

    -- حساب الرسائل المرسلة اليوم
    SELECT count(*) INTO v_sent_today
    FROM messages
    WHERE user_id = v_user_id
      AND direction = 'outbound'
      AND created_at >= CURRENT_DATE;

    -- حساب الرسائل المسلَّمة اليوم — المصحَّح: delivery_status وليس status
    SELECT count(*) INTO v_delivered_today
    FROM messages
    WHERE user_id = v_user_id
      AND direction = 'outbound'
      AND delivery_status = 'delivered'
      AND created_at >= CURRENT_DATE;

    -- حساب معدل التسليم
    IF v_sent_today > 0 THEN
        v_delivery_rate := round((v_delivered_today::numeric / v_sent_today::numeric) * 100, 2);
    ELSE
        v_delivery_rate := 0;
    END IF;

    -- القوالب النشطة (بما أنه لا يوجد جدول قوالب، سنفترض 0 حالياً أو نعدها من الرسائل الفريدة)
    v_active_templates := 0;

    RETURN jsonb_build_object(
        'sent_today', v_sent_today,
        'delivery_rate', v_delivery_rate,
        'active_templates', v_active_templates
    );
END;
$function$
;

-- ============================================================================
-- تحقق ذاتي: التعريف المخزَّن يجب أن يعدّ عبر delivery_status، لا status.
-- ============================================================================
do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.get_whatsapp_dashboard_stats'::regproc);
  if position('delivery_status = ''delivered''' in v_def) = 0 then
    raise exception '123: get_whatsapp_dashboard_stats لا يعدّ عبر delivery_status';
  end if;
  if position('status = ''delivered''' in v_def) <> 0 then
    raise exception '123: get_whatsapp_dashboard_stats ما زال يستعمل status = delivered';
  end if;
end $$;
