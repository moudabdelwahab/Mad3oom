-- ============================================================================
-- تراجع 072_invoice_pdf_attachment
--
-- بيرجّع ticket_invoice_status لنص 051 (اللي على الإنتاج قبل 072) ويشيل
-- الدالتين الجديدتين. مرفقات الـ PDF اللي اتعملت تفضل زي ما هي (ملفات في مجلد
-- التذكرة وصفوف في ticket_attachments) — العميل يفضل شايفها. زر الواجهة القديمة
-- (attach_accounting_invoice) لسه موجود من 051.
-- ============================================================================

begin;

create or replace function public.ticket_invoice_status(p_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_inv public.accounting_invoices;
begin
  if not public.is_platform_staff() then
    raise exception 'حالة الفاتورة متاحة لطاقم المنصة فقط' using errcode = '42501';
  end if;

  select * into v_inv from public.accounting_invoices
   where ticket_id = p_ticket_id
   order by created_at desc
   limit 1;

  if not found then
    return jsonb_build_object('state', 'none');
  end if;

  return jsonb_build_object(
    'state',          case when v_inv.reply_id is null then 'ready' else 'attached' end,
    'invoice_number', v_inv.invoice_number,
    'total',          v_inv.total,
    'currency',       v_inv.currency
  );
end;
$$;

drop function if exists public.ticket_invoice_document(uuid);
drop function if exists public.attach_accounting_invoice_pdf(uuid, text, text);

commit;
