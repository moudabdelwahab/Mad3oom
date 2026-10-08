-- Supabase platform stubs for a production-shaped local replica.
-- Only what public-schema objects reference; nothing here is copied from prod.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS net;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS emp_ops;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public;
GRANT USAGE ON SCHEMA auth, extensions, public, storage TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, phone text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), email_confirmed_at timestamptz,
  last_sign_in_at timestamptz, banned_until timestamptz);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT jsonb_strip_nulls(jsonb_build_object('sub', auth.uid(), 'role', auth.role(),
       'aal', NULLIF(current_setting('request.jwt.claim.aal', true), ''))) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

-- pg_net: every call is recorded so tests can assert what a trigger enqueued.
CREATE TABLE net._calls (id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb, at timestamptz DEFAULT clock_timestamp());
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
LANGUAGE sql AS $$ INSERT INTO net._calls (url, headers, body) VALUES (url, headers, body) RETURNING id $$;
GRANT USAGE ON SCHEMA net TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA net TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA net TO anon, authenticated, service_role;

-- storage (054 attachment guard reads storage.objects)
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text,
  owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated, service_role;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime;
