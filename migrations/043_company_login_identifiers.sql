-- ============================================================================
-- 043_company_login_identifiers.sql
--   شاشة دخول عضو الشركة: الشركة تُعرَف ببريد مالكها أيضًا، لا ببياناتها وحدها.
--
-- الخلل الذي يعالجه
--   الترحيل 042 عرّف resolve_company_member_login بحيث تُطابَق الشركة على
--   ثلاثة أعمدة من جدول companies فقط:
--       company_email · commercial_registration_number · company_phone
--
--   والترحيل 016 أسقط NOT NULL عن company_email و company_phone عمدًا، لأن
--   مسار «إنشاء شركة عند الاشتراك» يطلب البيانات القانونية الأساسية وحدها.
--   فنتجت شركات حقيقية على الإنتاج بعمودين فارغين ورقم سجل تجاري فقط.
--
--   النتيجة: مالك شركة يكتب بريده هو في خانة الشركة — وهو ما يوحي به نص
--   الحقل في شاشة الدخول — فلا تُطابَق الشركة أصلًا، وتعود الدالة بـ NULL،
--   فيرى «بيانات الشركة أو العضو غير صحيحة، أو العضو غير تابع لهذه الشركة»
--   بينما العضو مسجَّل سليمًا وتبعيته للشركة قائمة. القيمة الوحيدة التي
--   كانت تعمل هي رقم السجل التجاري، ولا شيء في الواجهة يقول ذلك.
--
-- التغيير
--   يُضاف إلى المطابقة معرِّفا **مالك** الشركة (بريده وهاتفه من profiles).
--   المالك هو companies.user_id، فالمعرّف يخص الشركة فعلًا لا حسابًا عابرًا.
--
--   وتُرتَّب المطابقات صراحةً: أعمدة الشركة نفسها قبل معرّفات مالكها، حتى لا
--   يصير الاختيار بين شركتين متطابقتين على نصّ واحد رهنَ ترتيب غير محدَّد.
--   الترحيل 042 كان يكتفي بـ limit 1 بلا ترتيب.
--
-- ما لم يتغيّر (متعمّد)
--   * شرط status = 'active' كما هو: الشركة الموقوفة لا تُسجِّل أحدًا.
--   * إثبات العضوية كما هو حرفيًا: super_user_id = المالك، أو المالك نفسه.
--     فالدالة ما زالت لا ترجع بريد العضو إلا بعد ثبوت عضويته في هذه الشركة
--     تحديدًا، ولا تقبل أي معرّف شركة موثوق من الواجهة.
--   * حدّا معدّل الطلبات كما هما (5/10د للشركة الواحدة، 60/5د إجمالًا).
--   * المنح كما هو: anon يحتاجها قبل وجود أي جلسة.
--
-- لماذا لا يوسّع هذا سطح التسريب
--   الخرج NULL في الحالتين — شركة غير موجودة، أو عضو غير تابع — فلا يفرّق
--   المهاجم بينهما. وإضافة بريد المالك توسّع ما يُقبل كمعرّف للشركة، لا ما
--   يُرجَع: النتيجة تظل محجوبة حتى تثبت عضوية العضو المطلوب في تلك الشركة.
-- ============================================================================

create or replace function public.resolve_company_member_login(p_company text, p_member text)
returns text language plpgsql stable security definer set search_path to 'public' as $$
declare v_company_id uuid; v_owner_id uuid; v_email text; v_member text; v_company text;
begin
  if p_company is null or p_member is null then return null; end if;

  v_company := btrim(p_company);
  if v_company = '' then return null; end if;

  if not public._check_email_lookup_rate_limit('company:' || lower(v_company), 5, 600) then
    raise exception 'محاولات كثيرة جدًا، حاول لاحقًا' using errcode='42901';
  end if;
  if not public._check_email_lookup_rate_limit('company_global', 60, 300) then
    raise exception 'محاولات كثيرة جدًا، حاول لاحقًا' using errcode='42901';
  end if;

  -- الشركة تُعرَف ببياناتها أو بمعرّفات مالكها. الترتيب صريح: أعمدة الشركة
  -- أولًا، فلا يزاحم بريدُ مالكٍ شركةً طابقت ببريدها هي.
  select c.id, c.user_id into v_company_id, v_owner_id
    from public.companies c
    left join public.profiles o on o.id = c.user_id
   where c.status = 'active'
     and (lower(c.company_email) = lower(v_company)
          or c.commercial_registration_number = v_company
          or public.normalize_phone(c.company_phone) = public.normalize_phone(v_company)
          or lower(o.email) = lower(v_company)
          or public.normalize_phone(o.phone) = public.normalize_phone(v_company))
   order by case
              when lower(c.company_email) = lower(v_company)                            then 1
              when c.commercial_registration_number = v_company                          then 2
              when public.normalize_phone(c.company_phone) = public.normalize_phone(v_company) then 3
              when lower(o.email) = lower(v_company)                                     then 4
              else 5
            end,
            c.id
   limit 1;
  if v_company_id is null then return null; end if;

  -- إثبات العضوية — منقول حرفيًا من 042 بلا تغيير.
  v_member := btrim(p_member);
  select p.email into v_email from public.profiles p
   where (p.super_user_id = v_owner_id or p.id = v_owner_id)
     and (lower(p.email) = lower(v_member)
          or public.normalize_phone(p.phone) = public.normalize_phone(v_member))
   limit 1;
  return v_email;
end;
$$;

comment on function public.resolve_company_member_login(text, text) is
  'تحلّ بريد عضو الشركة لشاشة الدخول. الشركة تُعرَف ببريدها أو سجلها التجاري '
  'أو هاتفها أو بمعرّفات مالكها؛ ولا يُرجَع البريد إلا بعد ثبوت عضوية العضو '
  'في تلك الشركة تحديدًا. محميّة بحدّ معدّل الطلبات ومتاحة لـ anon عمدًا.';

-- المنح كما قرّره 042: تُستدعى قبل وجود أي جلسة.
grant execute on function public.resolve_company_member_login(text, text) to anon, authenticated;


-- ── تحقّق ذاتي ────────────────────────────────────────────────────────────
do $$
declare v_src text;
begin
  if to_regprocedure('public.resolve_company_member_login(text,text)') is null then
    raise exception 'دالة حلّ عضو الشركة لم تُنشأ';
  end if;

  v_src := pg_get_functiondef(
             'public.resolve_company_member_login(text,text)'::regprocedure);

  if v_src !~ 'o\.email' then
    raise exception 'المطابقة لا تشمل بريد المالك — الخلل الأصلي باقٍ';
  end if;
  if v_src !~ 'status = ''active''' then
    raise exception 'شرط الشركة الفعّالة سقط — الشركة الموقوفة ستُسجِّل أعضاءها';
  end if;
  if v_src !~ 'super_user_id = v_owner_id' then
    raise exception 'إثبات العضوية سقط — الدالة قد تُرجع بريد غير عضو';
  end if;
  if v_src !~ '_check_email_lookup_rate_limit' then
    raise exception 'حدّ معدّل الطلبات سقط عن دالة متاحة لـ anon';
  end if;

  raise notice 'OK 043: الشركة تُعرَف ببياناتها أو بمعرّفات مالكها، والعضوية ما زالت تُثبَت في القاعدة';
end $$;
