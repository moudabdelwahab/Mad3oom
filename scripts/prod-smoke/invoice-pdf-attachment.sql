-- ============================================================================
-- 072 — فحص Production بعد التثبيت: فاتورة #1121 الحقيقية، كأدمن وكصاحبها
--
-- كتلة DO واحدة بتنتهي دايمًا بـ RAISE ⇒ المعاملة كلها بترجع، ومفيش أي ملف
-- بيتكتب في التخزين (الإرفاق الفعلي بيتجرّب من الزر).
-- متوقع: بيانات الفاتورة الكاملة للأدمن (الرقم، الإجمالي، البند وفترته، العميل،
-- رابط التحقق)؛ الحالة attached و has_pdf=false (مرفقة كرابط من 051)؛ ملف مش
-- موجود ⇒ P0002، مجلد تذكرة تانية ⇒ 22023، والعميل ⇒ 42501 للاتنين.
-- اتشغّل على Production يوم 2026-10-09 13:39 UTC ⇒ PASS/PASS/PASS.
-- ============================================================================
do $smoke$
declare
  ad uuid; cu uuid; tk uuid; d jsonb; st jsonb; r text := ''; e1 text; e2 text; e3 text; e4 text;
begin
  select ai.ticket_id, t.user_id into tk, cu from public.accounting_invoices ai join public.tickets t on t.id = ai.ticket_id
   where ai.invoice_number = 'INV-FY2026/27-0001';
  select id into ad from public.profiles where role = 'admin' order by created_at limit 1;

  perform set_config('request.jwt.claim.sub', ad::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  d  := public.ticket_invoice_document(tk);
  st := public.ticket_invoice_status(tk);
  begin perform public.attach_accounting_invoice_pdf(tk, tk::text || '/invoice-smoke-missing.pdf',
          'https://srnelrdpqkcntbgudyto.supabase.co/storage/v1/object/public/tickets/' || tk::text || '/invoice-smoke-missing.pdf'); e1 := 'ok';
  exception when others then e1 := sqlstate; end;
  begin perform public.attach_accounting_invoice_pdf(tk, 'other/invoice-x.pdf', 'https://x.supabase.co/storage/v1/object/public/tickets/other/invoice-x.pdf'); e2 := 'ok';
  exception when others then e2 := sqlstate; end;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub', cu::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', cu, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin perform public.ticket_invoice_document(tk); e3 := 'ok'; exception when others then e3 := sqlstate; end;
  begin perform public.attach_accounting_invoice_pdf(tk, tk::text || '/invoice-a.pdf',
          'https://srnelrdpqkcntbgudyto.supabase.co/storage/v1/object/public/tickets/' || tk::text || '/invoice-a.pdf'); e4 := 'ok';
  exception when others then e4 := sqlstate; end;
  execute 'reset role';

  r := r || E'\n' || case when d->>'invoice_number' = 'INV-FY2026/27-0001' and (d->>'total')::numeric = 9999 and d->>'currency' = 'EGP'
                              and d->'items'->0->>'description' like 'اشتراك %' and d->'items'->0->>'period_start' is not null
                              and d->'customer'->>'name' is not null and d->>'public_url' like 'https://%?t=%' and (d->>'ticket_number')::int = 1121
                         then 'PASS' else 'FAIL' end
       || format(' DOC #%s %s %s %s | item=%s %s→%s | customer=%s company=%s',
                 d->>'ticket_number', d->>'invoice_number', d->>'total', d->>'currency',
                 d->'items'->0->>'description', d->'items'->0->>'period_start', d->'items'->0->>'period_end',
                 case when d->'customer'->>'name' is not null then 'yes' else 'no' end, d->'customer'->'company' is not null and d->'customer'->'company' <> 'null'::jsonb);
  r := r || E'\n' || case when st->>'state' = 'attached' and st->>'has_pdf' = 'false' then 'PASS' else 'FAIL' end
       || format(' STATUS state=%s has_pdf=%s (رابط 051 ⇒ الزر هيعرض «إرفاق نسخة PDF»)', st->>'state', st->>'has_pdf');
  r := r || E'\n' || case when e1 = 'P0002' and e2 = '22023' and e3 = '42501' and e4 = '42501' then 'PASS' else 'FAIL' end
       || format(' GUARDS missing-file=%s other-folder=%s customer-doc=%s customer-attach=%s', e1, e2, e3, e4);
  raise exception 'SMOKE_072_RESULT:%', r;
end
$smoke$;
