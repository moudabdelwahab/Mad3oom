-- ═══════════════════════════════════════════════════════════════════════
-- Shared Inbox Tables Migration
-- إنشاء جداول صندوق الوارد المشترك متعدد الوكلاء
-- ═══════════════════════════════════════════════════════════════════════

-- 1. جدول المحادثات الرئيسي
CREATE TABLE IF NOT EXISTS shared_inbox_conversations (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  last_message TEXT,
  last_message_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  unread_count INTEGER NOT NULL DEFAULT 0,
  assigned_to BIGINT REFERENCES shared_inbox_agents(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  UNIQUE(user_id, phone_number),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_assigned_to (assigned_to),
  INDEX idx_updated_at (updated_at)
);

-- 2. جدول الوكلاء (الموظفين)
CREATE TABLE IF NOT EXISTS shared_inbox_agents (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'away')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  UNIQUE(user_id, email),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status)
);

-- 3. جدول الملاحظات الداخلية
CREATE TABLE IF NOT EXISTS shared_inbox_notes (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES shared_inbox_conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE,
  
  INDEX idx_conversation_id (conversation_id),
  INDEX idx_created_by (created_by),
  INDEX idx_created_at (created_at)
);

-- 4. جدول الوسوم (Tags)
CREATE TABLE IF NOT EXISTS shared_inbox_tags (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES shared_inbox_conversations(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  UNIQUE(conversation_id, name),
  INDEX idx_conversation_id (conversation_id),
  INDEX idx_name (name)
);

-- 5. جدول تتبع القراءة (Read Receipts)
CREATE TABLE IF NOT EXISTS shared_inbox_readers (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES shared_inbox_conversations(id) ON DELETE CASCADE,
  agent_id BIGINT NOT NULL REFERENCES shared_inbox_agents(id) ON DELETE CASCADE,
  read_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  UNIQUE(conversation_id, agent_id),
  INDEX idx_conversation_id (conversation_id),
  INDEX idx_agent_id (agent_id),
  INDEX idx_read_at (read_at)
);

-- 6. جدول سجل النشاط (Activity Log)
CREATE TABLE IF NOT EXISTS shared_inbox_activity_log (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES shared_inbox_conversations(id) ON DELETE CASCADE,
  agent_id BIGINT REFERENCES shared_inbox_agents(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  INDEX idx_conversation_id (conversation_id),
  INDEX idx_agent_id (agent_id),
  INDEX idx_action (action),
  INDEX idx_created_at (created_at)
);

-- ═══════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ═══════════════════════════════════════════════════════════════════════

-- Enable RLS on all tables
ALTER TABLE shared_inbox_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_inbox_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_inbox_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_inbox_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_inbox_readers ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_inbox_activity_log ENABLE ROW LEVEL SECURITY;

-- Conversations: Users can only see their own conversations
CREATE POLICY "Users can view their own conversations"
  ON shared_inbox_conversations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert conversations"
  ON shared_inbox_conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own conversations"
  ON shared_inbox_conversations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own conversations"
  ON shared_inbox_conversations FOR DELETE
  USING (auth.uid() = user_id);

-- Agents: Users can only see their own agents
CREATE POLICY "Users can view their own agents"
  ON shared_inbox_agents FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert agents"
  ON shared_inbox_agents FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own agents"
  ON shared_inbox_agents FOR UPDATE
  USING (auth.uid() = user_id);

-- Notes: Users can only see notes for their conversations
CREATE POLICY "Users can view notes for their conversations"
  ON shared_inbox_notes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM shared_inbox_conversations
      WHERE shared_inbox_conversations.id = shared_inbox_notes.conversation_id
      AND shared_inbox_conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert notes for their conversations"
  ON shared_inbox_notes FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM shared_inbox_conversations
      WHERE shared_inbox_conversations.id = shared_inbox_notes.conversation_id
      AND shared_inbox_conversations.user_id = auth.uid()
    )
  );

-- Tags: Users can only see tags for their conversations
CREATE POLICY "Users can view tags for their conversations"
  ON shared_inbox_tags FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM shared_inbox_conversations
      WHERE shared_inbox_conversations.id = shared_inbox_tags.conversation_id
      AND shared_inbox_conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert tags for their conversations"
  ON shared_inbox_tags FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM shared_inbox_conversations
      WHERE shared_inbox_conversations.id = shared_inbox_tags.conversation_id
      AND shared_inbox_conversations.user_id = auth.uid()
    )
  );

-- Readers: Users can only see readers for their conversations
CREATE POLICY "Users can view readers for their conversations"
  ON shared_inbox_readers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM shared_inbox_conversations
      WHERE shared_inbox_conversations.id = shared_inbox_readers.conversation_id
      AND shared_inbox_conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert readers for their conversations"
  ON shared_inbox_readers FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM shared_inbox_conversations
      WHERE shared_inbox_conversations.id = shared_inbox_readers.conversation_id
      AND shared_inbox_conversations.user_id = auth.uid()
    )
  );

-- Activity Log: Users can only see logs for their conversations
CREATE POLICY "Users can view activity logs for their conversations"
  ON shared_inbox_activity_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM shared_inbox_conversations
      WHERE shared_inbox_conversations.id = shared_inbox_activity_log.conversation_id
      AND shared_inbox_conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert activity logs for their conversations"
  ON shared_inbox_activity_log FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM shared_inbox_conversations
      WHERE shared_inbox_conversations.id = shared_inbox_activity_log.conversation_id
      AND shared_inbox_conversations.user_id = auth.uid()
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- INDEXES FOR PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════

-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_conversations_user_status 
  ON shared_inbox_conversations(user_id, status);

CREATE INDEX IF NOT EXISTS idx_conversations_user_assigned 
  ON shared_inbox_conversations(user_id, assigned_to);

CREATE INDEX IF NOT EXISTS idx_conversations_user_unread 
  ON shared_inbox_conversations(user_id, unread_count) 
  WHERE unread_count > 0;

CREATE INDEX IF NOT EXISTS idx_notes_conversation_created 
  ON shared_inbox_notes(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tags_conversation_name 
  ON shared_inbox_tags(conversation_id, name);

-- ═══════════════════════════════════════════════════════════════════════
-- FUNCTIONS & TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════

-- Function to update conversation updated_at timestamp
CREATE OR REPLACE FUNCTION update_conversation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update conversation timestamp
CREATE TRIGGER trigger_update_conversation_timestamp
  BEFORE UPDATE ON shared_inbox_conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_timestamp();

-- Function to log activity
CREATE OR REPLACE FUNCTION log_activity(
  p_conversation_id BIGINT,
  p_agent_id BIGINT,
  p_action VARCHAR,
  p_details JSONB DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  INSERT INTO shared_inbox_activity_log (conversation_id, agent_id, action, details)
  VALUES (p_conversation_id, p_agent_id, p_action, p_details);
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════
-- VIEWS FOR COMMON QUERIES
-- ═══════════════════════════════════════════════════════════════════════

-- View: Conversations with agent details
CREATE OR REPLACE VIEW v_conversations_with_agents AS
SELECT 
  c.id,
  c.user_id,
  c.phone_number,
  c.last_message,
  c.last_message_at,
  c.status,
  c.unread_count,
  c.assigned_to,
  a.name as agent_name,
  a.email as agent_email,
  c.created_at,
  c.updated_at
FROM shared_inbox_conversations c
LEFT JOIN shared_inbox_agents a ON c.assigned_to = a.id;

-- View: Conversations with tags
CREATE OR REPLACE VIEW v_conversations_with_tags AS
SELECT 
  c.id,
  c.user_id,
  c.phone_number,
  c.status,
  STRING_AGG(t.name, ', ') as tags
FROM shared_inbox_conversations c
LEFT JOIN shared_inbox_tags t ON c.id = t.conversation_id
GROUP BY c.id, c.user_id, c.phone_number, c.status;

-- View: Unread conversations count by agent
CREATE OR REPLACE VIEW v_unread_by_agent AS
SELECT 
  assigned_to,
  COUNT(*) as unread_count
FROM shared_inbox_conversations
WHERE unread_count > 0
GROUP BY assigned_to;
