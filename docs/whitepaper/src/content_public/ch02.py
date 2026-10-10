from lib import *

CHAPTER = chapter(2, ("Vision and Problem Statement", "الرؤية وبيان المشكلة"),
    ("The vision is simple to state and demanding to deliver: technical support that is organized, context-aware, "
     "accountable and intelligent. The obstacles are not unique to Mad3oom. They are the recurring failure points of "
     "support operations assembled from disconnected tools.",
     "الرؤية سهلة الصياغة وصعبة التحقيق: دعم فني منظَّم، واعٍ بالسياق، قابل للمساءلة، وذكي. والعقبات التي تعترض ذلك ليست خاصة "
     "بمدعوم، بل هي نقاط الإخفاق المتكررة في عمليات الدعم المبنية من أدوات غير مترابطة."),
    [
    H2("The vision", "الرؤية"),
    P("Mad3oom aims to make technical support more organized, more context-aware, more accountable and more intelligent. The order is "
      "deliberate and reflects design logic, not a delivery schedule. Organization comes first, because intelligence applied to disorganized "
      "work produces confident mistakes. Context follows, because every later improvement depends on knowing what has already happened. "
      "Accountability comes next, because work without an owner is the main source of dropped requests. Intelligence is the last layer.",
      "تسعى مدعوم إلى جعل الدعم الفني أكثر تنظيمًا، وأوعى بالسياق، وأقدر على المساءلة، وأكثر ذكاءً. والترتيب مقصود ويعكس منطق "
      "التصميم لا جدول التسليم. فالتنظيم أولًا، لأن الذكاء المطبَّق على عمل غير منظَّم ينتج أخطاء واثقة. ثم السياق، لأن كل تحسين "
      "لاحق يعتمد على معرفة ما جرى بالفعل. ثم المساءلة، لأن العمل بلا مسؤول هو المصدر الرئيس للطلبات الضائعة. وأخيرًا الذكاء."),

    H2("Six problems in customer support", "ست مشكلات في دعم العملاء"),
    NOTE("These are recurring industry problems that the platform is designed to address. They are drawn from general "
         "support-operations practice and from the design reasoning in Mad3oom's engineering documents. They are not "
         "quantified findings from a completed customer study, and this paper reports no statistics about them.",
         "هذه مشكلات متكررة في القطاع صُمِّمت المنصة لمعالجتها. وهي مستمدة من الممارسة العامة لعمليات الدعم ومن منطق التصميم في "
         "الوثائق الهندسية لمدعوم. وليست نتائج كمية لدراسة ميدانية مكتملة للعملاء، ولا تورد هذه الورقة أي إحصاءات بشأنها.",
         title=("Nature of this analysis", "طبيعة هذا التحليل")),

    H3("1. Customer information is scattered", "1. تشتت معلومات العميل"),
    P("One customer can exist as a chat session, a ticket, a profile and an email thread, each in a different screen or "
      "product. Agents rebuild the picture by hand, and different agents rebuild it differently.",
      "قد يظهر العميل الواحد في صورة جلسة محادثة، وتذكرة، وملف شخصي، وسلسلة بريد إلكتروني، كلٌّ منها في شاشة أو منتج مختلف. "
      "فيعيد الوكلاء بناء الصورة يدويًا، ويعيد كل وكيل بناءها على نحو مختلف."),

    H3("2. Context is lost when switching", "2. ضياع السياق عند التنقل"),
    P("Moving from a conversation to a ticket to the customer's history usually means leaving one view to open another, "
      "and half-written replies, the reasoning behind a decision and the reader's place in a long thread are left behind.",
      "يعني الانتقال من محادثة إلى تذكرة إلى سجل العميل في الغالب مغادرة عرض لفتح آخر. فتُترك الردود غير المكتملة، والمنطق الذي "
      "قام عليه القرار، والموضع الذي بلغه القارئ في سلسلة طويلة."),

    H3("3. Follow-ups are forgotten", "3. نسيان المتابعات"),
    P("A commitment made in a conversation, such as “I will check and come back tomorrow”, often lives only in the message "
      "itself. Unless someone copies it into a task list, it depends on memory, and unresolved requests quietly age.",
      "كثيرًا ما يعيش الالتزام الذي يُقطع داخل المحادثة، مثل «سأتحقق وأعود إليك غدًا»، في الرسالة نفسها فقط. وما لم ينسخه أحد "
      "إلى قائمة مهام فإنه يعتمد على الذاكرة، وتتقادم الطلبات غير المحسومة بصمت."),

    H3("4. Handoffs are incomplete", "4. نقص التسليم بين الموظفين"),
    P("When responsibility moves between people or shifts, the receiving agent often has the case but not the context: what was "
      "promised, what was already tried and what is still unknown.",
      "حين تنتقل المسؤولية بين الأشخاص أو الورديات، يتسلّم الموظف القضية غالبًا دون سياقها: ما الذي وُعد به، وما الذي جُرِّب "
      "بالفعل، وما الذي ما زال مجهولًا."),

    H3("5. Ownership, status and next action are hard to see", "5. صعوبة رؤية المسؤول والحالة والإجراء التالي"),
    P("Supervisors can see that work is open, but not always who owns it, what the next step is or whether a deadline has "
      "passed. Work with no owner is invisible until a customer complains.",
      "يرى المشرفون أن العمل مفتوح، لكنهم لا يرون دائمًا من يملكه، ولا ما الخطوة التالية، ولا هل فات الموعد. والعمل بلا مسؤول "
      "غير مرئي إلى أن يشتكي العميل."),

    H3("6. Intelligence is hard to apply consistently", "6. صعوبة تطبيق الذكاء بصورة متسقة"),
    P("Automation and AI features added tool by tool behave differently across channels, are difficult to explain afterwards "
      "and hard to test. Without a controlled design, intelligence amplifies inconsistency instead of reducing it.",
      "الأتمتة وميزات الذكاء الاصطناعي المضافة أداةً أداةً تتصرف على نحو مختلف بين القنوات، ويصعب تفسيرها بعد وقوعها، "
      "ويصعب اختبارها. وبلا تصميم منضبط يضخّم الذكاءُ التباينَ بدلًا من أن يقلّله."),

    H2("What the problems imply for design", "ما تفرضه المشكلات على التصميم"),
    P("Each problem points to a design requirement. The table shows the response chosen for each one, the component that carries "
      "it and the stage that response has reached.",
      "تشير كل مشكلة إلى متطلب تصميمي. ويبيّن الجدول الاستجابة المختارة لكل منها، والمكوّن الذي يحملها، والمرحلة التي بلغتها."),
    TABLE([("Problem", "المشكلة"), ("Design response", "الاستجابة التصميمية"), ("Carried by", "يحملها"), ("Stage", "المرحلة")], [
        [("Scattered information", "تشتت المعلومات"),
         ("Tickets, conversations and customer records in one platform, shown side by side.",
          "التذاكر والمحادثات وسجلات العملاء في منصة واحدة، وتُعرض جنبًا إلى جنب."),
         ("Core platform, Workspace", "المنصة الأساسية، Workspace"), ("{{E}}", "{{E}}")],
        [("Lost context", "ضياع السياق"),
         ("Several work contexts open at once; unsent text is protected when tabs move or close.",
          "عدة سياقات عمل مفتوحة معًا؛ والنص غير المرسل محمي عند نقل التبويبات أو إغلاقها."),
         ("Workspace", "Workspace"), ("{{E}}", "{{E}}")],
        [("Forgotten follow-ups", "المتابعات المنسية"),
         ("Records with a next action, a deadline and a derived overdue flag. Scheduled reminders and escalation are planned.",
          "سجلات لها إجراء تالٍ وموعد وعلامة تأخر مشتقة. أما التذكيرات المجدولة والتصعيد فمخطَّطان."),
         ("Relay", "Relay"), ("{{E}} {{P}}", "{{E}} {{P}}")],
        [("Incomplete handoffs", "التسليم الناقص"),
         ("Controlled reassignment with a history of changes. Handovers that the receiver must accept, clarify or decline are planned.",
          "إعادة إسناد منضبطة مع سجل للتغييرات. أما التسليمات التي يجب على المستلم قبولها أو طلب إيضاحها أو رفضها فمخطَّطة."),
         ("Relay", "Relay"), ("{{E}} {{P}}", "{{E}} {{P}}")],
        [("Limited visibility", "محدودية الرؤية"),
         ("Lists filtered by owner, status and category, with unassigned work flagged. A continuity monitor that explains why a record needs attention is planned.",
          "قوائم مصفّاة بحسب المسؤول والحالة والفئة مع الإشارة إلى العمل غير المسند. أما لوحة المتابعة التي توضّح سبب حاجة السجل إلى انتباه فمخطَّطة."),
         ("Relay", "Relay"), ("{{E}} {{P}}", "{{E}} {{P}}")],
        [("Inconsistent intelligence", "عدم اتساق الذكاء"),
         ("One layered, deterministic engine shared across channels, with a recorded reason for each decision.",
          "محرك واحد حتمي متعدد الطبقات مشترك بين القنوات، مع تسجيل سبب كل قرار."),
         ("SIE", "SIE"), ("{{E}} {{D}}", "{{E}} {{D}}")],
    ], widths=[20, 44, 22, 14], cls="compact",
        caption=("Problems, design responses and stage. Where two stages appear, the first covers what exists and the second what is in development or planned.",
                 "المشكلات والاستجابات التصميمية والمرحلة. وحيث تظهر مرحلتان، فالأولى لما هو قائم والثانية لما هو قيد التطوير أو مخطَّط.")),

    P("These responses explain the structure of the platform described in {{ch3}}.",
      "وتفسّر هذه الاستجابات بنية المنصة الموصوفة في {{ch3}}."),
])
