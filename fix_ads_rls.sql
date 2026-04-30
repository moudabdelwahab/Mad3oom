-- Fix RLS for ads_settings table
-- Ensure all administrative roles can manage ads

DROP POLICY IF EXISTS "Admins can manage ads_settings" ON ads_settings;

CREATE POLICY "Admins can manage ads_settings" ON ads_settings
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE profiles.id = auth.uid() 
            AND (profiles.role = 'admin' OR profiles.role = 'super_user' OR profiles.role = 'support')
        )
    );

-- Ensure public read access remains
DROP POLICY IF EXISTS "Allow read for all users" ON ads_settings;
CREATE POLICY "Allow read for all users" ON ads_settings
    FOR SELECT
    USING (true);
