from lib import *

def R(area, cap, st, ch):
    return [area, cap, (f"{{{{{st}}}}}", f"{{{{{st}}}}}"), (ch, ch)]

CHAPTER = appendix("A", ("Capability Status Register", "سجل حالة الإمكانات"),
    ("One table that gathers the stage of every capability named in this paper, so that a reader can check a claim in one place. "
     "The status reflects repository evidence on 9 October 2026.",
     "جدول واحد يجمع مرحلة كل إمكانية ورد ذكرها في هذه الورقة، ليتحقق القارئ من أي ادعاء في موضع واحد. وتعكس الحالة أدلة المستودعات "
     "بتاريخ 9 أكتوبر 2026."),
    [
    TABLE([("Area", "المجال"), ("Capability", "الإمكانية"), ("Stage", "المرحلة"), ("Chapter", "الفصل")], [
        R(("Core platform", "المنصة الأساسية"), ("Ticket lifecycle, SLA targets, notifications", "دورة حياة التذكرة وأهداف SLA والإشعارات"), "E", "3"),
        R(("Core platform", "المنصة الأساسية"), ("Helpdesk inbox: teams, assignment, tags, notes, scheduled replies, human–bot handoff", "صندوق الدعم: فرق وإسناد ووسوم وملاحظات وردود مجدولة وتسليم بين الإنسان والروبوت"), "E", "3"),
        R(("Core platform", "المنصة الأساسية"), ("Customer history; knowledge base and help center", "سجل العميل؛ قاعدة المعرفة ومركز المساعدة"), "E", "3"),
        R(("Core platform", "المنصة الأساسية"), ("Company accounts, roles, automation builder", "حسابات الشركات والأدوار ومنشئ الأتمتة"), "E", "3"),
        R(("Workspace", "Workspace"), ("Tabs, groups, splits and quick open over six panel types; unsent-work protection", "تبويبات ومجموعات وتقسيمات وفتح سريع على ست أنواع من اللوحات؛ وحماية العمل غير المرسل"), "E", "4"),
        R(("Workspace", "Workspace"), ("Layouts saved per browser", "تخطيطات تُحفظ لكل متصفح"), "E", "4"),
        R(("Workspace", "Workspace"), ("Layouts saved per agent on the server", "تخطيطات تُحفظ لكل وكيل على الخادم"), "D", "4"),
        R(("Workspace", "Workspace"), ("Relay and further panel types", "Relay وأنواع لوحات إضافية"), "P", "4"),
        R(("Workspace", "Workspace"), ("Adaptive, named layouts and shared context", "تخطيطات تكيّفية مسمّاة وسياق مشترك"), "F", "4"),
        R(("Relay", "Relay"), ("Follow-up and issue records, lifecycle, categories, creation from inbox messages", "سجلات المتابعة والمشكلات، ودورة الحياة، والفئات، والإنشاء من رسائل الصندوق"), "E", "5"),
        R(("Relay", "Relay"), ("Ownership and assignment rules; derived overdue flag; audit events", "قواعد المسؤولية والإسناد؛ وعلامة التأخر المشتقة؛ وأحداث التدقيق"), "E", "5"),
        R(("Relay", "Relay"), ("Evidence governance: access re-checks, retention, irreversible redaction", "حوكمة الأدلة: إعادة فحص الوصول والاحتفاظ والمحو غير القابل للرجوع"), "E", "5"),
        R(("Relay", "Relay"), ("Trash with restore; owner-only erase and grants", "سلة محذوفات مع استرجاع؛ ومحو ومنح للمالك وحده"), "D", "5"),
        R(("Relay", "Relay"), ("Handovers with acceptance, clarification and decline", "تسليمات مع القبول والاستيضاح والرفض"), "P", "5"),
        R(("Relay", "Relay"), ("Reminders, escalation, continuity monitor", "تذكيرات وتصعيد ولوحة متابعة الاستمرارية"), "P", "5"),
        R(("Relay", "Relay"), ("External API; browser capture", "واجهة خارجية؛ والتقاط من المتصفح"), "P", "5"),
        R(("Relay", "Relay"), ("Assisted extraction; company workspaces", "استخراج مساعَد؛ ومساحات الشركات"), "F", "5"),
        R(("SIE", "SIE"), ("Nine layers: language, scenarios, diagnostics, ranking, decision, dialogue, knowledge, action, observability", "تسع طبقات: اللغة والسيناريوهات والتشخيص والترتيب والقرار والحوار والمعرفة والتنفيذ والرصد"), "E", "6"),
        R(("SIE", "SIE"), ("Trust boundary; candidate retrieval; sparse session state", "حد الثقة؛ واسترجاع المرشحين؛ وحالة الجلسة المخفَّفة"), "E", "6"),
        R(("SIE", "SIE"), ("Remediation work packages 1–3: test foundation, truthful tracing, language primitives", "حزم المعالجة 1–3: أساس الاختبار والتتبع الصادق وأوليات اللغة"), "E", "6"),
        R(("SIE", "SIE"), ("Remediation work packages 4–9: route ownership, fallible belief, grounding, attachments, metering, dialogue", "حزم المعالجة 4–9: ملكية المسارات والاعتقاد القابل للانخفاض والارتكاز على المعرفة والمرفقات والقياس والحوار"), "D", "6"),
        R(("SIE", "SIE"), ("Grounding in live account data and published knowledge", "الارتكاز على بيانات الحساب الحية والمعرفة المنشورة"), "D", "6"),
        R(("SIE", "SIE"), ("Handing follow-up work to Relay", "تسليم أعمال المتابعة إلى Relay"), "F", "6"),
        R(("SIE", "SIE"), ("Controlled generative or tool-using assistance", "مساعدة توليدية أو مستخدمة للأدوات بضوابط"), "F", "6, 11"),
        R(("Integrations", "التكاملات"), ("Channel adapter layer; website chat and Telegram", "طبقة محوِّلات القنوات؛ محادثة الموقع وتيليجرام"), "E", "7"),
        R(("Integrations", "التكاملات"), ("MCP, OAuth 2.1, API tokens, integration API", "MCP وOAuth 2.1 ورموز API وواجهة التكامل"), "E", "7"),
        R(("Integrations", "التكاملات"), ("Trigger- and schedule-driven side effects", "آثار جانبية تحرّكها المحفِّزات والجداول"), "E", "7"),
        R(("Integrations", "التكاملات"), ("WhatsApp module (separate; outside the initial launch scope)", "وحدة واتساب (مستقلة؛ خارج نطاق الإطلاق الأولي)"), "D", "7"),
        R(("Integrations", "التكاملات"), ("WhatsApp, Messenger and API channel on the shared layer", "واتساب وماسنجر وقناة API على الطبقة المشتركة"), "P", "7"),
        R(("Integrations", "التكاملات"), ("Outbox with retries for side effects", "صندوق صادر مع إعادة المحاولة للآثار الجانبية"), "R", "7, 8"),
        R(("Integrations", "التكاملات"), ("Voice channels", "القنوات الصوتية"), "F", "7"),
        R(("Architecture", "المعمارية"), ("Row-level security, database-function rules, CI, drift checks, rollback scripts", "الأمان على مستوى الصفوف وقواعد دوال القاعدة والتكامل المستمر وفحوص الانحراف وسكربتات التراجع"), "E", "8, 9"),
        R(("Architecture", "المعمارية"), ("Conversation Core, installed with flags closed", "نواة المحادثات، مثبَّتة وأعلامها مغلقة"), "D", "8"),
        R(("Architecture", "المعمارية"), ("Baseline schema in version control, staging, dependency pinning, content policy", "خط أساس للمخطط تحت ضبط الإصدارات وبيئة تجريبية وتثبيت الاعتماديات وسياسة محتوى"), "R", "8"),
        R(("Security", "الأمان"), ("Second-factor assurance at the data layer; stronger secret storage; system actor for automation", "ضمان العامل الثاني على مستوى البيانات؛ وتخزين أقوى للأسرار؛ وفاعل نظام للأتمتة"), "R", "9"),
        R(("Security", "الأمان"), ("Retention policies and deletion workflows for chat history and engine traces", "سياسات احتفاظ وسير عمل حذف لسجل المحادثات وآثار المحرك"), "P", "9"),
    ], widths=[16, 56, 16, 12], cls="compact long",
        caption=("Capability register. Statuses follow the definitions on page 2.", "سجل الإمكانات. تتبع الحالات التعريفات الواردة في الصفحة 2.")),
])
