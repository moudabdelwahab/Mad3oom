-- ============================================================================
-- 116 — تسوية تلقائية لدفعات Pi المؤكَّدة: تذكرة + تفعيل + فاتورة
--
-- قبل هذا: بعد إتمام الدفعة على البلوكتشين كانت الصفحة نفسها ترسل طلب
-- الاشتراك. لو خرج المستخدم لمحفظة Pi ولم يرجع السياق كما هو، كانت الدفعة
-- تُخصم بلا تذكرة ولا اشتراك.
--
-- الآن الخادم يسوّي الدفعة وحده فور تأكيدها من Pi (دالة pi-payments):
--   1. pi_settle_payment — طلب الاشتراك يُرسَل بهوية العميل عبر
--      submit_subscription_request نفسها (كل تحققاتها ومحفّزاتها كما هي)،
--      ثم يُفعَّل بلا هوية مستخدم بنفس خطوات تأكيد الأدمن
--      (confirmPurchaseTicket): التواريخ وقت التأكيد، recompute_user_access،
--      التذكرة confirmed، وإشعار العميل. معاملة واحدة.
--   2. accounting-sync (من الدالة) يصدر الفاتورة في النظام المحاسبي.
--   3. pi_attach_invoice — يرفق الفاتورة في ردود التذكرة بنفس منطق
--      attach_accounting_invoice، باسم مالك المنصة.
--
-- الدالتان لدور الخدمة وحده. وكلتاهما idempotent: إعادة النداء تُرجع النتيجة نفسها.
-- التراجع: migrations/_rollback/116_pi_auto_settlement.down.sql
-- ============================================================================

alter table public.pi_payments
  add column if not exists subscription_id uuid references public.whatsapp_subscriptions(id),
  add column if not exists ticket_id uuid references public.tickets(id),
  add column if not exists settled_at timestamptz,
  add column if not exists settle_error text,
  add column if not exists invoice_attached_at timestamptz;

create or replace function public.pi_settle_payment(p_pi_payment_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay        public.pi_payments%rowtype;
  v_plan_key   text;
  v_plan_label text;
  v_renewal    boolean;
  v_cycle_lbl  text;
  v_result     jsonb;
  v_sub_id     uuid;
  v_ticket_id  uuid;
  v_sub        public.whatsapp_subscriptions%rowtype;
  v_start      timestamptz;
  v_end        timestamptz;
  v_owner      uuid;
  v_ref        text;
begin
  select * into v_pay from public.pi_payments
   where pi_payment_id = p_pi_payment_id for update;
  if not found then
    raise exception 'دفعة Pi غير موجودة: %', p_pi_payment_id;
  end if;
  if v_pay.status <> 'completed' then
    raise exception 'لا تُسوّى إلا الدفعة المكتملة (الحالة: %)', v_pay.status;
  end if;
  if v_pay.settled_at is not null then
    return jsonb_build_object('status', 'already_settled',
      'subscription_id', v_pay.subscription_id, 'ticket_id', v_pay.ticket_id);
  end if;

  select key, coalesce(name_ar, name) into v_plan_key, v_plan_label
    from public.subscription_plans where id = v_pay.plan_id;
  if v_plan_key is null then
    raise exception 'الخطة المرتبطة بالدفعة غير موجودة';
  end if;

  v_renewal := exists (
    select 1 from public.whatsapp_subscriptions
     where user_id = v_pay.user_id and plan = v_plan_key
       and status = 'active' and end_date > now());
  v_cycle_lbl := case when v_pay.billing_cycle = 'yearly' then 'سنوي' else 'شهري' end;
  v_ref := format('Pi Network · %s π · payment %s · txid %s',
                  trim(to_char(v_pay.amount, 'FM999999990.9999999')), v_pay.pi_payment_id, v_pay.txid);

  -- ── 1) الطلب بهوية العميل: نفس مسار المتصفح حرفيًا ──────────────────
  perform set_config('request.jwt.claim.sub', v_pay.user_id::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_pay.user_id, 'role', 'authenticated')::text, true);

  v_result := public.submit_subscription_request(
    v_plan_key, v_pay.billing_cycle,
    format('%s - %s (%s)', case when v_renewal then 'طلب تجديد اشتراك' else 'طلب اشتراك' end, v_plan_label, v_cycle_lbl),
    format(E'%s\n\nالخطة: %s\nنوع الفترة: %s\nوسيلة الدفع: Pi Network\nالمبلغ: %s π\nرقم الدفعة: %s\nالمعاملة (txid): %s\n\nدفعة مؤكَّدة على البلوكتشين — فُعِّل الاشتراك تلقائيًا.',
           case when v_renewal then 'طلب تجديد اشتراك' else 'طلب اشتراك جديد' end,
           v_plan_label, v_cycle_lbl,
           trim(to_char(v_pay.amount, 'FM999999990.9999999')), v_pay.pi_payment_id, v_pay.txid),
    v_renewal, 'gateway', v_ref);

  -- لا هوية بعد هذه النقطة: التأكيد عمل الخادم لا العميل
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  v_sub_id    := (v_result->>'subscription_id')::uuid;
  v_ticket_id := (v_result->'ticket'->>'id')::uuid;

  -- ── 2) التفعيل: نفس خطوات confirmPurchaseTicket ────────────────────────
  select * into v_sub from public.whatsapp_subscriptions where id = v_sub_id for update;
  v_start := now();
  if v_sub.is_renewal and v_sub.previous_end_date is not null and v_sub.previous_end_date > now() then
    v_start := v_sub.previous_end_date;
  end if;
  v_end := v_start + case when v_sub.billing_cycle = 'yearly' then interval '1 year' else interval '1 month' end;

  update public.whatsapp_subscriptions
     set status = 'active', start_date = v_start, end_date = v_end,
         reviewed_at = now(), updated_at = now()
   where id = v_sub_id and status = 'pending';

  perform public.recompute_user_access(v_pay.user_id);

  select id into v_owner from public.profiles where role = 'platform_owner' order by created_at limit 1;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);
  update public.tickets
     set status = 'confirmed', last_updated_by = v_owner, last_updated_at = now()
   where id = v_ticket_id;
  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  insert into public.notifications (user_id, title, message, type, link)
  values (v_pay.user_id, '✓ تم تفعيل اشتراكك',
          format('تم استلام دفعتك بـPi وتفعيل اشتراكك في خطة "%s" (%s). ينتهي في: %s.',
                 v_plan_label, v_cycle_lbl, to_char(v_end at time zone 'Africa/Cairo', 'YYYY-MM-DD')),
          'success', '/customer-subscriptions.html');

  update public.pi_payments
     set subscription_id = v_sub_id, ticket_id = v_ticket_id,
         settled_at = now(), settle_error = null
   where id = v_pay.id;

  return jsonb_build_object('status', 'settled', 'subscription_id', v_sub_id,
    'ticket_id', v_ticket_id, 'end_date', v_end);
end $$;

-- إرفاق الفاتورة: منطق attach_accounting_invoice نفسه، والكاتب مالك المنصة
create or replace function public.pi_attach_invoice(p_pi_payment_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay        public.pi_payments%rowtype;
  v_inv        public.accounting_invoices;
  v_owner      uuid;
  v_base_url   text;
  v_url        text;
  v_plan_label text;
  v_message    text;
  v_reply_id   uuid;
  v_attach_id  uuid;
begin
  select * into v_pay from public.pi_payments where pi_payment_id = p_pi_payment_id for update;
  if not found or v_pay.ticket_id is null then
    raise exception 'الدفعة غير مسوّاة بعد';
  end if;

  select * into v_inv from public.accounting_invoices
   where ticket_id = v_pay.ticket_id order by created_at desc limit 1 for update;
  if not found then
    return jsonb_build_object('status', 'no_invoice_yet');
  end if;
  if v_inv.reply_id is not null then
    update public.pi_payments set invoice_attached_at = coalesce(invoice_attached_at, now()) where id = v_pay.id;
    return jsonb_build_object('status', 'already_attached', 'invoice_number', v_inv.invoice_number);
  end if;

  select id into v_owner from public.profiles where role = 'platform_owner' order by created_at limit 1;

  v_base_url := coalesce(
    (select value->>'public_invoice_base_url' from public.advanced_settings where key = 'accounting_integration'),
    'https://mad3oom.com/invoice.html');
  v_url := v_base_url || '?t=' || v_inv.public_token;
  v_plan_label := coalesce((select coalesce(name_ar, name) from public.subscription_plans where key = v_inv.plan), v_inv.plan);

  v_message :=
    'تم إصدار فاتورة لهذا الطلب.' || E'\n\n' ||
    'رقم الفاتورة: ' || v_inv.invoice_number || E'\n' ||
    case when v_plan_label is not null then 'الباقة: ' || v_plan_label || E'\n' else '' end ||
    'الإجمالي: ' || trim(to_char(v_inv.total, 'FM999999990.00')) || ' ' || v_inv.currency || E'\n' ||
    'المدفوع: ' || trim(to_char(v_pay.amount, 'FM999999990.9999999')) || ' π عبر Pi Network' || E'\n' ||
    E'\n' || 'لعرض الفاتورة والتحقق منها: ' || v_url;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);
  insert into public.ticket_replies (ticket_id, user_id, message, is_internal)
  values (v_pay.ticket_id, v_owner, v_message, false)
  returning id into v_reply_id;

  insert into public.ticket_attachments (ticket_id, reply_id, file_url, file_name, mime_type, uploaded_by)
  values (v_pay.ticket_id, v_reply_id, v_url, 'فاتورة ' || v_inv.invoice_number, 'text/html', v_owner)
  returning id into v_attach_id;

  update public.accounting_invoices
     set reply_id = v_reply_id, attachment_id = v_attach_id, updated_at = now()
   where id = v_inv.id;
  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  update public.pi_payments set invoice_attached_at = now() where id = v_pay.id;

  return jsonb_build_object('status', 'attached', 'invoice_number', v_inv.invoice_number, 'public_url', v_url);
end $$;

revoke all on function public.pi_settle_payment(text) from public, anon, authenticated;
revoke all on function public.pi_attach_invoice(text) from public, anon, authenticated;
grant execute on function public.pi_settle_payment(text) to service_role;
grant execute on function public.pi_attach_invoice(text) to service_role;
