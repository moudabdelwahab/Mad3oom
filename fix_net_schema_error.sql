-- Fix for "schema net does not exist" error
-- This error usually occurs when a trigger or function tries to use the 'net' extension (for HTTP requests) 
-- but the extension is not enabled or the schema is missing.

-- 1. Create the 'net' schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS net;

-- 2. Enable the pg_net extension if available (Supabase uses this for webhooks/HTTP)
-- Note: In Supabase, this is usually pre-installed but might need to be enabled in the 'net' schema.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA net;

-- 3. Grant usage to relevant roles
GRANT USAGE ON SCHEMA net TO postgres, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO postgres, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA net TO postgres, authenticated, service_role;

-- 4. Verify if there are any triggers on the 'tickets' table that might be failing
-- This query helps identify triggers that might be calling functions using the 'net' schema
DO $$
DECLARE
    t_name TEXT;
BEGIN
    FOR t_name IN 
        SELECT trigger_name 
        FROM information_schema.triggers 
        WHERE event_object_table = 'tickets'
    LOOP
        RAISE NOTICE 'Found trigger on tickets table: %', t_name;
    END LOOP;
END $$;
