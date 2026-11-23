-- ============================================================================
-- 126 — ذاكرة أسعار الصرف (fx_rates) لدالة fx-rate
--
-- المشكلة: الأسعار بالدولار والجنيه يُحسب وقت المحاسبة من سعر الصرف
-- الحي (الترحيل 125). دالة fx-rate تجلب السعر من البنك المركزي المصري
-- أولًا ثم Frankfurter، لكن بلا ذاكرة في القاعدة: أي تعذّر مؤقت في
-- المصدرين كان سيترك الفوترة بلا سعر إطلاقًا، وكل محاسبة كانت ستضرب
-- المصدر الخارجي من جديد.
--
-- الإصلاح: جدول fx_rates يحفظ كل سعر يُجلب (المصدر + الشراء/البيع +
-- تاريخ نشرة البنك + وقت الجلب)، فالدالة تردّ آخر سعر إن كان عمره أقل
-- من ساعة، وآخر سعر مهما كان عمره إن تعذّر المصدران، ولا تفشل إلا إن
-- لم يوجد أي سعر مخزَّن إطلاقًا (503).
--
-- الصلاحيات: RLS مفعّلة بلا سياسات للعموم — الجدول ذاكرة خادم فقط؛
-- دالة fx-rate تقرؤه وتكتب فيه بمفتاح الخدمة (يتجاوز RLS)، والمتصفح
-- لا يقرؤه مباشرة أبدًا (يقرأ السعر عبر الدالة فقط).
--
-- المتطلبات: لا شيء.
-- التراجع: drop table public.fx_rates (يحذف الذاكرة؛ الدالة ترجع 503
-- حتى أول جلب ناجح بعده).
-- ============================================================================

create table if not exists public.fx_rates (
  id uuid primary key default gen_random_uuid(),
  base text not null default 'USD',
  quote text not null default 'EGP',
  rate numeric not null check (rate > 0),
  buy numeric check (buy is null or buy > 0),
  sell numeric check (sell is null or sell > 0),
  source text not null check (source in ('cbe', 'frankfurter')),
  rate_date date not null,
  as_of timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists fx_rates_latest_idx
  on public.fx_rates (base, quote, as_of desc);

alter table public.fx_rates enable row level security;

-- ============================================================================
-- تحقق ذاتي: الجدول والفهرس موجودان.
-- ============================================================================
do $$
begin
  if to_regclass('public.fx_rates') is null then
    raise exception '126: fx_rates غير موجود';
  end if;
  if to_regclass('public.fx_rates_latest_idx') is null then
    raise exception '126: فهرس fx_rates_latest_idx غير موجود';
  end if;
end $$;
