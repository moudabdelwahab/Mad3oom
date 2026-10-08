-- ============================================================================
-- Conversation Core (064 + 067) — فحص Production بعد التثبيت، والأعلام مقفولة
--
-- كتلة DO واحدة بتنتهي دايمًا بـ RAISE ⇒ المعاملة كلها بترجع: مفيش صف ولا علم
-- ولا حدث بيفضل. الحسابات اصطناعية (core-smoke-<uuid>@example.com) جوه نفس
-- المعاملة. مفيش تذاكر (عشان ticket_number_seq مايتحركش)، ومفيش http متزامن
-- ولا dblink في أي محفّز بيتلمس (pg_net بيتكتب في طابور بيترجع مع المعاملة).
-- بيرفض يشتغل لو أي علم Core مش false.
--
-- النتيجة المتوقعة: ERROR P0001  CORE_SMOKE_RESULT fails=0 + 19 سطر PASS.
-- اتشغّل على Production يوم 2026-10-08 18:57 UTC ⇒ fails=0.
-- ============================================================================
do $smoke$
declare
  u   uuid := gen_random_uuid();   -- active customer (synthetic)
  bn  uuid := gen_random_uuid();   -- banned customer (synthetic)
  res text := '';
  fails int := 0;
  ok boolean;
  st text;
  r jsonb; r2 jsonb;
  sid uuid; csid uuid; mid uuid;
  v int; n int; n2 int;
begin
  -- 0) refuse to run unless every Core flag is still off
  if exists (select 1 from public.sie_settings
              where key in ('core_ingest_website','core_ingest_telegram','agent_runtime_enabled')
                and value is distinct from 'false'::jsonb) then
    raise exception 'SMOKE_ABORT: a Core flag is not false';
  end if;

  insert into auth.users (id, email) values
    (u,  'core-smoke-' || u  || '@example.com'),
    (bn, 'core-smoke-' || bn || '@example.com');
  insert into public.profiles (id, email, role) values (u, 'core-smoke-' || u || '@example.com', 'user'),
                                                       (bn, 'core-smoke-' || bn || '@example.com', 'user')
    on conflict (id) do nothing;
  update public.profiles set phone = '01000000067' where id = u;
  update public.profiles set phone = '01000000068', ban_status = 'banned' where id = bn;
  -- signup trigger (066) queued the synthetic account; approve it (rolled back like everything else)
  update public.waitlist_entries set status = 'approved', approved_user_id = u
   where lower(email) = 'core-smoke-' || u || '@example.com';
  if not found then
    insert into public.waitlist_entries (name, email, status, approved_user_id)
    values ('core smoke', 'core-smoke-' || u || '@example.com', 'approved', u);
  end if;

  -- F1 flags off for this user on every channel
  ok := not public.conv_channel_enabled('website', u) and not public.conv_channel_enabled('telegram', u);
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' F1 flags off (website/telegram) for a customer';
  if not ok then fails := fails + 1; end if;

  -- G1 account gating
  ok := public.conv_account_active(u) and not public.conv_account_active(bn);
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' G1 conv_account_active: active=true banned=false';
  if not ok then fails := fails + 1; end if;

  -- ── legacy client path (browser, authenticated) ──
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.chat_sessions (user_id) values (u) returning id into sid;
  insert into public.chat_messages (session_id, sender_id, message_text) values (sid, u, 'smoke hello') returning id into mid;
  -- attachment in another user's folder is rejected (054 guard, unchanged)
  begin
    insert into public.chat_messages (session_id, sender_id, message_text, image_url, attachment)
    values (sid, u, 'x', bn || '/a.png', jsonb_build_object('kind','image','path', bn || '/a.png'));
    st := 'ok';
  exception when others then st := sqlstate; end;
  execute 'reset role';
  select seq into n from public.chat_messages where id = mid;
  ok := n = 1 and (select channel is null and state_version = 0 from public.chat_sessions where id = sid)
        and exists (select 1 from public.inbox_events where session_id = sid and kind = 'conversation_created' and payload->>'source' = 'legacy')
        and exists (select 1 from public.inbox_events where session_id = sid and kind = 'message_received' and (payload->>'seq')::int = 1);
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' LEGACY client: session+message accepted, seq=1, events source=legacy, channel NULL';
  if not ok then fails := fails + 1; end if;
  ok := st = '42501';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' ATTACH legacy: foreign-folder attachment rejected (' || st || ')';
  if not ok then fails := fails + 1; end if;

  -- ── legacy bot reply (chat-bot-reply runs as service_role) ──
  execute 'set local role service_role';
  insert into public.chat_messages (session_id, message_text, is_bot_reply) values (sid, 'smoke bot', true) returning id into mid;
  execute 'reset role';
  ok := (select seq from public.chat_messages where id = mid) = 2
        and exists (select 1 from public.inbox_events where session_id = sid and kind = 'agent_replied');
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' LEGACY bot reply (service_role): accepted, seq=2, agent_replied event';
  if not ok then fails := fails + 1; end if;

  -- ── human handoff on a legacy session ──
  perform public._handoff_set(sid, true, 'core smoke', 'agent', null);
  execute 'set local role service_role';
  begin
    insert into public.chat_messages (session_id, message_text, is_bot_reply) values (sid, 'bot while human', true);
    st := 'ok';
  exception when others then st := sqlstate; end;
  execute 'reset role';
  ok := (select is_manual_mode and state_version = 1 from public.chat_sessions where id = sid)
        and exists (select 1 from public.inbox_events where session_id = sid and kind = 'handoff_to_human')
        and st = '55000';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' HANDOFF legacy: manual mode on, state_version bumped, bot reply blocked (' || st || ')';
  if not ok then fails := fails + 1; end if;

  -- legacy client close of its own non-Core session still allowed
  perform set_config('request.jwt.claim.sub', u::text, true);
  execute 'set local role authenticated';
  begin
    update public.chat_sessions set status = 'closed' where id = sid;
    st := 'ok';
  exception when others then st := sqlstate; end;
  execute 'reset role';
  set constraints all immediate;
  ok := st = 'ok' and exists (select 1 from public.inbox_events where session_id = sid and kind = 'closed');
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' LEGACY client close: allowed (' || st || '), closed event';
  if not ok then fails := fails + 1; end if;

  -- ── Core functions (only service_role can call them; nothing calls them in production yet) ──
  execute 'set local role service_role';
  begin
    perform public.conv_ingest_message('telegram', bn, 'smoke-b', 'tg:b:1', 'banned');
    st := 'ok';
  exception when others then st := sqlstate; end;
  ok := st = '42501';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' G1 ingest for banned account rejected (' || st || ')';
  if not ok then fails := fails + 1; end if;

  r := public.conv_ingest_message('telegram', u, 'smoke-1', 'tg:1', 'core hello');
  csid := (r->'conversation'->>'id')::uuid; v := (r->>'stateVersion')::int;
  r2 := public.conv_ingest_message('telegram', u, 'smoke-1', 'tg:1', 'core hello again');
  select count(*) into n from public.chat_messages where session_id = csid;
  ok := (r->>'created')::boolean and (r->'message'->>'seq')::int = 1 and (r2->>'duplicate')::boolean and n = 1;
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' IDEMP ingest: same external_id twice -> duplicate, 1 message';
  if not ok then fails := fails + 1; end if;

  begin
    perform public.conv_ingest_message('telegram', u, 'smoke-1', 'turn:k1', 'spoof');
    st := 'ok';
  exception when others then st := sqlstate; end;
  ok := st = '22023';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' N1 reserved turn: external_id rejected (' || st || ')';
  if not ok then fails := fails + 1; end if;

  begin
    perform public.conv_ingest_message('telegram', u, 'smoke-1', 'tg:2', '', '[]', '{}', null, null, '{"kind":"video","path":"x"}');
    st := 'ok';
  exception when others then st := sqlstate; end;
  select count(*) into n2 from public.chat_messages where session_id = csid;
  ok := st = '22023' and n2 = 1;
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' D2 unsupported attachment rejected before any write (' || st || ')';
  if not ok then fails := fails + 1; end if;

  begin
    perform public.conv_ingest_message('telegram', u, 'smoke-1', 'tg:3', '', '[]', '{}', null, null,
      jsonb_build_object('kind','image','path', bn || '/x.png'));
    st := 'ok';
  exception when others then st := sqlstate; end;
  ok := st = '42501';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' D2 Core attachment outside sender folder rejected by 054 guard (' || st || ')';
  if not ok then fails := fails + 1; end if;

  r := public.conv_commit_turn(csid, v, 'k1', 'core reply', '[]', null, 'smoke', true);
  r2 := public.conv_commit_turn(csid, v, 'k1', 'core reply', '[]', null, 'smoke', true);
  select count(*) into n from public.chat_messages where session_id = csid and is_bot_reply;
  ok := (r->>'committed')::boolean and not (r->>'duplicate')::boolean and (r2->>'duplicate')::boolean and n = 1
        and r->>'deliveryState' = 'pending';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' IDEMP commit: same turn_key twice -> 1 reply, delivery pending';
  if not ok then fails := fails + 1; end if;

  r2 := public.conv_commit_turn(csid, v, 'k2', 'stale reply');
  ok := not (r2->>'committed')::boolean and r2->>'reason' = 'version_conflict';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' VERSION stale commit rejected (' || coalesce(r2->>'reason','?') || ')';
  if not ok then fails := fails + 1; end if;

  -- R1 delivery: claim/fail up to the attempt limit, then dead-lettered
  mid := (r->>'messageId')::uuid;
  r2 := public.conv_claim_delivery(mid, interval '2 minutes', 2);
  perform public.conv_record_delivery(mid, 'failed', null, 'smoke', (r2->>'attempt')::int);
  r2 := public.conv_claim_delivery(mid, interval '2 minutes', 2);
  perform public.conv_record_delivery(mid, 'failed', null, 'smoke', (r2->>'attempt')::int);
  r2 := public.conv_claim_delivery(mid, interval '2 minutes', 2);
  ok := not (r2->>'claimed')::boolean
        and (select delivery_state = 'failed' and delivery_attempts = 2 from public.chat_messages where id = mid);
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' R1 delivery: 2 attempts then no further claim (dead letter)';
  if not ok then fails := fails + 1; end if;
  execute 'reset role';

  -- human ownership on a Core conversation
  perform public._handoff_set(csid, true, 'core smoke', 'agent', null);
  execute 'set local role service_role';
  v := (select state_version from public.chat_sessions where id = csid);
  r2 := public.conv_commit_turn(csid, v, 'k3', 'agent while human');
  -- D3: idle policy must not close a human-owned conversation
  r := public.conv_ingest_message('telegram', u, 'smoke-1', 'tg:4', 'still there?', '[]', '{}', null, interval '0 seconds');
  execute 'reset role';
  ok := not (r2->>'committed')::boolean and r2->>'reason' = 'human_owner'
        and (r->'conversation'->>'id')::uuid = csid
        and (select status = 'active' and is_manual_mode from public.chat_sessions where id = csid);
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' HUMAN owner: agent commit refused (' || coalesce(r2->>'reason','?') || '), idle policy keeps human conversation';
  if not ok then fails := fails + 1; end if;

  -- D4 writer fences with flag OFF: legacy writers still accepted on a Core conversation,
  -- browser can only close (not reopen / re-own) a Core session
  perform public._handoff_set(csid, false, 'core smoke', 'agent', null);
  execute 'set local role service_role';
  begin
    insert into public.chat_messages (session_id, message_text, is_bot_reply) values (csid, 'legacy writer, flag off', true);
    st := 'ok';
  exception when others then st := sqlstate; end;
  execute 'reset role';
  ok := st = 'ok';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' D4 flag OFF: legacy server writer not fenced (' || st || ')';
  if not ok then fails := fails + 1; end if;

  perform set_config('request.jwt.claim.sub', u::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.chat_messages (session_id, sender_id, message_text) values (csid, u, 'browser, flag off');
    st := 'ok';
  exception when others then st := sqlstate; end;
  ok := st = 'ok';
  begin
    update public.chat_sessions set user_id = bn where id = csid;
    st := 'ok';
  exception when others then st := sqlstate; end;
  ok := ok and st = '42501';
  execute 'reset role';
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' D4 flag OFF: browser write allowed, re-owning a Core session blocked (' || st || ')';
  if not ok then fails := fails + 1; end if;

  -- flags still off at the end
  ok := not exists (select 1 from public.sie_settings
                     where key in ('core_ingest_website','core_ingest_telegram','agent_runtime_enabled')
                       and value is distinct from 'false'::jsonb);
  res := res || E'\n' || case when ok then 'PASS' else 'FAIL' end || ' FLAGS still false';
  if not ok then fails := fails + 1; end if;

  raise exception 'CORE_SMOKE_RESULT fails=%: %', fails, res;
end
$smoke$;
