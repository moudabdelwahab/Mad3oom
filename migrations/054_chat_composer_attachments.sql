-- ============================================================================
-- 054_chat_composer_attachments.sql
--   مرفقات الشات (صور، ملفات، رسائل صوتية) من الويدجت — مفروضة في القاعدة،
--   وإلغاء «الوضع التقليدي» كقيمة افتراضية لوضع الرد.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ما كان موجودًا (قراءة الإنتاج، 2026-09-25)
-- ════════════════════════════════════════════════════════════════════════════
--   • مستودع chat-attachments خاص؛ الرفع مسموح لمجلد المستخدم نفسه
--     (<uid>/…) والقراءة لصاحبه أو لفريق المنصة. **بلا حد حجم وبلا قائمة
--     أنواع** — أي ملف بأي حجم كان يُقبل.
--   • chat_messages فيه image_url و audio_url (نص، مسار داخل المستودع)،
--     ولا مكان لملف عادي (PDF، Excel…). ولا شيء يمنع رسالة من أن تشير إلى
--     مسار **ملف مستخدم آخر**: سياسة الإدراج تتحقق من الجلسة والمرسل فقط،
--     فعميل كان يستطيع أن يجعل فريق الدعم يفتح ملف عميل آخر.
--   • profiles.chatbot_mode افتراضيه 'traditional'.
--
-- ════════════════════════════════════════════════════════════════════════════
-- التغييرات — كلها إضافية، لا حذف ولا تعديل لصف قائم
-- ════════════════════════════════════════════════════════════════════════════
--   ① عمود chat_messages.attachment (jsonb، nullable): بيانات المرفق
--      {kind: image|file|audio, path, name, mime, size, duration_ms?}.
--      الصور والصوت تبقى أيضًا في image_url / audio_url كما كانت (كل من
--      يعرض الرسائل اليوم يقرؤهما)، والعمود الجديد يحمل الاسم والحجم والنوع.
--   ② حدود المستودع على الخادم: 10 ميجا، وقائمة أنواع مغلقة. التحقق في
--      الواجهة تجربة استخدام فقط؛ هذا هو الفرض.
--   ③ مُحفِّز قبل الإدراج/التعديل: كل مسار مرفق في رسالة يجب أن يكون
--        – مسارًا داخل المستودع (لا رابط، لا «..»)،
--        – في مجلد **مرسل الرسالة** نفسه (sender_id)،
--        – لملف موجود فعلًا في chat-attachments.
--      رسالة البوت (sender_id NULL) لا تحمل مرفقًا.
--   ④ الافتراضي الجديد لـ chatbot_mode هو 'sie'. الصفوف القديمة بقيمة
--      'traditional' / 'ai_model' / 'auto' **لا تُعدَّل**: الواجهة تقرأ أي
--      قيمة غير 'sie' على أنها 'sie' (SIE هو وضع الرد الوحيد الآن)، فلا
--      حالة غير صالحة ولا تعطل، ويبقى التراجع ممكنًا.
--
-- التطبيق: قبل نشر الواجهة الجديدة (لا تعتمد الواجهة على العمود إلا عند
-- إرسال ملف، وتتعامل مع غيابه كخطأ رفع عادي). يُطبَّق مرتين بلا أثر.
-- ============================================================================

-- ① ---------------------------------------------------------------------------
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS attachment jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_attachment_shape') THEN
    -- COALESCE: a missing key makes jsonb_typeof() NULL, and a NULL CHECK
    -- passes — {"kind":"file"} with no path would have been accepted.
    ALTER TABLE public.chat_messages ADD CONSTRAINT chat_messages_attachment_shape CHECK (
      attachment IS NULL OR COALESCE(
        jsonb_typeof(attachment) = 'object'
        AND attachment->>'kind' IN ('image', 'file', 'audio')
        AND jsonb_typeof(attachment->'path') = 'string'
        AND length(attachment->>'path') BETWEEN 3 AND 400
        AND (attachment->'size' IS NULL OR jsonb_typeof(attachment->'size') = 'number')
        AND (attachment->'name' IS NULL OR (jsonb_typeof(attachment->'name') = 'string' AND length(attachment->>'name') <= 200))
        AND (attachment->'mime' IS NULL OR (jsonb_typeof(attachment->'mime') = 'string' AND length(attachment->>'mime') <= 120)),
        false)
    );
  END IF;
END $$;

COMMENT ON COLUMN public.chat_messages.attachment IS
  'مرفق الرسالة: {kind: image|file|audio, path (في chat-attachments داخل مجلد المرسل), name, mime, size, duration_ms}. الصور والصوت مكررة في image_url/audio_url للتوافق.';

-- ② ---------------------------------------------------------------------------
UPDATE storage.buckets
   SET file_size_limit = 10485760,
       allowed_mime_types = ARRAY[
         'image/png', 'image/jpeg', 'image/webp', 'image/gif',
         'application/pdf', 'text/plain', 'text/csv',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.ms-powerpoint',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'
       ]
 WHERE id = 'chat-attachments';

-- ③ ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_attachment_path_ok(p_path text, p_sender uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_sender IS NOT NULL
     AND p_path !~ '^[a-zA-Z][a-zA-Z0-9+.-]*:'          -- لا روابط
     AND p_path !~ '(^|/)\.\.?(/|$)'                     -- لا . ولا ..
     AND left(p_path, 1) <> '/'
     AND split_part(p_path, '/', 1) = p_sender::text     -- مجلد المرسل نفسه
     AND EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = 'chat-attachments' AND o.name = p_path);
$$;

REVOKE ALL ON FUNCTION public.chat_attachment_path_ok(text, uuid) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_chat_message_attachment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_path text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.image_url IS NOT DISTINCT FROM OLD.image_url
     AND NEW.audio_url IS NOT DISTINCT FROM OLD.audio_url
     AND NEW.attachment IS NOT DISTINCT FROM OLD.attachment THEN
    RETURN NEW;
  END IF;

  FOREACH v_path IN ARRAY ARRAY[NEW.image_url, NEW.audio_url, NEW.attachment->>'path'] LOOP
    IF v_path IS NOT NULL AND NOT public.chat_attachment_path_ok(v_path, NEW.sender_id) THEN
      RAISE EXCEPTION 'مرفق غير صالح: يجب أن يكون ملفًا مرفوعًا في مجلد المرسل نفسه'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- المسار في image_url/audio_url يطابق المرفق نفسه إن وُجد الاثنان
  IF NEW.attachment IS NOT NULL THEN
    IF NEW.attachment->>'kind' = 'image' AND NEW.image_url IS DISTINCT FROM NEW.attachment->>'path' THEN
      RAISE EXCEPTION 'مرفق غير متسق: image_url لا يطابق مسار الصورة' USING ERRCODE = '22023';
    END IF;
    IF NEW.attachment->>'kind' = 'audio' AND NEW.audio_url IS DISTINCT FROM NEW.attachment->>'path' THEN
      RAISE EXCEPTION 'مرفق غير متسق: audio_url لا يطابق مسار التسجيل' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_chat_message_attachment() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_chat_message_attachment ON public.chat_messages;
CREATE TRIGGER trg_guard_chat_message_attachment
  BEFORE INSERT OR UPDATE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_message_attachment();

-- ④ ---------------------------------------------------------------------------
ALTER TABLE public.profiles ALTER COLUMN chatbot_mode SET DEFAULT 'sie';

-- ⑤ ---------------------------------------------------------------------------
-- «الوضع التقليدي» لا يُختار ولا من الـ API: أي قيمة **جديدة** لوضع الرد غير
-- 'sie' مرفوضة. مُحفِّز لا CHECK: قيد CHECK (ولو NOT VALID) يُفحص عند أي
-- UPDATE للصف، فكان سيكسر تعديل أي بيانات أخرى لـ31 حسابًا بقيم قديمة.
-- الصفوف القديمة تبقى كما هي ما لم يتغيّر وضعها.
CREATE OR REPLACE FUNCTION public.guard_chatbot_mode_value()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.chatbot_mode IS NOT NULL AND NEW.chatbot_mode <> 'sie'
     AND (TG_OP = 'INSERT' OR NEW.chatbot_mode IS DISTINCT FROM OLD.chatbot_mode) THEN
    RAISE EXCEPTION 'وضع الرد "%" لم يعد متاحًا — SIE هو وضع الرد الوحيد', NEW.chatbot_mode
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_chatbot_mode_value ON public.profiles;
CREATE TRIGGER trg_guard_chatbot_mode_value
  BEFORE INSERT OR UPDATE OF chatbot_mode ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_chatbot_mode_value();

-- ⑥ ---------------------------------------------------------------------------
-- تنظيف رفع لم يكتمل إرساله: العميل يحذف ملفه **ما دامت لا رسالة تشير إليه**.
-- ملف أُرسل في محادثة لا يحذفه أحد من الواجهة (دليل لفريق الدعم).
DROP POLICY IF EXISTS chat_attachments_delete_own_unreferenced ON storage.objects;
CREATE POLICY chat_attachments_delete_own_unreferenced ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'chat-attachments'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND NOT EXISTS (
      SELECT 1 FROM public.chat_messages m
       WHERE m.image_url = storage.objects.name
          OR m.audio_url = storage.objects.name
          OR m.attachment->>'path' = storage.objects.name)
  );
