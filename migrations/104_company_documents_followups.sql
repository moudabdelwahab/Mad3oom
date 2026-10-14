-- ============================================================================
-- 104_company_documents_followups.sql
--   إصلاحات أمامية لـ 100 (مطبَّق في الإنتاج منذ 2026-10-14): ملف 100 لا يُعدَّل، وكل تصحيح هنا.
--   المرجع: docs/tenancy/REVIEW_FOLLOWUPS_099_100.md (100 M1، M2، L1–L7). يتطلب 103.
--
--   M1  القرار A (موثَّق في المذكرة): المستندات والحجوز القانونية تبقى بعد حذف الشركة تحت قواعد الاحتفاظ
--       والحجز، بلا مفتاح خارجي إلى companies؛ حذف حساب المالك ينجح. المراجع المحذوف: assigned_reviewer
--       يصير null (ON DELETE SET NULL) بسطر في سجل المستند.
--   M2  تحقق ذاتي أشد: كل سياسة سماح على storage.objects يجب أن يكون شرطها الأعلى bucket_id = <قيمة ثابتة>
--       (أو ANY لقائمة ثابتة) مقرونًا بـ AND — وإلا توقف الترحيل. «bucket_id = 'x' OR …» و«bucket_id IS NOT NULL»
--       يُرفضان. فحص بنية النص كما يطبعه pg_get_expr، لا فحص وصول فعلي (موثَّق في مذكرة التثبيت).
--   L1  تنزيل مالك المنصة يحتاج تحقق خطوتين حديثًا (owner_critical_ok) — أحسّ قراءة.
--   L2  المراجع ينزّل الإصدار الحالي وحده. والمراجع (مفوَّض documents.review) يحتاج جلسة aal2 مثل 103.
--   L3  بصمة sha256 لا يرسلها المستخدم: التأكيد لمفتاح الخدمة وحده (الدالة الطرفية تحسب البصمة من البايتات
--       التي رفعتها)، والتأكيد بهوية المستخدم مرفوض.
--   L4  scan_error يعود للطابور حتى 3 محاولات، ثم يبقى معزولًا.
--   L5  نتيجة الفحص تحمل nonce (التوقيع نفسه) يُقبل مرة واحدة: لا إعادة إرسال لطلب موقَّع.
--   L6  حدود الرفع: 20 إصدارًا في الساعة لكل رافع، و3 رفعات معلقة لكل مستند.
--   L7  التجربة الجافة للاحتفاظ تستثني الإصدار الحالي دائمًا (حتى المرفوض أو المصاب).
--
-- company_documents_enabled يبقى مطفأً (يرفض الترحيل إن كان مفعّلًا). لا عامل فحص ولا سر يُضبط هنا.
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/104_company_documents_followups.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.company_documents') is null then
    raise exception '104 يتطلب 100_company_documents';
  end if;
  if to_regprocedure('public._session_aal2()') is null then
    raise exception '104 يتطلب 103_admin_hierarchy_followups';
  end if;
  if exists (select 1 from public.platform_feature_switches where key = 'company_documents_enabled' and enabled) then
    raise exception '104: مفتاح المستندات مفعّل — أطفئه قبل الترحيل';
  end if;
end $$;


-- ============================================================================
-- 1) M1 — المستندات تبقى بعد حذف الشركة؛ المراجع المحذوف يُرفع إسناده
-- ============================================================================
alter table public.company_documents drop constraint if exists company_documents_company_id_fkey;
alter table public.legal_holds       drop constraint if exists legal_holds_company_id_fkey;
alter table public.company_documents drop constraint if exists company_documents_assigned_reviewer_fkey;
alter table public.company_documents
  add constraint company_documents_assigned_reviewer_fkey foreign key (assigned_reviewer)
  references public.profiles(id) on delete set null;

create or replace function public._documents_on_reviewer_deleted()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.company_document_events (company_id, document_id, version_id, actor_id, action, detail)
  select d.company_id, d.id, null, auth.uid(), 'reviewer_removed', jsonb_build_object('reviewer', old.id, 'cause', 'account_deleted')
    from public.company_documents d where d.assigned_reviewer = old.id;
  return old;
end $$;
drop trigger if exists trg_documents_reviewer_deleted on public.profiles;
create trigger trg_documents_reviewer_deleted before delete on public.profiles
  for each row execute function public._documents_on_reviewer_deleted();

create or replace function public._documents_on_company_deleted()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if exists (select 1 from public.company_documents where company_id = old.id)
     or exists (select 1 from public.legal_holds where company_id = old.id) then
    insert into public.company_document_events (company_id, document_id, version_id, actor_id, action, detail)
    values (old.id, null, null, auth.uid(), 'company_deleted',
            jsonb_build_object('documents', (select count(*) from public.company_documents where company_id = old.id),
                               'open_holds', (select count(*) from public.legal_holds where company_id = old.id and released_at is null)));
  end if;
  return old;
end $$;
drop trigger if exists trg_documents_company_deleted on public.companies;
create trigger trg_documents_company_deleted after delete on public.companies
  for each row execute function public._documents_on_company_deleted();


-- ============================================================================
-- 2) L4 + L5 — محاولات الفحص و nonce النتيجة
-- ============================================================================
alter table public.company_document_versions
  add column if not exists scan_attempts integer not null default 0 check (scan_attempts between 0 and 100);

create table if not exists public.document_scan_nonces (
  nonce   text primary key check (nonce ~ '^[0-9a-f]{64}$'),
  seen_at timestamptz not null default now()
);
alter table public.document_scan_nonces enable row level security;
revoke all on table public.document_scan_nonces from public, anon, authenticated, service_role;


-- ============================================================================
-- 3) M2 — سياسات التخزين كلها مقيّدة بالمستودع
-- ============================================================================
create or replace function public._storage_unscoped_policies()
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(array_agg(policyname order by policyname), '{}'::text[])
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and permissive = 'PERMISSIVE'
     and ((qual is null and with_check is null)
          or (qual is not null and qual !~ '^(\(\(bucket_id = (''[^'']+''::text|ANY \(ARRAY\[[^]]+\]\))\) AND .*\)|\(bucket_id = (''[^'']+''::text|ANY \(ARRAY\[[^]]+\]\))\))$')
          or (with_check is not null and with_check !~ '^(\(\(bucket_id = (''[^'']+''::text|ANY \(ARRAY\[[^]]+\]\))\) AND .*\)|\(bucket_id = (''[^'']+''::text|ANY \(ARRAY\[[^]]+\]\))\))$'));
$$;


-- ============================================================================
-- 4) الرفع: الحدود (L6) والتأكيد بمفتاح الخدمة وحده (L3)
-- ============================================================================
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
    -- L6: إعادة الإرسال بنفس المفتاح لا تُحسب؛ الإصدار الجديد يُحسب. قفل لكل رافع حتى لا يتجاوز
    -- السباقُ بين أنواع مستندات مختلفة الحدَّ.
    perform pg_advisory_xact_lock(hashtext('document_upload:' || auth.uid()::text));
    if (select count(*) from public.company_document_versions
         where uploaded_by = auth.uid() and created_at > now() - interval '1 hour') >= 20 then
      raise exception 'تجاوزت حد الرفع (20 ملفًا في الساعة)' using errcode = '54000',
        detail = '{"code":"rate_limited","reason":"hourly_limit"}';
    end if;
    if (select count(*) from public.company_document_versions
         where document_id = d.id and status = 'uploading' and created_at > now() - interval '1 day') >= 3 then
      raise exception 'رفعات معلقة كثيرة لهذا المستند' using errcode = '54000',
        detail = '{"code":"rate_limited","reason":"too_many_pending"}';
    end if;
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

-- L3: لا تأكيد بهوية المستخدم — البصمة لا تأتي من المنادي
create or replace function public.document_upload_commit(p_version uuid, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'التأكيد يتم عبر دالة الرفع وحدها — البصمة يحسبها الخادم' using errcode = '42501',
    detail = '{"code":"server_commit_only"}';
end $$;

-- التأكيد لمفتاح الخدمة (company-document-upload): الرافع الذي تحققت منه الدالة الطرفية، والبصمة التي حسبتها
-- من البايتات المرفوعة. p_sha256 = null يعيد حالة إصدار مؤكَّد سابقًا (إعادة الإرسال).
create or replace function public.document_upload_commit_server(p_version uuid, p_actor uuid, p_sha256 text)
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
  if v.id is null or p_actor is null or v.uploaded_by <> p_actor then
    raise exception 'الإصدار غير موجود' using errcode = 'P0002';
  end if;
  select * into d from public.company_documents where id = v.document_id for update;
  if public._company_staff_role_of(d.company_id, p_actor) is distinct from 'admin'
     or not exists (select 1 from public.profiles p where p.id = p_actor and coalesce(p.ban_status, 'none') = 'none') then
    raise exception 'رفع المستندات لمدير الشركة' using errcode = '42501';
  end if;
  if v.status <> 'uploading' then
    return jsonb_build_object('version_id', v.id, 'status', v.status, 'document_status', d.status);
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'بصمة sha256 مطلوبة' using errcode = '22023', detail = '{"field":"sha256"}';
  end if;
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
  update public.company_documents
     set current_version_id = v.id, status = 'pending_scan', updated_at = now()
   where id = d.id;
  insert into public.company_document_events (company_id, document_id, version_id, actor_id, action, detail)
  values (d.company_id, d.id, v.id, p_actor, 'uploaded', jsonb_build_object('sha256', p_sha256, 'sha256_by', 'server'));
  return jsonb_build_object('version_id', v.id, 'status', 'pending_scan', 'document_status', 'pending_scan');
end $$;


-- ============================================================================
-- 5) نتيجة الفحص (L4، L5)
-- ============================================================================
-- الصيغة القديمة بلا nonce لا تُقبل
create or replace function public.document_scan_result(p_version uuid, p_result text, p_engine text, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'نتيجة الفحص تحتاج nonce (document-scan-callback)' using errcode = '42501', detail = '{"code":"nonce_required"}';
end $$;

create or replace function public.document_scan_result(p_version uuid, p_result text, p_engine text, p_detail jsonb, p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.company_document_versions;
  d public.company_documents;
  v_status text := case p_result when 'clean' then 'clean' when 'infected' then 'infected' when 'error' then 'scan_error' end;
  v_inserted integer;
begin
  if v_status is null or char_length(coalesce(p_engine, '')) not between 2 and 100
     or coalesce(p_nonce, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'نتيجة فحص غير صالحة' using errcode = '22023';
  end if;
  -- L5: كل طلب موقَّع يُقبل مرة واحدة
  insert into public.document_scan_nonces (nonce) values (p_nonce) on conflict (nonce) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    raise exception 'طلب نتيجة مكرر' using errcode = '23505', detail = '{"code":"replayed"}';
  end if;
  delete from public.document_scan_nonces where seen_at < now() - interval '1 day';
  select * into v from public.company_document_versions where id = p_version for update;
  if v.id is null then
    raise exception 'الإصدار غير موجود' using errcode = 'P0002';
  end if;
  if v.status not in ('pending_scan', 'scan_error') then
    if v.status = v_status then
      return jsonb_build_object('version_id', v.id, 'status', v.status, 'changed', false);
    end if;
    raise exception 'الإصدار ليس بانتظار الفحص' using errcode = '55000';
  end if;
  -- L4: ثلاث محاولات ثم يبقى معزولًا
  if v.status = 'scan_error' and v.scan_attempts >= 3 then
    raise exception 'استُنفدت محاولات الفحص — الملف معزول' using errcode = '55000', detail = '{"reason":"scan_attempts_exhausted"}';
  end if;
  select * into d from public.company_documents where id = v.document_id for update;
  update public.company_document_versions
     set status = v_status, scanned_at = now(), scan_engine = left(p_engine, 100), scan_attempts = scan_attempts + 1,
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
                                 jsonb_build_object('result', p_result, 'engine', left(p_engine, 100), 'attempt', v.scan_attempts + 1,
                                                    'detail', coalesce(p_detail, '{}'::jsonb)));
  if v_status = 'scan_error' and v.scan_attempts + 1 >= 3 then
    perform public._document_event(d.company_id, d.id, v.id, 'scan_gave_up', jsonb_build_object('attempts', v.scan_attempts + 1));
  end if;
  return jsonb_build_object('version_id', v.id, 'status', v_status, 'changed', true);
end $$;

-- الطابور: بانتظار الفحص، ثم أخطاء الفحص التي لم تستنفد محاولاتها
create or replace function public.document_scan_queue(p_limit integer default 20)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object('version_id', v.id, 'bucket', 'company-documents', 'path', v.storage_path,
                                               'sha256', v.sha256, 'size_bytes', v.size_bytes, 'mime_type', v.mime_type,
                                               'attempt', v.scan_attempts + 1)
                            order by v.scan_attempts, v.committed_at), '[]'::jsonb)
    from (select * from public.company_document_versions
           where status = 'pending_scan' or (status = 'scan_error' and scan_attempts < 3)
           order by scan_attempts, committed_at limit least(greatest(coalesce(p_limit, 20), 1), 100)) v;
$$;


-- ============================================================================
-- 6) القراءة: المراجع (aal2) والتنزيل (L1، L2)
-- ============================================================================
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
       and public._session_aal2()
       and public._delegate_can('documents.review', public._company_unit(d.company_id)));
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
  -- L1: أحسّ قراءة — تحقق خطوتين حديث لمالك المنصة
  if v_kind = 'owner' and not coalesce(public.owner_critical_ok(), false) then
    raise exception 'التنزيل يحتاج تحققًا بخطوتين حديثًا' using errcode = '42501', detail = '{"code":"step_up_required"}';
  end if;
  -- L2: المراجع للإصدار الحالي وحده
  if v_kind = 'reviewer' and v.id is distinct from d.current_version_id then
    raise exception 'المراجع ينزّل الإصدار الحالي وحده' using errcode = '55000', detail = '{"reason":"not_current"}';
  end if;
  if v.status <> 'clean' then
    raise exception 'الملف معزول حتى اكتمال الفحص الأمني' using errcode = '55000',
      detail = jsonb_build_object('reason', v.status)::text;
  end if;
  perform public._document_event(d.company_id, d.id, v.id, 'download_authorized', jsonb_build_object('as', v_kind));
  return jsonb_build_object('bucket', 'company-documents', 'path', v.storage_path, 'expires_in', 60,
                            'file_name', coalesce(v.original_name, d.doc_type || '-v' || v.version_no));
end $$;

-- مالك المنصة: مستندات الشركات المحذوفة تظهر باسم «شركة محذوفة» (M1)
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
  return coalesce((select jsonb_agg(public._document_json(d, true)
                                    || jsonb_build_object('company_name', coalesce(c.company_name, 'شركة محذوفة'),
                                                          'company_deleted', c.id is null)
                                    order by d.updated_at desc)
                     from public.company_documents d left join public.companies c on c.id = d.company_id
                    where p_status is null or d.status = p_status), '[]'::jsonb);
end $$;


-- ============================================================================
-- 7) الحجز القانوني (M1) والتجربة الجافة (L7)
-- ============================================================================
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
  -- شركة قائمة، أو شركة محذوفة ما زالت مستنداتها محفوظة (M1)
  if not (exists (select 1 from public.companies where id = p_company)
          or exists (select 1 from public.company_documents where company_id = p_company))
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
             else 'superseded_version' end
     -- L7: الإصدار الحالي لا يُرشَّح أبدًا
     where v.id is distinct from d.current_version_id)
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


-- ============================================================================
-- 8) الصلاحيات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['public._documents_on_reviewer_deleted()', 'public._documents_on_company_deleted()',
                           'public._storage_unscoped_policies()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array['public.document_upload_commit_server(uuid,uuid,text)',
                           'public.document_scan_result(uuid,text,text,jsonb,text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;


-- ============================================================================
-- 9) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where key = 'company_documents_enabled' and enabled) then
    raise exception '104: مفتاح المستندات مفعّل';
  end if;
  -- M2: كل سياسة سماح على storage.objects مقيّدة بـ bucket_id
  if cardinality(public._storage_unscoped_policies()) > 0 then
    raise exception '104: سياسة تخزين غير مقيّدة بالمستودع: %', public._storage_unscoped_policies();
  end if;
  if exists (select 1 from storage.buckets where id = 'company-documents' and public)
     or exists (select 1 from pg_policies where schemaname = 'storage'
                 and coalesce(qual, '') || coalesce(with_check, '') like '%company-documents%') then
    raise exception '104: مستودع المستندات مفتوح';
  end if;
  if exists (select 1 from pg_constraint where contype = 'f' and confrelid = 'public.companies'::regclass
              and conrelid in ('public.company_documents'::regclass, 'public.legal_holds'::regclass)) then
    raise exception '104: ما زال مفتاح خارجي من المستندات إلى الشركات';
  end if;
  if (select confdeltype from pg_constraint where conname = 'company_documents_assigned_reviewer_fkey') <> 'n' then
    raise exception '104: حذف المراجع لا يرفع الإسناد';
  end if;
  if has_function_privilege('authenticated', 'public.document_upload_commit_server(uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.document_scan_result(uuid,text,text,jsonb,text)', 'execute') then
    raise exception '104: دالة خدمة مفتوحة للمستخدمين';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname ~ 'retention' and proname ~ '(purge|delete|cleanup)'
               and proname ~ 'document') then
    raise exception '104: دالة حذف احتفاظ — غير مسموح';
  end if;
end $$;
