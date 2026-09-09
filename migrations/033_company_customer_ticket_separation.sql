-- ============================================================================
-- 033_company_customer_ticket_separation.sql
--   فصل مساري التذاكر في لوحة الشركة:
--     ① الشركة ↔ مدعوم   tickets.user_id = مالك الشركة
--     ② العميل  ↔ الشركة  tickets.user_id ∈ التابعين للمالك (super_user_id)
--
-- ما كان مدعومًا بالفعل — ولم يُلمَس
--   tickets_select_policy تنفّذ الفصل حرفيًا اليوم:
--
--     user_id = auth.uid()                                   ← مساري مع مدعوم
--     OR is_main_admin() OR role = 'admin'                   ← الطاقم
--     OR user_id IN (select id from profiles
--                     where super_user_id = auth.uid())      ← تذاكر عملائي
--
--   ومنها يتبع مباشرةً ما طلبه التصميم:
--     • الشركة لا ترى تذاكر شركة أخرى ولا عملاءها (الشرط مقيَّد بـauth.uid()).
--     • العميل لا يرى تذاكر عميل آخر (لا فرع يمنحه ذلك).
--     • تذكرة «الشركة ↔ مدعوم» لا تظهر لعملاء الشركة (الاتجاه أحادي: المالك
--       يرى تابعيه، والتابع لا يرى مالكه).
--   فلا حاجة لأي عمود جديد ولا جدول ولا رتبة. الترحيل ده **لا يوسّع** الرؤية.
--
-- ما وجدناه مكسورًا — وهو سبب هذا الترحيل
--
--   ① تسرّب الردود (IDOR مُثبَت على الإنتاج داخل معاملة ROLLBACK)
--      ticket_replies_select_policy كانت تبدأ بـ:
--
--          ((NOT is_internal) OR is_main_admin() OR role='admin' OR ...)
--
--      والفرع الأول وحده يُرضي الشرط لأي مستخدم مسجَّل: كل ردّ غير داخلي
--      مقروء للجميع. القياس الفعلي بحساب عميل عادي:
--
--          التذاكر المرئية له      : 2   (صحيح — تذاكره)
--          الردود المرئية له       : 17  (كل الردود العامة على المنصة)
--          الردود التي تخصّه فعلًا : 2
--          أصحاب التذاكر المتأثرون: 7 حسابات مختلفة
--
--      أي أن محادثات عملاء كل الشركات كانت مقروءة لأي حساب. بدون إغلاق هذا،
--      فصل المسارين في الواجهة بلا معنى.
--
--   ② صاحب الشركة لا يستطيع الردّ على تذكرة عميله
--      سياسة الإدراج كانت تشترط (tickets.user_id = auth.uid() OR admin) فقط،
--      فالمالك يقرأ تذكرة عميله ولا يردّ عليها — والمطلوب في المسار ②
--      «الرد على العميل».
--
--   ③ انتحال تأليف الردّ
--      سياستا الإدراج لا تشترطان ticket_replies.user_id = auth.uid()، فيمكن
--      كتابة ردّ منسوب لحساب آخر على تذكرة يملك المُدرِج الردَّ عليها.
--
-- ما لم يُمنَح عمدًا
--   لا UPDATE على tickets لصاحب الشركة. الحارس restrict_customer_ticket_update
--   يقيّد الأعمدة فقط حين auth.uid() = OLD.user_id — أي أنه **لا** يقيّد المالك،
--   فمنحه UPDATE كان سيسمح له بتغيير user_id وتحويل تذكرة «العميل ↔ الشركة»
--   إلى «الشركة ↔ مدعوم». وهو بالضبط ما يمنعه التصميم. تغيير الحالة يبقى
--   للطاقم، وإعادة الفتح تبقى عبر محفّز ردّ صاحب التذكرة (الترحيل 012).
--
-- بلا رتب جديدة، وبلا تغيير في المخطط: سياسات ودالة مساعدة فقط.
-- ============================================================================

-- ── 1) مصدر واحد لمعنى «تذكرة في نطاقي» ────────────────────────────────────
--
-- الشرط نفسه كان مكرَّرًا في ثلاث سياسات بصيغ مختلفة قليلًا — وهو بالضبط ما
-- سمح للفرع المكسور بالمرور دون أن يلاحظه أحد. توحيده هنا يجعل أي تعديل
-- مستقبلي يمرّ من مكان واحد.
--
-- SECURITY DEFINER عمدًا: الدالة تُنادى من داخل سياسة على ticket_replies،
-- فتقييم RLS متداخل على tickets بلا داعٍ. وهي لا تُسرّب شيئًا — تُرجع boolean
-- عن نطاق المنادي نفسه، ولا تقبل أي هوية كمُعامل.
create or replace function public.ticket_in_my_scope(p_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select auth.uid() is not null
     and exists (
           select 1
             from public.tickets t
            where t.id = p_ticket_id
              and (
                    -- ① مساري مع مدعوم
                    t.user_id = auth.uid()
                    -- ② تذاكر عملائي (التابعين لي وحدهم)
                    or t.user_id in (
                         select p.id from public.profiles p
                          where p.super_user_id = auth.uid()
                       )
                  )
         );
$function$;

comment on function public.ticket_in_my_scope(uuid) is
  'هل هذه التذكرة في نطاق المنادي: تذكرته هو، أو تذكرة مستخدم تابع له. '
  'نفس تعريف tickets_select_policy حرفيًا، في مكان واحد.';

revoke all on function public.ticket_in_my_scope(uuid) from public, anon;
grant execute on function public.ticket_in_my_scope(uuid) to authenticated;


-- ── 2) إغلاق تسرّب الردود ──────────────────────────────────────────────────
--
-- الفرق الجوهري: `not is_internal` لم تعد **بديلًا** عن ملكية التذكرة، بل
-- شرطًا إضافيًا فوقها. غير الطاقم يرى الردود العامة على تذاكر نطاقه فقط.
drop policy if exists "ticket_replies_select_policy" on public.ticket_replies;

create policy "ticket_replies_select_policy" on public.ticket_replies
for select
using (
  public.is_main_admin()
  or (select p.role from public.profiles p where p.id = auth.uid()) in ('admin', 'support')
  or (
        coalesce(is_internal, false) = false
    and public.ticket_in_my_scope(ticket_id)
  )
);


-- ── 3) الردّ: صاحب الشركة يردّ على عميله، ولا أحد ينتحل تأليف ردّ ──────────
drop policy if exists "Users can add replies to their tickets" on public.ticket_replies;

create policy "Users can add replies to their tickets" on public.ticket_replies
for insert
with check (
  -- لا انتحال: الردّ يُنسَب لمن كتبه فعلًا
  user_id = auth.uid()
  and (
    public.is_main_admin()
    or (select p.role from public.profiles p where p.id = auth.uid()) = 'admin'
    -- تذكرتي، أو تذكرة عميل تابع لي ← وهذا هو «الرد على العميل» في المسار ②
    or public.ticket_in_my_scope(ticket_id)
  )
);

-- نفس التقييد على مسار الدعم: الرتبة تفتح الردّ، لا انتحال الهوية.
drop policy if exists "Support can add replies" on public.ticket_replies;

create policy "Support can add replies" on public.ticket_replies
for insert
with check (
  user_id = auth.uid()
  and (select p.role from public.profiles p where p.id = auth.uid()) = 'support'
);


-- ── 4) تحقّق ذاتي بعد التطبيق ──────────────────────────────────────────────
do $$
declare
  v_leaky boolean;
begin
  -- لا سياسة قراءة على الردود تبدأ من is_internal وحدها بعد اليوم
  select exists (
           select 1 from pg_policies
            where schemaname = 'public'
              and tablename  = 'ticket_replies'
              and cmd = 'SELECT'
              and policyname = 'ticket_replies_select_policy'
              and qual like '%NOT is_internal%'
         ) into v_leaky;

  if v_leaky then
    raise exception 'التسرّب ما زال قائمًا: سياسة الردود تقبل is_internal وحدها';
  end if;

  raise notice 'OK 033: مسارا التذاكر مفصولان، وتسرّب الردود مغلق';
end $$;
