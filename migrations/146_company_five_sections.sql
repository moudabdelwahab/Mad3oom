-- ============================================================================
-- 146_company_five_sections.sql — الأقسام الخمسة داخل لوحة الشركة.
--
-- التبويبات الخمسة (workspace, inbox, continuity, customer history, team
-- performance) تُبنى داخل لوحة الشركة لا في لوحة الإدارة (قاعدة 2026-11-26:
-- لا زر/رابط داخل أي لوحة ينتقل إلى لوحة مختلفة). هذا الترحيل هو الجزء
-- الخاص بقاعدة البيانات فقط؛ الواجهة تبويبات hash في لوحة الشركة.
--
-- ── ما يضيفه ─────────────────────────────────────────────────────────────
-- (أ) استمرارية الشركة company_continuity_* (10 دوال عامة): نفس جداول
--     الاستمرارية (continuity_workspaces/records/notes/events من 073/077/093)
--     لكن بمساحة company لا platform:
--       • المساحة صف في continuity_workspaces (kind='company', company_id
--         فريد، قيد company_iff من 073): يُنشأ كسولًا مفعّلًا (enabled=true)
--         عند أول كتابة من فريق الشركة؛ القراءة قبله ترد enabled=false.
--         لا مفتاح platform جديد: وجود التبويب نفسه هو التفعيل.
--       • النطاق = مساحة الشركة وحدها. أي سجل platform غير مرئي هنا إطلاقًا،
--         وأي سجل شركة غير مرئي من دوال platform (التي تشترط kind='platform').
--       • team_id يبقى null دائمًا في سجلات الشركة: الشركة بلا inbox_teams،
--         ودالة الإسناد بلا معامل فريق أصلًا (لا يمكن تمريره بالتوقيع).
--       • kind المسموح: follow_up و issue فقط. handover مرفوض بـ 0A000
--         (مؤجَّل: التسليمات والمشاركات والسياسات والتطهير ومنح المُسندين).
--       • الإنشاء بلا مصادر (attach_sources مؤجَّل): مفتاح sources في الطلب
--         مرفوض صراحةً بـ validation_failed لا يُتجاهل صامتًا.
--       • إعادة الفتح تتخطى حجب الاحتفاظ (retention redaction): لا مصادر في
--         نطاق الشركة أصلًا فلا شيء يُحجب؛ ساعة الاحتفاظ نفسها (closed_at)
--         تُمسح كالمنصة.
--       • مفاتيح التكرار (idempotency_key) تُفحص داخل مساحة الشركة فقط،
--         لا على مستوى created_by وحده كالمنصة: مفتاح واحد لا يعيد تشغيل
--         سجل platform ولا سجل شركة أخرى.
-- (ب) company_customer_history(p_customer_id): حزمة العميل لتبويب «سجل
--     العميل» (تذاكر + ردود + محادثات الشركة + نقل العضويات + اشتراكاته).
--     لا مطابقة واتساب برقم الهاتف إطلاقًا (جدول messages بلا company_id؛
--     المطابقة بالهاتف تتسرب عبر الشركات) — الرسائل هنا ردود التذاكر
--     ورسائل محادثات الشركة فقط.
-- (ج) company_team_performance(p_from, p_to): أداء فريق الشركة. القائمة من
--     مالك الشركة + company_staff النشطين (086) — لا من profiles.role.
--     التذاكر scope='company' و company_id=شركة المنادي فقط. الردود من
--     ticket_replies المربوطة بتلك التذاكر وحدها. التقييمات والشات على مستوى
--     الشركة فقط لا لكل عضو: chat_sessions بلا رابط تذكرة ولا company_id،
--     فلا إسناد عضو صادق لهما — يُحسبان لعملاء الشركة النشطين إجمالًا.
--
-- ── الثوابت الأمنية ─────────────────────────────────────────────────────
--   • الشركة تُشتق من auth.uid() عبر current_company_id() (096) وحدها.
--     لا دالة عامة هنا تقبل company_id معاملًا إطلاقًا.
--   • لا اعتماد على فرع supervises() في أي سياسة RLS (تسرّب معروف عبر
--     الشركات): كل الفحوصات هنا عضوية صريحة (company_staff_role() و
--     _company_staff_role_of() و _company_customer_active()).
--   • كل الدوال SECURITY DEFINER مع set search_path to 'public'، والمنح
--     للمصادَقين وحدهم على العامة، ولا منح على الداخلية (_*) لأي دور.
--   • القراءة بلا وصول ترد null (نمط company_* القائم)؛ الكتابة بلا وصول
--     ترفع P0002 'غير موجود' (لا كشف وجود)، والتحقق 22023، وتعذّر التفعيل
--     0A000، وتعذّر الإذن 42501، وتعذّر النسخة 40001.
--
-- ── المرجع الدقيق للواجهة (لا تُعاد تسمية هذه الدوال بعد كتابتها) ────────
--   company_continuity_my_access() → jsonb
--     {member:boolean, enabled:boolean, company_id:uuid|null, role:text|null
--      ('admin'|'supervisor'|'agent'), supervisor:boolean, can_assign:boolean,
--      admin:boolean}
--   company_continuity_list(p_filters jsonb default '{}') → jsonb (مصفوفة)
--     p_filters: {limit?:1..100 (افتراضي 50), status?:string|string[],
--       kind?:'follow_up'|'issue', owner?:'me'|'unassigned'|uuid,
--       category?:string|null, before?:timestamptz, before_id?:uuid,
--       workspace_id?:null|'company'|<uuid الشركة>}
--     كل عنصر: {id, kind, title, status, priority, category, owner_id,
--       team_id:null دائمًا, due_at, due_tz, next_action, overdue:boolean,
--       closed_at, updated_at, version, source_count:0 دائمًا}
--   company_continuity_get(p_record uuid) → jsonb
--     {record:{...كل أعمدة السجل كما في _continuity_record_json},
--      sources:[], removed:[], replayed:boolean}
--   company_continuity_create(p_request jsonb) → jsonb (كـ get؛ replayed=true
--     عند إعادة مفتاح التكرار)
--     p_request: {contract_version:'1', idempotency_key:uuid (إلزامي),
--       kind:'follow_up'|'issue', title:1..160, summary?:≤4000,
--       next_action?:≤1000, priority?:1..4 (افتراضي 3),
--       category?:'order_status'|'order_problem'|'general_inquiry'|
--         'return_exchange'|'payment_billing'|'product_service'|
--         'technical_issue'|'complaint'|'other'|null,
--       due?:{at:timestamptz, tz:text} (إلزامي لـ follow_up مع next_action)،
--       owner_id?:uuid (إسناد لغيرك للمشرف/المدير فقط)،
--       issue?:{problem?:≤4000, known_facts?:≤4000, unknowns?:≤4000,
--         resolution_criteria?:≤4000} (problem إلزامية لـ issue)}
--     مرفوض: kind='handover' (0A000)، team_id غير null (22023)،
--       sources موجود (22023)، contract_version ≠ '1' (22023).
--   company_continuity_update(p_record uuid, p_patch jsonb,
--       p_expected_version int) → jsonb (كـ get)
--     p_patch مفاتيحه فقط: title, summary, next_action, problem,
--       known_facts, unknowns, resolution_criteria, priority, due, category.
--   company_continuity_transition(p_record uuid, p_to text, p_details jsonb,
--       p_expected_version int) → jsonb (كـ get)
--     p_to: 'in_progress'|'waiting'|'scheduled' (من نشط)، 'resolved' (يتطلب
--       details.resolution_note)، 'cancelled' (يتطلب details.cancel_reason)،
--       'open' من مغلق (يتطلب details.reason). 'ready_for_handover' مرفوض
--       بـ 0A000. waiting يتطلب details.waiting_on.
--   company_continuity_assign(p_record uuid, p_owner uuid,
--       p_expected_version int) → jsonb (كـ get؛ أو {record:{id,version},
--       access:'lost'} حين يفقد المنادي الوصول بعد الإسناد)
--     p_owner=null لإلغاء الإسناد. المسند إليه: مالك الشركة أو موظف نشط
--       غير محظور (_company_is_eligible_agent). الإسناد للمشرف/المدير، أو
--       المالك لنفسه فقط.
--   company_continuity_note_add(p_record uuid, p_body text) → jsonb
--     {id, record_id, workspace_id, handover_id:null, author_id, body,
--      created_at} — body من 1 إلى 2000 حرف، إلحاق فقط.
--   company_continuity_notes_for(p_record uuid) → jsonb (مصفوفة ملاحظات،
--     كما أعلاه، مرتبة بالأقدم)
--   company_continuity_events_for(p_record uuid, p_before bigint default null,
--       p_limit int default 50) → jsonb (مصفوفة)
--     كل عنصر: {id, kind, actor_id, client, payload, created_at}؛ سبب
--       data_subject_request يُخفى إلا للمشرف/المدير.
--   company_customer_history(p_customer_id uuid) → jsonb | null
--     null حين لا دور/لا صلاحية customers.view/العميل ليس عميلًا نشطًا
--     في شركة المنادي. غير ذلك:
--     {customer:{id,name,email,phone,joined_at},
--      tickets:[{id,ticket_number,title,status,priority,category,
--        assigned_to,created_at,resolved_at,first_response_at}] (الأحدث، ≤100),
--      replies:[{id,ticket_id,user_id,message,is_internal,created_at}]
--        (الأحدث، ≤200),
--      conversations:[{id,subject,status,assigned_to,last_message_at}]
--        (الأحدث، ≤50),
--      conversation_messages:[{id,conversation_id,sender_id,sender_kind,
--        is_internal,body,created_at}] (الأحدث، ≤200),
--      moves:[{id,direction:'incoming'|'outgoing',status,created_at,
--        expires_at}] (الأحدث، ≤50),
--      subscriptions:[{id,plan_key,plan_name,status,start_date,end_date}]
--        (الأحدث، ≤50)}
--   company_team_performance(p_from date default current_date - 30,
--       p_to date default current_date) → jsonb | null
--     null حين الدور ليس admin/supervisor. النافذة شاملة الطرفين، بحد
--     أقصى 366 يومًا (وإلا 22023).
--     {company_id, from:date, to:date, generated_at,
--      members:[{id,name,role,tickets_created,tickets_resolved,
--        replies_total,replies_public,replies_internal,
--        avg_first_response_seconds|null, avg_resolution_seconds|null}]
--        (مرتبة بالدور ثم الاسم؛ tickets_created = أُنشئت في النافذة
--        والمسند إليه العضو؛ tickets_resolved = resolved_at في النافذة؛
--        المتوسطات ثوانٍ مدوّرة أو null بلا عينة),
--      totals:{tickets_created,tickets_resolved,tickets_open_now,
--        avg_first_response_seconds|null, avg_resolution_seconds|null,
--        ratings:{count,avg|null (1..5، منزلتان)},
--        chat:{sessions,messages}}}
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/146_company_five_sections.down.sql
-- (يحذف الدوال فقط؛ صفوف مساحات/سجلات الشركة وبياناتها تبقى — التراجع
-- كود لا بيانات، وحذف سجلات شركة حية ليس إجراء تراجع آمنًا).
-- ============================================================================

begin;

-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.current_company_id()', 'public.company_staff_role()',
    'public._company_staff_role_of(uuid,uuid)', 'public._company_is_eligible_agent(uuid,uuid)',
    'public._company_customer_active(uuid,uuid)', 'public._company_perm(uuid,uuid,text)',
    'public._feature_on(text)',
    'public._continuity_record_json(uuid)', 'public._continuity_note_json(public.continuity_notes)',
    'public._continuity_log(uuid,uuid,text,jsonb,text)', 'public._continuity_parse_category(jsonb)',
    'public._continuity_parse_due(jsonb,text,boolean)', 'public._continuity_text_ok(jsonb,text,integer)',
    'public._continuity_validation(text,text)', 'public._continuity_hash(text)', 'public._continuity_client()'] loop
    if to_regprocedure(f) is null then
      raise exception '146 يتطلب % (073/077/086/093/096/098 وما قبله)', f;
    end if;
  end loop;
  foreach f in array array['continuity_workspaces', 'continuity_records', 'continuity_notes', 'continuity_events',
                           'tickets', 'ticket_replies', 'company_conversations', 'company_conversation_messages',
                           'customer_transfers', 'customer_subscriptions', 'subscription_plans',
                           'chat_sessions', 'chat_messages', 'chat_ratings',
                           'company_staff', 'company_memberships', 'companies', 'profiles'] loop
    if to_regclass('public.' || f) is null then
      raise exception '146 يتطلب الجدول public.% (073/077/093/096/098/102/134 وما قبله)', f;
    end if;
  end loop;
end $$;


-- ============================================================================
-- 1) الداخلية: مساحة الشركة والوصول والقفل والبناء
-- ============================================================================
-- مساحة الشركة (صف أو null). لا إنشاء هنا: القراءة قبل أي كتابة ترد null.
create or replace function public._company_continuity_workspace()
returns public.continuity_workspaces
language sql stable security definer set search_path to 'public' as $$
  select w.* from public.continuity_workspaces w
   where w.kind = 'company' and w.company_id = public.current_company_id();
$$;

-- إنشاء كسول مفعّل عند أول كتابة. لا مفتاح platform لهذا: وجود التبويب هو التفعيل.
create or replace function public._company_continuity_ensure_workspace()
returns public.continuity_workspaces
language plpgsql security definer set search_path to 'public' as $$
declare
  v_company uuid := public.current_company_id();
  w public.continuity_workspaces;
begin
  if v_company is null then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into w from public.continuity_workspaces where kind = 'company' and company_id = v_company;
  if w.id is null then
    insert into public.continuity_workspaces (kind, company_id, enabled)
    values ('company', v_company, true)
    on conflict (company_id) do nothing
    returning * into w;
    if w.id is null then
      select * into w from public.continuity_workspaces where kind = 'company' and company_id = v_company;
    end if;
  end if;
  if not w.enabled then
    raise exception 'الاستمرارية غير مفعّلة لهذه المساحة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  return w;
end $$;

-- عضو فريق الشركة: دور staff غير null (admin/supervisor/agent). العميل والغريب null.
create or replace function public._company_continuity_require_member()
returns uuid
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if public.company_staff_role() is null then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  return auth.uid();
end $$;

create or replace function public._company_continuity_is_supervisor()
returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.company_staff_role() in ('admin', 'supervisor'), false);
$$;

-- من يرى السجل: عضو فريق + السجل في مساحة شركته + (مشرف/مدير أو مالك أو منشئ).
-- لا فرع supervises هنا ولا في أي مكان في هذا الترحيل.
create or replace function public._company_continuity_can_access(p_record uuid)
returns boolean
language sql stable security definer set search_path to 'public' as $$
  select p_record is not null
     and public.company_staff_role() is not null
     and exists (
       select 1
         from public.continuity_records r
         join public.continuity_workspaces w
           on w.id = r.workspace_id and w.kind = 'company' and w.enabled
          and w.company_id = public.current_company_id()
        where r.id = p_record
          and (public._company_continuity_is_supervisor()
               or r.owner_id = auth.uid()
               or r.created_by = auth.uid()));
$$;

-- من يعدّل السجل: المشرف/المدير أو مالكه أو منشئه.
create or replace function public._company_continuity_can_edit(r public.continuity_records)
returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public._company_continuity_is_supervisor()
      or r.owner_id = auth.uid()
      or r.created_by = auth.uid();
$$;

-- قفل للكتابة + فحص النسخة (كما في المنصة: 40001 مع النسخة الحالية).
create or replace function public._company_continuity_lock_for_write(p_record uuid, p_expected_version integer)
returns public.continuity_records
language plpgsql security definer set search_path to 'public' as $$
declare r public.continuity_records;
begin
  perform public._company_continuity_require_member();
  if not public._company_continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.continuity_records where id = p_record for update;
  if p_expected_version is null then perform public._continuity_validation('expected_version'); end if;
  if r.version <> p_expected_version then
    raise exception 'السجل اتعدّل — حدّث الصفحة' using errcode = '40001',
      detail = jsonb_build_object('code', 'version_conflict', 'current_version', r.version)::text;
  end if;
  return r;
end $$;

-- البناء الكامل: سجلات الشركة بلا مصادر إطلاقًا (attach مؤجَّل).
create or replace function public._company_continuity_full(p_record uuid, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'record', public._continuity_record_json(p_record),
    'sources', '[]'::jsonb,
    'removed', '[]'::jsonb,
    'replayed', p_replayed);
$$;

revoke all on function public._company_continuity_workspace() from public, anon, authenticated, service_role;
revoke all on function public._company_continuity_ensure_workspace() from public, anon, authenticated, service_role;
revoke all on function public._company_continuity_require_member() from public, anon, authenticated, service_role;
revoke all on function public._company_continuity_is_supervisor() from public, anon, authenticated, service_role;
revoke all on function public._company_continuity_can_access(uuid) from public, anon, authenticated, service_role;
revoke all on function public._company_continuity_can_edit(public.continuity_records) from public, anon, authenticated, service_role;
revoke all on function public._company_continuity_lock_for_write(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public._company_continuity_full(uuid, boolean) from public, anon, authenticated, service_role;


-- ============================================================================
-- 2) استمرارية الشركة: الوصول والقائمة والقراءة والإنشاء
-- ============================================================================
create or replace function public.company_continuity_my_access()
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_role text := public.company_staff_role();
  w public.continuity_workspaces;
begin
  if v_role is null then
    return '{"member": false, "enabled": false, "company_id": null, "role": null, "supervisor": false, "can_assign": false, "admin": false}'::jsonb;
  end if;
  w := public._company_continuity_workspace();
  return jsonb_build_object(
    'member', true,
    'enabled', coalesce(w.enabled, false),
    'company_id', public.current_company_id(),
    'role', v_role,
    'supervisor', v_role in ('admin', 'supervisor'),
    'can_assign', v_role in ('admin', 'supervisor'),
    'admin', v_role = 'admin');
end $$;

-- p_filters: {limit, status, kind, owner, category, before, before_id, workspace_id}
create or replace function public.company_continuity_list(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_uid uuid;
  v_company uuid;
  w public.continuity_workspaces;
  v_limit int;
  v_status text[];
  v_kind text;
  v_owner text;
  v_category text;
  v_before timestamptz;
  v_before_id uuid;
begin
  v_uid := public._company_continuity_require_member();
  v_company := public.current_company_id();
  w := public._company_continuity_workspace();
  if w.id is null or not w.enabled then
    return '[]'::jsonb;
  end if;
  if p_filters is not null and jsonb_typeof(p_filters) <> 'object' then
    perform public._continuity_validation('filters');
  end if;
  if p_filters ->> 'workspace_id' is not null
     and (p_filters ->> 'workspace_id') not in (w.id::text, 'company') then
    raise exception 'الاستمرارية غير مفعّلة لهذه المساحة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  begin
    v_limit := least(greatest(coalesce((p_filters ->> 'limit')::int, 50), 1), 100);
    v_before := (p_filters ->> 'before')::timestamptz;
    v_before_id := (p_filters ->> 'before_id')::uuid;
    v_status := case jsonb_typeof(p_filters -> 'status')
                  when 'array' then array(select jsonb_array_elements_text(p_filters -> 'status'))
                  when 'string' then array[p_filters ->> 'status'] end;
  exception when others then
    perform public._continuity_validation('filters');
  end;
  v_kind := p_filters ->> 'kind';
  if v_kind is not null and v_kind not in ('follow_up', 'issue') then
    perform public._continuity_validation('kind');
  end if;
  v_owner := p_filters ->> 'owner';
  v_category := public._continuity_parse_category(p_filters -> 'category');
  return coalesce((
    select jsonb_agg(x.j order by x.updated_at desc, x.id desc)
      from (select r.id, r.updated_at,
                   jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'status', r.status,
                     'priority', r.priority, 'category', r.category, 'owner_id', r.owner_id, 'team_id', r.team_id,
                     'due_at', r.due_at, 'due_tz', r.due_tz, 'next_action', r.next_action,
                     'overdue', (r.status not in ('resolved', 'cancelled') and r.due_at is not null and r.due_at < now()),
                     'closed_at', r.closed_at, 'updated_at', r.updated_at, 'version', r.version,
                     'source_count', 0) as j
              from public.continuity_records r
             where r.workspace_id = w.id
               and public._company_continuity_can_access(r.id)
               and (v_status is null or r.status = any(v_status))
               and (v_kind is null or r.kind = v_kind)
               and (v_category is null or r.category = v_category)
               and (v_owner is null or (v_owner = 'me' and r.owner_id = v_uid)
                    or (v_owner = 'unassigned' and r.owner_id is null) or r.owner_id::text = v_owner)
               and (v_before is null or (v_before_id is null and r.updated_at < v_before)
                    or (r.updated_at, r.id) < (v_before, v_before_id))
             order by r.updated_at desc, r.id desc
             limit v_limit) x), '[]'::jsonb);
end $$;

create or replace function public.company_continuity_get(p_record uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._company_continuity_require_member();
  if not public._company_continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return public._company_continuity_full(p_record, false);
end $$;

create or replace function public.company_continuity_create(p_request jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_uid uuid;
  w public.continuity_workspaces;
  v_key uuid;
  v_hash text;
  v_existing public.continuity_records;
  r public.continuity_records;
  v_kind text;
  v_title text;
  v_owner uuid;
  v_category text;
  v_due_at timestamptz;
  v_due_tz text;
  v_priority int;
  v_id uuid;
begin
  v_uid := public._company_continuity_require_member();
  if p_request is null or jsonb_typeof(p_request) <> 'object' then perform public._continuity_validation('request'); end if;
  w := public._company_continuity_ensure_workspace();
  if octet_length(p_request::text) > 65536 then perform public._continuity_validation('request', 'too_large'); end if;
  if coalesce(p_request ->> 'contract_version', '') <> '1' then perform public._continuity_validation('contract_version'); end if;
  begin
    v_key := (p_request ->> 'idempotency_key')::uuid;
  exception when others then
    perform public._continuity_validation('idempotency_key');
  end;
  if v_key is null then perform public._continuity_validation('idempotency_key'); end if;
  -- بصمة الطلب على الخادم (jsonb يطبّع ترتيب المفاتيح).
  v_hash := public._continuity_hash((p_request - 'idempotency_key')::text);

  -- إعادة التشغيل داخل مساحة الشركة وحدها (لا على مستوى المنشئ كالمنصة).
  select * into v_existing from public.continuity_records
   where created_by = v_uid and idempotency_key = v_key and workspace_id = w.id;
  if v_existing.id is not null then
    if v_existing.request_hash <> v_hash then
      raise exception 'مفتاح التكرار مستخدم لطلب مختلف' using errcode = '23505',
        detail = '{"code":"idempotency_conflict"}';
    end if;
    if not public._company_continuity_can_access(v_existing.id) then
      raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
    end if;
    return public._company_continuity_full(v_existing.id, true);
  end if;

  v_kind := p_request ->> 'kind';
  if v_kind is null or v_kind not in ('follow_up', 'issue') then
    if v_kind = 'handover' then
      raise exception 'التسليم غير مفعّل في هذه المرحلة' using errcode = '0A000',
        detail = '{"code":"feature_not_enabled","field":"kind"}';
    end if;
    perform public._continuity_validation('kind');
  end if;
  if p_request ? 'team_id' and jsonb_typeof(p_request -> 'team_id') <> 'null' then
    perform public._continuity_validation('team_id', 'company_has_no_teams');
  end if;
  if p_request ? 'sources' and jsonb_typeof(p_request -> 'sources') <> 'null' then
    perform public._continuity_validation('sources', 'not_supported_in_company_scope');
  end if;
  perform public._continuity_text_ok(p_request -> 'title', 'title', 160);
  perform public._continuity_text_ok(p_request -> 'summary', 'summary', 4000);
  perform public._continuity_text_ok(p_request -> 'next_action', 'next_action', 1000);
  if p_request ? 'issue' and jsonb_typeof(p_request -> 'issue') = 'object' then
    perform public._continuity_text_ok(p_request -> 'issue' -> 'problem', 'issue.problem', 4000);
    perform public._continuity_text_ok(p_request -> 'issue' -> 'known_facts', 'issue.known_facts', 4000);
    perform public._continuity_text_ok(p_request -> 'issue' -> 'unknowns', 'issue.unknowns', 4000);
    perform public._continuity_text_ok(p_request -> 'issue' -> 'resolution_criteria', 'issue.resolution_criteria', 4000);
  end if;
  if p_request ? 'priority' and jsonb_typeof(p_request -> 'priority') not in ('number', 'null') then
    perform public._continuity_validation('priority');
  end if;
  v_category := public._continuity_parse_category(p_request -> 'category');
  v_title := btrim(coalesce(p_request ->> 'title', ''));
  if char_length(v_title) not between 1 and 160 then perform public._continuity_validation('title'); end if;
  if char_length(p_request ->> 'summary') > 4000 then perform public._continuity_validation('summary'); end if;
  if char_length(p_request ->> 'next_action') > 1000 then perform public._continuity_validation('next_action'); end if;
  begin
    v_priority := coalesce((p_request ->> 'priority')::int, 3);
  exception when others then
    perform public._continuity_validation('priority');
  end;
  if v_priority not between 1 and 4 then perform public._continuity_validation('priority'); end if;
  begin
    v_owner := (p_request ->> 'owner_id')::uuid;
  exception when others then
    perform public._continuity_validation('owner_id');
  end;
  -- الإسناد لغيرك للمشرف/المدير فقط (يُفحص قبل الأهلية حتى لا يعرف غير
  -- المصرّح له شيئًا عن المستهدف).
  if v_owner is not null and v_owner <> v_uid and not public._company_continuity_is_supervisor() then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden","field":"owner_id"}';
  end if;
  if v_owner is not null and not coalesce(public._company_is_eligible_agent(w.company_id, v_owner), false) then
    perform public._continuity_validation('owner_id', 'not_eligible');
  end if;
  select o_at, o_tz into v_due_at, v_due_tz from public._continuity_parse_due(p_request -> 'due', v_kind, true);
  if v_kind = 'follow_up' and (nullif(btrim(p_request ->> 'next_action'), '') is null or v_due_at is null) then
    perform public._continuity_validation('follow_up', 'next_action_and_due_required');
  end if;
  if v_kind = 'issue' and nullif(btrim(coalesce(p_request -> 'issue' ->> 'problem', p_request ->> 'summary')), '') is null then
    perform public._continuity_validation('issue.problem');
  end if;
  if p_request ? 'issue' and jsonb_typeof(p_request -> 'issue') not in ('object', 'null') then
    perform public._continuity_validation('issue');
  end if;

  insert into public.continuity_records (workspace_id, kind, title, summary, next_action, priority, category, owner_id,
                                    team_id, due_at, due_tz, problem, known_facts, unknowns, resolution_criteria,
                                    created_by, created_via, idempotency_key, request_hash)
  values (w.id, v_kind, v_title, nullif(p_request ->> 'summary', ''), nullif(btrim(p_request ->> 'next_action'), ''),
          v_priority, v_category, v_owner, null, v_due_at, v_due_tz,
          case when v_kind = 'issue' then coalesce(nullif(p_request -> 'issue' ->> 'problem', ''), p_request ->> 'summary') end,
          nullif(p_request -> 'issue' ->> 'known_facts', ''), nullif(p_request -> 'issue' ->> 'unknowns', ''),
          nullif(p_request -> 'issue' ->> 'resolution_criteria', ''),
          v_uid, public._continuity_client(), v_key, v_hash)
  on conflict (created_by, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- طلب متزامن بنفس المفتاح سبقنا: إعادة تشغيل أو تعارض (داخل المساحة).
    select * into v_existing from public.continuity_records
     where created_by = v_uid and idempotency_key = v_key and workspace_id = w.id;
    if v_existing.id is null or v_existing.request_hash <> v_hash then
      raise exception 'مفتاح التكرار مستخدم لطلب مختلف' using errcode = '23505',
        detail = '{"code":"idempotency_conflict"}';
    end if;
    return public._company_continuity_full(v_existing.id, true);
  end if;

  select * into r from public.continuity_records where id = v_id;
  perform public._continuity_log(r.id, r.workspace_id, 'created',
    jsonb_build_object('kind', r.kind, 'status', r.status, 'priority', r.priority, 'category', r.category,
                       'owner_id', r.owner_id, 'due_at', r.due_at, 'due_tz', r.due_tz,
                       'fields', jsonb_build_object(
                         'title', public._continuity_hash(r.title),
                         'summary', public._continuity_hash(r.summary),
                         'next_action', public._continuity_hash(r.next_action),
                         'problem', public._continuity_hash(r.problem),
                         'known_facts', public._continuity_hash(r.known_facts),
                         'unknowns', public._continuity_hash(r.unknowns),
                         'resolution_criteria', public._continuity_hash(r.resolution_criteria))));
  return public._company_continuity_full(r.id, false);
end $$;


-- ============================================================================
-- 3) استمرارية الشركة: التعديل والانتقال والإسناد والملاحظات والأحداث
-- ============================================================================
create or replace function public.company_continuity_update(p_record uuid, p_patch jsonb, p_expected_version integer)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  r public.continuity_records;
  n public.continuity_records;
  k text;
  v_due_at timestamptz;
  v_due_tz text;
  v_changed text[] := '{}';
  v_text_fields constant text[] := array['title', 'summary', 'next_action', 'problem', 'known_facts',
                                         'unknowns', 'resolution_criteria'];
begin
  r := public._company_continuity_lock_for_write(p_record, p_expected_version);
  if not public._company_continuity_can_edit(r) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform public._continuity_validation('patch');
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k <> all (v_text_fields || array['priority', 'due', 'category']) then
      perform public._continuity_validation('patch.' || k, 'not_updatable');
    end if;
  end loop;
  foreach k in array v_text_fields loop
    if p_patch ? k then perform public._continuity_text_ok(p_patch -> k, k, 4000); end if;
  end loop;
  if p_patch ? 'priority' and jsonb_typeof(p_patch -> 'priority') <> 'number' then
    perform public._continuity_validation('priority');
  end if;
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول — أعد فتحه أولًا' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  n := r;
  if p_patch ? 'title' then
    n.title := btrim(coalesce(p_patch ->> 'title', ''));
    if char_length(n.title) not between 1 and 160 then perform public._continuity_validation('title'); end if;
  end if;
  if p_patch ? 'summary' then n.summary := nullif(p_patch ->> 'summary', ''); end if;
  if p_patch ? 'next_action' then n.next_action := nullif(btrim(p_patch ->> 'next_action'), ''); end if;
  if p_patch ? 'problem' then n.problem := nullif(p_patch ->> 'problem', ''); end if;
  if p_patch ? 'known_facts' then n.known_facts := nullif(p_patch ->> 'known_facts', ''); end if;
  if p_patch ? 'unknowns' then n.unknowns := nullif(p_patch ->> 'unknowns', ''); end if;
  if p_patch ? 'resolution_criteria' then n.resolution_criteria := nullif(p_patch ->> 'resolution_criteria', ''); end if;
  if p_patch ? 'category' then n.category := public._continuity_parse_category(p_patch -> 'category'); end if;
  if char_length(n.summary) > 4000 or char_length(n.problem) > 4000 or char_length(n.known_facts) > 4000
     or char_length(n.unknowns) > 4000 or char_length(n.resolution_criteria) > 4000 then
    perform public._continuity_validation('text', 'too_long');
  end if;
  if char_length(n.next_action) > 1000 then perform public._continuity_validation('next_action'); end if;
  if p_patch ? 'priority' then
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
  if r.kind = 'issue' and n.problem is null then perform public._continuity_validation('issue.problem'); end if;

  update public.continuity_records
     set title = n.title, summary = n.summary, next_action = n.next_action, problem = n.problem,
         known_facts = n.known_facts, unknowns = n.unknowns, resolution_criteria = n.resolution_criteria,
         priority = n.priority, category = n.category, due_at = n.due_at, due_tz = n.due_tz,
         version = version + 1, updated_at = now()
   where id = r.id returning * into n;

  select array_agg(f) into v_changed from unnest(v_text_fields || array['priority', 'category', 'due_at', 'due_tz']) f
   where (to_jsonb(r) -> f) is distinct from (to_jsonb(n) -> f);
  perform public._continuity_log(r.id, r.workspace_id, 'updated',
    jsonb_build_object('changed', coalesce(to_jsonb(v_changed), '[]'::jsonb),
      'priority', case when r.priority is distinct from n.priority then jsonb_build_object('from', r.priority, 'to', n.priority) end,
      'category', case when r.category is distinct from n.category then jsonb_build_object('from', r.category, 'to', n.category) end,
      'due', case when r.due_at is distinct from n.due_at or r.due_tz is distinct from n.due_tz
                  then jsonb_build_object('from', r.due_at, 'to', n.due_at) end));
  return public._company_continuity_full(r.id, false);
end $$;

create or replace function public.company_continuity_transition(p_record uuid, p_to text, p_details jsonb, p_expected_version integer)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  r public.continuity_records;
  n public.continuity_records;
  v_note text;
  v_active constant text[] := array['open', 'scheduled', 'in_progress', 'waiting'];
begin
  r := public._company_continuity_lock_for_write(p_record, p_expected_version);
  if not public._company_continuity_can_edit(r) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_details is not null and jsonb_typeof(p_details) not in ('object', 'null') then
    perform public._continuity_validation('details');
  end if;
  if p_to = 'ready_for_handover' then
    raise exception 'التسليم غير مفعّل في هذه المرحلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  perform public._continuity_text_ok(p_details -> 'waiting_on', 'details.waiting_on', 1000);
  perform public._continuity_text_ok(p_details -> 'resolution_note', 'details.resolution_note', 4000);
  perform public._continuity_text_ok(p_details -> 'cancel_reason', 'details.cancel_reason', 1000);
  perform public._continuity_text_ok(p_details -> 'reason', 'details.reason', 1000);

  if p_to in ('in_progress', 'waiting', 'scheduled') and r.status = any(v_active) and r.status <> p_to then
    v_note := nullif(btrim(p_details ->> 'waiting_on'), '');
    if p_to = 'waiting' and v_note is null then perform public._continuity_validation('details.waiting_on'); end if;
    if char_length(v_note) > 1000 then perform public._continuity_validation('details.waiting_on'); end if;
    update public.continuity_records
       set status = p_to, waiting_on = case when p_to = 'waiting' then v_note end,
           version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'transitioned',
      jsonb_build_object('from', r.status, 'to', p_to, 'fields',
                         jsonb_build_object('waiting_on', public._continuity_hash(v_note))));
  elsif p_to = 'resolved' and r.status = any(v_active) then
    v_note := nullif(btrim(p_details ->> 'resolution_note'), '');
    if v_note is null or char_length(v_note) > 4000 then perform public._continuity_validation('details.resolution_note'); end if;
    update public.continuity_records
       set status = 'resolved', resolution_note = v_note, resolved_at = now(), resolved_by = auth.uid(),
           closed_at = now(), waiting_on = null, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'resolved',
      jsonb_build_object('from', r.status, 'closed_at', n.closed_at,
                         'fields', jsonb_build_object('resolution_note', public._continuity_hash(v_note))));
  elsif p_to = 'cancelled' and r.status = any(v_active) then
    v_note := nullif(btrim(p_details ->> 'cancel_reason'), '');
    if v_note is null or char_length(v_note) > 1000 then perform public._continuity_validation('details.cancel_reason'); end if;
    update public.continuity_records
       set status = 'cancelled', cancel_reason = v_note, closed_at = now(), waiting_on = null,
           version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'cancelled',
      jsonb_build_object('from', r.status, 'closed_at', n.closed_at,
                         'fields', jsonb_build_object('cancel_reason', public._continuity_hash(v_note))));
  elsif p_to = 'open' and r.status in ('resolved', 'cancelled') then
    v_note := nullif(btrim(p_details ->> 'reason'), '');
    if v_note is null or char_length(v_note) > 1000 then perform public._continuity_validation('details.reason'); end if;
    -- لا حجب احتفاظ هنا: سجلات الشركة بلا مصادر أصلًا. closed_at يُمسح كالمنصة.
    update public.continuity_records
       set status = 'open', closed_at = null, resolution_note = null, resolved_at = null, resolved_by = null,
           cancel_reason = null, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'reopened',
      jsonb_build_object('from', r.status, 'fields', jsonb_build_object('reason', public._continuity_hash(v_note))));
  else
    raise exception 'انتقال غير مسموح' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'from', r.status, 'to', p_to)::text;
  end if;
  return public._company_continuity_full(r.id, false);
end $$;

-- الإسناد بلا فريق: الشركة بلا inbox_teams، وteam_id يبقى null في سجلاتها.
create or replace function public.company_continuity_assign(p_record uuid, p_owner uuid, p_expected_version integer)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  r public.continuity_records;
  n public.continuity_records;
  w public.continuity_workspaces;
begin
  r := public._company_continuity_lock_for_write(p_record, p_expected_version);
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  w := public._company_continuity_workspace();
  if not coalesce(public._company_continuity_is_supervisor()
          or (r.owner_id = auth.uid() and (p_owner is null or p_owner = auth.uid()))
          or (r.owner_id is null and p_owner = auth.uid()), false) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_owner is not null and not coalesce(public._company_is_eligible_agent(w.company_id, p_owner), false) then
    perform public._continuity_validation('owner_id', 'not_eligible');
  end if;
  if p_owner is not distinct from r.owner_id then
    return public._company_continuity_full(r.id, false);
  end if;
  update public.continuity_records set owner_id = p_owner, version = version + 1, updated_at = now()
   where id = r.id returning * into n;
  perform public._continuity_log(r.id, r.workspace_id, 'assigned',
    jsonb_build_object('from_owner', r.owner_id, 'to_owner', n.owner_id));
  if public._company_continuity_can_access(r.id) then
    return public._company_continuity_full(r.id, false);
  end if;
  return jsonb_build_object('record', jsonb_build_object('id', r.id, 'version', n.version), 'access', 'lost');
end $$;

-- ملاحظة على السجل مباشرةً (handover_id دائمًا null: لا تسليمات في نطاق الشركة).
create or replace function public.company_continuity_note_add(p_record uuid, p_body text)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  r public.continuity_records;
  x public.continuity_notes;
begin
  perform public._company_continuity_require_member();
  if not public._company_continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  -- قفل الصف للكتابة (بلا فحص نسخة: الإضافة لا ترفع version السجل).
  select * into r from public.continuity_records where id = p_record for update;
  if not public._company_continuity_can_edit(r) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if char_length(v_body) not between 1 and 2000 then perform public._continuity_validation('body'); end if;
  insert into public.continuity_notes (record_id, workspace_id, handover_id, author_id, body)
  values (r.id, r.workspace_id, null, auth.uid(), v_body) returning * into x;
  perform public._continuity_log(r.id, r.workspace_id, 'note_added',
    jsonb_build_object('note_id', x.id, 'fields', jsonb_build_object('body', public._continuity_hash(v_body))));
  return public._continuity_note_json(x);
end $$;

create or replace function public.company_continuity_notes_for(p_record uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._company_continuity_require_member();
  if not public._company_continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return coalesce((select jsonb_agg(public._continuity_note_json(x) order by x.created_at)
                     from public.continuity_notes x where x.record_id = p_record), '[]'::jsonb);
end $$;

create or replace function public.company_continuity_events_for(p_record uuid, p_before bigint default null, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._company_continuity_require_member();
  if not public._company_continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'actor_id', e.actor_id, 'client', e.client,
                                        'payload', case when e.payload ->> 'reason' = 'data_subject_request'
                                                         and not public._company_continuity_is_supervisor()
                                                        then e.payload || '{"reason": "not_shown"}'::jsonb
                                                        else e.payload end,
                                        'created_at', e.created_at) order by e.id desc)
      from (select * from public.continuity_events
             where record_id = p_record and (p_before is null or id < p_before)
             order by id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) e), '[]'::jsonb);
end $$;


-- ============================================================================
-- 4) سجل العميل داخل الشركة
-- ============================================================================
-- null حين لا دور، أو بلا صلاحية customers.view (حين المفتاح مفعّل)، أو
-- العميل ليس عميلًا نشطًا في شركة المنادي. لا رفع استثناء يكشف الوجود.
create or replace function public.company_customer_history(p_customer_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_company uuid;
  v_role text := public.company_staff_role();
begin
  if v_role is null then
    return null;
  end if;
  v_company := public.current_company_id();
  if public._feature_on('company_permissions_enabled') then
    if not public._company_perm(v_company, auth.uid(), 'customers.view') then
      return null;
    end if;
  elsif v_role not in ('admin', 'supervisor') then
    return null;
  end if;
  if p_customer_id is null or not public._company_customer_active(v_company, p_customer_id) then
    return null;
  end if;
  return jsonb_build_object(
    'customer', (select jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.username, 'عميل'),
                                           'email', p.email, 'phone', p.phone, 'joined_at', m.joined_at)
                   from public.profiles p
                   join public.company_memberships m on m.user_id = p.id and m.company_id = v_company and m.status = 'active'
                  where p.id = p_customer_id),
    'tickets', (select coalesce(jsonb_agg(s.j order by s.c desc), '[]'::jsonb)
      from (select jsonb_build_object(
        'id', t.id, 'ticket_number', t.ticket_number, 'title', t.title, 'status', t.status,
        'priority', t.priority, 'category', t.category, 'assigned_to', t.assigned_to,
        'created_at', t.created_at, 'resolved_at', t.resolved_at, 'first_response_at', t.first_response_at) as j,
        t.created_at as c
      from public.tickets t
     where t.scope = 'company' and t.company_id = v_company and t.user_id = p_customer_id
     order by t.created_at desc limit 100) s),
    'replies', (select coalesce(jsonb_agg(s.j order by s.c desc), '[]'::jsonb)
      from (select jsonb_build_object(
        'id', r.id, 'ticket_id', r.ticket_id, 'user_id', r.user_id, 'message', r.message,
        'is_internal', r.is_internal, 'created_at', r.created_at) as j,
        r.created_at as c
      from public.ticket_replies r
      join public.tickets t on t.id = r.ticket_id
     where t.scope = 'company' and t.company_id = v_company and t.user_id = p_customer_id
     order by r.created_at desc limit 200) s),
    'conversations', (select coalesce(jsonb_agg(s.j order by s.c desc), '[]'::jsonb)
      from (select jsonb_build_object(
        'id', c.id, 'subject', c.subject, 'status', c.status, 'assigned_to', c.assigned_to,
        'last_message_at', c.last_message_at) as j,
        c.last_message_at as c
      from public.company_conversations c
     where c.company_id = v_company and c.customer_id = p_customer_id
     order by c.last_message_at desc limit 50) s),
    'conversation_messages', (select coalesce(jsonb_agg(s.j order by s.c desc), '[]'::jsonb)
      from (select jsonb_build_object(
        'id', m.id, 'conversation_id', m.conversation_id, 'sender_id', m.sender_id,
        'sender_kind', m.sender_kind, 'is_internal', m.is_internal, 'body', m.body, 'created_at', m.created_at) as j,
        m.created_at as c
      from public.company_conversation_messages m
      join public.company_conversations c on c.id = m.conversation_id
     where c.company_id = v_company and c.customer_id = p_customer_id
     order by m.created_at desc limit 200) s),
    'moves', (select coalesce(jsonb_agg(s.j order by s.c desc), '[]'::jsonb)
      from (select jsonb_build_object(
        'id', x.id, 'direction', case when x.from_company = v_company then 'outgoing' else 'incoming' end,
        'status', x.status, 'created_at', x.created_at, 'expires_at', x.expires_at) as j,
        x.created_at as c
      from public.customer_transfers x
     where x.customer_id = p_customer_id and (x.from_company = v_company or x.to_company = v_company)
     order by x.created_at desc limit 50) s),
    'subscriptions', (select coalesce(jsonb_agg(s.j order by s.c desc), '[]'::jsonb)
      from (select jsonb_build_object(
        'id', cs.id, 'plan_key', sp.key, 'plan_name', coalesce(sp.name_ar, sp.name),
        'status', cs.status, 'start_date', cs.start_date, 'end_date', cs.end_date) as j,
        cs.created_at as c
      from public.customer_subscriptions cs
      join public.subscription_plans sp on sp.id = cs.plan_id
     where cs.user_id = p_customer_id
     order by cs.created_at desc limit 50) s));
end $$;


-- ============================================================================
-- 5) أداء فريق الشركة
-- ============================================================================
-- null حين الدور ليس admin/supervisor. النافذة [p_from, p_to] شاملة، بحد 366 يومًا.
create or replace function public.company_team_performance(p_from date default (current_date - 30), p_to date default current_date)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_company uuid;
  v_role text := public.company_staff_role();
  v_from date := coalesce(p_from, current_date - 30);
  v_to date := coalesce(p_to, current_date);
  v_from_ts timestamptz;
  v_to_ts timestamptz;
begin
  -- ملاحظة: v_role قد يكون null (عميل/غريب)؛ `NOT IN` مع null تعطي null
  -- لا true، فلا يصح هنا إلا IS DISTINCT FROM.
  if v_role is distinct from 'admin' and v_role is distinct from 'supervisor' then
    return null;
  end if;
  if v_from > v_to then
    raise exception 'النافذة معكوسة' using errcode = '22023', detail = '{"code":"validation_failed","field":"p_from"}';
  end if;
  if (v_to - v_from) > 366 then
    raise exception 'النافذة أطول من 366 يومًا' using errcode = '22023', detail = '{"code":"validation_failed","field":"p_to"}';
  end if;
  v_company := public.current_company_id();
  v_from_ts := v_from::timestamptz;
  v_to_ts := (v_to + 1)::timestamptz;
  return jsonb_build_object(
    'company_id', v_company,
    'from', v_from,
    'to', v_to,
    'generated_at', now(),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'role', m.role,
        'tickets_created', (select count(*) from public.tickets t
          where t.scope = 'company' and t.company_id = v_company and t.assigned_to = m.id
            and t.created_at >= v_from_ts and t.created_at < v_to_ts),
        'tickets_resolved', (select count(*) from public.tickets t
          where t.scope = 'company' and t.company_id = v_company and t.assigned_to = m.id
            and t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts),
        'replies_total', (select count(*) from public.ticket_replies r
          join public.tickets t on t.id = r.ticket_id
         where t.scope = 'company' and t.company_id = v_company and r.user_id = m.id
           and r.created_at >= v_from_ts and r.created_at < v_to_ts),
        'replies_public', (select count(*) from public.ticket_replies r
          join public.tickets t on t.id = r.ticket_id
         where t.scope = 'company' and t.company_id = v_company and r.user_id = m.id and not r.is_internal
           and r.created_at >= v_from_ts and r.created_at < v_to_ts),
        'replies_internal', (select count(*) from public.ticket_replies r
          join public.tickets t on t.id = r.ticket_id
         where t.scope = 'company' and t.company_id = v_company and r.user_id = m.id and r.is_internal
           and r.created_at >= v_from_ts and r.created_at < v_to_ts),
        'avg_first_response_seconds', (select round(avg(extract(epoch from (t.first_response_at - t.created_at))))
          from public.tickets t
         where t.scope = 'company' and t.company_id = v_company and t.assigned_to = m.id
           and t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null),
        'avg_resolution_seconds', (select round(avg(extract(epoch from (t.resolved_at - t.created_at))))
          from public.tickets t
         where t.scope = 'company' and t.company_id = v_company and t.assigned_to = m.id
           and t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts))
        order by m.role, m.name)
      from (select p.id, coalesce(p.full_name, p.email) as name, rr.role
              from (select c.user_id as id, 'admin'::text as role
                      from public.companies c where c.id = v_company
                    union
                    select s.user_id, public._company_staff_role_of(v_company, s.user_id)
                      from public.company_staff s
                     where s.company_id = v_company and s.revoked_at is null
                       and public._company_staff_role_of(v_company, s.user_id) is not null) rr
              join public.profiles p on p.id = rr.id) m), '[]'::jsonb),
    'totals', jsonb_build_object(
      'tickets_created', (select count(*) from public.tickets t
        where t.scope = 'company' and t.company_id = v_company
          and t.created_at >= v_from_ts and t.created_at < v_to_ts),
      'tickets_resolved', (select count(*) from public.tickets t
        where t.scope = 'company' and t.company_id = v_company
          and t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts),
      'tickets_open_now', (select count(*) from public.tickets t
        where t.scope = 'company' and t.company_id = v_company and t.status in ('open', 'in-progress')),
      'avg_first_response_seconds', (select round(avg(extract(epoch from (t.first_response_at - t.created_at))))
        from public.tickets t
       where t.scope = 'company' and t.company_id = v_company
         and t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null),
      'avg_resolution_seconds', (select round(avg(extract(epoch from (t.resolved_at - t.created_at))))
        from public.tickets t
       where t.scope = 'company' and t.company_id = v_company
         and t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts),
      -- على مستوى الشركة فقط: chat_sessions بلا رابط تذكرة ولا company_id،
      -- فلا إسناد عضو صادق للتقييمات والشات (انظر ترويسة الملف).
      'ratings', (select jsonb_build_object('count', count(*),
                                            'avg', round(avg(cr.rating), 2))
                    from public.chat_ratings cr
                    join public.chat_sessions cs on cs.id = cr.session_id
                   where public._company_customer_active(v_company, cs.user_id)
                     and cr.created_at >= v_from_ts and cr.created_at < v_to_ts),
      'chat', jsonb_build_object(
        'sessions', (select count(*) from public.chat_sessions cs
                      where public._company_customer_active(v_company, cs.user_id)
                        and cs.created_at >= v_from_ts and cs.created_at < v_to_ts),
        'messages', (select count(*) from public.chat_messages cm
                      join public.chat_sessions cs on cs.id = cm.session_id
                     where public._company_customer_active(v_company, cs.user_id)
                       and cm.created_at >= v_from_ts and cm.created_at < v_to_ts
                       and cm.deleted_at is null))));
end $$;


-- ============================================================================
-- 6) المنح
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['public.company_continuity_my_access()', 'public.company_continuity_list(jsonb)',
                           'public.company_continuity_get(uuid)', 'public.company_continuity_create(jsonb)',
                           'public.company_continuity_update(uuid,jsonb,integer)',
                           'public.company_continuity_transition(uuid,text,jsonb,integer)',
                           'public.company_continuity_assign(uuid,uuid,integer)',
                           'public.company_continuity_note_add(uuid,text)',
                           'public.company_continuity_notes_for(uuid)',
                           'public.company_continuity_events_for(uuid,bigint,integer)',
                           'public.company_customer_history(uuid)', 'public.company_team_performance(date,date)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 7) تحقق ذاتي
-- ============================================================================
do $$
declare
  v_n int;
  v_bad text[];
begin
  -- (أ) الدوال العامة الـ12 موجودة وكلها SECURITY DEFINER.
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname in ('company_continuity_my_access', 'company_continuity_list', 'company_continuity_get',
                       'company_continuity_create', 'company_continuity_update', 'company_continuity_transition',
                       'company_continuity_assign', 'company_continuity_note_add', 'company_continuity_notes_for',
                       'company_continuity_events_for', 'company_customer_history', 'company_team_performance');
  if v_n <> 12 then
    raise exception '146: الدوال العامة ليست 12 SECURITY DEFINER (وجد %)', v_n;
  end if;

  -- (ب) لا دالة عامة جديدة تقبل company_id معاملًا إطلاقًا.
  select coalesce(array_agg(p.proname), '{}') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('company_continuity_my_access', 'company_continuity_list', 'company_continuity_get',
                       'company_continuity_create', 'company_continuity_update', 'company_continuity_transition',
                       'company_continuity_assign', 'company_continuity_note_add', 'company_continuity_notes_for',
                       'company_continuity_events_for', 'company_customer_history', 'company_team_performance')
     and pg_get_function_identity_arguments(p.oid) like '%company_id%';
  if cardinality(v_bad) > 0 then
    raise exception '146: دوال تقبل company_id معاملًا: %', v_bad;
  end if;

  -- (ج) لا منح مباشرة على الدوال الداخلية لأي دور.
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public' and routine_name like '_company_continuity\_%'
                and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) then
    raise exception '146: منح مباشرة على دوال _company_continuity الداخلية';
  end if;

  -- (د) لا إشارة إلى supervises() في أي جسم جديد.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public'
                 and (p.proname like 'company\_continuity\_%' or p.proname = 'company_customer_history'
                      or p.proname = 'company_team_performance'
                      or p.proname like '\_company\_continuity\_%')
                 and pg_get_functiondef(p.oid) like '%supervises(%') then
    raise exception '146: إشارة إلى supervises() في الدوال الجديدة';
  end if;

  raise notice 'OK 146: 12 دالة عامة SECURITY DEFINER، بلا معامل company_id، وبلا supervises()';
end $$;

commit;
