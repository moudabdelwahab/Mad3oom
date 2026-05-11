-- Add whatsapp_enabled column to profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT FALSE;

-- Update RLS for integrations to allow support user to view all integrations
-- Assuming support user has email 'support@mad3oom.online'
CREATE OR REPLACE FUNCTION is_support_user() 
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles 
    WHERE id = auth.uid() AND email = 'support@mad3oom.online'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update Select Policy for integrations
DROP POLICY IF EXISTS "Users can view their own integrations" ON integrations;
CREATE POLICY "Users can view their own integrations or support can view all" 
ON integrations FOR SELECT 
USING (auth.uid() = user_id OR is_support_user());

-- Update Select Policy for profiles
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON profiles; -- Check if this exists
CREATE POLICY "Profiles are viewable by owner or support" 
ON profiles FOR SELECT 
USING (auth.uid() = id OR is_support_user());

-- Update Policy for support to update whatsapp_enabled
CREATE POLICY "Support can update whatsapp_enabled on profiles" 
ON profiles FOR UPDATE 
USING (is_support_user())
WITH CHECK (is_support_user());
