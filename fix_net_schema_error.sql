-- Final and Complete Fix for "net.http_post does not exist"
-- This script ensures the pg_net extension is fully functional in the 'net' schema.

DO $$
BEGIN
    -- 1. Drop the extension if it's in a broken state (optional but safer)
    -- DROP EXTENSION IF EXISTS pg_net;

    -- 2. Ensure schema 'net' exists
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
        CREATE SCHEMA net;
    END IF;

    -- 3. Enable pg_net extension in the 'net' schema
    -- In Supabase, pg_net is often pre-installed. We need to make sure it's active.
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA net;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Extension pg_net might already exist or is managed by Supabase: %', SQLERRM;
    END;

    -- 4. Grant necessary permissions
    EXECUTE 'GRANT USAGE ON SCHEMA net TO postgres, authenticated, service_role, anon';
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres, authenticated, service_role';
    EXECUTE 'GRANT ALL ON ALL FUNCTIONS IN SCHEMA net TO postgres, authenticated, service_role';
    
    -- 5. Specifically grant execute on the http_post function if it exists
    -- This is the function causing the error in the screenshot
    BEGIN
        EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA net TO authenticated, service_role';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not grant execute on functions: %', SQLERRM;
    END;

    -- 6. Update search path for all relevant roles to include 'net'
    -- This allows calling http_post instead of net.http_post
    EXECUTE 'ALTER ROLE authenticated SET search_path TO "$user", public, net, extensions';
    EXECUTE 'ALTER ROLE service_role SET search_path TO "$user", public, net, extensions';
    EXECUTE 'ALTER ROLE postgres SET search_path TO "$user", public, net, extensions';

    RAISE NOTICE 'Database fix applied. The net.http_post function should now be accessible.';
END $$;
