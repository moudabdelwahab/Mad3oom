-- 1. إضافة عمود super_user_id لجدول profiles لربط المستخدمين بالـ Super User الخاص بهم
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS super_user_id UUID REFERENCES public.profiles(id);

-- 2. تحديث الـ RLS Policies لجدول profiles لضمان العزل
-- ملاحظة: سنقوم أولاً بحذف السياسات القديمة إذا كانت تتعارض، أو إضافة سياسات جديدة

-- سياسة تسمح للـ Super User برؤية المستخدمين التابعين له فقط
CREATE POLICY "Super Users can view their own sub-users" 
ON public.profiles 
FOR SELECT 
USING (
    auth.uid() = super_user_id OR -- المستخدم التابع يرى نفسه (مغطى بسياسات أخرى عادة)
    auth.uid() = id OR -- المستخدم يرى نفسه
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin' -- الأدمن يرى الكل
);

-- سياسة تسمح للـ Super User بتعديل بيانات المستخدمين التابعين له
CREATE POLICY "Super Users can update their own sub-users" 
ON public.profiles 
FOR UPDATE 
USING (
    auth.uid() = super_user_id OR 
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
);

-- سياسة تسمح للـ Super User بحذف المستخدمين التابعين له
CREATE POLICY "Super Users can delete their own sub-users" 
ON public.profiles 
FOR DELETE 
USING (
    auth.uid() = super_user_id OR 
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
);

-- 3. وظيفة للتحقق من صلاحية إنشاء Super User (فقط بواسطة support@mad3oom.online)
CREATE OR REPLACE FUNCTION public.is_main_admin() 
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (SELECT email FROM auth.users WHERE id = auth.uid()) = 'support@mad3oom.online';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. إضافة Role جديد 'super_user' إذا لم يكن موجوداً (عبر الـ check constraint أو منطق التطبيق)
-- بما أن الـ role هو نص، سنقوم فقط بالتأكد من استخدامه في الكود.

-- 5. تحديث السياسات للجداول الأخرى (مثل tickets, activity_logs) لضمان العزل أيضاً
-- سياسة التذاكر: Super User يرى تذاكر مستخدميه
CREATE POLICY "Super Users can view sub-users tickets" 
ON public.tickets 
FOR SELECT 
USING (
    user_id IN (SELECT id FROM public.profiles WHERE super_user_id = auth.uid()) OR
    user_id = auth.uid() OR
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
);

-- 6. تفعيل RLS على الجداول المتأثرة (احتياطاً)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
