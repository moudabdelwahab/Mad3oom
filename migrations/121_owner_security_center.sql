-- ============================================================================
-- 121 — مركز سلطة المالك وأمانه (Owner Authority & Security Control Center)
--
-- امتداد لـ053 (التحقق بخطوتين داخل القاعدة، privileged_audit، التفويض) و040 (السياقات) و117
-- (is_admin/is_platform_staff)، لا نظام موازٍ. كل قرار هنا في القاعدة؛ الواجهة تعرضه فقط.
--
-- ① جلسة التحرير: مدة نافذة التحقق بخطوتين صارت إعدادًا يحدده المالك (owner_security_policy،
--    1–240 دقيقة، الافتراضي 10 كما كان)، تُفرض في owner_step_up/step_up_fresh. كل جلسة تُسجَّل
--    (owner_step_up_sessions: البدء، الانتهاء، طريقة التحقق، IP، المتصفح، سبب الإنهاء)، وكل عملية
--    تُنفَّذ خلالها تحمل رقمها (privileged_audit.step_up_session، security_events.step_up_session).
--    رمز الاسترداد (recovery_code_hashes من 049) يفتح جلسة بدل TOTP عند فقد التطبيق، ويُستهلك.
-- ② مصفوفة الصلاحيات: كتالوج مغلق (permission_catalog) لكل إجراء تفرضه القاعدة فعلًا، وقواعد لكل دور
--    (role_permission_rules) يكتبها المالك وحده بعد التحقق. staff_write_ok(key) في سياسات RESTRICTIVE
--    على الجداول ومحفّز على profiles:
--       المالك   — مسموح دائمًا (لا يُقيَّد المالك: حماية من الإقفال)، ويشترط جلسة تحرير لما يحدده
--       admin / support — بحسب قاعدة الدور (الافتراضي = السلوك الحالي)
--       غيرهم   — لا تغيير (سياساتهم القائمة تقرر)
-- ③ سجل الأمان المركزي security_events: append-only بسلسلة SHA-256 (كل صف يحمل بصمة سابقه)،
--    لا يُعدَّل ولا يُحذف من أي دور، ويقرؤه المالك وحده. owner_verify_security_log() تعيد حساب السلسلة.
-- ④ مراقبة الدخول: محفّزان على auth.sessions (كل جلسة جديدة = دخول ناجح بـIP والمتصفح، وكل حذف =
--    خروج/إلغاء). كشف IP جديد للحساب، وIP مشترك بين أكثر من حساب (ip.shared)، وتكرار الفشل.
--    المحفّزان لا يكسران الدخول أبدًا: أي خطأ فيهما يُبتلع (EXCEPTION) ويُسجَّل تحذيرًا.
-- ⑤ الجلسات والأجهزة: قائمة جلسات حساب المالك وفريق المنصة، إلغاء جلسة، وخروج من كل الأجهزة.
-- ⑥ حماية كلمة مرور المالك وبريده: محفّز على auth.users يُبقي القيمة القديمة، ويحفظ الطلب
--    (بصمة bcrypt التي يرسلها GoTrue — لا نص كلمة مرور أبدًا)، ويطلب من دالة security-alert إرسال
--    تنبيه بالبريد برابطي موافقة/رفض. الرموز يولّدها الطرف ويحفظ بصمتها فقط. الموافقة = المالك
--    مسجَّل الدخول + تحقق بخطوتين حديث + رمز الرابط. الرفض = رمز الرابط، ويُخرج كل جلسات المالك.
-- ⑦ سجل التغييرات: كل تغيير في جداول الإعدادات والسياسة والصلاحيات بقيمه القديمة والجديدة وفاعله،
--    مع تراجع آمن (owner_rollback_change) للمالك بعد التحقق.
--
-- ما لا يفعله
--   • لا يمنح المالك أي قدرة جديدة على بيانات العملاء أو الشركات؛ عزل الشركات كما هو.
--   • لا يغيّر سياسة قائمة واحدة: يضيف سياسات RESTRICTIVE فقط (تُضيِّق ولا توسّع).
--   • لا يحفظ كلمة مرور أو رمز تحقق في أي سجل.
--
-- المتطلبات: 053، 117 (can_manage_central_wallet)، pg_net. التراجع: _rollback/121_owner_security_center.down.sql
-- ============================================================================

do $$
begin
  if to_regprocedure('public.owner_step_up(text)') is null
     or to_regprocedure('public.log_privileged(text, uuid, jsonb, jsonb)') is null then
    raise exception '121 يتطلب 053';
  end if;
  if to_regprocedure('public.can_manage_central_wallet()') is null then
    raise exception '121 يتطلب 117';
  end if;
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    raise exception '121 يتطلب pg_net (net.http_post)';
  end if;
  if to_regclass('auth.sessions') is null then
    raise exception '121 يتطلب auth.sessions (Supabase Auth)';
  end if;
end $$;


-- ============================================================================
-- 0) أدوات داخلية
-- ============================================================================

-- IP الطلب كما يضعه وسيط Supabase (أول عنوان في x-forwarded-for). استرشادي: لا تفويض عليه.
create or replace function public.request_ip()
returns inet
language plpgsql
stable
as $$
declare v text;
begin
  v := split_part(coalesce((current_setting('request.headers', true))::jsonb ->> 'x-forwarded-for', ''), ',', 1);
  return nullif(btrim(v), '')::inet;
exception when others then
  return null;
end;
$$;
revoke all on function public.request_ip() from public, anon, authenticated;

create or replace function public._platform_owner_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select a.user_id from public.platform_authority a where a.level = 'owner' order by a.granted_at limit 1;
$$;
revoke all on function public._platform_owner_id() from public, anon, authenticated;


-- ============================================================================
-- 1) سياسة الأمان — صف واحد يكتبه المالك وحده
-- ============================================================================

create table if not exists public.owner_security_policy (
  id                     int primary key default 1 check (id = 1),
  step_up_minutes        int not null default 10 check (step_up_minutes between 1 and 240),
  password_change_locked boolean not null default true,
  email_change_locked    boolean not null default true,
  login_alerts           boolean not null default true,
  shared_ip_window_days  int not null default 30 check (shared_ip_window_days between 1 and 365),
  failed_login_threshold int not null default 5 check (failed_login_threshold between 3 and 50),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users(id) on delete set null
);
insert into public.owner_security_policy (id) values (1) on conflict (id) do nothing;

comment on table public.owner_security_policy is
  'سياسة أمان المالك: مدة جلسة التحرير، قفل كلمة المرور والبريد، تنبيهات الدخول. تُكتب من owner_set_security_policy() وحدها.';

alter table public.owner_security_policy enable row level security;
drop policy if exists owner_security_policy_select on public.owner_security_policy;
create policy owner_security_policy_select on public.owner_security_policy
  for select to authenticated using (public.is_platform_owner());
revoke all on table public.owner_security_policy from public, anon, authenticated;
grant select on table public.owner_security_policy to authenticated;

create or replace function public._security_policy()
returns public.owner_security_policy
language sql
stable
security definer
set search_path to 'public'
as $$
  select p from public.owner_security_policy p where p.id = 1;
$$;
revoke all on function public._security_policy() from public, anon, authenticated;


-- ============================================================================
-- 2) سجل الأمان المركزي — append-only بسلسلة بصمات
-- ============================================================================

create table if not exists public.security_events (
  id               bigint generated always as identity primary key,
  at               timestamptz not null default now(),
  event_type       text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  severity         text not null default 'info' check (severity in ('info', 'notice', 'warning', 'critical')),
  actor_id         uuid,
  actor_email      text,
  target_user_id   uuid,
  target_email     text,
  ip               inet,
  user_agent       text,
  session_id       text,
  step_up_session  bigint,
  details          jsonb not null default '{}'::jsonb,
  source           text not null default 'db' check (source in ('db', 'edge', 'client_report')),
  prev_hash        text,
  hash             text not null
);

create index if not exists security_events_at on public.security_events (at desc);
create index if not exists security_events_type on public.security_events (event_type, at desc);
create index if not exists security_events_ip on public.security_events (ip, at desc) where ip is not null;
create index if not exists security_events_target on public.security_events (target_user_id, at desc);
create index if not exists security_events_target_email on public.security_events (lower(target_email), at desc);

comment on table public.security_events is
  'سجل الأمان المركزي. لا يُعدَّل ولا يُحذف (محفّز + لا صلاحيات). hash = sha256(prev_hash|محتوى الصف): '
  'أي تعديل مباشر بصلاحية superuser يكسر السلسلة وتكشفه owner_verify_security_log().';

alter table public.security_events enable row level security;
drop policy if exists security_events_select_owner on public.security_events;
create policy security_events_select_owner on public.security_events
  for select to authenticated using (public.owner_capability('owner_only'));
revoke all on table public.security_events from public, anon, authenticated, service_role;
grant select on table public.security_events to authenticated;
-- الدوال الطرفية (security-alert / security-event) تضيف بمفتاح الخدمة — إضافة فقط
grant select, insert on table public.security_events to service_role;

create or replace function public._security_event_hash(e public.security_events)
returns text
language sql
immutable
set search_path to ''
as $$
  select encode(extensions.digest(concat_ws('|',
    coalesce(e.prev_hash, 'genesis'), e.id::text, to_char(e.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    e.event_type, e.severity, coalesce(e.actor_id::text, ''), coalesce(e.actor_email, ''),
    coalesce(e.target_user_id::text, ''), coalesce(e.target_email, ''), coalesce(host(e.ip), ''),
    coalesce(e.user_agent, ''), coalesce(e.session_id, ''), coalesce(e.step_up_session::text, ''),
    e.details::text, e.source), 'sha256'), 'hex');
$$;
revoke all on function public._security_event_hash(public.security_events) from public, anon, authenticated;

create or replace function public.guard_security_events()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'سجل الأمان لا يُعدَّل ولا يُحذف' using errcode = '42501';
  end if;
  -- ترتيب السلسلة: إضافة واحدة في كل لحظة
  perform pg_advisory_xact_lock(hashtext('public.security_events'));
  new.at := clock_timestamp();
  if new.source is null or new.source not in ('db', 'edge', 'client_report') then
    new.source := 'db';
  end if;
  new.details := coalesce(new.details, '{}'::jsonb);
  select e.hash into new.prev_hash from public.security_events e order by e.id desc limit 1;
  new.hash := public._security_event_hash(new);
  return new;
end;
$$;
revoke all on function public.guard_security_events() from public, anon, authenticated;

drop trigger if exists trg_security_events_chain on public.security_events;
create trigger trg_security_events_chain
  before insert or update or delete on public.security_events
  for each row execute function public.guard_security_events();

drop trigger if exists trg_security_events_no_truncate on public.security_events;
create trigger trg_security_events_no_truncate
  before truncate on public.security_events
  for each statement execute function public.guard_security_events();

-- الإضافة الداخلية. الفاعل والـIP والمتصفح من الطلب نفسه، لا من المنادي.
create or replace function public._security_event(
  p_type text, p_severity text, p_target uuid, p_details jsonb default '{}'::jsonb,
  p_ip inet default null, p_user_agent text default null, p_session text default null
)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id bigint;
  v_actor uuid := auth.uid();
begin
  insert into public.security_events
    (event_type, severity, actor_id, actor_email, target_user_id, target_email, ip, user_agent,
     session_id, step_up_session, details, source)
  values
    (p_type, coalesce(p_severity, 'info'), v_actor,
     (select u.email from auth.users u where u.id = v_actor),
     p_target, (select u.email from auth.users u where u.id = p_target),
     coalesce(p_ip, public.request_ip()), coalesce(p_user_agent, public.request_user_agent()),
     coalesce(p_session, public._jwt_session_id()),
     (select s.session_ref from public.privileged_step_ups s
       where s.user_id = v_actor and s.expires_at > now()
         and s.session_id is not distinct from public._jwt_session_id()),
     coalesce(p_details, '{}'::jsonb), 'db')
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public._security_event(text, text, uuid, jsonb, inet, text, text) from public, anon, authenticated;

-- رفض مُسجَّل: الدوال الجديدة تُعيد {ok:false} بدل الاستثناء عند الرفض حتى يبقى أثر المحاولة
-- (الاستثناء كان سيُلغي السطر مع المعاملة). تكرار نفس الفاعل/الإجراء في دقيقة لا يُسجَّل ثانية.
create or replace function public._deny(p_action text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.security_events e
                  where e.event_type = 'access.denied' and e.at > now() - interval '1 minute'
                    and e.actor_id is not distinct from auth.uid() and e.details ->> 'action' = p_action) then
    perform public._security_event('access.denied', 'warning', auth.uid(),
      jsonb_build_object('action', p_action, 'reason', p_reason));
  end if;
  return jsonb_build_object('ok', false, 'error', p_reason);
end;
$$;
revoke all on function public._deny(text, text) from public, anon, authenticated;

create or replace function public.owner_verify_security_log()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  r       public.security_events;
  v_prev  text;
  v_count bigint := 0;
begin
  if not public.owner_capability('owner_only') then
    raise exception 'لمالك المنصة وحده، داخل واجهته' using errcode = '42501';
  end if;
  for r in select * from public.security_events order by id loop
    v_count := v_count + 1;
    if r.prev_hash is distinct from v_prev or r.hash <> public._security_event_hash(r) then
      return jsonb_build_object('ok', false, 'checked', v_count, 'broken_at', r.id);
    end if;
    v_prev := r.hash;
  end loop;
  return jsonb_build_object('ok', true, 'checked', v_count, 'head', v_prev);
end;
$$;
revoke all on function public.owner_verify_security_log() from public, anon;
grant execute on function public.owner_verify_security_log() to authenticated;


-- ============================================================================
-- 3) جلسة التحرير (step-up) — مدة من السياسة، سجل لكل جلسة، ورمز الاسترداد
-- ============================================================================

create table if not exists public.owner_step_up_sessions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  session_id   text,
  method       text not null check (method in ('totp', 'recovery_code')),
  started_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  ended_at     timestamptz,
  end_reason   text check (end_reason in ('manual', 'replaced', 'policy_changed')),
  ip           inet,
  user_agent   text
);
create index if not exists owner_step_up_sessions_user on public.owner_step_up_sessions (user_id, started_at desc);

comment on table public.owner_step_up_sessions is
  'كل جلسة تحرير للمالك. لا تُعدَّل إلا ended_at/end_reason من دوال 121.';

alter table public.owner_step_up_sessions enable row level security;
drop policy if exists owner_step_up_sessions_select on public.owner_step_up_sessions;
create policy owner_step_up_sessions_select on public.owner_step_up_sessions
  for select to authenticated using (user_id = auth.uid() and public.is_platform_owner());
revoke all on table public.owner_step_up_sessions from public, anon, authenticated;
grant select on table public.owner_step_up_sessions to authenticated;

alter table public.privileged_step_ups add column if not exists session_ref bigint;
alter table public.privileged_step_ups add column if not exists method text;
alter table public.privileged_audit add column if not exists step_up_session bigint;

-- log_privileged (053) + رقم جلسة التحرير السارية
create or replace function public.log_privileged(
  p_action text, p_target uuid, p_old jsonb, p_new jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ref bigint;
begin
  if auth.uid() is not null then
    select s.session_ref into v_ref from public.privileged_step_ups s
     where s.user_id = auth.uid() and s.expires_at > now()
       and s.session_id is not distinct from public._jwt_session_id();
  end if;
  insert into public.privileged_audit
    (actor_id, actor_tier, action, target_user_id, old_value, new_value, context, step_up, source, user_agent,
     step_up_session)
  values
    (auth.uid(),
     public.account_tier(auth.uid()),
     p_action, p_target, p_old, p_new,
     public.active_context(),
     case when auth.uid() is null then null else public.step_up_fresh() end,
     case when auth.uid() is null then 'system' else 'session' end,
     public.request_user_agent(),
     v_ref);
end;
$$;
revoke all on function public.log_privileged(text, uuid, jsonb, jsonb) from public, anon, authenticated;

-- owner_step_up (053) بمدة السياسة، ورمز استرداد بديلًا عن TOTP. نفس حدّ المحاولات ونفس رفض إعادة الرمز.
create or replace function public.owner_step_up(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  v_secret  text;
  v_hashes  text[];
  v_key     bytea;
  v_rl      public.twofa_rate_limits%rowtype;
  v_now     timestamptz := now();
  v_counter bigint := floor(extract(epoch from now()) / 30)::bigint;
  v_last    bigint;
  v_match   bigint;
  v_fails   int;
  v_raw     text := btrim(coalesce(p_code, ''));
  v_code    text := regexp_replace(coalesce(p_code, ''), '\s', '', 'g');
  v_method  text;
  v_minutes int := coalesce((public._security_policy()).step_up_minutes, 10);
  v_expires timestamptz;
  v_ref     bigint;
  w         int;
begin
  if v_uid is null or not public.is_platform_owner() then
    raise exception 'التحقق بخطوتين لعمليات المالك متاح لمالك المنصة وحده' using errcode = '42501';
  end if;

  select s.totp_secret, s.recovery_code_hashes into v_secret, v_hashes
    from public.user_mfa_secrets s where s.user_id = v_uid;
  if v_secret is null or btrim(v_secret) = '' then
    return jsonb_build_object('verified', false, 'error', 'mfa_not_enrolled');
  end if;

  select * into v_rl from public.twofa_rate_limits r where r.user_id = v_uid;
  if v_rl.locked_until is not null and v_rl.locked_until > v_now then
    return jsonb_build_object('verified', false, 'error', 'too_many_attempts',
      'retry_after_seconds', ceil(extract(epoch from v_rl.locked_until - v_now)));
  end if;

  if v_code ~ '^[0-9]{6}$' then
    v_key := public._base32_decode(v_secret);
    select s.last_counter into v_last from public.privileged_step_ups s where s.user_id = v_uid;
    for w in -1 .. 1 loop
      if public._totp_code(v_key, v_counter + w) = v_code
         and v_counter + w > coalesce(v_last, 0) then
        v_match := v_counter + w;
        v_method := 'totp';
        exit;
      end if;
    end loop;
  elsif length(v_raw) >= 8 and public.hash_recovery_code(v_raw) = any (coalesce(v_hashes, '{}')) then
    -- رمز استرداد: يُستهلك (لا يُعاد)، والعدّاد لا يتغيّر
    update public.user_mfa_secrets
       set recovery_code_hashes = array_remove(recovery_code_hashes, public.hash_recovery_code(v_raw)),
           updated_at = v_now
     where user_id = v_uid;
    select coalesce(s.last_counter, 0) into v_match from public.privileged_step_ups s where s.user_id = v_uid;
    v_match := coalesce(v_match, 0);
    v_method := 'recovery_code';
  end if;

  if v_method is null then
    v_fails := case when v_rl.window_start is not null and v_now - v_rl.window_start <= interval '10 minutes'
                    then coalesce(v_rl.failed_attempts, 0) else 0 end + 1;
    insert into public.twofa_rate_limits as r (user_id, failed_attempts, window_start, locked_until)
    values (v_uid, v_fails, v_now,
            case when v_fails >= 5 then v_now + interval '15 minutes' end)
    on conflict (user_id) do update
      set failed_attempts = excluded.failed_attempts,
          window_start    = case when r.window_start is not null and v_now - r.window_start <= interval '10 minutes'
                                 then r.window_start else v_now end,
          locked_until    = excluded.locked_until;
    perform public.log_privileged('step_up.failed', v_uid, null, jsonb_build_object('attempts', v_fails));
    perform public._security_event('step_up.failed', case when v_fails >= 5 then 'critical' else 'warning' end,
      v_uid, jsonb_build_object('attempts', v_fails, 'locked', v_fails >= 5));
    return jsonb_build_object('verified', false, 'error', 'invalid_code');
  end if;

  insert into public.twofa_rate_limits as r (user_id, failed_attempts, window_start, locked_until)
  values (v_uid, 0, v_now, null)
  on conflict (user_id) do update set failed_attempts = 0, window_start = v_now, locked_until = null;

  v_expires := v_now + make_interval(mins => v_minutes);

  update public.owner_step_up_sessions
     set ended_at = v_now, end_reason = 'replaced'
   where user_id = v_uid and ended_at is null and expires_at > v_now;

  insert into public.owner_step_up_sessions (user_id, session_id, method, started_at, expires_at, ip, user_agent)
  values (v_uid, public._jwt_session_id(), v_method, v_now, v_expires, public.request_ip(), public.request_user_agent())
  returning id into v_ref;

  insert into public.privileged_step_ups as s (user_id, session_id, verified_at, expires_at, last_counter, session_ref, method)
  values (v_uid, public._jwt_session_id(), v_now, v_expires, v_match, v_ref, v_method)
  on conflict (user_id) do update
    set session_id = excluded.session_id, verified_at = excluded.verified_at,
        expires_at = excluded.expires_at, last_counter = excluded.last_counter,
        session_ref = excluded.session_ref, method = excluded.method;

  perform public.log_privileged('step_up.verified', v_uid, null,
    jsonb_build_object('expires_at', v_expires, 'method', v_method, 'minutes', v_minutes));
  perform public._security_event('step_up.verified',
    case when v_method = 'recovery_code' then 'critical' else 'notice' end, v_uid,
    jsonb_build_object('method', v_method, 'minutes', v_minutes, 'expires_at', v_expires,
                       'recovery_codes_left', case when v_method = 'recovery_code'
                         then (select coalesce(array_length(recovery_code_hashes, 1), 0)
                                 from public.user_mfa_secrets where user_id = v_uid) end));
  if v_method = 'recovery_code' then
    perform public._security_alert_dispatch('recovery_code_used', jsonb_build_object('step_up_session', v_ref));
  end if;
  return jsonb_build_object('verified', true, 'expires_at', v_expires, 'method', v_method,
                            'minutes', v_minutes, 'session', v_ref);
end;
$$;
revoke all on function public.owner_step_up(text) from public, anon;
grant execute on function public.owner_step_up(text) to authenticated;

-- إنهاء جلسة التحرير قبل موعدها
create or replace function public.owner_end_step_up()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_ref bigint;
begin
  if not public.is_platform_owner() then
    return public._deny('step_up.end', 'forbidden');
  end if;
  select s.session_ref into v_ref from public.privileged_step_ups s where s.user_id = auth.uid();
  update public.privileged_step_ups set expires_at = now() where user_id = auth.uid() and expires_at > now();
  update public.owner_step_up_sessions set ended_at = now(), end_reason = 'manual'
   where user_id = auth.uid() and ended_at is null and expires_at > now();
  perform public._security_event('step_up.ended', 'info', auth.uid(), jsonb_build_object('session', v_ref));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.owner_end_step_up() from public, anon;
grant execute on function public.owner_end_step_up() to authenticated;

-- حالة المالك الأمنية (053) + السياسة والجلسة ورموز الاسترداد المتبقية
create or replace function public.owner_security_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_pol public.owner_security_policy := public._security_policy();
  v_s   public.privileged_step_ups;
begin
  if not public.is_platform_owner() then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  select * into v_s from public.privileged_step_ups s where s.user_id = auth.uid();
  return jsonb_build_object(
    'mfa_enrolled', exists (select 1 from public.user_mfa_secrets s where s.user_id = auth.uid()),
    'step_up_fresh', public.step_up_fresh(),
    'step_up_expires_at', case when public.step_up_fresh() then v_s.expires_at end,
    'step_up_seconds_left', case when public.step_up_fresh()
                              then greatest(0, floor(extract(epoch from v_s.expires_at - now())))::int end,
    'step_up_method', case when public.step_up_fresh() then v_s.method end,
    'step_up_session', case when public.step_up_fresh() then v_s.session_ref end,
    'step_up_minutes', v_pol.step_up_minutes,
    'recovery_codes_left', (select coalesce(array_length(m.recovery_code_hashes, 1), 0)
                              from public.user_mfa_secrets m where m.user_id = auth.uid()),
    'in_owner_context', public.owner_capability('owner_only'),
    'policy', jsonb_build_object(
      'step_up_minutes', v_pol.step_up_minutes,
      'password_change_locked', v_pol.password_change_locked,
      'email_change_locked', v_pol.email_change_locked,
      'login_alerts', v_pol.login_alerts,
      'shared_ip_window_days', v_pol.shared_ip_window_days,
      'failed_login_threshold', v_pol.failed_login_threshold,
      'updated_at', v_pol.updated_at)
  );
end;
$$;
revoke all on function public.owner_security_status() from public, anon;
grant execute on function public.owner_security_status() to authenticated;

-- سجل جلسات التحرير وعدد العمليات في كل منها
create or replace function public.owner_step_up_history(p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.owner_capability('owner_only') then
    raise exception 'لمالك المنصة وحده، داخل واجهته' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.started_at desc)
      from (select s.id, s.method, s.started_at, s.expires_at, s.ended_at,
                   coalesce(s.end_reason, case when s.expires_at <= now() then 'expired' end) as end_reason,
                   s.expires_at > now() and s.ended_at is null as active,
                   host(s.ip) as ip, s.user_agent,
                   (select count(*) from public.privileged_audit a where a.step_up_session = s.id
                      and a.action not like 'step_up.%') +
                   (select count(*) from public.security_events e where e.step_up_session = s.id
                      and e.event_type not like 'step_up.%') as operations,
                   (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action) order by a.at), '[]')
                      from public.privileged_audit a where a.step_up_session = s.id
                       and a.action not like 'step_up.%') as audit_actions,
                   (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'action', e.event_type) order by e.at), '[]')
                      from public.security_events e where e.step_up_session = s.id
                       and e.event_type not like 'step_up.%') as security_actions
              from public.owner_step_up_sessions s
             where s.user_id = auth.uid()
             order by s.started_at desc
             limit least(greatest(coalesce(p_limit, 30), 1), 200)) x), '[]'::jsonb);
end;
$$;
revoke all on function public.owner_step_up_history(int) from public, anon;
grant execute on function public.owner_step_up_history(int) to authenticated;


-- ============================================================================
-- 4) مصفوفة الصلاحيات
-- ============================================================================

create table if not exists public.permission_catalog (
  key                   text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  category              text not null,
  label_ar              text not null,
  description_ar        text not null,
  enforced_on           text not null,
  default_allowed       boolean not null default true,
  owner_step_up_default boolean not null default false,
  sort_order            int not null default 100
);

comment on table public.permission_catalog is
  'كل إجراء في المصفوفة تفرضه القاعدة فعلًا (enforced_on يسمّي موضع الفرض). القائمة تُضاف بترحيل لا من الواجهة.';

insert into public.permission_catalog (key, category, label_ar, description_ar, enforced_on, default_allowed, owner_step_up_default, sort_order) values
  ('settings.manage', 'platform', 'تعديل إعدادات التشغيل', 'الإعدادات المتقدمة، ساعات العمل، توزيع التذاكر، قواعد الأتمتة، الأدوار المخصصة',
     'RLS: advanced_settings, working_hours, ticket_distribution_config, rules_engine, custom_roles', true, true, 10),
  ('status_page.manage', 'platform', 'إدارة صفحة الحالة', 'الخدمات والحوادث المعروضة للعملاء', 'RLS: services, incidents', true, true, 20),
  ('knowledge_base.manage', 'content', 'إدارة قاعدة المعرفة', 'إضافة المقالات وتعديلها وحذفها', 'RLS: knowledge_base', true, false, 30),
  ('blog.manage', 'content', 'إدارة المدوّنة', 'المقالات والتصنيفات', 'RLS: blog_posts, blog_categories', true, false, 40),
  ('tickets.reply', 'support', 'الرد على التذاكر', 'إضافة رد أو ملاحظة داخلية على تذكرة', 'RLS: ticket_replies (insert)', true, false, 50),
  ('tickets.update', 'support', 'تحديث التذاكر', 'تغيير الحالة والأولوية والمسؤول', 'RLS: tickets (update)', true, false, 60),
  ('tickets.delete', 'support', 'حذف التذاكر', 'حذف تذكرة نهائيًا', 'RLS: tickets (delete)', true, true, 70),
  ('users.ban', 'users', 'حظر الحسابات ورفع الحظر', 'تغيير ban_status / ban_until / ban_reason لحساب آخر', 'trigger: profiles', true, true, 80),
  ('users.change_role', 'users', 'تغيير رتبة الحسابات', 'تغيير profiles.role لحساب آخر', 'trigger: profiles', true, true, 90)
on conflict (key) do update set
  category = excluded.category, label_ar = excluded.label_ar, description_ar = excluded.description_ar,
  enforced_on = excluded.enforced_on, sort_order = excluded.sort_order;

alter table public.permission_catalog enable row level security;
drop policy if exists permission_catalog_read on public.permission_catalog;
create policy permission_catalog_read on public.permission_catalog
  for select to authenticated using (public.is_platform_staff() or public.is_platform_owner());
revoke all on table public.permission_catalog from public, anon, authenticated;
grant select on table public.permission_catalog to authenticated;

create table if not exists public.role_permission_rules (
  role            text not null check (role in ('platform_owner', 'admin', 'support')),
  permission      text not null references public.permission_catalog(key) on delete cascade,
  allowed         boolean not null default true,
  require_step_up boolean not null default false,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null,
  primary key (role, permission),
  -- حماية من الإقفال: المالك لا يُمنع من شيء، والتحقق بخطوتين للمالك وحده (لا آلية step-up لغيره)
  constraint role_permission_rules_owner_allowed check (role <> 'platform_owner' or allowed),
  constraint role_permission_rules_step_up_owner_only check (role = 'platform_owner' or not require_step_up)
);

comment on table public.role_permission_rules is
  'قرار المالك لكل دور × إجراء. لا صف = الافتراضي في permission_catalog. تُكتب من owner_set_role_permission() وحدها.';

alter table public.role_permission_rules enable row level security;
drop policy if exists role_permission_rules_read on public.role_permission_rules;
create policy role_permission_rules_read on public.role_permission_rules
  for select to authenticated using (public.is_platform_owner()
    or role = (select p.role from public.profiles p where p.id = auth.uid()));
revoke all on table public.role_permission_rules from public, anon, authenticated;
grant select on table public.role_permission_rules to authenticated;

-- القرار نفسه. يُستعمل في سياسات RESTRICTIVE ومحفّز profiles. يرفع استثناءً واضحًا عند الرفض
-- (hint: step_up_required | permission_denied) بدل «صفر صفوف» صامت.
create or replace function public.staff_write_ok(p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid   uuid := auth.uid();
  v_cat   public.permission_catalog;
  v_role  text;
  v_rule  public.role_permission_rules;
begin
  if v_uid is null then
    return true;                       -- ترحيل / service_role / مهمة خلفية
  end if;
  select * into v_cat from public.permission_catalog c where c.key = p_permission;
  if not found then
    raise exception 'صلاحية غير معروفة: %', p_permission using errcode = '22023';
  end if;

  if public.is_platform_owner() then
    select * into v_rule from public.role_permission_rules r
     where r.role = 'platform_owner' and r.permission = p_permission;
    if coalesce(v_rule.require_step_up, v_cat.owner_step_up_default) and not public.step_up_fresh() then
      raise exception '«%» يتطلب جلسة تحرير: تحقّق بخطوتين أولًا', v_cat.label_ar
        using errcode = '42501', hint = 'step_up_required', detail = p_permission;
    end if;
    return true;
  end if;

  select p.role into v_role from public.profiles p where p.id = v_uid;
  if v_role is null or v_role not in ('admin', 'support') then
    return true;                       -- ليس من فريق المنصة: سياساته القائمة تقرر
  end if;
  select * into v_rule from public.role_permission_rules r where r.role = v_role and r.permission = p_permission;
  if coalesce(v_rule.allowed, v_cat.default_allowed) then
    return true;
  end if;
  raise exception '«%» معطّلة لدور % بقرار مالك المنصة', v_cat.label_ar, v_role
    using errcode = '42501', hint = 'permission_denied', detail = p_permission;
end;
$$;
revoke all on function public.staff_write_ok(text) from public, anon;
grant execute on function public.staff_write_ok(text) to authenticated;

-- حالة صلاحية للواجهة قبل الإجراء (لا ترفع): هل مسموح؟ هل يلزم تحقق؟ هل الجلسة مفتوحة؟
create or replace function public.my_permission_status(p_permission text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_cat  public.permission_catalog;
  v_role text;
  v_rule public.role_permission_rules;
  v_req  boolean := false;
begin
  select * into v_cat from public.permission_catalog c where c.key = p_permission;
  if not found or auth.uid() is null then
    return jsonb_build_object('known', false, 'allowed', false);
  end if;
  if public.is_platform_owner() then
    select * into v_rule from public.role_permission_rules r where r.role = 'platform_owner' and r.permission = p_permission;
    v_req := coalesce(v_rule.require_step_up, v_cat.owner_step_up_default);
    return jsonb_build_object('known', true, 'allowed', true, 'step_up_required', v_req,
                              'step_up_fresh', public.step_up_fresh(), 'label', v_cat.label_ar);
  end if;
  select p.role into v_role from public.profiles p where p.id = auth.uid();
  select * into v_rule from public.role_permission_rules r where r.role = v_role and r.permission = p_permission;
  return jsonb_build_object('known', true,
    'allowed', case when v_role in ('admin', 'support') then coalesce(v_rule.allowed, v_cat.default_allowed) else null end,
    'step_up_required', false, 'step_up_fresh', false, 'label', v_cat.label_ar);
end;
$$;
revoke all on function public.my_permission_status(text) from public, anon;
grant execute on function public.my_permission_status(text) to authenticated;

create or replace function public.owner_permission_matrix()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.owner_capability('owner_only') then
    return public._deny('permissions.read', 'forbidden');
  end if;
  return jsonb_build_object('ok', true, 'permissions', coalesce((
    select jsonb_agg(jsonb_build_object(
             'key', c.key, 'category', c.category, 'label', c.label_ar, 'description', c.description_ar,
             'enforced_on', c.enforced_on,
             'owner_step_up', coalesce(o.require_step_up, c.owner_step_up_default),
             'admin', coalesce(a.allowed, c.default_allowed),
             'support', coalesce(s.allowed, c.default_allowed),
             'default_allowed', c.default_allowed, 'owner_step_up_default', c.owner_step_up_default,
             'updated_at', greatest(o.updated_at, a.updated_at, s.updated_at))
           order by c.sort_order)
      from public.permission_catalog c
      left join public.role_permission_rules o on o.permission = c.key and o.role = 'platform_owner'
      left join public.role_permission_rules a on a.permission = c.key and a.role = 'admin'
      left join public.role_permission_rules s on s.permission = c.key and s.role = 'support'), '[]'::jsonb));
end;
$$;
revoke all on function public.owner_permission_matrix() from public, anon;
grant execute on function public.owner_permission_matrix() to authenticated;

-- p_field: 'allowed' (admin/support) أو 'require_step_up' (platform_owner)
create or replace function public.owner_set_role_permission(
  p_role text, p_permission text, p_field text, p_value boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old public.role_permission_rules;
  v_new public.role_permission_rules;
begin
  if not public.owner_capability('owner_only') then
    return public._deny('permissions.set', 'forbidden');
  end if;
  if not public.step_up_fresh() then
    return jsonb_build_object('ok', false, 'error', 'step_up_required');
  end if;
  if p_role not in ('platform_owner', 'admin', 'support')
     or not exists (select 1 from public.permission_catalog c where c.key = p_permission)
     or p_value is null
     or (p_role = 'platform_owner' and p_field <> 'require_step_up')
     or (p_role <> 'platform_owner' and p_field <> 'allowed') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select * into v_old from public.role_permission_rules r where r.role = p_role and r.permission = p_permission;
  insert into public.role_permission_rules as r (role, permission, allowed, require_step_up, updated_at, updated_by)
  values (p_role, p_permission,
          case when p_field = 'allowed' then p_value else true end,
          case when p_field = 'require_step_up' then p_value else false end,
          now(), auth.uid())
  on conflict (role, permission) do update
    set allowed = case when p_field = 'allowed' then p_value else r.allowed end,
        require_step_up = case when p_field = 'require_step_up' then p_value else r.require_step_up end,
        updated_at = now(), updated_by = auth.uid()
  returning * into v_new;

  perform public.log_privileged('permission.set', null,
    case when v_old.role is null then null else to_jsonb(v_old) end, to_jsonb(v_new));
  perform public._security_event('permission.changed', 'notice', null,
    jsonb_build_object('role', p_role, 'permission', p_permission, 'field', p_field,
                       'old', case when v_old.role is null then null
                                   when p_field = 'allowed' then to_jsonb(v_old.allowed)
                                   else to_jsonb(v_old.require_step_up) end,
                       'new', p_value));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.owner_set_role_permission(text, text, text, boolean) from public, anon;
grant execute on function public.owner_set_role_permission(text, text, text, boolean) to authenticated;

-- ── الفرض: سياسات RESTRICTIVE (تضيِّق فقط؛ السياسات القائمة تبقى كما هي) ──────────
do $$
declare
  r record;
  v_cmd text;
begin
  for r in select * from (values
      ('advanced_settings', 'settings.manage'), ('working_hours', 'settings.manage'),
      ('ticket_distribution_config', 'settings.manage'), ('rules_engine', 'settings.manage'),
      ('custom_roles', 'settings.manage'), ('services', 'status_page.manage'),
      ('incidents', 'status_page.manage'), ('knowledge_base', 'knowledge_base.manage'),
      ('blog_posts', 'blog.manage'), ('blog_categories', 'blog.manage')) as t(tbl, perm)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise exception '121: الجدول % غير موجود', r.tbl;
    end if;
    foreach v_cmd in array array['insert', 'update', 'delete'] loop
      execute format('drop policy if exists %I on public.%I', 'perm_' || v_cmd, r.tbl);
      if v_cmd = 'insert' then
        execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.staff_write_ok(%L))',
                       'perm_insert', r.tbl, r.perm);
      else
        execute format('create policy %I on public.%I as restrictive for %s to authenticated using (public.staff_write_ok(%L))',
                       'perm_' || v_cmd, r.tbl, v_cmd, r.perm);
      end if;
    end loop;
  end loop;
end $$;

drop policy if exists perm_reply on public.ticket_replies;
create policy perm_reply on public.ticket_replies as restrictive for insert to authenticated
  with check (public.staff_write_ok('tickets.reply'));
drop policy if exists perm_update on public.tickets;
create policy perm_update on public.tickets as restrictive for update to authenticated
  using (public.staff_write_ok('tickets.update'));
drop policy if exists perm_delete on public.tickets;
create policy perm_delete on public.tickets as restrictive for delete to authenticated
  using (public.staff_write_ok('tickets.delete'));

-- الحظر والرتبة على حساب آخر — محفّز (سياسة UPDATE كانت ستشمل كل تعديل للملف)
create or replace function public.enforce_staff_profile_permissions()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or auth.uid() = old.id then
    return new;
  end if;
  if (new.ban_status, new.ban_until, new.ban_reason) is distinct from (old.ban_status, old.ban_until, old.ban_reason) then
    perform public.staff_write_ok('users.ban');
  end if;
  if new.role is distinct from old.role then
    perform public.staff_write_ok('users.change_role');
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_staff_profile_permissions() from public, anon, authenticated;

drop trigger if exists trg_enforce_staff_profile_permissions on public.profiles;
create trigger trg_enforce_staff_profile_permissions
  before update of ban_status, ban_until, ban_reason, role on public.profiles
  for each row execute function public.enforce_staff_profile_permissions();


-- ============================================================================
-- 5) سجل التغييرات القديمة/الجديدة + التراجع
-- ============================================================================

create table if not exists public.settings_change_history (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  actor_id        uuid,
  actor_tier      text,
  table_name      text not null,
  row_key         text,
  op              text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  old_row         jsonb,
  new_row         jsonb,
  step_up_session bigint,
  rolled_back_at  timestamptz,
  rolled_back_by  uuid,
  rollback_of     bigint
);
create index if not exists settings_change_history_at on public.settings_change_history (at desc);

alter table public.settings_change_history enable row level security;
drop policy if exists settings_change_history_owner on public.settings_change_history;
create policy settings_change_history_owner on public.settings_change_history
  for select to authenticated using (public.owner_capability('owner_only'));
revoke all on table public.settings_change_history from public, anon, authenticated;
grant select on table public.settings_change_history to authenticated;

create or replace function public.guard_settings_history()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  -- لا حذف أبدًا؛ والتعديل الوحيد المسموح علامة التراجع من owner_rollback_change
  if tg_op = 'DELETE' or current_setting('app.settings_rollback', true) is distinct from 'on'
     or (to_jsonb(new) - array['rolled_back_at', 'rolled_back_by']) is distinct from
        (to_jsonb(old) - array['rolled_back_at', 'rolled_back_by']) then
    raise exception 'سجل التغييرات لا يُعدَّل ولا يُحذف' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_settings_history() from public, anon, authenticated;

drop trigger if exists trg_settings_history_immutable on public.settings_change_history;
create trigger trg_settings_history_immutable
  before update or delete on public.settings_change_history
  for each row execute function public.guard_settings_history();

create or replace function public.record_settings_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_ref bigint;
begin
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new;
  end if;
  if auth.uid() is not null then
    select s.session_ref into v_ref from public.privileged_step_ups s
     where s.user_id = auth.uid() and s.expires_at > now();
  end if;
  insert into public.settings_change_history
    (actor_id, actor_tier, table_name, row_key, op, old_row, new_row, step_up_session, rollback_of)
  values
    (auth.uid(), public.account_tier(auth.uid()), tg_table_name,
     coalesce(v_new ->> 'id', v_old ->> 'id',
              concat_ws(':', coalesce(v_new, v_old) ->> 'role', coalesce(v_new, v_old) ->> 'permission')),
     tg_op, v_old, v_new, v_ref, nullif(current_setting('app.rollback_of', true), '')::bigint);
  return coalesce(new, old);
end;
$$;
revoke all on function public.record_settings_change() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['advanced_settings', 'working_hours', 'ticket_distribution_config', 'rules_engine',
                           'custom_roles', 'owner_security_policy', 'role_permission_rules'] loop
    execute format('drop trigger if exists trg_record_settings_change on public.%I', t);
    execute format('create trigger trg_record_settings_change after insert or update or delete on public.%I '
                   'for each row execute function public.record_settings_change()', t);
  end loop;
end $$;

-- التراجع عن تغيير واحد. الجداول ذات العمود id فقط (role_permission_rules تُعاد من المصفوفة نفسها).
create or replace function public.owner_rollback_change(p_change bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  h       public.settings_change_history;
  v_cols  text;
  v_tbl   regclass;
begin
  if not public.owner_capability('owner_only') then
    return public._deny('settings.rollback', 'forbidden');
  end if;
  if not public.step_up_fresh() then
    return jsonb_build_object('ok', false, 'error', 'step_up_required');
  end if;
  select * into h from public.settings_change_history where id = p_change for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if h.rolled_back_at is not null then return jsonb_build_object('ok', false, 'error', 'already_rolled_back'); end if;
  if h.table_name not in ('advanced_settings', 'working_hours', 'ticket_distribution_config', 'rules_engine',
                          'custom_roles', 'owner_security_policy') then
    return jsonb_build_object('ok', false, 'error', 'not_reversible');
  end if;
  v_tbl := ('public.' || quote_ident(h.table_name))::regclass;

  perform set_config('app.rollback_of', h.id::text, true);
  if h.op = 'INSERT' then
    execute format('delete from %s t where t.id::text = $1', v_tbl) using h.new_row ->> 'id';
  elsif h.op = 'DELETE' then
    execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', v_tbl, v_tbl) using h.old_row;
  else
    select string_agg(format('%I = r.%I', k, k), ', ') into v_cols
      from jsonb_object_keys(h.old_row) k
     where k not in ('id', 'updated_at')
       and exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = h.table_name and c.column_name = k
                      and c.is_generated = 'NEVER' and c.identity_generation is null);
    execute format('update %s t set %s from jsonb_populate_record(null::%s, $1) r where t.id = r.id',
                   v_tbl, v_cols, v_tbl) using h.old_row;
  end if;
  perform set_config('app.rollback_of', '', true);

  perform set_config('app.settings_rollback', 'on', true);
  update public.settings_change_history set rolled_back_at = now(), rolled_back_by = auth.uid() where id = h.id;
  perform set_config('app.settings_rollback', 'off', true);

  perform public._security_event('settings.rolled_back', 'notice', null,
    jsonb_build_object('change', h.id, 'table', h.table_name, 'row', h.row_key, 'op', h.op));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.owner_rollback_change(bigint) from public, anon;
grant execute on function public.owner_rollback_change(bigint) to authenticated;

create or replace function public.owner_change_history(p_table text default null, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.owner_capability('owner_only') then
    raise exception 'لمالك المنصة وحده، داخل واجهته' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'total', (select count(*) from public.settings_change_history h where p_table is null or h.table_name = p_table),
    'items', coalesce((select jsonb_agg(row_to_json(x) order by x.at desc) from (
        select h.id, h.at, h.actor_id, (select u.email from auth.users u where u.id = h.actor_id) as actor_email,
               h.actor_tier, h.table_name, h.row_key, h.op, h.old_row, h.new_row, h.step_up_session,
               h.rolled_back_at, h.rollback_of,
               h.table_name in ('advanced_settings', 'working_hours', 'ticket_distribution_config', 'rules_engine',
                                'custom_roles', 'owner_security_policy') and h.rolled_back_at is null as reversible
          from public.settings_change_history h
         where p_table is null or h.table_name = p_table
         order by h.at desc
         limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb));
end;
$$;
revoke all on function public.owner_change_history(text, int, int) from public, anon;
grant execute on function public.owner_change_history(text, int, int) to authenticated;


-- ============================================================================
-- 6) كتابة سياسة الأمان
-- ============================================================================

create or replace function public.owner_set_security_policy(p_policy jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old public.owner_security_policy := public._security_policy();
  v_new public.owner_security_policy;
  v_minutes int;
begin
  if not public.owner_capability('owner_only') then
    return public._deny('security_policy.set', 'forbidden');
  end if;
  if not public.step_up_fresh() then
    return jsonb_build_object('ok', false, 'error', 'step_up_required');
  end if;
  if p_policy is null or jsonb_typeof(p_policy) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_policy) k
                 where k not in ('step_up_minutes', 'password_change_locked', 'email_change_locked',
                                 'login_alerts', 'shared_ip_window_days', 'failed_login_threshold')) then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  v_minutes := coalesce((p_policy ->> 'step_up_minutes')::int, v_old.step_up_minutes);
  if v_minutes not between 1 and 240
     or coalesce((p_policy ->> 'shared_ip_window_days')::int, v_old.shared_ip_window_days) not between 1 and 365
     or coalesce((p_policy ->> 'failed_login_threshold')::int, v_old.failed_login_threshold) not between 3 and 50 then
    return jsonb_build_object('ok', false, 'error', 'out_of_range');
  end if;

  update public.owner_security_policy set
    step_up_minutes        = v_minutes,
    password_change_locked = coalesce((p_policy ->> 'password_change_locked')::boolean, password_change_locked),
    email_change_locked    = coalesce((p_policy ->> 'email_change_locked')::boolean, email_change_locked),
    login_alerts           = coalesce((p_policy ->> 'login_alerts')::boolean, login_alerts),
    shared_ip_window_days  = coalesce((p_policy ->> 'shared_ip_window_days')::int, shared_ip_window_days),
    failed_login_threshold = coalesce((p_policy ->> 'failed_login_threshold')::int, failed_login_threshold),
    updated_at = now(), updated_by = auth.uid()
  where id = 1
  returning * into v_new;

  -- تقصير المدة يسري على الجلسة المفتوحة فورًا (لا تبقى أطول من السياسة الجديدة)
  if v_new.step_up_minutes < v_old.step_up_minutes then
    update public.privileged_step_ups
       set expires_at = least(expires_at, verified_at + make_interval(mins => v_new.step_up_minutes))
     where expires_at > now();
    update public.owner_step_up_sessions
       set expires_at = least(expires_at, started_at + make_interval(mins => v_new.step_up_minutes))
     where ended_at is null and expires_at > now();
  end if;

  perform public.log_privileged('security_policy.set', null, to_jsonb(v_old), to_jsonb(v_new));
  perform public._security_event('security_policy.changed',
    case when (v_old.password_change_locked and not v_new.password_change_locked)
           or (v_old.email_change_locked and not v_new.email_change_locked) then 'warning' else 'notice' end,
    null, jsonb_build_object('old', to_jsonb(v_old) - array['updated_by'], 'new', to_jsonb(v_new) - array['updated_by']));
  return jsonb_build_object('ok', true, 'policy', to_jsonb(v_new) - array['updated_by']);
end;
$$;
revoke all on function public.owner_set_security_policy(jsonb) from public, anon;
grant execute on function public.owner_set_security_policy(jsonb) to authenticated;


-- ============================================================================
-- 7) التنبيهات بالبريد — طلب غير متزامن لدالة security-alert (نمط 089/114)
-- ============================================================================

insert into public.internal_service_secrets (key, value)
values ('security_alert_internal', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- لا تحمل أي سر للمستخدم: النوع ومعرّفات فقط. الدالة الطرفية تقرأ التفاصيل بنفسها.
create or replace function public._security_alert_dispatch(p_kind text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_secret text;
begin
  select value into v_secret from public.internal_service_secrets where key = 'security_alert_internal';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/security-alert',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Internal-Secret', v_secret),
    body := jsonb_build_object('kind', p_kind) || coalesce(p_payload, '{}'::jsonb),
    timeout_milliseconds := 5000);
exception when others then
  raise warning 'security alert dispatch failed: %', sqlerrm;
end;
$$;
revoke all on function public._security_alert_dispatch(text, jsonb) from public, anon, authenticated;


-- ============================================================================
-- 8) مراقبة الدخول — auth.sessions
-- ============================================================================

create table if not exists public.ip_geo_cache (
  ip           inet primary key,
  country      text,
  country_code text,
  region       text,
  city         text,
  org          text,
  looked_up_at timestamptz not null default now(),
  source       text
);
alter table public.ip_geo_cache enable row level security;
drop policy if exists ip_geo_cache_owner on public.ip_geo_cache;
create policy ip_geo_cache_owner on public.ip_geo_cache
  for select to authenticated using (public.owner_capability('owner_only'));
revoke all on table public.ip_geo_cache from public, anon, authenticated;
grant select on table public.ip_geo_cache to authenticated;
grant select, insert, update on table public.ip_geo_cache to service_role;

-- عناوين بلا موقع تقريبي بعد. تنادَى من security-event بجلسة المالك نفسه: نجاحها = تفويض الإثراء.
create or replace function public.owner_geo_pending(p_limit int default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.owner_capability('owner_only') then
    raise exception 'لمالك المنصة وحده، داخل واجهته' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x.ip) from (
      select distinct host(e.ip) as ip
        from public.security_events e
        left join public.ip_geo_cache g on g.ip = e.ip
       where e.ip is not null and e.at > now() - interval '90 days'
         and (g.ip is null or g.looked_up_at < now() - interval '30 days')
       limit least(greatest(coalesce(p_limit, 25), 1), 50)) x), '[]'::jsonb);
end;
$$;
revoke all on function public.owner_geo_pending(int) from public, anon;
grant execute on function public.owner_geo_pending(int) to authenticated;

create or replace function public.on_auth_session_created()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email   text;
  v_pol     public.owner_security_policy := public._security_policy();
  v_new_ip  boolean;
  v_others  jsonb;
  v_owner   uuid := public._platform_owner_id();
  v_sev     text := 'info';
  v_event   bigint;
begin
  select u.email into v_email from auth.users u where u.id = new.user_id;

  v_new_ip := new.ip is not null and not exists (
    select 1 from public.security_events e
     where e.event_type = 'auth.login' and e.target_user_id = new.user_id and e.ip = new.ip
       and e.at > now() - interval '180 days');

  if new.user_id = v_owner and v_new_ip then
    v_sev := 'warning';
  end if;

  insert into public.security_events (event_type, severity, actor_id, actor_email, target_user_id, target_email,
                                      ip, user_agent, session_id, details, source)
  values ('auth.login', v_sev, new.user_id, v_email, new.user_id, v_email, new.ip, new.user_agent, new.id::text,
          jsonb_build_object('new_ip', v_new_ip, 'aal', new.aal::text), 'db')
  returning id into v_event;

  -- IP مشترك: حسابات أخرى دخلت من نفس العنوان خلال نافذة السياسة. لا يعني أنهم شخص واحد.
  if new.ip is not null then
    select jsonb_agg(distinct jsonb_build_object('user_id', e.target_user_id, 'email', e.target_email))
      into v_others
      from public.security_events e
     where e.event_type = 'auth.login' and e.ip = new.ip and e.target_user_id <> new.user_id
       and e.at > now() - make_interval(days => v_pol.shared_ip_window_days);
    if v_others is not null and not exists (
         select 1 from public.security_events e
          where e.event_type = 'ip.shared' and e.ip = new.ip and e.target_user_id = new.user_id
            and e.at > now() - interval '24 hours') then
      insert into public.security_events (event_type, severity, target_user_id, target_email, ip, details, source)
      values ('ip.shared', 'notice', new.user_id, v_email, new.ip,
              jsonb_build_object('other_accounts', v_others, 'login_event', v_event,
                                 'window_days', v_pol.shared_ip_window_days), 'db');
    end if;
  end if;

  if new.user_id = v_owner and v_new_ip and v_pol.login_alerts then
    perform public._security_alert_dispatch('owner_new_login', jsonb_build_object('event_id', v_event));
  end if;
  return new;
exception when others then
  -- الدخول لا يُكسر بسبب المراقبة أبدًا
  raise warning 'security login tracking failed: %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.on_auth_session_created() from public, anon, authenticated;

create or replace function public.on_auth_session_ended()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.security_events (event_type, severity, actor_id, target_user_id, target_email, ip, user_agent,
                                      session_id, details, source)
  values ('auth.session_ended', 'info', auth.uid(), old.user_id,
          (select u.email from auth.users u where u.id = old.user_id),
          old.ip, old.user_agent, old.id::text,
          jsonb_build_object('reason', coalesce(nullif(current_setting('app.session_end_reason', true), ''), 'logout_or_expiry'),
                             'started_at', old.created_at), 'db');
  return old;
exception when others then
  raise warning 'security logout tracking failed: %', sqlerrm;
  return old;
end;
$$;
revoke all on function public.on_auth_session_ended() from public, anon, authenticated;

drop trigger if exists trg_security_session_created on auth.sessions;
create trigger trg_security_session_created
  after insert on auth.sessions
  for each row execute function public.on_auth_session_created();

drop trigger if exists trg_security_session_ended on auth.sessions;
create trigger trg_security_session_ended
  after delete on auth.sessions
  for each row execute function public.on_auth_session_ended();

-- سجل نشاط الدخول والأمان (بحث وتصفية). لا يعيد كلمات مرور ولا رموزًا — لا تُحفَظ أصلًا.
create or replace function public.owner_security_log(
  p_email text default null, p_ip text default null, p_type text default null,
  p_from timestamptz default null, p_to timestamptz default null,
  p_severity text default null, p_limit int default 50, p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_ip inet;
begin
  if not public.owner_capability('owner_only') then
    raise exception 'لمالك المنصة وحده، داخل واجهته' using errcode = '42501';
  end if;
  begin
    v_ip := nullif(btrim(coalesce(p_ip, '')), '')::inet;
  exception when others then
    return jsonb_build_object('total', 0, 'items', '[]'::jsonb, 'error', 'invalid_ip');
  end;
  return (
    with f as (
      select e.* from public.security_events e
       where (p_email is null or btrim(p_email) = ''
              or lower(e.target_email) like '%' || lower(btrim(p_email)) || '%'
              or lower(e.actor_email) like '%' || lower(btrim(p_email)) || '%')
         and (v_ip is null or e.ip = v_ip)
         and (p_type is null or btrim(p_type) = '' or e.event_type = p_type or e.event_type like p_type || '.%')
         and (p_from is null or e.at >= p_from)
         and (p_to is null or e.at <= p_to)
         and (p_severity is null or btrim(p_severity) = '' or e.severity = p_severity))
    select jsonb_build_object(
      'total', (select count(*) from f),
      'items', coalesce((select jsonb_agg(row_to_json(x) order by x.at desc) from (
          select f.id, f.at, f.event_type, f.severity, f.actor_email, f.target_user_id, f.target_email,
                 host(f.ip) as ip, f.user_agent, f.details, f.source, f.step_up_session,
                 g.country, g.country_code, g.city, g.region, g.org
            from f left join public.ip_geo_cache g on g.ip = f.ip
           order by f.at desc
           limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
  );
end;
$$;
revoke all on function public.owner_security_log(text, text, text, timestamptz, timestamptz, text, int, int) from public, anon;
grant execute on function public.owner_security_log(text, text, text, timestamptz, timestamptz, text, int, int) to authenticated;

-- IP Correlation: عناوين دخل منها أكثر من حساب خلال p_days. لا حكم على الهوية؛ عرض فقط.
create or replace function public.owner_ip_correlation(p_days int default null, p_min_accounts int default 2, p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_days int := least(greatest(coalesce(p_days, (public._security_policy()).shared_ip_window_days), 1), 365);
begin
  if not public.owner_capability('owner_only') then
    raise exception 'لمالك المنصة وحده، داخل واجهته' using errcode = '42501';
  end if;
  return jsonb_build_object('days', v_days, 'items', coalesce((
    select jsonb_agg(row_to_json(x) order by x.accounts desc, x.last_seen desc) from (
      select host(e.ip) as ip,
             count(distinct e.target_user_id) as accounts,
             count(*) as logins,
             min(e.at) as first_seen, max(e.at) as last_seen,
             max(g.country) as country, max(g.city) as city, max(g.org) as org,
             jsonb_agg(distinct jsonb_build_object('user_id', e.target_user_id, 'email', e.target_email)) as account_list,
             (select jsonb_agg(jsonb_build_object('at', l.at, 'email', l.target_email, 'user_agent', l.user_agent)
                                order by l.at desc)
                from (select * from public.security_events l
                       where l.event_type = 'auth.login' and l.ip = e.ip
                         and l.at > now() - make_interval(days => v_days)
                       order by l.at desc limit 20) l) as timeline
        from public.security_events e
        left join public.ip_geo_cache g on g.ip = e.ip
       where e.event_type = 'auth.login' and e.ip is not null
         and e.at > now() - make_interval(days => v_days)
       group by e.ip
      having count(distinct e.target_user_id) >= greatest(coalesce(p_min_accounts, 2), 2)
       order by count(distinct e.target_user_id) desc, max(e.at) desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200)) x), '[]'::jsonb));
end;
$$;
revoke all on function public.owner_ip_correlation(int, int, int) from public, anon;
grant execute on function public.owner_ip_correlation(int, int, int) to authenticated;

-- ملخص المؤشرات الأمنية
create or replace function public.owner_security_overview(p_days int default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90));
begin
  if not public.owner_capability('owner_only') then
    raise exception 'لمالك المنصة وحده، داخل واجهته' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'days', least(greatest(coalesce(p_days, 7), 1), 90),
    'logins', (select count(*) from public.security_events where event_type = 'auth.login' and at > v_since),
    'failed_logins', (select count(*) from public.security_events where event_type = 'auth.login_failed' and at > v_since),
    'unique_ips', (select count(distinct ip) from public.security_events where event_type = 'auth.login' and at > v_since),
    'shared_ips', (select count(distinct ip) from public.security_events where event_type = 'ip.shared' and at > v_since),
    'denied', (select count(*) from public.security_events where event_type = 'access.denied' and at > v_since)
              + (select count(*) from public.owner_context_audit where event = 'denied' and at > v_since),
    'warnings', (select count(*) from public.security_events where severity in ('warning', 'critical') and at > v_since),
    'pending_account_changes', (select count(*) from public.owner_account_change_requests
                                  where status = 'pending' and expires_at > now()),
    'active_sessions', (select count(*) from auth.sessions s where s.not_after is null or s.not_after > now()),
    'owner_sessions', (select count(*) from auth.sessions s where s.user_id = public._platform_owner_id()
                         and (s.not_after is null or s.not_after > now())),
    'recent_alerts', coalesce((select jsonb_agg(row_to_json(x) order by x.at desc) from (
        select e.id, e.at, e.event_type, e.severity, e.target_email, host(e.ip) as ip, e.details
          from public.security_events e
         where e.severity in ('warning', 'critical') and e.at > v_since
         order by e.at desc limit 8) x), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.owner_security_overview(int) from public, anon;
-- grant بعد إنشاء owner_account_change_requests (أدناه)


-- ============================================================================
-- 9) الجلسات والأجهزة
-- ============================================================================

-- جلسات حساب المالك وحسابات فريق المنصة (لا جلسات العملاء: بيانات أجهزتهم ليست للمالك).
create or replace function public.owner_list_sessions(p_user uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_target uuid := coalesce(p_user, auth.uid());
begin
  if not public.owner_capability('owner_only') then
    raise exception 'لمالك المنصة وحده، داخل واجهته' using errcode = '42501';
  end if;
  if v_target <> auth.uid() and public.account_tier(v_target) not in ('platform_admin', 'admin', 'support') then
    return jsonb_build_object('ok', false, 'error', 'not_staff_account');
  end if;
  return jsonb_build_object('ok', true, 'user_id', v_target, 'items', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'created_at', s.created_at, 'refreshed_at', s.refreshed_at, 'ip', host(s.ip),
             'user_agent', s.user_agent, 'aal', s.aal::text, 'not_after', s.not_after,
             'current', s.id::text = public._jwt_session_id(),
             'country', g.country, 'city', g.city)
           order by coalesce(s.refreshed_at::timestamptz, s.created_at) desc)
      from auth.sessions s left join public.ip_geo_cache g on g.ip = s.ip
     where s.user_id = v_target and (s.not_after is null or s.not_after > now())), '[]'::jsonb));
end;
$$;
revoke all on function public.owner_list_sessions(uuid) from public, anon;
grant execute on function public.owner_list_sessions(uuid) to authenticated;

-- إلغاء جلسة. حماية من الإقفال: جلسة المالك الحالية لا تُلغى من هنا.
create or replace function public.owner_revoke_session(p_session uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_user uuid;
begin
  if not public.owner_capability('owner_only') then
    return public._deny('sessions.revoke', 'forbidden');
  end if;
  if not public.step_up_fresh() then
    return jsonb_build_object('ok', false, 'error', 'step_up_required');
  end if;
  if p_session::text = public._jwt_session_id() then
    return jsonb_build_object('ok', false, 'error', 'current_session');
  end if;
  select s.user_id into v_user from auth.sessions s where s.id = p_session;
  if v_user is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_user <> auth.uid() and public.account_tier(v_user) not in ('platform_admin', 'admin', 'support') then
    return jsonb_build_object('ok', false, 'error', 'not_staff_account');
  end if;
  perform set_config('app.session_end_reason', 'revoked_by_owner', true);
  delete from auth.sessions where id = p_session;
  perform public._security_event('session.revoked', 'notice', v_user, jsonb_build_object('session', p_session));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.owner_revoke_session(uuid) from public, anon;
grant execute on function public.owner_revoke_session(uuid) to authenticated;

-- خروج من كل الأجهزة لحساب. لحساب المالك نفسه تبقى الجلسة الحالية دائمًا (لا إقفال ذاتي).
-- لأي حساب: تُلغى جلسات التحديث؛ رمز الوصول الحالي يبقى صالحًا حتى انتهائه (ساعة على الأكثر).
create or replace function public.owner_global_logout(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_n int;
begin
  if not public.owner_capability('owner_only') then
    return public._deny('sessions.global_logout', 'forbidden');
  end if;
  if not public.step_up_fresh() then
    return jsonb_build_object('ok', false, 'error', 'step_up_required');
  end if;
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  perform set_config('app.session_end_reason', 'global_logout', true);
  delete from auth.sessions s
   where s.user_id = p_user
     and (p_user <> auth.uid() or s.id::text is distinct from public._jwt_session_id());
  get diagnostics v_n = row_count;
  perform public._security_event('session.global_logout', 'warning', p_user,
    jsonb_build_object('sessions', v_n, 'kept_current', p_user = auth.uid()));
  return jsonb_build_object('ok', true, 'revoked', v_n);
end;
$$;
revoke all on function public.owner_global_logout(uuid) from public, anon;
grant execute on function public.owner_global_logout(uuid) to authenticated;


-- ============================================================================
-- 10) حماية كلمة مرور المالك وبريده
-- ============================================================================

create table if not exists public.owner_account_change_requests (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  kind                text not null check (kind in ('password', 'email')),
  status              text not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  requested_at        timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '30 minutes',
  decided_at          timestamptz,
  -- password: بصمة bcrypt التي أرسلها GoTrue (لا نص). email: البريد المطلوب.
  pending_value       text,
  approve_token_hash  text,
  reject_token_hash   text,
  ip                  inet,
  user_agent          text,
  via                 text
);
create index if not exists owner_account_change_requests_user on public.owner_account_change_requests (user_id, requested_at desc);

comment on table public.owner_account_change_requests is
  'محاولات تغيير كلمة مرور/بريد المالك المحجوزة. لا قراءة لأي دور عدا service_role؛ المالك يرى الملخص عبر دالة.';

alter table public.owner_account_change_requests enable row level security;
revoke all on table public.owner_account_change_requests from public, anon, authenticated;
grant select, update on table public.owner_account_change_requests to service_role;

grant execute on function public.owner_security_overview(int) to authenticated;

create or replace function public.guard_owner_account_change()
returns trigger
language plpgsql
security definer
set search_path to 'public', auth
as $$
declare
  v_owner   uuid;
  v_pol     public.owner_security_policy;
  v_sess    record;
  v_req     uuid;
  v_kind    text;
  v_value   text;
begin
  -- من هو المالك؟ لو تعذّر حسمه لا نلمس تغيير أي حساب آخر
  begin
    v_owner := public._platform_owner_id();
  exception when others then
    return new;
  end;
  if v_owner is null or old.id <> v_owner then
    return new;
  end if;
  -- تطبيق موافقة صادرة من owner_approve_account_change داخل نفس المعاملة
  if current_setting('app.owner_account_change_approved', true) = old.id::text then
    return new;
  end if;

  begin
    v_pol := public._security_policy();

    if new.encrypted_password is distinct from old.encrypted_password
       and coalesce(v_pol.password_change_locked, true) then
      v_kind := 'password';
      v_value := new.encrypted_password;
    else
      -- بريد جديد مطلوب: إما تغيير مباشر لـemail، أو بدء تغيير (email_change غير فارغ وجديد).
      -- مسح email_change ('') ليس طلبًا.
      v_value := case when new.email is distinct from old.email then new.email
                      when coalesce(new.email_change, '') <> '' and new.email_change is distinct from old.email_change
                        then new.email_change end;
      if v_value is not null and lower(v_value) <> lower(coalesce(old.email, ''))
         and coalesce(v_pol.email_change_locked, true) then
        v_kind := 'email';
      end if;
    end if;
    if v_kind is null then
      return new;
    end if;

    -- القيمة القديمة تبقى
    new.encrypted_password := old.encrypted_password;
    new.email := old.email;
    new.email_change := old.email_change;
    new.email_change_token_new := old.email_change_token_new;
    new.email_change_token_current := old.email_change_token_current;
    new.email_change_sent_at := old.email_change_sent_at;

    -- GoTrue لا يمرّر IP الطلب إلى القاعدة: نأخذ IP آخر جلسة نشطة للحساب (تسمّيه الواجهة كذلك)
    select s.ip, s.user_agent, s.id into v_sess
      from auth.sessions s where s.user_id = old.id
     order by coalesce(s.refreshed_at::timestamptz, s.created_at) desc limit 1;

    update public.owner_account_change_requests set status = 'superseded'
     where user_id = old.id and kind = v_kind and status = 'pending';

    insert into public.owner_account_change_requests (user_id, kind, pending_value, ip, user_agent, via)
    values (old.id, v_kind, v_value, v_sess.ip, v_sess.user_agent,
            case when v_sess.id is null then 'no_session' else 'session' end)
    returning id into v_req;

    insert into public.security_events (event_type, severity, actor_id, target_user_id, target_email, ip, user_agent,
                                        session_id, details, source)
    values ('owner.' || v_kind || '_change_blocked', 'critical', old.id, old.id, old.email, v_sess.ip, v_sess.user_agent,
            v_sess.id::text,
            jsonb_build_object('request', v_req, 'ip_source', 'latest_session',
                               'requested_email', case when v_kind = 'email' then v_value end), 'db');

    perform public._security_alert_dispatch('owner_account_change', jsonb_build_object('request', v_req));
  exception when others then
    -- فشل التسجيل لا يُمرِّر التغيير على حساب المالك: fail-closed
    raise warning 'owner account change guard: %', sqlerrm;
    new.encrypted_password := old.encrypted_password;
    new.email := old.email;
    new.email_change := old.email_change;
    new.email_change_token_new := old.email_change_token_new;
    new.email_change_token_current := old.email_change_token_current;
    new.email_change_sent_at := old.email_change_sent_at;
  end;
  return new;
end;
$$;
revoke all on function public.guard_owner_account_change() from public, anon, authenticated;

drop trigger if exists trg_guard_owner_account_change on auth.users;
create trigger trg_guard_owner_account_change
  before update of encrypted_password, email, email_change on auth.users
  for each row execute function public.guard_owner_account_change();

-- الطرف (security-alert) يولّد رمزَي الرابطين ويحفظ بصمتيهما هنا مرة واحدة. النص لا يدخل القاعدة.
create or replace function public._account_change_set_tokens(p_request uuid, p_approve_hash text, p_reject_hash text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.owner_account_change_requests
     set approve_token_hash = p_approve_hash, reject_token_hash = p_reject_hash
   where id = p_request and status = 'pending' and approve_token_hash is null
     and p_approve_hash ~ '^[0-9a-f]{64}$' and p_reject_hash ~ '^[0-9a-f]{64}$';
  return found;
end;
$$;
revoke all on function public._account_change_set_tokens(uuid, text, text) from public, anon, authenticated;
grant execute on function public._account_change_set_tokens(uuid, text, text) to service_role;

create or replace function public._token_hash(p_token text)
returns text
language sql
immutable
set search_path to ''
as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;
revoke all on function public._token_hash(text) from public, anon, authenticated;

-- الموافقة: المالك نفسه، مسجَّل الدخول، بتحقق بخطوتين حديث، ورمز الرابط. تُخرج باقي جلساته.
create or replace function public.owner_approve_account_change(p_request uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', auth
as $$
declare
  r     public.owner_account_change_requests;
  v_n   int;
begin
  if not public.is_platform_owner() then
    return public._deny('account_change.approve', 'forbidden');
  end if;
  if not public.step_up_fresh() then
    return jsonb_build_object('ok', false, 'error', 'step_up_required');
  end if;
  select * into r from public.owner_account_change_requests where id = p_request for update;
  if not found or r.user_id <> auth.uid() or r.approve_token_hash is null
     or r.approve_token_hash <> public._token_hash(p_token) then
    perform public._security_event('owner.account_change_bad_token', 'warning', auth.uid(),
      jsonb_build_object('request', p_request, 'decision', 'approve'));
    return jsonb_build_object('ok', false, 'error', 'invalid_token');
  end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'already_' || r.status); end if;
  if r.expires_at <= now() then
    update public.owner_account_change_requests set status = 'expired', decided_at = now() where id = r.id;
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  perform set_config('app.owner_account_change_approved', r.user_id::text, true);
  if r.kind = 'password' then
    update auth.users set encrypted_password = r.pending_value, updated_at = now() where id = r.user_id;
  else
    update auth.users set email = r.pending_value, email_change = '', updated_at = now() where id = r.user_id;
  end if;
  perform set_config('app.owner_account_change_approved', '', true);

  update public.owner_account_change_requests
     set status = 'approved', decided_at = now(), pending_value = null
   where id = r.id;

  perform set_config('app.session_end_reason', 'account_change_approved', true);
  delete from auth.sessions s where s.user_id = r.user_id and s.id::text is distinct from public._jwt_session_id();
  get diagnostics v_n = row_count;

  perform public._security_event('owner.' || r.kind || '_change_approved', 'critical', r.user_id,
    jsonb_build_object('request', r.id, 'other_sessions_revoked', v_n));
  return jsonb_build_object('ok', true, 'kind', r.kind, 'sessions_revoked', v_n);
end;
$$;
revoke all on function public.owner_approve_account_change(uuid, text) from public, anon;
grant execute on function public.owner_approve_account_change(uuid, text) to authenticated;

-- الرفض: رمز الرابط وحده يكفي (رفض لا يغيّر شيئًا)، ويُخرج كل جلسات المالك — من حاول كان يملك جلسة.
create or replace function public.owner_reject_account_change(p_request uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', auth
as $$
declare
  r   public.owner_account_change_requests;
  v_n int;
begin
  select * into r from public.owner_account_change_requests where id = p_request for update;
  if not found or r.reject_token_hash is null or r.reject_token_hash <> public._token_hash(p_token) then
    insert into public.security_events (event_type, severity, ip, user_agent, details, source)
    values ('owner.account_change_bad_token', 'warning', public.request_ip(), public.request_user_agent(),
            jsonb_build_object('request', p_request, 'decision', 'reject'), 'db');
    return jsonb_build_object('ok', false, 'error', 'invalid_token');
  end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'already_' || r.status); end if;

  update public.owner_account_change_requests
     set status = 'rejected', decided_at = now(), pending_value = null
   where id = r.id;
  perform set_config('app.session_end_reason', 'account_change_rejected', true);
  delete from auth.sessions s where s.user_id = r.user_id;
  get diagnostics v_n = row_count;

  insert into public.security_events (event_type, severity, target_user_id, ip, user_agent, details, source)
  values ('owner.' || r.kind || '_change_rejected', 'critical', r.user_id, public.request_ip(), public.request_user_agent(),
          jsonb_build_object('request', r.id, 'sessions_revoked', v_n), 'db');
  return jsonb_build_object('ok', true, 'sessions_revoked', v_n);
end;
$$;
revoke all on function public.owner_reject_account_change(uuid, text) from public;
grant execute on function public.owner_reject_account_change(uuid, text) to anon, authenticated;

-- ملخص الطلبات للمالك (بلا البصمة ولا بصمات الرموز)
create or replace function public.owner_account_change_list(p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_platform_owner() then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(row_to_json(x) order by x.requested_at desc) from (
      select r.id, r.kind,
             case when r.status = 'pending' and r.expires_at <= now() then 'expired' else r.status end as status,
             r.requested_at, r.expires_at, r.decided_at, host(r.ip) as ip, r.user_agent, r.via,
             case when r.kind = 'email' and r.status = 'pending' then r.pending_value end as requested_email,
             r.approve_token_hash is not null as alert_sent
        from public.owner_account_change_requests r
       where r.user_id = auth.uid()
       order by r.requested_at desc
       limit least(greatest(coalesce(p_limit, 20), 1), 100)) x), '[]'::jsonb);
end;
$$;
revoke all on function public.owner_account_change_list(int) from public, anon;
grant execute on function public.owner_account_change_list(int) to authenticated;


-- ============================================================================
-- 11) تحقّق بَعدي
-- ============================================================================
do $$
declare v_n int;
begin
  -- لا صلاحية كتابة مباشرة على سجلات الأمان لأي دور جلسة
  if has_table_privilege('authenticated', 'public.security_events', 'insert')
     or has_table_privilege('authenticated', 'public.security_events', 'update')
     or has_table_privilege('authenticated', 'public.security_events', 'delete')
     or has_table_privilege('anon', 'public.security_events', 'select')
     or has_table_privilege('service_role', 'public.security_events', 'update')
     or has_table_privilege('service_role', 'public.security_events', 'delete')
     or has_table_privilege('authenticated', 'public.owner_account_change_requests', 'select')
     or has_table_privilege('authenticated', 'public.role_permission_rules', 'insert')
     or has_table_privilege('authenticated', 'public.owner_security_policy', 'update') then
    raise exception '121: صلاحية كتابة/قراءة غير مقصودة على جداول الأمان';
  end if;
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and policyname like 'perm\_%' and permissive = 'RESTRICTIVE';
  if v_n <> 33 then
    raise exception '121: عدد سياسات الصلاحيات % (المتوقع 33)', v_n;
  end if;
end $$;
