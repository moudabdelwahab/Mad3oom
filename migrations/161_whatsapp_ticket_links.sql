-- ============================================================================
-- 161_whatsapp_ticket_links.sql — عقدة «تواصل → تذكرة» في الرد الآلي
--   لواتساب (التصميم §4 في AUTOREPLY-REVIEW-2026-11-28.md، والقرارات
--   الخمسة كلها محسومة من محمود 2026-11-28).
--
--   ما يضيفه الترحيل:
--   1. جدول رابط جديد whatsapp_ticket_links (لا مساس بجدول tickets الساخن
--      إلا بعمودين): flow_run_id UNIQUE هو الضمان الثاني لمنع التكرار
--      على مستوى قاعدة البيانات (الأول: context.ticket_number في محرك
--      الويبهوك — التصميم §4.4).
--   2. عمودان على tickets: source text (قيمة 'whatsapp_flow') +
--      source_ref text (الـ flow_run_id) — لتقارير «مصدر التذكرة» بلا JOIN.
--   3. عمود messages.ticket_id (nullable، بلا قيد إلزامي): يربط رسائل
--      المحادثة بالتذكرة بعد إنشائها (تحديث جماعي واحد على نطاق التشغيل
--      داخل الـ RPC نفسه).
--   4. إعفاء تذاكر واتساب من حصة التذاكر في enforce_ticket_quota:
--      return new بلا أي فحص حد، بمفتاح new.source = 'whatsapp_flow'
--      (العمود يُضاف في نفس الترحيل قبل تعديل الدالة) — على نمط فروع
--      الإعفاء الموجودة (carry 101، والفوترة 069). السبب (قرار محمود
--      2026-11-28 ~16:30 EET): عميل الواتساب ممكن ميكونش مسجل أصلًا
--      فلا حصة تُحسب عليه. الفرع أولًا، قبل قفل الحصة وقبل قراءة
--      ticket_quota_status، فالتذكرة تتخطى كل الفحص فعلًا.
--   5. دالة RPC واحدة wa_create_ticket_from_flow (SECURITY DEFINER،
--      تُستدعى من الويبهوك بمفتاح الخدمة فقط — بلا أي منح لـ
--      authenticated/anon): تُنشئ التذكرة + أول رد فيها (نص المحادثة)
--      + صف الربط في معاملة واحدة وتعيد ticket_number. منع تكرار: إن
--      وُجد صف بنفس flow_run_id أُعيد رقم التذكرة الموجودة ولا يُنشأ
--      شيء (مع قفل استشاري على flow_run_id حتى لا يسبق متزامنان
--      التحقق فيُنشئا تذكرتين ثم يصطدم الثاني بالقيد الفريد).
--
--   حقائق حية تحققنا منها قبل البناء (قراءة فقط على
--   srnelrdpqkcntbgudyto):
--   • tickets.user_id وtitle وdescription وticket_type كلها NOT NULL؛
--     وstatus/priority لهما افتراضيان ('open'/'medium')؛ وticket_number
--     افتراضيه nextval('ticket_number_seq') والمحفّز tr_set_ticket_number
--     يملؤه إن كان NULL — فلا رقم يُولَّد يدويًا هنا.
--     وscope NOT NULL بلا افتراضي — يُملأ صراحةً في الـ RPC (أدناه).
--   • ticket_replies: ticket_id وuser_id وmessage كلها NOT NULL،
--     وuser_id له قيدا FK إلى auth.users وprofiles — فالمالك (صاحب
--     رقم الواتساب في مدعوم) يجب أن يكون حسابًا قائمًا؛ الـ RPC
--     يتحقق من وجوده في profiles بخطأ عربي صريح بدل خطأ FK مبهم.
--   • قيود CHECK على tickets: status في (open, in-progress, resolved,
--     confirmed, rejected, closed) وpriority في (low, medium, high)
--     وticket_type في (problem, inquiry) — والإدراج هنا يستخدم
--     'open'/'medium'/'problem' فهو داخل القيود.
--   • النطاق scope (سؤال §4.7 — متحقق منه حيًا): كل التذاكر الحية
--     (43) scope='mad3oom_support'. المحفّز a_ticket_scope_stamp
--     (BEFORE INSERT) يشتق scope تلقائيًا إن كان NULL — ولو كان
--     مالك الرقم عميلًا في شركة لصار scope='company'، فتُكتم كل
--     الإشعارات (شرط WHEN أدناه) وتُنشأ تذكرة صامتة. لذلك الـ RPC
--     يضع scope='mad3oom_support' وcompany_id=NULL صراحةً — لا يترك
--     الاشتقاق يقرر. وبهذا يتحقق شرط WHEN في كل محفّزات الإشعار:
--     (new.scope <> 'company' OR NOT _isolation_on()) — أي أنها
--     تُطلق مهما كانت حالة العزل:
--       - on_ticket_created → notify_ticket_event(): بريد لمالك
--         التذكرة عبر Edge Function send-ticket-email (بريد صاحب
--         رقم الواتساب في profiles).
--       - ticket_notification_trigger → notify_all_admins_on_ticket():
--         صف notifications «تذكرة جديدة» لكل profiles.role='admin'.
--       - tr_on_new_ticket → notify_admin_on_new_ticket(): صف
--         notifications لكل admin باسم العميل وعنوان التذكرة ورابط
--         admin/tickets.html?id=....
--       - trg_dispatch_ticket_webhooks → dispatch_ticket_webhooks():
--         حدث ticket_created يُرسَل POST (موقَّع HMAC) لكل webhook
--         نشط مشترك فيه، ويُسجَّل في webhook_deliveries. (هذا
--         ويبهوك خارجي، لا إشعار داخل المنصة.)
--       - trg_assign_ticket_round_robin: إسناد تلقائي بالتناوب.
--       - trg_dispatch_workflow_on_ticket_created: تشغيل سير العمل.
--     فالتذكرة التي ينشئها الـ RPC **ليست صامتة**: بريد للمالك +
--     إشعاران داخل المنصة لكل admin + ويبهوك خارجي + إسناد تلقائي.
--   • الفئة: المخزَّنة slug إنجليزي 'whatsapp_support' (مثل بقية
--     القيم الحية: whatsapp, subscription, whatsapp_wallet_topup,
--     login, api, other). خريطة العرض موجودة فعلًا في مكانين
--     وتُضاف إليها في نفس هذا التغيير (بلا ترحيل):
--     assets/js/admin/tickets.js (CATEGORY_MAP) و
--     supabase/functions/_shared/ticket-email.js (TICKET_CATEGORIES)
--     — التسمية «دعم واتساب» في كليهما.
--   • RLS مفعَّل على tickets وticket_replies وmessages وbot_settings
--     وbot_user_states — فالجدول الجديد يُفعَّل عليه RLS أيضًا،
--     بسياستي قراءة فقط (المالك يرى روابطه، والطاقم يرى الكل)؛
--     وبلا أي سياسة كتابة لـ authenticated — الكتابة عبر الـ RPC
--     (SECURITY DEFINER) بمفتاح الخدمة فقط.
--
--   قرارات محافظة (التصميم ساكت عنها أو الواجهة المثبتة تفرضها):
--   • contact_bsuid يبقى NULL في هذا الإصدار: واجهة الـ RPC المثبتة
--     (التي سيستدعيها محرك الويبهوك) لا تحمل معامل BSUID منفصلًا؛
--     وsender_key يحمل المفتاح كما مرّره الويبهوك (رقم أو BSUID).
--     إن احتاج صندوق الوارد الـ BSUID صراحةً، يُضاف معامل
--     p_contact_bsuid في إصدار لاحق — نقطة مفتوحة موثقة في التقرير.
--   • تحديث messages.ticket_id الخلفي يطابق (from_number أو to_number
--     أو contact_bsuid) = sender_key، وعلى رسائل المالك فقط، ومن
--     flow_started_at فصاعدًا، وبلا مساس برسائل مربوطة أصلًا بتذكرة.
--   • العنوان الافتراضي (إن لم يمرَّر p_title): «واتساب — {الاسم}»
--     (والاسم الافتراضي «عميل واتساب»)؛ والفئة الافتراضية إن لم
--     تُمرَّر 'whatsapp_support'. نص أول رد = نص المحادثة كاملًا
--     (p_transcript) كما يبنيه الويبهوك من نطاق التشغيل (§4.3).
--
--   يعتمد على: tickets وticket_replies وmessages وprofiles و
--   enforce_ticket_quota (069/101) وticket_number_seq وis_admin().
--   قابل لإعادة التشغيل.
--   التراجع: migrations/_rollback/161_whatsapp_ticket_links.down.sql
--   (يسقط الدالة والجدول والأعمدة، ويعيد enforce_ticket_quota إلى
--   نسخة الإنتاج الحية بلا فرع واتساب — حرفيًا كما في pg_get_functiondef).
-- ============================================================================

begin;

-- ============================================================================
-- 0) الشروط المسبقة
-- ============================================================================
do $$
begin
  if to_regclass('public.tickets') is null then
    raise exception '161 يتطلب جدول public.tickets';
  end if;
  if to_regclass('public.ticket_replies') is null then
    raise exception '161 يتطلب جدول public.ticket_replies';
  end if;
  if to_regclass('public.messages') is null then
    raise exception '161 يتطلب جدول public.messages';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception '161 يتطلب جدول public.profiles (للتحقق من المالك)';
  end if;
  if to_regprocedure('public.enforce_ticket_quota()') is null then
    raise exception '161 يتطلب public.enforce_ticket_quota() من 069/101';
  end if;
  if to_regclass('public.ticket_number_seq') is null then
    raise exception '161 يتطلب التسلسل public.ticket_number_seq';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception '161 يتطلب public.is_admin() (لسياسات قراءة الجدول الجديد)';
  end if;
end $$;

-- ============================================================================
-- 1) جدول الربط whatsapp_ticket_links
-- ============================================================================
create table if not exists public.whatsapp_ticket_links (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  owner_user_id uuid not null references public.profiles(id) on delete cascade,
  sender_key text not null,
  contact_bsuid text,
  flow_run_id uuid not null unique,
  flow_started_at timestamptz,
  transcript_snapshot text,
  contact_name text,
  contact_phone text,
  created_at timestamptz not null default now()
);

comment on table public.whatsapp_ticket_links is
  'ربط تشغيل تدفق واتساب (flow_run_id) بالتذكرة التي أنشأتها عقدة «تواصل». flow_run_id UNIQUE هو الضمان الثاني لمنع التكرار (الأول في محرك الويبهوك). يُكتب عبر wa_create_ticket_from_flow فقط (مفتاح الخدمة).';

create index if not exists whatsapp_ticket_links_ticket_id_idx
  on public.whatsapp_ticket_links (ticket_id);
create index if not exists whatsapp_ticket_links_owner_idx
  on public.whatsapp_ticket_links (owner_user_id, created_at desc);
create index if not exists whatsapp_ticket_links_sender_key_idx
  on public.whatsapp_ticket_links (sender_key);

alter table public.whatsapp_ticket_links enable row level security;

-- قراءة فقط؛ بلا أي سياسة كتابة لـ authenticated: الكتابة عبر الـ RPC
-- (SECURITY DEFINER) بمفتاح الخدمة فقط، وservice_role يتخطى RLS أصلًا.
drop policy if exists wa_ticket_links_owner_select on public.whatsapp_ticket_links;
create policy wa_ticket_links_owner_select
  on public.whatsapp_ticket_links for select to authenticated
  using (owner_user_id = auth.uid());

drop policy if exists wa_ticket_links_staff_select on public.whatsapp_ticket_links;
create policy wa_ticket_links_staff_select
  on public.whatsapp_ticket_links for select to authenticated
  using (public.is_admin()
         or exists (select 1 from public.profiles p
                     where p.id = auth.uid()
                       and p.role in ('admin', 'support', 'platform_owner')));

-- منح القراءة فقط (السياسات أعلاه هي التي تقيّد الصفوف)؛ بلا المنح
-- ترفض RLS القراءة أصلًا. الكتابة بلا منح إطلاقًا — عبر الـ RPC فقط.
grant select on public.whatsapp_ticket_links to authenticated;
revoke all on public.whatsapp_ticket_links from anon, authenticated;
grant select on public.whatsapp_ticket_links to authenticated;

-- ============================================================================
-- 2) عمودا المصدر على tickets (قبل تعديل enforce_ticket_quota — فرع
--    الإعفاء يقرأ new.source)
-- ============================================================================
alter table public.tickets
  add column if not exists source text,
  add column if not exists source_ref text;

comment on column public.tickets.source is
  'مصدر التذكرة — ''whatsapp_flow'' للتذاكر التي أنشأتها عقدة «تواصل» في الرد الآلي لواتساب (161). مفتاح إعفاء الحصة في enforce_ticket_quota.';
comment on column public.tickets.source_ref is
  'مرجع المصدر — flow_run_id لتشغيل التدفق الذي أنشأ التذكرة (161).';

create index if not exists tickets_source_idx
  on public.tickets (source) where source is not null;

-- ============================================================================
-- 3) عمود الربط على messages
-- ============================================================================
alter table public.messages
  add column if not exists ticket_id uuid references public.tickets(id) on delete set null;

comment on column public.messages.ticket_id is
  'التذكرة التي تنتمي إليها الرسالة (161): يملؤه wa_create_ticket_from_flow برسائل نطاق التشغيل فقط. nullable بلا قيد إلزامي.';

create index if not exists messages_ticket_id_idx
  on public.messages (ticket_id) where ticket_id is not null;

-- ============================================================================
-- 4) enforce_ticket_quota — نسخة الإنتاج الحية حرفيًا (069 + سطر carry
--    101) + فرع إعفاء واتساب أولًا، قبل قفل الحصة وقبل قراءة
--    ticket_quota_status، فتذكرة واتساب تتخطى كل الفحص فعلًا.
-- ============================================================================
create or replace function public.enforce_ticket_quota()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status jsonb;
begin
  -- 101: نسخ تذكرة بطلب العميل (carry_tickets) لا يستهلك حصة
  if coalesce(current_setting('app.ticket_carry', true), '') = 'on' then
    return new;
  end if;
  -- 161: تذكرة واتساب (عقدة «تواصل») معفاة تمامًا من الحصة — بلا أي
  -- فحص حد وبلا قفل وبلا قراءة حالة الرصيد. السبب: عميل الواتساب
  -- ممكن ميكونش مسجل أصلًا فلا حصة تُحسب عليه (قرار محمود 2026-11-28).
  if coalesce(new.source, '') = 'whatsapp_flow' then
    return new;
  end if;
  if new.user_id is null
     or public.is_admin()
     or exists (select 1 from public.profiles p
                 where p.id = new.user_id and p.role in ('admin', 'support', 'platform_owner')) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ticket_quota:' || public.ticket_account_owner(new.user_id)::text, 0));

  v_status := public.ticket_quota_status(new.user_id);

  -- 069: تذكرة الفوترة المعفاة = طلب يُنشئه النظام (العلم يضعه
  -- submit_subscription_request/upgrade وحدهما)، أو شحن محفظة واتساب.
  -- تذكرة 'subscription' بلا علم = تذكرة دعم عادية تُفحص من الرصيد.
  if coalesce(new.category, '') = 'whatsapp_wallet_topup'
     or (new.category = 'subscription'
         and coalesce(current_setting('mad3oom.billing_request_ticket', true), '') = 'on') then
    if (v_status->>'billing_used')::int >= (v_status->>'billing_limit')::int then
      raise exception 'وصلت للحد الأقصى من طلبات الاشتراك والفوترة هذا الشهر (% طلبات). لو محتاج مساعدة تواصل مع الدعم عبر المحادثة.',
        v_status->>'billing_limit'
        using errcode = 'P0001', hint = 'billing_quota_exceeded';
    end if;
    return new;
  end if;

  if (v_status->>'unlimited')::boolean is not true
     and (v_status->>'used')::int >= (v_status->>'monthly_limit')::int then
    raise exception 'وصلت للحد الأقصى من التذاكر في %: % تذكرة شهريًا. رقّي خطتك من صفحة الاشتراكات، أو انتظر تجدّد الرصيد أول الشهر.',
      v_status->>'plan_name_ar', v_status->>'monthly_limit'
      using errcode = 'P0001', hint = 'ticket_quota_exceeded';
  end if;
  return new;
end;
$function$;

comment on function public.enforce_ticket_quota() is
  'حارس حصة التذاكر عند الإدراج. 161: تذاكر واتساب (source = ''whatsapp_flow'') معفاة تمامًا من الحصة — بلا فحص حد وبلا قفل — لأن عميل الواتساب قد لا يكون مسجلًا أصلًا.';

-- ============================================================================
-- 5) wa_create_ticket_from_flow — إنشاء التذكرة + أول رد + صف الربط
--    في معاملة واحدة، مع منع تكرار على flow_run_id.
--
--    الواجهة مثبتة كما سيستدعيها محرك الويبهوك — لا تُغيَّر أسماء
--    المعاملات ولا ترتيبها ولا نوع الإرجاع (text = ticket_number).
-- ============================================================================
create or replace function public.wa_create_ticket_from_flow(
  p_owner_user_id uuid,
  p_sender_key text,
  p_flow_run_id uuid,
  p_flow_started_at timestamptz,
  p_transcript text,
  p_contact_name text,
  p_contact_phone text,
  p_title text,
  p_category text
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ticket_id uuid;
  v_ticket_number bigint;
  v_title text;
  v_category text;
  v_body text;
  v_phone text;
  v_name text;
begin
  if p_owner_user_id is null then
    raise exception 'مالك رقم الواتساب غير محدد' using errcode = '22023';
  end if;
  if p_flow_run_id is null then
    raise exception 'معرف تشغيل التدفق غير محدد' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_sender_key, '')), '') is null then
    raise exception 'مفتاح المرسل غير محدد' using errcode = '22023';
  end if;
  -- ticket_replies.user_id له FK إلى auth.users وprofiles، فالمالك
  -- يجب أن يكون حسابًا قائمًا — خطأ صريح هنا بدل خطأ FK مبهم.
  if not exists (select 1 from public.profiles where id = p_owner_user_id) then
    raise exception 'مالك رقم الواتساب غير موجود' using errcode = 'P0002';
  end if;

  -- تسلسل استدعاءين متزامنين لنفس التشغيل: الثاني يرى الربط القائم
  -- ويعيد رقمه بدل أن يصطدم بالقيد الفريد على flow_run_id.
  perform pg_advisory_xact_lock(hashtextextended('wa_ticket_flow:' || p_flow_run_id::text, 0));

  -- منع التكرار (1): رابط قائم لنفس التشغيل → نفس الرقم، بلا أي إنشاء.
  select l.ticket_id into v_ticket_id
    from public.whatsapp_ticket_links l
   where l.flow_run_id = p_flow_run_id;
  if found then
    select t.ticket_number into v_ticket_number
      from public.tickets t where t.id = v_ticket_id;
    return v_ticket_number::text;
  end if;

  v_name := coalesce(nullif(btrim(coalesce(p_contact_name, '')), ''), 'عميل واتساب');
  v_phone := nullif(btrim(coalesce(p_contact_phone, '')), '');
  v_title := nullif(btrim(coalesce(p_title, '')), '');
  if v_title is null then
    v_title := format('واتساب — %s', v_name);
  end if;
  v_category := coalesce(nullif(btrim(coalesce(p_category, '')), ''), 'whatsapp_support');
  v_body := coalesce(p_transcript, '');

  -- النطاق صراحةً 'mad3oom_support' (لا يُترك لاشتقاق
  -- a_ticket_scope_stamp): به تُطلق كل محفّزات الإشعار — بريد للمالك
  -- عبر on_ticket_created، وإشعاران لكل admin، وويبهوك ticket_created،
  -- وإسناد تلقائي — مهما كانت حالة عزل الشركات. company_id NULL
  -- لأن تذكرة فريق مدعوم لا تحمل شركة (يفرضه المحفّز نفسه).
  insert into public.tickets
    (user_id, title, description, status, priority, ticket_type,
     category, scope, company_id, source, source_ref, contact_info)
  values
    (p_owner_user_id, v_title, v_body, 'open', 'medium', 'problem',
     v_category, 'mad3oom_support', null, 'whatsapp_flow', p_flow_run_id::text, v_phone)
  returning id, ticket_number into v_ticket_id, v_ticket_number;

  -- أول رد في التذكرة: نص المحادثة كما بناه الويبهوك من نطاق التشغيل.
  insert into public.ticket_replies (ticket_id, user_id, message, is_internal)
  values (v_ticket_id, p_owner_user_id, v_body, false);

  insert into public.whatsapp_ticket_links
    (ticket_id, owner_user_id, sender_key, contact_bsuid, flow_run_id,
     flow_started_at, transcript_snapshot, contact_name, contact_phone)
  values
    (v_ticket_id, p_owner_user_id, p_sender_key, null, p_flow_run_id,
     p_flow_started_at, v_body, v_name, v_phone);

  -- ربط رسائل نطاق التشغيل بالتذكرة (الواردة والصادرة: المرسل قد
  -- يكون في from_number أو to_number أو contact_bsuid)، على رسائل
  -- المالك فقط، وبلا مساس برسائل مربوطة أصلًا بتذكرة. إن كان
  -- flow_started_at NULL يُتخطى التحديث (لا نطاق معروف).
  if p_flow_started_at is not null then
    update public.messages m
       set ticket_id = v_ticket_id
     where m.ticket_id is null
       and m.user_id = p_owner_user_id
       and m."timestamp" >= p_flow_started_at
       and (m.from_number = p_sender_key
            or m.to_number = p_sender_key
            or m.contact_bsuid = p_sender_key);
  end if;

  return v_ticket_number::text;
end;
$$;

comment on function public.wa_create_ticket_from_flow(uuid, text, uuid, timestamptz, text, text, text, text, text) is
  'عقدة «تواصل → تذكرة» في الرد الآلي لواتساب (161): تنشئ التذكرة + أول رد (نص المحادثة) + صف الربط في معاملة واحدة وتعيد ticket_number. تكرار نفس flow_run_id يعيد الرقم القائم. النطاق mad3oom_support صراحةً حتى تُطلق الإشعارات. تُستدعى بمفتاح الخدمة فقط.';

-- المنح: مفتاح الخدمة فقط — بلا أي منح لـ authenticated/anon.
revoke all on function public.wa_create_ticket_from_flow(uuid, text, uuid, timestamptz, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.wa_create_ticket_from_flow(uuid, text, uuid, timestamptz, text, text, text, text, text)
  to service_role;

-- ============================================================================
-- 6) تحقق ذاتي
-- ============================================================================
do $$
declare
  v_def text;
  v_secdef boolean;
begin
  if to_regclass('public.whatsapp_ticket_links') is null then
    raise exception '161: جدول whatsapp_ticket_links غائب';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'tickets'
                    and column_name = 'source')
     or not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'tickets'
                    and column_name = 'source_ref') then
    raise exception '161: عمودا source/source_ref غائبان من tickets';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'messages'
                    and column_name = 'ticket_id') then
    raise exception '161: عمود ticket_id غائب من messages';
  end if;
  -- القيد الفريد على flow_run_id هو الضمان الثاني لمنع التكرار.
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'whatsapp_ticket_links'
                    and indexdef like '%UNIQUE%' and indexdef like '%flow_run_id%') then
    raise exception '161: لا قيد فريد على whatsapp_ticket_links.flow_run_id';
  end if;
  -- RLS مفعَّل على الجدول الجديد، وبلا سياسة كتابة لـ authenticated.
  if not (select relrowsecurity from pg_class
           where oid = 'public.whatsapp_ticket_links'::regclass) then
    raise exception '161: RLS غير مفعَّل على whatsapp_ticket_links';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'whatsapp_ticket_links'
                and cmd in ('INSERT', 'UPDATE', 'DELETE')) then
    raise exception '161: سياسة كتابة غير متوقعة على whatsapp_ticket_links';
  end if;
  -- منح الجدول: قراءة فقط لـ authenticated (السياسات تقيّد الصفوف).
  if not has_table_privilege('authenticated', 'public.whatsapp_ticket_links', 'SELECT') then
    raise exception '161: authenticated بلا منح قراءة على whatsapp_ticket_links';
  end if;
  if has_table_privilege('authenticated', 'public.whatsapp_ticket_links', 'INSERT') then
    raise exception '161: authenticated له منح كتابة على whatsapp_ticket_links — يجب أن تكون عبر الـ RPC فقط';
  end if;
  -- فرع الإعفاء في enforce_ticket_quota، قبل أي فحص حد.
  v_def := pg_get_functiondef('public.enforce_ticket_quota()'::regprocedure);
  if v_def is null or position('whatsapp_flow' in v_def) = 0 then
    raise exception '161: فرع إعفاء واتساب غائب من enforce_ticket_quota()';
  end if;
  if position('whatsapp_flow' in v_def) > position('ticket_quota_status' in v_def) then
    raise exception '161: فرع إعفاء واتساب بعد قراءة الرصيد — يجب أن يكون قبله';
  end if;
  -- الـ RPC: موجودة، SECURITY DEFINER، وممنوحة لـ service_role فقط.
  if to_regprocedure('public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)') is null then
    raise exception '161: الدالة wa_create_ticket_from_flow غائبة';
  end if;
  select p.prosecdef into v_secdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wa_create_ticket_from_flow'
     and p.pronargs = 9;
  if not coalesce(v_secdef, false) then
    raise exception '161: wa_create_ticket_from_flow فقدت SECURITY DEFINER';
  end if;
  if not has_function_privilege('service_role',
        'public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)'::regprocedure, 'EXECUTE') then
    raise exception '161: wa_create_ticket_from_flow غير ممنوحة لـ service_role';
  end if;
  if has_function_privilege('authenticated',
        'public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon',
        'public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)'::regprocedure, 'EXECUTE') then
    raise exception '161: wa_create_ticket_from_flow ممنوحة لـ authenticated/anon — يجب أن تكون بمفتاح الخدمة فقط';
  end if;
  v_def := pg_get_functiondef('public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)'::regprocedure);
  if position('mad3oom_support' in v_def) = 0 then
    raise exception '161: الـ RPC بلا نطاق mad3oom_support الصريح';
  end if;
  if position('whatsapp_support' in v_def) = 0 then
    raise exception '161: الـ RPC بلا الفئة الافتراضية whatsapp_support';
  end if;
  raise notice 'OK 161: whatsapp_ticket_links + source/source_ref + messages.ticket_id + إعفاء حصة واتساب + wa_create_ticket_from_flow (service_role فقط)';
end $$;

commit;
