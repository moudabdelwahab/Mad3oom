-- ============================================================================
-- التراجع عن 087_continuity_edit_permissions
--   يحذف سطر بوابة التعديل من كل دالة ويثبت أن نصها رجع لبصمة الإنتاج قبل 087
--   بالضبط، ثم يحذف الدوال الداخلية الثلاث. لا بيانات تتأثر (087 لا يكتب بيانات).
--   بعده: القراءة = التعديل كما في P1/P2/T1.
-- ============================================================================
do $rb$
declare
  p record;
  v_def text;
begin
  for p in select * from (values
    ('public.continuity_update(uuid,jsonb,integer)', '8664dd01b54c7fe44bfe43b5869318e9',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attach_sources(uuid,jsonb,integer,boolean)', '8b0cf81023896d21ee28acad1882962b',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_remove_source(uuid,integer)', '73f66a8e26c2b6a3fb09fe66bab7c1b0',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_restore_source(uuid,integer)', 'a52bd9122c884da6b2c1c2516ba03d44',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attachment_begin(uuid,text,text,bigint,text,uuid)', '396ed3af4c08660ea47cbf8511b171da',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attachment_commit(uuid,text)', '70882cbc5a93711f5bbc146d146d9f68',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attachment_remove(uuid,integer)', '00c48245aa4482913c339d559dbc4bb7',
     E'  perform public._continuity_require_edit(a.record_id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attachment_restore(uuid,integer)', '4a4b17273f34a3f4182d3d35220d3c5e',
     E'  perform public._continuity_require_edit(a.record_id); -- 087_continuity_edit_gate\n'),
    ('public._continuity_full(uuid,boolean)', '9db8e30bb926b96d312c7010872fba29',
     E',\n    ''permissions'', public._continuity_permissions(p_record) /* 087_continuity_edit_gate */')
  ) as x(fn, md5_before, addition) loop
    if to_regprocedure(p.fn) is null then continue; end if;
    v_def := pg_get_functiondef(p.fn::regprocedure);
    if strpos(v_def, '087_continuity_edit_gate') = 0 then continue; end if;
    v_def := replace(v_def, p.addition, '');
    if md5(v_def) <> p.md5_before then
      raise exception 'تراجع 087: نص % بعد حذف البوابة لا يطابق ما قبل 087 (md5 %) — توقف', p.fn, md5(v_def);
    end if;
    execute v_def;
  end loop;
end $rb$;

drop function if exists public._continuity_permissions(uuid);
drop function if exists public._continuity_require_edit(uuid);
drop function if exists public._continuity_can_edit(uuid);
