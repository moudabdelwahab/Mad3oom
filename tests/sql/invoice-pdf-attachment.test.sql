-- ============================================================================
-- الفاتورة تُرفَق PDF كاملًا (072) — على نسخة مطابقة لشكل الإنتاج
--
-- الإعداد: 070 + 071 (زي الإنتاج دلوقتي). عميل باشتراك «الخطة المتقدمة» سنوي
--   وفاتورة من النظام المحاسبي على تذكرتين: T1 لم تُرفَق، و T2 أُرفقت بزر 051
--   (رابط text/html — زي #1121 على الإنتاج). وعميل تاني صاحب شركة.
-- ⓪ (قبل 072): الإرفاق رابط فقط، ومفيش بيانات فاتورة كاملة ولا has_pdf.
-- ① (بعد 072):
--    D1 ticket_invoice_document: الفاتورة الكاملة للطاقم بس (العميل، الشركة،
--       البند وفترته، الإجماليات، رابط التحقق).
--    D2 حرّاس الملف: المسار، الرابط، الوجود، النوع، الرافع، والصلاحية.
--    D3 الإرفاق الأول (موظف دعم): رد + مرفق PDF، مرة واحدة، والعميل يشوفه.
--    D4 الترقية: مرفق 051 (الرابط) يصير الـ PDF على نفس الرد.
-- ② التراجع وإعادة التطبيق.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;
\i migrations/070_owner_admin_context_tickets.sql
\i migrations/071_owner_admin_context_billing_requests.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false); $$;
CREATE FUNCTION t.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.ctx(p_context text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  perform set_config('app.owner_context_write', 'on', true);
  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values ('00000000-0000-4000-8000-0000000000f0', p_context, now(), now() + interval '12 hours')
  on conflict (user_id) do update set context = excluded.context, entered_at = excluded.entered_at,
                                      expires_at = excluded.expires_at;
  perform set_config('app.owner_context_write', 'off', true);
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون ────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io'), ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io'), ('00000000-0000-4000-8000-0000000000a5', 'sp@t.io'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io', 'حسين شاكر', 'user', '01000000051', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io', 'صاحب شركة', 'user', '01000000052', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io', 'أدمن', 'admin', '01000000053', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a5', 'sp@t.io', 'دعم', 'support', '01000000054', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io', 'المالك', 'platform_owner', '01000000055', '2026-09-01');
INSERT INTO public.platform_authority (user_id, level) VALUES ('00000000-0000-4000-8000-0000000000f0', 'owner');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number, tax_id, address, city) VALUES
  ('55555555-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000c2', 'شركة التجربة', 'CR-7788', 'TAX-123', 'شارع النصر', 'القاهرة');

INSERT INTO public.tickets (id, user_id, title, description, status, priority, category) VALUES
  ('22222222-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'طلب اشتراك', 'وصف', 'confirmed', 'medium', 'subscription'),
  ('22222222-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000c1', 'طلب اشتراك قديم', 'وصف', 'confirmed', 'medium', 'subscription'),
  ('22222222-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000c2', 'طلب شركة', 'وصف', 'confirmed', 'medium', 'subscription');
INSERT INTO public.whatsapp_subscriptions (id, user_id, ticket_id, status, plan, billing_cycle, start_date, end_date, company_id) VALUES
  ('33333333-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000d1',
   'active', 'support', 'yearly', '2026-10-09', '2027-10-09', null),
  ('33333333-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000c2', '22222222-0000-4000-8000-0000000000d3',
   'active', 'whatsapp', 'monthly', '2026-10-01', '2026-10-31', '55555555-0000-4000-8000-0000000000c2');
-- كما تسجّلها accounting-sync (الخطة والدورة بتوصل null من الطابور)
INSERT INTO public.accounting_invoices (id, external_invoice_id, invoice_number, ticket_id, user_id, subscription_id,
                                        subtotal, tax_amount, total, currency, issue_date, due_date, status, public_token) VALUES
  ('44444444-0000-4000-8000-0000000000d1', gen_random_uuid(), 'INV-FY2026/27-0001', '22222222-0000-4000-8000-0000000000d1',
   '00000000-0000-4000-8000-0000000000c1', '33333333-0000-4000-8000-0000000000d1', 9999, 0, 9999, 'EGP', '2026-10-09', '2027-10-09', 'sent',
   repeat('a', 48)),
  ('44444444-0000-4000-8000-0000000000d2', gen_random_uuid(), 'INV-2026-0008', '22222222-0000-4000-8000-0000000000d2',
   '00000000-0000-4000-8000-0000000000c1', null, 30, 0, 30, 'USD', '2026-08-16', '2026-09-16', 'sent', repeat('b', 48)),
  ('44444444-0000-4000-8000-0000000000d3', gen_random_uuid(), 'INV-FY2026/27-0002', '22222222-0000-4000-8000-0000000000d3',
   '00000000-0000-4000-8000-0000000000c2', '33333333-0000-4000-8000-0000000000d3', 1299, 0, 1299, 'EGP', '2026-10-01', '2026-10-31', 'sent',
   repeat('c', 48));

-- ملفات «مرفوعة» في مستودع tickets (زي ما Storage بيسجّلها: الرافع + metadata)
INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES
  ('tickets', '22222222-0000-4000-8000-0000000000d1/invoice-INV-FY2026_27-0001-1.pdf', '00000000-0000-4000-8000-0000000000a5',
   '{"mimetype":"application/pdf","size":"48211"}'),
  ('tickets', '22222222-0000-4000-8000-0000000000d1/invoice-INV-FY2026_27-0001-2.pdf', '00000000-0000-4000-8000-0000000000a5',
   '{"mimetype":"application/pdf","size":"48300"}'),
  ('tickets', '22222222-0000-4000-8000-0000000000d1/invoice-fake.pdf', '00000000-0000-4000-8000-0000000000a5',
   '{"mimetype":"text/html","size":"100"}'),
  ('tickets', '22222222-0000-4000-8000-0000000000d1/invoice-by-customer.pdf', '00000000-0000-4000-8000-0000000000c1',
   '{"mimetype":"application/pdf","size":"100"}'),
  ('tickets', '22222222-0000-4000-8000-0000000000d2/invoice-INV-2026-0008-1.pdf', '00000000-0000-4000-8000-0000000000ad',
   '{"mimetype":"application/pdf","size":"47000"}');

CREATE FUNCTION t.url(p_path text) RETURNS text LANGUAGE sql AS $$
  select 'https://srnelrdpqkcntbgudyto.supabase.co/storage/v1/object/public/tickets/' || p_path $$;
GRANT EXECUTE ON FUNCTION t.url(text) TO authenticated;

-- ============================================================================
-- ⓪ قبل 072
-- ============================================================================
DO $$
DECLARE st jsonb; att jsonb; doc text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated;
  att := public.attach_accounting_invoice('22222222-0000-4000-8000-0000000000d2');   -- زر 051 (زي #1121)
  st := public.ticket_invoice_status('22222222-0000-4000-8000-0000000000d2');
  doc := t.err($s$select public.ticket_invoice_document('22222222-0000-4000-8000-0000000000d1')$s$);
  RESET ROLE;
  PERFORM t.act(NULL);
  IF att->>'status' <> 'attached' OR st ? 'has_pdf' OR doc <> '42883'
     OR (select mime_type from public.ticket_attachments where id = (att->>'attachment_id')::uuid) <> 'text/html' THEN
    RAISE EXCEPTION 'FAIL ⓪: السلوك قبل 072 مش زي الإنتاج (% / % / %)', att, st, doc;
  END IF;
  RAISE NOTICE 'PROVEN GAP ⓪ (قبل 072): زر 051 بيرفق رابط text/html بس، ومفيش بيانات فاتورة كاملة (%) ولا has_pdf', doc;
END $$;

-- ============================================================================
-- ① بعد 072
-- ============================================================================
\i migrations/072_invoice_pdf_attachment.sql
SET search_path = public, extensions;

-- ── D1: الفاتورة الكاملة للطاقم بس ──────────────────────────────────────────
DO $$
DECLARE d jsonb; d3 jsonb; ow jsonb; e_cust text; e_owc text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a5');
  SET LOCAL ROLE authenticated;
  d  := public.ticket_invoice_document('22222222-0000-4000-8000-0000000000d1');
  d3 := public.ticket_invoice_document('22222222-0000-4000-8000-0000000000d3');
  RESET ROLE;
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  SET LOCAL ROLE authenticated; ow := public.ticket_invoice_document('22222222-0000-4000-8000-0000000000d1'); RESET ROLE;
  PERFORM t.ctx('customer');
  SET LOCAL ROLE authenticated; e_owc := t.err($s$select public.ticket_invoice_document('22222222-0000-4000-8000-0000000000d1')$s$); RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SET LOCAL ROLE authenticated; e_cust := t.err($s$select public.ticket_invoice_document('22222222-0000-4000-8000-0000000000d1')$s$); RESET ROLE;
  PERFORM t.act(NULL);

  IF d->>'invoice_number' <> 'INV-FY2026/27-0001' OR (d->>'total')::numeric <> 9999 OR d->>'currency' <> 'EGP'
     OR d->>'issue_date' <> '2026-10-09' OR d->>'due_date' <> '2027-10-09' OR d->>'status' <> 'sent'
     OR d->>'public_url' <> 'https://mad3oom.com/invoice.html?t=' || repeat('a', 48)
     OR d->'customer'->>'name' <> 'حسين شاكر' OR d->'customer'->>'email' <> 'c1@t.io' OR d->'customer'->>'phone' <> '+201000000051'
     OR d->'customer'->'company' <> 'null'::jsonb
     OR jsonb_array_length(d->'items') <> 1
     OR d->'items'->0->>'description' <> 'اشتراك الخطة المتقدمة — سنوي'
     OR d->'items'->0->>'period_start' <> '2026-10-09' OR d->'items'->0->>'period_end' <> '2027-10-09'
     OR (d->'items'->0->>'unit_price')::numeric <> 9999 OR (d->'items'->0->>'quantity')::int <> 1
     OR (d->>'ticket_number') IS NULL THEN
    RAISE EXCEPTION 'FAIL D1: الفاتورة الكاملة ناقصة %', d;
  END IF;
  IF d3->'customer'->'company'->>'name' <> 'شركة التجربة' OR d3->'customer'->'company'->>'tax_id' <> 'TAX-123'
     OR d3->'customer'->'company'->>'commercial_register' <> 'CR-7788' OR d3->'customer'->'company'->>'address' <> 'شارع النصر، القاهرة'
     OR d3->'items'->0->>'description' <> 'اشتراك واتساب بيزنس — شهري' THEN
    RAISE EXCEPTION 'FAIL D1: بيانات الشركة %', d3;
  END IF;
  IF ow IS NULL OR e_owc <> '42501' OR e_cust <> '42501' THEN
    RAISE EXCEPTION 'FAIL D1: الصلاحية (مالك admin=% مالك customer=% عميل=%)', ow IS NOT NULL, e_owc, e_cust;
  END IF;
  RAISE NOTICE 'PASS D1: الفاتورة الكاملة (رقم، تواريخ، حالة، عميل، بند «%» بفترته، إجماليات، رابط تحقق) + بيانات الشركة؛ للطاقم والمالك في سياق admin، والعميل/سياق customer ⇒ 42501',
    d->'items'->0->>'description';
END $$;

-- ── D2: حرّاس الملف ─────────────────────────────────────────────────────────
DO $$
DECLARE r text[];
  ok_path constant text := '22222222-0000-4000-8000-0000000000d1/invoice-INV-FY2026_27-0001-1.pdf';
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a5');
  SET LOCAL ROLE authenticated;
  r := ARRAY[
    -- مسار في مجلد تذكرة تانية
    t.err(format($s$select public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', %L, t.url(%L))$s$,
                 '22222222-0000-4000-8000-0000000000d2/invoice-INV-2026-0008-1.pdf', '22222222-0000-4000-8000-0000000000d2/invoice-INV-2026-0008-1.pdf')),
    -- ..
    t.err(format($s$select public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', %L, t.url(%L))$s$,
                 '22222222-0000-4000-8000-0000000000d1/invoice-..pdf', '22222222-0000-4000-8000-0000000000d1/invoice-..pdf')),
    -- رابط لمسار مختلف
    t.err(format($s$select public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', %L, t.url('x/invoice-a.pdf'))$s$, ok_path)),
    -- ملف مش موجود
    t.err(format($s$select public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', %L, t.url(%L))$s$,
                 '22222222-0000-4000-8000-0000000000d1/invoice-missing.pdf', '22222222-0000-4000-8000-0000000000d1/invoice-missing.pdf')),
    -- مش PDF
    t.err(format($s$select public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', %L, t.url(%L))$s$,
                 '22222222-0000-4000-8000-0000000000d1/invoice-fake.pdf', '22222222-0000-4000-8000-0000000000d1/invoice-fake.pdf')),
    -- رفعه حساب تاني
    t.err(format($s$select public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', %L, t.url(%L))$s$,
                 '22222222-0000-4000-8000-0000000000d1/invoice-by-customer.pdf', '22222222-0000-4000-8000-0000000000d1/invoice-by-customer.pdf'))
  ];
  RESET ROLE;
  -- العميل نفسه بملف سليم
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SET LOCAL ROLE authenticated;
  r := r || t.err(format($s$select public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', %L, t.url(%L))$s$, ok_path, ok_path));
  RESET ROLE;
  PERFORM t.act(NULL);
  IF r <> ARRAY['22023','22023','22023','P0002','22023','42501','42501']
     OR (select count(*) from public.ticket_replies where ticket_id = '22222222-0000-4000-8000-0000000000d1') <> 0 THEN
    RAISE EXCEPTION 'FAIL D2: %', r;
  END IF;
  RAISE NOTICE 'PASS D2: مجلد تذكرة تانية/../رابط مختلف ⇒ 22023، ملف ناقص ⇒ P0002، مش PDF ⇒ 22023، رافع تاني ⇒ 42501، العميل ⇒ 42501، ومفيش رد اتكتب';
END $$;

-- ── D3: الإرفاق الأول (موظف دعم) ────────────────────────────────────────────
DO $$
DECLARE a jsonb; a2 jsonb; st jsonb; att record; msg text; n_rep int; n_att int; cust_sees int; fr timestamptz;
  p1 constant text := '22222222-0000-4000-8000-0000000000d1/invoice-INV-FY2026_27-0001-1.pdf';
  p2 constant text := '22222222-0000-4000-8000-0000000000d1/invoice-INV-FY2026_27-0001-2.pdf';
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a5');
  SET LOCAL ROLE authenticated;
  a  := public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', p1, t.url(p1));
  a2 := public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d1', p2, t.url(p2));
  st := public.ticket_invoice_status('22222222-0000-4000-8000-0000000000d1');
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO cust_sees FROM public.ticket_attachments
   WHERE ticket_id = '22222222-0000-4000-8000-0000000000d1' AND file_path = p1 AND mime_type = 'application/pdf';
  RESET ROLE;
  PERFORM t.act(NULL);

  SELECT * INTO att FROM public.ticket_attachments WHERE id = (a->>'attachment_id')::uuid;
  SELECT message INTO msg FROM public.ticket_replies WHERE id = (a->>'reply_id')::uuid;
  SELECT count(*) INTO n_rep FROM public.ticket_replies WHERE ticket_id = '22222222-0000-4000-8000-0000000000d1';
  SELECT count(*) INTO n_att FROM public.ticket_attachments WHERE ticket_id = '22222222-0000-4000-8000-0000000000d1';
  SELECT first_response_at INTO fr FROM public.tickets WHERE id = '22222222-0000-4000-8000-0000000000d1';
  IF a->>'status' <> 'attached' OR att.mime_type <> 'application/pdf' OR att.file_path <> p1 OR att.file_url <> t.url(p1)
     OR att.file_name <> 'فاتورة INV-FY2026/27-0001.pdf' OR att.file_size <> 48211 OR att.reply_id <> (a->>'reply_id')::uuid
     OR att.uploaded_by <> '00000000-0000-4000-8000-0000000000a5'
     OR position('PDF' in msg) = 0 OR position('https://mad3oom.com/invoice.html?t=' || repeat('a', 48) in msg) = 0
     OR position('الخطة المتقدمة' in msg) = 0
     OR (select reply_id from public.accounting_invoices where id = '44444444-0000-4000-8000-0000000000d1') <> (a->>'reply_id')::uuid
     OR (select attachment_id from public.accounting_invoices where id = '44444444-0000-4000-8000-0000000000d1') <> att.id THEN
    RAISE EXCEPTION 'FAIL D3: الإرفاق % / % / %', a, row_to_json(att), msg;
  END IF;
  IF a2->>'status' <> 'already_attached' OR n_rep <> 1 OR n_att <> 1 OR st->>'has_pdf' <> 'true' OR st->>'state' <> 'attached'
     OR cust_sees <> 1 OR fr IS NULL THEN
    RAISE EXCEPTION 'FAIL D3: التكرار/العرض (% ردود % مرفقات % حالة % العميل %)', n_rep, n_att, st, a2, cust_sees;
  END IF;
  RAISE NOTICE 'PASS D3: موظف الدعم أرفق «%» (PDF، 48211 بايت) في رد فيه رابط التحقق؛ الضغطة التانية already_attached من غير رد ولا مرفق زيادة؛ has_pdf=true؛ العميل شايف المرفق', att.file_name;
END $$;

-- ── D4: الترقية — مرفق 051 (رابط) يصير PDF على نفس الرد ─────────────────────
DO $$
DECLARE before record; a jsonb; att record; n_rep int; n_att int; st jsonb;
  p constant text := '22222222-0000-4000-8000-0000000000d2/invoice-INV-2026-0008-1.pdf';
BEGIN
  SELECT reply_id, attachment_id INTO before FROM public.accounting_invoices WHERE id = '44444444-0000-4000-8000-0000000000d2';
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated;
  st := public.ticket_invoice_status('22222222-0000-4000-8000-0000000000d2');
  a := public.attach_accounting_invoice_pdf('22222222-0000-4000-8000-0000000000d2', p, t.url(p));
  RESET ROLE;
  PERFORM t.act(NULL);
  SELECT * INTO att FROM public.ticket_attachments WHERE id = before.attachment_id;
  SELECT count(*) INTO n_rep FROM public.ticket_replies WHERE ticket_id = '22222222-0000-4000-8000-0000000000d2';
  SELECT count(*) INTO n_att FROM public.ticket_attachments WHERE ticket_id = '22222222-0000-4000-8000-0000000000d2';
  IF st->>'state' <> 'attached' OR st->>'has_pdf' <> 'false'
     OR a->>'status' <> 'upgraded' OR (a->>'reply_id')::uuid <> before.reply_id OR (a->>'attachment_id')::uuid <> before.attachment_id
     OR att.mime_type <> 'application/pdf' OR att.file_path <> p OR att.file_name <> 'فاتورة INV-2026-0008.pdf'
     OR n_rep <> 1 OR n_att <> 1 THEN
    RAISE EXCEPTION 'FAIL D4: % / % / % ردود % مرفقات', st, a, row_to_json(att), n_rep;
  END IF;
  RAISE NOTICE 'PASS D4: فاتورة 051 (رابط، has_pdf=false) اترقّت: نفس الرد ونفس صف المرفق بقى PDF «%»، من غير رد جديد', att.file_name;
END $$;

-- ============================================================================
-- ② التراجع وإعادة التطبيق
-- ============================================================================
\i migrations/_rollback/072_invoice_pdf_attachment.down.sql
DO $$
DECLARE doc text; st jsonb; n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a5');
  SET LOCAL ROLE authenticated;
  doc := t.err($s$select public.ticket_invoice_document('22222222-0000-4000-8000-0000000000d1')$s$);
  st := public.ticket_invoice_status('22222222-0000-4000-8000-0000000000d1');
  RESET ROLE;
  PERFORM t.act(NULL);
  SELECT count(*) INTO n FROM public.ticket_attachments WHERE mime_type = 'application/pdf';
  IF doc <> '42883' OR st ? 'has_pdf' OR n <> 2 THEN RAISE EXCEPTION 'FAIL RB1: % / % / %', doc, st, n; END IF;
  RAISE NOTICE 'PASS RB1: التراجع بيرجّع نص 051 ويشيل الدالتين، ومرفقات الـ PDF تفضل للعميل (%)', n;
END $$;
\i migrations/072_invoice_pdf_attachment.sql
DO $$
DECLARE st jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a5');
  SET LOCAL ROLE authenticated; st := public.ticket_invoice_status('22222222-0000-4000-8000-0000000000d1'); RESET ROLE;
  PERFORM t.act(NULL);
  IF st->>'has_pdf' <> 'true' THEN RAISE EXCEPTION 'FAIL RB2 (%)', st; END IF;
  RAISE NOTICE 'PASS RB2: إعادة التطبيق idempotent';
END $$;

SELECT 'ALL INVOICE PDF ATTACHMENT TESTS PASSED';
