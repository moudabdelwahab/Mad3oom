-- ============================================================================
-- 100_company_documents.sql
--   DOC — مستندات الشركات: السجل التجاري، خطاب التفويض، إثبات التعاقد، البطاقة الضريبية.
--
-- القرارات: السؤال 12–15 (نظام مستندات؛ حقوق المالك عليها؛ أمان رفع متدرّج: pending_scan وحدود
--   ClamAV؛ احتفاظ قابل للضبط وحجز قانوني — تجربة جافة فقط). أمر التنفيذ §H–J والقيم الافتراضية 9 و10:
--   لا فحص يُدّعى قبل وجود عامل فحص حقيقي؛ الملف معزول حتى نتيجة فحص موقَّعة؛ لا حذف احتفاظ فعلي.
--
-- المسار
--   1. مدير الشركة (والمفتاح company_documents_enabled مفعّل): document_upload_begin بهويته ⇒ إصدار
--      جديد «uploading» ومسار يولّده الخادم في مستودع خاص (company-documents)، ثم الدالة الطرفية
--      company-document-upload تتحقق من التوقيع والحجم الفعلي وتحسب sha256 وترفع بمفتاح الخدمة،
--      ثم document_upload_commit بهويته ⇒ «pending_scan».
--   2. عامل الفحص (ClamAV — غير منشور) يرسل نتيجة موقَّعة HMAC إلى document-scan-callback ⇒
--      document_scan_result (مفتاح الخدمة وحده) ⇒ clean | infected | error. بلا عامل: يبقى كل شيء معزولًا.
--   3. التنزيل: document_download_authorize بهوية المنادي (مدير الشركة، مالك المنصة، أو المراجع المسند
--      إليه بتفويض documents.review) وللإصدار النظيف فقط، مع سطر في السجل؛ ثم رابط موقَّع 60 ثانية.
--   4. المراجعة: مالك المنصة أو المراجع المسند (لا يراجع رافع الملف نفسه)، للإصدار النظيف الحالي فقط.
--      التصحيح إصدار جديد؛ المحتوى لا يُعدَّل أبدًا. بيانات المالك الإدارية تُعدَّل بسجل قبل/بعد.
--   5. الاحتفاظ: سياسات قابلة للضبط (غير معتمدة قانونيًا)، حجز قانوني، وتجربة جافة تُقرير ما «كان
--      سيُحذف». لا دالة حذف في هذا الترحيل إطلاقًا.
--
-- المستودع company-documents خاص وبلا أي سياسة على storage.objects: لا قراءة ولا كتابة لأي دور من
-- المتصفح؛ مفتاح الخدمة وحده عبر الدوال الطرفية بعد قرار القاعدة.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/100_company_documents.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._feature_on(text)', 'public.owner_critical_ok()', 'public.owner_capability(text)',
    'public.company_staff_role()', 'public.current_company_id()', 'public._delegate_can(text,uuid)',
    'public._company_unit(uuid)', 'public._hierarchy_eligible(uuid)', 'public._reason_check(text)'] loop
    if to_regprocedure(f) is null then
      raise exception '100 يتطلب % (099_admin_hierarchy وما قبله)', f;
    end if;
  end loop;
end $$;

insert into public.platform_feature_switches (key, enabled, description) values
  ('company_documents_enabled', false, 'رفع مستندات الشركات ومراجعتها وتنزيلها (100). الفحص يحتاج عاملًا منشورًا.')
on conflict (key) do nothing;

-- مستودع خاص بلا أي سياسة: لا وصول من المتصفح إطلاقًا
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-documents', 'company-documents', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;


-- ============================================================================
-- 1) الكتالوجات
-- ============================================================================
create table if not exists public.document_types (
  key           text primary key,
  label_ar      text not null,
  has_expiry    boolean not null,
  allowed_mime  text[] not null,
  max_bytes     integer not null check (max_bytes between 1 and 10485760),
  sort          integer not null
);
insert into public.document_types (key, label_ar, has_expiry, allowed_mime, max_bytes, sort) values
  ('commercial_registration', 'السجل التجاري',       true,  array['application/pdf', 'image/png', 'image/jpeg'], 10485760, 10),
  ('authorization_letter',    'خطاب التفويض',         true,  array['application/pdf', 'image/png', 'image/jpeg'], 10485760, 20),
  ('contract_proof',          'إثبات التعاقد',        false, array['application/pdf', 'image/png', 'image/jpeg'], 10485760, 30),
  ('tax_card',                'البطاقة الضريبية',     true,  array['application/pdf', 'image/png', 'image/jpeg'], 10485760, 40)
on conflict (key) do nothing;

-- القيمة الافتراضية 1: كتالوج قابل للضبط، ونوع واحد مدعوم بوضوح اليوم.
create table if not exists public.company_kinds (
  key      text primary key check (key ~ '^[a-z][a-z_]{2,40}$'),
  label_ar text not null
);
insert into public.company_kinds (key, label_ar) values ('company', 'شركة') on conflict (key) do nothing;

create table if not exists public.company_kind_assignments (
  company_id  uuid primary key references public.companies(id) on delete cascade,
  kind        text not null references public.company_kinds(key),
  assigned_by uuid,
  assigned_at timestamptz not null default now()
);

create table if not exists public.document_requirements (
  company_kind text not null references public.company_kinds(key),
  doc_type     text not null references public.document_types(key),
  required     boolean not null,
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  primary key (company_kind, doc_type)
);
insert into public.document_requirements (company_kind, doc_type, required) values
  ('company', 'commercial_registration', true), ('company', 'tax_card', true),
  ('company', 'authorization_letter', false), ('company', 'contract_proof', false)
on conflict (company_kind, doc_type) do nothing;


-- ============================================================================
-- 2) المستندات والإصدارات والسجل
-- ============================================================================
create table if not exists public.company_documents (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  doc_type           text not null references public.document_types(key),
  status             text not null default 'pending_scan'
                       check (status in ('pending_scan', 'pending_review', 'approved', 'rejected', 'expired')),
  current_version_id uuid,
  expires_on         date,
  metadata           jsonb not null default '{}'::jsonb,
  assigned_reviewer  uuid references public.profiles(id),
  assigned_unit      uuid references public.admin_units(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, doc_type)
);

create table if not exists public.company_document_versions (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.company_documents(id) on delete cascade,
  version_no      integer not null,
  idempotency_key uuid not null,
  status          text not null default 'uploading'
                    check (status in ('uploading', 'pending_scan', 'clean', 'infected', 'scan_error')),
  storage_path    text not null unique,
  mime_type       text not null,
  size_bytes      integer not null check (size_bytes between 1 and 10485760),
  sha256          text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  original_name   text check (original_name is null or char_length(original_name) <= 200),
  uploaded_by     uuid not null,
  created_at      timestamptz not null default now(),
  committed_at    timestamptz,
  scanned_at      timestamptz,
  scan_engine     text,
  review_status   text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_note     text check (review_note is null or char_length(review_note) <= 1000),
  unique (document_id, version_no),
  unique (document_id, idempotency_key)
);

create table if not exists public.company_document_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  company_id  uuid not null,
  document_id uuid,
  version_id  uuid,
  actor_id    uuid,
  action      text not null,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists company_document_events_doc on public.company_document_events (document_id, at desc);

create table if not exists public.legal_holds (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  document_id uuid references public.company_documents(id),
  reason      text not null,
  placed_by   uuid not null,
  placed_at   timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid,
  release_reason text
);

-- القيمة الافتراضية 9: مدد مقترحة غير معتمدة قانونيًا؛ لا حذف قبل مراجعة قانونية وموافقة صريحة.
create table if not exists public.document_retention_policies (
  key               text primary key,
  applies_to        text not null check (applies_to in ('superseded_version', 'rejected_version', 'infected_version', 'abandoned_upload')),
  retain_days       integer not null check (retain_days between 1 and 36500),
  legally_approved  boolean not null default false,
  note_ar           text not null,
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);
insert into public.document_retention_policies (key, applies_to, retain_days, note_ar) values
  ('superseded', 'superseded_version', 1825, 'مقترح غير معتمد: 5 سنوات للإصدارات المستبدلة.'),
  ('rejected',   'rejected_version',   365,  'مقترح غير معتمد: سنة للإصدارات المرفوضة.'),
  ('infected',   'infected_version',   30,   'مقترح غير معتمد: 30 يومًا للملفات المصابة (معزولة).'),
  ('abandoned',  'abandoned_upload',   2,    'مقترح غير معتمد: يومان للرفع غير المكتمل.')
on conflict (key) do nothing;

create table if not exists public.retention_runs (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid,
  dry_run    boolean not null check (dry_run),
  as_of      date not null,
  candidates integer not null,
  held       integer not null,
  summary    jsonb not null
);

do $$
declare t text;
begin
  foreach t in array array['document_types', 'company_kinds', 'company_kind_assignments', 'document_requirements',
                           'company_documents', 'company_document_versions', 'company_document_events', 'legal_holds',
                           'document_retention_policies', 'retention_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all
                      using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;

-- السجلات إلحاقية؛ المحتوى والهوية في الإصدار لا يتغيران؛ لا حذف للمستند ولا للإصدار.
create or replace function public._documents_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'سجل المستندات إلحاقي — لا تعديل ولا حذف' using errcode = '23514';
end $$;
do $$
declare t text;
begin
  foreach t in array array['company_document_events', 'retention_runs'] loop
    execute format('drop trigger if exists trg_documents_append_only on public.%I', t);
    execute format('create trigger trg_documents_append_only before update or delete on public.%I
                      for each row execute function public._documents_append_only()', t);
    execute format('drop trigger if exists trg_documents_no_truncate on public.%I', t);
    execute format('create trigger trg_documents_no_truncate before truncate on public.%I
                      for each statement execute function public._documents_append_only()', t);
  end loop;
  foreach t in array array['company_documents', 'company_document_versions', 'legal_holds'] loop
    execute format('drop trigger if exists trg_documents_no_delete on public.%I', t);
    execute format('create trigger trg_documents_no_delete before delete on public.%I
                      for each row execute function public._documents_append_only()', t);
  end loop;
end $$;

create or replace function public._document_version_guard()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.document_id <> old.document_id or new.version_no <> old.version_no
     or new.storage_path <> old.storage_path or new.mime_type <> old.mime_type or new.size_bytes <> old.size_bytes
     or new.uploaded_by <> old.uploaded_by or new.idempotency_key <> old.idempotency_key
     or (old.sha256 is not null and new.sha256 is distinct from old.sha256) then
    raise exception 'محتوى الإصدار وهويته لا يتغيران — التصحيح إصدار جديد' using errcode = '23514';
  end if;
  -- انتقالات الفحص: uploading ← pending_scan ← (clean|infected|scan_error)؛ نتيجة الفحص نهائية
  if new.status is distinct from old.status and not (
       (old.status = 'uploading' and new.status = 'pending_scan')
    or (old.status = 'pending_scan' and new.status in ('clean', 'infected', 'scan_error'))
    or (old.status = 'scan_error' and new.status in ('clean', 'infected'))) then
    raise exception 'انتقال فحص غير مسموح' using errcode = '55000';
  end if;
  if old.review_status <> 'pending' and new.review_status is distinct from old.review_status then
    raise exception 'قرار المراجعة نهائي — إصدار جديد للتصحيح' using errcode = '55000';
  end if;
  return new;
end $$;
drop trigger if exists trg_document_version_guard on public.company_document_versions;
create trigger trg_document_version_guard before update on public.company_document_versions
  for each row execute function public._document_version_guard();

do $$
declare f text;
begin
  foreach f in array array['public._documents_append_only()', 'public._document_version_guard()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 3) أدوات داخلية
-- ============================================================================
create or replace function public._document_event(p_company uuid, p_document uuid, p_version uuid, p_action text,
                                                  p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into public.company_document_events (company_id, document_id, version_id, actor_id, action, detail)
  values (p_company, p_document, p_version, auth.uid(), p_action, coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function public._documents_require_enabled()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._feature_on('company_documents_enabled') then
    raise exception 'مستندات الشركات غير مفعّلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
end $$;

-- المراجع المسند: إسناد بالاسم (أو لوحدة تضم المنادي بتفويض)، وتفويض documents.review يغطي وحدة الشركة.
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

create or replace function public._document_reader_kind(p_document uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when coalesce(public.owner_capability('owner_only'), false) then 'owner'
    when exists (select 1 from public.company_documents d
                  where d.id = p_document and d.company_id = public.current_company_id()
                    and public.company_staff_role() = 'admin') then 'company_admin'
    when public._document_reviewer_ok(p_document, auth.uid()) then 'reviewer'
  end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public._document_event(uuid,uuid,uuid,text,jsonb)', 'public._documents_require_enabled()',
                           'public._document_reviewer_ok(uuid,uuid)', 'public._document_reader_kind(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 4) الرفع: begin ← (الدالة الطرفية ترفع) ← commit
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


-- ============================================================================
-- 5) نتيجة الفحص — مفتاح الخدمة وحده (عبر document-scan-callback بعد تحقق التوقيع)
-- ============================================================================
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
revoke all on function public.document_scan_result(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.document_scan_result(uuid, text, text, jsonb) to service_role;


-- طابور الفحص لعامل الفحص (مفتاح الخدمة وحده): المسارات بانتظار الفحص، الأقدم أولًا.
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
revoke all on function public.document_scan_queue(integer) from public, anon, authenticated;
grant execute on function public.document_scan_queue(integer) to service_role;


-- ============================================================================
-- 6) التنزيل — قرار + سجل، ثم رابط موقَّع قصير من الدالة الطرفية
-- ============================================================================
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


-- ============================================================================
-- 7) القوائم
-- ============================================================================
create or replace function public._document_json(d public.company_documents, p_include_history boolean)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', d.id, 'company_id', d.company_id, 'doc_type', d.doc_type,
    'label', (select label_ar from public.document_types where key = d.doc_type),
    'status', d.status, 'expires_on', d.expires_on, 'metadata', d.metadata, 'updated_at', d.updated_at,
    'assigned_reviewer', d.assigned_reviewer, 'assigned_unit', d.assigned_unit,
    'versions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', v.id, 'version_no', v.version_no, 'status', v.status, 'mime_type', v.mime_type, 'size_bytes', v.size_bytes,
        'sha256', v.sha256, 'original_name', v.original_name, 'created_at', v.created_at,
        'review_status', v.review_status, 'review_note', v.review_note, 'reviewed_at', v.reviewed_at,
        'is_current', v.id = d.current_version_id) order by v.version_no desc)
        from public.company_document_versions v
       where v.document_id = d.id and (p_include_history or v.id = d.current_version_id)), '[]'::jsonb));
$$;
revoke all on function public._document_json(public.company_documents, boolean) from public, anon, authenticated;

-- مدير الشركة: مستنداته ومتطلبات نوع شركته (المفقود منها ظاهر)
create or replace function public.company_documents_mine()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public.current_company_id();
  v_kind    text;
begin
  if public.company_staff_role() is distinct from 'admin' then
    return null;
  end if;
  v_kind := coalesce((select kind from public.company_kind_assignments where company_id = v_company), 'company');
  return jsonb_build_object(
    'enabled', public._feature_on('company_documents_enabled'),
    'kind', v_kind,
    'requirements', coalesce((select jsonb_agg(jsonb_build_object(
        'doc_type', t.key, 'label', t.label_ar, 'has_expiry', t.has_expiry, 'allowed_mime', t.allowed_mime,
        'max_bytes', t.max_bytes, 'required', coalesce(r.required, false),
        'status', coalesce((select d.status from public.company_documents d where d.company_id = v_company and d.doc_type = t.key), 'missing'))
        order by t.sort)
        from public.document_types t left join public.document_requirements r on r.doc_type = t.key and r.company_kind = v_kind), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(public._document_json(d, true) order by d.doc_type)
                             from public.company_documents d where d.company_id = v_company), '[]'::jsonb));
end $$;

-- مالك المنصة: الطابور كله
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

-- المراجع: المسندة إليه فقط (إصداره الحالي وحده)
create or replace function public.reviewer_documents()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(public._document_json(d, false) || jsonb_build_object('company_name', c.company_name)
                            order by d.updated_at desc), '[]'::jsonb)
    from public.company_documents d join public.companies c on c.id = d.company_id
   where public._feature_on('company_documents_enabled') and public._document_reviewer_ok(d.id, auth.uid());
$$;


-- ============================================================================
-- 8) الإسناد والمراجعة والبيانات الإدارية والانتهاء
-- ============================================================================
create or replace function public.owner_assign_document_reviewer(p_document uuid, p_reviewer uuid, p_unit uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  d public.company_documents;
begin
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  select * into d from public.company_documents where id = p_document for update;
  if d.id is null then
    raise exception 'المستند غير موجود' using errcode = 'P0002';
  end if;
  -- المراجع بالاسم: من طاقم المنصة المفصول، وتفويضه documents.review يغطي وحدة الشركة
  if p_reviewer is not null and not (
       public._hierarchy_eligible(p_reviewer)
       and exists (select 1 from public.platform_delegations g
                    where g.delegate_id = p_reviewer and g.revoked_at is null
                      and (g.expires_at is null or g.expires_at > now())
                      and 'documents.review' = any (g.capabilities)
                      and public._company_unit(d.company_id) in (select public._unit_subtree(g.unit_id)))) then
    raise exception 'المراجع يحتاج تفويض مراجعة المستندات على وحدة هذه الشركة' using errcode = '22023';
  end if;
  if p_unit is not null and not (public._company_unit(d.company_id) in (select public._unit_subtree(p_unit))) then
    raise exception 'الوحدة لا تضم هذه الشركة' using errcode = '22023';
  end if;
  update public.company_documents set assigned_reviewer = p_reviewer, assigned_unit = p_unit, updated_at = now() where id = d.id;
  perform public._document_event(d.company_id, d.id, null, 'reviewer_assigned',
                                 jsonb_build_object('reviewer', p_reviewer, 'unit', p_unit, 'previous_reviewer', d.assigned_reviewer,
                                                    'previous_unit', d.assigned_unit, 'reason', v_reason));
  return jsonb_build_object('document_id', d.id, 'assigned_reviewer', p_reviewer, 'assigned_unit', p_unit);
end $$;

create or replace function public.document_review(p_version uuid, p_approve boolean, p_note text, p_expires_on date default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.company_document_versions;
  d public.company_documents;
  v_owner boolean := coalesce(public.owner_critical_ok(), false);
begin
  perform public._documents_require_enabled();
  select * into v from public.company_document_versions where id = p_version for update;
  select * into d from public.company_documents where id = v.document_id for update;
  if d.id is null or not (v_owner or public._document_reviewer_ok(d.id, auth.uid())) then
    raise exception 'المستند غير موجود أو غير مسند إليك' using errcode = 'P0002';
  end if;
  if p_approve is null or (not p_approve and char_length(btrim(coalesce(p_note, ''))) < 10) then
    raise exception 'القرار مطلوب، والرفض بسبب واضح' using errcode = '22023';
  end if;
  if v.id <> d.current_version_id then
    raise exception 'المراجعة للإصدار الحالي فقط' using errcode = '55000';
  end if;
  if v.status <> 'clean' then
    raise exception 'لا مراجعة قبل نتيجة فحص نظيفة' using errcode = '55000', detail = jsonb_build_object('reason', v.status)::text;
  end if;
  if v.uploaded_by = auth.uid() then
    raise exception 'لا يراجع رافع الملف ملفه' using errcode = '42501';
  end if;
  if v.review_status <> 'pending' then
    raise exception 'تمت مراجعة هذا الإصدار' using errcode = '55000';
  end if;
  if p_approve and (select has_expiry from public.document_types where key = d.doc_type) and p_expires_on is null then
    raise exception 'تاريخ الانتهاء مطلوب لهذا النوع' using errcode = '22023', detail = '{"field":"expires_on"}';
  end if;
  update public.company_document_versions
     set review_status = case when p_approve then 'approved' else 'rejected' end,
         reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v.id;
  update public.company_documents
     set status = case when p_approve then 'approved' else 'rejected' end,
         expires_on = case when p_approve then p_expires_on else expires_on end, updated_at = now()
   where id = d.id;
  perform public._document_event(d.company_id, d.id, v.id, case when p_approve then 'approved' else 'rejected' end,
                                 jsonb_build_object('note', p_note, 'expires_on', p_expires_on, 'as', case when v_owner then 'owner' else 'reviewer' end));
  insert into public.notifications (user_id, title, message, type, category)
  select c.user_id, case when p_approve then 'تم اعتماد مستند' else 'رُفض مستند' end,
         (select label_ar from public.document_types where key = d.doc_type)
           || case when p_approve then ' معتمد.' else ': ' || coalesce(nullif(btrim(p_note), ''), 'راجع الملاحظات وارفع إصدارًا جديدًا.') end,
         case when p_approve then 'success' else 'error' end, 'account'
    from public.companies c where c.id = d.company_id;
  return jsonb_build_object('document_id', d.id, 'status', case when p_approve then 'approved' else 'rejected' end);
end $$;

-- بيانات المالك الإدارية: مفاتيح محددة، بسجل قبل/بعد. الملف لا يتغير.
create or replace function public.owner_document_metadata(p_document uuid, p_metadata jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  d public.company_documents;
  v_new jsonb;
begin
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_metadata) k where k not in ('number', 'issuer', 'issued_on', 'expires_on', 'notes')) then
    raise exception 'مفاتيح البيانات المسموحة: number, issuer, issued_on, expires_on, notes' using errcode = '22023';
  end if;
  select * into d from public.company_documents where id = p_document for update;
  if d.id is null then
    raise exception 'المستند غير موجود' using errcode = 'P0002';
  end if;
  v_new := d.metadata || p_metadata;
  update public.company_documents
     set metadata = v_new,
         expires_on = case when p_metadata ? 'expires_on' then (p_metadata ->> 'expires_on')::date else expires_on end,
         updated_at = now()
   where id = d.id;
  perform public._document_event(d.company_id, d.id, null, 'metadata_changed',
                                 jsonb_build_object('old', d.metadata, 'new', v_new, 'reason', v_reason));
  return jsonb_build_object('document_id', d.id, 'metadata', v_new);
end $$;

-- الانتهاء (يُجدوَل لاحقًا بقرار): المعتمد المنتهي ← expired؛ وتنبيه مرة واحدة قبل 30 يومًا.
create or replace function public.document_expiry_scan(p_today date default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'Africa/Cairo')::date);
  v_expired integer := 0;
  v_notices integer := 0;
  r record;
begin
  if not (coalesce(public.owner_capability('owner_only'), false)
          or (auth.uid() is null and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'service_role') = 'service_role')) then
    raise exception 'لمالك المنصة أو مفتاح الخدمة' using errcode = '42501';
  end if;
  for r in select d.*, c.user_id as owner_id from public.company_documents d join public.companies c on c.id = d.company_id
            where d.status = 'approved' and d.expires_on is not null and d.expires_on < v_today for update of d loop
    update public.company_documents set status = 'expired', updated_at = now() where id = r.id;
    perform public._document_event(r.company_id, r.id, r.current_version_id, 'expired', jsonb_build_object('expires_on', r.expires_on));
    insert into public.notifications (user_id, title, message, type, category)
    values (r.owner_id, 'انتهى مستند', (select label_ar from public.document_types where key = r.doc_type) || ' منتهي — ارفع إصدارًا جديدًا.', 'error', 'account');
    v_expired := v_expired + 1;
  end loop;
  for r in select d.*, c.user_id as owner_id from public.company_documents d join public.companies c on c.id = d.company_id
            where d.status = 'approved' and d.expires_on between v_today and v_today + 30
              and not exists (select 1 from public.company_document_events e
                               where e.document_id = d.id and e.action = 'expiry_notice'
                                 and e.detail ->> 'expires_on' = d.expires_on::text) loop
    perform public._document_event(r.company_id, r.id, r.current_version_id, 'expiry_notice', jsonb_build_object('expires_on', r.expires_on));
    insert into public.notifications (user_id, title, message, type, category)
    values (r.owner_id, 'مستند يقترب من الانتهاء',
            (select label_ar from public.document_types where key = r.doc_type) || ' ينتهي في ' || r.expires_on || '.', 'warning', 'account');
    v_notices := v_notices + 1;
  end loop;
  return jsonb_build_object('expired', v_expired, 'notices', v_notices, 'as_of', v_today);
end $$;


-- ============================================================================
-- 9) الحجز القانوني والاحتفاظ (تجربة جافة فقط)
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
  if not exists (select 1 from public.companies where id = p_company)
     or (p_document is not null and not exists (select 1 from public.company_documents where id = p_document and company_id = p_company)) then
    raise exception 'الشركة أو المستند غير موجود' using errcode = 'P0002';
  end if;
  insert into public.legal_holds (company_id, document_id, reason, placed_by) values (p_company, p_document, v_reason, auth.uid())
  returning id into v_id;
  perform public._document_event(p_company, p_document, null, 'legal_hold_set', jsonb_build_object('hold_id', v_id, 'reason', v_reason));
  return jsonb_build_object('hold_id', v_id);
end $$;

create or replace function public.owner_legal_hold_release(p_hold uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  h public.legal_holds;
begin
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  update public.legal_holds set released_at = now(), released_by = auth.uid(), release_reason = v_reason
   where id = p_hold and released_at is null returning * into h;
  if h.id is null then
    raise exception 'الحجز غير موجود أو مرفوع' using errcode = 'P0002';
  end if;
  perform public._document_event(h.company_id, h.document_id, null, 'legal_hold_released', jsonb_build_object('hold_id', h.id, 'reason', v_reason));
  return jsonb_build_object('hold_id', h.id, 'released', true);
end $$;

-- تجربة جافة: ما كان سيُحذف تحت السياسات الحالية، مع استثناء الحجز القانوني والإصدار الحالي.
-- لا حذف هنا ولا في أي دالة أخرى. كل تشغيل يُسجَّل (retention_runs، إلحاقي).
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

create or replace function public.owner_set_document_requirement(p_kind text, p_doc_type text, p_required boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
begin
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  if p_required is null or not exists (select 1 from public.company_kinds where key = p_kind)
     or not exists (select 1 from public.document_types where key = p_doc_type) then
    raise exception 'نوع شركة أو مستند غير معروف' using errcode = '22023';
  end if;
  insert into public.document_requirements (company_kind, doc_type, required, updated_by)
  values (p_kind, p_doc_type, p_required, auth.uid())
  on conflict (company_kind, doc_type) do update set required = excluded.required, updated_by = excluded.updated_by, updated_at = now();
  perform public.log_privileged('documents.requirement', null, null,
                                jsonb_build_object('kind', p_kind, 'doc_type', p_doc_type, 'required', p_required, 'reason', v_reason));
  return jsonb_build_object('kind', p_kind, 'doc_type', p_doc_type, 'required', p_required);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.document_upload_begin(text,text,integer,text,uuid)', 'public.document_upload_commit(uuid,text)',
                           'public.document_download_authorize(uuid)', 'public.company_documents_mine()',
                           'public.owner_documents_queue(text)', 'public.reviewer_documents()',
                           'public.owner_assign_document_reviewer(uuid,uuid,uuid,text)',
                           'public.document_review(uuid,boolean,text,date)', 'public.owner_document_metadata(uuid,jsonb,text)',
                           'public.owner_legal_hold_set(uuid,uuid,text)', 'public.owner_legal_hold_release(uuid,text)',
                           'public.owner_retention_dry_run(date)', 'public.owner_set_document_requirement(text,text,boolean,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  revoke all on function public.document_expiry_scan(date) from public, anon;
  grant execute on function public.document_expiry_scan(date) to authenticated, service_role;
end $$;


-- ============================================================================
-- 10) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where enabled) then
    raise exception '100: مفتاح مفعّل بعد الترحيل — يجب أن تكون كلها مطفأة';
  end if;
  if exists (select 1 from storage.buckets where id = 'company-documents' and public) then
    raise exception '100: مستودع المستندات عام';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage'
              and coalesce(qual, '') || coalesce(with_check, '') like '%company-documents%') then
    raise exception '100: سياسة تخزين تفتح مستودع المستندات';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname ~ 'retention' and proname ~ '(purge|delete|cleanup)'
               and proname ~ 'document') then
    raise exception '100: دالة حذف احتفاظ — غير مسموح في هذه المرحلة';
  end if;
end $$;
