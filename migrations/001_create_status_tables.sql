-- Create services table
CREATE TABLE IF NOT EXISTS services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'operational' CHECK (status IN ('operational', 'degraded', 'down')),
    response_time INTEGER,
    last_checked TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create service_status_history table
CREATE TABLE IF NOT EXISTS service_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL CHECK (status IN ('operational', 'degraded', 'down')),
    response_time INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create incidents table
CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'investigating' CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
    affected_services TEXT[] DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX idx_services_status ON services(status);
CREATE INDEX idx_service_history_service_id ON service_status_history(service_id);
CREATE INDEX idx_service_history_created_at ON service_status_history(created_at);
CREATE INDEX idx_incidents_status ON incidents(status);
CREATE INDEX idx_incidents_created_at ON incidents(created_at);

-- Enable RLS (Row Level Security)
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

-- Create policies for public read access
CREATE POLICY "Allow public read access to services" 
    ON services FOR SELECT 
    USING (true);

CREATE POLICY "Allow public read access to service history" 
    ON service_status_history FOR SELECT 
    USING (true);

CREATE POLICY "Allow public read access to incidents" 
    ON incidents FOR SELECT 
    USING (true);

-- Insert sample services
INSERT INTO services (name, description, status, response_time) VALUES
    ('API الرئيسية', 'خدمة API الأساسية للمنصة', 'operational', 45),
    ('قاعدة البيانات', 'خادم قاعدة البيانات الرئيسي', 'operational', 12),
    ('خدمة المصادقة', 'نظام تسجيل الدخول والمصادقة', 'operational', 23),
    ('خدمة الدفع', 'معالج الدفع والفواتير', 'operational', 156),
    ('خدمة البريد الإلكتروني', 'إرسال الرسائل والإشعارات', 'operational', 234),
    ('خدمة التخزين السحابي', 'تخزين الملفات والوسائط', 'operational', 89),
    ('خدمة الإشعارات', 'نظام الإشعارات الفورية', 'degraded', 450),
    ('لوحة التحكم', 'واجهة إدارة المنصة', 'operational', 78)
ON CONFLICT DO NOTHING;
