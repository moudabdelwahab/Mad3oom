-- التراجع عن 116 — يحذف دالتي التسوية والإرفاق وأعمدة الربط. التذاكر والاشتراكات المنشأة تبقى.
drop function if exists public.pi_attach_invoice(text);
drop function if exists public.pi_settle_payment(text);
alter table public.pi_payments
  drop column if exists invoice_attached_at,
  drop column if exists settle_error,
  drop column if exists settled_at,
  drop column if exists ticket_id,
  drop column if exists subscription_id;
