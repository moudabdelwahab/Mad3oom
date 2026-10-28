-- ============================================================================
-- 117_owner_admin_parity.sql — مالك المنصة في لوحة الإدارة يملك ما تملكه الإدارة، عبر السياق لا الرتبة.
--
-- السبب الجذري
--   040 جعل دوال السلطة واعية بالسياق: is_admin() = رتبة admin أو owner_capability('admin')، و
--   is_platform_staff() = رتبة admin/support أو owner_capability('staff'). لكنه أعاد كتابة السياسات التي
--   تسمّي is_main_admin وحدها (القاعدة ③ فيه)، وبقيت 46 سياسة على 36 جدولًا (منها storage.objects) وأربع دوال تفحص
--   profiles.role = 'admin' (أو admin/support) **حرفيًا**. المالك رتبته platform_owner دائمًا، فيرفضه كل
--   ذلك في أي سياق: لوحة الإدارة تُفتح له (guardPage يحترم السياق) ثم تُرسم أقسامها فارغة وتفشل عملياتها —
--   الإعدادات، الوسوم والردود الجاهزة، قاعدة المعرفة، حالة الخدمات، قائمة الانتظار، البريد، الأخطاء،
--   المنتدى، المكافآت والمحافظ، النطاقات الفرعية، الأتمتة…
--
-- الإصلاح — القاعدة ① من 040 حرفيًا: «كل مُسنَد يُعاد بنفس نطاقه، ويُضاف إليه فرع المالك وحده مشروطًا بسياقه».
--   • role = 'admin'                → public.is_admin()            (= نفس الشرط ∨ owner_capability('admin'))
--   • role in ('admin','support')   → public.is_platform_staff()   (= نفس الشرط ∨ owner_capability('staff'))
--   • role = 'admin' ∨ email = 'support@…' (أربع سياسات قراءة) → public.is_admin(): حساب support@ برتبة admin
--     ومرتفع في platform_authority، فلا يفقد شيئًا؛ ويسقط تفويض بالبريد الذي أزاله 040 من بقية الطبقات.
--   • المحفظة المركزية (بريد JWT = support@ وحده) → can_manage_central_wallet(): نفس الشرط ∨
--     owner_capability('owner_only') — مستوى السلطة المرتفعة نفسه (has_elevated_authority) لا مستوى الإدارة.
--
-- ما لا يفعله
--   • لا يوسّع لأي حساب غير المالك: الأدمن والدعم والعميل يمرّون ويُردّون كما كانوا (tests/sql/owner-admin-parity).
--   • المالك خارج سياقَي owner/admin (العميل، الشركة، المعاينة، بلا سياق) لا يكسب شيئًا: owner_capability.
--   • لا يمسّ الدوال التي تفحص رتبة **الهدف** لا المنادي (أهلية الوكيل، حرّاس الرتب، توزيع الإشعارات…)،
--     ولا _account_request_requester_ok (يستثني المالك عمدًا: الإداري يطلب والمالك يقرر).
--   • لا يمسّ عزل الشركات (097+): السياسات التقييدية فوق هذه الجداول كما هي.
--
-- لا مفتاح تفعيل ولا تغيير بيانات. قابل لإعادة التشغيل. التراجع: migrations/_rollback/117_owner_admin_parity.down.sql
-- ============================================================================
do $$
begin
  if to_regprocedure('public.is_admin()') is null or to_regprocedure('public.is_platform_staff()') is null
     or to_regprocedure('public.owner_capability(text)') is null then
    raise exception '117 يتطلب 038/040 (is_admin و is_platform_staff و owner_capability)';
  end if;
  if position('owner_capability' in pg_get_functiondef('public.is_admin()'::regprocedure)) = 0
     or position('owner_capability' in pg_get_functiondef('public.is_platform_staff()'::regprocedure)) = 0 then
    raise exception '117: is_admin/is_platform_staff ليستا الصيغة الواعية بالسياق (040)';
  end if;
end $$;

-- ============================================================================
-- 1) المحفظة المركزية — مُسنَد واحد للسياسات والدوال والواجهة
-- ============================================================================
create or replace function public.can_manage_central_wallet()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'support@mad3oom.online'
      or coalesce(public.owner_capability('owner_only'), false);
$$;

comment on function public.can_manage_central_wallet() is
  'المحفظة المركزية: حساب support@ (كما كان) أو مالك المنصة في سياقه (owner_only) — 117.';

revoke all on function public.can_manage_central_wallet() from public, anon;
grant execute on function public.can_manage_central_wallet() to authenticated;

-- ============================================================================
-- 2) السياسات — نفس الاسم والأمر والأدوار، والمُسنَد الواعي بالسياق
-- ============================================================================

-- ── role = 'admin' → is_admin() ─────────────────────────────────────────────
drop policy if exists activity_logs_select_policy on public.activity_logs;
create policy activity_logs_select_policy on public.activity_logs as permissive for select to public
  using ((user_id = auth.uid()) or public.has_elevated_authority() or public.is_admin());

drop policy if exists "Admins can manage advanced_settings" on public.advanced_settings;
create policy "Admins can manage advanced_settings" on public.advanced_settings as permissive for all to authenticated
  using (public.is_admin());

drop policy if exists "Admin can manage canned responses" on public.canned_responses;
create policy "Admin can manage canned responses" on public.canned_responses as permissive for all to public
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins have full access to chatbot_memory" on public.chatbot_memory;
create policy "Admins have full access to chatbot_memory" on public.chatbot_memory as permissive for all to public
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins can manage custom_roles" on public.custom_roles;
create policy "Admins can manage custom_roles" on public.custom_roles as permissive for all to public
  using (public.is_admin());

drop policy if exists "Admins can manage categories" on public.forum_categories;
create policy "Admins can manage categories" on public.forum_categories as permissive for all to public
  using (public.is_admin());

drop policy if exists "Authors/Admins can update replies" on public.forum_replies;
create policy "Authors/Admins can update replies" on public.forum_replies as permissive for update to public
  using ((auth.uid() = author_id) or public.is_admin());

drop policy if exists "Admins can view reports" on public.forum_reports;
create policy "Admins can view reports" on public.forum_reports as permissive for select to public
  using (public.is_admin());

drop policy if exists "Admins can manage subforums" on public.forum_subforums;
create policy "Admins can manage subforums" on public.forum_subforums as permissive for all to public
  using (public.is_admin());

drop policy if exists "Authors/Admins can update threads" on public.forum_threads;
create policy "Authors/Admins can update threads" on public.forum_threads as permissive for update to public
  using ((auth.uid() = author_id) or public.is_admin());

drop policy if exists "Admin can delete mailbox emails" on public.mailbox_emails;
create policy "Admin can delete mailbox emails" on public.mailbox_emails as permissive for delete to public
  using (public.is_admin());
drop policy if exists "Admin can select mailbox emails" on public.mailbox_emails;
create policy "Admin can select mailbox emails" on public.mailbox_emails as permissive for select to public
  using (public.is_admin());
drop policy if exists "Admin can update mailbox emails" on public.mailbox_emails;
create policy "Admin can update mailbox emails" on public.mailbox_emails as permissive for update to public
  using (public.is_admin());

drop policy if exists "Admins can manage firewall rules" on public.memory_firewall_rules;
create policy "Admins can manage firewall rules" on public.memory_firewall_rules as permissive for all to public
  using (public.is_admin());

drop policy if exists "Admins can view all reward logs" on public.reward_activity_logs;
create policy "Admins can view all reward logs" on public.reward_activity_logs as permissive for select to public
  using (public.is_admin());

drop policy if exists "Admins can manage rules_engine" on public.rules_engine;
create policy "Admins can manage rules_engine" on public.rules_engine as permissive for all to public
  using (public.is_admin());

drop policy if exists "Allow admins to update errors" on public.site_errors;
create policy "Allow admins to update errors" on public.site_errors as permissive for update to public
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Allow admins to view errors" on public.site_errors;
create policy "Allow admins to view errors" on public.site_errors as permissive for select to authenticated
  using (public.is_admin());

drop policy if exists "Admins view activity log" on public.subdomain_activity_log;
create policy "Admins view activity log" on public.subdomain_activity_log as permissive for select to authenticated
  using (public.is_admin());
drop policy if exists "Admins view all requests" on public.subdomain_request_queue;
create policy "Admins view all requests" on public.subdomain_request_queue as permissive for select to authenticated
  using (public.is_admin());
drop policy if exists "Admins view all subdomains" on public.subdomain_requests;
create policy "Admins view all subdomains" on public.subdomain_requests as permissive for select to authenticated
  using (public.is_admin());

drop policy if exists "Admins can manage ticket_distribution_config" on public.ticket_distribution_config;
create policy "Admins can manage ticket_distribution_config" on public.ticket_distribution_config as permissive for all to public
  using (public.is_admin());

drop policy if exists "Admin can manage tags" on public.ticket_tags;
create policy "Admin can manage tags" on public.ticket_tags as permissive for all to public
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists report_select_all on public.user_reports;
create policy report_select_all on public.user_reports as permissive for select to public
  using ((auth.uid() = user_id) or public.is_admin());
drop policy if exists report_update_all on public.user_reports;
create policy report_update_all on public.user_reports as permissive for update to public
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins can insert wallets" on public.user_wallets;
create policy "Admins can insert wallets" on public.user_wallets as permissive for insert to public
  with check (public.is_admin());
drop policy if exists "Admins can update wallets" on public.user_wallets;
create policy "Admins can update wallets" on public.user_wallets as permissive for update to public
  using (public.is_admin());
drop policy if exists wallet_select_all on public.user_wallets;
create policy wallet_select_all on public.user_wallets as permissive for select to public
  using ((auth.uid() = user_id) or public.is_admin());

drop policy if exists waitlist_entries_admin_all on public.waitlist_entries;
create policy waitlist_entries_admin_all on public.waitlist_entries as permissive for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins can manage working_hours" on public.working_hours;
create policy "Admins can manage working_hours" on public.working_hours as permissive for all to public
  using (public.is_admin());

-- شعارات النطاقات الفرعية في Storage
drop policy if exists "Admin delete subdomain logos" on storage.objects;
create policy "Admin delete subdomain logos" on storage.objects as permissive for delete to public
  using ((bucket_id = 'subdomain-logos') and public.is_admin());
drop policy if exists "Admin update subdomain logos" on storage.objects;
create policy "Admin update subdomain logos" on storage.objects as permissive for update to public
  using ((bucket_id = 'subdomain-logos') and public.is_admin());
drop policy if exists "Admin upload subdomain logos" on storage.objects;
create policy "Admin upload subdomain logos" on storage.objects as permissive for insert to public
  with check ((bucket_id = 'subdomain-logos') and public.is_admin());

-- ── role = 'admin' ∨ email = 'support@…' → is_admin() ───────────────────────
drop policy if exists "Admins can view all api_keys" on public.api_keys;
create policy "Admins can view all api_keys" on public.api_keys as permissive for select to public
  using (public.is_admin());
drop policy if exists "Admins can view all bot_api_keys" on public.bot_api_keys;
create policy "Admins can view all bot_api_keys" on public.bot_api_keys as permissive for select to public
  using (public.is_admin());
drop policy if exists "Admins can view all bot_settings" on public.bot_settings;
create policy "Admins can view all bot_settings" on public.bot_settings as permissive for select to public
  using (public.is_admin());
drop policy if exists "Admins can view all integrations" on public.integrations;
create policy "Admins can view all integrations" on public.integrations as permissive for select to public
  using (public.is_admin());
-- نسخة مكرّرة حرفيًا من السابقة (نفس الشرط بترتيب آخر): سياستان SELECT متساويتان لا تضيفان شيئًا.
drop policy if exists "Support can view all integrations" on public.integrations;

-- ── role in ('admin','support') → is_platform_staff() ───────────────────────
drop policy if exists "Staff manage service reports" on public.customer_service_reports;
create policy "Staff manage service reports" on public.customer_service_reports as permissive for all to authenticated
  using (public.is_platform_staff()) with check (public.is_platform_staff());

drop policy if exists "Staff can write incidents" on public.incidents;
create policy "Staff can write incidents" on public.incidents as permissive for all to authenticated
  using (public.is_platform_staff()) with check (public.is_platform_staff());

drop policy if exists "Staff can read article feedback" on public.kb_article_feedback;
create policy "Staff can read article feedback" on public.kb_article_feedback as permissive for select to authenticated
  using (public.is_platform_staff());

drop policy if exists "Staff can read all articles" on public.knowledge_base;
create policy "Staff can read all articles" on public.knowledge_base as permissive for select to authenticated
  using (public.is_platform_staff());
drop policy if exists "Staff can write articles" on public.knowledge_base;
create policy "Staff can write articles" on public.knowledge_base as permissive for all to authenticated
  using (public.is_platform_staff()) with check (public.is_platform_staff());

drop policy if exists "Staff can write service history" on public.service_status_history;
create policy "Staff can write service history" on public.service_status_history as permissive for all to authenticated
  using (public.is_platform_staff()) with check (public.is_platform_staff());

drop policy if exists "Staff can write services" on public.services;
create policy "Staff can write services" on public.services as permissive for all to authenticated
  using (public.is_platform_staff()) with check (public.is_platform_staff());

drop policy if exists "Staff can manage suggested questions" on public.suggested_questions;
create policy "Staff can manage suggested questions" on public.suggested_questions as permissive for all to authenticated
  using (public.is_platform_staff()) with check (public.is_platform_staff());

-- ── المحفظة المركزية → can_manage_central_wallet() ──────────────────────────
drop policy if exists "Only support email can update central wallet" on public.central_wallet;
create policy "Only support email can update central wallet" on public.central_wallet as permissive for update to public
  using (public.can_manage_central_wallet());
drop policy if exists "Only support email can view central wallet" on public.central_wallet;
create policy "Only support email can view central wallet" on public.central_wallet as permissive for select to public
  using (public.can_manage_central_wallet());
drop policy if exists "Only support email can insert transactions" on public.central_wallet_transactions;
create policy "Only support email can insert transactions" on public.central_wallet_transactions as permissive for insert to public
  with check (public.can_manage_central_wallet());
drop policy if exists "Only support email can view transactions" on public.central_wallet_transactions;
create policy "Only support email can view transactions" on public.central_wallet_transactions as permissive for select to public
  using (public.can_manage_central_wallet());

-- ============================================================================
-- 3) الدوال — سطر الفحص وحده يتغير، والجسم منسوخ من الإنتاج حرفيًا
-- ============================================================================

-- أتمتة سير العمل (wf_*): سياسات wf_leads/wf_node_types/wf_run_steps/wf_runs… كلها عبرها
CREATE OR REPLACE FUNCTION public.wf_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.is_admin();
$function$;

CREATE OR REPLACE FUNCTION public.approve_reward_report(p_report_id uuid, p_actual_points integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_report public.user_reports;
    v_wallet public.user_wallets;
    v_new_total integer;
    v_was_pro boolean;
BEGIN
    -- [117] is_admin() بدل الرتبة الحرفية — تشمل المالك في سياق owner/admin
    IF NOT coalesce(public.is_admin(), false) THEN
        RAISE EXCEPTION 'غير مصرح: هذا الإجراء متاح للأدمن فقط';
    END IF;

    IF p_actual_points IS NULL OR p_actual_points < 0 THEN
        RAISE EXCEPTION 'قيمة النقاط غير صالحة';
    END IF;

    SELECT * INTO v_report FROM public.user_reports WHERE id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'البلاغ غير موجود';
    END IF;
    IF v_report.status <> 'pending' THEN
        RAISE EXCEPTION 'تمت مراجعة هذا البلاغ بالفعل';
    END IF;

    UPDATE public.user_reports
        SET status = 'approved', actual_points = p_actual_points, approved_at = now()
        WHERE id = p_report_id;

    INSERT INTO public.user_wallets (user_id, total_points, available_points, pending_points)
    VALUES (v_report.user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_wallet FROM public.user_wallets WHERE user_id = v_report.user_id FOR UPDATE;
    v_was_pro := COALESCE(v_wallet.is_pro, false);
    v_new_total := COALESCE(v_wallet.total_points, 0) + p_actual_points;

    UPDATE public.user_wallets SET
        total_points = v_new_total,
        available_points = COALESCE(available_points, 0) + p_actual_points,
        pending_points = GREATEST(0, COALESCE(pending_points, 0) - COALESCE(v_report.estimated_points, 0)),
        membership_level = public.calc_membership_level(v_new_total),
        is_pro = (v_new_total >= 1000),
        pro_badge_earned_at = CASE WHEN v_new_total >= 1000 AND NOT v_was_pro THEN now() ELSE pro_badge_earned_at END,
        updated_at = now()
        WHERE user_id = v_report.user_id;

    -- [008] Only line added. Transaction-local, so it cannot leak past this call.
    PERFORM set_config('app.bypass_profile_points_guard', 'on', true);

    UPDATE public.profiles SET points = v_new_total WHERE id = v_report.user_id;

    INSERT INTO public.reward_activity_logs (user_id, activity_type, details)
    VALUES (v_report.user_id, 'report_approved', jsonb_build_object('reportId', p_report_id, 'actualPoints', p_actual_points, 'totalPoints', v_new_total));

    RETURN jsonb_build_object(
        'report_id', p_report_id,
        'user_id', v_report.user_id,
        'total_points', v_new_total,
        'is_pro', (v_new_total >= 1000)
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_reward_report(p_report_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_report public.user_reports;
BEGIN
    -- [117] is_admin() بدل الرتبة الحرفية — تشمل المالك في سياق owner/admin
    IF NOT coalesce(public.is_admin(), false) THEN
        RAISE EXCEPTION 'غير مصرح: هذا الإجراء متاح للأدمن فقط';
    END IF;

    SELECT * INTO v_report FROM public.user_reports WHERE id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'البلاغ غير موجود';
    END IF;
    IF v_report.status <> 'pending' THEN
        RAISE EXCEPTION 'تمت مراجعة هذا البلاغ بالفعل';
    END IF;

    UPDATE public.user_reports
        SET status = 'rejected', rejection_reason = p_reason, approved_at = now()
        WHERE id = p_report_id;

    UPDATE public.user_wallets
        SET pending_points = GREATEST(0, COALESCE(pending_points, 0) - COALESCE(v_report.estimated_points, 0)),
            updated_at = now()
        WHERE user_id = v_report.user_id;

    INSERT INTO public.reward_activity_logs (user_id, activity_type, details)
    VALUES (v_report.user_id, 'report_rejected', jsonb_build_object('reportId', p_report_id, 'reason', p_reason));

    RETURN jsonb_build_object('report_id', p_report_id, 'user_id', v_report.user_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_service_report_summary()
 RETURNS TABLE(service_id uuid, service_name text, incident_id uuid, episode_key text, report_count bigint, first_reported timestamp with time zone, last_reported timestamp with time zone, reporters jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- [117] is_platform_staff() بدل الرتبتين الحرفيتين — تشمل المالك في سياق owner/admin
  if not coalesce(public.is_platform_staff(), false) then
    raise exception 'غير مصرّح';
  end if;

  return query
  select r.service_id,
         s.name::text,
         r.incident_id,
         r.episode_key,
         count(*)          as report_count,
         min(r.created_at) as first_reported,
         max(r.created_at) as last_reported,
         jsonb_agg(
           jsonb_build_object(
             'user_id',     r.user_id,
             'name',        coalesce(pr.full_name, pr.email, 'عميل'),
             'reported_at', r.created_at
           ) order by r.created_at
         ) as reporters
    from public.customer_service_reports r
    join public.services s  on s.id = r.service_id
    left join public.profiles pr on pr.id = r.user_id
   where r.status <> 'resolved'
   group by r.service_id, s.name, r.incident_id, r.episode_key
   order by count(*) desc, max(r.created_at) desc;
end;
$function$;

-- دالتا المحفظة المركزية: نفس الجسم، والشرط الأول can_manage_central_wallet()
DO $$
DECLARE
  v_fn regprocedure;
  v_def text;
  v_old text := $q$IF COALESCE(auth.jwt() ->> 'email', '') != 'support@mad3oom.online' THEN$q$;
  v_new text := $q$IF NOT COALESCE(public.can_manage_central_wallet(), false) THEN -- [117] support@ أو المالك في سياقه$q$;
BEGIN
  FOREACH v_fn IN ARRAY array['public.manage_user_points(text,bigint,text)'::regprocedure,
                             'public.transfer_points_from_central(text,bigint)'::regprocedure] LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(v_new in v_def) > 0 THEN CONTINUE; END IF;          -- مطبَّق من قبل (إعادة تشغيل)
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '117: % لا يحمل سطر فحص البريد المتوقع مرة واحدة — انحراف عن الإنتاج', v_fn;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END LOOP;
END $$;

-- ============================================================================
-- 4) تحقّق بَعدي: لا سياسة تفحص رتبة المنادي حرفيًا، ولا تفويض ببريد profiles
-- ============================================================================
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(schemaname || '.' || tablename || ' «' || policyname || '»', '، ')
    INTO v_left
    FROM pg_policies
   WHERE schemaname IN ('public', 'storage')
     AND (coalesce(qual, '') || coalesce(with_check, '')) ~ '(''admin''::text|profiles\.email|support@mad3oom)';
  -- سياسات «Support can …» على tickets/ticket_replies/whatsapp_wallets تمنح رتبة support وحدها بجوار
  -- is_admin()؛ المالك يمرّ من السياسة الأخرى، فتبقى كما هي.
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION '117: سياسات ما زالت تفحص الرتبة أو البريد حرفيًا: %', v_left;
  END IF;
  RAISE NOTICE '117: سياسات الإدارة والطاقم والمحفظة المركزية واعية بالسياق';
END $$;
