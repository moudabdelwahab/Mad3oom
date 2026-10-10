from lib import *

CHAPTER = chapter(5, ("Mad3oom Relay", "Mad3oom Relay"),
    ("Tickets record cases. Relay records commitments. It is the follow-up and coordination layer that keeps a piece of work attached "
     "to its evidence, its owner and its deadline, so that a promise made in a conversation does not depend on someone remembering it.",
     "تسجّل التذاكر القضايا، أما Relay فتسجّل الالتزامات. وهي طبقة المتابعة والتنسيق التي تُبقي العمل مرتبطًا بدليله ومسؤوله وموعده، "
     "حتى لا يعتمد الوعد الذي قُطع في محادثة على ذاكرة أحد."),
    [
    H2("The business problem", "المشكلة العملية"),
    P("Work loses its context, its owner or its next action when responsibility moves between people or shifts. The usual symptoms "
      "are forgotten follow-ups, problems that outlive a shift, handovers without context, commitments discussed in chat and never "
      "tracked, and customers who must explain their issue again. A ticketing system answers whether a case is open. It does not by "
      "itself answer who has promised what, by when, on the strength of which evidence.",
      "يفقد العمل سياقه أو مسؤوله أو إجراءه التالي حين تنتقل المسؤولية بين الأشخاص أو الورديات. ومن أعراض ذلك متابعات منسية، "
      "ومشكلات تتجاوز وردية بعينها، وتسليم بلا سياق، والتزامات نوقشت في المحادثة ولم تُتتبَّع، وعملاء يضطرون إلى شرح مشكلتهم من جديد. "
      "ونظام التذاكر يجيب عن سؤال: هل القضية مفتوحة؟ لكنه لا يجيب وحده عن: من وعد بماذا، ومتى، وبأي دليل؟"),

    H2("What a continuity record is", "ما هو سجل الاستمرارية"),
    NOTE("A **continuity record** is the operational unit of Relay. It combines evidence (references to selected messages), "
         "one accountable owner or an explicit “unassigned”, a next action, a deadline with an explicit time zone, a completion that "
         "must be justified, and an append-only history.",
         "**سجل الاستمرارية** هو الوحدة التشغيلية في Relay. ويجمع الدليل (إحالات إلى رسائل مختارة)، ومسؤولًا واحدًا أو «غير مسند» "
         "صراحةً، وإجراءً تاليًا، وموعدًا بمنطقة زمنية صريحة، وإغلاقًا لا بد من تعليله، وسجلًا تاريخيًا لا يُعدَّل بل يُضاف إليه.",
         kind="defn", title=("Definition", "تعريف")),
    P("Today a record is either a **follow-up**, which must have a next action and a deadline, or an **issue**, a problem that needs "
      "resolving. A third kind, **handover**, is planned (see below). Each record can also carry one "
      "of nine categories, such as order status, payment and billing, technical issue or complaint.",
      "السجل اليوم إما **متابعة**، وتستلزم إجراءً تاليًا وموعدًا، أو **مشكلة**، أي أمرًا يحتاج إلى حل. أما النوع الثالث، "
      "**التسليم**، فمخطَّط (انظر أدناه). ويمكن أن يحمل كل سجل إحدى تسع فئات، مثل حالة الطلب أو "
      "المدفوعات والفوترة أو المشكلة التقنية أو الشكوى."),

    H2("How Relay complements ticketing", "كيف تكمّل Relay نظام التذاكر"),
    TABLE([("", ""), ("Ticket", "التذكرة"), ("Relay record", "سجل Relay")], [
        [("**Main question**", "**السؤال الرئيس**"),
         ("Is this customer case open, and how is it progressing?", "هل قضية العميل هذه مفتوحة، وكيف تتقدم؟"),
         ("Who committed to what, by when, on which evidence?", "من التزم بماذا، ومتى، وبأي دليل؟")],
        [("**Scope**", "**النطاق**"),
         ("A customer-facing case.", "قضية مرتبطة بالعميل."),
         ("Any piece of follow-up work, whether or not a ticket exists.", "أي عمل متابعة، سواء وُجدت تذكرة أم لم توجد.")],
        [("**Evidence**", "**الدليل**"),
         ("The messages of the ticket thread.", "رسائل سلسلة التذكرة."),
         ("Selected messages cited from conversations, shown only to people who still have access to the original conversation.", "رسائل مختارة من المحادثات، لا تُعرض إلا لمن ما زال له حق الوصول إلى المحادثة الأصلية.")],
        [("**Time**", "**الزمن**"),
         ("SLA targets by priority.", "أهداف مستوى الخدمة بحسب الأولوية."),
         ("An explicit deadline and time zone. Overdue is derived and never resolves anything by itself.", "موعد ومنطقة زمنية صريحان. والتأخر مشتق ولا يحسم شيئًا بنفسه.")],
        [("**Ownership**", "**المسؤولية**"),
         ("An assigned agent or team.", "وكيل أو فريق مسند إليه."),
         ("One accountable owner or an explicit “unassigned”, with rules on who may assign.", "مسؤول واحد أو «غير مسند» صراحةً، مع قواعد لمن يحق له الإسناد.")],
        [("**History**", "**السجل التاريخي**"),
         ("Ticket activity.", "نشاط التذكرة."),
         ("An append-only event log that holds identifiers and changes, not message text.", "سجل أحداث لا يُعدَّل يحمل المعرّفات والتغييرات لا نصوص الرسائل.")],
    ], widths=[18, 38, 44], cls="compact",
        caption=("Ticketing and Relay answer different questions and are designed to be used together.",
                 "يجيب نظام التذاكر وRelay عن أسئلة مختلفة، وصُمِّما ليُستخدما معًا.")),

    H2("Capabilities against the intended concepts", "الإمكانات مقابل المفاهيم المقصودة"),
    TABLE([("Concept", "المفهوم"), ("What exists or is intended", "ما هو قائم أو مقصود"), ("Stage", "المرحلة")], [
        [("**Tracking follow-ups and outstanding actions**", "**تتبّع المتابعات والإجراءات المعلّقة**"),
         ("Follow-up and issue records with a lifecycle (open, scheduled, in progress, waiting, resolved, cancelled), a next action, "
          "a priority and a category; a filterable list; creation from selected inbox messages through a three-step dialog.",
          "سجلات متابعة ومشكلات ذات دورة حياة (مفتوح، مجدول، قيد المعالجة، بانتظار، تمت المعالجة، مُلغى)، وإجراء تالٍ وأولوية وفئة؛ "
          "وقائمة قابلة للتصفية؛ والإنشاء من رسائل مختارة في الصندوق عبر حوار من ثلاث خطوات."),
         ("{{E}}", "{{E}}")],
        [("**Preserving context through summaries**", "**حفظ السياق عبر الملخصات**"),
         ("Each record can hold a summary written by the person who creates it, and cites its source messages. Excerpts are shown only to "
          "people who still have access to the original conversation. Automatic summarization is not implemented.",
          "يمكن أن يحمل كل سجل ملخصًا يكتبه من ينشئه، ويستشهد برسائله المصدرية. ولا تُعرض المقتطفات إلا لمن ما زال لديه حق الوصول إلى "
          "المحادثة الأصلية. أما التلخيص الآلي فغير منفَّذ."),
         ("{{E}}", "{{E}}")],
        [("", ""),
         ("Assisted extraction of titles, dates and next actions, with every suggestion editable and never confirmed automatically.",
          "استخراج مساعَد للعناوين والتواريخ والإجراءات التالية، مع بقاء كل اقتراح قابلًا للتعديل ودون تأكيد آلي."),
         ("{{F}}", "{{F}}")],
        [("**Clarifying ownership**", "**توضيح المسؤولية**"),
         ("One owner field; unassigned work is flagged. Assigning work to others is a controlled permission granted explicitly; it is not a default.",
          "حقل مسؤول واحد؛ ويُشار إلى العمل غير المسند. والإسناد إلى الآخرين صلاحية خاضعة للضبط تُمنح صراحةً، وليست وضعًا افتراضيًا."),
         ("{{E}}", "{{E}}")],
        [("**Supporting handoffs**", "**دعم التسليم**"),
         ("Reassignment under the rules above, with a history of every change.", "إعادة إسناد وفق القواعد أعلاه، مع سجل لكل تغيير."),
         ("{{E}}", "{{E}}")],
        [("", ""),
         ("A formal handover that the receiver must accept, query or decline; handovers to a team where the first to accept wins; end-of-shift bundles. "
          "The record keeps the previous owner until acceptance.",
          "تسليم رسمي يجب أن يقبله المستلم أو يستوضحه أو يرفضه؛ وتسليم إلى فريق يفوز فيه أول من يقبل؛ وحزم نهاية الوردية. ويحتفظ "
          "السجل بالمسؤول السابق حتى القبول."),
         ("{{P}}", "{{P}}")],
        [("**Making pending and overdue work visible**", "**إظهار العمل المعلّق والمتأخر**"),
         ("An overdue flag derived from the deadline, shown in lists; filters by status, owner and category.",
          "علامة تأخر مشتقة من الموعد تظهر في القوائم؛ وتصفية بحسب الحالة والمسؤول والفئة."),
         ("{{E}}", "{{E}}")],
        [("", ""),
         ("Reminders before a deadline, escalation, and a continuity monitor that lists records needing attention with a reason "
          "(unassigned, no next action, overdue, handover pending, owner inactive).",
          "تذكيرات قبل الموعد، وتصعيد، ولوحة متابعة تعرض السجلات التي تحتاج إلى انتباه مع السبب (غير مسند، بلا إجراء تالٍ، "
          "متأخر، تسليم معلّق، مسؤول غير نشط)."),
         ("{{P}}", "{{P}}")],
        [("**Continuity and accountability**", "**الاستمرارية والمساءلة**"),
         ("An append-only event log; version checks that reject stale edits; idempotency keys that prevent duplicate records on retries.",
          "سجل أحداث لا يُعدَّل؛ وفحوص إصدار ترفض التعديلات القديمة؛ ومفاتيح تفرّد تمنع تكرار السجلات عند إعادة المحاولة."),
         ("{{E}}", "{{E}}")],
    ], widths=[24, 58, 18], cls="compact",
        caption=("Relay capabilities against the six intended concepts. A row with no concept name continues the row above.",
                 "إمكانات Relay مقابل المفاهيم الستة المقصودة. الصف الخالي من اسم المفهوم يكمل الصف الذي يسبقه.")),
    FIG("lifecycle", ("The lifecycle of a continuity record. Solid arrows are implemented transitions; the dashed branch is the designed but not yet available handover.",
                      "دورة حياة سجل الاستمرارية. الأسهم المتصلة انتقالات منفَّذة؛ والفرع المتقطع هو التسليم المصمَّم لكنه غير متاح بعد.")),

    H2("Governance of evidence", "حوكمة الأدلة"),
    P("Relay copies a small piece of customer conversation into another place, so its design treats that copy carefully. "
      "These rules are designed to be enforced in the database layer and are exercised by automated tests.",
      "تنسخ Relay جزءًا صغيرًا من محادثة العميل إلى موضع آخر، ولذلك يعامل تصميمها هذه النسخة بحذر. وهذه القواعد مصمَّمة لتُفرَض في "
      "طبقة قاعدة البيانات وتُجرى عليها اختبارات آلية."),
    UL(("**Minimal capture.** Only the messages the user selects are stored, within a bounded size.",
        "**التقاط أدنى.** لا تُخزَّن إلا الرسائل التي يحدّدها المستخدم، وضمن حجم محدود."),
       ("**Access follows the conversation.** An excerpt is shown only to someone who has access to the record and who still has access to the "
        "original conversation.",
        "**الوصول يتبع المحادثة.** لا يُعرض المقتطف إلا لمن له حق الوصول إلى السجل ولا يزال له حق الوصول إلى المحادثة الأصلية."),
       ("**Retention and redaction.** Excerpts are hidden a defined period after a record is closed and are then redacted "
        "irreversibly.",
        "**الاحتفاظ والمحو.** تُخفى المقتطفات بعد مدة محددة من إغلاق السجل ثم تُمحى محوًا لا رجعة فيه."),
       ("**Sensitive content.** Captured messages that look sensitive need an explicit acknowledgement before they are saved.",
        "**المحتوى الحساس.** الرسائل الملتقطة التي تبدو حساسة تتطلب إقرارًا صريحًا قبل حفظها."),
       ("**History without content.** Audit events are designed to hold identifiers and changes, not excerpt text or free-text values, so "
        "content can be removed without breaking the history.",
        "**تاريخ بلا محتوى.** صُمِّمت أحداث التدقيق لتحمل المعرّفات والتغييرات لا نص المقتطف ولا القيم النصية الحرة، "
        "فيمكن إزالة المحتوى دون كسر التاريخ."),
       ("**Trash and restore.** A removed source goes to a trash and can be restored. This capability is in development.",
        "**السلة والاسترجاع.** يذهب المصدر المُزال إلى سلة ويمكن استرجاعه. وهذه الإمكانية قيد التطوير.")),

    H2("Stage and limits", "المرحلة والحدود"),
    TABLE([("Phase", "الطور"), ("Content", "المحتوى"), ("Stage", "المرحلة")], [
        [("Core persistence and access rules", "الحفظ الأساسي وقواعد الوصول"),
         ("Records, sources, snapshots, events, ownership rules, retention.",
          "السجلات والمصادر واللقطات والأحداث وقواعد المسؤولية والاحتفاظ."),
         ("{{E}}", "{{E}}")],
        [("Native selection and conversion", "الاختيار والتحويل داخل المنصة"),
         ("The inbox dialog, type preview, the Relay page and assignment permissions.",
          "حوار الصندوق ومعاينة النوع وصفحة Relay وصلاحيات الإسناد."),
         ("{{E}}", "{{E}}")],
        [("Trash and restore", "السلة والاسترجاع"),
         ("Removal with restore.", "إزالة مع استرجاع."),
         ("{{D}}", "{{D}}")],
        [("Handover", "التسليم"), ("Handover records with acceptance, clarification and decline; end-of-shift bundles.",
                                    "سجلات تسليم مع القبول والاستيضاح والرفض؛ وحزم نهاية الوردية."),
         ("{{P}}", "{{P}}")],
        [("Scheduling and monitor", "الجدولة ولوحة المتابعة"), ("Reminders, escalation and the continuity monitor.",
                                                                  "التذكيرات والتصعيد ولوحة متابعة الاستمرارية."),
         ("{{P}}", "{{P}}")],
        [("External API and browser capture", "الواجهة الخارجية والالتقاط من المتصفح"),
         ("A token-based API for other clients, and a browser extension that records a selected passage with its page address.",
          "واجهة قائمة على الرموز لعملاء آخرين، وإضافة متصفح تسجّل مقطعًا محدّدًا مع عنوان صفحته."),
         ("{{P}}", "{{P}}")],
        [("Assisted extraction; company workspaces", "الاستخراج المساعَد؛ مساحات الشركات"),
         ("Suggested fields from messages; Relay for companies' own support teams.", "حقول مقترحة من الرسائل؛ وRelay لفرق الدعم لدى الشركات."),
         ("{{F}}", "{{F}}")],
    ], widths=[26, 56, 18], cls="compact",
        caption=("Relay by delivery phase.", "Relay بحسب مراحل التسليم.")),
    NOTE("Relay is currently scoped to the platform's own support inbox and to platform staff; company workspaces are not yet supported. "
         "It is not yet linked to tickets, to Workspace panels or to SIE. It sends no reminders, and it produces no automatic summaries. The "
         "measures intended to show its value (records created per source, share of active records with an owner and a next action, overdue "
         "count and age, handover acceptance time, reminders delivered against failed) are defined but not yet reported, so this paper makes no "
         "claim about how much it reduces missed requests.",
         "تقتصر Relay حاليًا على صندوق الدعم الخاص بالمنصة وعلى طاقم المنصة؛ ومساحات الشركات غير مدعومة بعدُ. وهي غير "
         "مرتبطة بعدُ بالتذاكر ولا بلوحات Workspace ولا بـ SIE. ولا ترسل تذكيرات، ولا تنتج ملخصات آلية. والمقاييس المقصودة لإثبات "
         "قيمتها (السجلات المنشأة لكل مصدر، ونسبة السجلات النشطة التي لها مسؤول وإجراء تالٍ، وعدد المتأخر وعمره، وزمن قبول التسليم، "
         "والتذكيرات المُسلَّمة مقابل الفاشلة) معرَّفة لكن لم يُبلَّغ عنها بعد، فلا تقدّم هذه الورقة ادعاءً بمدى تقليلها للطلبات الفائتة.",
         kind="limit"),
])
