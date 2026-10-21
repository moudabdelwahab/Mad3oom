-- ============================================================================
-- 111_billing_ticket_isolation.sql — فواتير المحاسبة وطلبات الاشتراك لا تعبر إلى تذكرة شركة (I1، I2)
--   docs/tenancy/ISOLATION_VERIFICATION_2026-10-21.md §4، tests/sql/tenant-isolation-matrix.test.sql
--
--   I1 دوال فواتير طاقم المنصة (ticket_invoice_status و ticket_invoice_document و attach_accounting_invoice
--      و attach_accounting_invoice_pdf) بامتياز المالك وبلا فحص عزل: مع company_isolation_enforced كان الأدمن
--      يقرأ رقم تذكرة الشركة وبيانات فاتورتها ويكتب ردًا ومرفقًا علنيين داخلها. الآن تذكرة الشركة مع العزل
--      «بلا فاتورة» لطاقم المنصة، بنفس رد الغياب (097).
--   I2 مصدر الفاتورة على تذكرة شركة: request_subscription_purchase كان يقبل تذكرة المنادي بأي نطاق، و
--      request_subscription_upgrade كان يقبل أي تذكرة لأي حساب (مالك الشركة ب يربط ترقيته بتذكرة عميل أ،
--      فتُرفق فاتورته داخل تذكرة أ بعد المزامنة — عبور بين الشركات مستقل عن مفتاح العزل). الآن التذكرة
--      المرتبطة تخص المنادي وهي تذكرة لفريق مدعوم. المسار الفعلي (submit_subscription_*) ينشئ تذكرة
--      category = subscription فيختمها a_ticket_scope_stamp لمدعوم دائمًا، فلا يتغير.
--   وصفوف accounting_invoices تأخذ سياسة العزل التقييدية نفسها لجداول التذكرة الفرعية (097).
--
-- لا مفتاح ولا بيانات تتغير. الصلاحيات كما هي (create or replace). قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/111_billing_ticket_isolation.down.sql
-- ============================================================================
do $$
begin
  if to_regprocedure('public._ticket_private_to_company(uuid)') is null
     or to_regprocedure('public.request_subscription_upgrade(text,uuid,text,text)') is null
     or to_regprocedure('public.attach_accounting_invoice_pdf(uuid,text,text)') is null then
    raise exception '111 يتطلب 097 ودوال الفواتير وطلبات الاشتراك';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.request_subscription_purchase(p_plan text, p_billing_cycle text, p_ticket_id uuid DEFAULT NULL::uuid, p_is_renewal boolean DEFAULT false, p_payment_method text DEFAULT NULL::text, p_payment_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid        uuid := auth.uid();
  v_check      jsonb;
  v_days       int;
  v_prev_end   timestamptz := null;
  v_start      timestamptz := now();
  v_row        public.whatsapp_subscriptions%rowtype;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  if p_plan is null or not exists (
       select 1 from public.subscription_plans where key = p_plan and is_active) then
    raise exception 'باقة غير معروفة أو غير مفعّلة' using errcode = '22023';
  end if;

  if p_billing_cycle is null or p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'دورة فوترة غير صالحة' using errcode = '22023';
  end if;

  if p_payment_method is not null
     and p_payment_method not in ('bank_transfer', 'cash_wallet', 'instapay', 'gateway') then
    raise exception 'وسيلة دفع غير صالحة' using errcode = '22023';
  end if;

  -- التذكرة لا تُقبل إلا إذا كانت تخص المنادي، وهي تذكرة لفريق مدعوم (111: الفوترة الشخصية لمدعوم، السؤال 10).
  if p_ticket_id is not null and not exists (
       select 1 from public.tickets where id = p_ticket_id and user_id = v_uid and scope = 'mad3oom_support') then
    raise exception 'التذكرة غير موجودة أو لا تخص حسابك' using errcode = '42501';
  end if;

  -- طلب معلّق لنفس الباقة
  if exists (
       select 1 from public.whatsapp_subscriptions
        where user_id = v_uid and plan = p_plan and status = 'pending') then
    raise exception 'لديك بالفعل طلب في هذه الباقة قيد المراجعة. انتظر رد فريق الدعم قبل إرسال طلب جديد.'
      using errcode = '42501';
  end if;

  v_check := public.subscription_purchase_check(p_plan, p_is_renewal, v_uid);
  if not (v_check->>'allowed')::boolean then
    raise exception '%', v_check->>'reason' using errcode = '42501';
  end if;

  v_days := case when p_billing_cycle = 'yearly' then 365 else 30 end;

  if p_is_renewal then
    select max(end_date) into v_prev_end
      from public.whatsapp_subscriptions
     where user_id = v_uid and plan = p_plan
       and status = 'active' and end_date > now();
  end if;

  insert into public.whatsapp_subscriptions (
    user_id, ticket_id, plan, billing_cycle,
    start_date, end_date, status, is_renewal,
    duration_days, previous_end_date, payment_method, payment_reference
  ) values (
    v_uid, p_ticket_id, p_plan, p_billing_cycle,
    v_start, v_start + make_interval(days => v_days), 'pending', coalesce(p_is_renewal, false),
    v_days, v_prev_end, p_payment_method,
    nullif(btrim(coalesce(p_payment_reference, '')), '')
  )
  returning * into v_row;

  return jsonb_build_object(
    'subscription_id', v_row.id,
    'status',          v_row.status,
    'plan',            v_row.plan,
    'billing_cycle',   v_row.billing_cycle,
    'is_renewal',      v_row.is_renewal,
    'previous_end_date', v_row.previous_end_date
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.request_subscription_upgrade(p_plan text, p_ticket_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT NULL::text, p_payment_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid(); v_quote jsonb; v_cur_id uuid;
  v_new public.whatsapp_subscriptions%rowtype; v_cur public.whatsapp_subscriptions%rowtype;
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501'; end if;
  -- 111: كالشراء — التذكرة المرتبطة تخص المنادي وهي تذكرة لفريق مدعوم (كانت تُقبل أي تذكرة لأي حساب)
  if p_ticket_id is not null and not exists (
       select 1 from public.tickets where id = p_ticket_id and user_id = v_uid and scope = 'mad3oom_support') then
    raise exception 'التذكرة غير موجودة أو لا تخص حسابك' using errcode = '42501';
  end if;
  v_quote := public.subscription_upgrade_quote(p_plan);
  if (v_quote->>'eligible')::boolean is not true then
    raise exception 'لا يمكن ترقية اشتراكك إلى هذه الباقة (%).', coalesce(v_quote->>'code', 'unknown');
  end if;

  v_cur_id := (v_quote->'current'->>'subscription_id')::uuid;
  select * into v_cur from public.whatsapp_subscriptions where id = v_cur_id for update;
  if v_cur.status <> 'active' or v_cur.end_date <= now() then
    raise exception 'الاشتراك الحالي لم يعد صالحًا للترقية';
  end if;

  insert into public.whatsapp_subscriptions (
    user_id, ticket_id, plan, status, billing_cycle, start_date, end_date, duration_days,
    payment_method, payment_reference,
    upgraded_from_subscription_id, upgrade_amount, price_snapshot, company_id
  ) values (
    v_uid, p_ticket_id, p_plan, 'pending', v_cur.billing_cycle,
    v_cur.start_date, v_cur.end_date, v_cur.duration_days,
    nullif(btrim(coalesce(p_payment_method, '')), ''),
    nullif(btrim(coalesce(p_payment_reference, '')), ''),
    v_cur.id, (v_quote->>'amount_due')::numeric,
    jsonb_build_object('quoted_at', now(),
      'from_plan', v_quote->'current'->>'plan', 'from_price', (v_quote->'current'->>'price')::numeric,
      'to_plan', p_plan, 'to_price', (v_quote->'target'->>'price')::numeric,
      'billing_cycle', v_cur.billing_cycle,
      'remaining_days', (v_quote->>'remaining_days')::int, 'cycle_days', (v_quote->>'cycle_days')::int,
      'price_difference', (v_quote->>'price_difference')::numeric,
      'amount_due', (v_quote->>'amount_due')::numeric, 'currency', v_quote->>'currency'),
    v_cur.company_id
  ) returning * into v_new;

  return jsonb_build_object('subscription_id', v_new.id, 'amount_due', v_new.upgrade_amount,
    'currency', v_quote->>'currency', 'quote', v_quote);
end;
$function$;

CREATE OR REPLACE FUNCTION public.ticket_invoice_status(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_inv public.accounting_invoices;
begin
  if not public.is_platform_staff() then
    raise exception 'حالة الفاتورة متاحة لطاقم المنصة فقط' using errcode = '42501';
  end if;
  -- 111: مع العزل تذكرة الشركة «بلا فاتورة» لطاقم المنصة (نفس رد الغياب، فلا كاشف)
  if public._ticket_private_to_company(p_ticket_id) then
    return jsonb_build_object('state', 'none', 'has_pdf', false);
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
$function$;

CREATE OR REPLACE FUNCTION public.ticket_invoice_document(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- 111: مع العزل تذكرة الشركة «بلا فاتورة» لطاقم المنصة (نفس رد الغياب، فلا كاشف)
  if public._ticket_private_to_company(p_ticket_id) then
    raise exception 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد' using errcode = 'P0002';
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
$function$;

CREATE OR REPLACE FUNCTION public.attach_accounting_invoice(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- 111: مع العزل تذكرة الشركة «بلا فاتورة» لطاقم المنصة (نفس رد الغياب، فلا كاشف)
  if public._ticket_private_to_company(p_ticket_id) then
    raise exception 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد' using errcode = 'P0002';
  end if;

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
$function$;

CREATE OR REPLACE FUNCTION public.attach_accounting_invoice_pdf(p_ticket_id uuid, p_file_path text, p_file_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- 111: مع العزل تذكرة الشركة «بلا فاتورة» لطاقم المنصة (نفس رد الغياب، فلا كاشف)
  if public._ticket_private_to_company(p_ticket_id) then
    raise exception 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد' using errcode = 'P0002';
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
$function$;

-- صفوف الفواتير: نفس سياسة العزل التقييدية لجداول التذكرة الفرعية (097). صاحب الفاتورة يرى فاتورته لأنه يرى
-- تذكرته؛ فاتورة بلا تذكرة لا تتأثر.
drop policy if exists tenant_isolation on public.accounting_invoices;
create policy tenant_isolation on public.accounting_invoices as restrictive for all
  using (not (select public._isolation_on()) or ticket_id is null or public._ticket_id_visible(ticket_id))
  with check (not (select public._isolation_on()) or ticket_id is null or public._ticket_id_visible(ticket_id));

-- التحقق
do $$
declare f text;
begin
  foreach f in array array['public.ticket_invoice_status(uuid)', 'public.ticket_invoice_document(uuid)',
                           'public.attach_accounting_invoice(uuid)', 'public.attach_accounting_invoice_pdf(uuid,text,text)'] loop
    if position('_ticket_private_to_company(p_ticket_id)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '111: % بلا فحص العزل', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '111: % متاحة لـ anon', f; end if;
  end loop;
  foreach f in array array['public.request_subscription_purchase(text,text,uuid,boolean,text,text)', 'public.request_subscription_upgrade(text,uuid,text,text)'] loop
    if position('scope = ''mad3oom_support''' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '111: % تقبل تذكرة خارج مدعوم', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '111: % متاحة لـ anon', f; end if;
  end loop;
  if not exists (select 1 from pg_policy where polrelid = 'public.accounting_invoices'::regclass
                  and polname = 'tenant_isolation' and not polpermissive) then
    raise exception '111: سياسة العزل على accounting_invoices غائبة';
  end if;
end $$;
