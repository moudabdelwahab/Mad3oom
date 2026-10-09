from lib import *

CHAPTER = chapter(3, ("The Mad3oom Solution", "حل مدعوم"),
    ("Mad3oom's answer is not another silo. It is a connected set of parts: the records of support work, a surface to work on "
     "them, a layer designed to keep work from being dropped, and an engine that understands customer messages.",
     "جواب مدعوم ليس معزلًا جديدًا، بل مجموعة مترابطة من الأجزاء: سجلات العمل في الدعم، وسطح للعمل عليها، وطبقة تهدف إلى منع ضياع "
     "العمل، ومحرك يفهم رسائل العملاء."),
    [
    H2("A unified approach", "نهج موحَّد"),
    P("The platform treats six things as parts of one workflow rather than as separate tools. Each is described below as it exists "
      "today in the project's repositories.",
      "تتعامل المنصة مع ستة عناصر بوصفها أجزاء من سير عمل واحد لا أدوات منفصلة. ويوصف كل منها أدناه كما هو قائم اليوم في مستودعات المشروع."),
    TABLE([("Element", "العنصر"), ("What it provides", "ما يقدّمه"), ("Stage", "المرحلة")], [
        [("**Support tickets**", "**تذاكر الدعم**"),
         ("A ticket lifecycle from opening to resolution, including customer confirmation, rejection or reopening of a resolution; "
          "SLA targets; assignment and distribution; in-platform notifications, ticket email templates, and Telegram alerts for staff.",
          "دورة حياة للتذكرة من الفتح إلى الحل، تشمل تأكيد العميل للحل أو رفضه أو إعادة فتح التذكرة؛ وأهداف مستوى الخدمة SLA؛ "
          "والإسناد والتوزيع؛ والإشعارات داخل المنصة، وقوالب بريد للتذاكر، وتنبيهات تيليجرام للطاقم."),
         ("{{E}}", "{{E}}")],
        [("**Customer conversations**", "**محادثات العملاء**"),
         ("Website chat and Telegram feed a helpdesk inbox with teams, assignment, tags, internal notes, attachments, scheduled replies "
          "and an explicit hand-off between the bot and a human agent.",
          "تغذّي محادثةُ الموقع وتيليجرام صندوقَ وارد للدعم يضم فرقًا وإسنادًا ووسومًا وملاحظات داخلية ومرفقات وردودًا مجدولة "
          "وتسليمًا صريحًا بين الروبوت والموظف البشري."),
         ("{{E}}", "{{E}}")],
        [("**Customer records**", "**سجلات العملاء**"),
         ("A customer history page that gathers a customer's tickets and conversations in one view.",
          "صفحة سجل للعميل تجمع تذاكره ومحادثاته في عرض واحد."),
         ("{{E}}", "{{E}}")],
        [("**Knowledge resources**", "**موارد المعرفة**"),
         ("A public knowledge base and help center, plus knowledge entries that the intelligence engine can attach to answers.",
          "قاعدة معرفة ومركز مساعدة عامان، إضافةً إلى مواد معرفية يستطيع محرك الذكاء إرفاقها بالإجابات."),
         ("{{E}}", "{{E}}")],
        [("**Team workflows**", "**سير عمل الفريق**"),
         ("Roles for platform staff and companies, an automation builder for rules and actions, and company accounts "
          "with their own dashboards.",
          "أدوار لطاقم المنصة وللشركات، ومنشئ أتمتة للقواعد والإجراءات، وحسابات للشركات بلوحات خاصة بها."),
         ("{{E}}", "{{E}}")],
        [("**Operational follow-up**", "**المتابعة التشغيلية**"),
         ("Mad3oom Relay: continuity records with an owner, a next action, a deadline and source evidence. See {{ch5}}.",
          "Mad3oom Relay: سجلات استمرارية لها مسؤول وإجراء تالٍ وموعد ودليل مصدري. انظر {{ch5}}."),
         ("{{E}} {{P}}", "{{E}} {{P}}")],
    ], widths=[22, 62, 16], cls="compact",
        caption=("The six elements of the unified approach and the stage each has reached.",
                 "العناصر الستة للنهج الموحَّد والمرحلة التي بلغها كل منها.")),

    H2("How the parts are meant to relate", "العلاقة المقصودة بين الأجزاء"),
    P("Three layers sit on top of the core records. **Workspace** is the surface on which agents see those records together. "
      "**Relay** is the layer that keeps follow-up work attached to its evidence, its owner and its deadline. **SIE** is the engine "
      "that interprets what customers write. The figure below shows the intended relationships, and the table that follows "
      "states which of them are implemented today.",
      "تقوم ثلاث طبقات فوق السجلات الأساسية. فـ**Workspace** هو السطح الذي يرى عليه الوكلاء تلك السجلات معًا. و**Relay** هي الطبقة "
      "التي تُبقي عمل المتابعة مرتبطًا بدليله ومسؤوله وموعده. و**SIE** هو المحرك الذي يفسّر ما يكتبه العملاء. ويعرض الشكل أدناه "
      "العلاقات المقصودة، ويبيّن الجدول الذي يليه أيها منفَّذ اليوم."),
    FIG("relations", ("Intended relationships between the parts. Solid lines exist today; dashed lines are planned, in development or future. "
                      "This is a conceptual map, not a data-flow specification.",
                      "العلاقات المقصودة بين الأجزاء. الخطوط المتصلة قائمة اليوم؛ والخطوط المتقطعة مخطَّطة أو قيد التطوير أو مستقبلية. "
                      "وهي خريطة مفاهيمية وليست توصيفًا لتدفق البيانات.")),
    TABLE([("Relationship", "العلاقة"), ("What it means", "معناها"), ("Stage", "المرحلة")], [
        [("Workspace and the hosted pages", "Workspace والصفحات المستضافة"),
         ("The existing pages are hosted as panels in an embed mode; they keep their own logic and access rules.",
          "تُستضاف الصفحات القائمة لوحاتٍ بوضع تضمين؛ وتحتفظ بمنطقها وقواعد وصولها."),
         ("{{E}}", "{{E}}")],
        [("Relay and conversations", "Relay والمحادثات"),
         ("An agent selects messages in a conversation and creates a continuity record that cites them.",
          "يحدّد الوكيل رسائل في محادثة وينشئ سجل استمرارية يستشهد بها."),
         ("{{E}}", "{{E}}")],
        [("Relay and tickets", "Relay والتذاكر"),
         ("A ticket as a source of a continuity record.", "التذكرة مصدرًا لسجل استمرارية."),
         ("{{P}}", "{{P}}")],
        [("Relay inside Workspace", "Relay داخل Workspace"),
         ("A Relay record opened as a panel beside the conversation it came from.", "سجل Relay يُفتح لوحةً بجانب المحادثة التي نشأ منها."),
         ("{{P}}", "{{P}}")],
        [("SIE and conversations", "SIE والمحادثات"),
         ("The engine reads inbound website and Telegram messages and writes its replies; a human takeover stops it.",
          "يقرأ المحرك الرسائل الواردة من الموقع وتيليجرام ويكتب ردوده؛ ويتوقف عند استلام موظف بشري للمحادثة."),
         ("{{E}}", "{{E}}")],
        [("SIE and tickets", "SIE والتذاكر"),
         ("When the decision is to open a ticket, the message, state and ticket are committed together.",
          "حين يكون القرار فتح تذكرة، تُحفظ الرسالة والحالة والتذكرة معًا."),
         ("{{E}}", "{{E}}")],
        [("Knowledge and SIE", "المعرفة وSIE"),
         ("Static knowledge entries are attached to answers. Grounding in live account data and published knowledge is in development.",
          "تُرفق مواد معرفية ثابتة بالإجابات. أما الارتكاز على بيانات الحساب الحية والمعرفة المنشورة فقيد التطوير."),
         ("{{E}} {{D}}", "{{E}} {{D}}")],
        [("SIE and Relay", "SIE وRelay"),
         ("The engine handing a follow-up to Relay. No such link exists today.", "تسليم المحرك متابعةً إلى Relay. لا توجد صلة كهذه اليوم."),
         ("{{F}}", "{{F}}")],
    ], widths=[26, 58, 16], cls="compact",
        caption=("Relationships between the parts and their stage.", "العلاقات بين الأجزاء ومرحلتها.")),

    NOTE("Not every integration or workflow described in this paper is fully implemented. Where a relationship is marked as planned, "
         "in development or future, the platform does not yet behave that way. The rest of the paper keeps the same distinction.",
         "ليست كل التكاملات وسير العمل الموصوفة في هذه الورقة منفَّذة بالكامل. فحيثما وُسمت علاقة بأنها مخطَّطة أو قيد التطوير "
         "أو مستقبلية، فإن المنصة لا تتصرف على هذا النحو بعد. وتحافظ بقية الورقة على التمييز نفسه.",
         kind="limit"),

    H2("Two kinds of work, kept separate", "نوعان من العمل، يُبقيان منفصلين"),
    P("A central design decision is to keep **interpretation** apart from **coordination**. Interpretation answers the question "
      "“what is this customer telling us, and what should happen next in this conversation?”. That is SIE's job. Coordination "
      "answers “who is responsible for what, by when, and with which evidence?”. That is Relay's job, together with ticketing. "
      "Keeping them apart lets each be built, tested and improved on its own, and is designed to keep an intelligent component from "
      "silently taking decisions that belong to people.",
      "من القرارات التصميمية المحورية فصل **التفسير** عن **التنسيق**. فالتفسير يجيب عن سؤال «ماذا يخبرنا هذا العميل، وما الذي "
      "ينبغي أن يحدث تاليًا في هذه المحادثة؟»، وهذه مهمة SIE. والتنسيق يجيب عن «من المسؤول عن ماذا، ومتى، وبأي دليل؟»، وهذه مهمة "
      "Relay مع نظام التذاكر. وهذا الفصل يتيح بناء كل منهما واختباره وتحسينه على حدة، ويهدف إلى منع مكوّن ذكي من اتخاذ قرارات تخص "
      "البشر دون علمهم."),
])
