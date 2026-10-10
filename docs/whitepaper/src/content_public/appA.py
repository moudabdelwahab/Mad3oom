from lib import *

def R(area, cap, st, ch):
    return [area, cap, (f"{{{{{st}}}}}", f"{{{{{st}}}}}"), (ch, ch)]

CHAPTER = appendix("A", ("Capability Status Register", "سجل حالة الإمكانات"),
    ("One table that gathers the stage of every capability named in this paper, so that a reader can check a claim in one place. "
     "The status reflects the position on 9 October 2026.",
     "جدول واحد يجمع مرحلة كل إمكانية ورد ذكرها في هذه الورقة، ليتحقق القارئ من أي ادعاء في موضع واحد. وتعكس الحالة الوضع "
     "بتاريخ 9 أكتوبر 2026."),
    [
    TABLE([("Area", "المجال"), ("Capability", "الإمكانية"), ("Stage", "المرحلة"), ("Chapter", "الفصل")], [
        R(("Core platform", "المنصة الأساسية"), ("Ticket lifecycle, SLA targets, notifications", "دورة حياة التذكرة وأهداف SLA والإشعارات"), "E", "3"),
        R(("Core platform", "المنصة الأساسية"), ("Helpdesk inbox: teams, assignment, tags, notes, scheduled replies, human–bot handoff", "صندوق الدعم: فرق وإسناد ووسوم وملاحظات وردود مجدولة وتسليم بين الإنسان والروبوت"), "E", "3"),
        R(("Core platform", "المنصة الأساسية"), ("Customer history; knowledge base and help center", "سجل العميل؛ قاعدة المعرفة ومركز المساعدة"), "E", "3"),
        R(("Core platform", "المنصة الأساسية"), ("Company accounts, roles, automation builder", "حسابات الشركات والأدوار ومنشئ الأتمتة"), "E", "3"),
        R(("Workspace", "Workspace"), ("Tabs, groups, splits and quick open over six panel types; unsent-work protection", "تبويبات ومجموعات وتقسيمات وفتح سريع على ستة أنواع من اللوحات؛ وحماية العمل غير المرسل"), "E", "4"),
        R(("Workspace", "Workspace"), ("Layouts saved per browser", "تخطيطات تُحفظ لكل متصفح"), "E", "4"),
        R(("Workspace", "Workspace"), ("Layouts saved per agent on the server", "تخطيطات تُحفظ لكل وكيل على الخادم"), "D", "4"),
        R(("Workspace", "Workspace"), ("Relay and further panel types", "Relay وأنواع لوحات إضافية"), "P", "4"),
        R(("Workspace", "Workspace"), ("Adaptive, named layouts and shared context", "تخطيطات تكيّفية مسمّاة وسياق مشترك"), "F", "4"),
        R(("Relay", "Relay"), ("Follow-up and issue records, lifecycle, categories, creation from inbox messages", "سجلات المتابعة والمشكلات، ودورة الحياة، والفئات، والإنشاء من رسائل الصندوق"), "E", "5"),
        R(("Relay", "Relay"), ("Ownership and assignment rules; derived overdue flag; audit events", "قواعد المسؤولية والإسناد؛ وعلامة التأخر المشتقة؛ وأحداث التدقيق"), "E", "5"),
        R(("Relay", "Relay"), ("Evidence governance: access re-checks, retention, irreversible redaction", "حوكمة الأدلة: إعادة فحص الوصول والاحتفاظ والمحو غير القابل للرجوع"), "E", "5"),
        R(("Relay", "Relay"), ("Trash with restore", "سلة محذوفات مع استرجاع"), "D", "5"),
        R(("Relay", "Relay"), ("Handovers with acceptance, clarification and decline", "تسليمات مع القبول والاستيضاح والرفض"), "P", "5"),
        R(("Relay", "Relay"), ("Reminders, escalation, continuity monitor", "تذكيرات وتصعيد ولوحة متابعة الاستمرارية"), "P", "5"),
        R(("Relay", "Relay"), ("External API; browser capture", "واجهة خارجية؛ والتقاط من المتصفح"), "P", "5"),
        R(("Relay", "Relay"), ("Assisted extraction; company workspaces", "استخراج مساعَد؛ ومساحات الشركات"), "F", "5"),
        R(("SIE", "SIE"), ("Nine layers: language, scenarios, diagnostics, ranking, decision, dialogue, knowledge, action, observability", "تسع طبقات: اللغة والسيناريوهات والتشخيص والترتيب والقرار والحوار والمعرفة والتنفيذ والرصد"), "E", "6"),
        R(("SIE", "SIE"), ("Trust boundary; candidate retrieval; sparse session state", "حد الثقة؛ واسترجاع المرشحين؛ وحالة الجلسة المخفَّفة"), "E", "6"),
        R(("SIE", "SIE"), ("Continued extension of SIE", "مواصلة توسيع SIE"), "D", "6, 11"),
        R(("SIE", "SIE"), ("Grounding in live account data and published knowledge", "الارتكاز على بيانات الحساب الحية والمعرفة المنشورة"), "D", "6"),
        R(("SIE", "SIE"), ("Handing follow-up work to Relay", "تسليم أعمال المتابعة إلى Relay"), "F", "6"),
        R(("SIE", "SIE"), ("Controlled generative or tool-using assistance", "مساعدة توليدية أو مستخدمة للأدوات بضوابط"), "F", "6, 11"),
        R(("Integrations", "التكاملات"), ("Channel adapter layer; website chat and Telegram", "طبقة محوِّلات القنوات؛ محادثة الموقع وتيليجرام"), "E", "7"),
        R(("Integrations", "التكاملات"), ("MCP, OAuth 2.1, API tokens", "MCP وOAuth 2.1 ورموز API"), "E", "7"),
        R(("Integrations", "التكاملات"), ("Trigger- and schedule-driven side effects", "آثار جانبية تحرّكها المحفِّزات والجداول"), "E", "7"),
        R(("Integrations", "التكاملات"), ("WhatsApp module and its integration API (separate; outside the initial launch scope)", "وحدة واتساب وواجهة تكاملها (مستقلة؛ خارج نطاق الإطلاق الأولي)"), "D", "7"),
        R(("Integrations", "التكاملات"), ("WhatsApp, Messenger and API channel on the shared layer", "واتساب وماسنجر وقناة API على الطبقة المشتركة"), "P", "7"),
        R(("Integrations", "التكاملات"), ("Voice channels", "القنوات الصوتية"), "F", "7"),
        R(("Architecture", "المعمارية"), ("Database-level access rules, continuous integration", "قواعد وصول على مستوى قاعدة البيانات والتكامل المستمر"), "E", "8, 9"),
        R(("Architecture", "المعمارية"), ("Conversation Core: a unified conversation layer for all channels", "نواة المحادثات: طبقة محادثات موحَّدة لكل القنوات"), "D", "8"),
        R(("Security", "الأمان"), ("Security design objectives and traceable safeguards, as described in Chapter 9; not independently assessed", "الأهداف التصميمية للأمان وتدابير الحماية التي يمكن تتبّعها، كما وردت في الفصل 9؛ دون تقييم مستقل"), "E", "9"),
    ], widths=[16, 56, 16, 12], cls="compact long",
        caption=("Capability register. Statuses follow the definitions on page 2.", "سجل الإمكانات. تتبع الحالات التعريفات الواردة في الصفحة 2.")),
])
