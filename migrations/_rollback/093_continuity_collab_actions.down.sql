-- ============================================================================
-- تراجع 093_continuity_collab_actions
--
-- يعيد المشاركة لشكل 091 بالضبط:
--   • يعكس الترقيعات الثماني (يُثبت أن بصمة كل دالة رجعت لنص ما بعد 091).
--   • يحذف دوال 093 وجداول الملاحظات والاقتراحات وعناصر المنح، وعمود delegation_allow_collab.
--
-- حماية: يرفض لو فيه ملاحظات أو اقتراحات أو عناصر أضافها مستلم، أو منح تعاون بإجراءات غير العرض،
--   إلا لو الجلسة ضبطت  set continuity.rollback_discard_data = 'on';
-- عندها: تُسحب منح التعاون القائمة ذات الإجراءات (revoke_cause = policy)، وتُحذف الجداول الثلاثة.
-- الرسائل والمرفقات التي أضافها المستلم تبقى في السجل (هي بيانات السجل)، والأحداث تبقى.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('continuity.rollback_discard_data', true), '') <> 'on'
     and (   (to_regclass('public.continuity_notes') is not null and exists (select 1 from public.continuity_notes))
          or (to_regclass('public.continuity_change_proposals') is not null and exists (select 1 from public.continuity_change_proposals))
          or (to_regclass('public.continuity_grant_items') is not null and exists (select 1 from public.continuity_grant_items))
          or exists (select 1 from public.continuity_handovers h join public.continuity_handover_scopes s
                        on s.handover_id = h.id and s.version = h.scope_version
                      where h.state = 'accepted' and cardinality(s.actions) > 1)) then
    raise exception 'تراجع 093: فيه بيانات تعاون سيضيع تاريخها — اضبط continuity.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

-- 1) منح التعاون ذات الإجراءات: تُسحب (لا تبقى إجراءات بلا دوال)
update public.continuity_handovers h
   set state = 'revoked', revoked_at = now(), revoke_cause = 'policy'
  from public.continuity_handover_scopes s
 where s.handover_id = h.id and s.version = h.scope_version and h.state = 'accepted' and cardinality(s.actions) > 1;

-- 2) عكس الترقيعات (قبل حذف ما تناديه)
do $patch$
declare p record; v_def text;
begin
  for p in select * from (values
    ('public._continuity_scope_resolve(public.continuity_records,jsonb,text)', '8de00f350f1d53135982585bb007e8a0',
     array[E'        perform public._continuity_require_collab(); -- 093_continuity_collab_actions\n        if not a = any (sc.actions) then sc.actions := sc.actions || a; end if; -- 093_continuity_collab_actions\n',
           E'  sc.editable_fields := public._continuity_scope_fields(p_scope -> ''editable_fields'', sc.actions); -- 093_continuity_collab_actions\n'],
     array[E'        raise exception ''إجراءات المشاركة غير مفعّلة بعد'' using errcode = ''0A000'',\n          detail = ''{"code":"feature_not_enabled","field":"scope.actions"}'';\n',
           E'  sc.editable_fields := ''{}'';\n']),
    ('public._continuity_scope_narrower(public.continuity_handover_scopes,public.continuity_handover_scopes,timestamp with time zone,timestamp with time zone)', '31907f5d77f8d02a5f9c7b2f30fa8611',
     array[' and b.editable_fields <@ a.editable_fields /* 093_continuity_collab_actions */'], array['']),
    ('public.continuity_handover_amend_scope(uuid,jsonb)', '0e263e8cab490069c1a43e8ae8810a31',
     array[E'    mid.editable_fields := array(select x from unnest(cur.editable_fields) x where x = any (want.editable_fields)); -- 093_continuity_collab_actions\n',
           ' or mid.editable_fields <> cur.editable_fields /* 093_continuity_collab_actions */'],
     array['', '']),
    ('public._continuity_scope_source_ids(public.continuity_handover_scopes)', 'd631cd54d1b7a45825f3363a6e9412d9',
     array['(s.id = any (sc.source_ids) or s.id in (select gi.source_id from public.continuity_grant_items gi where gi.handover_id = sc.handover_id and gi.source_id is not null)) and s.record_id = sc.record_id /* 093_continuity_collab_actions */',
           '(sc.range_from is null or s.id in (select gi.source_id from public.continuity_grant_items gi where gi.handover_id = sc.handover_id and gi.source_id is not null)'],
     array['s.id = any (sc.source_ids) and s.record_id = sc.record_id', '(sc.range_from is null']),
    ('public._continuity_scope_attachment_ids(public.continuity_handover_scopes)', '402a356cef9a1bbbf921b4f4ed69db54',
     array['(a.id = any (sc.attachment_ids) or a.id in (select gi.attachment_id from public.continuity_grant_items gi where gi.handover_id = sc.handover_id and gi.attachment_id is not null)) and a.record_id = sc.record_id /* 093_continuity_collab_actions */'],
     array['a.id = any (sc.attachment_ids) and a.record_id = sc.record_id']),
    ('public.continuity_shared_get(uuid)', '4f8f6485f0b4a932755819d6f306209a',
     array['public._continuity_shared_extras(h) /* 093_continuity_collab_actions */ || '], array['']),
    ('public.continuity_handover_scope(uuid)', '3dbfaf64d76f59f5912c392bc0cf6d9e',
     array[', ''editable_fields'', to_jsonb(s.editable_fields) /* 093_continuity_collab_actions */'], array['']),
    ('public.continuity_set_policies(jsonb,integer)', '4f8aa4bcf5674837224432a72fd0e7b0',
     array[', ''delegation_allow_collab'' /* 093_continuity_collab_actions */',
           ' delegation_allow_collab = n.delegation_allow_collab /* 093_continuity_collab_actions */,'],
     array['', ''])
  ) as x(fn, md5_after, patched, original) loop
    if to_regprocedure(p.fn) is null then continue; end if;
    v_def := pg_get_functiondef(p.fn::regprocedure);
    if strpos(v_def, '093_continuity_collab_actions') = 0 then continue; end if;
    for i in 1 .. cardinality(p.patched) loop
      v_def := replace(v_def, p.patched[i], p.original[i]);
    end loop;
    if md5(v_def) <> p.md5_after or strpos(v_def, '093_continuity_collab_actions') > 0 then
      raise exception 'تراجع 093: عكس ترقيع % لا يعيد نص 091 (md5 %)', p.fn, md5(v_def);
    end if;
    execute v_def;
  end loop;
end $patch$;

-- 3) دوال 093
drop function if exists public.continuity_note_add(uuid, text, uuid);
drop function if exists public.continuity_notes_for(uuid);
drop function if exists public.continuity_shared_propose(uuid, jsonb, text);
drop function if exists public.continuity_proposals_for(uuid);
drop function if exists public.continuity_proposal_decide(uuid, text, text, integer);
drop function if exists public.continuity_proposal_withdraw(uuid);
drop function if exists public.continuity_shared_update(uuid, jsonb, integer);
drop function if exists public.continuity_shared_attach_sources(uuid, jsonb, integer, boolean);
drop function if exists public.continuity_shared_attachment_begin(uuid, text, text, bigint, text, uuid);
drop function if exists public.continuity_shared_attachment_commit(uuid, text);
drop function if exists public.continuity_delegation_settings();
drop function if exists public._continuity_shared_extras(public.continuity_handovers);
drop function if exists public._continuity_collab_grant(uuid, text);
drop function if exists public._continuity_collab_patch(public.continuity_records, jsonb, text[]);
drop function if exists public._continuity_scope_fields(jsonb, text[]);
drop function if exists public._continuity_require_collab();
drop function if exists public._continuity_collab_on();

-- 4) الجداول (الدوال التي تأخذ صفوفها تُحذف معها)
drop function if exists public._continuity_note_json(public.continuity_notes);
drop function if exists public._continuity_proposal_json(public.continuity_change_proposals);
drop table if exists public.continuity_grant_items;
drop table if exists public.continuity_change_proposals;
drop table if exists public.continuity_notes;
drop function if exists public._continuity_guard_collab_row();
drop function if exists public._continuity_collab_same_record();

-- 5) السياسة
alter table public.continuity_policies drop column if exists delegation_allow_collab;

-- 6) التحقق: لا بقايا
do $$
begin
  if to_regclass('public.continuity_notes') is not null or to_regclass('public.continuity_change_proposals') is not null
     or to_regclass('public.continuity_grant_items') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prokind = 'f'
                   and strpos(pg_get_functiondef(p.oid), '093_continuity_collab_actions') > 0)
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'continuity_policies' and column_name = 'delegation_allow_collab') then
    raise exception 'تراجع 093: بقايا لم تُحذف';
  end if;
end $$;

commit;
