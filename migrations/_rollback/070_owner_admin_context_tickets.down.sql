-- ============================================================================
-- تراجع 070_owner_admin_context_tickets
--
-- بيرجّع شروط السياسات الخمس لنص الإنتاج حرفيًا (tests/fixtures/prod-shape،
-- 60_triggers_rls_policies.sql). بعده يرجع المالك في سياق admin مايشوفش تذاكر
-- العملاء (يدخل سياق owner عشان يشوفها). مفيش بيانات بتتأثر.
-- ومحفّزا تعديل التذكرة بيرجعوا لنص الإنتاج (منقول آليًا).
-- ============================================================================

alter policy tickets_select_policy on public.tickets
  using (((user_id = auth.uid()) OR has_elevated_authority() OR (( SELECT p.role
   FROM profiles p
  WHERE (p.id = auth.uid())) = 'admin'::text) OR supervises(user_id)));

alter policy "Admin can update tickets" on public.tickets
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));

alter policy "Admin can delete tickets" on public.tickets
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));

alter policy ticket_replies_select_policy on public.ticket_replies
  using ((has_elevated_authority() OR (( SELECT p.role
   FROM profiles p
  WHERE (p.id = auth.uid())) = ANY (ARRAY['admin'::text, 'support'::text])) OR ((COALESCE(is_internal, false) = false) AND ticket_in_my_scope(ticket_id))));

alter policy "Users can add replies to their tickets" on public.ticket_replies
  with check (((user_id = auth.uid()) AND (has_elevated_authority() OR (( SELECT p.role
   FROM profiles p
  WHERE (p.id = auth.uid())) = 'admin'::text) OR ticket_in_my_scope(ticket_id))));

CREATE OR REPLACE FUNCTION public.enforce_customer_ticket_update_restrictions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    is_admin boolean;
BEGIN
    IF current_setting('app.bypass_ticket_restrictions', true) = 'on' THEN
        RETURN NEW;
    END IF;

    SELECT (public.is_main_admin() OR EXISTS (
        SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
    )) INTO is_admin;

    IF COALESCE(is_admin, false) THEN
        RETURN NEW; -- الأدمن يقدر يعدل أي عمود
    END IF;

    -- أي عمود غير أعمدة الأرشفة اتغيّر ومنفذّه مش أدمن؟ نرفض العملية بالكامل
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.priority IS DISTINCT FROM OLD.priority
       OR NEW.image_url IS DISTINCT FROM OLD.image_url
       OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number
       OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       OR NEW.ticket_type IS DISTINCT FROM OLD.ticket_type
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.subdomain_id IS DISTINCT FROM OLD.subdomain_id
       OR NEW.contact_info IS DISTINCT FROM OLD.contact_info
       OR NEW.first_response_at IS DISTINCT FROM OLD.first_response_at
       OR NEW.sla_alert_sent IS DISTINCT FROM OLD.sla_alert_sent
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'غير مسموح للعميل بتعديل هذا الحقل في التذكرة';
    END IF;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.restrict_customer_ticket_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  is_caller_admin boolean;
BEGIN
  IF current_setting('app.bypass_ticket_restrictions', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ) INTO is_caller_admin;

  IF is_caller_admin THEN
    RETURN NEW;
  END IF;

  IF auth.uid() = OLD.user_id THEN
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.priority IS DISTINCT FROM OLD.priority
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.image_url IS DISTINCT FROM OLD.image_url
       OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number THEN
      RAISE EXCEPTION 'العميل غير مسموح له بتعديل هذه الحقول، يمكنه فقط أرشفة التذكرة';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;
