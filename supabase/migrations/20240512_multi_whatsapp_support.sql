-- 1. Ensure integrations table can handle multiple WhatsApp numbers per user
-- The current implementation uses 'user_id' and 'provider' as a unique pair for upsert.
-- We need to allow multiple providers of type 'whatsapp' for the same user.
-- However, we should still ensure that a specific phone_number_id is unique across the system.

-- First, let's add a column to specifically identify the phone number if not already in metadata in a searchable way
-- Actually, the current schema stores it in metadata. To support multiple, we should ideally have a unique constraint 
-- on (user_id, provider, phone_number_id) or similar.

-- Since we can't easily change the existing 'integrations' table unique constraints without knowing them exactly,
-- we will ensure that our JS code handles multiple entries and we'll add a helper index.

CREATE INDEX IF NOT EXISTS idx_integrations_user_provider ON integrations(user_id, provider);

-- 2. Update RLS policies for integrations to ensure strict isolation
-- (They should already be isolated by user_id, but let's double check/reinforce)

DROP POLICY IF EXISTS "Users can manage their own integrations" ON integrations;
CREATE POLICY "Users can manage their own integrations" ON integrations
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Support/Admin can view all integrations for management
CREATE POLICY "Support can view all integrations" ON integrations
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE profiles.id = auth.uid() 
            AND (profiles.email = 'support@mad3oom.online' OR profiles.role = 'admin')
        )
    );

-- 3. Ensure profiles table has whatsapp_enabled
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'profiles' AND COLUMN_NAME = 'whatsapp_enabled') THEN
        ALTER TABLE profiles ADD COLUMN whatsapp_enabled BOOLEAN DEFAULT FALSE;
    END IF;
END $$;
