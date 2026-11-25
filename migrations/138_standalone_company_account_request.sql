-- ============================================================================
-- 138_standalone_company_account_request.sql
--   مدخل مستقل لطلب حساب شركة من خارج مسار الشراء
--
-- المشكلة
--   طلب حساب الشركة (068) لا يُرسَل إلا من داخل مسار الشراء («فرد أم شركة؟»
--   عند الضغط على «اشترك الآن»). عميل يملك شركة أو متجرًا أو منصة ويريد
--   حساب شركة — بلا باقة يضغط عليها — لا مدخل له، فيضطر للشراء أولًا أو
--   للتواصل خارج المنصة. والمالك يريد الطلب أولًا ليتواصل مع العميل ويتفق
--   معه قبل أي تفعيل.
--
-- ما يضيفه هذا الترحيل
--   1) أعمدة على company_account_requests: نوع المتقدم (applicant_type:
--      company | store | platform | other) + مصدر الطلب (request_source:
--      purchase | standalone) + رابط الموقع (website_url) + مستند الإثبات
--      (الاسم/النوع/الحجم/المسار/البصمة/الرمز).
--   2) قواعد الإثبات المشروط في قيود الجدول نفسها (للطلبات المستقلة فقط،
--      فصفوف مسار الشراء القائمة لا تُمس):
--        • شركة   ⇒ مستند إثبات مرفوع، ولا رابط.
--        • متجر/منصة ⇒ رابط موقع بصيغة صالحة، ولا مستند.
--        • أخرى   ⇒ لا مستند ولا رابط.
--      فحتى نداء مباشر يتخطى الواجهة يصطدم بالقيد.
--   3) submit_standalone_company_account_request(): طلب مستقل بلا باقة.
--      يتحقق من قواعد الإثبات بالعربي، ثم ينادي submit_company_account_request
--      (068) بكل بواباته (الحساب مفعّل، ليس شركة/عضوًا، سجل فريد، طلب واحد
--      قيد المراجعة، إخطار الإدارة)، ثم يوسم الصف مستقلًا ويربط الإثبات.
--      لا يُنشئ شركة إطلاقًا — التفعيل بموافقة الإدارة وحدها (068).
--   4) رفع المستند قبل الطلب عبر مسار company-document-upload القائم:
--      المسار نفسه لا يصلح هنا كما هو — document_upload_begin (100) يشترط
--      مدير شركة قائمة (company_staff_role()='admin')، والمتقدم بلا شركة
--      أصلًا. فأُضيف بدء/تأكيد بمفتاح الطلب لا الشركة:
--        • company_account_request_proof_begin: بهوية المتقدم، يتحقق من
--          البوابة نفسها (حساب مفعّل، ليس شركة/عضوًا، بلا طلب قيد المراجعة)
--          ومن النوع/الحجم، ويولّد مسارًا في المستودع الخاص نفسه
--          (company-documents) تحت request-proofs/ — المسار من الخادم،
--          لا يختاره المتقدم.
--        • company_account_request_proof_commit_server: بمفتاح الخدمة وحده
--          (مثل 104)، يسجّل البصمة التي حسبتها الدالة الطرفية من البايتات.
--      جدول مرحلي company_account_request_proof_uploads يحمل حالة الرفع
--      (uploading/uploaded/attached) ويربط بالطلب عند الإرسال. صف مرحلي
--      بلا طلب بعده لا يفعّل شيئًا — مجرد ملف معزول في مستودع خاص.
--      حدّ أمني موثَّق: لا عامل فحص ClamAV منشور لنتائج فحص هذه المستندات
--      بعد، فتنزيل الإدارة للمراجعة مسموح للمسؤولين وحدهم برابط موقَّع
--      60 ثانية (admin_company_account_request_proof_download)؛ التوقيع
--      والنوع والحجم والبصمة تتحقق منها الدالة الطرفية قبل الحفظ.
--   5) my_company_account_request() و admin_list_company_account_requests()
--      أُعيد تعريفهما بالحقول الجديدة (فوق تعريف 118 حرفيًا + الإضافات)،
--      فيرى المالك في قائمته نوع المتقدم والرابط والمستند المرفق.
--      admin_review_company_account_request (068) لم تُلمس: الموافقة وحدها
--      تُنشئ الشركة، بنوع المنظمة الافتراضي 'company' — طلب مستقل من متجر
--      أو منصة يصير حساب شركة، وتحويله لحساب متجر يبقى بيد مالك المنصة
--      (owner_set_company_account_kind، 118)، لا برابط يذكره المتقدم.
--
-- ما لم يتغيّر (متعمّد)
--   • مسار الشراء (068/118) كما هو: دالة الإرسال القديمة بلا مساس، وصفوفها
--     مصدرها 'purchase' ونوعها الافتراضي 'company'، ولا قيد جديد يطالها.
--   • مفتاح company_documents_enabled لا يبوّب هذا المسار: مستندات الشركات
--     القائمة (100) شيء، وإثبات طلب جديد شيء آخر.
--
-- يعتمد على 068 و 118 (كلاهما مطبق على الإنتاج). قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/138_standalone_company_account_request.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  if to_regprocedure('public.submit_company_account_request(text,text,date,text,text,text,text)') is null then
    raise exception '138 يتطلب 068';
  end if;
  if to_regclass('public.company_account_requests') is null then
    raise exception '138 يتطلب جدول company_account_requests (068)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'company_account_requests'
                    and column_name = 'account_kind') then
    raise exception '138 يتطلب 118 (عمود account_kind)';
  end if;
  foreach f in array array[
    'public.account_is_active()', 'public.owns_a_company(uuid)',
    'public.belongs_to_a_company(uuid)', 'public.is_admin()',
    'public.guard_preview_read_only()'] loop
    if to_regprocedure(f) is null then
      raise exception '138 يتطلب %', f;
    end if;
  end loop;
end $$;


-- ============================================================================
-- 1) أعمدة الطلب: نوع المتقدم + المصدر + الرابط + مستند الإثبات
-- ============================================================================
alter table public.company_account_requests
  add column if not exists applicant_type       text not null default 'company',
  add column if not exists request_source       text not null default 'purchase',
  add column if not exists website_url          text,
  add column if not exists proof_document_name  text,
  add column if not exists proof_document_mime  text,
  add column if not exists proof_document_size  integer,
  add column if not exists proof_document_path  text,
  add column if not exists proof_document_sha256 text,
  add column if not exists proof_token          uuid;

comment on column public.company_account_requests.applicant_type is
  '138: نوع المتقدم. company شركة (بمستند إثبات) · store متجر إلكتروني (برابط) · platform منصة (برابط) · other أخرى (بلا إثبات).';
comment on column public.company_account_requests.request_source is
  '138: مصدر الطلب. purchase من مسار الشراء (068/118) · standalone من المدخل المستقل.';
comment on column public.company_account_requests.website_url is
  '138: رابط موقع/متجر المتقدم — إثبات نوعي store و platform بدل المستند.';
comment on column public.company_account_requests.proof_document_path is
  '138: مسار مستند الإثبات في المستودع الخاص company-documents (يولّده الخادم). لا يُقرأ مباشرةً: التنزيل برابط موقَّع عبر admin_company_account_request_proof_download.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'company_account_requests_applicant_check') then
    alter table public.company_account_requests add constraint company_account_requests_applicant_check
      check (applicant_type in ('company', 'store', 'platform', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'company_account_requests_source_check') then
    alter table public.company_account_requests add constraint company_account_requests_source_check
      check (request_source in ('purchase', 'standalone'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'company_account_requests_url_check') then
    alter table public.company_account_requests add constraint company_account_requests_url_check
      check (website_url is null
             or (char_length(website_url) <= 2048
                 and website_url ~ '^https?://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]{1,5})?(/[^[:space:]]*)?$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'company_account_requests_proof_check') then
    alter table public.company_account_requests add constraint company_account_requests_proof_check
      check ((proof_document_mime is null or proof_document_mime in ('application/pdf', 'image/png', 'image/jpeg'))
             and (proof_document_size is null or (proof_document_size between 1 and 10485760))
             and (proof_document_sha256 is null or proof_document_sha256 ~ '^[0-9a-f]{64}$'));
  end if;
  -- الإثبات المشروط — للطلبات المستقلة فقط؛ صفوف الشراء القائمة بلا قيد جديد
  if not exists (select 1 from pg_constraint where conname = 'company_account_requests_standalone_proof_check') then
    alter table public.company_account_requests add constraint company_account_requests_standalone_proof_check
      check (request_source <> 'standalone'
             or (applicant_type = 'company'
                 and proof_document_path is not null and proof_document_sha256 is not null
                 and website_url is null)
             or (applicant_type in ('store', 'platform')
                 and website_url is not null and proof_document_path is null)
             or (applicant_type = 'other'
                 and website_url is null and proof_document_path is null));
  end if;
end $$;

create index if not exists company_account_requests_applicant_source
  on public.company_account_requests (request_source, applicant_type, created_at desc);


-- ============================================================================
-- 2) جدول مرحلي لرفع مستند الإثبات قبل وجود الطلب
-- ============================================================================
create table if not exists public.company_account_request_proof_uploads (
  proof_token     uuid primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  request_id      uuid references public.company_account_requests(id) on delete set null,
  storage_path    text not null,
  file_name       text,
  mime_type       text,
  size_bytes      integer,
  sha256          text,
  status          text not null default 'uploading',
  idempotency_key uuid not null,
  created_at      timestamptz not null default now(),
  constraint company_account_request_proof_uploads_status_check
    check (status in ('uploading', 'uploaded', 'attached')),
  constraint company_account_request_proof_uploads_idempotency_unique
    unique (user_id, idempotency_key)
);

comment on table public.company_account_request_proof_uploads is
  '138: رفع مستند إثبات طلب شركة مستقل قبل إرسال الطلب (بلا شركة بعد). يُربط بالطلب عند الإرسال؛ صف بلا طلب لا يفعّل شيئًا.';

alter table public.company_account_request_proof_uploads enable row level security;

-- بلا سياسات كتابة إطلاقًا: كل كتابة عبر دوال SECURITY DEFINER أدناه
revoke all on table public.company_account_request_proof_uploads from public, anon, authenticated;
grant all on table public.company_account_request_proof_uploads to service_role;

drop trigger if exists trg_preview_read_only on public.company_account_request_proof_uploads;
create trigger trg_preview_read_only
  before insert or update or delete on public.company_account_request_proof_uploads
  for each statement execute function public.guard_preview_read_only();


-- ============================================================================
-- 3) بدء رفع الإثبات (بهوية المتقدم) + تأكيده (بمفتاح الخدمة وحده)
-- ============================================================================
create or replace function public.company_account_request_proof_begin(
  p_proof_token     uuid,
  p_mime            text,
  p_size            integer,
  p_name            text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid  uuid := auth.uid();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_row  public.company_account_request_proof_uploads%rowtype;
  v_ext  text;
  v_path text;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  -- نفس بوابة الحساب (042/066/068): حساب غير مفعّل لا يفتح طلبات
  if not public.account_is_active() then
    raise exception 'حسابك غير مفعّل بعد، فلا يمكن إرسال طلب حساب شركة' using errcode = '42501';
  end if;

  if public.owns_a_company(v_uid) then
    raise exception 'حسابك حساب شركة بالفعل';
  end if;
  if public.belongs_to_a_company(v_uid) then
    raise exception 'حسابك عضو في شركة قائمة بالفعل';
  end if;
  if exists (select 1 from public.company_account_requests
              where user_id = v_uid and status = 'pending') then
    raise exception 'لديك طلب حساب شركة قيد المراجعة بالفعل';
  end if;

  if p_proof_token is null or p_idempotency_key is null then
    raise exception 'رمز الرفع مطلوب' using errcode = '22023';
  end if;
  if p_mime is null or p_mime not in ('application/pdf', 'image/png', 'image/jpeg') then
    raise exception 'نوع ملف غير مسموح' using errcode = '22023';
  end if;
  if p_size is null or p_size < 1 or p_size > 10485760 then
    raise exception 'حجم غير مسموح' using errcode = '22023';
  end if;

  -- إعادة الإرسال بنفس مفتاح منع التكرار: نفس الملف يعيد المسار نفسه،
  -- وملف مختلف بنفس المفتاح تعارض (مثل document_upload_begin في 100)
  select * into v_row
    from public.company_account_request_proof_uploads
   where user_id = v_uid and idempotency_key = p_idempotency_key
     for update;
  if found then
    if v_row.proof_token is distinct from p_proof_token
       or v_row.mime_type is distinct from p_mime
       or v_row.size_bytes is distinct from p_size then
      raise exception 'أُرسل هذا الطلب بملف مختلف — أعد المحاولة' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'proof_token', v_row.proof_token,
      'status', v_row.status,
      'upload', jsonb_build_object('bucket', 'company-documents', 'path', v_row.storage_path, 'max_bytes', 10485760));
  end if;

  if exists (select 1 from public.company_account_request_proof_uploads
              where proof_token = p_proof_token) then
    raise exception 'رمز الرفع مستخدم بالفعل' using errcode = '23505';
  end if;
  if exists (select 1 from public.company_account_requests
              where proof_token = p_proof_token) then
    raise exception 'رمز الرفع مرتبط بطلب مرسل بالفعل' using errcode = '23505';
  end if;

  v_ext := case p_mime when 'application/pdf' then 'pdf' when 'image/png' then 'png' else 'jpg' end;
  v_path := format('request-proofs/%s/%s.%s', v_uid, p_proof_token, v_ext);

  insert into public.company_account_request_proof_uploads (
    proof_token, user_id, storage_path, file_name, mime_type, size_bytes, idempotency_key
  ) values (
    p_proof_token, v_uid, v_path, v_name, p_mime, p_size, p_idempotency_key
  )
  returning * into v_row;

  return jsonb_build_object(
    'proof_token', v_row.proof_token,
    'status', v_row.status,
    'upload', jsonb_build_object('bucket', 'company-documents', 'path', v_row.storage_path, 'max_bytes', 10485760));
end;
$function$;

comment on function public.company_account_request_proof_begin(uuid, text, integer, text, uuid) is
  '138: بدء رفع مستند إثبات طلب شركة مستقل (بهوية المتقدم). المسار يولّده الخادم في المستودع الخاص company-documents.';

revoke all on function public.company_account_request_proof_begin(uuid, text, integer, text, uuid) from public, anon;
grant execute on function public.company_account_request_proof_begin(uuid, text, integer, text, uuid) to authenticated;


create or replace function public.company_account_request_proof_commit_server(
  p_proof_token uuid,
  p_actor       uuid,
  p_sha256      text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_row public.company_account_request_proof_uploads%rowtype;
begin
  select * into v_row
    from public.company_account_request_proof_uploads
   where proof_token = p_proof_token
     for update;

  if v_row.proof_token is null or p_actor is null or v_row.user_id <> p_actor then
    raise exception 'رفع الإثبات غير موجود' using errcode = 'P0002';
  end if;

  -- إعادة تأكيد لرفع مكتمل: بلا أثر، يرجع حالته (مثل document_upload_commit_server في 104)
  if v_row.status <> 'uploading' then
    return jsonb_build_object(
      'proof_token', v_row.proof_token, 'status', v_row.status,
      'path', v_row.storage_path, 'file_name', v_row.file_name,
      'mime_type', v_row.mime_type, 'size_bytes', v_row.size_bytes, 'sha256', v_row.sha256);
  end if;

  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'بصمة sha256 مطلوبة' using errcode = '22023';
  end if;

  update public.company_account_request_proof_uploads
     set status = 'uploaded', sha256 = p_sha256
   where proof_token = p_proof_token;

  return jsonb_build_object(
    'proof_token', v_row.proof_token, 'status', 'uploaded',
    'path', v_row.storage_path, 'file_name', v_row.file_name,
    'mime_type', v_row.mime_type, 'size_bytes', v_row.size_bytes, 'sha256', p_sha256);
end;
$function$;

comment on function public.company_account_request_proof_commit_server(uuid, uuid, text) is
  '138: تأكيد رفع مستند الإثبات بالبصمة التي حسبتها الدالة الطرفية — بمفتاح الخدمة وحده (مثل 104).';

revoke all on function public.company_account_request_proof_commit_server(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.company_account_request_proof_commit_server(uuid, uuid, text) to service_role;


-- ============================================================================
-- 4) المتقدم يرسل طلبه المستقل — بلا باقة، وبلا شركة قبل الموافقة
-- ============================================================================
create or replace function public.submit_standalone_company_account_request(
  p_company_name                   text,
  p_commercial_registration_number text,
  p_commercial_registration_expiry date,
  p_company_email                  text default null,
  p_company_phone                  text default null,
  p_applicant_type                 text default 'company',
  p_website_url                    text default null,
  p_proof_token                    uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_type    text := coalesce(nullif(btrim(coalesce(p_applicant_type, '')), ''), 'company');
  v_url     text := nullif(btrim(coalesce(p_website_url, '')), '');
  v_proof   public.company_account_request_proof_uploads%rowtype;
  v_res     jsonb;
  v_req_id  uuid;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  -- الإثبات المشروط — نفس قواعد قيود الجدول، برسائل عربية قبل أي كتابة
  if v_type not in ('company', 'store', 'platform', 'other') then
    raise exception 'نوع متقدم غير معروف: %', v_type;
  end if;

  if v_type = 'company' then
    if v_url is not null then
      raise exception 'نوع «شركة» يُثبَت بمستند، لا برابط';
    end if;
    if p_proof_token is null then
      raise exception 'مستند الإثبات مطلوب — ارفع مستندًا يثبت أنها شركة';
    end if;
    select * into v_proof
      from public.company_account_request_proof_uploads
     where proof_token = p_proof_token
       for update;
    if v_proof.proof_token is null or v_proof.user_id <> v_uid then
      raise exception 'لم يكتمل رفع مستند الإثبات — أعد رفعه';
    end if;
    if v_proof.status <> 'uploaded' or v_proof.sha256 is null then
      raise exception 'لم يكتمل رفع مستند الإثبات — أعد رفعه';
    end if;
    if v_proof.request_id is not null then
      raise exception 'مستند الإثبات مرتبط بطلب مرسل بالفعل';
    end if;
  elsif v_type in ('store', 'platform') then
    if p_proof_token is not null then
      raise exception 'نوع «متجر إلكتروني» و«منصة» يُثبَت برابط، لا بمستند';
    end if;
    if v_url is null then
      raise exception 'رابط الموقع أو المتجر مطلوب';
    end if;
    if v_url !~ '^https?://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]{1,5})?(/[^[:space:]]*)?$' then
      raise exception 'رابط غير صالح — اكتب رابطًا يبدأ بـ https://';
    end if;
  else -- 'other'
    if v_url is not null or p_proof_token is not null then
      raise exception 'نوع «أخرى» لا يحتاج مستندًا ولا رابطًا';
    end if;
  end if;

  -- كل بوابات 068 (الحساب مفعّل، ليس شركة/عضوًا، السجل فريد، طلب واحد
  -- قيد المراجعة، إخطار الإدارة) + إنشاء الصف بحالة pending
  v_res := public.submit_company_account_request(
    p_company_name, p_commercial_registration_number, p_commercial_registration_expiry,
    p_company_email, p_company_phone, null, null);
  v_req_id := (v_res ->> 'id')::uuid;

  -- وسم الصف مستقلًا وربط الإثبات — في بيان واحد فيُفحص قيد الإثبات
  -- على الحالة النهائية كاملة، لا على صف ناقص
  update public.company_account_requests
     set request_source = 'standalone',
         applicant_type = v_type,
         website_url = v_url,
         proof_document_name = v_proof.file_name,
         proof_document_mime = v_proof.mime_type,
         proof_document_size = v_proof.size_bytes,
         proof_document_path = v_proof.storage_path,
         proof_document_sha256 = v_proof.sha256,
         proof_token = p_proof_token,
         updated_at = now()
   where id = v_req_id and user_id = v_uid;

  if v_type = 'company' then
    update public.company_account_request_proof_uploads
       set status = 'attached', request_id = v_req_id
     where proof_token = p_proof_token;
  end if;

  return v_res || jsonb_build_object(
    'applicant_type', v_type,
    'website_url', v_url,
    'proof_document_name', v_proof.file_name,
    'proof_document_mime', v_proof.mime_type,
    'proof_document_size', v_proof.size_bytes);
end;
$function$;

comment on function public.submit_standalone_company_account_request(text, text, date, text, text, text, text, uuid) is
  '138: طلب حساب شركة مستقل من خارج مسار الشراء (بلا باقة). إثبات مشروط بنوع المتقدم، ولا يُنشئ شركة — تنتظر موافقة الإدارة (068).';

revoke all on function public.submit_standalone_company_account_request(text, text, date, text, text, text, text, uuid) from public, anon;
grant execute on function public.submit_standalone_company_account_request(text, text, date, text, text, text, text, uuid) to authenticated;


-- ============================================================================
-- 5) آخر طلب للمنادي + قائمة الإدارة — بالحقول الجديدة (فوق تعريف 118)
-- ============================================================================
create or replace function public.my_company_account_request()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
           'id',             r.id,
           'status',         r.status,
           'company_name',   r.company_name,
           'requested_plan', r.requested_plan,
           'review_note',    r.review_note,
           'created_at',     r.created_at,
           'reviewed_at',    r.reviewed_at,
           'account_kind',   r.account_kind,
           'applicant_type', r.applicant_type,
           'request_source', r.request_source,
           'website_url',    r.website_url,
           'proof_document_name', r.proof_document_name,
           'proof_document_mime', r.proof_document_mime,
           'proof_document_size', r.proof_document_size
         )
    from public.company_account_requests r
   where auth.uid() is not null
     and r.user_id = auth.uid()
   order by (r.status = 'pending') desc, r.created_at desc
   limit 1;
$function$;

revoke all on function public.my_company_account_request() from public, anon;
grant execute on function public.my_company_account_request() to authenticated;


create or replace function public.admin_list_company_account_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(q.item order by q.r_created desc), '[]'::jsonb)
    into v_rows
    from (
      select r.created_at as r_created,
             jsonb_build_object(
               'id',                             r.id,
               'user_id',                        r.user_id,
               'customer_name',                  coalesce(nullif(btrim(p.full_name), ''), p.email),
               'customer_email',                 p.email,
               'customer_phone',                 p.phone,
               'company_name',                   r.company_name,
               'commercial_registration_number', r.commercial_registration_number,
               'commercial_registration_expiry', r.commercial_registration_expiry,
               'company_email',                  r.company_email,
               'company_phone',                  r.company_phone,
               'requested_plan',                 r.requested_plan,
               'requested_plan_name_ar',         coalesce(sp.name_ar, sp.name, r.requested_plan),
               'requested_billing_cycle',        r.requested_billing_cycle,
               'status',                         r.status,
               'review_note',                    r.review_note,
               'reviewed_at',                    r.reviewed_at,
               'reviewer_name',                  coalesce(nullif(btrim(rv.full_name), ''), rv.email),
               'company_id',                     r.company_id,
               'created_at',                     r.created_at,
               'account_kind',                   r.account_kind,
               'store_platform',                 r.store_platform,
               'store_domain_hint',              r.store_domain_hint,
               'applicant_type',                 r.applicant_type,
               'request_source',                 r.request_source,
               'website_url',                    r.website_url,
               'proof_document_name',            r.proof_document_name,
               'proof_document_mime',            r.proof_document_mime,
               'proof_document_size',            r.proof_document_size
             ) as item
        from public.company_account_requests r
        left join public.profiles p  on p.id  = r.user_id
        left join public.profiles rv on rv.id = r.reviewed_by
        left join public.subscription_plans sp on sp.key = r.requested_plan
    ) q;

  return v_rows;
end;
$function$;

revoke all on function public.admin_list_company_account_requests() from public, anon;
grant execute on function public.admin_list_company_account_requests() to authenticated;


-- ============================================================================
-- 6) الإدارة: رابط تنزيل موقَّع لمستند إثبات طلب (للمراجعة فقط)
-- ============================================================================
create or replace function public.admin_company_account_request_proof_download(
  p_request_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_req public.company_account_requests%rowtype;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select * into v_req
    from public.company_account_requests
   where id = p_request_id;

  if not found then
    raise exception 'الطلب غير موجود' using errcode = 'P0002';
  end if;
  if v_req.proof_document_path is null then
    raise exception 'هذا الطلب بلا مستند إثبات' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'bucket', 'company-documents',
    'path', v_req.proof_document_path,
    'file_name', v_req.proof_document_name);
end;
$function$;

comment on function public.admin_company_account_request_proof_download(uuid) is
  '138: تفويض تنزيل مستند إثبات طلب شركة (للإدارة فقط) — الدالة الطرفية توقّع الرابط 60 ثانية للمسار المعاد وحده.';

revoke all on function public.admin_company_account_request_proof_download(uuid) from public, anon;
grant execute on function public.admin_company_account_request_proof_download(uuid) to authenticated;


-- ============================================================================
-- 7) تحقّق بَعدي
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.submit_standalone_company_account_request(text,text,date,text,text,text,text,uuid)',
    'public.company_account_request_proof_begin(uuid,text,integer,text,uuid)',
    'public.company_account_request_proof_commit_server(uuid,uuid,text)',
    'public.admin_company_account_request_proof_download(uuid)'] loop
    if to_regprocedure(f) is null then
      raise exception '138: الدالة % غير موجودة بعد التطبيق', f;
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'company_account_requests_standalone_proof_check') then
    raise exception '138: قيد الإثبات المشروط غير موجود';
  end if;
  if exists (select 1 from pg_policy
              where polrelid = 'public.company_account_request_proof_uploads'::regclass) then
    raise exception '138: سياسة على جدول الرفع المرحلي — الكتابة عبر الدوال فقط';
  end if;
  raise notice '138: المدخل المستقل لطلب حساب الشركة جاهز — الإثبات مشروط بنوع المتقدم، والتفعيل بموافقة الإدارة وحدها';
end $$;
