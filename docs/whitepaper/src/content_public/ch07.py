from lib import *

CHAPTER = chapter(7, ("Integrations and Connectivity", "التكاملات والاتصال"),
    ("Mad3oom's integration vision is that support should meet customers where they already are and connect to the systems teams already "
     "use, without letting any single vendor's details leak into the core platform.",
     "رؤية مدعوم للتكامل أن يلتقي الدعم بالعملاء حيث هم بالفعل، وأن يتصل بالأنظمة التي تستخدمها الفرق، دون أن تتسرب تفاصيل أي "
     "مزوّد بعينه إلى نواة المنصة."),
    [
    H2("Integration principles", "مبادئ التكامل"),
    UL(("**Adapters isolate vendors.** Each messaging channel is an adapter with four duties: verify the request, parse the vendor format into "
        "one standard message, send replies, and optionally show typing. The engine knows nothing about channels, and a test that reads the "
        "source fails if vendor details leak out of the adapter folders.",
        "**المحوِّلات تعزل المزوّدين.** كل قناة مراسلة محوِّل له أربع مهام: التحقق من الطلب، وتحويل صيغة المزوّد إلى رسالة قياسية واحدة، "
        "وإرسال الردود، وإظهار مؤشر الكتابة اختياريًا. ولا يعرف المحرك شيئًا عن القنوات، ويفشل اختبار يقرأ الشيفرة المصدرية إذا تسربت "
        "تفاصيل المزوّد من مجلدات المحوِّلات."),
       ("**Identity before spend.** A single-use, expiring code links a messaging account to a platform account before the engine replies. "
        "This is designed so that a stranger who finds the bot cannot consume a paying customer's allowance.",
        "**الهوية قبل الإنفاق.** يربط رمز لمرة واحدة ومحدود الصلاحية حساب المراسلة بحساب في المنصة قبل أن يرد المحرك. "
        "وقد صُمّم ذلك بحيث لا يستطيع غريب وجد الروبوت أن يستهلك حصة عميل مدفوعة."),
       ("**Verify and de-duplicate before cost.** Verifying incoming requests and recognizing duplicate deliveries are duties of each adapter, "
        "performed before anything is charged.",
        "**التحقق وإزالة التكرار قبل التكلفة.** التحقق من الطلبات الواردة والتعرّف إلى عمليات التسليم المكررة من مهام كل محوِّل، وتجري قبل احتساب أي رسوم."),
       ("**Open, standard interfaces.** OAuth 2.1, the Model Context Protocol and token-based APIs, rather than private conventions.",
        "**واجهات مفتوحة وقياسية.** OAuth 2.1 وبروتوكول سياق النموذج MCP وواجهات قائمة على الرموز، بدل اصطلاحات خاصة.")),

    H2("Channels and connected systems", "القنوات والأنظمة المتصلة"),
    FIG("connectivity", ("Connectivity map. Channels reach the engine through one adapter layer. The lower row shows APIs and tools, event-driven "
                         "work and future connectors. It is conceptual.",
                         "خريطة الاتصال. تصل القنوات إلى المحرك عبر طبقة محوِّلات واحدة. ويعرض الصف السفلي الواجهات والأدوات والعمل المدفوع "
                         "بالأحداث والموصِّلات المستقبلية. وهي خريطة مفاهيمية.")),
    TABLE([("Integration", "التكامل"), ("What exists or is intended", "ما هو قائم أو مقصود"), ("Stage", "المرحلة")], [
        [("**Website chat and customer portal**", "**محادثة الموقع وبوابة العميل**"),
         ("A chat widget that runs in the customer's browser under their own session and calls the engine; customer and company dashboards.",
          "أداة محادثة تعمل في متصفح العميل بجلسته الخاصة وتستدعي المحرك؛ ولوحات للعملاء وللشركات."),
         ("{{E}}", "{{E}}")],
        [("**Telegram**", "**تيليجرام**"),
         ("A support channel handled by the engine, with request verification and account linking. "
          "Customer-facing availability of this channel is not confirmed by the project's code.",
          "قناة دعم يتولاها المحرك، مع التحقق من الطلبات وربط الحسابات. "
          "ولا يثبت من شيفرة المشروع توفر هذه القناة للعملاء."),
         ("{{E}}", "{{E}}")],
        [("**Email**", "**البريد الإلكتروني**"),
         ("Ticket emails sent through an email provider, and receipt of replies by email.",
          "رسائل بريد للتذاكر تُرسل عبر مزوّد بريد، واستقبال الردود عبر البريد الإلكتروني."),
         ("{{E}}", "{{E}}")],
        [("**WhatsApp**", "**واتساب**"),
         ("A separate WhatsApp module. See the next section; it is not part of the initial launch scope.",
          "وحدة واتساب مستقلة. انظر القسم التالي؛ وهي ليست ضمن نطاق الإطلاق الأولي."),
         ("{{D}}", "{{D}}")],
        [("**Messenger and an API channel**", "**ماسنجر وقناة API**"),
         ("Adapter shapes are defined in the engine's channel layer; no transport is connected.",
          "أشكال المحوِّلات معرَّفة في طبقة القنوات للمحرك؛ ولا يوجد نقل متصل."),
         ("{{P}}", "{{P}}")],
        [("**MCP server and client; OAuth 2.1**", "**خادم وعميل MCP؛ OAuth 2.1**"),
         ("Mad3oom can expose tools to MCP-compatible AI clients and connect to external MCP servers. Its authorization server uses PKCE, "
          "scoped tokens and a page where users revoke connected apps.",
          "يمكن لمدعوم إتاحة أدوات لعملاء الذكاء الاصطناعي المتوافقين مع MCP، والاتصال بخوادم MCP خارجية. ويستخدم خادم التفويض لديها PKCE، "
          "ورموزًا محدودة النطاق، وصفحة يسحب منها المستخدمون صلاحية التطبيقات المتصلة."),
         ("{{E}}", "{{E}}")],
        [("**API tokens and the integration API**", "**رموز API وواجهة التكامل**"),
         ("Users can issue scoped API tokens. A versioned integration API lets an approved external application request a pre-approved template "
          "message without knowing the provider, tokens or database; its keys distinguish test from live and can be revoked.",
          "يستطيع المستخدمون إصدار رموز API محدودة النطاق. وتتيح واجهة تكامل ذات إصدارات لتطبيق خارجي معتمد طلب رسالة قالب معتمدة دون أن "
          "يعرف المزوّد أو الرموز أو قاعدة البيانات؛ وتميّز مفاتيحها بين الاختبار والتشغيل، ويمكن إبطالها."),
         ("{{E}}", "{{E}}")],
        [("**Event-driven work**", "**العمل المدفوع بالأحداث**"),
         ("Background and scheduled jobs produce notifications, email, SLA checks and scheduled replies; an automation "
          "builder runs rules when tickets are created; outgoing webhooks notify other systems.",
          "تنتج المهام الخلفية والمجدولة الإشعارات والبريد وفحوص SLA والردود المجدولة؛ ويشغّل منشئ أتمتة "
          "قواعد عند إنشاء التذاكر؛ وتبلّغ ويب هوك صادرة الأنظمة الأخرى."),
         ("{{E}}", "{{E}}")],
        [("**Relay API and browser capture**", "**واجهة Relay والالتقاط من المتصفح**"),
         ("A token-based API for Relay and a browser extension, using the same authorization server.",
          "واجهة Relay قائمة على الرموز وإضافة متصفح، تستخدمان خادم التفويض نفسه."),
         ("{{P}}", "{{P}}")],
        [("**Voice channels**", "**القنوات الصوتية**"),
         ("Speech-to-text, spoken replies and voice support. This is an exploratory vision and is not on the current schedule.",
          "التحويل من الكلام إلى نص، وردود منطوقة، ودعم صوتي. وهي رؤية استكشافية وليست على الجدول الحالي."),
         ("{{F}}", "{{F}}")],
    ], widths=[24, 58, 18], cls="compact long",
        caption=("Integrations by stage.", "التكاملات بحسب المرحلة.")),

    H2("WhatsApp Cloud API: three different things", "واجهة WhatsApp Cloud API: ثلاثة أمور مختلفة"),
    NOTE("WhatsApp is not part of Mad3oom's initial launch scope. Nothing in this paper announces it as an available, generally launched "
         "customer-facing offering.",
         "واتساب ليس جزءًا من نطاق الإطلاق الأولي لمدعوم. ولا يُعلن أي شيء في هذه الورقة عنه بوصفه خدمة متاحة أو مُطلقة للعملاء بصورة عامة.",
         kind="limit", title=("Scope", "النطاق")),
    P("Three separate questions are easy to blur, so they are kept apart here.",
      "ثلاثة أسئلة منفصلة يسهل الخلط بينها، ولذلك تُفصل هنا."),
    TABLE([("Question", "السؤال"), ("What the evidence says", "ما تقوله الأدلة"), ("Stage", "المرحلة")], [
        [("**1. Integration engineering work that exists**", "**1. أعمال هندسة التكامل القائمة**"),
         ("A separate WhatsApp module with its own application. It connects a business number through Meta's Embedded Signup, "
          "verifies requests from Meta, stores each inbound message once, runs auto-reply flows that stop when "
          "a human takes over, and charges template messages against a prepaid wallet. Contract tests cover request verification, provisioning and the integration API.",
          "وحدة واتساب مستقلة بتطبيق خاص بها. تربط رقمًا تجاريًا عبر Embedded Signup من Meta، "
          "وتتحقق من الطلبات الواردة من Meta، وتخزّن كل رسالة واردة مرة واحدة، وتشغّل مسارات رد آلي تتوقف حين "
          "يستلم إنسان المحادثة، وتحاسب رسائل القوالب من محفظة مدفوعة مسبقًا. وتغطي اختبارات العقود التحقق من الطلبات والتهيئة وواجهة التكامل."),
         ("{{D}}", "{{D}}")],
        [("**2. Technical-provider activities**", "**2. أنشطة مزوّد الخدمة التقني**"),
         ("Meta runs programs for providers that onboard other businesses' accounts, including business verification and app review. Completing them and the "
          "commercial terms around them are business and compliance processes that the repositories do not document. This paper therefore states no provider "
          "status, partner agreement or approval.",
          "تدير Meta برامج للمزوّدين الذين يضمّون حسابات شركات أخرى، منها التحقق من النشاط التجاري ومراجعة التطبيق. وإتمامها والشروط "
          "التجارية المحيطة بها عمليات تجارية وامتثالية لا توثّقها المستودعات. ولذلك لا تذكر هذه الورقة أي صفة مزوّد أو اتفاق شراكة أو اعتماد."),
         ("—", "—")],
        [("**3. Future commercial availability**", "**3. الإتاحة التجارية المستقبلية**"),
         ("Any general availability would be announced separately and would depend on completing those requirements and on further engineering "
          "readiness work, including moving WhatsApp onto the shared channel and engine layer.",
          "أي إتاحة عامة ستُعلن على حدة، وستتوقف على استكمال تلك المتطلبات وعلى أعمال جاهزية هندسية إضافية، "
          "منها نقل واتساب إلى طبقة القنوات والمحرك المشتركة."),
         ("{{P}}", "{{P}}")],
    ], widths=[24, 58, 18], cls="compact",
        caption=("The three layers of the WhatsApp question. The platform's policies change over time and are set by Meta.",
                 "الطبقات الثلاث لمسألة واتساب. وسياسات المنصة تتغير مع الزمن وتضعها Meta.")),

    H2("What is not claimed", "ما لا يُدَّعى"),
    P("This paper does not claim any partner agreement, customer deployment or integration beyond those in the table above, and it publishes "
      "no endpoint addresses or API contracts. Where an integration is listed as planned or in development, the platform does not yet connect that way.",
      "لا تدّعي هذه الورقة أي اتفاق شراكة أو نشرًا لدى عملاء أو تكاملًا يتجاوز ما في الجدول أعلاه، ولا تنشر عناوين نقاط وصول ولا عقود "
      "واجهات. وحيث يُذكر تكامل بوصفه مخطَّطًا أو قيد التطوير، فإن المنصة لا تتصل بهذه الطريقة بعد."),
])
