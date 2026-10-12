-- ============================================================================
-- 087_continuity_edit_permissions.sql
--   Mad3oom Continuity — صلاحية التعديل منفصلة عن صلاحية القراءة.
--
-- لماذا
--   حتى 086 كل من «يرى» السجل يعدّله (P1)، ويرفق له مصادر ويشيلها ويرجّعها (P2/T1)،
--   ويرفع له مرفقات ويشيلها (080): المنشئ وكل أعضاء فريق السجل والمشرفون. قرار
--   المالك (2026-10-12، «Complete Mad3oom Continuity»): لا تعديل لمجرد الرؤية؛
--   القراءة والتعديل والإسناد وإدارة المصادر كلٌّ صلاحية مستقلة.
--
-- القاعدة الجديدة (E1)
--   القراءة      continuity_can_access — بلا تغيير (المشرف، المالك، المنشئ، فريق السجل).
--   التعديل      الحقول، المصادر (إرفاق/إزالة/استرجاع)، المرفقات (بدء/إتمام/إزالة/استرجاع):
--                مالك السجل أو المشرف فقط، على سجل يراه المنادي.
--   الحالة       بلا تغيير (079): المالك أو المشرف.
--   الإسناد      بلا تغيير (P3/P4): صاحب صلاحية الإسناد لأي مؤهل؛ غيره لنفسه أو بلا مالك؛
--                السجل بلا مالك يأخذه من يراه لنفسه ثم يعدّله.
--   المسح النهائي بلا تغيير (T2): مالك المنصة فقط.
--   الرفض لمن يرى ولا يعدّل: 42501 forbidden {field: record, reason: not_owner|unassigned}
--   (هو يرى السجل أصلًا، فلا تسرّب).
--
-- الطريقة
--   لا إعادة كتابة لأي دالة: كل دالة كتابة تُرقَّع بسطر واحد بعد نقطة ارتكاز ثابتة،
--   بشرط أن بصمتها (md5 لـ pg_get_functiondef) تطابق نص الإنتاج الحالي بالضبط، وأن
--   الارتكاز يظهر مرة واحدة. أي اختلاف ⇒ يتوقف ولا يغيّر شيئًا. السطر المضاف يحمل
--   العلامة 087_continuity_edit_gate، فإعادة التشغيل لا تكرره، والتراجع يحذفه ويثبت
--   أن البصمة رجعت كما كانت.
--
-- ما يضيفه
--   • _continuity_can_edit(record) و_continuity_require_edit(record) (داخلية).
--   • _continuity_permissions(record): ما يقدر المنادي يعمله على السجل (للواجهة فقط —
--     القرار في كل RPC)، ويُرجَع في _continuity_full كمفتاح 'permissions'.
--
-- ما لا يفعله
--   • لا يغيّر القراءة ولا القوائم ولا الإسناد ولا الانتقالات ولا التسليم ولا السياسات.
--   • لا يمس بيانات: لا جدول ولا صف جديد.
--   • relay_* (أغلفة 077) تمر بنفس الدوال فتأخذ نفس القاعدة.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/087_continuity_edit_permissions.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.continuity_handovers') is null
     or to_regprocedure('public._continuity_capability_handovers()') is null
     or to_regprocedure('public._continuity_capability_attachments()') is null then
    raise exception '087: يتطلب 080 و081';
  end if;
end $$;


-- ============================================================================
-- 1) الدوال الداخلية
-- ============================================================================
-- يعدّل = يرى السجل، والسجل نشط في مساحة مفعّلة، وهو مالكه أو مشرف.
create or replace function public._continuity_can_edit(p_record uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.continuity_can_access(p_record) and exists (
    select 1 from public.continuity_records r
     where r.id = p_record
       and (public._continuity_is_supervisor() or r.owner_id = auth.uid())), false);
$$;

create or replace function public._continuity_require_edit(p_record uuid)
returns void language plpgsql stable security definer set search_path to 'public' as $$
declare v_owner uuid;
begin
  if public._continuity_can_edit(p_record) then return; end if;
  -- من لا يرى السجل لا يصل هنا أصلًا (كل نداء يفحص الوصول قبله)؛ احتياطًا نفس رد «غير موجود».
  if not public.continuity_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select owner_id into v_owner from public.continuity_records where id = p_record;
  raise exception 'التعديل لمالك السجل أو للمشرف' using errcode = '42501',
    detail = jsonb_build_object('code', 'forbidden', 'field', 'record',
                                'reason', case when v_owner is null then 'unassigned' else 'not_owner' end)::text;
end $$;

-- ما يقدر المنادي يعمله على سجل يراه. للعرض فقط: كل RPC يقرر بنفسه.
create or replace function public._continuity_permissions(p_record uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case when not public.continuity_can_access(p_record) then null else (
    select jsonb_build_object(
      'edit',        v.active and v.editor,
      'sources',     v.active and v.editor,
      'attachments', v.active and v.editor and public._continuity_attachments_on(),
      'transition',  v.editor,
      'assign',      v.active and public._continuity_can_assign(),
      'claim',       v.active and r.owner_id is null,
      'release',     v.active and r.owner_id = auth.uid(),
      'handover',    v.active and public._continuity_handovers_on()
                       and coalesce(r.owner_id = auth.uid() or public._continuity_can_assign(), false),
      'purge',       public._continuity_is_owner(),
      'reason',      case when not v.active then 'closed'
                          when v.editor then null
                          when r.owner_id is null then 'unassigned'
                          else 'not_owner' end)
      from public.continuity_records r
      cross join lateral (select r.status not in ('resolved', 'cancelled') as active,
                                 coalesce(public._continuity_is_supervisor() or r.owner_id = auth.uid(), false) as editor) v
     where r.id = p_record) end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public._continuity_can_edit(uuid)', 'public._continuity_require_edit(uuid)',
                           'public._continuity_permissions(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;

comment on function public._continuity_can_edit(uuid) is
  '087: التعديل (الحقول، المصادر، المرفقات) لمالك السجل أو للمشرف، على سجل يراه المنادي.';
comment on function public._continuity_permissions(uuid) is
  '087: ما يقدر المنادي يعمله على السجل — للواجهة فقط؛ كل RPC يقرر بنفسه.';


-- ============================================================================
-- 2) ترقيع دوال الكتابة: سطر واحد بعد ارتكاز ثابت، على نص الإنتاج الحالي بالضبط
-- ============================================================================
do $patch$
declare
  p record;
  v_def text;
  v_new text;
  v_hits int;
begin
  for p in select * from (values
    -- (الدالة، بصمة نص الإنتاج قبل 087، الارتكاز، السطر المضاف بعده)
    ('public.continuity_update(uuid,jsonb,integer)', '8664dd01b54c7fe44bfe43b5869318e9',
     E'  r := public._continuity_lock_for_write(p_record, p_expected_version);\n',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attach_sources(uuid,jsonb,integer,boolean)', '8b0cf81023896d21ee28acad1882962b',
     E'  r := public._continuity_lock_for_write(p_record, p_expected_version);\n',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_remove_source(uuid,integer)', '73f66a8e26c2b6a3fb09fe66bab7c1b0',
     E'  r := public._continuity_lock_for_write(s.record_id, p_expected_version);\n',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_restore_source(uuid,integer)', 'a52bd9122c884da6b2c1c2516ba03d44',
     E'  r := public._continuity_lock_for_write(s.record_id, p_expected_version);\n',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attachment_begin(uuid,text,text,bigint,text,uuid)', '396ed3af4c08660ea47cbf8511b171da',
     E'  select * into r from public.continuity_records where id = p_record for update;\n',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attachment_commit(uuid,text)', '70882cbc5a93711f5bbc146d146d9f68',
     E'  select * into r from public.continuity_records where id = a.record_id for update;\n',
     E'  perform public._continuity_require_edit(r.id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attachment_remove(uuid,integer)', '00c48245aa4482913c339d559dbc4bb7',
     E'  a := public._continuity_attachment_for_write(p_attachment, p_expected_version);\n',
     E'  perform public._continuity_require_edit(a.record_id); -- 087_continuity_edit_gate\n'),
    ('public.continuity_attachment_restore(uuid,integer)', '4a4b17273f34a3f4182d3d35220d3c5e',
     E'  a := public._continuity_attachment_for_write(p_attachment, p_expected_version);\n',
     E'  perform public._continuity_require_edit(a.record_id); -- 087_continuity_edit_gate\n'),
    -- القراءة الكاملة تحمل ما يقدر المنادي يعمله (للواجهة)
    ('public._continuity_full(uuid,boolean)', '9db8e30bb926b96d312c7010872fba29',
     E'    ''replayed'', p_replayed',
     E',\n    ''permissions'', public._continuity_permissions(p_record) /* 087_continuity_edit_gate */')
  ) as x(fn, md5_before, anchor, addition) loop
    v_def := pg_get_functiondef(p.fn::regprocedure);
    if strpos(v_def, '087_continuity_edit_gate') > 0 then
      continue;  -- مُرقَّعة من تشغيل سابق
    end if;
    if md5(v_def) <> p.md5_before then
      raise exception '087: نص % لا يطابق الإنتاج (md5 %)، لن يُرقَّع', p.fn, md5(v_def);
    end if;
    v_hits := (length(v_def) - length(replace(v_def, p.anchor, ''))) / length(p.anchor);
    if v_hits <> 1 then
      raise exception '087: الارتكاز في % ظهر % مرة', p.fn, v_hits;
    end if;
    v_new := replace(v_def, p.anchor, p.anchor || p.addition);
    execute v_new;
    if md5(replace(pg_get_functiondef(p.fn::regprocedure), p.addition, '')) <> p.md5_before then
      raise exception '087: الترقيع غيّر % بأكثر من السطر المضاف', p.fn;
    end if;
  end loop;
end $patch$;


-- ============================================================================
-- 3) التحقق
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['continuity_update(uuid,jsonb,integer)', 'continuity_attach_sources(uuid,jsonb,integer,boolean)',
                           'continuity_remove_source(uuid,integer)', 'continuity_restore_source(uuid,integer)',
                           'continuity_attachment_begin(uuid,text,text,bigint,text,uuid)', 'continuity_attachment_commit(uuid,text)',
                           'continuity_attachment_remove(uuid,integer)', 'continuity_attachment_restore(uuid,integer)',
                           '_continuity_full(uuid,boolean)'] loop
    if strpos(pg_get_functiondef(('public.' || f)::regprocedure), '087_continuity_edit_gate') = 0 then
      raise exception '087: % بلا بوابة التعديل', f;
    end if;
  end loop;
  -- لا تغيير في من ينادي ماذا: دوال الكتابة كما هي للمصادَق، والداخلية لا أحد.
  foreach f in array array['continuity_update(uuid,jsonb,integer)', 'continuity_attach_sources(uuid,jsonb,integer,boolean)',
                           'continuity_remove_source(uuid,integer)', 'continuity_restore_source(uuid,integer)',
                           'continuity_attachment_begin(uuid,text,text,bigint,text,uuid)', 'continuity_attachment_commit(uuid,text)',
                           'continuity_attachment_remove(uuid,integer)', 'continuity_attachment_restore(uuid,integer)'] loop
    if not has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')
       or has_function_privilege('anon', 'public.' || f, 'EXECUTE') then
      raise exception '087: صلاحيات % تغيّرت', f;
    end if;
  end loop;
  foreach f in array array['_continuity_can_edit(uuid)', '_continuity_require_edit(uuid)', '_continuity_permissions(uuid)',
                           '_continuity_full(uuid,boolean)'] loop
    if has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')
       or has_function_privilege('anon', 'public.' || f, 'EXECUTE') then
      raise exception '087: دالة داخلية مكشوفة: %', f;
    end if;
  end loop;
  raise notice '087: التعديل والمصادر والمرفقات لمالك السجل أو للمشرف؛ القراءة كما هي';
end $$;
