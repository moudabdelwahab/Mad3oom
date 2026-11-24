-- تراجع 127: إعادة تعريف company_of() كما كان في 035 حرفيًا.
-- تحذير: هذا يعيد الثغرة (أي مستخدم موثَّق يسأل عن شركة أي مستخدم)؛
-- يُستعمل فقط إن تقرر التراجع الطارئ عن 127، مع العلم أن البديل الآمن
-- هو إبقاء 127 وإصلاح المستدعِي المنكسر بدل إعادة الثغرة.
create or replace function public.company_of(p_user_id uuid default auth.uid())
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id
    from public.companies c
   where p_user_id is not null
     and (c.user_id = p_user_id
          or c.user_id = (select p.super_user_id from public.profiles p where p.id = p_user_id))
   order by (c.user_id = p_user_id) desc
   limit 1;
$$;

comment on function public.company_of(uuid) is null;

revoke all on function public.company_of(uuid) from public, anon;
grant execute on function public.company_of(uuid) to authenticated;
