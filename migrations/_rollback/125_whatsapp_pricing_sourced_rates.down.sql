-- تراجع 125: حذف مفتاحي الأسعار بالدولار.
-- يُستعمل فقط إن تقرر التراجع عن التسعير بالدولار؛ المفتاحان القديمتان
-- بالجنيه (template_charge_egp/text_charge_egp) لم يمسّهما الترحيل 125
-- أصلًا، فيبقيان كما هما وتعود مسارات الإرسال لقراءتهما بعد إعادة
-- الكود السابق (أو يبقى الافتراضي في الكود).
delete from public.integration_settings where key in ('template_charge_usd', 'text_charge_usd');
