from lib import *

CHAPTER = chapter(4, ("Mad3oom Workspace", "Mad3oom Workspace"),
    ("Support work rarely fits on one screen. Mad3oom Workspace lets an agent keep several tickets, conversations and customer "
     "records open at once, arranged as tabs and split panels, without losing what has been typed or where they left off.",
     "نادرًا ما يتسع العمل في الدعم لشاشة واحدة. يتيح Mad3oom Workspace للوكيل إبقاء عدة تذاكر ومحادثات وسجلات عملاء مفتوحة معًا، "
     "مرتَّبة في تبويبات ولوحات مقسَّمة، دون أن يفقد ما كتبه أو موضعه في كل منها."),
    [
    H2("The idea", "الفكرة"),
    P("Workspace is a multi-tab work surface inside the Mad3oom administration console. Rather than treating the inbox, the tickets "
      "list and the customer history as separate pages that replace one another, it hosts them side by side. An agent can read a "
      "conversation, open the related ticket beside it and look at the customer's history in a third pane. Each stays as it was left.",
      "Workspace سطح عمل متعدد التبويبات داخل وحدة إدارة مدعوم. فبدلًا من التعامل مع صندوق الوارد وقائمة التذاكر وسجل العميل بوصفها "
      "صفحات يحلّ بعضها محل بعض، يستضيفها جنبًا إلى جنب. ويستطيع الوكيل قراءة محادثة، وفتح التذكرة المرتبطة بها بجانبها، ثم الاطلاع "
      "على سجل العميل في لوحة ثالثة. وتبقى كل منها كما تركها."),

    H2("What exists and what does not", "ما هو قائم وما ليس قائمًا"),
    TABLE([("Capability", "الإمكانية"), ("Detail", "التفصيل"), ("Stage", "المرحلة")], [
        [("**Tickets, conversations and customers in one place**", "**التذاكر والمحادثات والعملاء في مكان واحد**"),
         ("Six panel types: the inbox, tickets and customer-history pages, and single-conversation, single-ticket and single-customer panels.",
          "ستة أنواع من اللوحات: صفحات الصندوق والتذاكر وسجل العملاء، ولوحات المحادثة الواحدة والتذكرة الواحدة والعميل الواحد."),
         ("{{E}}", "{{E}}")],
        [("**Switching without losing context**", "**التنقل دون فقدان السياق**"),
         ("Hosted pages keep running while hidden, within the live-panel limit described below. Closing a tab that holds unsent text asks for confirmation; moving or docking a tab never reloads it.",
          "تبقى الصفحات المستضافة تعمل وهي مخفية، في حدود عدد اللوحات الحية المذكور أدناه. وإغلاق تبويب يحمل نصًا غير مرسل يطلب تأكيدًا؛ أما نقل التبويب أو تثبيته فلا يعيد تحميله."),
         ("{{E}}", "{{E}}")],
        [("**Organizing views**", "**تنظيم العروض**"),
         ("Tabs, groups and nested splits made by dragging a tab to any edge or the center; resizable dividers; quick open with Ctrl+K or Cmd+K; "
          "starter layouts; reopening the last closed tab.",
          "تبويبات ومجموعات وتقسيمات متداخلة تُنشأ بسحب التبويب إلى أي حافة أو إلى المركز؛ وفواصل قابلة لتغيير الحجم؛ وفتح سريع "
          "بالضغط على Ctrl+K أو Cmd+K؛ وتخطيطات ابتدائية؛ وإعادة فتح آخر تبويب أُغلق."),
         ("{{E}}", "{{E}}")],
        [("**Opening related records beside the source**", "**فتح السجلات المرتبطة بجانب المصدر**"),
         ("Following a link from a ticket to its customer opens the customer in another group, or splits the view if only one group exists.",
          "اتباع رابط من تذكرة إلى عميلها يفتح العميل في مجموعة أخرى، أو يقسّم العرض إن لم توجد سوى مجموعة واحدة."),
         ("{{E}}", "{{E}}")],
        [("**Layouts that survive a reload**", "**تخطيطات تبقى بعد إعادة التحميل**"),
         ("Saved per device in browser storage, with titles resolved live and never stored.",
          "تُحفظ لكل جهاز في تخزين المتصفح، وتُحلّ العناوين حيًّا ولا تُخزَّن."),
         ("{{E}}", "{{E}}")],
        [("", ""),
         ("Saving each agent's layout on the server, so it follows the agent across devices. This is in development; until then, layouts are saved per browser.",
          "حفظ تخطيط كل وكيل على الخادم ليتبعه عبر الأجهزة. وهو قيد التطوير؛ وإلى ذلك الحين تُحفظ التخطيطات لكل متصفح."),
         ("{{D}}", "{{D}}")],
        [("**Keyboard, RTL and small screens**", "**لوحة المفاتيح واليمين-يسار والشاشات الصغيرة**"),
         ("Tab-list semantics, direction-aware arrow keys, menu alternatives to dragging, mirrored layout in Arabic, and a one-panel compact mode below 900 px.",
          "دلالات قائمة التبويب، ومفاتيح أسهم تراعي الاتجاه، وبدائل بالقوائم للسحب، وتخطيط معكوس بالعربية، ووضع مدمج للوحة واحدة تحت 900 بكسل."),
         ("{{E}}", "{{E}}")],
        [("**Relay as a panel**", "**Relay بوصفه لوحة**"),
         ("Opening Relay records as a first-class panel type next to the conversation they cite.",
          "فتح سجلات Relay نوعًا قائمًا بذاته من اللوحات بجانب المحادثة التي تستشهد بها."),
         ("{{P}}", "{{P}}")],
        [("**More panel types**", "**أنواع لوحات إضافية**"),
         ("Knowledge and reporting panels. The registry is designed to accept new types without changes to the layout engine.",
          "لوحات للمعرفة والتقارير. صُمِّم السجل ليقبل أنواعًا جديدة دون تعديل محرك التخطيط."),
         ("{{P}}", "{{P}}")],
        [("**Adaptive organization**", "**تنظيم تكيّفي**"),
         ("Named layouts for recurring tasks and context shared across panels.",
          "تخطيطات مسمّاة للمهام المتكررة وسياق مشترك بين اللوحات."),
         ("{{F}}", "{{F}}")],
    ], widths=[26, 56, 18], cls="compact",
        caption=("Workspace capabilities by stage. A row with no capability name continues the row above.",
                 "إمكانات Workspace بحسب المرحلة. الصف الخالي من اسم الإمكانية يكمل الصف الذي يسبقه.")),

    H2("How it is built", "كيف بُني"),
    P("The inbox and tickets pages are built to run once per page, and rewriting the tested helpdesk code was ruled out. "
      "Workspace therefore **hosts the existing pages** as panels, each keeping its own logic, access rules and live updates. "
      "A tab behaves like a browser tab of that page.",
      "صُمِّمت صفحتا الصندوق والتذاكر لتعمل كلٌّ منهما مرة واحدة في الصفحة، واستُبعدت إعادة كتابة شيفرة الدعم المختبَرة. "
      "لذلك **يستضيف Workspace الصفحات القائمة** بوصفها لوحات، تحتفظ كلٌّ منها بمنطقها وقواعد الوصول فيها وتحديثاتها الحية. "
      "فيعمل التبويب كأنه تبويب متصفح لتلك الصفحة."),
    FIG("workspace", ("The Workspace model. A shell arranges tabs and split groups; each panel is an existing page. The three "
                      "supporting parts are shown below the window. The window is illustrative, not a screenshot.",
                      "نموذج Workspace. يرتّب غلافٌ التبويبات والمجموعات المقسَّمة؛ وكل لوحة صفحة قائمة. وتظهر الأجزاء الثلاثة "
                      "الداعمة تحت النافذة. والنافذة توضيحية وليست لقطة شاشة.")),
    UL(("**Positioned panels.** Hosted pages are placed over the area of the group that shows them rather than moved in the page "
        "structure, because moving a hosted page would reload it and discard an unsent reply.",
        "**لوحات موضوعة بالإحداثيات.** توضع الصفحات المستضافة فوق منطقة المجموعة التي تعرضها بدلًا من نقلها في بنية الصفحة، لأن نقل "
        "الصفحة المستضافة يعيد تحميلها ويُسقط ردًا غير مرسل."),
       ("**A pure layout model.** Tabs, groups and splits are described by plain data and pure functions, tested without a browser. "
        "Edges are logical (start and end), so right-to-left is correct by construction. Limits on the number of panels, groups and nesting depth keep layouts bounded.",
        "**نموذج تخطيط خالص.** تُوصَف التبويبات والمجموعات والتقسيمات ببيانات بسيطة ودوال خالصة تُختبر دون متصفح. والحواف منطقية "
        "(بداية ونهاية)، فيصح اتجاه اليمين-يسار بحكم البناء. وتُبقي حدودٌ لعدد اللوحات والمجموعات وعمق التداخل التخطيطاتِ ضمن نطاق محدود."),
       ("**A panel registry.** A registry of allowed panel types validates their parameters.",
        "**سجل للوحات.** سجل بأنواع اللوحات المسموحة يتحقق من معاملاتها."),
       ("**A message bridge.** The shell and hosted pages exchange titles and unsaved-work state through a small, fixed protocol.",
        "**جسر رسائل.** يتبادل الغلاف والصفحات المستضافة العناوين وحالة العمل غير المحفوظ عبر بروتوكول صغير ثابت.")),

    H2("Integrity and access rules", "قواعد السلامة والوصول"),
    P("Workspace is designed to follow these rules.",
      "صُمِّم Workspace ليلتزم بهذه القواعد."),
    UL(("Moving, docking or splitting a tab never reloads or recreates its hosted page.",
        "نقل التبويب أو تثبيته أو تقسيمه لا يعيد تحميل صفحته المستضافة ولا ينشئها من جديد."),
       ("Closing a tab, closing others, resetting the layout or leaving the page checks for unsent work first. The cap on live panels never unloads a panel that holds unsent work.",
        "إغلاق تبويب أو بقية التبويبات أو إعادة ضبط التخطيط أو مغادرة الصفحة يفحص أولًا وجود عمل غير مرسل. والحد الأقصى للوحات الحية لا يُفرغ لوحةً تحمل عملًا غير مرسل."),
       ("Workspace does not submit support actions itself. Replies, ticket changes and other support writes happen inside the hosted page, so the shell does not duplicate a submission.",
        "لا يُجري Workspace بنفسه أي إجراء من إجراءات الدعم؛ فالردود وتعديلات التذاكر وسائر عمليات الكتابة في الدعم تجري داخل الصفحة المستضافة، فلا يكرر الغلاف أي إرسال."),
       ("Saved layouts are validated, and each record panel is checked against the user's own access before it opens; a record that is no longer visible appears as an unavailable tab.",
        "يُتحقَّق من التخطيطات المحفوظة، وتُفحص كل لوحة سجل مقابل صلاحيات المستخدم نفسه قبل فتحها؛ والسجل الذي لم يعد مرئيًا يظهر تبويبًا غير متاح."),
       ("A saved layout contains only panel types and record identifiers, never names, email addresses or message text.",
        "لا يحتوي التخطيط المحفوظ إلا أنواع اللوحات ومعرّفات السجلات، ولا يحتوي أسماء أو عناوين بريد أو نصوص رسائل."),
       ("If saving fails, Workspace keeps working with the in-memory layout, and every page remains usable on its own.",
        "إذا تعذّر الحفظ يواصل Workspace العمل بالتخطيط في الذاكرة، وتبقى كل صفحة صالحة للاستخدام بمفردها.")),

    H2("Engineering evidence and limits", "الأدلة الهندسية والحدود"),
    TABLE([("Check (repository, 9 October 2026)", "الفحص (المستودع، 9 أكتوبر 2026)"), ("Result", "النتيجة")], [
        [("Layout engine unit tests", "اختبارات الوحدة لمحرك التخطيط"), ("28 of 28 pass", "نجح 28 من 28")],
        [("Chromium render tests of the real page code on test doubles", "اختبارات عرض في Chromium لشيفرة الصفحة الفعلية على بدائل اختبارية"), ("22 of 22 pass", "نجح 22 من 22")],
        [("Size of the whole workspace", "حجم Workspace كاملًا"), ("about 46 KB compressed, no new dependency", "نحو 46 كيلوبايت مضغوطًا، دون اعتماديات جديدة")],
        [("Layout operations at the panel limit", "عمليات التخطيط عند الحد الأقصى للوحات"), ("under 1 ms each in Node", "أقل من 1 ميلي ثانية لكل عملية في Node")],
        [("Re-render on tab switch, typical layout (6 tabs)", "إعادة الرسم عند تبديل التبويب، تخطيط نموذجي (6 تبويبات)"), ("median about 9 ms in headless Chromium", "وسيط نحو 9 ميلي ثانية في Chromium بلا واجهة")],
    ], widths=[62, 38], cls="compact",
        caption=("Development-environment checks. They show that the design works as specified; they say nothing about how Workspace performs for agents on production data.",
                 "فحوص في بيئة التطوير. تبيّن أن التصميم يعمل وفق المواصفة، ولا تقول شيئًا عن أداء Workspace للوكلاء على بيانات الإنتاج.")),
    NOTE("Each live panel is a full page instance with its own real-time connection, so the number of live panels is capped at six and the "
         "least recently shown clean panel is unloaded. A draft typed in the inbox does not follow a conversation opened as its own tab. "
         "Hosted pages keep their existing language while the shell follows the language switch. Drag-and-drop is not supported on touch "
         "screens, where compact mode is used instead. No automated accessibility audit has been run. Saving layouts on the server is in "
         "development, so layouts are saved per browser until then.",
         "كل لوحة حية نسخة كاملة من الصفحة ولها اتصالها الحي الخاص، ولذلك يُحدَّد عدد اللوحات الحية بست، وتُفرَّغ أقدمها عرضًا من "
         "اللوحات الخالية من عمل غير مرسل. والمسودة المكتوبة في الصندوق لا ترافق محادثة فُتحت في تبويب مستقل. وتحتفظ الصفحات المستضافة "
         "بلغتها القائمة بينما يتبع الغلاف مفتاح اللغة. ولا يُدعم السحب والإفلات على شاشات اللمس، ويُستعاض عنه بالوضع المدمج. ولم يُجرَ "
         "تدقيق آلي لإمكانية الوصول. وحفظ التخطيطات على الخادم قيد التطوير، فتُحفظ التخطيطات لكل متصفح إلى ذلك الحين.",
         kind="limit"),
])
