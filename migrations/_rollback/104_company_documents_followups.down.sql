-- ============================================================================
-- التراجع عن 104_company_documents_followups — يعيد دوال 100 التسع حرفيًا (منسوخة من ملف 100)، ويحذف
-- دالة التأكيد بمفتاح الخدمة وصيغة النتيجة بالـ nonce وجدولها وعمود المحاولات والمحفّزين، ويعيد المفاتيح
-- الخارجية كما كانت.
--
-- الترتيب: 104 أولًا (قبل 103 و100). يُشغَّل في معاملة واحدة:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/104_company_documents_followups.down.sql
-- يرفض (قبل أي تغيير) إن كان مفتاح المستندات مفعّلًا، أو بقيت مستندات أو حجوز لشركة محذوفة (المفتاح الخارجي
-- لا يعود عليها، والمستندات لا تُحذف بتراجع).
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where key = 'company_documents_enabled' and enabled) then
    raise exception 'التراجع عن 104 مرفوض: مفتاح المستندات مفعّل — أطفئه أولًا';
  end if;
  if exists (select 1 from public.company_documents d where not exists (select 1 from public.companies c where c.id = d.company_id))
     or exists (select 1 from public.legal_holds h where not exists (select 1 from public.companies c where c.id = h.company_id)) then
    raise exception 'التراجع عن 104 مرفوض: مستندات أو حجوز لشركة محذوفة — لا يعود المفتاح الخارجي عليها';
  end if;
end $$;

drop trigger if exists trg_documents_reviewer_deleted on public.profiles;
drop trigger if exists trg_documents_company_deleted on public.companies;
drop function if exists public.document_upload_commit_server(uuid, uuid, text);
drop function if exists public.document_scan_result(uuid, text, text, jsonb, text);

-- دوال 100 حرفيًا

create or replace function public._document_reviewer_ok(p_document uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.company_documents d
     where d.id = p_document
       and (d.assigned_reviewer = p_user
            or (d.assigned_unit is not null and exists (
                  select 1 from public.platform_delegations g
                   where g.delegate_id = p_user and g.revoked_at is null
                     and (g.expires_at is null or g.expires_at > now())
                     and 'documents.review' = any (g.capabilities)
                     and d.assigned_unit in (select public._unit_subtree(g.unit_id)))))
       and p_user = auth.uid()
       and public._delegate_can('documents.review', public._company_unit(d.company_id)));
$$;

create or replace function public.document_upload_begin(p_doc_type text, p_mime text, p_size integer, p_name text,
                                                         p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  t   public.document_types;
  d   public.company_documents;
  v   public.company_document_versions;
  v_ext text;
begin
  perform public._documents_require_enabled();
  if public.company_staff_role() is distinct from 'admin' then
    raise exception 'رفع المستندات لمدير الشركة' using errcode = '42501';
  end if;
  v_company := public.current_company_id();
  select * into t from public.document_types where key = p_doc_type;
  if t.key is null then
    raise exception 'نوع مستند غير معروف' using errcode = '22023', detail = '{"field":"doc_type"}';
  end if;
  if p_mime is null or not (p_mime = any (t.allowed_mime)) then
    raise exception 'نوع ملف غير مسموح' using errcode = '22023', detail = '{"field":"mime"}';
  end if;
  if p_size is null or p_size < 1 or p_size > t.max_bytes then
    raise exception 'حجم غير مسموح' using errcode = '22023', detail = '{"field":"size","reason":"too_large"}';
  end if;
  if p_idempotency_key is null then
    raise exception 'مفتاح منع التكرار مطلوب' using errcode = '22023', detail = '{"field":"idempotency_key"}';
  end if;

  insert into public.company_documents (company_id, doc_type) values (v_company, p_doc_type)
  on conflict (company_id, doc_type) do nothing;
  select * into d from public.company_documents where company_id = v_company and doc_type = p_doc_type for update;

  select * into v from public.company_document_versions where document_id = d.id and idempotency_key = p_idempotency_key;
  if v.id is null then
    v_ext := case p_mime when 'application/pdf' then 'pdf' when 'image/png' then 'png' else 'jpg' end;
    insert into public.company_document_versions (document_id, version_no, idempotency_key, storage_path, mime_type,
                                                  size_bytes, original_name, uploaded_by)
    values (d.id, coalesce((select max(version_no) from public.company_document_versions where document_id = d.id), 0) + 1,
            p_idempotency_key,
            v_company || '/' || d.id || '/' || gen_random_uuid() || '.' || v_ext,
            p_mime, p_size, left(nullif(regexp_replace(coalesce(p_name, ''), '[^[:alnum:][:space:]._-]', '', 'g'), ''), 200),
            auth.uid())
    returning * into v;
    perform public._document_event(v_company, d.id, v.id, 'upload_started',
                                   jsonb_build_object('version_no', v.version_no, 'mime', p_mime, 'size', p_size));
  elsif v.mime_type <> p_mime or v.size_bytes <> p_size then
    raise exception 'مفتاح منع التكرار لملف مختلف' using errcode = '23505';
  end if;
  return jsonb_build_object(
    'version', jsonb_build_object('id', v.id, 'status', v.status, 'version_no', v.version_no),
    'upload', jsonb_build_object('bucket', 'company-documents', 'path', v.storage_path, 'max_bytes', t.max_bytes));
end $$;

create or replace function public.document_upload_commit(p_version uuid, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.company_document_versions;
  d public.company_documents;
  o record;
begin
  perform public._documents_require_enabled();
  select * into v from public.company_document_versions where id = p_version for update;
  if v.id is null or v.uploaded_by <> auth.uid() then
    raise exception 'الإصدار غير موجود' using errcode = 'P0002';
  end if;
  select * into d from public.company_documents where id = v.document_id for update;
  if v.status <> 'uploading' then
    return jsonb_build_object('version_id', v.id, 'status', v.status, 'document_status', d.status);
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'بصمة sha256 مطلوبة' using errcode = '22023', detail = '{"field":"sha256"}';
  end if;
  -- الملف المخزَّن نفسه: موجود في المسار المولَّد وبالحجم المعلن (الدالة الطرفية تحققت من التوقيع والبصمة)
  select * into o from storage.objects where bucket_id = 'company-documents' and name = v.storage_path;
  if o is null then
    raise exception 'الملف غير موجود في المستودع' using errcode = '55000', detail = '{"reason":"object_missing"}';
  end if;
  if o.metadata ? 'size' and (o.metadata ->> 'size')::bigint <> v.size_bytes then
    raise exception 'حجم الملف المخزَّن لا يطابق المعلن' using errcode = '22023', detail = '{"field":"size","reason":"size_mismatch"}';
  end if;
  update public.company_document_versions
     set status = 'pending_scan', sha256 = p_sha256, committed_at = now()
   where id = v.id;
  -- الإصدار الأحدث هو الحالي؛ يُعزل حتى نتيجة فحص موقَّعة
  update public.company_documents
     set current_version_id = v.id, status = 'pending_scan', updated_at = now()
   where id = d.id;
  perform public._document_event(d.company_id, d.id, v.id, 'uploaded', jsonb_build_object('sha256', p_sha256));
  return jsonb_build_object('version_id', v.id, 'status', 'pending_scan', 'document_status', 'pending_scan');
end $$;

create or replace function public.document_scan_result(p_version uuid, p_result text, p_engine text, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.company_document_versions;
  d public.company_documents;
  v_status text := case p_result when 'clean' then 'clean' when 'infected' then 'infected' when 'error' then 'scan_error' end;
begin
  if v_status is null or char_length(coalesce(p_engine, '')) not between 2 and 100 then
    raise exception 'نتيجة فحص غير صالحة' using errcode = '22023';
  end if;
  select * into v from public.company_document_versions where id = p_version for update;
  if v.id is null then
    raise exception 'الإصدار غير موجود' using errcode = 'P0002';
  end if;
  if v.status not in ('pending_scan', 'scan_error') then
    -- إعادة إرسال النتيجة نفسها بلا أثر؛ غيرها مرفوض (النتيجة نهائية)
    if v.status = v_status then
      return jsonb_build_object('version_id', v.id, 'status', v.status, 'changed', false);
    end if;
    raise exception 'الإصدار ليس بانتظار الفحص' using errcode = '55000';
  end if;
  select * into d from public.company_documents where id = v.document_id for update;
  update public.company_document_versions
     set status = v_status, scanned_at = now(), scan_engine = left(p_engine, 100),
         review_status = case when v_status = 'infected' then 'rejected' else review_status end,
         review_note = case when v_status = 'infected' then 'ملف مصاب — مرفوض آليًا' else review_note end,
         reviewed_at = case when v_status = 'infected' then now() else reviewed_at end
   where id = v.id;
  if d.current_version_id = v.id then
    update public.company_documents
       set status = case v_status when 'clean' then 'pending_review' when 'infected' then 'rejected' else 'pending_scan' end,
           updated_at = now()
     where id = d.id;
  end if;
  perform public._document_event(d.company_id, d.id, v.id, 'scan_result',
                                 jsonb_build_object('result', p_result, 'engine', left(p_engine, 100), 'detail', coalesce(p_detail, '{}'::jsonb)));
  return jsonb_build_object('version_id', v.id, 'status', v_status, 'changed', true);
end $$;

create or replace function public.document_scan_queue(p_limit integer default 20)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object('version_id', v.id, 'bucket', 'company-documents', 'path', v.storage_path,
                                               'sha256', v.sha256, 'size_bytes', v.size_bytes, 'mime_type', v.mime_type)
                            order by v.committed_at), '[]'::jsonb)
    from (select * from public.company_document_versions
           where status = 'pending_scan' order by committed_at limit least(greatest(coalesce(p_limit, 20), 1), 100)) v;
$$;

create or replace function public.document_download_authorize(p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.company_document_versions;
  d public.company_documents;
  v_kind text;
begin
  perform public._documents_require_enabled();
  select * into v from public.company_document_versions where id = p_version;
  select * into d from public.company_documents where id = v.document_id;
  v_kind := case when d.id is null then null else public._document_reader_kind(d.id) end;
  if v_kind is null then
    raise exception 'المستند غير موجود' using errcode = 'P0002';
  end if;
  -- معزول حتى نتيجة فحص نظيفة — لكل أحد، حتى مالك المنصة (الفشل مغلق)
  if v.status <> 'clean' then
    raise exception 'الملف معزول حتى اكتمال الفحص الأمني' using errcode = '55000',
      detail = jsonb_build_object('reason', v.status)::text;
  end if;
  perform public._document_event(d.company_id, d.id, v.id, 'download_authorized', jsonb_build_object('as', v_kind));
  return jsonb_build_object('bucket', 'company-documents', 'path', v.storage_path, 'expires_in', 60,
                            'file_name', coalesce(v.original_name, d.doc_type || '-v' || v.version_no));
end $$;

create or replace function public.owner_documents_queue(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(public._document_json(d, true) || jsonb_build_object('company_name', c.company_name)
                                    order by d.updated_at desc)
                     from public.company_documents d join public.companies c on c.id = d.company_id
                    where p_status is null or d.status = p_status), '[]'::jsonb);
end $$;

create or replace function public.owner_legal_hold_set(p_company uuid, p_document uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  v_id uuid;
begin
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  if not exists (select 1 from public.companies where id = p_company)
     or (p_document is not null and not exists (select 1 from public.company_documents where id = p_document and company_id = p_company)) then
    raise exception 'الشركة أو المستند غير موجود' using errcode = 'P0002';
  end if;
  insert into public.legal_holds (company_id, document_id, reason, placed_by) values (p_company, p_document, v_reason, auth.uid())
  returning id into v_id;
  perform public._document_event(p_company, p_document, null, 'legal_hold_set', jsonb_build_object('hold_id', v_id, 'reason', v_reason));
  return jsonb_build_object('hold_id', v_id);
end $$;

create or replace function public.owner_retention_dry_run(p_as_of date default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Africa/Cairo')::date);
  v_rows jsonb;
  v_held integer;
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  with c as (
    select v.id as version_id, d.company_id, d.id as document_id, d.doc_type, v.version_no, v.status, v.review_status,
           p.key as policy, p.retain_days, p.legally_approved,
           (v_as_of - (coalesce(v.reviewed_at, v.scanned_at, v.committed_at, v.created_at) at time zone 'Africa/Cairo')::date) as age_days,
           exists (select 1 from public.legal_holds h where h.released_at is null and h.company_id = d.company_id
                     and (h.document_id is null or h.document_id = d.id)) as held
      from public.company_document_versions v
      join public.company_documents d on d.id = v.document_id
      join public.document_retention_policies p on p.applies_to = case
             when v.status = 'infected' then 'infected_version'
             when v.status = 'uploading' then 'abandoned_upload'
             when v.review_status = 'rejected' then 'rejected_version'
             when v.id <> d.current_version_id then 'superseded_version' end
     where v.id <> d.current_version_id or v.status in ('infected', 'uploading') or v.review_status = 'rejected')
  select coalesce(jsonb_agg(jsonb_build_object('version_id', version_id, 'company_id', company_id, 'document_id', document_id,
                                               'doc_type', doc_type, 'version_no', version_no, 'policy', policy,
                                               'age_days', age_days, 'retain_days', retain_days, 'held', held,
                                               'legally_approved', legally_approved) order by age_days desc)
                    filter (where age_days > retain_days), '[]'::jsonb),
         count(*) filter (where age_days > retain_days and held)
    into v_rows, v_held
    from c;
  insert into public.retention_runs (actor_id, dry_run, as_of, candidates, held, summary)
  values (auth.uid(), true, v_as_of, jsonb_array_length(v_rows), v_held, jsonb_build_object('candidates', v_rows));
  return jsonb_build_object('dry_run', true, 'as_of', v_as_of, 'would_delete',
                            (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(v_rows) x where not (x ->> 'held')::boolean),
                            'held', v_held,
                            'note', 'تجربة جافة: لا حذف. المدد غير معتمدة قانونيًا.');
end $$;

drop function if exists public._documents_on_reviewer_deleted();
drop function if exists public._documents_on_company_deleted();
drop function if exists public._storage_unscoped_policies();
drop table if exists public.document_scan_nonces;
alter table public.company_document_versions drop column if exists scan_attempts;

alter table public.company_documents drop constraint if exists company_documents_assigned_reviewer_fkey;
alter table public.company_documents
  add constraint company_documents_assigned_reviewer_fkey foreign key (assigned_reviewer) references public.profiles(id);
alter table public.company_documents
  add constraint company_documents_company_id_fkey foreign key (company_id) references public.companies(id) on delete cascade;
alter table public.legal_holds
  add constraint legal_holds_company_id_fkey foreign key (company_id) references public.companies(id) on delete cascade;
