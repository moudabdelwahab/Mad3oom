-- ============================================================================
-- 015_notification_actions.sql   —   الإشعار يحمل إجراءه بنفسه
--
-- المشكلة
--   بعد 011 بقى للإشعار تصنيف حقيقي، لكن **سلوكه** لسه مستنتَجًا في الواجهة
--   من نص الرابط: نبحث عن ‎?ticket=‎ في link، وإلا نخمّن القسم من التصنيف.
--   ده يعني إن أي مُرسِل جديد لازم يعرف صيغة الروابط بالظبط، وإن تغيير
--   بسيط في الصياغة أو المسار بيكسر وجهة الإشعار بدون أي إشارة.
--
--   وreference_id عمود موجود من الأول ولسه NULL في كل الصفوف، رغم إن
--   معرّف التذكرة مكتوب فعلاً جوه link في ٤٣ إشعارًا.
--
-- الحل
--   نقل القرار من الواجهة إلى البيانات: عمودان جديدان action و action_target
--   (+ action_label اختياري)، تُملأ تلقائيًا بنفس نمط 011 — دالة اشتقاق
--   واحدة و trigger عند الإدراج. الواجهة بقت بتقرأ حقلًا، مش بتحلّل نصًا.
--
--   الروابط (link) بتفضل زي ما هي: هي البنية اللي بتخدم الروابط الخارجية
--   والبريد، ولها قيمتها. الفرق إنها بقت مصدر اشتقاق لمرة واحدة على
--   السيرفر، مش منطقًا يتكرر في كل شاشة.
--
-- الأمان
--   مفيش تغيير في أي سياسة RLS. الأعمدة تُقرأ بنفس سياسة الجدول الحالية.
-- ============================================================================

alter table public.notifications
  add column if not exists action        text,
  add column if not exists action_target text,
  add column if not exists action_label  text;

comment on column public.notifications.action is
  'نوع الإجراء المتاح للإشعار: open_ticket / open_section / open_incident / none. تقرأه الواجهة كما هو بدل استنتاجه من العنوان.';
comment on column public.notifications.action_target is
  'وجهة الإجراء: معرّف التذكرة/الحادثة، أو اسم القسم داخل البوابة.';
comment on column public.notifications.action_label is
  'نص الزر داخل نافذة تفاصيل الإشعار. NULL يعني استخدم النص الافتراضي للنوع.';

-- ── معرّف التذكرة المدفون في الرابط ─────────────────────────────────────────
-- الاستخراج بتعبير نمطي صارم على شكل UUID: أي شيء غير ذلك يرجع NULL بدل
-- ما يتسرّب نص عشوائي لعمود uuid.
create or replace function public.notification_link_ticket_id(p_link text)
returns uuid
language sql
immutable
set search_path to 'public'
as $function$
  select nullif(
           substring(coalesce(p_link, '') from
             'ticket=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'),
           ''
         )::uuid;
$function$;

-- ── اشتقاق الإجراء ──────────────────────────────────────────────────────────
-- المصدر: التصنيف (اللي 011 بيضبطه) + الرابط. مش العنوان.
-- الأقسام هنا لازم تطابق أسماء أقسام البوابة في customer-dashboard.
create or replace function public.derive_notification_action(
  p_category text,
  p_link     text
) returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case
    when public.notification_link_ticket_id(p_link) is not null then 'open_ticket'
    when coalesce(p_category, '') = 'tickets'                   then 'open_section'
    when coalesce(p_category, '') in ('subscription', 'billing',
                                      'whatsapp', 'sie')        then 'open_section'
    when coalesce(p_category, '') = 'security'                  then 'open_section'
    when coalesce(p_category, '') = 'account'                   then 'open_section'
    when coalesce(p_category, '') = 'rewards'                   then 'open_section'
    when coalesce(p_category, '') = 'system'                    then 'open_section'
    else 'none'
  end;
$function$;

create or replace function public.derive_notification_action_target(
  p_category text,
  p_link     text
) returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case
    when public.notification_link_ticket_id(p_link) is not null
      then public.notification_link_ticket_id(p_link)::text
    when coalesce(p_category, '') = 'tickets'                    then 'tickets'
    when coalesce(p_category, '') in ('subscription', 'billing',
                                      'whatsapp', 'sie')         then 'usage'
    when coalesce(p_category, '') = 'security'                   then 'security'
    when coalesce(p_category, '') = 'account'                    then 'profile'
    when coalesce(p_category, '') = 'rewards'                    then 'rewards'
    when coalesce(p_category, '') = 'system'                     then 'support'
    else null
  end;
$function$;

comment on function public.derive_notification_action(text, text) is
  'يشتق إجراء الإشعار من تصنيفه ورابطه. مصدر واحد يستخدمه الـbackfill والـtrigger معًا.';

-- ── الملء التلقائي عند الإدراج ──────────────────────────────────────────────
-- Postgres بينفّذ محفّزات BEFORE بترتيب أبجدي لأسمائها، و«action» بتسبق
-- «category» أبجديًا — يعني الاعتماد على إن التصنيف اتحدّد قبلنا يبقى غلط.
-- فبنشتق التصنيف محليًا لو لسه فاضي، بنفس الدالة اللي بيستخدمها محفّز 011.
-- النتيجة واحدة مهما كان ترتيب التنفيذ.
create or replace function public.set_notification_action()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_category text;
begin
  v_category := coalesce(
    nullif(btrim(coalesce(new.category, '')), ''),
    public.derive_notification_category(new.type, new.title, new.link)
  );

  if new.reference_id is null then
    new.reference_id := public.notification_link_ticket_id(new.link);
  end if;

  if new.action is null or btrim(new.action) = '' then
    new.action := public.derive_notification_action(v_category, new.link);
  end if;

  if new.action_target is null or btrim(new.action_target) = '' then
    new.action_target := public.derive_notification_action_target(v_category, new.link);
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_notifications_set_action on public.notifications;
create trigger trg_notifications_set_action
  before insert on public.notifications
  for each row execute function public.set_notification_action();

-- ── ملء الصفوف الموجودة ─────────────────────────────────────────────────────
update public.notifications
   set reference_id  = coalesce(reference_id, public.notification_link_ticket_id(link)),
       action        = coalesce(action,        public.derive_notification_action(category, link)),
       action_target = coalesce(action_target, public.derive_notification_action_target(category, link))
 where action is null or action_target is null or reference_id is null;

create index if not exists idx_notifications_user_action
  on public.notifications (user_id, action, created_at desc);
