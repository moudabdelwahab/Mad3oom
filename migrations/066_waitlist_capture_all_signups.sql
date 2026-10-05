-- ============================================================================
-- 066_waitlist_capture_all_signups.sql
--   كل حساب جديد غير معتمَد يدخل قائمة الانتظار، أيًّا كانت طريقة تسجيله.
--
-- المشكلة
--   وضع «قائمة الانتظار» كان يُفرض في نموذج التسجيل بصفحة login.html فقط.
--   التسجيل عبر Google/GitHub (أو نداء signUp مباشر) ينشئ الحساب دون المرور
--   بالنموذج، فلا يُضاف صف في waitlist_entries. بوابة الحساب (042) كانت
--   تحجبه فعلًا (waiting_approval)، لكنه لا يظهر للأدمن في قائمة الانتظار،
--   فلا سبيل لاعتماده. في الإنتاج: 7 حسابات Google بين 2026-09-19 و2026-10-03.
--
-- الحل (في القاعدة، فيطال كل مسار تسجيل)
--   • محفّز AFTER INSERT على profiles: الحساب غير المعتمَد يُضاف للقائمة
--     «قيد المراجعة» مربوطًا بحسابه. لو للبريد طلب انتظار قائم من النموذج
--     يُربط به بدل التكرار. لا يُسقط التسجيل أبدًا (أي خطأ = تحذير فقط).
--   • عمود source: من أين جاء الطلب (form/google/github/email/admin).
--   • لو صار الحساب لاحقًا من الطاقم أو عضو شركة، يُحذف طلبه التلقائي المعلّق.
--   • إدراج الحسابات الناقصة الآن، ومعها ثلاثة حسابات قديمة طلب المالك
--     إدخالها القائمة صراحةً (سُجّلت قبل تفعيل البوابة فكانت معفاة).
--   • مالك المنصة (is_admin) يرى الطلبات ويديرها مثل الأدمن.
--
-- التطبيق في الإنتاج (2026-10-05): على دفعات 066a..066c بنفس المحتوى، بلا
-- «drop trigger if exists» لأن المحفّزين لم يكونا موجودين.
-- ============================================================================
begin;

-- ── 1) مصدر الطلب ──────────────────────────────────────────────────────────
alter table public.waitlist_entries
  add column if not exists source text not null default 'form';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'waitlist_entries_source_check') then
    alter table public.waitlist_entries add constraint waitlist_entries_source_check
      check (source in ('form', 'google', 'github', 'email', 'admin'));
  end if;
end $$;

comment on column public.waitlist_entries.source is
  'طريقة دخول الطلب: form = نموذج قائمة الانتظار، google/github/email = حساب أُنشئ مباشرة وأُضيف تلقائيًا، admin = أضافه الأدمن.';

-- ── 2) مالك المنصة يدير القائمة ────────────────────────────────────────────
-- سياسة إضافية (permissive) بجانب waitlist_entries_admin_all — لا تُحذف القديمة.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'waitlist_entries'
                    and policyname = 'waitlist_entries_platform_admin_all') then
    create policy waitlist_entries_platform_admin_all on public.waitlist_entries
      for all to authenticated
      using (public.is_admin()) with check (public.is_admin());
  end if;
end $$;

-- ── 3) الإضافة التلقائية ──────────────────────────────────────────────────
create or replace function public.waitlist_enqueue_new_account()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email    text := lower(btrim(new.email));
  v_provider text;
  v_meta     jsonb;
  v_name     text;
begin
  if v_email is null or v_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
    return new;
  end if;
  if public.account_is_whitelisted(new.id) then
    return new;
  end if;

  -- طلب من النموذج بنفس البريد (أو طلب يُعتمَد الآن عبر approve-waitlist-entry):
  -- يُربط بالحساب، ولا يُنشأ طلب مكرر.
  update public.waitlist_entries w
     set approved_user_id = new.id
   where lower(w.email) = v_email and w.status = 'pending' and w.approved_user_id is null;
  if found then
    return new;
  end if;

  if exists (select 1 from public.waitlist_entries w
              where w.status <> 'rejected'
                and (w.approved_user_id = new.id or lower(w.email) = v_email)) then
    return new;
  end if;

  select u.raw_app_meta_data->>'provider', u.raw_user_meta_data
    into v_provider, v_meta
    from auth.users u where u.id = new.id;

  v_name := coalesce(
    nullif(btrim(new.full_name), ''),
    nullif(btrim(concat_ws(' ', new.first_name, new.last_name)), ''),
    nullif(btrim(v_meta->>'full_name'), ''),
    nullif(btrim(v_meta->>'name'), ''),
    split_part(v_email, '@', 1));

  insert into public.waitlist_entries (name, email, phone, status, approved_user_id, source)
  values (v_name, v_email, new.phone, 'pending', new.id,
          case when v_provider in ('google', 'github') then v_provider else 'email' end)
  on conflict do nothing;

  return new;
exception when others then
  -- قائمة الانتظار لا تُسقط إنشاء حساب أبدًا؛ البوابة تحجبه على أي حال.
  raise warning 'waitlist_enqueue_new_account(%): %', new.id, sqlerrm;
  return new;
end;
$function$;
revoke all on function public.waitlist_enqueue_new_account() from public, anon, authenticated;

drop trigger if exists trg_waitlist_enqueue_new_account on public.profiles;
create trigger trg_waitlist_enqueue_new_account
  after insert on public.profiles
  for each row execute function public.waitlist_enqueue_new_account();

-- ── 4) حساب صار من الطاقم أو عضو شركة لا يبقى معلّقًا في القائمة ─────────────
create or replace function public.waitlist_drop_auto_entry_on_role()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.role in ('admin', 'support', 'platform_owner', 'company_admin', 'company_user')
     and new.role is distinct from old.role then
    delete from public.waitlist_entries w
     where w.approved_user_id = new.id and w.status = 'pending' and w.source <> 'form';
  end if;
  return new;
end;
$function$;
revoke all on function public.waitlist_drop_auto_entry_on_role() from public, anon, authenticated;

drop trigger if exists trg_waitlist_drop_auto_entry_on_role on public.profiles;
create trigger trg_waitlist_drop_auto_entry_on_role
  after update of role on public.profiles
  for each row execute function public.waitlist_drop_auto_entry_on_role();

-- ── 5) الحسابات الناقصة الآن ───────────────────────────────────────────────
-- (أ) طلب نموذج لصاحبه حساب بنفس البريد: يُربط به.
update public.waitlist_entries w
   set approved_user_id = p.id
  from public.profiles p
 where w.approved_user_id is null and w.status = 'pending'
   and lower(p.email) = lower(w.email);

-- (ب) كل حساب غير معتمَد بلا أي طلب، والثلاثة القديمة التي طلبها المالك.
--     الحساب المرفوض سابقًا لا يُعاد إدراجه. تاريخ الطلب = تاريخ إنشاء الحساب.
insert into public.waitlist_entries (name, email, phone, status, approved_user_id, source, created_at)
select coalesce(nullif(btrim(p.full_name), ''),
                nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
                nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
                nullif(btrim(u.raw_user_meta_data->>'name'), ''),
                split_part(lower(p.email), '@', 1)),
       lower(p.email), p.phone, 'pending', p.id,
       case when u.raw_app_meta_data->>'provider' in ('google', 'github')
            then u.raw_app_meta_data->>'provider' else 'email' end,
       p.created_at
  from public.profiles p
  left join auth.users u on u.id = p.id
 where p.email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
   and not exists (select 1 from public.waitlist_entries w
                    where w.approved_user_id = p.id or lower(w.email) = lower(p.email))
   and (not public.account_is_whitelisted(p.id)
        or (lower(p.email) in ('alshjyryalshjyryashrfalshjyry@gmail.com',
                               'shakrabdy0@gmail.com',
                               'aposuriye686@gmail.com')
            and coalesce(p.role, 'user') = 'user'));

-- (ج) الطلبات الثلاثة التي أدرجها 042 يدويًا ليست من النموذج: مصدرها حساب الدخول.
update public.waitlist_entries w
   set source = case when u.raw_app_meta_data->>'provider' in ('google', 'github')
                     then u.raw_app_meta_data->>'provider' else 'email' end
  from auth.users u
 where u.id = w.approved_user_id and w.source = 'form'
   and w.approved_user_id in ('494c025c-03ef-48eb-b17a-a9cb4ba349da',
                              '70736a4a-1ccc-4935-857b-7898deba14da',
                              '670a2e28-8dd6-4cd2-b124-c5e43ed7c933');

commit;
