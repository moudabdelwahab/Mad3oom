-- ============================================================================
-- 114 — حمولة محفّزَي بريد التذاكر: الحالة السابقة ومعرّف الرد
--
-- بريد التذاكر كان يُبنى من حمولة المحفّز كما هي: حالة جديدة فقط، ونص الرد منسوخًا، ولا شيء غيرهما.
-- دالة send-ticket-email صارت تقرأ التذكرة نفسها من القاعدة بمعرّفها (الرقم والعنوان والحالة الحالية
-- والتواريخ والشركة وبريد صاحبها)، فلا يلزم المحفّز إلا أن يقول «أي تذكرة، وأي حدث». يضيف هذا الترحيل
-- مفتاحين فقط:
--   previous_status  (UPDATE) الحالة قبل التغيير، ليفرّق البريد بين «تم الحل» و«أُعيد فتحها» و«أُغلقت».
--   reply_id         (REPLY) معرّف الرد، فتقرأ الدالة الرد بنفسها وتتحقق أنه لهذه التذكرة وغير داخلي.
--
-- لا تغيير في شروط الإطلاق ولا في المستلم ولا في المحفّزات نفسها (on_ticket_created، on_ticket_updated
-- عند تغيّر status فقط، on_ticket_reply_created). الطلب عبر pg_net يُرسل بعد نجاح المعاملة وحده.
-- بقية النص هو نص الإنتاج حرفيًا (tests/fixtures/prod-shape/51_functions_b.sql).
--
-- الترتيب: الدالة الجديدة تعمل مع الحمولة القديمة والجديدة، فتُنشر الدالة قبل هذا الترحيل أو بعده.
-- التراجع: migrations/_rollback/114_ticket_email_payload.down.sql
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_ticket_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    payload JSONB;
    customer_email TEXT;
    customer_name TEXT;
    v_internal_secret text;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    SELECT email, full_name INTO customer_email, customer_name
    FROM profiles
    WHERE id = NEW.user_id;

    IF customer_email IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT value INTO v_internal_secret FROM public.internal_service_secrets WHERE key = 'send_ticket_email_internal';

    payload = jsonb_build_object(
        'event', TG_OP,
        'ticket_id', NEW.id,
        'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
        'ticket_number', NEW.ticket_number,
        'title', NEW.title,
        'status', NEW.status,
        'description', NEW.description,
        'customer_email', customer_email,
        'customer_name', customer_name,
        'created_at', NEW.created_at
    );

    BEGIN
        PERFORM public.http_post(
            url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/send-ticket-email',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'X-Internal-Trigger-Secret', v_internal_secret
            ),
            body := payload
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'notify_ticket_event: failed to send email for ticket %: %', NEW.id, SQLERRM;
    END;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_ticket_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    payload JSONB;
    customer_email TEXT;
    customer_name TEXT;
    ticket_data RECORD;
    v_internal_secret text;
BEGIN
    SELECT * INTO ticket_data FROM tickets WHERE id = NEW.ticket_id;

    SELECT email, full_name INTO customer_email, customer_name
    FROM profiles
    WHERE id = ticket_data.user_id;

    IF NEW.is_internal = FALSE AND NEW.user_id != ticket_data.user_id AND customer_email IS NOT NULL THEN
        SELECT value INTO v_internal_secret FROM public.internal_service_secrets WHERE key = 'send_ticket_email_internal';

        payload = jsonb_build_object(
            'event', 'REPLY',
            'ticket_id', ticket_data.id,
            'reply_id', NEW.id,
            'ticket_number', ticket_data.ticket_number,
            'title', ticket_data.title,
            'message', NEW.message,
            'customer_email', customer_email,
            'customer_name', customer_name
        );

        BEGIN
            PERFORM public.http_post(
                url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/send-ticket-email',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'X-Internal-Trigger-Secret', v_internal_secret
                ),
                body := payload
            );
        EXCEPTION WHEN OTHERS THEN
            RAISE LOG 'notify_ticket_reply: failed to send email for ticket %: %', ticket_data.id, SQLERRM;
        END;
    END IF;

    RETURN NEW;
END;
$function$
;
