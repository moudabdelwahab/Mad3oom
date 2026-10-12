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
             ("Foundational edition, version 1.0, October 2026. English and Arabic editions, equivalent in meaning and structure.",
              "الإصدار التأسيسي 1.0، أكتوبر 2026. نسختان بالعربية والإنجليزية، متكافئتان في المعنى والبنية.")],
            [("Information as of", "حالة المعلومات"),
             ("9 October 2026, from the engineering documentation and source code of the three project repositories.",
              "9 أكتوبر 2026، استنادًا إلى الوثائق الهندسية والشيفرة المصدرية لمستودعات المشروع الثلاثة.")],
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
        LEGEND(),
        NOTE("Statements about the future are intentions that depend on technical validation and business priorities. "
             "They are not commitments, and no delivery dates are given. This paper reports no customer counts, revenue, "
             "market share, security certifications, partnerships or measured real-world accuracy, because none are "
             "documented. See {{appC}} for the evidence basis.",
             "العبارات المتعلقة بالمستقبل نوايا تعتمد على التحقق التقني وعلى أولويات العمل، وليست التزامات، ولا تتضمن الورقة "
             "مواعيد تسليم. ولا تورد الورقة أعداد عملاء ولا إيرادات ولا حصصًا سوقية ولا شهادات أمنية ولا شراكات ولا قياسات "
             "لدقة الأداء في الواقع، لأن شيئًا من ذلك غير موثَّق. وللاطلاع على أساس الأدلة انظر {{appC}}.",
             kind="limit", title=("Notice", "تنويه")),
    ])
