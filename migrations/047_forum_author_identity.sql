-- ============================================================================
-- 047 — الكاتب هو المنادي (H-05)
-- ============================================================================
--
-- الحالة قبل هذه الهجرة (مُتحقَّق منها على الإنتاج في 2026-09-18):
--
--   | الجدول               | عمود الكاتب  | WITH CHECK                          |
--   |----------------------|--------------|-------------------------------------|
--   | forum_threads        | author_id    | auth.uid() IS NOT NULL              |
--   | forum_replies        | author_id    | auth.uid() IS NOT NULL              |
--   | forum_reports        | reporter_id  | auth.uid() IS NOT NULL              |
--   | community_posts      | user_id      | auth.role() = 'authenticated'       |
--   | community_comments   | user_id      | auth.role() = 'authenticated'       |
--
-- ولا واحدة منها تربط عمود الكاتب بـauth.uid(). أي أن الشرط الوحيد هو «أن
-- تكون مسجّلًا»، لا «أن تكون أنت». فأي حساب يكتب صفًّا بـauth_id حساب الإدارة،
-- فيظهر في الواجهة باسمه وبشارة دوره.
--
-- مُثبَت بإعادة الاستغلال على الإنتاج داخل transaction:
--   insert into forum_threads (author_id = <admin>) → ALLOWED
--
-- ولماذا لم يكن المحفّز يكفي: `forum_content_sanitization` — رغم اسمه — لا
-- يفعل إلا filter_profanity على content وtitle. لا يلمس الهوية إطلاقًا.
--
-- الأثر غير المباشر أسوأ من الظاهر: محفّزات trg_badges_on_forum_* و
-- increment_user_post_count تُمنَح للهوية المزوّرة، فيفسد عدّاد المشاركات
-- والأوسمة لحساب لم يكتب شيئًا.
--
-- ملاحظة على الصياغة: `is not distinct from` بدل `=` مقصود. عمود الكاتب يقبل
-- NULL في الخمسة، و`null = auth.uid()` يساوي NULL لا false — وسياسة تُقيَّم
-- إلى NULL ترفض، لكن الصياغة الصريحة تقول المقصود بلا اعتماد على ذلك.
-- وnull لا يمرّ لأن auth.uid() ليس null في مسار المستخدم.
--
-- ============================================================================

-- ─── المنتدى ────────────────────────────────────────────────────────────────

drop policy if exists "Authenticated users can create threads" on public.forum_threads;
create policy "Authenticated users can create threads"
  on public.forum_threads for insert to authenticated
  with check (author_id = auth.uid());

drop policy if exists "Authenticated users can create replies" on public.forum_replies;
create policy "Authenticated users can create replies"
  on public.forum_replies for insert to authenticated
  with check (author_id = auth.uid());

-- البلاغ تحديدًا: بلاغ مزوَّر يُنسَب لمستخدم بريء يوجّه إليه تبعات إدارية.
drop policy if exists "Authenticated users can report" on public.forum_reports;
create policy "Authenticated users can report"
  on public.forum_reports for insert to authenticated
  with check (reporter_id = auth.uid());

-- ─── المجتمع ────────────────────────────────────────────────────────────────

drop policy if exists "Authenticated users can create posts" on public.community_posts;
create policy "Authenticated users can create posts"
  on public.community_posts for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Authenticated users can create comments" on public.community_comments;
create policy "Authenticated users can create comments"
  on public.community_comments for insert to authenticated
  with check (user_id = auth.uid());

comment on table public.forum_threads is
  'مواضيع المنتدى. author_id مربوط بـauth.uid() في سياسة الإنشاء (H-05):
   «أن تكون مسجّلًا» لا يكفي، المطلوب «أن تكون أنت».';
