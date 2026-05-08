-- إنشاء جدول integrations لتخزين بيانات الربط مع الخدمات الخارجية (مثل WhatsApp)
CREATE TABLE IF NOT EXISTS integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    provider TEXT NOT NULL, -- 'whatsapp', 'facebook', etc.
    access_token TEXT NOT NULL,
    token_type TEXT,
    expires_in INTEGER,
    refresh_token TEXT,
    scope TEXT,
    metadata JSONB DEFAULT '{}'::jsonb, -- لتخزين بيانات إضافية مثل phone_number_id, waba_id
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- تفعيل RLS
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

-- سياسات الوصول (RLS Policies)
-- يمكن للمستخدم رؤية تكاملاته الخاصة فقط
CREATE POLICY "Users can view their own integrations" 
ON integrations FOR SELECT 
USING (auth.uid() = user_id);

-- يمكن للمستخدم إضافة تكامل جديد لنفسه
CREATE POLICY "Users can insert their own integrations" 
ON integrations FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- يمكن للمستخدم تحديث تكاملاته الخاصة
CREATE POLICY "Users can update their own integrations" 
ON integrations FOR UPDATE 
USING (auth.uid() = user_id);

-- يمكن للمستخدم حذف تكاملاته الخاصة
CREATE POLICY "Users can delete their own integrations" 
ON integrations FOR DELETE 
USING (auth.uid() = user_id);

-- إضافة Trigger لتحديث updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_integrations_updated_at
    BEFORE UPDATE ON integrations
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();
