-- ============================================================================
-- عزل MCP لكل حساب
--
-- ما كان قائمًا قبل هذا الترحيل
-- ----------------------------------------------------------------------------
-- جدولا MCP كان يحرسهما سياسة واحدة لكل منهما، من نوع ALL، شرطها:
--
--     profiles.role = 'admin' OR profiles.email = 'support@mad3oom.online'
--
-- وهذا يعني أمرين معًا:
--
--   1) العميل العادي لا يرى شيئًا إطلاقًا — لا خادمه هو، ولا اتصاله هو.
--   2) كل أدمن يرى **كل** الصفوف، بما فيها صفوف mcp_server_connections
--      المملوكة لأدمن آخر — وهي تحمل مفاتيح وتوكنات OAuth مشفّرة وحالة
--      الاتصال وقائمة أدواته. الواجهة كانت تُرشّح بـ.eq('owner_id', me)
--      من المتصفح، لكن الترشيح في المتصفح ليس حاجزًا: أي طلب PostgREST
--      بلا ذلك القيد كان يُعيد صفوف الآخرين.
--
-- القاعدة بعد هذا الترحيل: كل حساب يرى ما يملكه وحده، ولا استثناء للأدمن.
-- استثناء الأدمن كان سيُبقي التسريب قائمًا بين الستة أدمن، وهو بالضبط ما
-- يُغلقه هذا الترحيل.
--
-- لماذا لا يكسر هذا عمليات المنصّة
-- ----------------------------------------------------------------------------
-- كل دوال الحافة التي تلمس هذين الجدولين (test-mcp-server,
-- save-mcp-credentials, mcp-oauth-start, mcp-oauth-callback, mcp-invoke-tool,
-- mcp-server-info) تقرأ وتكتب بمفتاح service_role، وهو يتجاوز RLS أصلًا.
-- ومفتاح المستخدم يُستعمل فيها للتحقق من الجلسة فقط. وقد سبق أن كانت تفرض
-- الملكية بنفسها بـ.eq("owner_id", userData.user.id)، فلا تتغيّر سلوكيًا.
--
-- ملكية الخادم
-- ----------------------------------------------------------------------------
-- mcp_servers لم يكن فيه عمود ملكية يُفرض: created_by موجود لكنه NULL في
-- كل الصفوف. نضيف owner_id ونملؤه من الاتصال الذي يحمل المالك فعلًا
-- (علاقة 1:1 مقيسة قبل الكتابة)، ثم نجعله NOT NULL حتى لا يُنشأ خادم بلا
-- مالك فيصير غير مرئي للجميع.
-- ============================================================================

begin;

-- ── 1) عمود الملكية على mcp_servers ─────────────────────────────────────────
alter table public.mcp_servers
    add column if not exists owner_id uuid references auth.users(id) on delete cascade;

-- المصدر الأوثق للمالك هو صفّ الاتصال، لأنه العمود الوحيد الذي حمل هوية
-- حقيقية حتى الآن.
update public.mcp_servers s
   set owner_id = c.owner_id
  from public.mcp_server_connections c
 where c.server_id = s.id
   and s.owner_id is null;

-- خادم أُنشئ ولم يُربط باتصال بعد: نأخذ created_by إن وُجد.
update public.mcp_servers
   set owner_id = created_by
 where owner_id is null
   and created_by is not null;

-- خادم بلا مالك بعد المحاولتين يعني صفًّا لا يملكه أحد، وسيصير غير مرئي
-- للجميع بصمت. نفشل بصوت عالٍ بدل أن نُخفيه.
do $$
declare
    orphans int;
begin
    select count(*) into orphans from public.mcp_servers where owner_id is null;
    if orphans > 0 then
        raise exception
            'mcp_servers: % صفًّا بلا owner_id بعد التعبئة — عيّن المالك يدويًا قبل إعادة التشغيل',
            orphans;
    end if;
end $$;

alter table public.mcp_servers alter column owner_id set not null;

create index if not exists mcp_servers_owner_id_idx
    on public.mcp_servers (owner_id);
create index if not exists mcp_server_connections_owner_id_idx
    on public.mcp_server_connections (owner_id);

-- ── 2) سياسات mcp_servers: المالك وحده ──────────────────────────────────────
drop policy if exists "Admins can manage mcp_servers" on public.mcp_servers;
drop policy if exists "Owner can view own mcp servers"   on public.mcp_servers;
drop policy if exists "Owner can insert own mcp servers" on public.mcp_servers;
drop policy if exists "Owner can update own mcp servers" on public.mcp_servers;
drop policy if exists "Owner can delete own mcp servers" on public.mcp_servers;

create policy "Owner can view own mcp servers"
    on public.mcp_servers for select to authenticated
    using (auth.uid() = owner_id);

-- owner_id يُفرض في WITH CHECK لا يُترك للعميل: بدونه يستطيع أي مستخدم
-- إدراج خادم باسم غيره.
create policy "Owner can insert own mcp servers"
    on public.mcp_servers for insert to authenticated
    with check (auth.uid() = owner_id);

create policy "Owner can update own mcp servers"
    on public.mcp_servers for update to authenticated
    using (auth.uid() = owner_id)
    with check (auth.uid() = owner_id);

create policy "Owner can delete own mcp servers"
    on public.mcp_servers for delete to authenticated
    using (auth.uid() = owner_id);

-- ── 3) سياسات mcp_server_connections: المالك وحده ───────────────────────────
drop policy if exists "Admins can manage mcp_server_connections" on public.mcp_server_connections;
drop policy if exists "Owner can view own mcp connections"   on public.mcp_server_connections;
drop policy if exists "Owner can insert own mcp connections" on public.mcp_server_connections;
drop policy if exists "Owner can update own mcp connections" on public.mcp_server_connections;
drop policy if exists "Owner can delete own mcp connections" on public.mcp_server_connections;

create policy "Owner can view own mcp connections"
    on public.mcp_server_connections for select to authenticated
    using (auth.uid() = owner_id);

create policy "Owner can insert own mcp connections"
    on public.mcp_server_connections for insert to authenticated
    with check (auth.uid() = owner_id);

create policy "Owner can update own mcp connections"
    on public.mcp_server_connections for update to authenticated
    using (auth.uid() = owner_id)
    with check (auth.uid() = owner_id);

create policy "Owner can delete own mcp connections"
    on public.mcp_server_connections for delete to authenticated
    using (auth.uid() = owner_id);

commit;
