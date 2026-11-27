-- ============================================================================
-- 145_supervises_same_company على نسخة مطابقة للإنتاج حتى 093 + 095 … 107
--
--   ⓪ قبل 145 والعلم مطفأ: التسريب مُثبَت لا مفترَض — مالك أ يرى تذكرة شركة ب
--      لعميل تابع له بعضوية ثانوية (TB2)، وردودها ومرفقاتها، عبر supervises؛
--      والعلم مفعّلًا يُغلقها أصلًا (107 + 097) بلا تغيير.
--   ① بعد 145: التسريب مغلق والعلم مطفأ — وكل ما في نفس الشركة كما كان:
--      مالك أ يرى تذاكر وملفات عملائه (TA1/TA2/TA1S)، ويعيد فتح تذكرة مدعوم
--      قديمة لعميله؛ والموظفون (AS مشرف أ) يرون تذاكر شركتهم لا غيرها؛
--      والعلم مفعّلًا بلا أي تغيير عن قبل 145.
--   ② النقل A1 من أ إلى ب (بموافقة الطرفين): علاقة الإشراف تنتقل مع العضوية
--      الأساسية — مالك ب يشرف على A1 ويرى ملفه، ومالك أ لا يشرف عليه ولا يرى
--      ملفه؛ وتذاكر مدعوم القديمة (TA1S) تظل مغلقة على مالك ب بقاعدة 097/107
--      كما كانت قبل 145 (لا رؤية جديدة ولا مفقودة — 145 لا يغيّرها).
--   ③ التراجع: تعود الثغرة = الاختبار يكشفها (TB2 يعود مرئيًا لمالك أ والعلم
--      مطفأ)؛ ثم تُعاد 145 فيُغلق التسريب مجددًا، والبصمات كما هي.
--   ترتيب المراحل ⓪ ← ① ← ③ ← ② عمدًا: إثبات عودة التسريب في ③ يحتاج
--      العلم مطفأً، وحارس 101 يمنع إطفاءه بعد أي نقل مكتمل — فلو جاء النقل
--      (②) قبل التراجع (③) صار إثبات العودة مستحيل الوصول بالتصميم.
--
-- تنبيه نطاق: رؤية مالك الوجهة لتذاكر مدعوم القديمة بعد النقل «والعلم مطفأ»
-- لا تُختبَر هنا لأن حارس 101 يمنع إطفاء العلم بعد أي نقل مكتمل أصلًا — تلك
-- الحالة مستحيلة الوصول بعد النقل بتصميم النظام، لا نقص في هذا الاختبار.
-- ما يُثبَت هنا بعد النقل هو انتقال علاقة الإشراف نفسها (supervises + الملف).
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
\i tests/fixtures/prod-shape/chain-to-093.sql
\i migrations/094_continuity_reminders.sql
SET search_path = public, extensions;
\i tests/fixtures/tenancy/harness.sql
\i migrations/095_account_boundaries.sql
\i migrations/096_company_memberships.sql
SET search_path = public, extensions;
SET check_function_bodies = off;
\i tests/fixtures/tenancy/tickets.sql
\i migrations/097_ticket_scope_isolation.sql
\i migrations/098_company_permissions_usage_ledger.sql
\i migrations/099_admin_hierarchy.sql
\i migrations/100_company_documents.sql
\i migrations/101_customer_transfers_carry.sql
SET search_path = public, extensions;
\i migrations/102_company_conversations.sql
\i migrations/103_admin_hierarchy_followups.sql
\i migrations/104_company_documents_followups.sql
SET search_path = public, extensions;
\i migrations/105_account_hierarchy_customers.sql
\i migrations/106_account_request_execution.sql
\i migrations/107_isolation_readiness.sql
SET search_path = public, extensions;

CREATE FUNCTION t.mem(p_user text, p_company text) RETURNS text LANGUAGE sql AS $$
  select coalesce((select case when is_primary then 'primary' else 'secondary' end || ':' || status
                     from public.company_memberships where user_id = t.u(p_user) and company_id = t.u(p_company)
                     order by joined_at desc, id desc limit 1), 'none') $$;
CREATE FUNCTION t.join_b(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM t.call(t.u('OB'), format('public.company_invite_customer(%L)', lower(p) || '@tenancy.test'));
  PERFORM t.call(t.u(p), format('public.company_invitation_respond(%L::uuid, true)',
                 (SELECT id FROM public.company_membership_invitations WHERE invited_email = lower(p) || '@tenancy.test' AND status = 'pending')));
END $$;
-- بصمات ما لا يجوز أن يغيّره 145: دوال العزل والنطاق والعضويات، والسياسات
-- إلا tickets_select_policy (طبقة شركة التذكرة قصدًا — تُحفظ بصمتها pol1
-- بعد 145 وتُقارن بها عند إعادة التطبيق؛ وبصمة pol0 تعود عند التراجع).
CREATE FUNCTION t.fn_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(f::regprocedure), '#' order by f))
    from unnest(array['public._ticket_row_visible(uuid,text,uuid)', 'public._ticket_id_visible(uuid)',
                      'public._isolation_on()', 'public.current_company_id()', 'public.company_of(uuid)',
                      'public._company_ticket_row_access(uuid,uuid,text)', 'public._company_staff_role_of(uuid,uuid)',
                      'public._ticket_customer_company(uuid)', 'public._company_customer_active(uuid,uuid)',
                      'public.is_owner_or_super_of(uuid)', 'public.is_platform_staff()',
                      'public.has_elevated_authority()', 'public.company_has_feature(text)']) f $$;
CREATE FUNCTION t.pol_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(concat_ws('|', tablename, policyname, permissive, cmd, qual, with_check), '#'
                        order by tablename, policyname))
    from pg_policies where schemaname = 'public' $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الإعداد: عميل أ2 بعضوية ثانوية في ب + تذكرته في ب ─────────────────────
-- TB2: تذكرة شركة ب لعميل أ2 (أساسي في أ، ثانوي في ب) — عين التسريب.
DO $$
BEGIN
  PERFORM t.sw('multi_company_memberships_enabled', true);
  PERFORM t.sw('company_isolation_enforced', false);
  PERFORM t.join_b('A2');
  PERFORM t.ok(t.mem('A2', 'CA') = 'primary:active', 'SETUP A2 primary in A');
  PERFORM t.ok(t.mem('A2', 'CB') = 'secondary:active', 'SETUP A2 secondary in B');
  INSERT INTO public.tickets (id, user_id, title, description, status, priority, category, scope, company_id, created_at)
  VALUES ('7b000000-0000-4000-8000-000000000b22', t.u('A2'), 'طلب من ب', 'تفاصيل أ2 في ب', 'open', 'medium', 'other', 'company', t.u('CB'), now() - interval '1 day');
  INSERT INTO public.ticket_replies (id, ticket_id, user_id, message)
  VALUES ('7c000000-0000-4000-8000-000000000b22', '7b000000-0000-4000-8000-000000000b22', t.u('A2'), 'متابعة من ب');
  INSERT INTO public.ticket_attachments (ticket_id, reply_id, file_url, file_name, file_size, mime_type, uploaded_by, file_path)
  VALUES ('7b000000-0000-4000-8000-000000000b22', '7c000000-0000-4000-8000-000000000b22', 'x', 'b2.png', 10, 'image/png', t.u('A2'), t.path('A2', '7b000000-0000-4000-8000-000000000b22', 'b2.png'));
  INSERT INTO storage.objects (bucket_id, name, owner)
  VALUES ('tickets', t.path('A2', '7b000000-0000-4000-8000-000000000b22', 'b2.png'), t.u('A2'));
  INSERT INTO t.saved VALUES ('fn0', t.fn_digest()), ('pol0', t.pol_digest());
END $$;

-- ══ ⓪ قبل 145: التسريب موجود والعلم مطفأ ═════════════════════════════════
DO $$
BEGIN
  -- ضوابط: مالك أ يشرف على عميله أ2، ولا يشرف على عميل ب (B1)
  PERFORM t.ok(t.call(t.u('OA'), format('public.supervises(%L::uuid)', t.u('A2'))) = 'true'::jsonb, 'PRE supervises A2');
  PERFORM t.ok(t.call(t.u('OA'), format('public.supervises(%L::uuid)', t.u('B1'))) = 'false'::jsonb, 'PRE no supervises B1');
  -- التسريب: تذكرة شركة ب لعميل أ2 في نطاق مالك أ، ومرئية RLS، وردودها ومرفقاتها
  PERFORM t.ok(t.call(t.u('OA'), 'public.ticket_in_my_scope(''7b000000-0000-4000-8000-000000000b22''::uuid)') = 'true'::jsonb, 'LEAK scope TB2');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.tickets where id = ''7b000000-0000-4000-8000-000000000b22''') = 1, 'LEAK RLS ticket TB2');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.ticket_replies where ticket_id = ''7b000000-0000-4000-8000-000000000b22''') = 1, 'LEAK RLS reply TB2');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.ticket_attachments where ticket_id = ''7b000000-0000-4000-8000-000000000b22''') = 1, 'LEAK RLS attachment TB2');
  PERFORM t.ok(t.call(t.u('OA'), 'public.can_access_ticket(''7b000000-0000-4000-8000-000000000b22''::uuid)') = 'true'::jsonb, 'LEAK can_access TB2');
  -- والعلم مفعّلًا يغلقها أصلًا (107 + 097) — بلا تغيير يُنتظَر من 145 هنا
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.ok(t.call(t.u('OA'), 'public.ticket_in_my_scope(''7b000000-0000-4000-8000-000000000b22''::uuid)') = 'false'::jsonb, 'PRE-ON scope TB2 blocked');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.tickets where id = ''7b000000-0000-4000-8000-000000000b22''') = 0, 'PRE-ON RLS TB2 blocked');
  PERFORM t.sw('company_isolation_enforced', false);
  RAISE NOTICE 'PASS ⓪ قبل 145: التسريب مُثبَت والعلم مطفأ، والعلم مفعّلًا يغلقه أصلًا';
END $$;

-- ══ ① 145 ════════════════════════════════════════════════════════════════
\i migrations/145_supervises_same_company.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT v FROM t.saved WHERE k = 'fn0') = t.fn_digest(), '145 unchanged functions');
  -- (تصحيح) السياسة تتغير قصدًا: طبقة شركة التذكرة في tickets_select_policy.
  PERFORM t.ok((SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND policyname = 'tickets_select_policy') like '%_ticket_supervises_visible%', '145 policy has ticket-company layer');
  PERFORM t.ok((SELECT v FROM t.saved WHERE k = 'pol0') <> t.pol_digest(), '145 policy digest changed as intended');
  INSERT INTO t.saved VALUES ('pol1', t.pol_digest());
  PERFORM t.ok(pg_get_functiondef('public.can_access_ticket(uuid)'::regprocedure) like '%t.company_id is null%', '145 can_access has ticket-company layer');
  PERFORM t.ok(pg_get_functiondef('public.supervises(uuid)'::regprocedure) like '%_supervises_same_company%', '145 supervises narrowed');
  -- العلم مطفأ: التسريب مغلق
  PERFORM t.ok(t.call(t.u('OA'), 'public.ticket_in_my_scope(''7b000000-0000-4000-8000-000000000b22''::uuid)') = 'false'::jsonb, 'FIX scope TB2 closed');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.tickets where id = ''7b000000-0000-4000-8000-000000000b22''') = 0, 'FIX RLS ticket TB2 closed');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.ticket_replies where ticket_id = ''7b000000-0000-4000-8000-000000000b22''') = 0, 'FIX RLS reply TB2 closed');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.ticket_attachments where ticket_id = ''7b000000-0000-4000-8000-000000000b22''') = 0, 'FIX RLS attachment TB2 closed');
  PERFORM t.ok(t.call(t.u('OA'), 'public.can_access_ticket(''7b000000-0000-4000-8000-000000000b22''::uuid)') = 'false'::jsonb, 'FIX can_access TB2 closed');
  -- نفس الشركة كما كانت: مالك أ يرى تذاكر وملفات عملائه، ويعيد فتح تذكرة مدعوم قديمة
  PERFORM t.ok(t.call(t.u('OA'), format('public.supervises(%L::uuid)', t.u('A2'))) = 'true'::jsonb, 'FIX supervises A2 kept');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.tickets where id = %L', t.k('TA1'))) = 1, 'FIX OA sees TA1');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.tickets where id = %L', t.k('TA2'))) = 1, 'FIX OA sees TA2');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.tickets where id = %L', t.k('TA1S'))) = 1, 'FIX OA sees TA1S');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.profiles where id = %L', t.u('A2'))) = 1, 'FIX OA sees A2 profile');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.profiles where id = %L', t.u('B1'))) = 0, 'FIX OA no B1 profile');
  PERFORM t.ok(t.rows(t.u('OB'), format('public.profiles where id = %L', t.u('B1'))) = 1, 'FIX OB sees B1 profile');
  PERFORM t.ok(t.rows(t.u('OB'), format('public.tickets where id = %L', t.k('TB1'))) = 1, 'FIX OB sees TB1');
  -- إعداد: وضع TA1S في resolved لاختبار إعادة الفتح — عبر ممر الإعداد
  -- الموثق (app.bypass_ticket_restrictions)، كـ ticket-reopen-close:97-99.
  -- بلا الممر يرفض محفز 070 التحديث المباشر (بلا هوية أدمن بعد تصفير الـ JWT).
  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);
  UPDATE public.tickets SET status = 'resolved' WHERE id = t.k('TA1S');
  PERFORM set_config('app.bypass_ticket_restrictions', 'off', true);
  PERFORM t.ok(t.err(t.u('OA'), format('public.reopen_ticket_in_my_scope(%L::uuid)', t.k('TA1S'))) = 'ok', 'FIX OA reopens TA1S');
  PERFORM t.ok(t.err(t.u('OA'), 'public.reopen_ticket_in_my_scope(''7b000000-0000-4000-8000-000000000b22''::uuid)') = '42501', 'FIX OA cannot reopen TB2');
  -- موظف أ إلى مدعوم (TAS): رؤية المالك لتذكرة موظفه الشخصية محفوظة كما كانت والعلم مطفأ
  PERFORM t.ok(t.call(t.u('OA'), format('public.ticket_in_my_scope(%L::uuid)', t.k('TAS'))) = 'true'::jsonb, 'FIX OA scope TAS kept');
  -- حساب بلا شركة (PU): لا يشرف عليه أحد، ويرى تذكرته هو
  PERFORM t.ok(t.call(t.u('OA'), format('public.supervises(%L::uuid)', t.u('PU'))) = 'false'::jsonb, 'FIX no supervises PU');
  PERFORM t.ok(t.call(t.u('PU'), format('public.ticket_in_my_scope(%L::uuid)', t.k('TPU'))) = 'true'::jsonb, 'FIX PU own ticket');
  -- الموظفون: مشرف أ يرى تذاكر شركته لا غيرها (098 مفعّلًا لهذا القسم)
  PERFORM t.sw('company_permissions_enabled', true);
  PERFORM t.ok(t.rows(t.u('AS'), format('public.tickets where id = %L', t.k('TA1'))) = 1, 'FIX AS sees TA1');
  PERFORM t.ok(t.rows(t.u('AS'), 'public.tickets where id = ''7b000000-0000-4000-8000-000000000b22''') = 0, 'FIX AS no TB2');
  -- العلم مفعّلًا: بلا أي تغيير عن قبل 145
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.ok(t.call(t.u('OA'), 'public.ticket_in_my_scope(''7b000000-0000-4000-8000-000000000b22''::uuid)') = 'false'::jsonb, 'FIX-ON scope TB2 still blocked');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.tickets where id = %L', t.k('TA1'))) = 1, 'FIX-ON OA still sees TA1');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.tickets where id = %L', t.k('TA1S'))) = 0, 'FIX-ON OA TA1S blocked by 097/107 as before');
  PERFORM t.sw('company_isolation_enforced', false);
  RAISE NOTICE 'PASS ① بعد 145: التسريب مغلق والعلم مطفأ، ونفس الشركة والموظفون كما كانوا';
END $$;

-- ══ ③ التراجع ثم إعادة التطبيق ═════════════════════════════════════════
\i migrations/_rollback/145_supervises_same_company.down.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(pg_get_functiondef('public.supervises(uuid)'::regprocedure) not like '%_supervises_same_company%', 'ROLLBACK supervises restored');
  PERFORM t.ok((SELECT v FROM t.saved WHERE k = 'pol0') = t.pol_digest(), 'ROLLBACK policy restored');
  PERFORM t.sw('company_isolation_enforced', false);
  PERFORM t.ok(t.call(t.u('OA'), 'public.ticket_in_my_scope(''7b000000-0000-4000-8000-000000000b22''::uuid)') = 'true'::jsonb, 'ROLLBACK leak returns (test detects it)');
  RAISE NOTICE 'PASS ③ التراجع يعيد الثغرة والاختبار يكشفها';
END $$;
\i migrations/145_supervises_same_company.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(pg_get_functiondef('public.supervises(uuid)'::regprocedure) like '%_supervises_same_company%', 'REAPPLY supervises narrowed again');
  PERFORM t.ok(t.call(t.u('OA'), 'public.ticket_in_my_scope(''7b000000-0000-4000-8000-000000000b22''::uuid)') = 'false'::jsonb, 'REAPPLY leak closed again');
  PERFORM t.ok((SELECT v FROM t.saved WHERE k = 'fn0') = t.fn_digest(), 'REAPPLY unchanged functions');
  PERFORM t.ok((SELECT v FROM t.saved WHERE k = 'pol1') = t.pol_digest(), 'REAPPLY policy digest = pol1');
  RAISE NOTICE 'PASS ④ إعادة التطبيق: التسريب مغلق مجددًا والبصمات كما هي';
END $$;

-- ══ ② النقل A1 من أ إلى ب ═══════════════════════════════════════════════
DO $$
DECLARE k uuid := gen_random_uuid(); r jsonb; x uuid;
BEGIN
  PERFORM t.sw('customer_transfers_enabled', true);
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.join_b('A1');
  PERFORM t.ok(t.mem('A1', 'CB') = 'secondary:active', 'XFER A1 secondary in B');
  r := t.call(t.u('A1'), format('public.transfer_request(%L::uuid, true, %L::uuid)', t.u('CB'), k));
  x := (r ->> 'transfer_id')::uuid;
  PERFORM t.ok(r ->> 'status' = 'pending', 'XFER pending');
  PERFORM t.ok(t.call(t.u('OB'), format('public.transfer_decide(%L::uuid, true)', x)) ->> 'waiting_for' = 'source', 'XFER destination first');
  r := t.call(t.u('OA'), format('public.transfer_decide(%L::uuid, true, true)', x));
  PERFORM t.ok(r ->> 'status' = 'completed' AND (r ->> 'kept_source_secondary')::boolean, 'XFER completed');
  PERFORM t.ok(t.mem('A1', 'CB') = 'primary:active' AND t.mem('A1', 'CA') = 'secondary:active'
           AND (SELECT super_user_id FROM public.profiles WHERE id = t.u('A1')) = t.u('OB'), 'XFER atomic state');
  -- علاقة الإشراف انتقلت مع العضوية الأساسية
  PERFORM t.ok(t.call(t.u('OB'), format('public.supervises(%L::uuid)', t.u('A1'))) = 'true'::jsonb, 'XFER OB supervises A1');
  PERFORM t.ok(t.call(t.u('OA'), format('public.supervises(%L::uuid)', t.u('A1'))) = 'false'::jsonb, 'XFER OA no longer supervises A1');
  PERFORM t.ok(t.rows(t.u('OB'), format('public.profiles where id = %L', t.u('A1'))) = 1, 'XFER OB sees A1 profile');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.profiles where id = %L', t.u('A1'))) = 0, 'XFER OA no A1 profile');
  -- تذاكر مدعوم القديمة تظل مغلقة على مالك ب بقاعدة 097/107 كما قبل 145 (لا رؤية جديدة ولا مفقودة)
  PERFORM t.ok(t.rows(t.u('OB'), format('public.tickets where id = %L', t.k('TA1S'))) = 0, 'XFER OB TA1S still blocked by 097/107');
  PERFORM t.ok(t.call(t.u('OB'), format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1S'))) = 'false'::jsonb, 'XFER OB scope TA1S still blocked');
  RAISE NOTICE 'PASS ② النقل: الإشراف انتقل مع العضوية الأساسية، وتذاكر مدعوم القديمة كما كانت';
END $$;

SELECT 'ALL supervises-same-company-145 tests passed';
