-- ============================================================================
-- 093_continuity_collab_actions.sql
--   Mad3oom Continuity — إجراءات المشاركة التعاونية (082b في docs/continuity/SCOPED_HANDOVER_DESIGN.md §4.3، §5.4)
--
-- القرارات المعتمدة (2026-10-12): S-3 (082b بعد مراجعة 082a)، S-8 (الملاحظات)، والبقية كما في 091.
--
-- ما يضيفه:
--   • collab يقبل الإجراءات note، propose، edit_fields، add_source، والحقول المسموحة
--     (next_action، summary، due، priority) مع propose أو edit_fields فقط. review يظل عرضًا فقط.
--   • مفتاح مستقل delegation_allow_collab (مطفأ افتراضيًا): مطفأ ⇒ لا طلب تعاون جديد بإجراءات،
--     ولا أي كتابة مشتركة، والعرض كما هو. يُفعَّل من إعدادات مالك المنصة.
--   • الملاحظات (continuity_notes): إلحاق فقط. ملاحظة السجل لمن يعدّل السجل (المالك أو المشرف)،
--     وملاحظة المشاركة في «خيط» المنحة. المستلم يرى خيط منحته فقط: ملاحظاته وردود من يدير المنحة (S-8).
--     من يرى السجل يرى كل الملاحظات. الأحداث تحمل بصمة النص فقط.
--   • الاقتراحات (continuity_change_proposals): المستلم يقترح على الحقول المسموحة فقط، ويُتحقق منها
--     بنفس قواعد continuity_update. المالك/المشرف يطبّق عبر continuity_update نفسها (بفحص النسخة) أو يرفض.
--   • التعديل المباشر (continuity_shared_update): الحقول المسموحة فقط، بنفس التحقق وفحص النسخة.
--     لا يلمس المالك ولا الفريق ولا الحالة ولا المصادر.
--   • إضافة مصادر (continuity_shared_attach_sources): بوصول المستلم **نفسه** للمحادثة (_continuity_attach
--     كما هي)، وما يضيفه يظهر لمنحته فقط (continuity_grant_items)، ولا يتوسع نطاق أي منحة أخرى.
--     رسالة موجودة في السجل ومستبعدة من النطاق لا تُضاف للمنحة.
--   • رفع مرفق (continuity_shared_attachment_begin/commit): نفس قيود 080، والمرفق لمنحته فقط.
--     دالة الرفع تختار هذا المسار بترويسة X-Continuity-Shared.
--
-- ما لا يتغيّر: البوابة (_continuity_active_grant) هي نفسها لكل نداء؛ القراءة العادية؛ التسليم الكامل؛
--   سياسة المستودع؛ لا جدول في supabase_realtime.
--
-- الترقيع (نفس طريقة 087/091): نص ثابت يظهر مرة واحدة، بشرط بصمة نص الإنتاج بعد 091، وإثبات أن عكس
--   الاستبدال يعيد البصمة. العلامة 093_continuity_collab_actions.
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/093_continuity_collab_actions.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.continuity_handover_scopes') is null
     or to_regprocedure('public._continuity_active_grant(uuid,text)') is null then
    raise exception '093: يتطلب 091';
  end if;
end $$;


-- ============================================================================
-- 1) السياسة: مفتاح التعاون
-- ============================================================================
alter table public.continuity_policies
  add column if not exists delegation_allow_collab boolean not null default false;


-- ============================================================================
-- 2) الجداول
-- ============================================================================
create table if not exists public.continuity_notes (
  id           uuid primary key default gen_random_uuid(),
  record_id    uuid not null references public.continuity_records(id),
  workspace_id uuid not null references public.continuity_workspaces(id),
  handover_id  uuid references public.continuity_handovers(id),
  author_id    uuid references public.profiles(id) on delete set null,
  body         text not null check (char_length(body) between 1 and 2000),
  created_at   timestamptz not null default now()
);
create index if not exists continuity_notes_record on public.continuity_notes (record_id, created_at);
create index if not exists continuity_notes_handover on public.continuity_notes (handover_id, created_at) where handover_id is not null;
comment on table public.continuity_notes is
  'الاستمرارية (093). ملاحظات السجل وخيوط المشاركة. إلحاق فقط. المستلم يرى خيط منحته فقط.';

create table if not exists public.continuity_change_proposals (
  id             uuid primary key default gen_random_uuid(),
  record_id      uuid not null references public.continuity_records(id),
  workspace_id   uuid not null references public.continuity_workspaces(id),
  handover_id    uuid not null references public.continuity_handovers(id),
  proposed_by    uuid references public.profiles(id) on delete set null,
  patch          jsonb not null check (jsonb_typeof(patch) = 'object'),
  note           text check (char_length(note) <= 1000),
  base_version   int not null,
  state          text not null default 'pending' check (state in ('pending', 'applied', 'rejected', 'withdrawn')),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text check (char_length(decision_note) <= 1000),
  created_at     timestamptz not null default now(),
  constraint continuity_change_proposals_decided check ((state = 'pending') = (decided_at is null))
);
create index if not exists continuity_change_proposals_record on public.continuity_change_proposals (record_id, created_at desc);
create index if not exists continuity_change_proposals_handover on public.continuity_change_proposals (handover_id, created_at desc);
comment on table public.continuity_change_proposals is
  'الاستمرارية (093). اقتراحات تعديل من مستلم مشاركة تعاونية. المالك أو المشرف يطبّق عبر continuity_update أو يرفض.';

-- ما أضافه المستلم بنفسه: يظهر لمنحته فقط (لا يدخل نطاق أي منحة أخرى).
create table if not exists public.continuity_grant_items (
  id            uuid primary key default gen_random_uuid(),
  handover_id   uuid not null references public.continuity_handovers(id),
  record_id     uuid not null references public.continuity_records(id),
  workspace_id  uuid not null references public.continuity_workspaces(id),
  source_id     uuid references public.continuity_sources(id),
  attachment_id uuid references public.continuity_attachments(id),
  added_by      uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint continuity_grant_items_one check ((source_id is null) <> (attachment_id is null))
);
create unique index if not exists continuity_grant_items_source on public.continuity_grant_items (handover_id, source_id) where source_id is not null;
create unique index if not exists continuity_grant_items_attachment on public.continuity_grant_items (handover_id, attachment_id) where attachment_id is not null;
comment on table public.continuity_grant_items is
  'الاستمرارية (093). رسائل ومرفقات أضافها مستلم مشاركة تعاونية؛ تظهر لمنحته فقط. إلحاق فقط.';

-- الثبات
create or replace function public._continuity_guard_collab_row()
returns trigger language plpgsql set search_path to 'public' as $$
declare v_actors text[];
begin
  if tg_op = 'DELETE' then
    raise exception 'لا حذف' using errcode = '42501';
  end if;
  v_actors := case tg_table_name
                when 'continuity_notes' then array['author_id']
                when 'continuity_grant_items' then array['added_by']
                else array['proposed_by', 'decided_by'] end;
  -- حذف حساب فاعل فقط
  if (to_jsonb(new) - v_actors) = (to_jsonb(old) - v_actors)
     and not exists (select 1 from unnest(v_actors) c
                      where (to_jsonb(new) ->> c) is not null and (to_jsonb(new) ->> c) is distinct from (to_jsonb(old) ->> c)) then
    return new;
  end if;
  -- الاقتراح: قرار واحد من pending
  if tg_table_name = 'continuity_change_proposals' then
    if (to_jsonb(old) ->> 'state') = 'pending' and (to_jsonb(new) ->> 'state') <> 'pending'
       and (to_jsonb(new) - array['state', 'decided_by', 'decided_at', 'decision_note'])
           = (to_jsonb(old) - array['state', 'decided_by', 'decided_at', 'decision_note']) then
      return new;
    end if;
  end if;
  raise exception 'السجل ثابت' using errcode = '42501';
end $$;

-- كل صف من نفس السجل والمساحة.
create or replace function public._continuity_collab_same_record()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from public.continuity_records r where r.id = new.record_id and r.workspace_id = new.workspace_id) then
    raise exception 'سجل من مساحة أخرى' using errcode = '23514';
  end if;
  if new.handover_id is not null and not exists (
       select 1 from public.continuity_handovers h where h.id = new.handover_id and h.record_id = new.record_id and h.mode <> 'transfer') then
    raise exception 'منحة من سجل آخر' using errcode = '23514';
  end if;
  if tg_table_name = 'continuity_grant_items' then
    if (new.source_id is not null and not exists (select 1 from public.continuity_sources s where s.id = new.source_id and s.record_id = new.record_id))
       or (new.attachment_id is not null and not exists (select 1 from public.continuity_attachments a where a.id = new.attachment_id and a.record_id = new.record_id)) then
      raise exception 'عنصر من سجل آخر' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['continuity_notes', 'continuity_change_proposals', 'continuity_grant_items'] loop
    execute format('drop trigger if exists trg_%1$s_guard on public.%1$I', t);
    execute format('create trigger trg_%1$s_guard before update or delete on public.%1$I for each row execute function public._continuity_guard_collab_row()', t);
    execute format('drop trigger if exists trg_%1$s_same_record on public.%1$I', t);
    execute format('create trigger trg_%1$s_same_record before insert on public.%1$I for each row execute function public._continuity_collab_same_record()', t);
    execute format('drop trigger if exists trg_%1$s_no_truncate on public.%1$I', t);
    execute format('create trigger trg_%1$s_no_truncate before truncate on public.%1$I for each statement execute function public._continuity_guard_append_only()', t);
    -- اتفاقيات 041/042
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table public.%I from service_role', t);
    end if;
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all to authenticated using (public.account_is_active()) with check (public.account_is_active())', t);
    execute format('drop trigger if exists trg_preview_read_only on public.%I', t);
    execute format('create trigger trg_preview_read_only before insert or update or delete on public.%I for each statement execute function public.guard_preview_read_only()', t);
  end loop;
end $$;


-- ============================================================================
-- 3) مساعدات
-- ============================================================================
create or replace function public._continuity_collab_on()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((public._continuity_policy_row()).delegation_allow_collab, false);
$$;

create or replace function public._continuity_require_collab()
returns void language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public._continuity_collab_on() then
    raise exception 'المشاركة التعاونية غير مفعّلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled","field":"collab"}';
  end if;
end $$;

-- الحقول القابلة للتعديل/الاقتراح في النطاق: مع propose أو edit_fields فقط، ومن الأربعة التي يعدّلها
-- continuity_update لهذه الأنواع.
create or replace function public._continuity_scope_fields(v jsonb, p_actions text[])
returns text[] language plpgsql immutable set search_path to 'public' as $$
declare f text; out text[] := '{}';
  allowed constant text[] := array['next_action', 'summary', 'due', 'priority'];
begin
  if not (p_actions && array['propose', 'edit_fields']) then
    if v is not null and v <> 'null'::jsonb and v <> '[]'::jsonb then
      perform public._continuity_validation('scope.editable_fields', 'requires_action');
    end if;
    return out;
  end if;
  if v is null or jsonb_typeof(v) <> 'array' or v = '[]'::jsonb then
    perform public._continuity_validation('scope.editable_fields', 'required');
  end if;
  for f in select value from jsonb_array_elements_text(v) loop
    if not f = any (allowed) then perform public._continuity_validation('scope.editable_fields'); end if;
    if not f = any (out) then out := out || f; end if;
  end loop;
  return out;
end $$;

-- تحقق رقعة المستلم بنفس قواعد continuity_update للحقول الأربعة ⇒ السطر الجديد (بلا كتابة).
create or replace function public._continuity_collab_patch(r public.continuity_records, p_patch jsonb, p_allowed text[])
returns public.continuity_records language plpgsql stable security definer set search_path to 'public' as $$
declare n public.continuity_records := r; k text; v_due_at timestamptz; v_due_tz text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform public._continuity_validation('patch');
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not k = any (p_allowed) then
      raise exception 'الحقل خارج المشاركة' using errcode = '42501',
        detail = jsonb_build_object('code', 'forbidden', 'field', 'patch.' || k, 'reason', 'not_in_scope')::text;
    end if;
  end loop;
  if p_patch ? 'summary' then
    perform public._continuity_text_ok(p_patch -> 'summary', 'summary', 4000);
    n.summary := nullif(p_patch ->> 'summary', '');
  end if;
  if p_patch ? 'next_action' then
    perform public._continuity_text_ok(p_patch -> 'next_action', 'next_action', 4000);
    n.next_action := nullif(btrim(p_patch ->> 'next_action'), '');
    if char_length(n.next_action) > 1000 then perform public._continuity_validation('next_action'); end if;
  end if;
  if p_patch ? 'priority' then
    if jsonb_typeof(p_patch -> 'priority') <> 'number' then perform public._continuity_validation('priority'); end if;
    begin
      n.priority := (p_patch ->> 'priority')::smallint;
    exception when others then
      perform public._continuity_validation('priority');
    end;
    if n.priority is null or n.priority not between 1 and 4 then perform public._continuity_validation('priority'); end if;
  end if;
  if p_patch ? 'due' then
    select o_at, o_tz into v_due_at, v_due_tz from public._continuity_parse_due(p_patch -> 'due', r.kind, true);
    n.due_at := v_due_at; n.due_tz := v_due_tz;
  end if;
  if r.kind = 'follow_up' and (n.due_at is null or n.next_action is null) then
    perform public._continuity_validation('follow_up', 'next_action_and_due_required');
  end if;
  return n;
end $$;

-- منحة نشطة بإجراء كتابة: البوابة + المفتاح + النطاق. ⇒ (المنحة، النطاق)
create or replace function public._continuity_collab_grant(p_record uuid, p_action text)
returns public.continuity_handovers language plpgsql stable security definer set search_path to 'public' as $$
declare h public.continuity_handovers;
begin
  h := public._continuity_active_grant(p_record, p_action);
  perform public._continuity_require_collab();
  if h.mode <> 'collab' then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return h;
end $$;

create or replace function public._continuity_note_json(x public.continuity_notes)
returns jsonb language sql stable set search_path to 'public' as $$
  select jsonb_build_object('id', x.id, 'record_id', x.record_id, 'handover_id', x.handover_id, 'author_id', x.author_id,
                            'body', x.body, 'created_at', x.created_at);
$$;

create or replace function public._continuity_proposal_json(x public.continuity_change_proposals)
returns jsonb language sql stable set search_path to 'public' as $$
  select jsonb_build_object('id', x.id, 'record_id', x.record_id, 'handover_id', x.handover_id, 'proposed_by', x.proposed_by,
                            'patch', x.patch, 'note', x.note, 'base_version', x.base_version, 'state', x.state,
                            'decided_by', x.decided_by, 'decided_at', x.decided_at, 'decision_note', x.decision_note,
                            'created_at', x.created_at);
$$;

-- ما يُضاف للعرض المشترك: خيط المنحة واقتراحاتها والحقول المسموحة.
create or replace function public._continuity_shared_extras(h public.continuity_handovers)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'notes', coalesce((select jsonb_agg(public._continuity_note_json(x) order by x.created_at)
                         from public.continuity_notes x where x.handover_id = h.id), '[]'::jsonb),
    'proposals', coalesce((select jsonb_agg(public._continuity_proposal_json(x) order by (x.state = 'pending') desc, x.created_at desc)
                             from public.continuity_change_proposals x where x.handover_id = h.id), '[]'::jsonb),
    'collab', jsonb_build_object('enabled', public._continuity_collab_on(),
                                 'editable_fields', coalesce((select to_jsonb(s.editable_fields) from public.continuity_handover_scopes s
                                                               where s.handover_id = h.id and s.version = h.scope_version), '[]'::jsonb)));
$$;


-- ============================================================================
-- 4) الملاحظات
-- ============================================================================
-- p_handover = null ⇒ ملاحظة على السجل (لمن يعدّل السجل). غير null ⇒ في خيط تلك المنحة:
--   المستلم (منحة نشطة بإجراء note) أو من يعدّل السجل (رد المالك/المشرف).
create or replace function public.continuity_note_add(p_record uuid, p_body text, p_handover uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  h public.continuity_handovers;
  r public.continuity_records;
  x public.continuity_notes;
  v_grantee boolean := false;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  if p_handover is not null then
    select * into h from public.continuity_handovers where id = p_handover;
    v_grantee := h.id is not null and h.to_owner = auth.uid() and h.record_id = p_record;
  end if;
  if v_grantee then
    h := public._continuity_collab_grant(p_record, 'note');
    if h.id <> p_handover then raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}'; end if;
  else
    if not public.continuity_can_access(p_record) then
      raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
    end if;
    perform public._continuity_require_edit(p_record);
    if p_handover is not null and (h.id is null or h.record_id <> p_record or h.mode = 'transfer') then
      raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found","field":"handover"}';
    end if;
  end if;
  if char_length(v_body) not between 1 and 2000 then perform public._continuity_validation('body'); end if;
  select * into r from public.continuity_records where id = p_record;
  insert into public.continuity_notes (record_id, workspace_id, handover_id, author_id, body)
  values (r.id, r.workspace_id, p_handover, auth.uid(), v_body) returning * into x;
  perform public._continuity_log(r.id, r.workspace_id, 'note_added',
    jsonb_strip_nulls(jsonb_build_object('note_id', x.id, 'handover_id', p_handover, 'fields', jsonb_build_object('body', public._continuity_hash(v_body)))));
  return public._continuity_note_json(x);
end $$;

-- كل ملاحظات السجل لمن يراه.
create or replace function public.continuity_notes_for(p_record uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  if not public.continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return coalesce((select jsonb_agg(public._continuity_note_json(x) order by x.created_at)
                     from public.continuity_notes x where x.record_id = p_record), '[]'::jsonb);
end $$;


-- ============================================================================
-- 5) الاقتراحات
-- ============================================================================
create or replace function public.continuity_shared_propose(p_record uuid, p_patch jsonb, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  h public.continuity_handovers; sc public.continuity_handover_scopes; r public.continuity_records;
  x public.continuity_change_proposals; v_note text := nullif(btrim(p_note), '');
begin
  h := public._continuity_collab_grant(p_record, 'propose');
  sc := public._continuity_scope_of(h);
  if v_note is not null and char_length(v_note) > 1000 then perform public._continuity_validation('note'); end if;
  if (select count(*) from public.continuity_change_proposals where handover_id = h.id and state = 'pending') >= 20 then
    perform public._continuity_validation('proposal', 'too_many_pending');
  end if;
  select * into r from public.continuity_records where id = p_record;
  perform public._continuity_collab_patch(r, p_patch, sc.editable_fields);
  insert into public.continuity_change_proposals (record_id, workspace_id, handover_id, proposed_by, patch, note, base_version)
  values (r.id, r.workspace_id, h.id, auth.uid(), p_patch, v_note, r.version) returning * into x;
  perform public._continuity_log(r.id, r.workspace_id, 'change_proposed',
    jsonb_build_object('proposal_id', x.id, 'handover_id', h.id,
                       'changed', (select jsonb_agg(k order by k) from jsonb_object_keys(p_patch) k)));
  return public.continuity_shared_get(p_record);
end $$;

create or replace function public.continuity_proposals_for(p_record uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  if not public.continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return coalesce((select jsonb_agg(public._continuity_proposal_json(x) order by (x.state = 'pending') desc, x.created_at desc)
                     from public.continuity_change_proposals x where x.record_id = p_record), '[]'::jsonb);
end $$;

-- المالك أو المشرف: تطبيق عبر continuity_update (نفس التحقق وفحص النسخة) أو رفض.
create or replace function public.continuity_proposal_decide(p_proposal uuid, p_decision text, p_note text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare x public.continuity_change_proposals; v_note text := nullif(btrim(p_note), ''); v_full jsonb;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  select * into x from public.continuity_change_proposals where id = p_proposal;
  if x.id is null or not public.continuity_can_access(x.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  perform public._continuity_require_edit(x.record_id);
  if p_decision not in ('apply', 'reject') then perform public._continuity_validation('decision'); end if;
  if v_note is not null and char_length(v_note) > 1000 then perform public._continuity_validation('note'); end if;
  select * into x from public.continuity_change_proposals where id = p_proposal for update;
  if x.state <> 'pending' then
    raise exception 'الاقتراح اتحسم' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'reason', 'proposal_' || x.state)::text;
  end if;
  if p_decision = 'apply' then
    v_full := public.continuity_update(x.record_id, x.patch, p_expected_version);
  end if;
  update public.continuity_change_proposals
     set state = case p_decision when 'apply' then 'applied' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = v_note
   where id = x.id returning * into x;
  perform public._continuity_log(x.record_id, x.workspace_id,
    case p_decision when 'apply' then 'change_proposal_applied' else 'change_proposal_rejected' end,
    jsonb_strip_nulls(jsonb_build_object('proposal_id', x.id, 'handover_id', x.handover_id,
                                         'fields', case when v_note is not null then jsonb_build_object('note', public._continuity_hash(v_note)) end)));
  return jsonb_build_object('proposal', public._continuity_proposal_json(x),
                            'record', coalesce(v_full, public._continuity_full(x.record_id, false)));
end $$;

-- المقترِح يسحب اقتراحه المعلّق.
create or replace function public.continuity_proposal_withdraw(p_proposal uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare x public.continuity_change_proposals;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  select * into x from public.continuity_change_proposals where id = p_proposal for update;
  if x.id is null or x.proposed_by is distinct from auth.uid() then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if x.state <> 'pending' then
    raise exception 'الاقتراح اتحسم' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'reason', 'proposal_' || x.state)::text;
  end if;
  update public.continuity_change_proposals set state = 'withdrawn', decided_by = auth.uid(), decided_at = now()
   where id = x.id returning * into x;
  perform public._continuity_log(x.record_id, x.workspace_id, 'change_proposal_withdrawn',
    jsonb_build_object('proposal_id', x.id, 'handover_id', x.handover_id));
  return public._continuity_proposal_json(x);
end $$;


-- ============================================================================
-- 6) التعديل المباشر (edit_fields)
-- ============================================================================
create or replace function public.continuity_shared_update(p_record uuid, p_patch jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  h public.continuity_handovers; sc public.continuity_handover_scopes;
  r public.continuity_records; n public.continuity_records; v_changed text[];
  v_text constant text[] := array['summary', 'next_action'];
begin
  h := public._continuity_collab_grant(p_record, 'edit_fields');
  select * into r from public.continuity_records where id = p_record for update;
  -- بعد القفل: البوابة مرة أخرى (سحب أو إسناد متزامن)
  h := public._continuity_collab_grant(p_record, 'edit_fields');
  sc := public._continuity_scope_of(h);
  if p_expected_version is null then perform public._continuity_validation('expected_version'); end if;
  if r.version <> p_expected_version then
    raise exception 'السجل اتعدّل — حدّث الصفحة' using errcode = '40001',
      detail = jsonb_build_object('code', 'version_conflict', 'current_version', r.version)::text;
  end if;
  n := public._continuity_collab_patch(r, p_patch, sc.editable_fields);
  update public.continuity_records
     set summary = n.summary, next_action = n.next_action, priority = n.priority, due_at = n.due_at, due_tz = n.due_tz,
         version = version + 1, updated_at = now()
   where id = r.id returning * into n;
  select array_agg(f) into v_changed from unnest(array['summary', 'next_action', 'priority', 'due_at', 'due_tz']) f
   where (to_jsonb(r) -> f) is distinct from (to_jsonb(n) -> f);
  perform public._continuity_log(r.id, r.workspace_id, 'updated',
    jsonb_build_object('changed', coalesce(to_jsonb(v_changed), '[]'::jsonb), 'via_handover', h.id,
      'fields', public._continuity_text_fields_digest(n, (select coalesce(array_agg(f), '{}') from unnest(v_changed) f where f = any (v_text))),
      'priority', case when r.priority is distinct from n.priority then jsonb_build_object('from', r.priority, 'to', n.priority) end,
      'due', case when r.due_at is distinct from n.due_at or r.due_tz is distinct from n.due_tz
                  then jsonb_build_object('from', r.due_at, 'to', n.due_at, 'tz', n.due_tz) end));
  return public.continuity_shared_get(p_record);
end $$;


-- ============================================================================
-- 7) إضافة مصادر ومرفقات (add_source)
-- ============================================================================
create or replace function public.continuity_shared_attach_sources(p_record uuid, p_sources jsonb, p_expected_version integer, p_sensitive_ack boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare h public.continuity_handovers; r public.continuity_records; v_before uuid[]; v_added int;
begin
  h := public._continuity_collab_grant(p_record, 'add_source');
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  select * into r from public.continuity_records where id = p_record for update;
  h := public._continuity_collab_grant(p_record, 'add_source');
  if p_expected_version is null then perform public._continuity_validation('expected_version'); end if;
  if r.version <> p_expected_version then
    raise exception 'السجل اتعدّل — حدّث الصفحة' using errcode = '40001',
      detail = jsonb_build_object('code', 'version_conflict', 'current_version', r.version)::text;
  end if;
  select coalesce(array_agg(id), '{}') into v_before from public.continuity_sources where record_id = r.id;
  -- وصول المستلم نفسه لكل محادثة (C1)، والتكرار يُتجاهل: رسالة موجودة ومستبعدة لا تدخل المنحة.
  v_added := public._continuity_attach(r, p_sources, p_sensitive_ack);
  insert into public.continuity_grant_items (handover_id, record_id, workspace_id, source_id, added_by)
  select h.id, r.id, r.workspace_id, s.id, auth.uid() from public.continuity_sources s
   where s.record_id = r.id and not s.id = any (v_before);
  if v_added > 0 then
    update public.continuity_records set version = version + 1, updated_at = now() where id = r.id;
    perform public._continuity_log(r.id, r.workspace_id, 'shared_sources_added', jsonb_build_object('handover_id', h.id, 'count', v_added));
  end if;
  return public.continuity_shared_get(p_record);
end $$;

create or replace function public.continuity_shared_attachment_begin(p_record uuid, p_kind text, p_mime text, p_size bigint, p_name text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  h public.continuity_handovers;
  r public.continuity_records;
  a public.continuity_attachments;
  v_id uuid := gen_random_uuid();
  v_mime text := lower(btrim(split_part(coalesce(p_mime, ''), ';', 1)));
begin
  h := public._continuity_collab_grant(p_record, 'add_source');
  perform public._continuity_require_attachments();
  if public._continuity_via_api() then perform public._continuity_forbidden('client'); end if;
  if p_idempotency_key is null then perform public._continuity_validation('idempotency_key'); end if;

  select * into a from public.continuity_attachments where created_by = auth.uid() and idempotency_key = p_idempotency_key;
  if a.id is not null then
    if a.record_id is distinct from p_record or a.kind is distinct from p_kind or a.mime is distinct from v_mime
       or a.declared_size is distinct from p_size then
      raise exception 'مفتاح التكرار مستخدم لطلب مختلف' using errcode = '23505', detail = '{"code":"idempotency_conflict"}';
    end if;
    if a.status not in ('pending', 'active')
       or not exists (select 1 from public.continuity_grant_items gi where gi.handover_id = h.id and gi.attachment_id = a.id) then
      raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
    end if;
    return jsonb_build_object('attachment', jsonb_build_object('id', a.id, 'kind', a.kind, 'status', a.status), 'replayed', true,
      'upload', case when a.status = 'pending' then jsonb_build_object(
        'bucket', 'continuity-attachments', 'path', a.storage_path, 'max_bytes', a.declared_size) end);
  end if;

  if p_kind is null or public._continuity_attachment_max(p_kind) is null then perform public._continuity_validation('kind', 'not_allowed'); end if;
  if not public._continuity_attachment_mime_ok(p_kind, v_mime) then perform public._continuity_validation('mime', 'not_allowed'); end if;
  if p_size is null or p_size <= 0 then perform public._continuity_validation('size', 'invalid'); end if;
  if p_size > public._continuity_attachment_max(p_kind) then perform public._continuity_validation('size', 'too_large'); end if;

  select * into r from public.continuity_records where id = p_record for update;
  h := public._continuity_collab_grant(p_record, 'add_source');
  if (select count(*) from public.continuity_attachments x
       where x.record_id = r.id and x.status in ('pending', 'active')) >= 20 then
    perform public._continuity_validation('record', 'too_many_attachments');
  end if;
  insert into public.continuity_attachments (id, record_id, workspace_id, kind, mime, declared_size, display_name,
                                             storage_path, idempotency_key, created_by)
  values (v_id, r.id, r.workspace_id, p_kind, v_mime, p_size, public._continuity_attachment_name(p_name),
          r.workspace_id::text || '/' || r.id::text || '/' || v_id::text, p_idempotency_key, auth.uid())
  returning * into a;
  insert into public.continuity_grant_items (handover_id, record_id, workspace_id, attachment_id, added_by)
  values (h.id, r.id, r.workspace_id, a.id, auth.uid());
  return jsonb_build_object('attachment', jsonb_build_object('id', a.id, 'kind', a.kind, 'status', a.status), 'replayed', false,
    'upload', jsonb_build_object('bucket', 'continuity-attachments', 'path', a.storage_path, 'max_bytes', a.declared_size));
end $$;

create or replace function public.continuity_shared_attachment_commit(p_attachment uuid, p_sha256 text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  h public.continuity_handovers;
  a public.continuity_attachments;
  r public.continuity_records;
  o record;
  v_size bigint;
  v_mime text;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  select * into a from public.continuity_attachments where id = p_attachment;
  if a.id is null or a.created_by is distinct from auth.uid() then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  h := public._continuity_collab_grant(a.record_id, 'add_source');
  perform public._continuity_require_attachments();
  if not exists (select 1 from public.continuity_grant_items gi where gi.handover_id = h.id and gi.attachment_id = a.id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = a.record_id for update;
  select * into a from public.continuity_attachments where id = p_attachment for update;
  if a.status = 'active' then
    return public.continuity_shared_get(r.id);
  end if;
  if a.status <> 'pending' then
    raise exception 'المرفق لم يعد قيد الرفع' using errcode = '55000', detail = '{"code":"invalid_transition"}';
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
    jsonb_build_object('attachment_id', a.id, 'kind', a.kind, 'mime', a.mime, 'size', v_size, 'sha256', p_sha256, 'via_handover', h.id));
  return public.continuity_shared_get(r.id);
end $$;


-- ============================================================================
-- 8) إعدادات المشاركة للأعضاء (للواجهة: الخيارات المسموحة فقط)
-- ============================================================================
create or replace function public.continuity_delegation_settings()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare p public.continuity_policies;
begin
  perform public._continuity_require_member();
  perform public._continuity_workspace(null);
  p := public._continuity_policy_row();
  return jsonb_build_object('default_minutes', p.delegation_default_minutes, 'max_minutes', p.delegation_max_minutes,
                            'session_max_minutes', p.delegation_session_max_minutes, 'allow_ongoing', p.delegation_allow_ongoing,
                            'collab', p.delegation_allow_collab);
end $$;


-- ============================================================================
-- 9) ترقيع دوال 091 (ونص السياسة) بنص ثابت
-- ============================================================================
do $patch$
declare p record; v_def text; v_hits int;
begin
  for p in select * from (values
    -- الطلب: collab يقبل الإجراءات (بمفتاح التعاون)، والحقول المسموحة
    ('public._continuity_scope_resolve(public.continuity_records,jsonb,text)', '8de00f350f1d53135982585bb007e8a0',
     E'      if a <> ''view'' then\n        if p_mode = ''review'' then perform public._continuity_validation(''scope.actions'', ''review_is_view_only''); end if;\n        raise exception ''إجراءات المشاركة غير مفعّلة بعد'' using errcode = ''0A000'',\n          detail = ''{"code":"feature_not_enabled","field":"scope.actions"}'';\n      end if;\n    end loop;\n  end if;\n  sc.editable_fields := ''{}'';\n',
     E'      if a <> ''view'' then\n        if p_mode = ''review'' then perform public._continuity_validation(''scope.actions'', ''review_is_view_only''); end if;\n        perform public._continuity_require_collab(); -- 093_continuity_collab_actions\n        if not a = any (sc.actions) then sc.actions := sc.actions || a; end if; -- 093_continuity_collab_actions\n      end if;\n    end loop;\n  end if;\n  sc.editable_fields := public._continuity_scope_fields(p_scope -> ''editable_fields'', sc.actions); -- 093_continuity_collab_actions\n'),
    -- التضييق: الحقول المسموحة جزء من المقارنة
    ('public._continuity_scope_narrower(public.continuity_handover_scopes,public.continuity_handover_scopes,timestamp with time zone,timestamp with time zone)', '31907f5d77f8d02a5f9c7b2f30fa8611',
     E'and b.actions <@ a.actions\n',
     E'and b.actions <@ a.actions and b.editable_fields <@ a.editable_fields /* 093_continuity_collab_actions */\n'),
    -- التقاطع الفوري في التعديل المختلط يشمل الحقول
    ('public.continuity_handover_amend_scope(uuid,jsonb)', '0e263e8cab490069c1a43e8ae8810a31',
     E'    mid.actions := array(select x from unnest(cur.actions) x where x = any (want.actions));\n',
     E'    mid.actions := array(select x from unnest(cur.actions) x where x = any (want.actions));\n'
     || E'    mid.editable_fields := array(select x from unnest(cur.editable_fields) x where x = any (want.editable_fields)); -- 093_continuity_collab_actions\n'),
    ('public.continuity_handover_amend_scope(uuid,jsonb)', 'x-chained',
     E'or mid.actions <> cur.actions\n',
     E'or mid.actions <> cur.actions or mid.editable_fields <> cur.editable_fields /* 093_continuity_collab_actions */\n'),
    -- ما أضافه المستلم يظهر لمنحته (والفترة الزمنية لا تخفيه عنه)
    ('public._continuity_scope_source_ids(public.continuity_handover_scopes)', 'd631cd54d1b7a45825f3363a6e9412d9',
     E'   where s.id = any (sc.source_ids) and s.record_id = sc.record_id\n     and s.removed_at is null and s.purged_at is null\n     and (sc.range_from is null\n',
     E'   where (s.id = any (sc.source_ids) or s.id in (select gi.source_id from public.continuity_grant_items gi where gi.handover_id = sc.handover_id and gi.source_id is not null)) and s.record_id = sc.record_id /* 093_continuity_collab_actions */\n     and s.removed_at is null and s.purged_at is null\n     and (sc.range_from is null or s.id in (select gi.source_id from public.continuity_grant_items gi where gi.handover_id = sc.handover_id and gi.source_id is not null)\n'),
    ('public._continuity_scope_attachment_ids(public.continuity_handover_scopes)', '402a356cef9a1bbbf921b4f4ed69db54',
     E'   where a.id = any (sc.attachment_ids) and a.record_id = sc.record_id',
     E'   where (a.id = any (sc.attachment_ids) or a.id in (select gi.attachment_id from public.continuity_grant_items gi where gi.handover_id = sc.handover_id and gi.attachment_id is not null)) and a.record_id = sc.record_id /* 093_continuity_collab_actions */'),
    -- العرض المشترك: خيط المنحة واقتراحاتها والحقول
    ('public.continuity_shared_get(uuid)', '4f8f6485f0b4a932755819d6f306209a',
     E'  return jsonb_build_object(\n    ''record'',',
     E'  return public._continuity_shared_extras(h) /* 093_continuity_collab_actions */ || jsonb_build_object(\n    ''record'','),
    -- تاريخ النطاق: الحقول المسموحة
    ('public.continuity_handover_scope(uuid)', '3dbfaf64d76f59f5912c392bc0cf6d9e',
     E'''actions'', to_jsonb(s.actions), ''expiry''',
     E'''actions'', to_jsonb(s.actions), ''editable_fields'', to_jsonb(s.editable_fields) /* 093_continuity_collab_actions */, ''expiry'''),
    -- السياسة: مفتاح التعاون
    ('public.continuity_set_policies(jsonb,integer)', '4f8aa4bcf5674837224432a72fd0e7b0',
     E'''delegation_allow_ongoing'' /* 091_continuity_scoped_handover */];',
     E'''delegation_allow_ongoing'' /* 091_continuity_scoped_handover */, ''delegation_allow_collab'' /* 093_continuity_collab_actions */];'),
    ('public.continuity_set_policies(jsonb,integer)', 'x-chained',
     E'delegation_allow_ongoing = n.delegation_allow_ongoing /* 091_continuity_scoped_handover */,',
     E'delegation_allow_ongoing = n.delegation_allow_ongoing /* 091_continuity_scoped_handover */, delegation_allow_collab = n.delegation_allow_collab /* 093_continuity_collab_actions */,')
  ) as x(fn, md5_before, anchor, replacement) loop
    v_def := pg_get_functiondef(p.fn::regprocedure);
    if strpos(v_def, p.replacement) > 0 then continue; end if;  -- مُرقَّعة من تشغيل سابق
    if p.md5_before <> 'x-chained' and md5(v_def) <> p.md5_before then
      raise exception '093: نص % لا يطابق الإنتاج (md5 %)، لن يُرقَّع', p.fn, md5(v_def);
    end if;
    v_hits := (length(v_def) - length(replace(v_def, p.anchor, ''))) / length(p.anchor);
    if v_hits <> 1 then raise exception '093: الارتكاز في % ظهر % مرة', p.fn, v_hits; end if;
    execute replace(v_def, p.anchor, p.replacement);
  end loop;
end $patch$;


-- ============================================================================
-- 10) الصلاحيات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._continuity_guard_collab_row()', 'public._continuity_collab_same_record()',
    'public._continuity_collab_on()', 'public._continuity_require_collab()',
    'public._continuity_scope_fields(jsonb, text[])',
    'public._continuity_collab_patch(public.continuity_records, jsonb, text[])',
    'public._continuity_collab_grant(uuid, text)',
    'public._continuity_note_json(public.continuity_notes)',
    'public._continuity_proposal_json(public.continuity_change_proposals)',
    'public._continuity_shared_extras(public.continuity_handovers)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array array[
    'public.continuity_note_add(uuid, text, uuid)', 'public.continuity_notes_for(uuid)',
    'public.continuity_shared_propose(uuid, jsonb, text)', 'public.continuity_proposals_for(uuid)',
    'public.continuity_proposal_decide(uuid, text, text, integer)', 'public.continuity_proposal_withdraw(uuid)',
    'public.continuity_shared_update(uuid, jsonb, integer)',
    'public.continuity_shared_attach_sources(uuid, jsonb, integer, boolean)',
    'public.continuity_shared_attachment_begin(uuid, text, text, bigint, text, uuid)',
    'public.continuity_shared_attachment_commit(uuid, text)',
    'public.continuity_delegation_settings()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 11) التحقق
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['continuity_notes', 'continuity_change_proposals', 'continuity_grant_items'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '093: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role') and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '093: صلاحية مباشرة على %', t;
    end if;
  end loop;
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename like 'continuity\_%') then
    raise exception '093: جدول continuity_* في supabase_realtime';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like 'continuity\_%' or p.proname like '\_continuity\_%')
                and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception '093: دالة متاحة لـ anon';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['continuity\_%', '\_continuity\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '093: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f' and strpos(pg_get_functiondef(p.oid), '093_continuity_collab_actions') > 0) <> 8 then
    raise exception '093: الترقيعات الثماني غير مكتملة';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and (qual like '%continuity%' or with_check like '%continuity%')) <> 1 then
    raise exception '093: سياسات مستودع المرفقات تغيّرت';
  end if;
  raise notice '093: إجراءات المشاركة التعاونية مثبتة (delegation_allow_collab يحكمها، مطفأ افتراضيًا)';
end $$;
