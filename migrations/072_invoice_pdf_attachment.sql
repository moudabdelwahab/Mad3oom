-- ============================================================================
-- 072_invoice_pdf_attachment.sql
--   الفاتورة تُرفَق في التذكرة ملف PDF كامل، لا رابطًا
--
-- الطلب (من صاحب المنصة): «محتاج ارفاقها ك pdf ضروري وتكون فاتوره كامله زي
-- اللي بتكون موجوده في نظام المحاسبه».
--
-- قبل 072 كان زر «إرفاق فاتورة» (051) يكتب ردًّا فيه رابط صفحة التحقق
-- (invoice.html?t=…) ومرفقًا من نوع text/html يشير لنفس الرابط — العميل لا
-- يستلم فاتورة، بل رابطًا لملخّص.
--
-- الآن:
--   1. ticket_invoice_document — كل ما تحتاجه الفاتورة الكاملة (رقمها،
--      تواريخها، حالتها، العميل وشركته، بند الاشتراك وفترته، الإجماليات،
--      ورابط التحقق للـ QR) لطاقم المنصة فقط. البند مشتق من الاشتراك نفسه:
--      الفواتير اللي تنشئها المزامنة في acc بلا بنود، وسعرها = subtotal.
--   2. المتصفح يرسم الفاتورة بتصميم النظام المحاسبي ويحوّلها PDF ويرفعها في
--      مجلد التذكرة في مستودع tickets (اللي سياساته تسمح للطاقم بالرفع ولصاحب
--      التذكرة بالقراءة).
--   3. attach_accounting_invoice_pdf — تتحقق من الملف في التخزين (المسار داخل
--      مجلد التذكرة، النوع application/pdf، ورافعه هو المنادي) ثم:
--        • فاتورة لم تُرفَق: ردّ + مرفق PDF، مرة واحدة.
--        • فاتورة أُرفقت قبل 072 كرابط: المرفق نفسه يصير الـ PDF (نفس الرد).
--        • مرفقة PDF بالفعل: لا شيء (already_attached).
--   4. ticket_invoice_status تضيف has_pdf ليعرف الزر أي حالة يعرض.
--
-- attach_accounting_invoice (051) تبقى كما هي: الواجهة الجديدة لا تناديها، وتغيير
-- توقيعها كان سيكسر الواجهة الحالية قبل نشر الجديدة.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/072_invoice_pdf_attachment.down.sql
-- ============================================================================

-- ---------- 1) حالة الفاتورة لزر التذكرة (+ has_pdf) ----------
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
    return jsonb_build_object('state', 'none', 'has_pdf', false);
  end if;

  return jsonb_build_object(
    'state',          case when v_inv.reply_id is null then 'ready' else 'attached' end,
    'invoice_number', v_inv.invoice_number,
    'total',          v_inv.total,
    'currency',       v_inv.currency,
    'has_pdf',        exists (select 1 from public.ticket_attachments a
                               where a.id = v_inv.attachment_id
                                 and a.mime_type = 'application/pdf')
  );
end;
$$;

-- ---------- 2) بيانات الفاتورة الكاملة لرسم الـ PDF ----------
create or replace function public.ticket_invoice_document(p_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv        public.accounting_invoices;
  v_ticket     public.tickets;
  v_sub        public.whatsapp_subscriptions;
  v_prof       public.profiles;
  v_company    public.companies;
  v_plan       text;
  v_cycle      text;
  v_plan_label text;
  v_base_url   text;
  v_desc       text;
begin
  if not public.is_platform_staff() then
    raise exception 'بيانات الفاتورة متاحة لطاقم المنصة فقط' using errcode = '42501';
  end if;

  select * into v_inv from public.accounting_invoices
   where ticket_id = p_ticket_id
   order by created_at desc
   limit 1;
  if not found then
    raise exception 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد' using errcode = 'P0002';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id;

  -- الاشتراك: المسجّل مع الفاتورة، وإلا المرتبط بالتذكرة
  select * into v_sub from public.whatsapp_subscriptions where id = v_inv.subscription_id;
  if not found then
    select * into v_sub from public.whatsapp_subscriptions
     where ticket_id = p_ticket_id
     order by created_at desc
     limit 1;
  end if;

  v_plan  := coalesce(v_inv.plan, v_sub.plan);
  v_cycle := coalesce(v_inv.billing_cycle, v_sub.billing_cycle);
  v_plan_label := coalesce(
    (select coalesce(sp.name_ar, sp.name) from public.subscription_plans sp where sp.key = v_plan),
    v_plan);
  v_desc := case
    when v_plan_label is null then 'اشتراك منصة مدعوم'
    else 'اشتراك ' || v_plan_label
         || case v_cycle when 'yearly' then ' — سنوي' when 'monthly' then ' — شهري' else '' end
  end;

  select * into v_prof from public.profiles where id = coalesce(v_inv.user_id, v_ticket.user_id);

  -- الشركة: المربوطة بالاشتراك، وإلا شركة يملكها العميل
  select * into v_company from public.companies where id = v_sub.company_id;
  if not found then
    select * into v_company from public.companies where user_id = v_prof.id order by created_at limit 1;
  end if;

  v_base_url := coalesce(
    (select value->>'public_invoice_base_url' from public.advanced_settings where key = 'accounting_integration'),
    'https://mad3oom.com/invoice.html');

  return jsonb_build_object(
    'invoice_number', v_inv.invoice_number,
    'issue_date',     v_inv.issue_date,
    'due_date',       v_inv.due_date,
    'status',         v_inv.status,
    'subtotal',       v_inv.subtotal,
    'tax_amount',     v_inv.tax_amount,
    'total',          v_inv.total,
    'currency',       v_inv.currency,
    'public_url',     v_base_url || '?t=' || v_inv.public_token,
    'ticket_number',  v_ticket.ticket_number,
    'customer', jsonb_build_object(
      'name',    coalesce(nullif(v_prof.full_name, ''), v_prof.username, v_prof.email),
      'email',   v_prof.email,
      'phone',   v_prof.phone,
      'company', case when v_company.id is null then null else jsonb_build_object(
                   'name',                v_company.company_name,
                   'commercial_register', v_company.commercial_registration_number,
                   'tax_id',              v_company.tax_id,
                   'address',             nullif(concat_ws('، ', v_company.address, v_company.city), ''))
                 end),
    'items', jsonb_build_array(jsonb_build_object(
      'description',  v_desc,
      'period_start', v_sub.start_date::date,
      'period_end',   v_sub.end_date::date,
      'quantity',     1,
      'unit_price',   v_inv.subtotal,
      'line_total',   v_inv.subtotal))
  );
end;
$$;

-- ---------- 3) إرفاق ملف الـ PDF ----------
create or replace function public.attach_accounting_invoice_pdf(
  p_ticket_id uuid,
  p_file_path text,
  p_file_url  text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author     uuid := auth.uid();
  v_inv        public.accounting_invoices;
  v_obj_meta   jsonb;
  v_obj_owner  uuid;
  v_att        public.ticket_attachments;
  v_file_name  text;
  v_base_url   text;
  v_url        text;
  v_plan_label text;
  v_message    text;
  v_reply_id   uuid;
  v_attach_id  uuid;
  v_status     text;
begin
  if v_author is null or not public.is_platform_staff() then
    raise exception 'إرفاق الفاتورة متاح للمالك والأدمن والموظفين فقط' using errcode = '42501';
  end if;

  -- الملف: داخل مجلد التذكرة نفسها، باسم invoice-…pdf، بلا مقاطع . أو ..
  if p_file_path is null
     or p_file_path !~ ('^' || p_ticket_id::text || '/invoice-[A-Za-z0-9._-]+\.pdf$')
     or p_file_path ~ '\.\.' then
    raise exception 'مسار ملف الفاتورة غير صالح' using errcode = '22023';
  end if;
  -- الرابط بالشكل العام لنفس المسار (العمود NOT NULL؛ العرض يمر بتوقيع file_path)
  if p_file_url is null
     or p_file_url !~ '^https://[A-Za-z0-9.-]+/storage/v1/object/public/tickets/'
     or p_file_url <> substring(p_file_url from '^https://[A-Za-z0-9.-]+/storage/v1/object/public/tickets/') || p_file_path then
    raise exception 'رابط ملف الفاتورة غير صالح' using errcode = '22023';
  end if;

  select o.metadata, o.owner into v_obj_meta, v_obj_owner
    from storage.objects o
   where o.bucket_id = 'tickets' and o.name = p_file_path;
  if not found then
    raise exception 'ملف الفاتورة غير موجود في التخزين' using errcode = 'P0002';
  end if;
  if coalesce(v_obj_meta->>'mimetype', '') <> 'application/pdf' then
    raise exception 'ملف الفاتورة يجب أن يكون PDF' using errcode = '22023';
  end if;
  if v_obj_owner is distinct from v_author then
    raise exception 'ملف الفاتورة لم يرفعه الحساب الحالي' using errcode = '42501';
  end if;

  -- القفل يمنع ضغطتين متزامنتين من إرفاق الفاتورة نفسها مرتين
  select * into v_inv from public.accounting_invoices
   where ticket_id = p_ticket_id
   order by created_at desc
   limit 1
   for update;
  if not found then
    raise exception 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد' using errcode = 'P0002';
  end if;

  if v_inv.attachment_id is not null then
    select * into v_att from public.ticket_attachments where id = v_inv.attachment_id;
    if found and v_att.mime_type = 'application/pdf' then
      return jsonb_build_object(
        'status',        'already_attached',
        'reply_id',      v_inv.reply_id,
        'attachment_id', v_inv.attachment_id
      );
    end if;
  end if;

  v_file_name := 'فاتورة ' || v_inv.invoice_number || '.pdf';

  -- محفّزات الرد تعدّل التذكرة، وحارس التذاكر يرفض ذلك لغير الأدمن (الدعم
  -- مثلًا) — نفس مخرج 051 بعد فحص الصلاحية.
  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  if v_inv.reply_id is null then
    v_base_url := coalesce(
      (select value->>'public_invoice_base_url' from public.advanced_settings where key = 'accounting_integration'),
      'https://mad3oom.com/invoice.html');
    v_url := v_base_url || '?t=' || v_inv.public_token;
    v_plan_label := coalesce(
      (select coalesce(name_ar, name) from public.subscription_plans where key = coalesce(v_inv.plan,
        (select s.plan from public.whatsapp_subscriptions s where s.id = v_inv.subscription_id))),
      v_inv.plan);

    v_message :=
      'تم إصدار فاتورة لهذا الطلب، ومرفقة بصيغة PDF.' || E'\n\n' ||
      'رقم الفاتورة: ' || v_inv.invoice_number || E'\n' ||
      case when v_plan_label is not null then 'الباقة: ' || v_plan_label || E'\n' else '' end ||
      'الإجمالي: ' || trim(to_char(v_inv.total, 'FM999999990.00')) || ' ' || v_inv.currency || E'\n' ||
      case when v_inv.due_date is not null
           then 'تاريخ الاستحقاق: ' || to_char(v_inv.due_date, 'YYYY-MM-DD') || E'\n' else '' end ||
      E'\n' || 'للتحقق من الفاتورة: ' || v_url;

    insert into public.ticket_replies (ticket_id, user_id, message, is_internal)
    values (p_ticket_id, v_author, v_message, false)
    returning id into v_reply_id;
    v_status := 'attached';
  else
    v_reply_id := v_inv.reply_id;
    v_status := 'upgraded';
  end if;

  if v_att.id is not null then
    -- مرفق 051 (رابط text/html) يصير ملف الـ PDF، على نفس الرد
    update public.ticket_attachments
       set file_url = p_file_url, file_path = p_file_path, file_name = v_file_name,
           file_size = nullif(v_obj_meta->>'size', '')::bigint,
           mime_type = 'application/pdf', uploaded_by = v_author
     where id = v_att.id
    returning id into v_attach_id;
  else
    insert into public.ticket_attachments (
      ticket_id, reply_id, file_url, file_path, file_name, file_size, mime_type, uploaded_by
    ) values (
      p_ticket_id, v_reply_id, p_file_url, p_file_path, v_file_name,
      nullif(v_obj_meta->>'size', '')::bigint, 'application/pdf', v_author
    ) returning id into v_attach_id;
  end if;

  update public.accounting_invoices
     set reply_id = v_reply_id, attachment_id = v_attach_id, updated_at = now()
   where id = v_inv.id;

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return jsonb_build_object(
    'status',         v_status,
    'reply_id',       v_reply_id,
    'attachment_id',  v_attach_id,
    'invoice_number', v_inv.invoice_number
  );
end;
$$;

revoke all on function public.ticket_invoice_status(uuid)                    from public, anon;
revoke all on function public.ticket_invoice_document(uuid)                  from public, anon;
revoke all on function public.attach_accounting_invoice_pdf(uuid, text, text) from public, anon;
grant execute on function public.ticket_invoice_status(uuid)                    to authenticated;
grant execute on function public.ticket_invoice_document(uuid)                  to authenticated;
grant execute on function public.attach_accounting_invoice_pdf(uuid, text, text) to authenticated;

do $$
begin
  raise notice '072: الفاتورة تُرفَق PDF كاملًا (ticket_invoice_document + attach_accounting_invoice_pdf)';
end $$;
