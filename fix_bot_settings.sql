-- Fix bot_settings table schema
-- This script ensures the bot_settings table has the correct column names

-- 1. Check if bot_settings table exists, if not create it
CREATE TABLE IF NOT EXISTS bot_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    bot_enabled BOOLEAN DEFAULT TRUE,
    is_enabled BOOLEAN DEFAULT TRUE,
    welcome_message TEXT DEFAULT 'مرحباً بك في منصة مدعوم! كيف يمكنني مساعدتك اليوم؟',
    ticket_message TEXT DEFAULT 'تم فتح تذكرة دعم فني وسيقوم فريقنا بالرد عليك في أقرب وقت.',
    response_delay_seconds INTEGER DEFAULT 1,
    keywords TEXT[] DEFAULT '{}',
    custom_replies JSONB DEFAULT '[]',
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Add missing columns if they don't exist
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS welcome_message TEXT DEFAULT 'مرحباً بك في منصة مدعوم! كيف يمكنني مساعدتك اليوم؟';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ticket_message TEXT DEFAULT 'تم فتح تذكرة دعم فني وسيقوم فريقنا بالرد عليك في أقرب وقت.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS response_delay_seconds INTEGER DEFAULT 1;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS keywords TEXT[] DEFAULT '{}';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS custom_replies JSONB DEFAULT '[]';

-- 3. Enable RLS
ALTER TABLE bot_settings ENABLE ROW LEVEL SECURITY;

-- 4. Drop existing policies if they exist
DROP POLICY IF EXISTS "Enable read for all users" ON bot_settings;
DROP POLICY IF EXISTS "Enable update for admins" ON bot_settings;

-- 5. Create new policies
CREATE POLICY "Enable read for all users" ON bot_settings FOR SELECT USING (true);
CREATE POLICY "Enable update for admins" ON bot_settings FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role IN ('admin', 'super_user'))
);

-- 6. Ensure there's at least one row in bot_settings
INSERT INTO bot_settings (bot_enabled, is_enabled, welcome_message, ticket_message)
SELECT true, true, 'مرحباً بك في منصة مدعوم! كيف يمكنني مساعدتك اليوم؟', 'تم فتح تذكرة دعم فني وسيقوم فريقنا بالرد عليك في أقرب وقت.'
WHERE NOT EXISTS (SELECT 1 FROM bot_settings);

-- 7. Update chat_messages table to ensure it has the correct columns
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_bot_reply BOOLEAN DEFAULT FALSE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_admin_reply BOOLEAN DEFAULT FALSE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_id TEXT;

-- 8. Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions(status);
