-- Final Fix for "schema net does not exist" and pg_net extension conflicts

DO $$
BEGIN
    -- 1. Check if pg_net extension exists
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
        -- Extension exists, ensure schema 'net' exists
        IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
            CREATE SCHEMA net;
        END IF;
        
        -- Try to move the extension to the 'net' schema
        BEGIN
            EXECUTE 'ALTER EXTENSION pg_net SET SCHEMA net';
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Could not move pg_net to net schema: %', SQLERRM;
        END;
    ELSE
        -- Extension doesn't exist, create schema and then extension
        IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
            CREATE SCHEMA net;
        END IF;
        
        BEGIN
            CREATE EXTENSION pg_net WITH SCHEMA net;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Could not create pg_net extension: %', SQLERRM;
        END;
    END IF;

    -- 2. Ensure permissions are correct
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA net TO postgres, authenticated, service_role';
        
        -- Grant on tables/functions if they exist in the net schema
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'net') THEN
            EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres, authenticated, service_role';
            EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO postgres, authenticated, service_role';
            EXECUTE 'GRANT ALL ON ALL FUNCTIONS IN SCHEMA net TO postgres, authenticated, service_role';
        END IF;
    END IF;

    -- 3. Update search path for roles
    EXECUTE 'ALTER ROLE authenticated SET search_path TO "$user", public, net, extensions';
    EXECUTE 'ALTER ROLE service_role SET search_path TO "$user", public, net, extensions';

    RAISE NOTICE 'Fix applied successfully.';
END $$;
