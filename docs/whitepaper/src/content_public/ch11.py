from lib import *

CHAPTER = chapter(11, ("Product Roadmap", "خارطة طريق المنتج"),
    ("The roadmap is organized by how real each item is today, not by date. It separates what exists, what is being built, what is planned and what "
     "remains a long-term opportunity.",
     "تُنظَّم خارطة الطريق بحسب مدى واقعية كل بند اليوم، لا بحسب التاريخ. وهي تفصل بين ما هو قائم، وما يُبنى، وما هو مخطَّط، وما يبقى فرصة بعيدة المدى."),
    [
    NOTE("Roadmap items are subject to technical validation and to business priorities. They are not commitments. No delivery dates, "
         "customer milestones or completion claims are given, and the order of items within a category is not a schedule.",
         "بنود خارطة الطريق خاضعة للتحقق التقني ولأولويات العمل، وليست التزامات. ولا تُذكر مواعيد تسليم ولا محطات لدى العملاء ولا ادعاءات "
         "اكتمال، وترتيب البنود داخل كل فئة ليس جدولًا زمنيًا.",
         kind="limit", title=("Read this first", "اقرأ هذا أولًا")),
    FIG("roadmap", ("The four roadmap categories at a glance.", "فئات خارطة الطريق الأربع في لمحة.")),

    H2("Existing foundations", "الأسس القائمة"),
    P("{{E}} These are implemented in the repositories. They are foundations to build on, not a claim of production maturity.",
      "{{E}} هذه منفَّذة في المستودعات. وهي أسس يُبنى عليها، وليست ادعاءً بنضج إنتاجي."),
    TABLE([("Area", "المجال"), ("Foundation", "الأساس")], [
        [("Support operations", "عمليات الدعم"), ("Tickets with SLA targets and notifications; a helpdesk inbox with teams, assignment, tags, notes, scheduled replies and human–bot handoff; customer history; knowledge base and help center; company accounts, roles and an automation builder.",
                                                  "التذاكر مع أهداف SLA والإشعارات؛ وصندوق وارد للدعم بفرق وإسناد ووسوم وملاحظات وردود مجدولة وتسليم بين الإنسان والروبوت؛ وسجل العميل؛ وقاعدة المعرفة ومركز المساعدة؛ وحسابات الشركات والأدوار ومنشئ الأتمتة.")],
        [("Workspace", "Workspace"), ("Tabs, groups and splits over six panel types, quick open, unsent-work protection, local layout persistence, keyboard and right-to-left support.",
                                      "تبويبات ومجموعات وتقسيمات على ست أنواع من اللوحات، وفتح سريع، وحماية العمل غير المرسل، وحفظ محلي للتخطيطات، ودعم لوحة المفاتيح واليمين-يسار.")],
        [("Relay", "Relay"), ("Continuity records, source evidence with access re-checks, ownership and assignment rules, retention and redaction, an audit log, and the native creation flow from the inbox.",
                              "سجلات استمرارية، ودليل مصدري مع إعادة فحص الوصول، وقواعد المسؤولية والإسناد، والاحتفاظ والمحو، وسجل تدقيق، وتدفق إنشاء من الصندوق.")],
        [("SIE", "SIE"), ("The nine-layer engine, the trust boundary, candidate retrieval, one trace per paid turn, and the website and Telegram channels.",
                           "المحرك ذو الطبقات التسع، وحد الثقة، واسترجاع المرشحين، وأثر واحد لكل دور مدفوع، وقناتا الموقع وتيليجرام.")],
        [("Integration", "التكامل"), ("The channel adapter layer, MCP with OAuth 2.1, API tokens and an integration API.", "طبقة محوِّلات القنوات، وMCP مع OAuth 2.1، ورموز API، وواجهة تكامل.")],
        [("Engineering", "الهندسة"), ("Continuous integration, SQL access-rule tests on a real Postgres, browser tests, drift checks and rollback scripts.", "التكامل المستمر، واختبارات SQL لقواعد الوصول على Postgres حقيقية، واختبارات المتصفح، وفحوص الانحراف وسكربتات التراجع.")],
    ], widths=[22, 78], cls="compact"),

    H2("Current development and refinement", "التطوير الحالي والتحسين"),
    P("{{D}} Active work that is not yet complete or available to users.",
      "{{D}} أعمال جارية لم تكتمل ولم تتح للمستخدمين بعد."),
    TABLE([("Item", "البند"), ("Detail", "التفصيل")], [
        [("SIE hardening and extension", "تعزيز SIE وتوسيعه"),
         ("Continued extension of coverage; grounding answers in live account data and published knowledge; awareness of attachments; and further consistency of customer-visible text.",
          "مواصلة توسيع التغطية؛ وارتكاز الإجابات على بيانات الحساب الحية والمعرفة المنشورة؛ ووعي المحرك بالمرفقات؛ ومزيد من اتساق النصوص التي يراها العميل.")],
        [("Relay trash and restore", "سلة محذوفات Relay والاسترجاع"),
         ("In development.", "قيد التطوير.")],
        [("Workspace server-side layouts", "تخطيطات Workspace على الخادم"),
         ("In development. Until then layouts are saved per browser.", "قيد التطوير. وإلى ذلك الحين تُحفظ التخطيطات لكل متصفح.")],
        [("Conversation Core", "نواة المحادثات"),
         ("In development; not yet used by any conversation. The orchestrator and the engine contract are still to be built.",
          "قيد التطوير؛ ولا تستخدمها أي محادثة بعد. ولا يزال على المنسّق وعقد المحرك أن يُبنيا.")],
        [("WhatsApp module", "وحدة واتساب"),
         ("Separate module with its own flows and billing logic; outside the initial launch scope.", "وحدة مستقلة بمساراتها ومنطق فوترتها؛ وهي خارج نطاق الإطلاق الأولي.")],
    ], widths=[26, 74], cls="compact"),

    H2("Planned capabilities", "الإمكانات المخطَّطة"),
    P("{{P}} Designed and intended, with no delivered implementation yet.",
      "{{P}} مصمَّمة ومقصودة، دون تنفيذ مُسلَّم حتى الآن."),
    TABLE([("Direction", "الاتجاه"), ("Items", "البنود")], [
        [("Relay", "Relay"), ("Handovers that must be accepted; reminders, escalation and a continuity monitor; an external API and browser capture; Relay as a Workspace panel.",
                              "تسليمات يجب قبولها؛ وتذكيرات وتصعيد ولوحة متابعة للاستمرارية؛ وواجهة خارجية والتقاط من المتصفح؛ وRelay بوصفه لوحة في Workspace.")],
        [("Expanded integrations", "تكاملات أوسع"), ("WhatsApp, Messenger and an API channel brought onto the shared channel layer; further tool connections through MCP.",
                                                    "نقل واتساب وماسنجر وقناة API إلى طبقة القنوات المشتركة؛ ووصلات أدوات إضافية عبر MCP.")],
        [("Knowledge workflows", "سير عمل المعرفة"), ("Answers grounded in live account data and published knowledge; review and validation tools wired to publishing.",
                                                       "إجابات مرتكزة على بيانات الحساب الحية والمعرفة المنشورة؛ وأدوات مراجعة وتحقق موصولة بالنشر.")],
        [("Workspace", "Workspace"), ("Additional panel types such as knowledge and reports.", "أنواع لوحات إضافية، كالمعرفة والتقارير.")],
        [("Data governance", "حوكمة البيانات"), ("Retention policies and deletion workflows across the platform.", "سياسات احتفاظ وسير عمل حذف عبر المنصة.")],
    ], widths=[22, 78], cls="compact"),

    H2("Long-term opportunities", "الفرص بعيدة المدى"),
    P("{{F}} Exploratory directions. No commitment is made and none is scheduled.",
      "{{F}} اتجاهات استكشافية. لا يُقدَّم التزام ولا يُجدوَل شيء منها."),
    TABLE([("Opportunity", "الفرصة"), ("What it would mean", "ما الذي تعنيه")], [
        [("Assisted extraction for Relay", "استخراج مساعَد لـ Relay"), ("Suggested titles, dates and next actions, validated against a strict schema and never confirmed automatically.", "عناوين وتواريخ وإجراءات مقترحة، يُتحقق منها بمخطط صارم ولا تُؤكَّد آليًا.")],
        [("Company workspaces in Relay", "مساحات الشركات في Relay"), ("Relay for companies' own support teams; the data model already carries the workspace boundary.", "Relay لفرق الدعم لدى الشركات؛ ونموذج البيانات يحمل بالفعل حد مساحة العمل.")],
        [("Controlled AI-assisted actions", "إجراءات مدعومة بالذكاء الاصطناعي بضوابط"), ("Letting the engine propose or perform approved actions through standard tool interfaces, under policy and with human confirmation where needed.", "أن يقترح المحرك إجراءات معتمدة أو ينفّذها عبر واجهات أدوات قياسية، ضمن سياسة وبتأكيد بشري حيث يلزم.")],
        [("Richer workspace organization", "تنظيم أغنى لمساحة العمل"), ("Named layouts for recurring tasks and context shared across panels.", "تخطيطات مسمّاة للمهام المتكررة وسياق مشترك بين اللوحات.")],
        [("Per-company bots and knowledge", "روبوتات ومعرفة لكل شركة"), ("Configuration and knowledge owned by each company, with cited sources.", "إعدادات ومعرفة تملكها كل شركة، مع مصادر مستشهَد بها.")],
        [("Shift-aware automation", "أتمتة واعية بالورديات"), ("Automatic handovers once a shift schedule exists as a source in the platform.", "تسليمات آلية حين يتوافر جدول ورديات مصدرًا داخل المنصة.")],
        [("Voice channels", "القنوات الصوتية"), ("Speech-to-text, spoken replies and a voice assistant for agents. An exploratory vision outside the current schedule.", "تحويل الكلام إلى نص، وردود منطوقة، ومساعد صوتي للوكلاء. رؤية استكشافية خارج الجدول الحالي.")],
    ], widths=[26, 74], cls="compact"),
])
