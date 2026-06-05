-- Migration: WhatsApp Session Messages Support
-- Date: 2025-06-05
-- Description: Ensure messages table has proper columns for session message tracking

-- 1. Ensure messages table exists with session message support
-- (Assuming it already exists, we'll just ensure necessary columns)

DO $$ 
BEGIN
    -- Add session_message_type column if not exists
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'session_message_type') THEN
        ALTER TABLE messages ADD COLUMN session_message_type VARCHAR(50) DEFAULT 'session';
    END IF;

    -- Add api_key_id column if not exists (for tracking which API key sent the message)
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'api_key_id') THEN
        ALTER TABLE messages ADD COLUMN api_key_id UUID;
    END IF;

    -- Add sent_via_api column if not exists
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'sent_via_api') THEN
        ALTER TABLE messages ADD COLUMN sent_via_api BOOLEAN DEFAULT FALSE;
    END IF;

    -- Add 24h_window_check column if not exists
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'within_24h_window') THEN
        ALTER TABLE messages ADD COLUMN within_24h_window BOOLEAN DEFAULT TRUE;
    END IF;
END $$;

-- 2. Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_messages_user_to_timestamp ON messages(user_id, to_number, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sent_via_api ON messages(user_id, sent_via_api, timestamp DESC);

-- 3. Add RLS policy for API-sent messages
CREATE POLICY IF NOT EXISTS "API can send messages for user" ON messages
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM bot_api_keys 
            WHERE bot_api_keys.created_by = messages.user_id 
            AND bot_api_keys.status = 'active'
        )
    );
