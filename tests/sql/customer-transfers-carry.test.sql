-- ============================================================================
-- 101_customer_transfers_carry على نسخة مطابقة للإنتاج حتى 093 + 095 … 100
--
--   ① الكائنات؛ المفاتيح مطفأة؛ الحصة لكل حساب مطابقة حرفيًا لما قبل 101 (لا تذاكر منسوخة)
--   ①ب التراجع حرفيًا ثم إعادة التطبيق
--   ② المفاتيح مطفأة: لا نقل ولا نسخ، والمسار القديم كما هو
--   ③ النقل: طلب العميل، موافقة المصدر والوجهة، تنفيذ ذري، الاحتفاظ بالمصدر إضافيةً باختياره وإذن المصدر،
--      منع التكرار، طلب معلّق واحد، الرفض، النقل الاستثنائي للمالك، وتقييد المسار الخام
--   ④ النسخ: محتوى العميل وحده (لا ملاحظات داخلية ولا ردود موظفين)، تذكرة جديدة والأصل باقٍ، مرة واحدة
--      لكل وجهة، إشعار المصدر بلا كشف الوجهة، لا حصة ولا فوترة مزدوجة، ونسخ المرفقات بعامل الخدمة
--   ⑤ الوصول التاريخي: موافقة العميل واختياره ثم المالك، قراءة محدودة بمحتوى العميل، مسجَّلة، وتنتهي
--   ⑥ الثوابت، و⑦ رفض التراجع
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
\i tests/fixtures/prod-shape/chain-to-093.sql
-- 094 (PR #133، مدموج في main) يسبق 095 في الإنتاج
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
SET search_path = public, extensions;

CREATE FUNCTION t.own(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.call(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.own_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.err(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.cc(p text) RETURNS text LANGUAGE sql AS $$ select t.call(t.u(p), 'public.current_company_id()') #>> '{}' $$;
CREATE FUNCTION t.mem(p_user text, p_company text) RETURNS text LANGUAGE sql AS $$
  select coalesce((select case when is_primary then 'primary' else 'secondary' end || ':' || status
                     from public.company_memberships where user_id = t.u(p_user) and company_id = t.u(p_company)
                     order by joined_at desc, id desc limit 1), 'none') $$;
CREATE FUNCTION t.quota_all() RETURNS text LANGUAGE sql AS $$
  select string_agg(n || '=' || (public.ticket_quota_status(t.u(n)) - 'period_start' - 'resets_at')::text, ';' order by n)
    from unnest(array['OA','OB','PU','A1','A2','OW']) n $$;
CREATE FUNCTION t.join_b(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM t.call(t.u('OB'), format('public.company_invite_customer(%L)', lower(p) || '@tenancy.test'));
  PERFORM t.call(t.u(p), format('public.company_invitation_respond(%L::uuid, true)',
                 (SELECT id FROM public.company_membership_invitations WHERE invited_email = lower(p) || '@tenancy.test' AND status = 'pending')));
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO t.saved VALUES ('schema0', t.schema_digest()), ('quota0', t.quota_all());

-- ══ ① 101 ════════════════════════════════════════════════════════════════
\i migrations/101_customer_transfers_carry.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok(t.quota_all() = (SELECT s.v FROM t.saved s WHERE s.k = 'quota0'), 'OBJ quota identical per account');
  PERFORM t.ok(jsonb_array_length(public.usage_reconciliation() -> 'mismatches') = 0, 'OBJ ledger reconciles');
  PERFORM t.ok(NOT has_table_privilege('authenticated', 'public.customer_transfers', 'select')
           AND NOT has_function_privilege('authenticated', 'public.carry_copy_complete(uuid,boolean,text,text)', 'execute')
           AND NOT has_function_privilege('authenticated', 'public._transfer_execute(uuid)', 'execute'), 'OBJ grants');
  RAISE NOTICE 'PASS ① 101: المفاتيح مطفأة، حصة كل حساب حرفيًا كما قبل 101، السجل يطابق، والجداول والدوال الداخلية مغلقة';
END $$;
\i migrations/_rollback/101_customer_transfers_carry.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT s.v FROM t.saved s WHERE s.k = 'schema0'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع: حرفيًا كما قبل 101 (ومنها دوال الحصة والسجل الأربع)';
END $$;
\i migrations/101_customer_transfers_carry.sql
\i migrations/101_customer_transfers_carry.sql
SET search_path = public, extensions;

-- ══ ② المفاتيح مطفأة ═════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.err(t.u('A1'), format('public.transfer_request(%L::uuid, false, gen_random_uuid())', t.u('CB'))) = '0A000', 'OFF transfer');
  PERFORM t.ok(t.err(t.u('A1'), format('public.carry_tickets(%L::uuid, %L::uuid, array[%L::uuid], gen_random_uuid())', t.u('CA'), t.u('CB'), t.k('TA1'))) = '0A000', 'OFF carry');
  PERFORM t.ok(t.err(t.u('OB'), format('public.historical_access_request(%L::uuid, ''غرض واضح بما يكفي للطلب'')', t.u('B1'))) = '0A000', 'OFF history');
  PERFORM t.ok(t.call(t.u('A1'), 'public.h2_features()') = '{"transfers": false, "carry": false, "historical": false}'::jsonb, 'OFF features for the UI');
  RAISE NOTICE 'PASS ② المفاتيح مطفأة: لا نقل ولا نسخ ولا وصول تاريخي';
END $$;

-- ══ ③ النقل ══════════════════════════════════════════════════════════════
DO $$
DECLARE k uuid := gen_random_uuid(); r jsonb; x uuid;
BEGIN
  PERFORM t.sw('multi_company_memberships_enabled', true);
  PERFORM t.sw('customer_transfers_enabled', true);
  PERFORM t.join_b('A1');
  -- النقل يتطلب العزل وصلاحيات 098 (وإلا رأى مالك الوجهة التذاكر القديمة عبر super_user_id)
  PERFORM t.ok(t.err(t.u('A1'), format('public.transfer_request(%L::uuid, true, gen_random_uuid())', t.u('CB'))) = '0A000', 'REQ needs isolation + 098');
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.ok(t.err(t.u('A1'), format('public.transfer_request(%L::uuid, true, gen_random_uuid())', t.u('CB'))) = '0A000', 'REQ needs 098 too');
  PERFORM t.sw('company_permissions_enabled', true);
  PERFORM t.ok(t.mem('A1', 'CB') = 'secondary:active', 'SETUP A1 secondary in B');
  -- الطلب = تأكيد العميل؛ الوجهة عضوية قائمة
  PERFORM t.ok(t.err(t.u('A2'), format('public.transfer_request(%L::uuid, true, gen_random_uuid())', t.u('CB'))) = 'P0002', 'REQ no membership in destination');
  PERFORM t.ok(t.err(t.u('AS'), format('public.transfer_request(%L::uuid, true, gen_random_uuid())', t.u('CB'))) = '55000', 'REQ staff is not a customer');
  r := t.call(t.u('A1'), format('public.transfer_request(%L::uuid, true, %L::uuid)', t.u('CB'), k));
  x := (r ->> 'transfer_id')::uuid;
  PERFORM t.ok(r ->> 'status' = 'pending', 'REQ pending');
  PERFORM t.ok((t.call(t.u('A1'), format('public.transfer_request(%L::uuid, true, %L::uuid)', t.u('CB'), k)) ->> 'transfer_id')::uuid = x, 'REQ idempotent');
  PERFORM t.ok(t.err(t.u('A1'), format('public.transfer_request(%L::uuid, true, gen_random_uuid())', t.u('CB'))) = '23505', 'REQ one pending');
  -- المسار الخام مقيَّد والمفتاح مفعّل
  PERFORM t.act(t.u('EA'));
  PERFORM t.ok(t.err_super_ok(format('update public.profiles set super_user_id = %L where id = %L', t.u('OB'), t.u('A1'))) = '42501', 'RAW move blocked');
  PERFORM t.act(null);
  -- القرارات: المدير وحده، كلٌ لجهته
  PERFORM t.ok(t.err(t.u('BS'), format('public.transfer_decide(%L::uuid, true)', x)) = '42501', 'DEC supervisor no');
  PERFORM t.ok(t.err(t.u('OW'), format('public.transfer_decide(%L::uuid, true)', x)) = '42501', 'DEC unrelated no');
  PERFORM t.ok(t.call(t.u('OB'), format('public.transfer_decide(%L::uuid, true)', x)) ->> 'waiting_for' = 'source', 'DEC destination first');
  PERFORM t.ok(t.err(t.u('OB'), format('public.transfer_decide(%L::uuid, true)', x)) = '55000', 'DEC once');
  PERFORM t.ok(t.mem('A1', 'CA') = 'primary:active', 'DEC nothing moved yet');
  r := t.call(t.u('OA'), format('public.transfer_decide(%L::uuid, true, true)', x));
  PERFORM t.ok(r ->> 'status' = 'completed' AND (r ->> 'kept_source_secondary')::boolean, 'EXEC completed');
  PERFORM t.ok(t.mem('A1', 'CB') = 'primary:active' AND t.mem('A1', 'CA') = 'secondary:active'
           AND (SELECT super_user_id FROM public.profiles WHERE id = t.u('A1')) = t.u('OB') AND t.cc('A1') = t.u('CB')::text, 'EXEC atomic state');
  PERFORM t.ok((t.call(t.u('A1'), format('public.transfer_request(%L::uuid, true, %L::uuid)', t.u('CB'), k)) ->> 'status') = 'completed', 'EXEC replay');
  -- الأصل باقٍ في المصدر: التذكرة القديمة ما زالت لشركة أ
  PERFORM t.ok((SELECT company_id FROM public.tickets WHERE id = t.k('TA1')) = t.u('CA'), 'EXEC tickets stay');
  -- الرفض: A2 تنضم لـ ب وتطلب، والمصدر يرفض
  PERFORM t.join_b('A2');
  x := (t.call(t.u('A2'), format('public.transfer_request(%L::uuid, false, gen_random_uuid())', t.u('CB'))) ->> 'transfer_id')::uuid;
  PERFORM t.ok(t.call(t.u('OA'), format('public.transfer_decide(%L::uuid, false)', x)) ->> 'status' = 'rejected', 'REJ');
  PERFORM t.ok(t.mem('A2', 'CA') = 'primary:active', 'REJ nothing moved');
  -- النقل الاستثنائي للمالك
  PERFORM t.ok(t.err(t.u('EA'), format('public.owner_transfer_exceptional(%L::uuid, %L::uuid, ''سبب استثنائي واضح جدًا للنقل'', false, gen_random_uuid())', t.u('A2'), t.u('CB'))) = '42501', 'EXC elevated no');
  PERFORM t.ok(t.own_err(format('public.owner_transfer_exceptional(%L::uuid, %L::uuid, ''قصير'', false, gen_random_uuid())', t.u('A2'), t.u('CB'))) = '22023', 'EXC reason');
  k := gen_random_uuid();
  r := t.own(format('public.owner_transfer_exceptional(%L::uuid, %L::uuid, ''تصحيح ربط خاطئ بطلب موثَّق من العميل'', false, %L::uuid)', t.u('A2'), t.u('CB'), k));
  PERFORM t.ok(r ->> 'status' = 'completed' AND (r ->> 'exceptional')::boolean, 'EXC done');
  PERFORM t.ok(t.mem('A2', 'CB') = 'primary:active' AND t.mem('A2', 'CA') = 'primary:ended', 'EXC source ended');
  PERFORM t.ok(t.own(format('public.owner_transfer_exceptional(%L::uuid, %L::uuid, ''تصحيح ربط خاطئ بطلب موثَّق من العميل'', false, %L::uuid)', t.u('A2'), t.u('CB'), k)) ->> 'replayed' = 'true', 'EXC idempotent');
  PERFORM t.ctx(null);
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'customer.transfer.exceptional' AND target_user_id = t.u('A2')), 'EXC audited');
  -- قوائم المدير بلا كشف الطرف الآخر
  PERFORM t.ok(NOT (t.call(t.u('OA'), 'public.company_transfer_requests()')::text LIKE '%شركة ب%'), 'LIST no counterpart name');
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(t.call(t.u('OA'), 'public.company_transfer_requests()')) e
                        WHERE e ->> 'direction' = 'outgoing' AND (e ->> 'customer_wants_secondary')::boolean)
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.call(t.u('OB'), 'public.company_transfer_requests()')) e
                            WHERE e ->> 'direction' = 'incoming' AND e ? 'customer_wants_secondary' AND e -> 'customer_wants_secondary' <> 'null'::jsonb)
           AND t.call(t.u('BS'), 'public.company_transfer_requests()') IS NULL, 'LIST source sees the customer''s wish, destination does not');
  -- انتهاء المهلة يُحفظ (لا RAISE يلغيه) ويحرّر مكان الطلب المعلّق
  x := (t.call(t.u('A1'), format('public.transfer_request(%L::uuid, false, gen_random_uuid())', t.u('CA'))) ->> 'transfer_id')::uuid;
  UPDATE public.customer_transfers SET expires_at = now() - interval '1 second' WHERE id = x;
  PERFORM t.ok(t.call(t.u('OA'), format('public.transfer_decide(%L::uuid, true)', x)) ->> 'status' = 'expired', 'EXP decide reports expired');
  PERFORM t.ok((SELECT status FROM public.customer_transfers WHERE id = x) = 'expired', 'EXP persisted');
  x := (t.call(t.u('A1'), format('public.transfer_request(%L::uuid, false, gen_random_uuid())', t.u('CA'))) ->> 'transfer_id')::uuid;
  PERFORM t.ok(x IS NOT NULL, 'EXP slot freed');
  PERFORM t.ok(t.call(t.u('A1'), format('public.transfer_cancel(%L::uuid)', x)) ->> 'status' = 'cancelled', 'EXP cancel');
  PERFORM t.sw('company_permissions_enabled', false);
  PERFORM t.sw('company_isolation_enforced', false);
  RAISE NOTICE 'PASS ③ النقل: العميل يطلب (تأكيده)، المديران يقرران، التنفيذ ذري عند اكتمالهما، المصدر يبقى إضافية باختيار العميل وإذن المصدر، منع التكرار وطلب معلّق واحد، الرفض لا يغيّر شيئًا، الاستثنائي للمالك بسبب مسجَّل، والمسار الخام مقيَّد';
END $$;

-- ══ ④ النسخ ══════════════════════════════════════════════════════════════
DO $$
DECLARE k uuid := gen_random_uuid(); r jsonb; nt uuid; q0 jsonb; q1 jsonb; c jsonb; item uuid;
BEGIN
  PERFORM t.sw('ticket_carry_enabled', true);
  -- رد للعميل ومرفقه على تذكرته في أ (إلى جانب رد الشركة والملاحظة الداخلية في العُدّة)
  INSERT INTO public.ticket_replies (id, ticket_id, user_id, message) VALUES ('7c000000-0000-4000-8000-0000000000a1', t.k('TA1'), t.u('A1'), 'رسالتي الثانية للشركة');
  INSERT INTO public.ticket_attachments (ticket_id, reply_id, file_url, file_name, file_size, mime_type, uploaded_by, file_path)
  VALUES (t.k('TA1'), '7c000000-0000-4000-8000-0000000000a1', 'x', 'invoice.png', 10, 'image/png', t.u('A1'), t.path('A1', 'TA1', 'invoice.png'));
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('tickets', t.path('A1', 'TA1', 'invoice.png'), t.u('A1'));
  -- صفوف مرفقات مزوّرة يكتبها العميل: ملف داخلي في مجلده (مالكه الدعم)، ومسار في مجلد غيره — لا تُنسخ أبدًا
  INSERT INTO public.ticket_attachments (ticket_id, reply_id, file_url, file_name, file_size, mime_type, uploaded_by, file_path) VALUES
    (t.k('TA1'), null, 'x', 'stolen-internal.png', 10, 'image/png', t.u('A1'), t.path('A1', 'TA1', 'internal.png')),
    (t.k('TA1'), null, 'x', 'stolen-other.png', 10, 'image/png', t.u('A1'), t.path('B1', 'TB1', 'whatever.png'));
  c := t.call(t.u('A1'), format('public.carry_candidates(%L::uuid)', t.u('CA')));
  PERFORM t.ok(jsonb_array_length(c) = 1 AND c -> 0 ->> 'id' = t.k('TA1')::text, 'CAND own company tickets only');
  PERFORM t.ok((c #>> '{0,manifest,replies_included}')::int = 1 AND (c #>> '{0,manifest,replies_excluded_staff}')::int = 1
           AND (c #>> '{0,manifest,replies_excluded_internal}')::int = 1 AND (c #>> '{0,manifest,attachments_included}')::int = 1
           AND (c #>> '{0,manifest,attachments_excluded}')::int = 4, 'CAND manifest ' || (c -> 0 -> 'manifest')::text);
  q0 := public.ticket_quota_status(t.u('A1'));
  r := t.call(t.u('A1'), format('public.carry_tickets(%L::uuid, %L::uuid, array[%L::uuid], %L::uuid)', t.u('CA'), t.u('CB'), t.k('TA1'), k));
  nt := (r -> 'tickets' ->> 0)::uuid;
  PERFORM t.ok(nt IS NOT NULL AND (r ->> 'attachments_pending')::int = 1, 'CARRY created');
  PERFORM t.ok((SELECT scope || ':' || company_id || ':' || user_id || ':' || coalesce(assigned_to::text, '-') FROM public.tickets WHERE id = nt)
             = 'company:' || t.u('CB') || ':' || t.u('A1') || ':-', 'CARRY new ticket in destination, unassigned');
  PERFORM t.ok((SELECT description LIKE '%تفاصيل أ1%' AND description LIKE '%رسالتي الثانية للشركة%'
                       AND description NOT LIKE '%رد الشركة%' AND description NOT LIKE '%ملاحظة داخلية%' AND description NOT LIKE '%مالك أ%'
                  FROM public.tickets WHERE id = nt), 'CARRY customer content only');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ticket_replies WHERE ticket_id = nt), 'CARRY no replies copied as replies');
  PERFORM t.ok((SELECT company_id FROM public.tickets WHERE id = t.k('TA1')) = t.u('CA')
           AND (SELECT count(*) FROM public.ticket_replies WHERE ticket_id = t.k('TA1')) = 3, 'CARRY original intact');
  PERFORM t.ok((t.call(t.u('A1'), format('public.carry_tickets(%L::uuid, %L::uuid, array[%L::uuid], %L::uuid)', t.u('CA'), t.u('CB'), t.k('TA1'), k)) ->> 'replayed')::boolean, 'CARRY idempotent');
  PERFORM t.ok(t.err(t.u('A1'), format('public.carry_tickets(%L::uuid, %L::uuid, array[%L::uuid], gen_random_uuid())', t.u('CA'), t.u('CB'), t.k('TA1'))) = '23505', 'CARRY once per destination');
  PERFORM t.ok(t.err(t.u('A1'), format('public.carry_tickets(%L::uuid, %L::uuid, array[%L::uuid], gen_random_uuid())', t.u('CB'), t.u('CA'), t.k('TB1'))) = 'P0002', 'CARRY not own ticket');
  PERFORM t.ok(t.err(t.u('B1'), format('public.carry_tickets(%L::uuid, %L::uuid, array[%L::uuid], gen_random_uuid())', t.u('CB'), t.u('CA'), t.k('TB1'))) = 'P0002', 'CARRY no membership in destination');
  -- المصدر يُبلَّغ بلا كشف الوجهة
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('OA') AND title = 'نسخ تذاكر بطلب عميل' AND message NOT LIKE '%شركة ب%'), 'CARRY source notified privately');
  -- لا حصة ولا فوترة مزدوجة
  q1 := public.ticket_quota_status(t.u('A1'));
  PERFORM t.ok((q1 ->> 'used')::int = (q0 ->> 'used')::int, 'BILL quota unchanged by carry');
  PERFORM t.ok((SELECT counter || ':' || units FROM public.usage_ledger WHERE ticket_id = nt) = 'none:0', 'BILL ledger not billed');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.usage_reconciliation() -> 'mismatches') e WHERE e ->> 'reason' = 'unexplained'), 'BILL reconciliation explained');
  -- العزل: الوجهة ترى المنسوخة لا الأصل؛ المصدر يرى الأصل لا المنسوخة
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.ok(t.sees('OB', 'TA1') = false AND t.rows(t.u('OB'), format('public.tickets where id = %L', nt)) = 1, 'ISO destination');
  -- بلا 098 يرى المصدر تذاكره عبر الرابط القديم وحده، والنقل يحرّكه: يُغلق ولا يتسرب (ترتيب الإطلاق: 098 قبل 101)
  PERFORM t.ok(NOT t.sees('OA', 'TA1') AND t.rows(t.u('OA'), format('public.tickets where id = %L', nt)) = 0, 'ISO source fail-closed without 098');
  PERFORM t.sw('company_permissions_enabled', true);
  PERFORM t.ok(t.sees('OA', 'TA1') AND t.rows(t.u('OA'), format('public.tickets where id = %L', nt)) = 0, 'ISO source');
  PERFORM t.ok(t.sees('OB', 'TA1') = false AND t.rows(t.u('OB'), format('public.tickets where id = %L', nt)) = 1, 'ISO destination with 098');
  PERFORM t.sw('company_permissions_enabled', false);
  PERFORM t.sw('company_isolation_enforced', false);
  -- نسخ المرفق: عامل الخدمة؛ لا تأكيد بلا ملف جديد
  item := (public.carry_copy_queue() -> 0 ->> 'id')::uuid;
  PERFORM t.ok(item IS NOT NULL AND t.err(t.u('A1'), 'public.carry_copy_queue()') = '42501', 'COPY queue service only');
  PERFORM t.ok(t.err_super_ok(format('select public.carry_copy_complete(%L, true, %L)', item, repeat('a', 64))) = '55000', 'COPY needs new object');
  INSERT INTO storage.objects (bucket_id, name, owner) SELECT 'tickets', dest_path, t.u('A1') FROM public.ticket_carry_attachments WHERE id = item;
  PERFORM t.ok(public.carry_copy_complete(item, true, repeat('a', 64)) ->> 'status' = 'copied', 'COPY complete');
  PERFORM t.ok((SELECT uploaded_by = t.u('A1') AND file_path <> t.path('A1', 'TA1', 'invoice.png') FROM public.ticket_attachments WHERE ticket_id = nt), 'COPY new object, customer-owned');
  PERFORM t.ok(public.carry_copy_queue() = '[]'::jsonb, 'COPY queue drained');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ticket_carry_attachments WHERE source_path LIKE '%internal.png' OR source_path LIKE '%whatever.png'),
               'CARRY forged attachment rows never queued');
  RAISE NOTICE 'PASS ④ النسخ: محتوى العميل وحده إلى تذكرة جديدة غير مسندة والأصل باقٍ، مرة واحدة لكل وجهة، المصدر يُبلَّغ بلا كشف الوجهة، لا حصة ولا فوترة مزدوجة، العزل بين المصدر والوجهة، ومرفقات العميل تُنسخ ملفًا جديدًا بعامل الخدمة';
END $$;

-- ══ ⑤ الوصول التاريخي ════════════════════════════════════════════════════
DO $$
DECLARE req uuid; r jsonb;
BEGIN
  PERFORM t.sw('historical_access_enabled', true);
  PERFORM t.ok(t.err(t.u('OA'), format('public.historical_access_request(%L::uuid, ''غرض واضح بما يكفي للطلب'')', t.u('B1'))) = 'P0002', 'HREQ not our customer');
  PERFORM t.ok(t.err(t.u('OB'), format('public.historical_access_request(%L::uuid, ''قصير'')', t.u('A1'))) = '22023', 'HREQ purpose');
  PERFORM t.ok(t.err(t.u('BS'), format('public.historical_access_request(%L::uuid, ''متابعة شكوى سابقة للعميل بخصوص طلبه'')', t.u('A1'))) = '42501', 'HREQ admin only');
  req := (t.call(t.u('OB'), format('public.historical_access_request(%L::uuid, ''متابعة شكوى سابقة للعميل بخصوص طلبه'')', t.u('A1'))) ->> 'request_id')::uuid;
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OB'), 'public.company_historical_requests()')) = 1
           AND t.call(t.u('OB'), 'public.company_historical_requests()') -> 0 -> 'ticket_ids' = 'null'::jsonb
           AND t.call(t.u('OA'), 'public.company_historical_requests()') = '[]'::jsonb
           AND t.call(t.u('BS'), 'public.company_historical_requests()') IS NULL, 'HLIST company admin only, own requests');
  PERFORM t.ok(t.call(t.u('A1'), 'public.my_historical_requests()') -> 0 ->> 'company_id' = t.u('CB')::text, 'HLIST customer sees requesting company');
  PERFORM t.ok((SELECT bool_and(e ->> 'company_name' <> 'شركة ب') AND bool_or(e ->> 'id' = t.k('TA1')::text) AND NOT bool_or(e ->> 'id' = t.k('TA1S')::text)
                  FROM jsonb_array_elements(t.call(t.u('A1'), 'public.my_historical_requests()') -> 0 -> 'eligible') e), 'HLIST eligible = own company tickets elsewhere');
  -- المالك لا يقرر قبل العميل (القيمة 5)
  PERFORM t.ok(t.own_err(format('public.owner_decide_historical_access(%L::uuid, true)', req)) = 'P0002', 'HDEC before consent');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('A2'), format('public.historical_access_consent(%L::uuid, true, array[%L::uuid])', req, t.k('TA1'))) = 'P0002', 'HCON not yours');
  PERFORM t.ok(t.err(t.u('A1'), format('public.historical_access_consent(%L::uuid, true, array[%L::uuid])', req,
                                         (SELECT id FROM public.tickets WHERE company_id = t.u('CB') AND user_id = t.u('A1') LIMIT 1))) = '22023', 'HCON only other companies tickets');
  PERFORM t.ok(t.call(t.u('A1'), format('public.historical_access_consent(%L::uuid, true, array[%L::uuid])', req, t.k('TA1'))) ->> 'status' = 'awaiting_owner', 'HCON consent');
  PERFORM t.ok(t.err(t.u('OB'), format('public.historical_ticket_view(%L::uuid, %L::uuid)', req, t.k('TA1'))) = '42501', 'HVIEW before owner');
  PERFORM t.ok(t.own(format('public.owner_decide_historical_access(%L::uuid, true, 24)', req)) ->> 'status' = 'approved', 'HDEC approve');
  PERFORM t.ctx(null);
  r := t.call(t.u('OB'), format('public.historical_ticket_view(%L::uuid, %L::uuid)', req, t.k('TA1')));
  PERFORM t.ok(r #>> '{ticket,title}' = 'طلبي لم يصل' AND jsonb_array_length(r -> 'customer_messages') = 1
           AND NOT (r::text LIKE '%رد الشركة%') AND NOT (r::text LIKE '%ملاحظة داخلية%'), 'HVIEW customer content only');
  PERFORM t.ok(t.err(t.u('OB'), format('public.historical_ticket_view(%L::uuid, %L::uuid)', req, t.k('TA1S'))) = '42501', 'HVIEW only chosen tickets');
  PERFORM t.ok(t.err(t.u('BS'), format('public.historical_ticket_view(%L::uuid, %L::uuid)', req, t.k('TA1'))) = '42501', 'HVIEW admin only');
  PERFORM t.ok(t.err(t.u('OA'), format('public.historical_ticket_view(%L::uuid, %L::uuid)', req, t.k('TA1'))) = '42501', 'HVIEW not other company');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.historical_access_audit WHERE request_id = req AND action = 'viewed' AND actor_id = t.u('OB')), 'HVIEW audited');
  PERFORM t.ok(t.call(t.u('OB'), 'public.company_historical_requests()') -> 0 -> 'ticket_ids' = jsonb_build_array(t.k('TA1')), 'HLIST ids while approved');
  UPDATE public.historical_access_requests SET expires_at = now() - interval '1 second' WHERE id = req;
  PERFORM t.ok(t.err(t.u('OB'), format('public.historical_ticket_view(%L::uuid, %L::uuid)', req, t.k('TA1'))) = '42501', 'HVIEW expired');
  PERFORM t.ok(t.call(t.u('OB'), 'public.company_historical_requests()') -> 0 -> 'ticket_ids' = 'null'::jsonb, 'HLIST ids hidden after expiry');
  -- العميل يرفض طلبًا آخر
  req := (t.call(t.u('OB'), format('public.historical_access_request(%L::uuid, ''طلب ثانٍ لمراجعة تاريخ العميل'')', t.u('A1'))) ->> 'request_id')::uuid;
  PERFORM t.ok(t.call(t.u('A1'), format('public.historical_access_consent(%L::uuid, false, null)', req)) ->> 'status' = 'declined', 'HCON decline');
  RAISE NOTICE 'PASS ⑤ الوصول التاريخي: مدير الشركة يطلب بغرض، العميل يوافق ويختار تذاكره، ثم المالك؛ القراءة لمحتوى العميل وحده وللتذاكر المختارة، مسجَّلة، وتنتهي';
END $$;

-- ══ ⑥ الثوابت ═══════════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.err_super_ok('delete from public.historical_access_audit') = '23514'
           AND t.err_super_ok('delete from public.customer_transfers') = '23514'
           AND t.err_super_ok('delete from public.ticket_carry_items') = '23514', 'INV append-only, no delete');
  PERFORM t.ok(t.exec(t.u('OA'), 'select * from public.ticket_carries') = '42501', 'INV no direct read');
  -- حذف حساب عميل له سجل نقل لا يتعطل، والسجل يبقى بمعرّفات فقط (اصطلاح 086 و096)
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.u('A2'))) = 'ok', 'INV account deletion not blocked');
  PERFORM t.ok((SELECT count(*) FROM public.customer_transfers WHERE customer_id = t.u('A2')) = 2, 'INV history kept after deletion');
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(t.call(t.u('OA'), 'public.company_transfer_requests()')) e
                        WHERE e ->> 'customer_name' = 'حساب محذوف'), 'INV deleted customer shown as deleted');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f'
                             AND conrelid IN ('public.customer_transfers'::regclass, 'public.ticket_carries'::regclass,
                                              'public.historical_access_requests'::regclass)
                             AND confrelid IN ('public.companies'::regclass, 'public.profiles'::regclass)), 'INV no FK to companies/profiles');
  RAISE NOTICE 'PASS ⑥ الثوابت: السجلات إلحاقية ولا حذف ولا قراءة مباشرة، وحذف الحساب لا يتعطل والسجل يبقى';
END $$;

-- ══ ⑦ رفض التراجع ═══════════════════════════════════════════════════════
\set rbsql `cat migrations/_rollback/101_customer_transfers_carry.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  UPDATE public.platform_feature_switches SET enabled = false;
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with data';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS ⑦ التراجع مرفوض مع وجود نقل أو نسخ أو وصول تاريخي';
END $$;

SELECT 'ALL customer-transfers-carry tests passed';
