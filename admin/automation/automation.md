# تقرير فني شامل — `automation.html` (Workflow Builder)

> **الهدف من هذا الملف:** مرجع فني كامل لصفحة `automation.html` بحيث عند طلب أي تعديل مستقبلًا، يبدأ العمل من قراءة هذا التقرير بدل قراءة الملف كاملًا (٢٧٠٠+ سطر). التقرير يوضّح: أين يقع كل جزء (بأرقام الأسطر التقريبية وقت كتابة هذا التقرير)، كيف تتدفق البيانات، شكل كل جدول في Supabase كما يفترضه الكود، وكل قيد/نقص معروف.
>
> **تنبيه مهم:** أرقام الأسطر أدناه صحيحة اعتبارًا من هذه النسخة فقط، وستنزاح مع أي تعديل لاحق (إضافة/حذف أسطر). عند إجراء تعديل استخدم `grep`/بحث عن اسم الدالة أو الـ id بدل الاعتماد على رقم السطر وحده. **بعد أي تعديل جوهري على البنية، حدّث هذا الملف.**

---

## 1) نظرة عامة

- ملف HTML واحد ذاتي الاحتواء (CSS + JS مضمّنين، لا ملفات خارجية غير الخطوط و3 imports من نفس المنصة).
- يعرض صفحتين منطقيتين داخل نفس الـ DOM عبر تبديل `class="wf-active"`:
  1. **قائمة الـ Workflows** (`#wfListView`)
  2. **محرر الـ Workflow / Builder** (`#wfBuilderView`) — تصميم شبيه بـ n8n/Zapier: مكتبة عناصر + Canvas قابل للسحب والتكبير + Inspector ديناميكي + لوحة سفلية (تحقق/تشغيل/سجلات) + لوحة إصدارات جانبية.
- اللغة: عربي بالكامل (`dir="rtl"`)، لكن إحداثيات الـ Canvas نفسه تُفرض LTR دائمًا (`canvasWrap.setAttribute('dir','ltr')`) بحيث يمين = مخرج (output)، يسار = مدخل (input)، بغضّ النظر عن اتجاه الصفحة.
- الاتصال بالبيانات عبر Supabase مباشرة من المتصفح (`import { supabase } from '/api-config.js'`) — لا يوجد Backend API وسيط في هذا الملف.
- المصادقة عبر `checkAdminAuth()` / `updateAdminUI()` من `/assets/js/admin/auth.js` — الصفحة تنتظر هذا قبل أي رندر (`#wfAuthGate`).

### البنية العريضة للملف
| القسم | الوصف |
|---|---|
| `<style>` (أعلى الملف) | كل الـ CSS، محصور داخل `.wf-shell` (namespaced) حتى لا يتعارض مع بقية لوحة الإدارة |
| `<body>` → HTML ثابت | هيكل الصفحتين (List / Builder) + مودال إنشاء Workflow + Toast container |
| `<script type="module">` | كل منطق التطبيق (~2100 سطر JS) |

---

## 2) نظام التصميم (Design Tokens)

كل المتغيرات معرّفة داخل `.wf-shell{...}` (Dark افتراضي)، ويُعاد تعريف جزء منها داخل `html[data-theme="light"] .wf-shell{...}` (Light overrides) — نفس آلية باقي المنصة عبر `theme-manager.js`.

أهم المتغيرات:
- ألوان الخلفية: `--wf-bg-void` (الخلفية العامة), `--wf-bg-surface`, `--wf-bg-elevated` (بطاقات/لوحات)
- زجاجية: `--wf-glass`, `--wf-glass-strong`, `--wf-glass-border` (تُستخدم في كل الحدود الشفافة تقريبًا)
- ألوان دلالية: `--wf-primary` (أزرق أساسي `#0077CC`), `--wf-accent` (`#4DA3FF`), `--wf-success`, `--wf-danger`, `--wf-whatsapp`, `--wf-mcp`
- نص: `--wf-text-1` (أساسي), `--wf-text-2` (ثانوي), `--wf-text-3` (باهت جدًا)
- خطوط: `--wf-font-display` = Cairo (عناوين), `--wf-font-body` = IBM Plex Sans Arabic (نص عام), `--wf-font-data` = Space Grotesk (أرقام/بيانات تقنية مثل نسبة الزوم وأرقام الإصدارات)
- شارات الحالة (badges): أزواج `--wf-pill-*-bg` / `--wf-pill-*-text` لكل لون (green/amber/blue/purple/gray/red)

**كل الكلاسات مسبوقة بـ `wf-`** لتفادي أي تصادم مع كلاسات لوحة الإدارة العامة (`.wf-btn`, `.wf-card`, `.wf-badge`, `.wf-input`...). عند إضافة عنصر UI جديد، اتّبع نفس الاصطلاح والتزم باستخدام الـ CSS variables بدل قيم لون ثابتة.

---

## 3) نظام الأيقونات (SVG Icon System) — أُضيف في تعديل سابق

كل الإيموجي في الملف استُبدلت بأيقونات SVG (نمط Feather: `stroke-width:2`, `viewBox 0 0 24 24`, `stroke-linecap/linejoin: round`). الموقع: قرب أعلى الـ `<script>` (بعد `isStaffFieldOptional`, تقريبًا السطر **605-651**).

```js
const ICON_PATHS = { box, alertTriangle, zap, tag, clock, pin, play, pause, archive,
  barChart, fileText, activity, user, tool, star, checkCircle, x, search, edit,
  copy, trash, settings, plus, minus, undo, info };
function ic(name, size)       // أيقونة outline (تتلوّن عبر currentColor) — الافتراضي
function icFilled(name, size) // أيقونة معبّأة (تُستخدم لـ play/pause وحالة "مفضّل" المفعّلة)
```

**قاعدة مهمة:** أيقونات أنواع الـ Nodes نفسها (`nt.icon`, `nt.color`) **تأتي من قاعدة البيانات** (عمود `wf_node_types.icon`)، وهي غالبًا إيموجي محفوظ في الداتابيز نفسها — هذه **خارج نطاق هذا الملف تمامًا**. الكود هنا يستخدم `ic('settings', ...)` فقط كـ **fallback** لو `nt.icon` فاضي.

**لإضافة أيقونة جديدة:** أضف مفتاحًا جديدًا في `ICON_PATHS` (محتوى `<path>`/`<line>`/... بدون وسم `<svg>` الخارجي)، ثم استخدمها عبر `ic('اسم_المفتاح', حجم_بالبكسل)`.

---

## 4) نموذج البيانات المفترض (Supabase Schema كما يستخدمه الكود)

> هذا **ليس** تعريف Schema رسمي؛ هو استنتاج من كل استعلامات `supabase.from(...)` الموجودة فعليًا في الكود. أي تعديل على أعمدة هذه الجداول في قاعدة البيانات الحقيقية يجب أن ينعكس هنا وفي الكود معًا.

### `wf_workflows` (الجدول الرئيسي لكل Workflow)
| العمود | الاستخدام |
|---|---|
| `id`, `name`, `description` | أساسيات |
| `status` | `draft` \| `active` \| `paused` \| `archived` — **حالة تشغيلية** (منفصلة عن حالة الإصدار) |
| `current_draft_version_id` | FK → `wf_workflow_versions.id` (المسودة الجارية) |
| `published_version_id` | FK → `wf_workflow_versions.id` (آخر إصدار منشور) |
| `trigger_event_key` | مفتاح الحدث الفعلي (يُشتق من نوع الـ trigger node عند النشر فقط) |
| `trigger_config` | نسخة من إعدادات الـ trigger عند آخر نشر |
| `created_by`, `created_at`, `updated_at` | تتبّع |

**علاقتان مُضمَّنتان (embedded FK)** عبر أسماء صريحة في كل استعلامات `listWorkflows`/`getWorkflow`:
```
draft_version:wf_workflow_versions!wf_workflows_current_draft_version_id_fkey(*)
published_version:wf_workflow_versions!wf_workflows_published_version_id_fkey(*)
```
هذا يعني: **لا يوجد View منفصل**، والكود يعتمد بشكل مباشر على وجود هذين اسمي الـ FK Constraints بالضبط في قاعدة البيانات. لو تغيّر اسم أي Constraint في الداتابيز، هذا الاستعلام سيفشل.

### `wf_workflow_versions` (كل إصدار/مسودة لأي Workflow — Append-only تقريبًا)
| العمود | الاستخدام |
|---|---|
| `id`, `workflow_id`, `version_number` | أساسيات |
| `status` | `draft` \| `published` \| `archived` (حالة الإصدار نفسه، **مختلفة** عن `wf_workflows.status`) |
| `definition` | `{ nodes: [...], edges: [...] }` — **مصدر الحقيقة الوحيد** لمخطط الـ Canvas |
| `variables` | كائن مفتاح/قيمة لمتغيرات الـ Workflow اليدوية (يُحرَّر من "إعدادات الـ Workflow" في الـ Inspector) |
| `trigger_config` | ⚠️ انظر قسم 8 — يُشتق الآن تلقائيًا من `node.config` الخاص بعقدة الـ trigger |
| `trigger_event_key` | يُكتب فقط لحظة النشر (`extractTriggerEventKey`) |
| `published_at`, `created_by` | تتبّع |

**مهم:** لا يوجد عمود `definition`/`variables`/`trigger_config` قابل للتعديل مباشرة على `wf_workflows` نفسها — هذه الثلاثة تعيش **فقط** داخل `wf_workflow_versions`. أي كود يحاول تحديثها على `wf_workflows` مباشرة فهو خطأ منطقي.

### `wf_node_types` (كتالوج أنواع الـ Nodes — للقراءة فقط من هذا الملف)
الأعمدة المستخدمة: `key` (مثل `trigger.ticket_created`), `category` (`trigger`|`condition`|`action`|`ai`|`api`|`database`|`delay`|`loop`|`control`), `name_ar`, `name_en`, `icon`, `color`, `description`, `handler_type` (لو `NULL` → لم يُبنَ له منفّذ فعلي بعد، يظهر badge "بانتظار التنفيذ")، `output_vars` (مصفوفة نصوص، أسماء المتغيرات التي تنتجها هذه العقدة)، `config_schema` (كائن `{ fields: [...] }` — يبني منه Inspector النموذج ديناميكيًا بالكامل، **لا نماذج ثابتة في الكود**)، `is_active`, `sort_order`.

**شكل كائن `field` داخل `config_schema.fields[]`:**
```
{ key, type, label, placeholder?, default?, optional?, options?, supports_variables?, source_table? }
```
أنواع `field.type` المدعومة حاليًا (كل نوع له case في `buildFieldControl`، حوالي السطر **2297-2432**):
`text` (افتراضي) · `textarea` · `select` · `number` · `tags` · `key_value_list` · `variable_picker` · `staff_picker` · `integration_picker` · `mcp_tool_picker` · `webhook_picker`

**لإضافة نوع حقل جديد:** أضف `case` جديد داخل `buildFieldControl` (حوالي السطر 2323 فصاعدًا) يبني `control` (عنصر DOM) ويربطه بـ `node.config[field.key]`.

### جداول أخرى للقراءة فقط
| الجدول | يُستخدم في | الأعمدة |
|---|---|---|
| `mcp_tools_catalog` | قائمة `mcp_tool_picker` | `name, scope, description` |
| `profiles` | قائمة `staff_picker` (فقط `role in ('admin','support')`) | `id, full_name, email, role` |
| `external_integrations` | قائمة `integration_picker` (فقط `is_active=true`) | `id, provider, display_name` |
| `wf_webhook_endpoints` | قائمة `webhook_picker` لكل Workflow محدَّد | كل الأعمدة، مُفلترة بـ `workflow_id` |
| `wf_runs` | تبويب "سجل التشغيل" | كل الأعمدة، مُفلترة بـ `workflow_id`, مرتّبة `started_at desc`, حد ٢٥ |

### جدول موجود بالاسم فقط (لم يُستخدم بعد فعليًا)
`wf_run_steps` — مذكور في تعليق TODO فقط (سطر ~2538)؛ الهدف منه تخزين تفاصيل كل خطوة تنفيذ، لكن **لا يوجد Executor فعلي بعد** يكتب إليه، فتبويبات "السجلات/الجدول الزمني/المقاييس" في اللوحة السفلية كلها Placeholder ثابت (انظر قسم 12).

---

## 5) حالة التطبيق العامة — `appState`
(تعريفه حوالي السطر **555-566**)

```js
const appState = {
    currentUser: null,
    workflows: [],             // كاش قائمة الـ Workflows (List view) — كل صف يحمل draft_version/published_version مضمَّنة
    nodeTypes: [],              // كل صفوف wf_node_types
    nodeTypesByKey: {},         // نفس القائمة مفهرسة بـ key للوصول السريع (nt = appState.nodeTypesByKey[node.type])
    mcpTools: [], staff: [], integrations: [],
    currentWorkflowWebhooks: [],// webhooks الخاصة بالـ Workflow المفتوح حاليًا في الـ Builder فقط
    openTabs: [],                // جلسات الـ Builder المفتوحة (تعدد تابات)، كل عنصر = "Session" (قسم 6)
    activeTabId: null,
    view: 'list'                 // 'list' | 'builder'
};
```

`appState.nodeTypesByKey` هو **المرجع الأهم** المستخدم في كل مكان تقريبًا لترجمة `node.type` (مثل `"action.send_whatsapp"`) إلى بيانات العرض (الاسم، اللون، الأيقونة، الحقول).

---

## 6) طبقة البيانات — `DataLayer` (سطر **660-817**)

كل دوال الوصول لـ Supabase مجمّعة هنا فقط (لا يوجد استدعاء `supabase.from` خارج هذا الكائن). أهم الدوال:

| الدالة | ماذا تفعل |
|---|---|
| `listWorkflows()` | كل الـ Workflows + draft_version + published_version مضمَّنة، مرتّبة `updated_at desc` |
| `getWorkflow(id)` | نفس الشيء لِـ Workflow واحد |
| `createWorkflow({name, description, created_by})` | يُنشئ صف `wf_workflows` **ثم** أول صف `wf_workflow_versions` (v1, draft, definition فاضي) **ثم** يربطهما عبر تحديث `current_draft_version_id` — 3 استعلامات متتابعة |
| `duplicateWorkflow(sourceFull, newName, created_by)` | ينسخ Workflow كامل: صف جديد + v1 draft بمحتوى منسوخ من (`draft_version` أو `published_version` أيهما موجود) |
| `updateWorkflowMeta(id, patch)` | تحديث عام على `wf_workflows` (name/description/status/updated_at) |
| `updateDraftVersion(versionId, patch)` | تحديث عام على صف مسودة (`definition`/`variables`/`trigger_config`/`trigger_event_key`) |
| `publishWorkflow(workflowId, draftVersionId, created_by)` | **العملية الأهم** — انظر قسم 7 بالتفصيل |
| `restoreVersionIntoDraft(draftVersionId, versionRow)` | يستبدل محتوى المسودة الحالية بمحتوى إصدار قديم (استعادة) |
| `deleteWorkflow(id)` | حذف نهائي — يفشل غالبًا بخطأ FK لو للـ Workflow إصدارات/تشغيلات سابقة (يُعالَج في `deleteWorkflowConfirm` برسالة توضّح استخدام الأرشفة بدلًا من الحذف) |

---

## 7) دورة حياة الإصدارات (Draft ⇄ Published) — الأهم فهمًا في كل الملف

هذا النظام **مصدر حقيقة مزدوج** لازم يُفهم قبل أي تعديل على منطق الحفظ/النشر:

1. كل Workflow له **مسودة حالية واحدة فقط** قابلة للتعديل (`current_draft_version_id`)، و**إصدار منشور واحد فقط** (قد يكون `null` لو لم يُنشر بعد).
2. المستخدم يحرر دائمًا **المسودة** فقط (`s.definition` في الـ Session = نسخة من `draft_version.definition`).
3. **الحفظ (`saveDraft`)** = تحديث صف المسودة الحالي في `wf_workflow_versions` بدون إنشاء صف جديد ولا تغيير حالة الـ Workflow.
4. **النشر (`publishWorkflow` في الواجهة → `DataLayer.publishWorkflow` في الطبقة الخلفية):**
   - يحفظ آخر تعديلات المسودة أولًا (`saveDraft(true)`)
   - يستخرج `trigger_event_key` من التعريف الحالي ويكتبه على صف المسودة (**قبل** ترقيته)
   - `DataLayer.publishWorkflow` ثم:
     أ) يحوّل صف المسودة الحالي إلى `status:'published'` (يصبح هذا الصف **immutable** منطقيًا من الآن)
     ب) ينشئ صف مسودة **جديد** (`version_number + 1`) بنفس المحتوى (definition/trigger_config/**trigger_event_key**) ليكمل عليه المستخدم
     ج) يحدّث `wf_workflows`: `status:'active'`, `published_version_id`, `current_draft_version_id` (يشير للمسودة الجديدة), وينسخ `trigger_event_key`/`trigger_config` من الإصدار المنشور
5. **لا يوجد Rollback حقيقي** — "استعادة إصدار قديم" (`restoreVersionIntoDraft`) لا تُنشئ نسخة جديدة، بل **تكتب فوق المسودة الحالية** بمحتوى الإصدار القديم (وتطلب تأكيدًا من المستخدم لأن هذا يفقد أي تعديل غير محفوظ في المسودة الحالية).

**حالة `readOnly`:** المسودة قابلة للتعديل طالما `status !== 'archived'` (أي draft/active/paused كلها قابلة للتعديل عبر مسودتها الحالية — الأرشفة فقط تجعل التبويب للقراءة).

---

## 8) نظام الـ Trigger — تفاصيل مهمة (عُدِّل مؤخرًا)

القيد الأساسي في الـ Backend: **Workflow واحد = trigger_event_key واحد فقط.** حتى لو أضاف المستخدم أكثر من عقدة trigger على الـ Canvas، سيُعتمد **الأول فقط** حسب ترتيب المصفوفة `definition.nodes` (وليس ترتيب العرض البصري بالضرورة).

الدوال (سطر **819-846**، كلها تشترك في دالة واحدة الآن بعد التعديل الأخير):
```js
findTriggerNode(definition)        // أول node يبدأ type بـ "trigger." — نقطة الحقيقة الوحيدة، تُستخدم من الجميع
extractTriggerEventKey(definition) // trigger.type بدون بادئة "trigger." → يُكتب في wf_workflows.trigger_event_key عند النشر فقط
extractTriggerConfig(definition)   // trigger.config (أي إعدادات المستخدم في حقول عقدة الـ trigger) → يُكتب في trigger_config عند كل حفظ
```

### إصلاحات تمت على هذا الجزء (سجّلها هنا حتى لا تتكرر المشكلة):
- **كان `trigger_config` يبقى `{}` دائمًا** لأن لا شيء كان يربطه فعليًا بإعدادات عقدة الـ trigger. الآن `saveDraft()` يستدعي `extractTriggerConfig(s.definition)` في كل حفظ ويحدّث `s.triggerConfig` منه مباشرة قبل الإرسال لِـ Supabase.
- **كانت المسودة الجديدة بعد النشر تفقد `trigger_event_key`** (الـ `insert` كان ينسخ definition/trigger_config/variables لكن ليس trigger_event_key) — تم إصلاحه في `DataLayer.publishWorkflow`.
- **رسالة تحذير "أكثر من مشغّل واحد" كانت غامضة.** الآن `validateDefinition()` (قسم 11) يضيف تحذيرًا **منفصلًا لكل trigger زائد عن الأول**، يذكر اسمه بالضبط ويوضح أنه سيُتجاهل تمامًا عند النشر، ويحمل `nodeId` بحيث الضغط على رسالة التحقق في اللوحة السفلية يوديك مباشرة لتلك العقدة.

### قيود معروفة لم تُحل بعد (Backend غير موجود أصلًا)
- **لا يوجد Trigger Dispatcher فعلي.** التعليق الأصلي في الكود (سطر ~819) يوضّح أن `trigger_event_key` المُشتق من اسم الـ node type هو **إشارة أولية فقط** ريثما يُبنى نظام ربط حقيقي بين كل `trigger.*` ومفتاح حدث رسمي قادم من مصدر الحدث الفعلي (Webhook / Cron / قاعدة بيانات...).
- تعدد المشغّلات (OR logic بين أكثر من Trigger) **غير مدعوم فعليًا** حاليًا رغم أن الواجهة تسمح بإضافة أكثر من واحد بصريًا — إن أردنا دعم هذا مستقبلًا، يلزم تغيير في الـ Backend (عمود واحد → مصفوفة) وليس فقط في هذا الملف.

---

## 9) تبسيط أسماء المتغيرات للمستخدم العادي (Variable Humanization) — أُضيف مؤخرًا

**المشكلة الأصلية:** أي مكان يعرض متغيّرًا متاحًا للاستخدام (اختيار متغيّر في حقل، قائمة "إدراج بيانات"، شرائح "البيانات المتاحة") كان يعرض المفتاح التقني الخام كما هو، مثل: `subscription.user_id — اقتراب انتهاء اشتراك` — غير مناسب لجمهور غير تقني.

**الحل** (سطر **~2113-2148**):
```js
const VAR_WORD_MAP = { user, customer, ticket, subscription, order, payment, invoice,
  agent, staff, email, phone, name, full, plan, status, amount, total, price, reason,
  reference, number, code, title, content, body, type, category, priority, subject,
  message, url, link, channel, notification, id, end, start, created, updated };
  // كل مفتاح إنجليزي → قيمته تسمية عربية واحدة

function humanizeVarKey(key) {
  // ياخد آخر جزء بعد آخر نقطة فقط (subscription.user_id → "user_id")
  // يقسّم على "_" ويحاول ترجمة كل رمز
  // حالة خاصة: "xxx_id" → "معرّف xxx" (وليس "xxx معرّف")
  // حالة خاصة: "xxx_date" أو "xxx_at" → "تاريخ xxx"
  // لو مفيش أي ترجمة معروفة → null (وليس عرض المفتاح الخام)
}

function friendlyVarLabel(u) {
  // u = { v: المفتاح التقني, from: اسم العقدة المصدر }
  // يرجّع "الترجمة — اسم العقدة المصدر"، أو "اسم العقدة المصدر" فقط لو تعذّرت الترجمة
  // (لا يُعرض المفتاح التقني الخام أبدًا تحت أي ظرف)
}
```

**أماكن الاستخدام الثلاثة (لازم تتحدّث الثلاثة معًا لو غيّرت المنطق):**
1. `case 'variable_picker'` داخل `buildFieldControl` (سطر ~2361) — قائمة اختيار متغيّر في حقل Inspector (هذا بالضبط ما كان يظهر في السكرين شوت الذي أرسله المستخدم)
2. `openVarMenu()` (سطر ~2495) — قائمة "إدراج بيانات" السريعة فوق حقول النص/textarea
3. شرائح "البيانات المتاحة لاستخدامها لاحقًا" داخل `renderNodeInspector` (سطر ~2282) — تعرض `nt.output_vars` بعد تبسيطها، مع الاحتفاظ بالمفتاح الخام في `title` (tooltip) فقط لأغراض تقنية

**مهم:** القيمة الفعلية المخزَّنة داخل `node.config[field.key]` تبقى دائمًا الصياغة التقنية الكاملة `{{subscription.user_id}}` — التبسيط **عرضي (label) فقط** ولا يغيّر البيانات المحفوظة أو طريقة عمل الـ Executor مستقبلًا.

**لإضافة كلمة جديدة للقاموس:** أضف مفتاحًا لِـ `VAR_WORD_MAP`. تأكد أن أي كلمة تُستخدم كـ "أساس" في حالة `_id`/`_date`/`_at` الخاصة (مثل `end`, `start`, `created`, `updated`) موجودة فعلًا في القاموس، وإلا سيرجع فقط الكلمة العامة "المعرّف"/"التاريخ" بدل التفصيل.

---

## 10) الجلسات والتابات (Sessions & Tabs) — قلب الـ Builder

`createSession(workflowFull, isNew)` (سطر ~1153) يبني كائن **Session** واحد لكل تبويب مفتوح في الـ Builder. كل Session مستقل تمامًا (تعديل في تبويب لا يؤثر على آخر حتى لو نفس الـ Workflow لم يُفتح مرتين).

**أهم حقول الـ Session:**
```js
{
  id, name, description, status, createdBy, updatedAt, createdAt,
  draftVersionId, draftVersionNumber, publishedVersion,
  definition,     // نسخة مستقلة (deep clone) من draft.definition — هذا ما يُعدَّل على الـ Canvas مباشرة
  variables, triggerConfig,
  savedSnapshot,  // JSON.stringify({definition, variables}) وقت آخر حفظ ناجح — للمقارنة
  history, historyIndex,  // Undo/Redo (مصفوفة JSON snapshots لِـ definition فقط)
  pinned,          // تثبيت التبويب (لا يُغلق بالخطأ)
  selection: { nodeIds: Set, edgeId },
  view: { pan: {x,y}, zoom },
  get readOnly()   { return this.status === 'archived'; }
  get hasUnsaved() { return JSON.stringify({definition,variables}) !== this.savedSnapshot; }
}
```

**ملاحظة تصميمية مهمة:** `hasUnsaved` **لا** يقارن `triggerConfig` صراحة — لكن هذا مقصود وصحيح، لأن `triggerConfig` مُشتق بالكامل من `definition` (تحديدًا `node.config` الخاص بعقدة الـ trigger)، فأي تغيير فيه يظهر أصلًا كتغيير في `definition`.

**تدفّق فتح/إغلاق تبويب:**
- `openWorkflowInBuilder(id, preloadedRow?)` → لو التبويب مفتوح أصلًا يُفعَّل فقط، وإلا يجلب البيانات (`DataLayer.getWorkflow`) ويبني Session جديدة
- `closeTab(id, force?)` → لو فيه تغييرات غير محفوظة يطلب تأكيدًا (إلا لو `force`)
- **حفظ تلقائي دوري كل 45 ثانية** (`setInterval`, سطر ~1420) للتبويب النشط فقط لو فيه تغييرات وغير مؤرشف
- `beforeunload` listener يمنع إغلاق المتصفح لو أي تبويب مفتوح فيه تغييرات غير محفوظة

---

## 11) محرك التحقق — `validateDefinition(def)` (سطر **~2054-2100**)

يعمل بالكامل على تعريف الـ Canvas الحالي (client-side فقط، بدون استدعاء أي Backend). يُستدعى في: كل render للـ Canvas، قبل الحفظ (لعرض عدد الملاحظات)، قبل النشر (يمنع النشر لو فيه أخطاء `error`).

**قواعد التحقق الحالية:**
| القاعدة | المستوى |
|---|---|
| لا توجد أي عناصر على الـ Canvas | `error` |
| لا يوجد trigger واحد على الأقل | `error` |
| أكثر من trigger واحد | `warn` **لكل عقدة زائدة على حدة** (منذ الإصلاح الأخير)، مع اسمها ورابط لها |
| `node.type` غير موجود ضمن `nodeTypesByKey` (نوع غير نشط/محذوف من الداتابيز) | `error` |
| حقل مطلوب (`!isStaffFieldOptional(field)`) فارغ في `node.config` | `error` |
| عقدة غير-trigger بدون أي edge داخل إليها (`incoming`) | `warn` |
| `edge` يشير لـ `source`/`target` غير موجود في `nodes` | `error` |
| `id` مكرر بين عقدتين | `error` |

**النشر يُمنع فقط عند وجود `error`** واحد على الأقل — `warn` لا يمنع النشر لكن يظهر في تبويب "التحقق" أسفل الشاشة.

`isStaffFieldOptional(field)` (سطر 602): حقل يُعتبر اختياريًا لو `field.optional===true` **أو** له `default` غير فارغ **أو** كلمة "اختياري" موجودة داخل `field.label` نفسه (اصطلاح نصي وليس عمود منفصل بالضرورة).

---

## 12) اللوحة السفلية (Bottom Panel) — حالة التنفيذ الفعلي

5 تبويبات: **التحقق** (فعّال بالكامل، قسم 11) · **سجل التشغيل** (فعّال، يقرأ `wf_runs` الحقيقي) · **السجلات/الجدول الزمني/المقاييس** (Placeholder ثابت فقط — `renderPlaceholderTab`).

**لماذا Placeholder:** لا يوجد Executor حقيقي بعد ينفّذ الـ Workflows فعليًا (`handler_type` لمعظم `wf_node_types` لا يزال `NULL`)، فجدول `wf_run_steps` (المفترض تخزين تفاصيل كل خطوة) غير مُستخدَم إطلاقًا حاليًا. عند بناء الـ Executor مستقبلًا، هذه الثلاث لوحات هي التي تحتاج استبدال منطقها الوهمي باستعلامات حقيقية على `wf_run_steps`.

---

## 13) الكانفاس — `Canvas` (IIFE Module، سطر **~1523-2050**)

وحدة مستقلة (`const Canvas = (() => {...})()`) تُدير كل تفاعل الرسم. أهم الوظائف الداخلية:

| الوظيفة | الغرض |
|---|---|
| `render()` | إعادة رسم كل العقد والوصلات من `session.definition`، يُستدعى بعد أي تعديل |
| `nodeHtml(n, issues)` | HTML لعقدة واحدة (Trigger لا يحمل `.wf-port-in` — لا مدخل له فعليًا) |
| `updateEdgePaths()` | يرسم منحنيات SVG بين العقد (Bezier بسيط عبر نقطتي تحكم) |
| `bindNodeEvents(el)` | Pointer events لكل عقدة: سحب، تحديد (شيفت للتحديد المتعدد)، بدء سحب Edge من `.wf-port-out` |
| `onViewportPointerDown/Move/Up` | Pan (بالمسطرة الوسطى/يمين/Space+سحب) + Marquee selection (تحديد بالمستطيل) |
| `onWheel` | تكبير/تصغير بـ Ctrl/Cmd+عجلة الفأرة (نحو موضع المؤشر)، أو Pan عادي بالعجلة وحدها |
| `autoLayout()` | ترتيب تلقائي عبر BFS طبقي (Layered)، من الجذور (عقد بدون مدخلات) نحو الأطراف، `COL_GAP=300px`, `ROW_GAP=130px` |
| `pushHistory()/undo()/redo()` | Undo/Redo عبر JSON snapshots كاملة لـ `definition` (وليس diff) |
| `onKeyDown` | اختصارات لوحة المفاتيح (قسم 14) |

**إصلاح تم مؤخرًا:** الزر الأيمن (`button===2`) لتحريك الكانفاس كان يتعارض مع قائمة المتصفح الأصلية (كانت تظهر فوق الرسم أثناء السحب) — تم إضافة `preventDefault()` + مستمع `contextmenu` يمنع القائمة الافتراضية بالكامل على منطقة الـ viewport.

---

## 14) اختصارات لوحة المفاتيح (داخل `Canvas.onKeyDown`)
| الاختصار | الفعل |
|---|---|
| `Delete`/`Backspace` | حذف التحديد الحالي (عقد و/أو edge) |
| `Ctrl/Cmd+D` | تكرار التحديد |
| `Ctrl/Cmd+A` | تحديد كل العناصر |
| `Ctrl/Cmd+Z` | تراجع |
| `Ctrl/Cmd+Shift+Z` أو `Ctrl/Cmd+Y` | إعادة |
| `Ctrl/Cmd+S` | حفظ كمسودة (لو غير مؤرشف) |
| `Escape` | إلغاء التحديد |
| الأسهم | تحريك العناصر المحدَّدة (5px، أو 20px مع Shift) |
| `Space` (مُمسك) + سحب | Pan |

---

## 15) الـ Inspector — توليد النماذج ديناميكيًا

`renderInspector()` (سطر ~2176) يفرّع حسب حالة التحديد:
- تحديد **متعدد** (`>1` عقدة) → أزرار تكرار/حذف جماعي فقط
- تحديد **عقدة واحدة** → `renderNodeInspector` (النموذج الكامل حسب `config_schema.fields`)
- تحديد **edge** → `renderEdgeInspector` (من/إلى + زر حذف فقط، لا إعدادات أخرى للـ edge حاليًا)
- **بدون تحديد** → `renderWorkflowInspector` (وصف الـ Workflow، ملخص المشغّل الحالي للقراءة فقط، متغيرات الـ Workflow اليدوية)

**نقطة تمديد رئيسية:** أي نوع حقل جديد يلزم إضافته في **مكانين فقط**: الـ `switch(field.type)` داخل `buildFieldControl` (سطر ~2322)، وربما تحديث `isStaffFieldOptional` لو النوع الجديد له قواعد اختيارية خاصة.

---

## 16) نظام "المتغيرات المتاحة" (Upstream Variables)

`getUpstreamVariables(session, nodeId)` (سطر ~2150): يعمل BFS عكسي على الـ `edges` بادئًا من العقدة الحالية صعودًا لكل أسلافها (كل العقد المتصلة بها عبر مسار سابق مهما بَعُد)، ويجمع `output_vars` الخاصة بكل سلف + متغيرات الـ Workflow اليدوية. هذه القائمة هي مصدر خيارات `variable_picker` وقائمة "إدراج بيانات" — **وليست** كل عقد الـ Canvas، فقط ما هو متصل فعليًا "قبل" العقدة الحالية في تسلسل الوصلات.

---

## 17) قائمة الـ Workflows (List View)

- `deriveWorkflowCategory(workflow)` و`triggerSummary(workflow)`: يشتقّان من **الإصدار المنشور أولًا إن وُجد، وإلا من المسودة** (`primaryDefinitionSource`) — أي أن القائمة الرئيسية تعرض حالة "المنشور الحي" وليس بالضرورة آخر تعديل غير منشور بعد. هذا **مقصود** (يعكس ما يعمل فعليًا الآن) وليس Bug.
- الفلاتر (بحث/تصنيف/حالة/ترتيب) كلها client-side بالكامل على `appState.workflows` المحمَّل مسبقًا (لا استعلام Supabase جديد لكل فلتر).
- كل بطاقة لها قائمة إجراءات منسدلة (`toggleCardMenu`): فتح، تكرار، إيقاف/استئناف (فقط لو `active`/`paused`)، أرشفة، حذف نهائي.

---

## 18) إمكانية الوصول (Accessibility) — إصلاحات تمت + ملاحظات متبقية

- تم إصلاح: زر طي/فتح اللوحة السفلية (`#wfBottomToggle`) كان `div` بدون `role`/`tabindex`، الآن `role="button" tabindex="0"` + دعم `Enter`/`Space`.
- **متبقٍ وغير مُصلَح عمدًا** (نطاق أوسع من إصلاح سريع): عناصر تبويب أخرى مبنية كـ `div` قابلة للنقر بدون دعم كيبورد كامل: `.wf-tab`, `.wf-lib-tab`, `.wf-lib-cat-head`, `.wf-version-tab`, `.wf-bottom-tab`, `.wf-tab-add`. لو طُلب تدقيق Accessibility شامل مستقبلًا، هذه هي القائمة الكاملة لنقطة البداية.

---

## 19) التوافق مع الثيم الفاتح (Light Theme)

كل الألوان تمر عبر متغيرات CSS تُعاد كتابتها تحت `html[data-theme="light"] .wf-shell{...}`. **استثناء واحد متعمَّد:** `.wf-node-icon{color:#fff}` ثابت دائمًا (أبيض) بغض النظر عن الثيم، لأن خلفية أيقونة العقدة تُبنى من `nt.color` (لون صريح من الداتابيز، مفترَض أنه دائمًا غامق بما يكفي لتباين مقبول مع نص أبيض) — هذا افتراض على مستوى البيانات وليس تحكم في هذا الملف.

---

## 20) سجل التعديلات المهمة (Changelog)

### الجلسة الأولى — استبدال الإيموجي + تحسينات تصميم
- استبدال كل الإيموجي المكتوبة يدويًا في الكود (~25 موقعًا) بأيقونات SVG موحّدة (قسم 3)
- إصلاح `min-height:calc(100vh - 0px)` → `100vh`
- إصلاح تعارض الزر الأيمن مع قائمة المتصفح أثناء الـ Pan
- جعل `#wfBottomToggle` قابلًا للوصول بالكيبورد

### الجلسة الثانية — إصلاحات منطق الـ Trigger
- توحيد إيجاد عقدة الـ trigger في دالة واحدة `findTriggerNode` بدل 5 نسخ مكرّرة من نفس الـ `.find()`
- إضافة `extractTriggerConfig` وربطها فعليًا بـ `saveDraft()` — كان `trigger_config` يبقى `{}` دائمًا قبل هذا
- إصلاح فقدان `trigger_event_key` عند إنشاء مسودة جديدة بعد كل نشر
- تحسين رسالة تحذير تعدد الـ Triggers لتكون واضحة ومحدَّدة لكل عقدة زائدة

### الجلسة الثالثة — تبسيط أسماء المتغيرات لجمهور غير تقني
- إضافة `VAR_WORD_MAP` / `humanizeVarKey` / `friendlyVarLabel` (قسم 9)
- تطبيقها في 3 أماكن: `variable_picker`، `openVarMenu`، شرائح "البيانات المتاحة"
- تبسيط نص زر "إدراج متغير" (كان يعرض `{{ }}` حرفيًا) إلى "إدراج بيانات" + أيقونة

---

## 21) دليل سريع للتعديلات المستقبلية الشائعة

| المطلوب | ابدأ من هنا |
|---|---|
| إضافة نوع حقل جديد في Inspector | `buildFieldControl` — أضف `case` جديد (~سطر 2322) |
| إضافة أيقونة SVG جديدة | `ICON_PATHS` (~سطر 605) ثم استخدمها بـ `ic('name', size)` |
| إضافة كلمة عربية جديدة لتبسيط أسماء المتغيرات | `VAR_WORD_MAP` (~سطر 2113) |
| تغيير قاعدة تحقق (Validation) أو إضافة قاعدة جديدة | `validateDefinition()` (~سطر 2054) |
| تغيير شكل/تصنيفات الـ Node Library | `CATEGORY_LABELS` / `CATEGORY_ORDER` / `CATEGORY_ACCENT` (~سطر 528-540) و`renderNodeLibrary()` |
| تعديل منطق النشر/الحفظ | `saveDraft()` (~1327)، `publishWorkflow()` (~1362)، `DataLayer.publishWorkflow` (~779) — **حدّث الثلاثة معًا** |
| تعديل عرض قائمة الـ Workflows (بطاقة) | `workflowCardHtml()` (~949) |
| تعديل تفاعل الكانفاس (سحب/تكبير/تحديد) | داخل وحدة `Canvas` (~1523) |
| إضافة تبويب جديد في اللوحة السفلية | `renderBottomPanel()` (~2532) + HTML الثابت لتبويبات `.wf-bottom-tab` |
| تغيير أي لون/خط/مسافة في التصميم | متغيرات CSS أعلى الملف داخل `.wf-shell{...}` فقط — لا تكتب قيم Hex مباشرة في أي مكان آخر |

---

## 22) قيود معمارية يجب تذكّرها دائمًا قبل أي تعديل

1. **لا يوجد Backend وسيط** — كل شيء Supabase مباشر من المتصفح؛ أي منطق "خادمي" (مثل تنفيذ الـ Workflow فعليًا) غير موجود في هذا الملف إطلاقًا ولن يظهر أثره هنا حتى يُبنى Executor منفصل.
2. **`definition` هو مصدر الحقيقة الوحيد** لمخطط الـ Workflow — أي حقل آخر (`trigger_config`, `trigger_event_key`) هو **مُشتق** منه وليس مصدرًا مستقلًا؛ عدّل `definition` أولًا ثم تأكد من تحديث المُشتقات.
3. **المسودة والمنشور صفّان منفصلان تمامًا** في `wf_workflow_versions` — لا تفترض أبدًا أن تعديل أحدهما يغيّر الآخر.
4. **لا يوجد دعم فعلي لأكثر من Trigger واحد** رغم أن الواجهة تسمح بإضافته بصريًا (قسم 8).
5. **أيقونات/ألوان أنواع الـ Nodes بيانات من الداتابيز** وليست جزءًا من هذا الملف — أي طلب "غيّر شكل أيقونة نوع معيّن" يحتاج تعديل `wf_node_types.icon`/`color` في Supabase نفسها، وليس في هذا الكود.
