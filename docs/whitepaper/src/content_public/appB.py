from lib import *

CHAPTER = appendix("B", ("Glossary", "المصطلحات"), None, [
    TABLE([("Term", "المصطلح"), ("Meaning in this paper", "المعنى في هذه الورقة")], [
        [("**Action layer**", "**طبقة التنفيذ (Action)**"), ("The SIE layer designed to be the single writer: it commits a decision's message, state and ticket in one atomic transaction.", "طبقة في SIE صُمّمت لتكون الكاتب الوحيد: تحفظ رسالة القرار وحالته وتذكرته في معاملة ذرية واحدة.")],
        [("**Adapter (channel)**", "**المحوِّل (القناة)**"), ("A module that hides one messaging vendor's details behind a common contract: verify, parse, send.", "وحدة تخفي تفاصيل مزوّد مراسلة واحد خلف عقد مشترك: تحقق وتحليل وإرسال.")],
        [("**Arabizi**", "**العربيزي**"), ("Arabic written in Latin letters and digits, as often used in chat.", "العربية المكتوبة بحروف وأرقام لاتينية، كما تُستخدم كثيرًا في المحادثات.")],
        [("**Continuity record**", "**سجل الاستمرارية**"), ("Relay's unit of work: evidence, ownership, a next action, a deadline and an append-only history.", "وحدة العمل في Relay: دليل ومسؤولية وإجراء تالٍ وموعد وسجل تاريخي لا يُعدَّل.")],
        [("**Conversation Core**", "**نواة المحادثات**"), ("A unified conversation layer intended to be shared by all channels; in development.", "طبقة محادثات موحَّدة يُقصد أن تتشاركها القنوات كلها؛ قيد التطوير.")],
        [("**Deterministic**", "**حتمي**"), ("Producing the same output for the same input and configuration; no randomness, injectable time, explicit tie-breaking.", "ينتج المخرج نفسه من المدخل والإعداد نفسيهما؛ بلا عشوائية وبوقت قابل للحقن وحسم صريح للتعادل.")],
        [("**Edge Function**", "**دالة Edge Function**"), ("Server-side code run by the backend platform for integrations and the SIE runtime.", "شيفرة تُنفَّذ في الخادم على المنصة الخلفية، وتُستخدم للتكاملات وبيئة تشغيل SIE.")],
        [("**Evaluated rules**", "**القواعد المفحوصة**"), ("The record, kept with each decision of SIE's decision layer, of every rule that was checked, whether it matched and why.", "السجل المحفوظ مع كل قرار تصدره طبقة القرار في SIE لكل قاعدة فُحصت، وهل انطبقت، ولماذا.")],
        [("**Idempotency key**", "**مفتاح التفرّد (Idempotency)**"), ("A client-chosen identifier that makes a retried request return the first result instead of creating a duplicate.", "معرّف يختاره التطبيق المستدعي يجعل الطلب المعاد يرجع بالنتيجة الأولى بدل إنشاء نسخة مكررة.")],
        [("**Least privilege**", "**أقل الصلاحيات**"), ("Giving each person and component only the access needed for their task.", "منح كل شخص وكل مكوّن الوصول الذي تحتاجه مهمته فقط.")],
        [("**MCP**", "**MCP**"), ("Model Context Protocol, a standard way for AI clients to use tools and data exposed by a server.", "بروتوكول سياق النموذج، طريقة قياسية لاستخدام عملاء الذكاء الاصطناعي الأدوات والبيانات التي يتيحها خادم.")],
        [("**OAuth 2.1 and PKCE**", "**OAuth 2.1 وPKCE**"), ("A standard for delegated, scoped authorization; PKCE protects the exchange of authorization codes.", "معيار للتفويض المفوَّض محدود النطاق؛ ويحمي PKCE تبادل رموز التفويض.")],
        [("**Optimistic concurrency**", "**التزامن التفاؤلي**"), ("Rejecting an edit made against a stale version of a record instead of overwriting newer changes.", "رفض تعديل أُجري على إصدار قديم من السجل بدل الكتابة فوق تغييرات أحدث.")],
        [("**Panel**", "**اللوحة**"), ("One tab in Workspace, hosting a page or a single record.", "تبويب واحد في Workspace يستضيف صفحة أو سجلًا واحدًا.")],
        [("**RLS**", "**RLS**"), ("Row-level security: database rules that decide which rows a user can read or change.", "الأمان على مستوى الصفوف: قواعد في قاعدة البيانات تحدد أي الصفوف يقرؤها المستخدم أو يغيّرها.")],
        [("**Scenario**", "**السيناريو**"), ("An authored description of a support situation in SIE's catalog: expected evidence, resolutions and questions.", "وصف مؤلَّف لحالة دعم في كتالوج SIE: الأدلة المتوقعة والحلول والأسئلة.")],
        [("**SIE**", "**SIE**"), ("Support Intelligence Engine, Mad3oom's deterministic engine for interpreting support conversations.", "محرك ذكاء الدعم الفني، محرك مدعوم الحتمي لتفسير محادثات الدعم.")],
        [("**SLA**", "**SLA**"), ("Service-level agreement; here, a target time for the first response to a ticket, by priority.", "اتفاقية مستوى الخدمة؛ والمقصود هنا زمن مستهدف لأول استجابة لتذكرة، بحسب الأولوية.")],
        [("**Trust boundary**", "**حد الثقة**"), ("The component of SIE designed to treat customer text as untrusted data wherever it could influence the engine.", "مكوّن في SIE مصمَّم لمعاملة نص العميل بوصفه بيانات غير موثوقة حيثما أمكن أن يؤثر في المحرك.")],
    ], widths=[26, 74], cls="compact long"),
])
