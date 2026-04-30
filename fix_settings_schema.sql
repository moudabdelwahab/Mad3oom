-- 1. التأكد من وجود جدول ads_settings
CREATE TABLE IF NOT EXISTS ads_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enabled BOOLEAN DEFAULT FALSE,
    content TEXT,
    link TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- تفعيل RLS لجدول ads_settings
ALTER TABLE ads_settings ENABLE ROW LEVEL SECURITY;

-- سياسة للأدمن فقط لإدارة الإعلانات
DROP POLICY IF EXISTS "Admins can manage ads_settings" ON ads_settings;
CREATE POLICY "Admins can manage ads_settings" ON ads_settings
    FOR ALL
    USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

-- سياسة للقراءة للجميع لعرض الإعلانات
DROP POLICY IF EXISTS "Allow read for all users" ON ads_settings;
CREATE POLICY "Allow read for all users" ON ads_settings
    FOR SELECT
    USING (true);

-- إدراج سجل افتراضي إذا كان الجدول فارغاً
INSERT INTO ads_settings (enabled, content)
SELECT false, 'مرحباً بك في منصة مدعوم'
WHERE NOT EXISTS (SELECT 1 FROM ads_settings);

-- 2. تحديث جدول bot_settings ليتوافق مع صفحة الإعدادات
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bot_settings' AND column_name='smart_memory_enabled') THEN
        ALTER TABLE bot_settings ADD COLUMN smart_memory_enabled BOOLEAN DEFAULT FALSE;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bot_settings' AND column_name='system_prompt') THEN
        ALTER TABLE bot_settings ADD COLUMN system_prompt TEXT;
    END IF;
END $$;

-- 3. التأكد من وجود جدول trusted_devices
CREATE TABLE IF NOT EXISTS trusted_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    device_name TEXT,
    device_fingerprint TEXT,
    ip_address TEXT,
    last_login TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- تفعيل RLS لجدول trusted_devices
ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;

-- سياسة للمستخدمين لإدارة أجهزتهم الخاصة
DROP POLICY IF EXISTS "Users can manage their own devices" ON trusted_devices;
CREATE POLICY "Users can manage their own devices" ON trusted_devices
    FOR ALL
    USING (auth.uid() = user_id);

-- سياسة للأدمن لمشاهدة جميع الأجهزة
DROP POLICY IF EXISTS "Admins can view all devices" ON trusted_devices;
CREATE POLICY "Admins can view all devices" ON trusted_devices
    FOR SELECT
    USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

-- 4. التأكد من وجود الأعمدة اللازمة في جدول profiles
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='role_id') THEN
        ALTER TABLE profiles ADD COLUMN role_id UUID REFERENCES custom_roles(id);
    END IF;
END $$;
