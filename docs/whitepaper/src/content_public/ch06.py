from lib import *

CHAPTER = chapter(6, ("SIE: Support Intelligence Engine", "SIE: محرك ذكاء الدعم الفني"),
    ("SIE is Mad3oom's specialized engine for technical-support conversations. It reads what a customer writes, weighs it against a "
     "catalog of known support situations, and chooses one next action from a closed set while recording why. It is deliberately "
     "not a general-purpose chatbot.",
     "SIE هو محرك مدعوم المتخصص في محادثات الدعم الفني. يقرأ ما يكتبه العميل، ويقارنه بكتالوج من حالات الدعم المعروفة، ويختار "
     "إجراءً تاليًا واحدًا من مجموعة مغلقة، مع تسجيل سبب اختياره. وهو ليس روبوت دردشة عامَّ الغرض عن قصد."),
    [
    H2("What SIE is, and what it is not", "ما هو SIE وما ليس هو"),
    P("SIE is a deterministic, rule- and data-driven engine written as dependency-free JavaScript modules. For the same input and the "
      "same configuration it produces the same decision: time is injected rather than read, there is no randomness, and ties are "
      "settled by an explicit rule. Its decision is one action from a closed vocabulary, chosen by ordered rules, and each rule "
      "records whether it matched and why.",
      "SIE محرك حتمي قائم على القواعد والبيانات، مكتوب بوحدات JavaScript بلا اعتماديات خارجية. فمن المدخل نفسه والإعداد نفسه ينتج "
      "القرار نفسه: الوقت يُحقن ولا يُقرأ، ولا عشوائية فيه، وتُحسم حالات التعادل بقاعدة صريحة. وقراره إجراء واحد من مفردات مغلقة، "
      "تختاره قواعد مرتَّبة، وتسجّل كل قاعدة هل انطبقت ولماذا."),
    P("Determinism and a closed action set make the engine explainable and testable. The trade-off is coverage: SIE handles the "
      "situations its catalog describes and does not improvise outside it.",
      "والحتمية ومجموعة الإجراءات المغلقة تجعلان المحرك قابلًا للتفسير والاختبار. ومقابل ذلك التغطية: يتعامل SIE مع الحالات "
      "التي يصفها كتالوجه، ولا يرتجل خارجها."),
    NOTE("This paper does not claim human-level reasoning, autonomous resolution of every issue, guaranteed accuracy or independently "
         "verified production performance for SIE. A generative model does not make SIE's decisions today. Whether controlled "
         "generative assistance could be added is a long-term direction, discussed in {{ch11}}.",
         "لا تدّعي هذه الورقة لـ SIE استدلالًا بمستوى الإنسان، ولا حلًا ذاتيًا لكل مشكلة، ولا دقة مضمونة، ولا أداءً إنتاجيًا مُتحقَّقًا "
         "منه باستقلال. ولا يتخذ نموذج توليدي قرارات SIE اليوم. أما إمكان إضافة مساعدة توليدية منضبطة فاتجاه بعيد المدى يناقشه {{ch11}}.",
         kind="limit", title=("What is not claimed", "ما لا يُدَّعى")),

    H2("Interpreting a problem versus coordinating the work", "تفسير المشكلة مقابل تنسيق العمل"),
    P("SIE answers one question: what is this customer telling us, and what should happen next in this conversation? Its possible "
      "outputs are conversational: answer from knowledge, ask for more detail, check an understanding with the customer, open a "
      "ticket, or hand the conversation to a person. It does not assign owners, set deadlines or track commitments. That coordination "
      "belongs to ticketing and to Relay ({{ch5}}).",
      "يجيب SIE عن سؤال واحد: ماذا يخبرنا هذا العميل، وما الذي ينبغي أن يحدث تاليًا في هذه المحادثة؟ ومخرجاته الممكنة حوارية: "
      "الإجابة من المعرفة، أو طلب مزيد من التفاصيل، أو التحقق من فهم مع العميل، أو فتح تذكرة، أو تسليم المحادثة إلى إنسان. ولا يسند "
      "مسؤولين ولا يحدد مواعيد ولا يتتبع التزامات. فذلك التنسيق من شأن نظام التذاكر وRelay ({{ch5}})."),
    P("Today SIE's only operational effects are its chat reply and, when it so decides, a ticket created in the same atomic step. "
      "A human takeover of a conversation stops it from replying. There is no link from SIE to Relay yet; handing follow-up work "
      "from the engine to Relay is a future possibility.",
      "اليوم، الأثر التشغيلي الوحيد لـ SIE هو رده في المحادثة، وتذكرة تُنشأ في الخطوة الذرية نفسها حين يقرر ذلك. واستلام موظف بشري "
      "للمحادثة يوقف ردوده. ولا توجد صلة بين SIE وRelay بعد؛ وتسليم المحرك أعمال متابعة إلى Relay احتمال مستقبلي."),

    H2("A layered design", "تصميم متعدد الطبقات"),
    P("SIE is organized in nine layers plus a trust boundary that cuts across them. The figure lists them in runtime order, which "
      "differs from their numbering: knowledge is attached before the reply is written.",
      "يُنظَّم SIE في تسع طبقات إضافة إلى حد ثقة يخترقها جميعًا. ويسردها الشكل بترتيب التشغيل، وهو يختلف عن ترقيمها: إذ تُرفق "
      "المعرفة قبل صياغة الرد."),
    FIG("sie_layers", ("SIE layers in runtime order, with stage. The numbering is the layers' own; the trust boundary treats customer "
                       "text as untrusted data across the layers.",
                       "طبقات SIE بترتيب التشغيل مع مرحلة كل منها. الترقيم هو ترقيم الطبقات نفسها؛ ويعامل حد الثقة نص العميل "
                       "بوصفه بيانات غير موثوقة عبر الطبقات.")),
    TABLE([("Responsibility", "المسؤولية"), ("What exists", "ما هو قائم")], [
        [("**Language understanding and normalization**", "**فهم اللغة وتطبيعها**"),
         ("Tokenization; a technical glossary that maps many phrasings to canonical terms; Arabic-dialect normalization; Arabic written in "
          "Latin letters; reply language. Matching respects whole-word boundaries, negation and yes/no polarity.",
          "التجزئة؛ ومعجم تقني يحوّل صيغًا كثيرة إلى مصطلحات معيارية؛ وتطبيع اللهجات العربية؛ والعربية المكتوبة بحروف لاتينية؛ ولغة الرد. "
          "وتراعي المطابقة حدود الكلمات الكاملة والنفي واتجاه نعم/لا.")],
        [("**Scenario-based reasoning and interpretation**", "**الاستدلال والتفسير القائمان على السيناريوهات**"),
         ("A closed catalog of authored scenarios, each with a signature of expected evidence, resolutions and questions; grouped "
          "into editions and extensible by a published overlay. About 900 scenarios in the largest edition.",
          "كتالوج مغلق من سيناريوهات مؤلَّفة، لكل منها توقيع من الأدلة المتوقعة وحلول وأسئلة؛ مجمَّعة في إصدارات وقابلة للتوسيع "
          "بطبقة منشورة. نحو 900 سيناريو في أكبر إصدار.")],
        [("**Diagnostic analysis**", "**التحليل التشخيصي**"),
         ("Extracts evidence from each message, accumulates it over the conversation and scores each candidate scenario by how much of its "
          "signature is present. Session state can be stored in a compact sparse form.",
          "يستخرج الأدلة من كل رسالة، ويراكمها على امتداد المحادثة، ويقيّم كل سيناريو مرشَّح بقدر ما يتوافر من توقيعه. ويمكن حفظ حالة "
          "الجلسة بصورة مخفَّفة.")],
        [("**Candidate ranking and decision logic**", "**ترتيب المرشحين ومنطق القرار**"),
         ("Deterministic ordering with explicit tie-breaks, specificity and an ambiguity flag; then ordered decision rules that choose one "
          "action and record every rule evaluated.",
          "ترتيب حتمي بقواعد تعادل صريحة ومراعاة للتخصيص وعلم للالتباس؛ ثم قواعد قرار مرتَّبة تختار إجراءً واحدًا وتسجّل كل قاعدة فُحصت.")],
        [("**Dialogue management**", "**إدارة الحوار**"),
         ("Decisions are rendered as messages in Arabic or English from templates, with a parity test between the two languages.",
          "تُصاغ القرارات رسائل بالعربية أو الإنجليزية من قوالب، مع اختبار تكافؤ بين اللغتين.")],
        [("**Knowledge retrieval and application**", "**استرجاع المعرفة وتطبيقها**"),
         ("Static knowledge entries attach to answers for a small set of scenarios. A separate inverted-index step narrows scoring to "
          "relevant candidates and is tested to give the same results as a full scan.",
          "مواد معرفية ثابتة تُرفق بالإجابات لمجموعة صغيرة من السيناريوهات. وخطوة منفصلة بفهرس معكوس تحصر التقييم في المرشحين المعنيين "
          "وقد اختُبر أنها تعطي النتائج نفسها التي يعطيها المسح الكامل.")],
        [("**Action-oriented support workflows**", "**سير عمل الدعم الموجَّه بالإجراءات**"),
         ("The action layer is the only writer. One decision becomes one atomic transaction covering the message, the session state and, "
          "when decided, the ticket. Each paid turn is traced once, with the decision's intent and the executed outcome kept apart.",
          "طبقة التنفيذ هي الكاتب الوحيد. فالقرار الواحد يصبح معاملة ذرية واحدة تشمل الرسالة وحالة الجلسة والتذكرة عند قرار فتحها. "
          "ويُتتبَّع كل دور مدفوع مرة واحدة، مع فصل نية القرار عن النتيجة المنفَّذة.")],
    ], widths=[26, 74], cls="compact long",
        caption=("The seven responsibilities of the engine and what exists for each.",
                 "المسؤوليات السبع للمحرك، وما هو قائم لكل منها.")),
    H3("In development", "قيد التطوير"),
    UL(("Grounding answers in live account data (ticket and subscription status) and in published knowledge.",
        "ارتكاز الإجابات على بيانات الحساب الحية (حالة التذكرة والاشتراك) وعلى المعرفة المنشورة."),
       ("Awareness of attachments.",
        "إدراك المرفقات."),
       ("Continued extension of scenario and language coverage.",
        "مواصلة توسيع تغطية السيناريوهات واللغات.")),

    H2("Why the layers matter", "لماذا تهم الطبقات"),
    UL(("**Modularity.** Dependencies run one way: the engine imports nothing from channel or platform code, "
        "and a test enforces the same boundary on the channel side. Scenarios and glossary are data behind provider interfaces, not code.",
        "**النمطية.** تسير الاعتماديات في اتجاه واحد: فالمحرك لا يستورد شيئًا من شيفرة القنوات أو المنصة، "
        "ويفرض اختبار الحدّ نفسه من جهة القنوات. والسيناريوهات والمعجم بيانات خلف واجهات مزوّدين، وليست شيفرة."),
       ("**Testability.** Layers are pure functions with an injected clock, so the suite runs without a database or network. At the time of writing "
        "all 1,264 tests in the engine repository pass. Behavioral guarantees are registered and linked to tests.",
        "**قابلية الاختبار.** الطبقات دوال خالصة بساعة محقونة، فتعمل المجموعة دون قاعدة بيانات أو شبكة. وقت كتابة هذه الورقة تنجح "
        "جميع اختبارات مستودع المحرك وعددها 1,264. وتُسجَّل الضمانات السلوكية وتُربط باختبارات."),
       ("**Maintainability.** Each layer has its own tests and a narrow contract, there is a single writer, and every decision carries the rules "
        "that produced it, so a surprising reply can be traced to a cause.",
        "**قابلية الصيانة.** لكل طبقة اختباراتها وعقدها الضيق، وكاتب واحد، وكل قرار يحمل القواعد التي أنتجته، فيمكن ردّ الرد المفاجئ إلى سببه."),
       ("**Controlled evolution.** Behavioral changes ship behind settings flags that default to current behavior, and changes proceed "
        "in staged steps with stated exit criteria.",
        "**تطور منضبط.** تُطرح التغييرات السلوكية خلف أعلام إعداد افتراضيها السلوك الحالي، وتمضي التغييرات على مراحل متدرجة "
        "لها معايير إنجاز معلنة.")),

    H2("What has been verified, and what has not", "ما جرى التحقق منه وما لم يجرِ"),
    TABLE([("Evidence", "الدليل"), ("What it shows", "ما يبيّنه")], [
        [("Automated tests", "الاختبارات الآلية"),
         ("1,264 tests pass in the engine repository (run on 9 October 2026). They verify specified behavior under controlled conditions. They are not accuracy measurements.",
          "تنجح 1,264 اختبارًا في مستودع المحرك (جرى تشغيلها في 9 أكتوبر 2026). وهي تتحقق من سلوك محدد في ظروف مضبوطة، وليست قياسات للدقة.")],
        [("Scale benchmarks, synthetic", "قياسات التوسع، تركيبية"),
         ("On generated catalogs, computation time stayed in milliseconds up to 10,000 scenarios; resident memory and index build time, not computation, "
          "limit larger sizes. These are synthetic measurements, not production load results.",
          "على كتالوجات مولَّدة بقي زمن الحساب في حدود أجزاء من الثانية حتى 10,000 سيناريو؛ وما يحدّ الأحجام الأكبر هو الذاكرة المقيمة وزمن بناء "
          "الفهرس لا الحساب. وهي قياسات تركيبية، وليست نتائج حمل إنتاجي.")],
        [("Trust boundary", "حد الثقة"),
         ("Exercised in tests on synthetic hostile and legitimate messages. Its behavior on real traffic has not been measured.",
          "جرى اختباره على رسائل تركيبية عدائية ومشروعة. أما سلوكه على حركة حقيقية فلم يُقَس.")],
        [("Accuracy, resolution rate, satisfaction", "الدقة ونسبة الحل والرضا"),
         ("Not measured. No such figure is claimed.", "غير مقيسة. ولا يُدَّعى أي رقم من هذا النوع.")],
    ], widths=[26, 74], cls="compact",
        caption=("The evidence behind SIE, stated with its limits.", "الأدلة التي يستند إليها SIE، مع حدودها.")),

    H2("Where SIE runs", "أين يعمل SIE"),
    P("SIE runs server-side behind the website chat and the Telegram channel, reached through a shared adapter layer ({{ch7}}). "
      "It is offered in editions that differ in scenario coverage, and administrators set its behavior through a settings schema. "
      "Its operation is pre-launch and at limited volume.",
      "يعمل SIE في جهة الخادم خلف محادثة الموقع وقناة تيليجرام، وتصل إليه القنوات عبر طبقة محوِّلات مشتركة ({{ch7}}). "
      "ويُقدَّم في إصدارات تتفاوت في تغطية السيناريوهات، ويضبط المسؤولون سلوكه عبر مخطط إعدادات. وتشغيله في مرحلة ما قبل الإطلاق "
      "وبحجم محدود."),
])
