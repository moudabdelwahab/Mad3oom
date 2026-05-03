-- ============================================================
-- FINAL FIX: Ticket Creation & Automatic Email Notification
-- ============================================================
-- This script fixes the "net.http_post does not exist" error
-- and ensures the pg_net extension is properly configured.

DO $$
BEGIN
    -- 1. Ensure schema 'net' exists
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
        CREATE SCHEMA net;
    END IF;

    -- 2. Enable pg_net extension in the 'net' schema
    -- This is required for making HTTP requests (like sending emails via Edge Functions/Resend)
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA net;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Extension pg_net might already exist or is managed by Supabase: %', SQLERRM;
    END;

    -- 3. Create a compatibility wrapper for net.http_post
    -- The error "function net.http_post(url => unknown, headers => jsonb, body => jsonb) does not exist"
    -- happens because different versions of pg_net have different parameter names.
    CREATE OR REPLACE FUNCTION net.http_post(url text, headers jsonb, body jsonb)
    RETURNS bigint
    LANGUAGE sql
    SECURITY DEFINER
    AS $f$
        SELECT net.http_post(
            url := url,
            body := body::text,
            params := '{}'::jsonb,
            headers := COALESCE(headers, '{}'::jsonb),
            timeout_milliseconds := 10000
        );
    $f$;

    -- 4. Grant necessary permissions to all roles
    GRANT USAGE ON SCHEMA net TO postgres, authenticated, service_role, anon;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA net TO postgres, authenticated, service_role, anon;
    
    -- 5. Update search path for roles to include 'net' schema
    -- This allows the database to find the http_post function easily.
    EXECUTE 'ALTER ROLE authenticated SET search_path TO "$user", public, net, extensions';
    EXECUTE 'ALTER ROLE service_role SET search_path TO "$user", public, net, extensions';
    EXECUTE 'ALTER ROLE postgres SET search_path TO "$user", public, net, extensions';

    RAISE NOTICE 'Success: Ticket creation and email system fix applied.';
END $$;
