# دالة `mcp` — لقطة من الإنتاج

هذا المجلد **لقطة حرفية** للمصدر المنشور فعليًا لدالة `mcp` في مشروع
`srnelrdpqkcntbgudyto`، حُفظت لأن الدالة لم تكن موجودة في أي مستودع.

| | |
|---|---|
| النسخة المنشورة وقت اللقطة | **31** |
| `ezbr_sha256` | `834398b04c0e3689ce21001b63a66f3a1f1f9fa7a057a4495ba708df13756162` |
| `verify_jwt` | `false` |
| عدد الملفات | 11 |

## ⚠️ لم تعد لقطة حرفية — تعديل واحد مقصود (2026-09-16)

كانت هذه اللقطة حرفية تمامًا حتى تحوّل الدومين. **سطر واحد تغيّر منذئذ**،
بموافقة صريحة من صاحب المشروع:

```diff
-const PROTECTED_RESOURCE_METADATA_URL = "https://mad3oom.online/.well-known/oauth-protected-resource";
+const PUBLIC_SITE_ORIGIN = Deno.env.get("PUBLIC_SITE_ORIGIN") ?? "https://mad3oom.com";
+const PROTECTED_RESOURCE_METADATA_URL = `${PUBLIC_SITE_ORIGIN}/.well-known/oauth-protected-resource`;
```

السبب: هذه الترويسة (`WWW-Authenticate` على 401) هي **أول ما يتبعه أي عميل
MCP** لبدء اكتشاف OAuth. كانت تُرسل كل عميل إلى الدومين القديم مهما فُعل
ببقية الدوال، وهناك تموت السلسلة (تفصيل الدليل في
`docs/MCP-CANONICAL-CUTOVER.md`). كانت هذه الدالة الخامسة المنسيّة في
قائمة `docs/DOMAIN-MIGRATION.md` التي تعدّ أربعًا.

**نسخة ما قبل التعديل، حرفيًا كما كانت منشورة (v31):**

```bash
git show 398fd26:supabase/functions/mcp/index.ts
```

**التراجع:** ضبط `PUBLIC_SITE_ORIGIN` على `https://mad3oom.online` — يعيد
السلوك القديم بالحرف بلا أي إعادة نشر.

## ما لم يُعدَّل

عدا السطر أعلاه، اللقطة كما هي. تحديدًا **لم تُغيَّر**:

- `MAIN_ADMIN_EMAILS` — ما زال على `@mad3oom.online`
- بنية ترويسة `WWW-Authenticate` نفسها (تغيّرت قيمة الرابط فقط، لا شكلها)
- أي منطق مصادقة أو تفويض أو أسماء أدوات

## ما جرى التحقق منه

- ✅ الصياغة تُحلَّل بـ`tsc` بلا أخطاء بنيوية
- ✅ كل `import` يشير إلى ملف موجود داخل اللقطة
- ✅ أسماء الأدوات الـ18 في `callTool()` مطابقة تمامًا لصفوف `mcp_tools_catalog` الحيّة
- ✅ الثوابت الحرجة محفوظة حرفيًا

## ما لم يجرِ التحقق منه

**المطابقة بايت-لبايت مع الحزمة المنشورة.** اللقطة نُسخت عبر واجهة الإدارة،
ولا توجد وسيلة في بيئة العمل الحالية لتنزيل الحزمة الأصلية ومقارنتها
(لا `supabase` CLI، والشبكة إلى `supabase.co` محجوبة بسياسة المؤسسة).

قبل الاعتماد على هذا المجلد كمصدر للنشر، شغّل من جهازك:

```bash
supabase functions download mcp --project-ref srnelrdpqkcntbgudyto
diff -r <المجلد_المنزَّل> supabase/functions/mcp
```

## ملاحظة على نوع قائم (بلا أثر تشغيلي)

`getVisibleUserIds()` تُرجع اتحادًا `{all:true} | {all:false; ids:string[]}`،
و`tsc` لا يُضيّقه عند `if (!visibility.all)` فيشكو من `visibility.ids`
في خمسة مواضع. **هذا موجود في المصدر المنشور نفسه، ولم تُدخِله اللقطة** —
وبلا أثر تشغيلي لأن Edge Functions تُجرَّد أنواعها عند البناء. مذكور هنا
حتى لا يُظَن لاحقًا أنه انحراف في اللقطة.
