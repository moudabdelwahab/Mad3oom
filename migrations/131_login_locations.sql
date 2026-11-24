-- ============================================================================
-- 131 — مواقع تسجيل الدخول الدقيقة لحساب المالك.
--
-- المشكلة: تقرير تسجيل الدخول في شات Muse داخل المنصة يعرف الـ IP والمتصفح
-- والجهاز من auth.sessions، لكن اللوكيشن من الـ IP تقريبي على مستوى المدينة
-- فقط — لا يصلح لمعرفة مكان تسجيل الدخول بالضبط.
--
-- الإصلاح: جدول public.login_locations يسجّل موقع المتصفح الذي تلتقطه صفحة
-- الدخول بعد نجاح تسجيل الدخول (بإذن المتصفح — Geolocation API)، صف واحد
-- لكل التقاط. الجسر يقرأ أقرب صف بعد وقت الجلسة ويضمّنه في التقرير مع رابط
-- خريطة؛ وإن غاب الصف (رفض الإذن أو لم يكتمل قبل الانتقال) يرجع التقرير
-- لموقع الـ IP (المدينة) تلقائيًا.
--
-- النطاق — حساب واحد فقط: الكود في login-location.js يلتقط لحساب
-- mahmoud@mad3oom.com وحده، ولا يظهر طلب الإذن لأي حساب آخر أصلًا.
-- الجدول نفسه لا يقيّد البريد (الالتقاط قرار واجهة)، لكن سياسة RLS تقيّد
-- كل صف بصاحبه (user_id = auth.uid()) إدراجًا وقراءةً.
--
-- الأعمدة:
--   user_id     صاحب الجلسة
--   latitude    خط العرض (-90..90)
--   longitude   خط الطول (-180..180)
--   accuracy_m  دقة القياس بالمتر (تقريبية من المتصفح؛ خالية إن لم يذكرها)
--   source      مصدر الموقع ('browser' فقط حاليًا)
--   captured_at وقت الالتقاط
--
-- الصلاحيات — سجل إلحاقي لا يُعدَّل:
--   * الإدراج: المستخدم الموثَّق لصفه هو (user_id = auth.uid()).
--   * القراءة: صاحب الصف وحده (الجسر يقرأ بدور الخدمة فيتجاوز RLS).
--   * لا سياسة UPDATE ولا DELETE — الموقع سجل، لا مسودة.
--
-- ملاحظة ترقيم: 130 محجوز لفرع ترحيل حارس owns/belongs (غير مدموج بعد)،
-- فهذا الترحيل 131 حتى لا يتصادم معه عند الدمج.
--
-- المتطلبات: لا شيء (جدول مستقل). التراجع:
-- migrations/_rollback/131_login_locations.down.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.login_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude double precision NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  accuracy_m integer CHECK (accuracy_m IS NULL OR accuracy_m > 0),
  source text NOT NULL DEFAULT 'browser' CHECK (source = 'browser'),
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_locations_user_captured_idx
  ON public.login_locations (user_id, captured_at DESC);

ALTER TABLE public.login_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS login_locations_insert_own ON public.login_locations;
CREATE POLICY login_locations_insert_own ON public.login_locations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS login_locations_select_own ON public.login_locations;
CREATE POLICY login_locations_select_own ON public.login_locations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'login_locations') THEN
    RAISE EXCEPTION 'login_locations table was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'login_locations') THEN
    RAISE EXCEPTION 'login_locations RLS is not enabled';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'login_locations') <> 2 THEN
    RAISE EXCEPTION 'login_locations must have exactly 2 policies';
  END IF;
END $$;
