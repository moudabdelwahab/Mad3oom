-- =====================================================
-- نظام الرد الآلي المتقدم - Database Schema
-- mad3oom.online - Enterprise SaaS Grade
-- Version: 3.0.0
-- =====================================================

-- هذا الملف تم تطبيقه بالفعل على قاعدة البيانات باستخدام Supabase MCP
-- يمكن استخدامه كمرجع أو للنسخ الاحتياطي

-- =====================================================
-- 1. جدول الرسائل المجدولة
-- =====================================================

CREATE TABLE IF NOT EXISTS public.scheduled_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    phone_number VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
    sent_at TIMESTAMP WITH TIME ZONE,
    whatsapp_message_id VARCHAR(100),
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_scheduled_messages_status_time ON public.scheduled_messages(status, scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_scheduled_messages_user ON public.scheduled_messages(user_id);
CREATE INDEX idx_scheduled_messages_phone ON public.scheduled_messages(phone_number);

ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own scheduled messages" ON public.scheduled_messages FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own scheduled messages" ON public.scheduled_messages FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own scheduled messages" ON public.scheduled_messages FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own scheduled messages" ON public.scheduled_messages FOR DELETE USING (auth.uid() = user_id);

-- =====================================================
-- 2. جدول أحداث التحليلات
-- =====================================================

CREATE TABLE IF NOT EXISTS public.flow_analytics_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    phone_number VARCHAR(20) NOT NULL,
    flow_id VARCHAR(100) NOT NULL,
    node_id VARCHAR(100),
    node_type VARCHAR(50),
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
        'node_entry', 'node_exit', 'flow_completed', 'flow_error', 
        'button_click', 'condition_result', 'flow_started'
    )),
    duration_ms INTEGER,
    success BOOLEAN,
    error_message TEXT,
    total_duration_ms INTEGER,
    nodes_visited INTEGER,
    condition VARCHAR(255),
    result BOOLEAN,
    button_text VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_flow_events_user_flow ON public.flow_analytics_events(user_id, flow_id);
CREATE INDEX idx_flow_events_timestamp ON public.flow_analytics_events(timestamp DESC);
CREATE INDEX idx_flow_events_type ON public.flow_analytics_events(event_type);
CREATE INDEX idx_flow_events_user_time ON public.flow_analytics_events(user_id, timestamp DESC);
CREATE INDEX idx_flow_events_phone ON public.flow_analytics_events(phone_number);
CREATE INDEX idx_flow_events_node ON public.flow_analytics_events(node_id, event_type);

ALTER TABLE public.flow_analytics_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own analytics events" ON public.flow_analytics_events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own analytics events" ON public.flow_analytics_events FOR INSERT WITH CHECK (auth.uid() = user_id);

-- =====================================================
-- 3. جدول قوالب التدفقات
-- =====================================================

CREATE TABLE IF NOT EXISTS public.flow_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    name_ar VARCHAR(100) NOT NULL,
    description TEXT,
    description_ar TEXT,
    category VARCHAR(50) NOT NULL CHECK (category IN (
        'welcome', 'support', 'sales', 'feedback', 
        'lead_generation', 'appointment', 'faq', 'custom'
    )),
    flow_data JSONB NOT NULL,
    preview_image_url TEXT,
    is_public BOOLEAN DEFAULT true,
    is_featured BOOLEAN DEFAULT false,
    usage_count INTEGER DEFAULT 0,
    rating DECIMAL(3,2) DEFAULT 0.00,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_flow_templates_category ON public.flow_templates(category);
CREATE INDEX idx_flow_templates_public ON public.flow_templates(is_public, is_featured);
CREATE INDEX idx_flow_templates_usage ON public.flow_templates(usage_count DESC);
CREATE INDEX idx_flow_templates_tags ON public.flow_templates USING GIN(tags);

ALTER TABLE public.flow_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view public templates" ON public.flow_templates FOR SELECT USING (is_public = true OR auth.uid() = created_by);
CREATE POLICY "Users can create their own templates" ON public.flow_templates FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Users can update their own templates" ON public.flow_templates FOR UPDATE USING (auth.uid() = created_by);
CREATE POLICY "Users can delete their own templates" ON public.flow_templates FOR DELETE USING (auth.uid() = created_by);

-- =====================================================
-- 4. Views للتحليلات
-- =====================================================

-- إحصائيات التدفقات اليومية
CREATE OR REPLACE VIEW public.flow_daily_stats AS
SELECT 
    user_id, flow_id, DATE(timestamp) as date,
    COUNT(DISTINCT CASE WHEN event_type = 'flow_started' THEN phone_number END) as unique_users,
    COUNT(CASE WHEN event_type = 'flow_started' THEN 1 END) as total_starts,
    COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END) as total_completions,
    COUNT(CASE WHEN event_type = 'flow_error' THEN 1 END) as total_errors,
    ROUND((COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END)::DECIMAL / 
           NULLIF(COUNT(CASE WHEN event_type = 'flow_started' THEN 1 END), 0) * 100), 2) as completion_rate,
    AVG(CASE WHEN event_type = 'flow_completed' THEN total_duration_ms END) as avg_duration_ms
FROM public.flow_analytics_events
GROUP BY user_id, flow_id, DATE(timestamp);

-- أداء العقد
CREATE OR REPLACE VIEW public.node_performance_stats AS
SELECT 
    user_id, flow_id, node_id, node_type,
    COUNT(*) as total_visits,
    AVG(duration_ms) as avg_duration_ms,
    MAX(duration_ms) as max_duration_ms,
    MIN(duration_ms) as min_duration_ms,
    COUNT(CASE WHEN success = false THEN 1 END) as error_count,
    ROUND((COUNT(CASE WHEN success = false THEN 1 END)::DECIMAL / NULLIF(COUNT(*), 0) * 100), 2) as error_rate
FROM public.flow_analytics_events
WHERE event_type = 'node_exit' AND node_id IS NOT NULL
GROUP BY user_id, flow_id, node_id, node_type;

-- الرسائل المجدولة النشطة
CREATE OR REPLACE VIEW public.active_scheduled_messages AS
SELECT 
    sm.*, p.full_name as user_name,
    EXTRACT(EPOCH FROM (sm.scheduled_at - NOW())) as seconds_until_send,
    CASE 
        WHEN sm.scheduled_at <= NOW() THEN 'overdue'
        WHEN sm.scheduled_at <= NOW() + INTERVAL '1 hour' THEN 'imminent'
        ELSE 'scheduled'
    END as urgency_status
FROM public.scheduled_messages sm
LEFT JOIN public.profiles p ON p.id = sm.user_id
WHERE sm.status = 'pending'
ORDER BY sm.scheduled_at ASC;

-- الجلسات النشطة
CREATE OR REPLACE VIEW public.active_user_sessions AS
SELECT 
    bus.*, p.full_name as user_name,
    EXTRACT(EPOCH FROM (NOW() - bus.last_interaction)) as seconds_since_last_interaction,
    CASE 
        WHEN bus.last_interaction >= NOW() - INTERVAL '5 minutes' THEN 'active'
        WHEN bus.last_interaction >= NOW() - INTERVAL '1 hour' THEN 'idle'
        WHEN bus.last_interaction >= NOW() - INTERVAL '24 hours' THEN 'stale'
        ELSE 'expired'
    END as session_status
FROM public.bot_user_states bus
LEFT JOIN public.profiles p ON p.id = bus.user_id
WHERE bus.last_interaction >= NOW() - INTERVAL '24 hours'
ORDER BY bus.last_interaction DESC;

-- نقاط الخروج
CREATE OR REPLACE VIEW public.flow_dropoff_points AS
WITH node_entries AS (
    SELECT user_id, flow_id, node_id, COUNT(*) as entry_count
    FROM public.flow_analytics_events
    WHERE event_type = 'node_entry'
    GROUP BY user_id, flow_id, node_id
),
node_exits AS (
    SELECT user_id, flow_id, node_id, COUNT(*) as exit_count
    FROM public.flow_analytics_events
    WHERE event_type = 'node_exit'
    GROUP BY user_id, flow_id, node_id
)
SELECT 
    ne.user_id, ne.flow_id, ne.node_id,
    ne.entry_count,
    COALESCE(nx.exit_count, 0) as exit_count,
    ne.entry_count - COALESCE(nx.exit_count, 0) as dropoff_count,
    ROUND(((ne.entry_count - COALESCE(nx.exit_count, 0))::DECIMAL / ne.entry_count * 100), 2) as dropoff_rate
FROM node_entries ne
LEFT JOIN node_exits nx ON ne.user_id = nx.user_id AND ne.flow_id = nx.flow_id AND ne.node_id = nx.node_id
WHERE ne.entry_count > 0
ORDER BY dropoff_rate DESC;

-- =====================================================
-- 5. دوال الصيانة والتحليلات
-- =====================================================

-- تنظيف الجلسات المنتهية
CREATE OR REPLACE FUNCTION public.cleanup_expired_sessions()
RETURNS INTEGER AS $$
DECLARE deleted_count INTEGER;
BEGIN
    DELETE FROM public.bot_user_states WHERE last_interaction < NOW() - INTERVAL '30 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- تنظيف الرسائل القديمة
CREATE OR REPLACE FUNCTION public.cleanup_old_scheduled_messages()
RETURNS INTEGER AS $$
DECLARE deleted_count INTEGER;
BEGIN
    DELETE FROM public.scheduled_messages
    WHERE status IN ('sent', 'failed', 'cancelled') AND created_at < NOW() - INTERVAL '90 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- أرشفة الأحداث القديمة
CREATE OR REPLACE FUNCTION public.archive_old_analytics_events()
RETURNS INTEGER AS $$
DECLARE deleted_count INTEGER;
BEGIN
    DELETE FROM public.flow_analytics_events WHERE timestamp < NOW() - INTERVAL '180 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- إحصائيات المستخدم
CREATE OR REPLACE FUNCTION public.get_user_flow_stats(
    p_user_id UUID, p_flow_id VARCHAR DEFAULT 'default', p_days INTEGER DEFAULT 7
)
RETURNS TABLE(
    total_executions BIGINT, completed_executions BIGINT, failed_executions BIGINT,
    avg_duration_seconds NUMERIC, completion_rate NUMERIC, unique_users BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(DISTINCT CASE WHEN event_type = 'flow_started' THEN timestamp END),
        COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END),
        COUNT(CASE WHEN event_type = 'flow_error' THEN 1 END),
        ROUND(AVG(CASE WHEN event_type = 'flow_completed' THEN total_duration_ms / 1000.0 END), 2),
        ROUND((COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END)::NUMERIC / 
               NULLIF(COUNT(DISTINCT CASE WHEN event_type = 'flow_started' THEN timestamp END), 0) * 100), 2),
        COUNT(DISTINCT phone_number)
    FROM public.flow_analytics_events
    WHERE user_id = p_user_id AND flow_id = p_flow_id
    AND timestamp >= NOW() - (p_days || ' days')::INTERVAL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- أكثر العقد زيارة
CREATE OR REPLACE FUNCTION public.get_most_visited_nodes(
    p_user_id UUID, p_flow_id VARCHAR DEFAULT 'default', p_limit INTEGER DEFAULT 10
)
RETURNS TABLE(node_id VARCHAR, node_type VARCHAR, visit_count BIGINT, avg_duration_ms NUMERIC) AS $$
BEGIN
    RETURN QUERY
    SELECT fae.node_id, fae.node_type, COUNT(*), ROUND(AVG(fae.duration_ms), 2)
    FROM public.flow_analytics_events fae
    WHERE fae.user_id = p_user_id AND fae.flow_id = p_flow_id
    AND fae.event_type = 'node_entry' AND fae.node_id IS NOT NULL
    GROUP BY fae.node_id, fae.node_type
    ORDER BY COUNT(*) DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- تقرير شامل
CREATE OR REPLACE FUNCTION public.generate_flow_report(
    p_user_id UUID, p_flow_id VARCHAR DEFAULT 'default',
    p_start_date TIMESTAMP DEFAULT NOW() - INTERVAL '30 days',
    p_end_date TIMESTAMP DEFAULT NOW()
)
RETURNS JSON AS $$
DECLARE report JSON;
BEGIN
    SELECT json_build_object(
        'period', json_build_object('start', p_start_date, 'end', p_end_date),
        'summary', (
            SELECT json_build_object(
                'total_executions', COUNT(DISTINCT CASE WHEN event_type = 'flow_started' THEN timestamp END),
                'completions', COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END),
                'errors', COUNT(CASE WHEN event_type = 'flow_error' THEN 1 END),
                'unique_users', COUNT(DISTINCT phone_number),
                'avg_duration_ms', ROUND(AVG(CASE WHEN event_type = 'flow_completed' THEN total_duration_ms END), 2)
            )
            FROM public.flow_analytics_events
            WHERE user_id = p_user_id AND flow_id = p_flow_id
            AND timestamp BETWEEN p_start_date AND p_end_date
        )
    ) INTO report;
    RETURN report;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- نهاية الملف
-- =====================================================
