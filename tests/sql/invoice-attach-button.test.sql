-- Executed regression test for migrations/051_invoice_attach_button.sql.
--
-- 051 splits invoice delivery in two: record_accounting_invoice (called by
-- accounting-sync with service_role) records the invoice and its public token
-- only; attach_accounting_invoice (the «إرفاق فاتورة» button) writes the reply
-- and attachment, once, and only for platform staff (is_platform_staff()).
--
-- Models just what the functions touch. is_platform_staff() keeps the live
-- role branch (admin/support); the owner branch goes through owner_capability,
-- which platform-owner-context.test.sql already covers.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'user');

CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = auth.uid() AND p.role IN ('admin', 'support'));
$$;

CREATE TABLE public.tickets (id uuid PRIMARY KEY, user_id uuid REFERENCES public.profiles (id));
CREATE TABLE public.ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid REFERENCES public.tickets (id),
  user_id uuid, message text, is_internal boolean DEFAULT false,
  bypass_seen text  -- what app.bypass_ticket_restrictions was while inserting
);
-- Stands in for the live ticket guard: a reply inserted by a non-admin must
-- carry the bypass, otherwise the first-response trigger's ticket update fails.
CREATE FUNCTION public.capture_bypass() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  new.bypass_seen := current_setting('app.bypass_ticket_restrictions', true);
  RETURN new;
END $$;
CREATE TRIGGER capture_bypass BEFORE INSERT ON public.ticket_replies
  FOR EACH ROW EXECUTE FUNCTION public.capture_bypass();

CREATE TABLE public.ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid, reply_id uuid, file_url text, file_name text, mime_type text, uploaded_by uuid
);
CREATE TABLE public.advanced_settings (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.subscription_plans (key text PRIMARY KEY, name text, name_ar text);

CREATE TABLE public.accounting_invoices (
  id                  uuid primary key default gen_random_uuid(),
  external_invoice_id uuid not null unique,
  invoice_number      text not null,
  ticket_id           uuid references public.tickets (id) on delete set null,
  user_id             uuid references public.profiles (id) on delete set null,
  subscription_id     uuid,
  plan                text,
  billing_cycle       text,
  subtotal            numeric(14,2) not null default 0,
  tax_amount          numeric(14,2) not null default 0,
  total               numeric(14,2) not null default 0,
  currency            text not null default 'USD',
  issue_date          date,
  due_date            date,
  status              text,
  public_token        text not null unique
                        default encode(extensions.gen_random_bytes(24), 'hex'),
  reply_id            uuid references public.ticket_replies (id) on delete set null,
  attachment_id       uuid references public.ticket_attachments (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

INSERT INTO public.profiles VALUES
  ('11111111-1111-4111-8111-111111111111', 'user'),     -- the customer
  ('22222222-2222-4222-8222-222222222222', 'support'),  -- staff
  ('33333333-3333-4333-8333-333333333333', 'admin');
INSERT INTO public.tickets VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111');
INSERT INTO public.advanced_settings VALUES
  ('accounting_integration', '{"public_invoice_base_url": "https://mad3oom.com/invoice.html"}');
INSERT INTO public.subscription_plans VALUES ('support', 'Support', 'الدعم الفني');

\echo '--- applying migrations/051 ---'
\i migrations/051_invoice_attach_button.sql

\echo ''
\echo '=== R) accounting-sync records the invoice without touching the ticket ==='
RESET request.jwt.claim.sub;  -- service_role: no auth.uid()

DO $$ DECLARE r jsonb; n int; BEGIN
  r := public.record_accounting_invoice(jsonb_build_object(
    'external_invoice_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'invoice_number', 'INV-2026-0042', 'ticket_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'plan', 'support', 'billing_cycle', 'monthly', 'subtotal', 15, 'total', 15, 'currency', 'USD'));
  IF r->>'status' <> 'recorded' THEN RAISE EXCEPTION 'FAIL R1: %', r; END IF;
  IF r->>'public_url' NOT LIKE 'https://mad3oom.com/invoice.html?t=%' THEN RAISE EXCEPTION 'FAIL R1 url: %', r; END IF;
  SELECT count(*) INTO n FROM public.ticket_replies;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL R1: recording wrote % replies into the ticket', n; END IF;
  RAISE NOTICE 'PASS R1: recorded with a public URL, no reply written';
END $$;

DO $$ DECLARE r jsonb; BEGIN
  r := public.record_accounting_invoice(jsonb_build_object(
    'external_invoice_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'invoice_number', 'INV-2026-0042'));
  IF r->>'status' <> 'already_recorded' THEN RAISE EXCEPTION 'FAIL R2: %', r; END IF;
  RAISE NOTICE 'PASS R2: a retried sync is idempotent';
END $$;

\echo ''
\echo '=== C) a customer cannot see or press the button ==='
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

DO $$ BEGIN
  PERFORM public.ticket_invoice_status('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  RAISE EXCEPTION 'FAIL C1: customer read the invoice status';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS C1: status blocked for the customer';
END $$;

DO $$ BEGIN
  PERFORM public.attach_accounting_invoice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  RAISE EXCEPTION 'FAIL C2: customer attached the invoice';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS C2: attach blocked for the customer';
END $$;

\echo ''
\echo '=== S) staff presses «إرفاق فاتورة» ==='
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';

DO $$ DECLARE r jsonb; BEGIN
  r := public.ticket_invoice_status('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  IF r->>'state' <> 'ready' OR r->>'invoice_number' <> 'INV-2026-0042' THEN RAISE EXCEPTION 'FAIL S1: %', r; END IF;
  r := public.ticket_invoice_status('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF r->>'state' <> 'none' THEN RAISE EXCEPTION 'FAIL S1 none: %', r; END IF;
  RAISE NOTICE 'PASS S1: status is ready / none';
END $$;

DO $$ DECLARE r jsonb; rep record; att record; inv record; BEGIN
  r := public.attach_accounting_invoice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  IF r->>'status' <> 'attached' THEN RAISE EXCEPTION 'FAIL S2: %', r; END IF;

  SELECT * INTO rep FROM public.ticket_replies WHERE id = (r->>'reply_id')::uuid;
  IF rep.user_id <> '22222222-2222-4222-8222-222222222222' THEN RAISE EXCEPTION 'FAIL S2: reply not authored by the clicker'; END IF;
  IF rep.is_internal THEN RAISE EXCEPTION 'FAIL S2: reply is internal, the customer would not see it'; END IF;
  IF rep.bypass_seen IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'FAIL S2: ticket guard bypass not set (%)', rep.bypass_seen; END IF;
  IF rep.message NOT LIKE '%INV-2026-0042%' OR rep.message NOT LIKE '%الدعم الفني%'
     OR rep.message NOT LIKE '%https://mad3oom.com/invoice.html?t=%' THEN
    RAISE EXCEPTION 'FAIL S2: message %', rep.message; END IF;

  SELECT * INTO att FROM public.ticket_attachments WHERE id = (r->>'attachment_id')::uuid;
  IF att.reply_id <> rep.id OR att.file_url NOT LIKE 'https://mad3oom.com/invoice.html?t=%'
     OR att.file_name <> 'فاتورة INV-2026-0042' THEN RAISE EXCEPTION 'FAIL S2: attachment %', att; END IF;

  SELECT * INTO inv FROM public.accounting_invoices WHERE ticket_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF inv.reply_id <> rep.id OR inv.attachment_id <> att.id THEN RAISE EXCEPTION 'FAIL S2: invoice not linked'; END IF;
  IF current_setting('app.bypass_ticket_restrictions', true) <> 'off' THEN
    RAISE EXCEPTION 'FAIL S2: bypass left on after the call'; END IF;
  RAISE NOTICE 'PASS S2: reply + attachment written by the staff member, invoice linked';
END $$;

DO $$ DECLARE r jsonb; n int; BEGIN
  SET LOCAL request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
  r := public.attach_accounting_invoice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  IF r->>'status' <> 'already_attached' THEN RAISE EXCEPTION 'FAIL S3: %', r; END IF;
  SELECT count(*) INTO n FROM public.ticket_replies WHERE ticket_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL S3: % replies after a second press', n; END IF;
  RAISE NOTICE 'PASS S3: a second press does not attach twice';
END $$;

DO $$ DECLARE r jsonb; BEGIN
  r := public.ticket_invoice_status('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  IF r->>'state' <> 'attached' THEN RAISE EXCEPTION 'FAIL S4: %', r; END IF;
  RAISE NOTICE 'PASS S4: status reports attached';
END $$;

DO $$ BEGIN
  PERFORM public.attach_accounting_invoice('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  RAISE EXCEPTION 'FAIL S5: attached a ticket that has no invoice';
EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS S5: no invoice yet is a clear error';
END $$;

\echo ''
\echo '=== G) grants ==='
DO $$ BEGIN
  IF has_function_privilege('anon', 'public.attach_accounting_invoice(uuid)', 'execute') THEN
    RAISE EXCEPTION 'FAIL G1: anon can call attach'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.attach_accounting_invoice(uuid)', 'execute') THEN
    RAISE EXCEPTION 'FAIL G1: authenticated cannot call attach'; END IF;
  RAISE NOTICE 'PASS G1: attach callable by signed-in users only (authority checked inside)';
END $$;

\echo 'ALL invoice-attach-button checks passed'
