from lib import *

INFO = Chapter(
    num=None, kind="front", letter=None, slug="front-info",
    title=("About this document", "حول هذه الوثيقة"),
    lead=None,
    blocks=[
        TABLE([("Item", "البند"), ("Detail", "التفصيل")], [
            [("Title", "العنوان"),
             ("**The Mad3oom White Paper** — Intelligent Customer Support & Unified Customer Operations",
              "**الورقة البيضاء الأساسية لمنصة مدعوم** — الدعم الذكي للعملاء وتوحيد عمليات خدمة العملاء")],
            [("Edition", "الإصدار"),
             ("Public edition, version 1.0, October 2026. English and Arabic editions, equivalent in meaning and structure.",
              "النسخة العامة، الإصدار 1.0، أكتوبر 2026. نسختان بالعربية والإنجليزية، متكافئتان في المعنى والبنية.")],
            [("Information as of", "حالة المعلومات"),
             ("9 October 2026, from the project's engineering documentation and source code.",
              "9 أكتوبر 2026، استنادًا إلى الوثائق الهندسية والشيفرة المصدرية للمشروع.")],
            [("Intended readers", "القرّاء المستهدفون"),
             ("Prospective partners, technical stakeholders and business audiences",
              "الشركاء المحتملون، والمعنيون التقنيون، والجهات ذات الاهتمام التجاري")],
            [("Product stage", "مرحلة المنتج"),
             ("Pre-launch. The official launch is still ahead.", "ما قبل الإطلاق. الإطلاق الرسمي ما زال قادمًا.")],
        ], widths=[26, 74], cls="docinfo"),
        H2("Purpose and scope", "الغرض والنطاق"),
        P("This paper presents the product vision, platform architecture and roadmap of Mad3oom, an intelligent customer "
          "support and customer operations platform. It is written as a credible foundation for conversations with partners "
          "and technical stakeholders, and it separates what exists from what is under development, planned or merely envisaged.",
          "تعرض هذه الورقة الرؤية المنتجية والمعمارية التقنية وخارطة الطريق لمنصة مدعوم، وهي منصة للدعم الذكي للعملاء "
          "وعمليات خدمتهم. وقد كُتبت أساسًا موثوقًا للحوار مع الشركاء والمعنيين التقنيين، ولذلك تفصل بين ما هو قائم، وما هو قيد "
          "التطوير، وما هو مخطَّط، وما هو تصوُّر بعيد."),
        H2("How to read the status labels", "كيفية قراءة وسوم الحالة"),
        P("Every capability in this paper carries one of the labels below. They describe engineering status, not commercial "
          "availability.",
          "تحمل كل إمكانية في هذه الورقة أحد الوسوم الآتية. وهي تصف الحالة الهندسية، ولا تصف الإتاحة التجارية."),
        LEGEND(rows=[
            ("E", ("Implemented in the project repositories, with automated tests where noted. It does not imply "
                   "production maturity, wide use or independent validation.",
                   "منفَّذ في مستودعات المشروع، مع اختبارات آلية حيث يُذكر ذلك. ولا يعني نضجًا إنتاجيًا "
                   "ولا استخدامًا واسعًا ولا تحققًا مستقلًا.")),
            ("D", ("Active engineering work: code written or partly delivered, not yet complete or enabled for users.",
                   "عمل هندسي جارٍ: شيفرة مكتوبة أو مُسلَّمة جزئيًا، لم تكتمل أو لم تُفعَّل للمستخدمين بعد.")),
            ("P", ("Designed and intended, with no delivered implementation yet. Subject to validation and priorities.",
                   "مصمَّم ومقصود، دون تنفيذ مُسلَّم حتى الآن، ويخضع للتحقق من الجدوى ولترتيب الأولويات.")),
            ("F", ("A long-term opportunity or exploratory direction. No commitment is made.",
                   "فرصة بعيدة المدى أو اتجاه استكشافي، ولا يُقدَّم بشأنه أي التزام.")),
            ("R", ("Architectural direction proposed by this paper. It is advice, not a statement about the current system.",
                   "اتجاه معماري مقترح في هذه الورقة. وهو توجيه، وليس وصفًا للنظام الحالي.")),
        ]),
        NOTE("Statements about the future are intentions that depend on technical validation and business priorities. "
             "They are not commitments, and no delivery dates are given. This paper reports no customer counts, revenue, "
             "market share, security certifications, partnerships or measured real-world accuracy, because none are "
             "documented. See {{appC}} for the evidence basis. This public edition describes product capabilities, "
             "architecture at a conceptual level and security principles, and does not publish operational or "
             "implementation detail.",
             "العبارات المتعلقة بالمستقبل نوايا تعتمد على التحقق التقني وعلى أولويات العمل، وليست التزامات، ولا تتضمن الورقة "
             "مواعيد تسليم. ولا تورد الورقة أعداد عملاء ولا إيرادات ولا حصصًا سوقية ولا شهادات أمنية ولا شراكات ولا قياسات "
             "لدقة الأداء في الواقع، لأن شيئًا من ذلك غير موثَّق. وللاطلاع على أساس الأدلة انظر {{appC}}. وتعرض هذه النسخة العامة "
             "إمكانيات المنتج والمعمارية على المستوى المفاهيمي ومبادئ الأمن، ولا تنشر تفاصيل تشغيلية أو تنفيذية.",
             kind="limit", title=("Notice", "تنويه")),
    ])
