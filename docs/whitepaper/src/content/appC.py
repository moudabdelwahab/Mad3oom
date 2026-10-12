from lib import *

CHAPTER = appendix("C", ("Basis of Preparation and Limitations", "أساس الإعداد والحدود"),
    ("How the statements in this paper were established, and what was not verified. A white paper is only as credible as its evidence.",
     "كيف جرى إثبات العبارات الواردة في هذه الورقة، وما الذي لم يجرِ التحقق منه. فمصداقية الورقة البيضاء بقدر أدلتها."),
    [
    H2("Sources reviewed", "المصادر التي روجعت"),
    UL(("The source code and engineering documents of three repositories: the Mad3oom platform, the SIE engine and the WhatsApp module, as they stood on 9 October 2026.",
        "الشيفرة المصدرية والوثائق الهندسية لثلاثة مستودعات: منصة Mad3oom ومحرك SIE ووحدة واتساب، كما كانت في 9 أكتوبر 2026."),
       ("Architecture and implementation records, including the Workspace and Relay design documents, the SIE architecture, guarantee registry and nine-layer audit, "
        "the conversation-core gate and installation notes, and the October 2026 engineering audit of the platform.",
        "سجلات المعمارية والتنفيذ، ومنها وثائق تصميم Workspace وRelay، ومعمارية SIE وسجل ضماناته وتدقيق طبقاته التسع، وبوابة نواة المحادثات "
        "وملاحظات تثبيتها، والتدقيق الهندسي للمنصة في أكتوبر 2026."),
       ("Database migrations, rollback scripts and the automated tests in each repository.", "ترحيلات قاعدة البيانات وسكربتات التراجع والاختبارات الآلية في كل مستودع.")),

    H2("Method", "المنهج"),
    UL(("Statements about what exists rest on the code and on the engineering records. Statements about production rest on those records, which note what was applied and when.",
        "تستند العبارات عما هو قائم إلى الشيفرة والسجلات الهندسية. وتستند العبارات عن الإنتاج إلى تلك السجلات التي تذكر ما طُبِّق ومتى."),
       ("The SIE engine's automated suite was run on the repository's latest commit while this paper was prepared, and 1,264 tests passed.",
        "شُغِّلت مجموعة الاختبارات الآلية لمحرك SIE على أحدث إصدار في المستودع أثناء إعداد هذه الورقة، فنجح 1,264 اختبارًا."),
       ("Figures from engineering records, such as test counts, code sizes and timings, are quoted with their date and with what they measure.",
        "تُذكر الأرقام المأخوذة من السجلات الهندسية، كأعداد الاختبارات وأحجام الشيفرة والأزمنة، مع تاريخها وما تقيسه."),
       ("The English and Arabic editions are produced from one source, so that their structure and facts match. The Arabic edition is equivalent in meaning, not a word-for-word translation.",
        "تُنتَج النسختان الإنجليزية والعربية من مصدر واحد، لتتطابق بنيتهما وحقائقهما. والنسخة العربية مكافئة في المعنى، وليست ترجمة حرفية.")),

    H2("What was not verified", "ما لم يجرِ التحقق منه"),
    TABLE([("Not verified", "غير متحقَّق منه"), ("Consequence for this paper", "الأثر على هذه الورقة")], [
        [("Production usage and volumes", "الاستخدام والأحجام في الإنتاج"), ("No customer counts, usage figures or deployments are reported.", "لا تُذكر أعداد عملاء ولا أرقام استخدام ولا عمليات نشر لدى عملاء.")],
        [("Whether each merged change is live for end users", "هل كل تغيير مدموج متاح للمستخدمين النهائيين"), ("“Existing” means implemented in the repositories, not confirmed live.", "«قائم» تعني منفَّذًا في المستودعات، لا مؤكَّدًا في الإنتاج.")],
        [("Real-world accuracy of SIE", "الدقة الفعلية لـ SIE في الواقع"), ("No accuracy, resolution or satisfaction figures are reported.", "لا تُذكر أرقام للدقة أو الحل أو الرضا.")],
        [("Security assessment by a third party", "تقييم أمني من طرف ثالث"), ("No certification or compliance is claimed.", "لا يُدَّعى حصول على شهادة أو امتثال.")],
        [("Meta provider status and commercial terms", "صفة المزوّد لدى Meta والشروط التجارية"), ("No partnership or provider status is stated.", "لا تُذكر شراكة ولا صفة مزوّد.")],
        [("Changes after 9 October 2026", "التغييرات بعد 9 أكتوبر 2026"), ("They are not reflected in this edition.", "لا تنعكس في هذا الإصدار.")],
    ], widths=[34, 66], cls="compact"),

    H2("Editorial rules", "قواعد التحرير"),
    UL(("Every capability carries a stage label, and a planned feature is never described as a current capability.",
        "تحمل كل إمكانية وسم مرحلة، ولا يُوصف أي ميزة مخطَّطة بأنها إمكانية حالية."),
       ("Passing automated tests are never presented as proof of production reliability.",
        "لا يُعرض نجاح الاختبارات الآلية دليلًا على الموثوقية في الإنتاج."),
       ("No competitor is named and no superiority is claimed. No credentials, customer data or exploitable security detail is included.",
        "لا يُسمَّى منافس ولا يُدَّعى تفوّق. ولا تُدرج بيانات اعتماد ولا بيانات عملاء ولا تفاصيل أمنية يمكن استغلالها."),
       ("Other public material, such as the website's roadmap page last updated in July 2026, is not used as evidence. Where it differs from this paper, this paper follows the repository evidence.",
        "لا تُستخدم المواد العامة الأخرى، كصفحة خارطة الطريق في الموقع التي حُدّثت آخر مرة في يوليو 2026، دليلًا. وحيث تختلف عن هذه الورقة، تتبع الورقة أدلة المستودعات.")),

    H2("Document history", "سجل الوثيقة"),
    TABLE([("Version", "الإصدار"), ("Date", "التاريخ"), ("Note", "ملاحظة")], [
        [("1.0", "1.0"), ("October 2026", "أكتوبر 2026"), ("Foundational edition. Information as of 9 October 2026.", "الإصدار التأسيسي. المعلومات حتى 9 أكتوبر 2026.")],
    ], widths=[16, 24, 60], cls="compact"),
])
