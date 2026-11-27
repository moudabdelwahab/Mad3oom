-- تراجع 148_agent_northflank_token.sql: يسقط عمودي توكن Northflank.
-- لا يحذف أي صف ولا يمسّ أي عمود آخر؛ إعادة تطبيق 148 تعيد العمودين فارغين.
alter table public.ai_agents
  drop column if exists northflank_token_encrypted,
  drop column if exists northflank_token_last4;
