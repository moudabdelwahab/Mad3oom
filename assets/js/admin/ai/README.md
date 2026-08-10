# نظام مزوّدي الذكاء الاصطناعي (AI Provider System)

`admin/mcp.html` **لوحة إدارة فقط**. لا تنادي أي مزوّد، ولا ترى أي مفتاح، ولا تعرف
أسماء المزوّدين مسبقًا. كل تشغيل حقيقي يحدث في Edge Functions مستقلة.

```
admin/mcp.html  ──►  assets/js/admin/ai/*  ──►  Supabase (جداول إعدادات)
   (إدارة)              (عرض فقط)                     ▲
                                                       │ يقرأ الإعدادات
                                    ai-gateway (Edge) ──┘
                                          │
                     ProtocolAdapter (openai | anthropic | gemini | custom_http)
                                          │
                                    أي مزوّد خارجي
```

## إضافة مزوّد جديد

**سطر SQL واحد. صفر تعديل كود، صفر إعادة نشر.**

```sql
INSERT INTO public.ai_provider_catalog
  (id, label, label_ar, kind, protocols, default_endpoints,
   auth_methods, credential_fields, models_discovery, sort_order)
VALUES (
  'myprovider', 'My Provider', 'مزوّدي', 'ai_provider',
  ARRAY['openai'],
  '{"openai":"https://api.myprovider.com/v1"}'::jsonb,
  ARRAY['api_key'],
  '[{"key":"api_key","label":"API Key","label_ar":"مفتاح API","type":"password","required":true}]'::jsonb,
  '{"supported":true,"protocol":"openai","path":"/models"}'::jsonb,
  100
);
```

بعدها مباشرة: يظهر في قائمة "إضافة مزوّد"، بفورم بحقوله الخاصة، ويعمل معه
الاختبار ومزامنة الموديلات والتوجيه والاحتياطي وتتبّع التكلفة.

### مزوّد بأكثر من بروتوكول

`AgentRouter` مثال حي: بوابة واحدة بواجهتين.

```jsonc
protocols: ["anthropic", "openai"],
default_endpoints: {
  "anthropic": "https://co.agentrouter.org",      // ثم /v1/messages
  "openai":    "https://co.agentrouter.org/v1"    // ثم /chat/completions
}
```

**لا يُضاف `/v1` تلقائيًا في أي مكان.** البروتوكول هو ما يحدّد المسار النهائي:
البروتوكول `anthropic` يضيف `/v1/messages` لرابط بلا `/v1`، والبروتوكول `openai`
يضيف `/chat/completions` لرابط يتضمّن `/v1` بالفعل. لو احتاج مزوّد مسارًا شاذًا،
يُوضَع في `endpoint_paths` بالكتالوج دون لمس أي كود.

## إضافة بروتوكول جديد

ملف واحد + سطر تسجيل في `supabase/functions/ai-gateway/protocols.ts`:

```ts
const myAdapter: ProtocolAdapter = { id: 'myproto', chatUrl, modelsUrl, headers, buildBody, parseResponse, parseModels };
const PROTOCOLS = { ..., myproto: myAdapter };
```

`index.ts` و`router.ts` و`usage.ts` والواجهة كلها: صفر تعديل.

## الملفات

| الملف | الدور |
|---|---|
| `provider-registry.js` | قراءة `ai_provider_catalog` + حلّ البروتوكول/الرابط/حقول الاعتماد |
| `capability-registry.js` | تعريف القدرات وتصنيفها وشرط فتح بيئة التطوير |
| `ai-service.js` | كل نداءات Supabase وEdge Functions (لا منطق عرض) |
| `ai-admin.js` | الحالة المشتركة + التبويبات + تفويض الأحداث |
| `ui/providers-view.js` | بطاقات المزوّدين + الفورم الديناميكي |
| `ui/models-view.js` | قائمة الموديلات + شارات القدرات + التعديل اليدوي |
| `ui/routing-view.js` | سلاسل التوجيه والاحتياطي + معاينة المسار |
| `ui/usage-view.js` | الاستخدام والتكلفة وزمن الاستجابة والأخطاء |
| `ui/dev-environment.js` | بيئة التطوير: أوضاع + جلسات + ألواح Terminal/Changes/Logs/Usage |
| `ui/shared.js` | أدوات عرض مشتركة (تنسيق، أيقونات، حالات فارغة) |

## الأمان

- لا يوجد أي API Key في الواجهة. الحفظ يمر عبر `manage-external-integration`
  التي تشفّر (AES-GCM) قبل التخزين، ولا تُقرأ المفاتيح مرة أخرى أبدًا.
- العرض يعتمد على بصمة مقنّعة (`key_prefix` + `key_last_four`) تُحسب على
  الخادم وقت الحفظ: `sk-••••••••8F92`.
- `ai_usage_events` لا تملك سياسة كتابة عمدًا — الكتابة حصريًا بـ service_role
  من داخل Edge Functions.

## بيئة التطوير — ما هو مفعّل وما هو ليس كذلك

مفعّل: أوضاع التشغيل السبعة، الجلسات المحفوظة، سجل كل نداء (مزوّد/موديل/توكنات/
تكلفة/زمن)، والانتقال التلقائي للاحتياطي عند الفشل.

**غير مفعّل عمدًا** (نقاط امتداد معرَّفة بالاسم، ترجع `extension_not_enabled`):
`sandbox` • `repository` • `github` • `filesystem` • `terminal` • `code_execution`.

لا يوجد تنفيذ كود ولا نظام ملفات ولا طرفية حقيقية في المتصفح. تفعيل أي منها
لاحقًا يتم في `ai-session` وحدها — الواجهة تعرضها تلقائيًا دون تعديل.
