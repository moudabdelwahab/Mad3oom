-- 051: الفاتورة تُرفَق في التذكرة بزر، لا تلقائيًا
--
-- المطلوب من صاحب المنتج: الاشتراك بعد الموافقة عليه يذهب أولًا إلى
-- النظام المحاسبي (acc)، ثم يظهر للمالك والأدمن والموظفين زر «إرفاق فاتورة»
-- في التذكرة، والضغط عليه هو الذي يضيف الفاتورة في ردود التذكرة.
--
-- قبل هذا الترحيل كانت record_accounting_invoice (تناديها accounting-sync
-- بمفتاح service_role) تسجّل الفاتورة وتكتب الرد والمرفق في خطوة واحدة.
-- الآن تنقسم إلى خطوتين:
--
--   1. record_accounting_invoice — تسجّل الفاتورة وتُصدر رمزها العام فقط.
--      الرمز لازم قبل الإرفاق لأن المحاسبة تطبعه QR على الفاتورة.
--   2. attach_accounting_invoice — يناديها الزر. تكتب الرد والمرفق باسم
--      الموظف الذي ضغط، مرة واحدة فقط لكل فاتورة.
--
-- والزر يحتاج أن يعرف حالة الفاتورة (غير موجودة / جاهزة / مرفقة) دون أن
-- يقرأ accounting_invoices مباشرة، فسياسة القراءة عليها للعميل وللأدمن
-- فقط: ticket_invoice_status تجيب بذلك لطاقم المنصة.
--
-- «المالك والأدمن والموظفين» = is_platform_staff(): الأدمن والدعم، ومالك
-- المنصة في سياق owner/admin.

-- ---------- 1) التسجيل بلا إرفاق ----------
create or replace function public.record_accounting_invoice(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings   jsonb;
  v_base_url   text;
  v_existing   public.accounting_invoices;
  v_invoice    public.accounting_invoices;
  v_ticket_id  uuid;
  v_user_id    uuid;
begin
  if p_payload is null or p_payload->>'external_invoice_id' is null then
    raise exception 'external_invoice_id مطلوب';
  end if;

  select value into v_settings from public.advanced_settings where key = 'accounting_integration';
  v_base_url := coalesce(v_settings->>'public_invoice_base_url', 'https://mad3oom.com/invoice.html');

  select * into v_existing from public.accounting_invoices
   where external_invoice_id = (p_payload->>'external_invoice_id')::uuid;

  if found then
    return jsonb_build_object(
      'status',       'already_recorded',
      'invoice_id',   v_existing.id,
      'public_token', v_existing.public_token,
      'public_url',   v_base_url || '?t=' || v_existing.public_token,
      'reply_id',     v_existing.reply_id
    );
  end if;

  v_ticket_id := nullif(p_payload->>'ticket_id', '')::uuid;
  v_user_id   := nullif(p_payload->>'user_id', '')::uuid;

  -- استنتاج العميل من التذكرة إن لم يُمرَّر
  if v_user_id is null and v_ticket_id is not null then
    select user_id into v_user_id from public.tickets where id = v_ticket_id;
  end if;

  insert into public.accounting_invoices (
    external_invoice_id, invoice_number, ticket_id, user_id, subscription_id,
    plan, billing_cycle, subtotal, tax_amount, total, currency,
    issue_date, due_date, status
  ) values (
    (p_payload->>'external_invoice_id')::uuid,
    coalesce(p_payload->>'invoice_number', '—'),
    v_ticket_id,
    v_user_id,
    nullif(p_payload->>'subscription_id', '')::uuid,
    p_payload->>'plan',
    p_payload->>'billing_cycle',
    coalesce((p_payload->>'subtotal')::numeric, 0),
    coalesce((p_payload->>'tax_amount')::numeric, 0),
    coalesce((p_payload->>'total')::numeric, 0),
    coalesce(p_payload->>'currency', 'USD'),
    nullif(p_payload->>'issue_date', '')::date,
    nullif(p_payload->>'due_date', '')::date,
    p_payload->>'status'
  ) returning * into v_invoice;

  return jsonb_build_object(
    'status',       'recorded',
    'invoice_id',   v_invoice.id,
    'public_token', v_invoice.public_token,
    'public_url',   v_base_url || '?t=' || v_invoice.public_token,
    'reply_id',     null
  );
end;
$$;

-- ---------- 2) حالة الفاتورة لزر التذكرة ----------
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

-- ---------- 3) الزر: إرفاق الفاتورة في ردود التذكرة ----------
create or replace function public.attach_accounting_invoice(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author     uuid := auth.uid();
  v_inv        public.accounting_invoices;
  v_base_url   text;
  v_url        text;
  v_plan_label text;
  v_message    text;
  v_reply_id   uuid;
  v_attach_id  uuid;
begin
  if v_author is null or not public.is_platform_staff() then
    raise exception 'إرفاق الفاتورة متاح للمالك والأدمن والموظفين فقط' using errcode = '42501';
  end if;

  -- القفل يمنع ضغطتين متزامنتين من كتابة ردّين للفاتورة نفسها
  select * into v_inv from public.accounting_invoices
   where ticket_id = p_ticket_id
   order by created_at desc
   limit 1
   for update;

  if not found then
    raise exception 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد' using errcode = 'P0002';
  end if;

  if v_inv.reply_id is not null then
    return jsonb_build_object(
      'status',        'already_attached',
      'reply_id',      v_inv.reply_id,
      'attachment_id', v_inv.attachment_id
    );
  end if;

  v_base_url := coalesce(
    (select value->>'public_invoice_base_url' from public.advanced_settings where key = 'accounting_integration'),
    'https://mad3oom.com/invoice.html');
  v_url := v_base_url || '?t=' || v_inv.public_token;

  v_plan_label := coalesce(
    (select coalesce(name_ar, name) from public.subscription_plans where key = v_inv.plan),
    v_inv.plan
  );

  v_message :=
    'تم إصدار فاتورة لهذا الطلب.' || E'\n\n' ||
    'رقم الفاتورة: ' || v_inv.invoice_number || E'\n' ||
    case when v_plan_label is not null then 'الباقة: ' || v_plan_label || E'\n' else '' end ||
    'الإجمالي: ' || trim(to_char(v_inv.total, 'FM999999990.00')) || ' ' || v_inv.currency || E'\n' ||
    case when v_inv.due_date is not null
         then 'تاريخ الاستحقاق: ' || to_char(v_inv.due_date, 'YYYY-MM-DD') || E'\n' else '' end ||
    E'\n' || 'لعرض الفاتورة والتحقق منها: ' || v_url;

  -- محفّز track_first_response يعدّل التذكرة، وحارس التذاكر يرفض ذلك لغير
  -- الأدمن (موظف الدعم مثلًا). هذا مخرج المنصة القياسي للعمليات الموثوقة
  -- بعد فحص الصلاحية، نفسه المستعمل في record_accounting_invoice سابقًا.
  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  insert into public.ticket_replies (ticket_id, user_id, message, is_internal)
  values (p_ticket_id, v_author, v_message, false)
  returning id into v_reply_id;

  insert into public.ticket_attachments (
    ticket_id, reply_id, file_url, file_name, mime_type, uploaded_by
  ) values (
    p_ticket_id, v_reply_id, v_url,
    'فاتورة ' || v_inv.invoice_number,
    'text/html', v_author
  ) returning id into v_attach_id;

  update public.accounting_invoices
     set reply_id = v_reply_id, attachment_id = v_attach_id, updated_at = now()
   where id = v_inv.id;

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return jsonb_build_object(
    'status',         'attached',
    'reply_id',       v_reply_id,
    'attachment_id',  v_attach_id,
    'invoice_number', v_inv.invoice_number,
    'public_url',     v_url
  );
end;
$$;

revoke all on function public.ticket_invoice_status(uuid)     from public, anon;
revoke all on function public.attach_accounting_invoice(uuid) from public, anon;
grant execute on function public.ticket_invoice_status(uuid)     to authenticated;
grant execute on function public.attach_accounting_invoice(uuid) to authenticated;
