-- Improved Fix for "schema net does not exist" and pg_net extension conflicts

-- 1. Check if pg_net extension exists and what schema it belongs to
-- This script handles cases where the extension might be in 'extensions' or 'public' schema
DO $$
BEGIN
    -- If pg_net exists but is not in 'net' schema, we try to move it or create the schema
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
        -- Extension exists, let's make sure the schema 'net' exists as it's often expected
        IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
            CREATE SCHEMA net;
        END IF;
        
        -- Move the extension to the 'net' schema if it's elsewhere
        -- Note: This might require superuser, but in Supabase 'postgres' role usually can do this
        BEGIN
            ALTER EXTENSION pg_net SET SCHEMA net;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Could not move pg_net to net schema, it might be managed by Supabase. Error: %', SQLERRM;
        END;
    ELSE
        -- Extension doesn't exist, create schema and then extension
        IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
            CREATE SCHEMA net;
        END IF;
        CREATE EXTENSION pg_net WITH SCHEMA net;
    END IF;
END $$;

-- 2. Ensure permissions are correct regardless of where it is
GRANT USAGE ON SCHEMA net TO postgres, authenticated, service_role;
-- Only grant on tables if they exist to avoid errors
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'net') THEN
        GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres, authenticated, service_role;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO postgres, authenticated, service_role;
        GRANT ALL ON ALL FUNCTIONS IN SCHEMA net TO postgres, authenticated, service_role;
    END IF;
END $$;

-- 3. Verify triggers on tickets table
-- If a trigger is calling a function that explicitly looks for net.http_post, 
-- this ensures the path is available.
ALTER ROLE authenticated SET search_path TO "$user", public, net, extensions;
ALTER ROLE service_role SET search_path TO "$user", public, net, extensions;

RAISE NOTICE 'Fix applied. Please try creating a ticket again.';
