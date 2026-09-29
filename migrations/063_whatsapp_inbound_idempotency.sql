-- ============================================================================
-- 063_whatsapp_inbound_idempotency — رسالة واتساب الواردة تتخزّن مرة واحدة (W1)
--
-- المشكلة (مقيسة على الإنتاج، 2026-09-29):
--   whatsapp-webhook بيدرج الرسالة الواردة من غير wa_message_id (0 من 392
--   رسالة واردة)، ومفيش قيد فريد. ميتا بتعيد إرسال نفس الـwebhook لو الرد
--   اتأخر، فالرسالة بتتخزّن مرتين والتدفق (FlowEngine) بيشتغل مرتين: رد مكرر
--   للعميل. في الإنتاج مجموعتين مكررتين فعلًا (نفس raw_data->>'id').
--
-- الحل:
--   ① عمود duplicate_of_id (إضافي، nullable): الصف المكرر بيشاور على الأصل.
--      مفيش حذف ولا تعديل لمحتوى أي رسالة.
--   ② تعبئة wa_message_id للرسائل الواردة من raw_data->>'id' — لأول صف بس في
--      كل مجموعة (created_at, id). الصفوف التانية: wa_message_id يفضل NULL
--      و duplicate_of_id = الأصل. قابلة لإعادة التشغيل: الترتيب محسوب على
--      كل الصفوف (المعبّاة وغيرها) فالأصل مايتغيرش.
--   ③ فهرس فريد جزئي (user_id, wa_message_id) WHERE direction = 'inbound'.
--      الصادر مش داخل فيه (مسارات الإرسال البشري والتكامل زي ما هي).
--   ④ wa_insert_inbound_message(...): إدراج ذري
--      INSERT ... ON CONFLICT (user_id, wa_message_id) WHERE direction='inbound'
--      DO NOTHING RETURNING id. بترجّع id لو الصف اتدرج، و NULL لو مكرر — والـ
--      webhook مابيشغّلش التدفق إلا للفائز. مفيش قراءة قبل الكتابة.
--      service_role بس.
--
-- مفيش حذف بيانات. قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/063_whatsapp_inbound_idempotency.down.sql
-- ⚠️ ترتيب النشر: الترحيل ده الأول، وبعده whatsapp-webhook اللي بينادي الدالة.
-- ============================================================================

-- ── ① علامة التكرار ────────────────────────────────────────────────────────
alter table public.messages add column if not exists duplicate_of_id uuid;
comment on column public.messages.duplicate_of_id is
  'رسالة واردة وصلت مرتين من ميتا (نفس wa_message_id): الصف ده نسخة، والأصل هو الـid المكتوب هنا. ماتتحذفش (063).';

-- ── ② تعبئة الموجود ────────────────────────────────────────────────────────
with ranked as (
  select m.id,
         m.wa_message_id,
         m.raw_data->>'id' as wamid,
         first_value(m.id) over w as canonical_id,
         row_number() over w as rn
    from public.messages m
   where m.direction = 'inbound'
     and nullif(btrim(m.raw_data->>'id'), '') is not null
  window w as (partition by m.user_id, m.raw_data->>'id' order by m.created_at, m.id)
)
update public.messages m
   set wa_message_id   = case when r.rn = 1 then r.wamid else m.wa_message_id end,
       duplicate_of_id = case when r.rn > 1 then r.canonical_id else m.duplicate_of_id end
  from ranked r
 where m.id = r.id
   and ((r.rn = 1 and m.wa_message_id is null)
     or (r.rn > 1 and m.duplicate_of_id is null));

-- ── ③ القيد ────────────────────────────────────────────────────────────────
create unique index if not exists messages_inbound_wa_message_id_key
  on public.messages (user_id, wa_message_id)
  where direction = 'inbound';

-- ── ④ الإدراج الذري ────────────────────────────────────────────────────────
create or replace function public.wa_insert_inbound_message(
  p_user_id uuid,
  p_wa_message_id text,
  p_from_number text,
  p_to_number text,
  p_contact_bsuid text,
  p_message_text text,
  p_message_type text,
  p_waba_id text,
  p_timestamp timestamptz,
  p_raw_data jsonb
)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_wamid text := nullif(btrim(p_wa_message_id), '');
begin
  insert into public.messages (user_id, from_number, to_number, contact_bsuid, message_text, message_type,
                               direction, status, waba_id, "timestamp", raw_data, wa_message_id)
  values (p_user_id, p_from_number, p_to_number, p_contact_bsuid, p_message_text, p_message_type,
          'inbound', 'received', p_waba_id, coalesce(p_timestamp, now()), p_raw_data, v_wamid)
  on conflict (user_id, wa_message_id) where direction = 'inbound' do nothing
  returning id into v_id;
  -- NULL = نفس الرسالة اتخزّنت قبل كده (إعادة إرسال من ميتا). رسالة من غير
  -- معرّف مابتتعارضش أبدًا (NULL مش مساوي لـNULL) فبتتدرج زي الأول.
  return v_id;
end;
$$;

revoke all on function public.wa_insert_inbound_message(uuid, text, text, text, text, text, text, text, timestamptz, jsonb)
  from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.wa_insert_inbound_message(uuid, text, text, text, text, text, text, text, timestamptz, jsonb)
      to service_role;
  end if;
end $$;

-- ============================================================================
-- التحقق
-- ============================================================================
do $$
declare
  f constant text := 'public.wa_insert_inbound_message(uuid, text, text, text, text, text, text, text, timestamptz, jsonb)';
  v_missing bigint;
  v_orphans bigint;
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'messages'
                  and indexname = 'messages_inbound_wa_message_id_key') then
    raise exception '063: الفهرس الفريد ناقص';
  end if;
  if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE') then
    raise exception '063: الإدراج الذري متاح لعميل';
  end if;
  -- كل رسالة واردة ليها معرّف يا متعبّية يا متعلّمة كنسخة — مفيش حاجة وقعت.
  select count(*) into v_missing from public.messages
   where direction = 'inbound' and nullif(btrim(raw_data->>'id'), '') is not null
     and wa_message_id is null and duplicate_of_id is null;
  if v_missing > 0 then
    raise exception '063: % رسالة واردة من غير wa_message_id ولا علامة تكرار', v_missing;
  end if;
  -- كل نسخة بتشاور على أصل موجود بنفس المعرّف.
  select count(*) into v_orphans from public.messages d
   where d.duplicate_of_id is not null
     and not exists (select 1 from public.messages c where c.id = d.duplicate_of_id
                      and c.direction = 'inbound' and c.raw_data->>'id' = d.raw_data->>'id');
  if v_orphans > 0 then
    raise exception '063: % نسخة بتشاور على أصل غلط', v_orphans;
  end if;
  raise notice '063: الرسالة الواردة بتتخزّن مرة واحدة';
end $$;
