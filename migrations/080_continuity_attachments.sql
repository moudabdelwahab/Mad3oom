-- ============================================================================
-- 080_continuity_attachments.sql
--   مدعوم — الاستمرارية: مرفقات السجل (صور، فيديو، صوت)
--   (docs/relay/CONTINUITY_ARCHITECTURE_PROPOSAL.md §15.3، القرارات S1–S5 بالتوصية)
--
-- طلب المالك 2026-10-12: «Images: 3 MiB, Videos: 16 MiB, Audio: 8 MiB … server-side
--   size/MIME/signature validation; private storage; signed URLs; lifecycle/retention».
--
-- ما يضيفه
--   • مستودع خاص continuity-attachments (public=false، 16 MiB، قائمة أنواع مغلقة).
--     لا سياسة INSERT/UPDATE/DELETE للمستخدمين: الملف يدخل فقط عبر دالة الرفع
--     (Edge Function continuity-attachment-upload) بعد فحص التوقيع. القراءة سياسة
--     SELECT تنادي _continuity_attachment_readable(name).
--   • continuity_attachments: صف لكل مرفق. المسار يولّده الخادم
--     (<workspace>/<record>/<attachment>) ولا يؤخذ من المستخدم.
--     الحالات: pending → active → removed ⇄ active، و purged / redacted / abandoned نهائية.
--   • الدوال (لـ authenticated): continuity_attachment_begin / _commit / _remove /
--     _restore / _purge، و _continuity_attachment_readable لسياسة القراءة.
--   • continuity_attachment_sweep (pg_cron كل ساعة): pending أقدم من ساعة ⇒ abandoned؛
--     انتهاء الاحتفاظ (365 يومًا بعد الإغلاق، C5) ⇒ redacted؛ ويسجّل اختفاء الملف فعلًا.
--   • continuity_attachment_deletion_queue (لـ service_role فقط — استثناء موثّق): قائمة
--     المسارات التي تحذفها فعليًا دالة التنظيف (Edge Function continuity-attachment-cleanup)
--     عبر Storage API. حذف صف storage.objects بـ SQL لا يحذف الملف.
--   • _continuity_capability_attachments(): علامة التثبيت. القدرة نفسها تظل مطفأة
--     (attachments_enabled = false من 078) حتى قرار منفصل.
--
-- يعيد تعريف
--   _continuity_full   يضيف attachments و removed_attachments (فقط والقدرة مفعّلة،
--                      وليس بعد انتهاء الاحتفاظ). نص 079 حرفيًا فيما عدا ذلك.
--
-- مفتاح الإيقاف: attachments_enabled = false ⇒ لا رفع ولا قراءة (السياسة ترفض) ولا عرض.
--
-- لا يلمس: chat_* أو inbox_* أو tickets أو أي مستودع آخر، ولا سياسات storage الحالية.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/080_continuity_attachments.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات (079)
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._continuity_full(uuid, boolean)', 'public._continuity_lock_for_write(uuid, integer)',
    'public._continuity_log(uuid, uuid, text, jsonb, text)', 'public._continuity_validation(text, text)',
    'public._continuity_guard_append_only()', 'public._continuity_effective_capabilities()',
    'public._continuity_capability_installed(text)', 'public._continuity_guard_closure()',
    'public._continuity_retention_expired(timestamp with time zone, integer)'] loop
    if to_regprocedure(f) is null then
      raise exception '080 يتطلب 079 (%)', f;
    end if;
  end loop;
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise exception '080 يتطلب Supabase Storage';
  end if;
end $$;


-- ============================================================================
-- 1) القواعد (مصدر واحد في القاعدة؛ نفسها في assets/js/continuity/continuity-media.js)
-- ============================================================================
create or replace function public._continuity_attachment_max(p_kind text)
returns bigint language sql immutable set search_path to 'public' as $$
  select case p_kind when 'image' then 3145728 when 'video' then 16777216 when 'audio' then 8388608 end::bigint;
$$;

create or replace function public._continuity_attachment_mime_ok(p_kind text, p_mime text)
returns boolean language sql immutable set search_path to 'public' as $$
  select coalesce(case p_kind
    when 'image' then p_mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
    when 'video' then p_mime in ('video/mp4', 'video/webm', 'video/quicktime')
    when 'audio' then p_mime in ('audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav')
  end, false);
$$;

-- اسم العرض: آخر جزء من المسار، بلا محارف تحكم أو اتجاه، 200 حرف. ⇒ نص أو null.
create or replace function public._continuity_attachment_name(p text)
returns text language sql immutable set search_path to 'public' as $$
  select nullif(left(btrim(regexp_replace(
           regexp_replace(coalesce(p, ''), '^.*[/\\]', ''),
           '[\u0001-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', '', 'g')), 200), '');
$$;


-- ============================================================================
-- 2) المستودع
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('continuity-attachments', 'continuity-attachments', false, 16777216,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif',
              'video/mp4', 'video/webm', 'video/quicktime',
              'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav'])
on conflict (id) do update
   set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;


-- ============================================================================
-- 3) الجدول
-- ============================================================================
create table if not exists public.continuity_attachments (
  id                  uuid primary key default gen_random_uuid(),
  record_id           uuid not null references public.continuity_records(id),
  workspace_id        uuid not null references public.continuity_workspaces(id),
  kind                text not null check (kind in ('image', 'video', 'audio')),
  mime                text not null,
  declared_size       bigint not null,
  size_bytes          bigint,
  sha256              text check (sha256 ~ '^[0-9a-f]{64}$'),
  display_name        text check (char_length(display_name) between 1 and 200),
  storage_path        text not null,
  status              text not null default 'pending'
                      check (status in ('pending', 'active', 'removed', 'purged', 'redacted', 'abandoned')),
  idempotency_key     uuid not null,
  -- حذف حساب الموظف يُبقي المرفق بفاعل فارغ (نفس قاعدة 079).
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  committed_at        timestamptz,
  removed_at          timestamptz,
  removed_by          uuid references public.profiles(id) on delete set null,
  purged_at           timestamptz,
  purged_by           uuid references public.profiles(id) on delete set null,
  redacted_at         timestamptz,
  abandoned_at        timestamptz,
  delete_requested_at timestamptz,
  object_deleted_at   timestamptz,
  constraint continuity_attachments_path unique (storage_path),
  constraint continuity_attachments_idem unique (created_by, idempotency_key),
  constraint continuity_attachments_path_shape check (storage_path = workspace_id::text || '/' || record_id::text || '/' || id::text),
  constraint continuity_attachments_kind_rules check (
    public._continuity_attachment_mime_ok(kind, mime)
    and declared_size > 0 and declared_size <= public._continuity_attachment_max(kind)
    and (size_bytes is null or (size_bytes = declared_size))),
  constraint continuity_attachments_state check (
    case status
      when 'pending'   then committed_at is null and size_bytes is null and removed_at is null and purged_at is null
                            and redacted_at is null and abandoned_at is null and delete_requested_at is null
      when 'active'    then committed_at is not null and size_bytes is not null and sha256 is not null and removed_at is null
                            and purged_at is null and redacted_at is null and delete_requested_at is null
      when 'removed'   then committed_at is not null and removed_at is not null and purged_at is null and redacted_at is null
                            and delete_requested_at is null
      when 'purged'    then purged_at is not null and display_name is null and delete_requested_at is not null
      when 'redacted'  then redacted_at is not null and display_name is null and delete_requested_at is not null
      when 'abandoned' then abandoned_at is not null and committed_at is null and delete_requested_at is not null
    end),
  constraint continuity_attachments_deleted check (object_deleted_at is null or delete_requested_at is not null)
);
create index if not exists continuity_attachments_record on public.continuity_attachments (record_id, created_at);
create index if not exists continuity_attachments_pending on public.continuity_attachments (created_at) where status = 'pending';
create index if not exists continuity_attachments_delete on public.continuity_attachments (delete_requested_at)
  where delete_requested_at is not null and object_deleted_at is null;

comment on table public.continuity_attachments is
  'الاستمرارية (080). مرفقات السجل. الملف في المستودع الخاص continuity-attachments بمسار يولّده الخادم؛ '
  'القراءة بسياسة تنادي _continuity_attachment_readable. لا حذف للصفوف: الحالات النهائية purged/redacted/abandoned.';

-- الثبات: لا حذف ولا تفريغ؛ الأعمدة الثابتة لا تتغير؛ الانتقالات المسموحة فقط.
create or replace function public._continuity_guard_attachment()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'المرفقات لا تُحذف صفوفها' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.record_id is distinct from old.record_id
     or new.workspace_id is distinct from old.workspace_id or new.kind is distinct from old.kind
     or new.mime is distinct from old.mime or new.declared_size is distinct from old.declared_size
     or new.storage_path is distinct from old.storage_path or new.idempotency_key is distinct from old.idempotency_key
     or (new.created_by is distinct from old.created_by and new.created_by is not null)
     or new.created_at is distinct from old.created_at
     or (old.size_bytes is not null and new.size_bytes is distinct from old.size_bytes)
     or (old.sha256 is not null and new.sha256 is distinct from old.sha256)
     or (old.committed_at is not null and new.committed_at is distinct from old.committed_at)
     or (new.display_name is distinct from old.display_name and new.display_name is not null)
     or (old.delete_requested_at is not null and new.delete_requested_at is distinct from old.delete_requested_at)
     or (old.object_deleted_at is not null and new.object_deleted_at is distinct from old.object_deleted_at) then
    raise exception 'بيانات المرفق ثابتة' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('active', 'abandoned'))
    or (old.status = 'active' and new.status in ('removed', 'purged', 'redacted'))
    or (old.status = 'removed' and new.status in ('active', 'purged', 'redacted'))) then
    raise exception 'انتقال غير مسموح للمرفق (% → %)', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_continuity_attachment_guard on public.continuity_attachments;
create trigger trg_continuity_attachment_guard before update or delete on public.continuity_attachments
  for each row execute function public._continuity_guard_attachment();
drop trigger if exists trg_continuity_attachments_no_truncate on public.continuity_attachments;
create trigger trg_continuity_attachments_no_truncate before truncate on public.continuity_attachments
  for each statement execute function public._continuity_guard_append_only();

-- اتفاقيات 041/042
alter table public.continuity_attachments enable row level security;
revoke all on table public.continuity_attachments from public, anon, authenticated;
drop policy if exists gate_account_active on public.continuity_attachments;
create policy gate_account_active on public.continuity_attachments
  as restrictive for all to authenticated
  using (public.account_is_active()) with check (public.account_is_active());
drop trigger if exists trg_preview_read_only on public.continuity_attachments;
create trigger trg_preview_read_only
  before insert or update or delete on public.continuity_attachments
  for each statement execute function public.guard_preview_read_only();


-- ============================================================================
-- 4) القراءة: قرار واحد للعرض ولسياسة المستودع
-- ============================================================================
create or replace function public._continuity_attachments_on()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((public._continuity_effective_capabilities() ->> 'attachments')::boolean, false);
$$;

-- مرفق نشط، على سجل يراه المستدعي الآن (continuity_can_access: حساب نشط، ليس معاينة،
-- عضو، ومالك/منشئ/فريق/مشرف)، والقدرة مفعّلة، والاحتفاظ لم ينتهِ.
create or replace function public._continuity_attachment_readable(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public._continuity_attachments_on() and exists (
    select 1
      from public.continuity_attachments a
      join public.continuity_records r on r.id = a.record_id and r.workspace_id = a.workspace_id
      join public.continuity_workspaces w on w.id = r.workspace_id
     where a.storage_path = p_name and a.status = 'active'
       and not public._continuity_retention_expired(r.closed_at, w.snapshot_retention_days)
       and public.continuity_can_access(a.record_id)), false);
$$;

create or replace function public._continuity_attachment_json(a public.continuity_attachments)
returns jsonb language sql stable set search_path to 'public' as $$
  select jsonb_build_object('id', a.id, 'kind', a.kind, 'mime', a.mime, 'size', coalesce(a.size_bytes, a.declared_size),
                            'name', a.display_name, 'path', a.storage_path, 'status', a.status,
                            'created_by', a.created_by, 'created_at', a.created_at)
         || case when a.status = 'removed' then jsonb_build_object('removed_at', a.removed_at, 'removed_by', a.removed_by)
                 else '{}'::jsonb end;
$$;

-- سياسة القراءة الوحيدة على المستودع. لا كتابة للمستخدمين إطلاقًا.
drop policy if exists continuity_attachments_read on storage.objects;
create policy continuity_attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'continuity-attachments' and public._continuity_attachment_readable(name));


-- ============================================================================
-- 5) الرفع: begin ← (دالة الرفع تفحص التوقيع وترفع) ← commit
-- ============================================================================
create or replace function public._continuity_require_attachments()
returns void language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public._continuity_attachments_on() then
    raise exception 'المرفقات غير مفعّلة' using errcode = '0A000',
      detail = '{"code":"feature_not_enabled","field":"attachments"}';
  end if;
end $$;

create or replace function public.continuity_attachment_begin(
  p_record uuid, p_kind text, p_mime text, p_size bigint, p_name text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r public.continuity_records;
  a public.continuity_attachments;
  v_id uuid := gen_random_uuid();
  v_mime text := lower(btrim(split_part(coalesce(p_mime, ''), ';', 1)));
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_attachments();
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  if p_idempotency_key is null then perform public._continuity_validation('idempotency_key'); end if;

  -- إعادة الإرسال بنفس المفتاح: نفس الصف، أو تعارض لو اختلف الطلب.
  select * into a from public.continuity_attachments
   where created_by = auth.uid() and idempotency_key = p_idempotency_key;
  if a.id is not null then
    if a.record_id is distinct from p_record or a.kind is distinct from p_kind or a.mime is distinct from v_mime
       or a.declared_size is distinct from p_size then
      raise exception 'مفتاح التكرار مستخدم لطلب مختلف' using errcode = '23505', detail = '{"code":"idempotency_conflict"}';
    end if;
    if a.status not in ('pending', 'active') or not public.continuity_can_access(a.record_id) then
      raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
    end if;
    return jsonb_build_object('attachment', public._continuity_attachment_json(a), 'replayed', true,
      'upload', case when a.status = 'pending' then jsonb_build_object(
        'bucket', 'continuity-attachments', 'path', a.storage_path, 'max_bytes', a.declared_size) end);
  end if;

  if p_kind is null or public._continuity_attachment_max(p_kind) is null then perform public._continuity_validation('kind', 'not_allowed'); end if;
  if not public._continuity_attachment_mime_ok(p_kind, v_mime) then perform public._continuity_validation('mime', 'not_allowed'); end if;
  if p_size is null or p_size <= 0 then perform public._continuity_validation('size', 'invalid'); end if;
  if p_size > public._continuity_attachment_max(p_kind) then perform public._continuity_validation('size', 'too_large'); end if;

  if not public.continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  -- قفل السجل يسلسل عدّ الحد الأقصى بين رفعين متزامنين.
  select * into r from public.continuity_records where id = p_record for update;
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  if (select count(*) from public.continuity_attachments x
       where x.record_id = r.id and x.status in ('pending', 'active')) >= 20 then
    perform public._continuity_validation('record', 'too_many_attachments');
  end if;

  insert into public.continuity_attachments (id, record_id, workspace_id, kind, mime, declared_size, display_name,
                                             storage_path, idempotency_key, created_by)
  values (v_id, r.id, r.workspace_id, p_kind, v_mime, p_size, public._continuity_attachment_name(p_name),
          r.workspace_id::text || '/' || r.id::text || '/' || v_id::text, p_idempotency_key, auth.uid())
  returning * into a;
  return jsonb_build_object('attachment', public._continuity_attachment_json(a), 'replayed', false,
    'upload', jsonb_build_object('bucket', 'continuity-attachments', 'path', a.storage_path, 'max_bytes', a.declared_size));
end $$;

-- يُستدعى بعد رفع الملف. يتحقق من الملف المخزَّن نفسه (الحجم والنوع من بيانات
-- Storage، لا من العميل). sha256 تحسبه دالة الرفع من البايتات للتدقيق فقط.
create or replace function public.continuity_attachment_commit(p_attachment uuid, p_sha256 text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  a public.continuity_attachments;
  r public.continuity_records;
  o record;
  v_size bigint;
  v_mime text;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  perform public._continuity_require_attachments();
  select * into a from public.continuity_attachments where id = p_attachment;
  if a.id is null or a.created_by is distinct from auth.uid() or not public.continuity_can_access(a.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = a.record_id for update;
  select * into a from public.continuity_attachments where id = p_attachment for update;
  if a.status = 'active' then
    return public._continuity_full(r.id, true);
  end if;
  if a.status <> 'pending' then
    raise exception 'المرفق لم يعد قيد الرفع' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then perform public._continuity_validation('sha256'); end if;

  select o2.metadata into o from storage.objects o2
   where o2.bucket_id = 'continuity-attachments' and o2.name = a.storage_path;
  if not found then perform public._continuity_validation('object', 'missing'); end if;
  v_size := nullif(o.metadata ->> 'size', '')::bigint;
  v_mime := lower(btrim(split_part(coalesce(o.metadata ->> 'mimetype', ''), ';', 1)));
  if v_size is distinct from a.declared_size then perform public._continuity_validation('object', 'size_mismatch'); end if;
  if v_mime is distinct from a.mime then perform public._continuity_validation('object', 'mime_mismatch'); end if;

  update public.continuity_attachments
     set status = 'active', committed_at = now(), size_bytes = v_size, sha256 = p_sha256
   where id = a.id;
  update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
  perform public._continuity_log(r.id, r.workspace_id, 'attachment_added',
    jsonb_build_object('attachment_id', a.id, 'kind', a.kind, 'mime', a.mime, 'size', v_size, 'sha256', p_sha256));
  return public._continuity_full(r.id, false);
end $$;


-- ============================================================================
-- 6) المحذوفات (T1) والمسح النهائي (T2: مالك المنصة فقط)
-- ============================================================================
create or replace function public._continuity_attachment_for_write(p_attachment uuid, p_expected_version integer)
returns public.continuity_attachments language plpgsql security definer set search_path to 'public' as $$
declare a public.continuity_attachments; r public.continuity_records;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  select * into a from public.continuity_attachments where id = p_attachment;
  -- غير موجود، نهائي، أو سجل لا تراه ⇒ نفس الرد.
  if a.id is null or a.status not in ('active', 'removed') or not public.continuity_can_access(a.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  r := public._continuity_lock_for_write(a.record_id, p_expected_version);
  select * into a from public.continuity_attachments where id = p_attachment for update;
  if a.status not in ('active', 'removed') then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return a;
end $$;

create or replace function public.continuity_attachment_remove(p_attachment uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a public.continuity_attachments; r public.continuity_records;
begin
  perform public._continuity_require_attachments();
  a := public._continuity_attachment_for_write(p_attachment, p_expected_version);
  select * into r from public.continuity_records where id = a.record_id;
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  if a.status = 'active' then
    update public.continuity_attachments set status = 'removed', removed_at = now(), removed_by = auth.uid() where id = a.id;
    update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
    perform public._continuity_log(r.id, r.workspace_id, 'attachment_removed',
      jsonb_build_object('attachment_id', a.id, 'kind', a.kind));
  end if;
  return public._continuity_full(r.id, false);
end $$;

create or replace function public.continuity_attachment_restore(p_attachment uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a public.continuity_attachments; r public.continuity_records;
begin
  perform public._continuity_require_attachments();
  a := public._continuity_attachment_for_write(p_attachment, p_expected_version);
  select * into r from public.continuity_records where id = a.record_id;
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  if a.status = 'removed' then
    if (select count(*) from public.continuity_attachments x
         where x.record_id = r.id and x.status in ('pending', 'active')) >= 20 then
      perform public._continuity_validation('record', 'too_many_attachments');
    end if;
    update public.continuity_attachments set status = 'active', removed_at = null, removed_by = null where id = a.id;
    update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
    perform public._continuity_log(r.id, r.workspace_id, 'attachment_restored',
      jsonb_build_object('attachment_id', a.id, 'kind', a.kind));
  end if;
  return public._continuity_full(r.id, false);
end $$;

-- مسح نهائي: مالك المنصة فقط، سجل مفتوح أو مقفول. الصف يصبح purged بلا اسم، والملف
-- يُجدول للحذف الفعلي. لا رجوع.
create or replace function public.continuity_attachment_purge(p_attachment uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a public.continuity_attachments; r public.continuity_records;
begin
  perform public._continuity_require_owner();
  a := public._continuity_attachment_for_write(p_attachment, p_expected_version);
  select * into r from public.continuity_records where id = a.record_id;
  update public.continuity_attachments
     set status = 'purged', purged_at = now(), purged_by = auth.uid(), display_name = null, delete_requested_at = now()
   where id = a.id;
  update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
  perform public._continuity_log(r.id, r.workspace_id, 'attachment_purged',
    jsonb_build_object('attachment_id', a.id, 'kind', a.kind, 'sha256', a.sha256));
  return public._continuity_full(r.id, false);
end $$;


-- ============================================================================
-- 7) الكنس (pg_cron) وقائمة الحذف الفعلي (service_role)
-- ============================================================================
create or replace function public.continuity_attachment_sweep(p_limit integer default 5000)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_lim int := greatest(coalesce(p_limit, 5000), 1);
  v_abandoned int := 0;
  v_redacted int := 0;
  v_gone int := 0;
  x record;
begin
  -- (أ) رفع لم يكتمل خلال ساعة.
  with s as (
    update public.continuity_attachments a
       set status = 'abandoned', abandoned_at = now(), delete_requested_at = now()
     where a.id in (select id from public.continuity_attachments
                     where status = 'pending' and created_at < now() - interval '1 hour'
                     order by created_at limit v_lim for update skip locked)
    returning 1)
  select count(*) into v_abandoned from s;

  -- (ب) انتهاء الاحتفاظ (C5، S5): نفس قاعدة المقتطفات.
  for x in
    select a.id, a.record_id, a.workspace_id, a.kind
      from public.continuity_attachments a
      join public.continuity_records r on r.id = a.record_id and r.workspace_id = a.workspace_id
      join public.continuity_workspaces w on w.id = r.workspace_id
     where a.status in ('active', 'removed')
       and r.status in ('resolved', 'cancelled')
       and public._continuity_retention_expired(r.closed_at, w.snapshot_retention_days)
     order by r.closed_at, a.id
     limit v_lim
     for update of a skip locked
  loop
    update public.continuity_attachments
       set status = 'redacted', redacted_at = now(), display_name = null, delete_requested_at = now()
     where id = x.id;
    insert into public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
    values (x.record_id, x.workspace_id, null, 'cron', 'attachment_redacted',
            jsonb_build_object('attachment_id', x.id, 'kind', x.kind, 'reason', 'retention'));
    v_redacted := v_redacted + 1;
  end loop;

  -- (ج) الملف اختفى فعلًا من Storage (حذفته دالة التنظيف) ⇒ يُسجَّل.
  with g as (
    update public.continuity_attachments a
       set object_deleted_at = now()
     where a.delete_requested_at is not null and a.object_deleted_at is null
       and not exists (select 1 from storage.objects o
                        where o.bucket_id = 'continuity-attachments' and o.name = a.storage_path)
    returning 1)
  select count(*) into v_gone from g;

  return jsonb_build_object('abandoned', v_abandoned, 'redacted', v_redacted, 'objects_gone', v_gone);
end $$;

-- لدالة التنظيف فقط (service_role): مسارات يجب حذفها فعليًا عبر Storage API —
-- مرفقات طُلب حذفها، وملفات يتيمة في المستودع بلا صف (أقدم من ساعة). مسارات فقط.
create or replace function public.continuity_attachment_deletion_queue(p_limit integer default 500)
returns table (path text, reason text) language sql stable security definer set search_path to 'public' as $$
  (select a.storage_path, a.status
     from public.continuity_attachments a
    where a.delete_requested_at is not null and a.object_deleted_at is null
      and exists (select 1 from storage.objects o where o.bucket_id = 'continuity-attachments' and o.name = a.storage_path)
    order by a.delete_requested_at
    limit greatest(coalesce(p_limit, 500), 1))
  union all
  (select o.name, 'orphan'
     from storage.objects o
    where o.bucket_id = 'continuity-attachments'
      and coalesce(o.created_at, now()) < now() - interval '1 hour'
      and not exists (select 1 from public.continuity_attachments a where a.storage_path = o.name)
    order by o.created_at
    limit greatest(coalesce(p_limit, 500), 1));
$$;

-- علامة التثبيت (078): القدرة تصبح «مثبتة»؛ تظل مطفأة حتى قرار التفعيل.
create or replace function public._continuity_capability_attachments()
returns boolean language sql immutable set search_path to 'public' as $$ select true $$;


-- ============================================================================
-- 8) _continuity_full: نص 079 + المرفقات
-- ============================================================================
create or replace function public._continuity_full(p_record uuid, p_replayed boolean default false)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'record', public._continuity_record_json(p_record),
    'sources', coalesce((select jsonb_agg(public._continuity_source_view(s.id) order by s.position)
                           from public.continuity_sources s
                          where s.record_id = p_record and s.removed_at is null), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(public._continuity_source_view(s.id)
                                          || jsonb_build_object('removed_at', s.removed_at, 'removed_by', s.removed_by)
                                          order by s.removed_at desc, s.position)
                           from public.continuity_sources s
                          where s.record_id = p_record and s.removed_at is not null and s.purged_at is null), '[]'::jsonb),
    'closures', coalesce((select jsonb_agg(jsonb_build_object(
                             'seq', c.seq, 'closed_status', c.closed_status, 'closed_at', c.closed_at, 'closed_by', c.closed_by,
                             'resolution_note', c.resolution_note, 'cancel_reason', c.cancel_reason,
                             'reopened_at', c.reopened_at, 'reopened_by', c.reopened_by, 'reopen_reason', c.reopen_reason,
                             'backfilled', c.backfilled) order by c.seq desc)
                            from public.continuity_closures c where c.record_id = p_record), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(public._continuity_attachment_json(a) order by a.created_at)
                               from public.continuity_attachments a
                               join public.continuity_records r on r.id = a.record_id
                               join public.continuity_workspaces w on w.id = r.workspace_id
                              where a.record_id = p_record and a.status = 'active' and public._continuity_attachments_on()
                                and not public._continuity_retention_expired(r.closed_at, w.snapshot_retention_days)), '[]'::jsonb),
    'removed_attachments', coalesce((select jsonb_agg(public._continuity_attachment_json(a) order by a.removed_at desc)
                               from public.continuity_attachments a
                               join public.continuity_records r on r.id = a.record_id
                               join public.continuity_workspaces w on w.id = r.workspace_id
                              where a.record_id = p_record and a.status = 'removed' and public._continuity_attachments_on()
                                and not public._continuity_retention_expired(r.closed_at, w.snapshot_retention_days)), '[]'::jsonb),
    'replayed', p_replayed);
$$;


-- ============================================================================
-- 9) الصلاحيات
-- ============================================================================
do $$
declare f text;
begin
  -- داخلية: لا أحد
  foreach f in array array[
    'public._continuity_attachment_max(text)', 'public._continuity_attachment_mime_ok(text, text)',
    'public._continuity_attachment_name(text)', 'public._continuity_guard_attachment()',
    'public._continuity_attachments_on()', 'public._continuity_attachment_json(public.continuity_attachments)',
    'public._continuity_require_attachments()', 'public._continuity_attachment_for_write(uuid, integer)',
    'public.continuity_attachment_sweep(integer)', 'public.continuity_attachment_deletion_queue(integer)',
    'public._continuity_capability_attachments()', 'public._continuity_full(uuid, boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  -- للمستخدمين (كل قرار داخلها)
  foreach f in array array[
    'public.continuity_attachment_begin(uuid, text, text, bigint, text, uuid)',
    'public.continuity_attachment_commit(uuid, text)',
    'public.continuity_attachment_remove(uuid, integer)', 'public.continuity_attachment_restore(uuid, integer)',
    'public.continuity_attachment_purge(uuid, integer)', 'public._continuity_attachment_readable(text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  -- الاستثناء الوحيد: دالة التنظيف تقرأ قائمة المسارات (مسارات فقط، بلا محتوى ولا أسماء).
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.continuity_attachments from service_role;
    grant execute on function public.continuity_attachment_deletion_queue(integer) to service_role;
  end if;
end $$;


-- ============================================================================
-- 10) pg_cron: كنس كل ساعة
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'continuity-attachment-sweep';
    perform cron.schedule('continuity-attachment-sweep', '23 * * * *', 'select public.continuity_attachment_sweep()');
  end if;
end $$;


-- ============================================================================
-- 11) تحقق
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['continuity_workspaces', 'continuity_records', 'continuity_sources', 'continuity_source_snapshots',
                           'continuity_events', 'continuity_assigners', 'continuity_policies', 'continuity_policy_history',
                           'continuity_closures', 'continuity_attachments'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '080: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '080: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '080: % بلا اتفاقيات 041/042', t;
    end if;
  end loop;
  -- 21 (079) + 5 دوال مرفقات + دالة سياسة القراءة
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 27 then
    raise exception '080: المتوقع 27 دالة لـ authenticated';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
                and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception '080: دالة متاحة لـ anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and (select array_agg(p.proname::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
             and has_function_privilege('service_role', p.oid, 'EXECUTE')) is distinct from array['continuity_attachment_deletion_queue'] then
    raise exception '080: service_role يصل لغير قائمة الحذف';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['continuity\_%', '\_continuity\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '080: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  -- المستودع خاص، وحدوده كما هي، ولا سياسة كتابة تصل إليه.
  if not exists (select 1 from storage.buckets where id = 'continuity-attachments' and not public
                   and file_size_limit = 16777216 and cardinality(allowed_mime_types) = 13) then
    raise exception '080: المستودع ليس خاصًا أو حدوده مختلفة';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
              and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
              and (coalesce(qual, '') || coalesce(with_check, '')) not like '%bucket_id%') then
    raise exception '080: سياسة كتابة على storage.objects بلا تقييد بالمستودع';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
              and (coalesce(qual, '') || coalesce(with_check, '')) like '%continuity-attachments%'
              and policyname <> 'continuity_attachments_read') then
    raise exception '080: سياسة أخرى على مستودع المرفقات';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                  and policyname = 'continuity_attachments_read' and cmd = 'SELECT') then
    raise exception '080: سياسة القراءة مفقودة';
  end if;
  if not public._continuity_capability_installed('attachments') then
    raise exception '080: علامة التثبيت مفقودة';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'continuity-attachment-sweep' and active) then
      raise exception '080: مهمة الكنس غير مجدولة';
    end if;
  end if;
  raise notice '080: مرفقات الاستمرارية مثبتة ومطفأة';
end $$;
