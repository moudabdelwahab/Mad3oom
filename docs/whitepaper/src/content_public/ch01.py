from lib import *

CHAPTER = chapter(1, ("Executive Summary", "الملخص التنفيذي"),
    ("Mad3oom is a platform for technical support and customer operations. It brings tickets, customer conversations, "
     "customer records, knowledge and follow-up work into one structured environment, and adds a layer of support-specific "
     "intelligence on top.",
     "مدعوم منصة للدعم الفني وعمليات خدمة العملاء. تجمع التذاكر ومحادثات العملاء وسجلاتهم والمعرفة وأعمال المتابعة في بيئة "
     "منظَّمة واحدة، وتضيف إليها طبقة من الذكاء المتخصص في الدعم الفني."),
    [
    KEY(("At a glance", "نظرة موجزة"),
        ("Mad3oom unifies tickets, conversations, customer records, knowledge and operational follow-up in one platform.",
         "توحّد مدعوم التذاكر والمحادثات وسجلات العملاء والمعرفة والمتابعة التشغيلية في منصة واحدة."),
        ("Three layers shape its design: **Workspace** for multi-context work, **Relay** for continuity and accountability, "
         "and **SIE** for support intelligence.",
         "ثلاث طبقات تشكّل تصميمها: **Workspace** للعمل متعدد السياقات، و**Relay** للاستمرارية والمساءلة، و**SIE** للذكاء الخاص بالدعم."),
        ("Foundations exist in code; the official launch is still ahead. Every capability in this paper is labeled by stage.",
         "الأسس قائمة في الشيفرة، أما الإطلاق الرسمي فما زال قادمًا. وكل إمكانية في هذه الورقة موسومة بمرحلتها."),
        ("The architecture favors modularity, clear interfaces and explainable decisions over feature breadth.",
         "تُفضِّل المعمارية النمطية وواجهات التخاطب الواضحة والقرارات القابلة للتفسير على اتساع الميزات.")),

    H2("What Mad3oom is", "ما هي مدعوم"),
    P("Mad3oom is a software platform for support teams. It lets a team receive customer requests, understand them, assign "
      "responsibility, keep the context of every interaction and follow each request until it is resolved. It is designed as a "
      "coherent technology product with a defined architecture, rather than as a chat widget or a conventional ticket list.",
      "مدعوم منصة برمجية موجَّهة لفرق الدعم. تتيح للفريق استقبال طلبات العملاء وفهمها وإسناد المسؤولية عنها والاحتفاظ بسياق كل "
      "تفاعل ومتابعة كل طلب حتى يُحَل. وقد صُمِّمت منتجًا تقنيًا متماسكًا ذا معمارية محددة، وليس أداة محادثة منفصلة ولا قائمة تذاكر تقليدية."),
    P("The design is Arabic-first: interfaces are right-to-left, and the intelligence layer is built to handle Arabic dialects "
      "and Arabic written in Latin letters, while the engine can also reply in English.",
      "التصميم عربي الأولوية: الواجهات من اليمين إلى اليسار، وطبقة الذكاء مبنية للتعامل مع اللهجات العربية والعربية المكتوبة "
      "بالحروف اللاتينية، ويستطيع المحرك كذلك الرد بالإنجليزية."),

    H2("Whom it serves", "من تخدم"),
    UL(("**Support agents and supervisors**, who need one place to work on tickets and conversations without losing context.",
        "**وكلاء الدعم والمشرفون**، الذين يحتاجون إلى مكان واحد للعمل على التذاكر والمحادثات دون فقدان السياق."),
       ("**Companies** that support their own customers and need structure, clear ownership and visibility over open work.",
        "**الشركات** التي تقدّم الدعم لعملائها وتحتاج إلى بنية منظَّمة ومسؤولية واضحة ورؤية شاملة للأعمال المفتوحة."),
       ("**Customers**, who reach support through a portal and messaging channels and should not have to repeat themselves.",
        "**العملاء**، الذين يصلون إلى الدعم عبر بوابة وقنوات مراسلة، ولا ينبغي أن يُضطروا إلى تكرار شرح مشكلاتهم."),
       ("**Platform operators**, who need governance over access, data and automation.",
        "**مشغّلو المنصة**، الذين يحتاجون إلى حوكمة للصلاحيات والبيانات والأتمتة.")),

    H2("The problems it addresses", "المشكلات التي تعالجها"),
    P("Support work degrades when customer information is scattered, context is lost between tools, follow-ups are forgotten, "
      "handoffs are incomplete, ownership is unclear and intelligence is applied inconsistently. These are common industry "
      "problems, analyzed in {{ch2}}. They are described here as the reasoning behind the design, not as findings of a "
      "completed customer study.",
      "يتدهور العمل في الدعم حين تتشتت معلومات العميل، ويضيع السياق بين الأدوات، وتُنسى المتابعات، ويكون التسليم ناقصًا، "
      "وتغيب وضوحية المسؤولية، ويُطبَّق الذكاء بصورة غير متسقة. وهذه مشكلات شائعة في القطاع تُحلَّل في {{ch2}}، وتُعرض هنا بوصفها "
      "منطق التصميم، لا بوصفها نتائج دراسة ميدانية مكتملة للعملاء."),

    H2("Main components", "المكوّنات الرئيسة"),
    FIG("glance", ("Mad3oom at a glance. A conceptual map of the platform, with the stage of each part. It is not a deployment diagram.",
                   "مدعوم في لمحة. خريطة مفاهيمية للمنصة مع مرحلة كل جزء، وليست مخطط نشر.")),
    TABLE([("Component", "المكوّن"), ("Role", "الدور"), ("Stage", "المرحلة")], [
        [("**Core support platform**", "**منصة الدعم الأساسية**"),
         ("Tickets with SLA targets and notifications, a helpdesk inbox with human–bot handoff, customer history, a knowledge base and team workflows.",
          "تذاكر مع أهداف مستوى الخدمة SLA وإشعارات، وصندوق وارد للدعم مع تسليم بين الإنسان والروبوت، وسجل للعميل، وقاعدة معرفة، وسير عمل للفريق."),
         ("{{E}}", "{{E}}")],
        [("**Mad3oom Workspace**", "**Mad3oom Workspace**"),
         ("A tabbed, split-panel surface that hosts tickets, conversations and customer records side by side.",
          "سطح عمل بتبويبات ولوحات مقسَّمة يستضيف التذاكر والمحادثات وسجلات العملاء جنبًا إلى جنب."),
         ("{{E}} {{D}}", "{{E}} {{D}}")],
        [("**Mad3oom Relay**", "**Mad3oom Relay**"),
         ("Continuity records that keep evidence, an accountable owner, a next action and a deadline together.",
          "سجلات استمرارية تحفظ معًا الدليل والمسؤول والإجراء التالي والموعد."),
         ("{{E}} {{P}}", "{{E}} {{P}}")],
        [("**SIE**", "**SIE**"),
         ("A deterministic engine that interprets customer messages and decides the next support action.",
          "محرك حتمي يفسّر رسائل العملاء ويقرّر إجراء الدعم التالي."),
         ("{{E}} {{D}}", "{{E}} {{D}}")],
        [("**Integration layer**", "**طبقة التكامل**"),
         ("Channel adapters, MCP with OAuth 2.1, API tokens and event-driven side effects.",
          "محوِّلات القنوات، وبروتوكول MCP مع OAuth 2.1، ورموز API، والآثار الجانبية المدفوعة بالأحداث."),
         ("{{E}}", "{{E}}")],
    ], widths=[24, 56, 20], cls="compact",
        caption=("Components and their stage. Workspace, Relay and SIE each combine delivered parts with parts still in development or planned; the detail is in {{ch4}}, {{ch5}} and {{ch6}}.",
                 "المكوّنات ومراحلها. تجمع كل من Workspace وRelay وSIE بين أجزاء مُسلَّمة وأجزاء قيد التطوير أو مخطَّطة؛ وتفاصيل ذلك في {{ch4}} و{{ch5}} و{{ch6}}.")),

    H2("The value of one connected workflow", "قيمة سير العمل المترابط"),
    P("The intended value comes from three properties that separate tools rarely provide together.",
      "تنبع القيمة المقصودة من ثلاث خصائص نادرًا ما تجتمع في أدوات منفصلة."),
    UL(("**Context travels with the work.** A ticket, the conversation behind it and the customer's history are reachable from the same place.",
        "**السياق يرافق العمل.** يمكن الوصول إلى التذكرة والمحادثة التي وراءها وسجل العميل من المكان نفسه."),
       ("**Responsibility is explicit.** Each piece of follow-up work has one accountable owner, a next action and a deadline that is visible to the team.",
        "**المسؤولية صريحة.** لكل عمل متابعة مسؤول واحد وإجراء تالٍ وموعد ظاهر للفريق."),
       ("**Intelligence is controlled and explainable.** The engine chooses from a closed set of actions through ordered rules, and records why.",
        "**الذكاء منضبط وقابل للتفسير.** يختار المحرك من مجموعة مغلقة من الإجراءات عبر قواعد مرتَّبة، ويسجّل سبب اختياره.")),
    P("These are design intentions. Whether they translate into fewer missed requests or faster resolution can only be shown "
      "by measurement in real use, and this paper reports no such measurements.",
      "وهذه نوايا تصميمية. أما ترجمتها إلى طلبات فائتة أقل أو معالجة أسرع فلا يثبتها إلا القياس في الاستخدام الفعلي، ولا تورد "
      "هذه الورقة أي قياسات من هذا النوع."),

    H2("Where the project stands", "أين يقف المشروع اليوم"),
    NOTE("Mad3oom has not launched. The paper describes foundations that exist in the code, work that is under way and "
         "directions that are planned. A controlled pilot is the intended first step. No customer deployments, "
         "benchmarks of real-world accuracy or security certifications are claimed.",
         "لم تُطلَق مدعوم بعد. تصف الورقة أسسًا قائمة في الشيفرة، وأعمالًا جارية، واتجاهات مخطَّطة. والخطوة الأولى المقصودة تجربة تشغيلية "
         "محدودة. ولا يُدَّعى هنا وجود عمليات نشر لدى عملاء ولا قياسات لدقة الأداء في الواقع ولا شهادات أمنية.",
         kind="limit", title=("Stage of the project", "مرحلة المشروع")),
])
