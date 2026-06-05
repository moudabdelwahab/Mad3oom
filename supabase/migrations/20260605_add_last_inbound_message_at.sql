-- Migration: Add last_inbound_message_at and improve session tracking
-- Date: 2026-06-05

-- 1. Ensure bot_user_states has last_inbound_message_at
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'bot_user_states' AND COLUMN_NAME = 'last_inbound_message_at') THEN
        ALTER TABLE bot_user_states ADD COLUMN last_inbound_message_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- 2. Add index for performance on window checks
CREATE INDEX IF NOT EXISTS idx_bot_user_states_last_inbound ON bot_user_states(user_id, phone_number, last_inbound_message_at DESC);

-- 3. Ensure messages table has direction and timestamp indexes
CREATE INDEX IF NOT EXISTS idx_messages_direction_timestamp ON messages(user_id, direction, timestamp DESC);
