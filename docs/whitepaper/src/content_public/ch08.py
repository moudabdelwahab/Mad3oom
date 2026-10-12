from lib import *

CHAPTER = chapter(8, ("Technical Architecture", "المعمارية التقنية"),
    ("Mad3oom is built from deliberately simple, modular parts. This chapter describes the architecture at a conceptual level: the "
     "layers and the principles that shape them. It does not describe the technology stack, hosting or infrastructure.",
     "بُنيت مدعوم من أجزاء بسيطة ونمطية عن قصد. ويصف هذا الفصل المعمارية على مستوى مفاهيمي: الطبقات والمبادئ التي تشكّلها. "
     "ولا يصف التقنيات المستخدمة ولا الاستضافة ولا البنية التحتية."),
    [
    H2("Conceptual architecture", "المعمارية المفاهيمية"),
    P("The platform is organized in three layers. People and connected systems reach it through clients and channel adapters. Platform "
      "services hold identity and access, the support records and their business rules, integrations and background work. The intelligence "
      "layer interprets support conversations and decides the next step.",
      "تُنظَّم المنصة في ثلاث طبقات. يصل إليها الأشخاص والأنظمة المتصلة عبر واجهات العملاء ومحوِّلات القنوات. وتضم خدمات المنصة الهوية "
      "والصلاحيات، وسجلات الدعم وقواعد عملها، والتكاملات، والعمل في الخلفية. أما طبقة الذكاء فتفسّر محادثات الدعم وتقرر الخطوة التالية."),
    FIG("architecture", ("A conceptual overview of the layers. It is not a deployment, network or data-flow diagram.",
                         "نظرة مفاهيمية على الطبقات. وهي ليست مخطط نشر ولا شبكة ولا تدفق بيانات.")),

    H2("Principles at work", "المبادئ قيد العمل"),
    TABLE([("Principle", "المبدأ"), ("How it appears today", "كيف يظهر اليوم"), ("Stage", "المرحلة")], [
        [("**Modularity**", "**النمطية**"),
         ("Newer features are split into separate model, data and view parts. The engine is layered behind narrow interfaces. Workspace panels are registered, not hard-wired.",
          "تُقسَّم الميزات الأحدث إلى أجزاء منفصلة للنموذج والبيانات والعرض. والمحرك متعدد الطبقات خلف واجهات ضيقة. واللوحات في Workspace تُسجَّل في سجل خاص ولا تُثبَّت مباشرة في الشيفرة."),
         ("{{E}}", "{{E}}")],
        [("**Clear interfaces**", "**واجهات واضحة**"),
         ("Channel adapters have a four-duty contract, and the Workspace bridge has a fixed message protocol.",
          "لمحوِّلات القنوات عقد من أربع مهام، وللجسر في Workspace بروتوكول رسائل ثابت."),
         ("{{E}}", "{{E}}")],
        [("**Separation of responsibilities**", "**فصل المسؤوليات**"),
         ("In SIE, deciding and writing are separate layers, and writes are designed to go through one layer. Workspace does not write support records: the hosted pages do. Domain rules are intended to live with the data rather than in the pages that reach it.",
          "في SIE تُفصل طبقتا القرار والكتابة، والكتابة مصمَّمة لتمر عبر طبقة واحدة. ولا يكتب Workspace سجلات الدعم: بل تكتبها الصفحات المستضافة. والمقصود أن تقيم قواعد المجال مع البيانات لا في الصفحات التي تصل إليها."),
         ("{{E}}", "{{E}}")],
        [("**Maintainability and safe change**", "**قابلية الصيانة والتغيير الآمن**"),
         ("Changes to data structures are versioned and written to be re-run safely. Relay rejects edits made against a stale version and does not create duplicates when a request is retried.",
          "تُرقَّم التغييرات على هياكل البيانات وتُكتب لتُعاد بأمان. وترفض Relay التعديل الذي يُجرى على إصدار قديم من السجل، ولا تنشئ نسخًا مكررة حين يُعاد إرسال الطلب."),
         ("{{E}}", "{{E}}")],
        [("**Reproducible decisions**", "**قرارات قابلة لإعادة الإنتاج**"),
         ("The engine has no randomness, takes time as an injectable parameter and orders ties explicitly, so decisions are designed to be replayable.",
          "لا عشوائية في المحرك، والوقت فيه معامل قابل للحقن، ويرتّب حالات التعادل صراحةً، فالقرارات مصمَّمة لتكون قابلة لإعادة التشغيل."),
         ("{{E}}", "{{E}}")],
        [("**One conversation core**", "**نواة محادثات واحدة**"),
         ("A unified conversation layer intended to be shared by every channel.",
          "طبقة محادثات موحَّدة يُقصد أن تتشاركها القنوات كلها."),
         ("{{D}}", "{{D}}")],
    ], widths=[22, 60, 18], cls="compact",
        caption=("Architectural principles and where they show in the code.", "المبادئ المعمارية وأين تظهر في الشيفرة.")),

    H2("Quality practice", "ممارسات الجودة"),
    P("Changes are checked by automated tests and code scanning in continuous integration. The checks include tests of access rules "
      "and browser render tests. The SIE engine had 1,264 passing tests on 9 October 2026. Passing tests show specified behavior under "
      "controlled conditions; they are not evidence of production reliability.",
      "تُفحص التغييرات باختبارات آلية وفحص للشيفرة ضمن التكامل المستمر. وتشمل الفحوص اختبارات لقواعد الوصول واختبارات عرض في "
      "المتصفح. وكان لمحرك SIE 1,264 اختبارًا ناجحًا في 9 أكتوبر 2026. ونجاح الاختبارات يبيّن سلوكًا محددًا في ظروف مضبوطة، "
      "ولا يُعد دليلًا على الموثوقية في الإنتاج."),
    NOTE("This public edition does not publish the technology stack, hosting providers, infrastructure, a complete system diagram or API "
         "contracts. The architecture is described at the conceptual level only.",
         "لا تنشر هذه النسخة العامة التقنيات المستخدمة ولا مزوّدي الاستضافة ولا البنية التحتية ولا مخططًا كاملًا للنظام ولا عقود الواجهات. "
         "وتُوصف المعمارية على المستوى المفاهيمي فقط.",
         kind="limit"),
])
