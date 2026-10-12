from lib import *

CHAPTER = chapter(9, ("Security, Privacy and Governance", "الأمان والخصوصية والحوكمة"),
    ("A customer-support platform holds conversations, identities and operational history. This chapter describes the principles Mad3oom follows "
     "to protect that information, the safeguards that can be traced to its code, tests and documented practice, and how security is governed. "
     "It states design intent and practice. It does not describe any control as complete or independently verified.",
     "تحتفظ منصة دعم العملاء بمحادثات وهويات وتاريخ تشغيلي. يصف هذا الفصل المبادئ التي تلتزم بها مدعوم لحماية هذه المعلومات، "
     "وتدابير الحماية التي يمكن تتبّعها إلى شيفرتها واختباراتها وممارساتها الموثَّقة، وكيفية حوكمة الأمان. وهو يعرض النية التصميمية والممارسة، "
     "ولا يصف أي ضابط بأنه مكتمل أو متحقَّق منه باستقلال."),
    [
    NOTE("Mad3oom makes no claim of compliance with, or certification against, GDPR, ISO 27001, SOC 2 or any other standard, because none has "
         "been independently assessed. No independent penetration test or third-party security audit is documented. The descriptions in this "
         "chapter are design objectives and safeguards that can be traced to the product's code, tests and documented practice. They are not "
         "guarantees, and they do not mean that every control has been independently verified. For security reasons, the chapter does not publish "
         "credentials, customer data or implementation detail.",
         "لا تدّعي مدعوم الامتثال لـ GDPR أو ISO 27001 أو SOC 2 أو أي معيار آخر، ولا الحصول على شهادة وفقه، لأن شيئًا من ذلك لم يخضع "
         "لتقييم مستقل. ولا يوجد اختبار اختراق مستقل ولا تدقيق أمني من طرف ثالث موثَّق. والأوصاف الواردة في هذا الفصل أهداف تصميمية وتدابير حماية "
         "يمكن تتبّعها إلى شيفرة المنتج واختباراته وممارساته الموثَّقة؛ وهي ليست ضمانات، ولا تعني أن كل ضابط قد جرى التحقق منه "
         "باستقلال. ولدواعٍ أمنية، لا ينشر هذا الفصل بيانات اعتماد ولا بيانات عملاء ولا تفاصيل تنفيذية.",
         kind="limit", title=("Compliance and assurance statement", "بيان الامتثال والتحقق")),

    H2("Security by design", "الأمان بالتصميم"),
    P("Mad3oom treats security as part of the architecture rather than as a layer added at the end. Four principles guide design decisions "
      "across the platform, Workspace, Relay and SIE.",
      "تتعامل مدعوم مع الأمان بوصفه جزءًا من المعمارية لا طبقةً تُضاف في النهاية. وتهتدي قرارات التصميم في المنصة وWorkspace وRelay وSIE "
      "بأربعة مبادئ."),
    UL(("**Decide access in the platform, not only in the interface.** Access is decided by the platform itself, so that what a screen "
        "shows or hides is never the only control.",
        "**تُقرَّر الصلاحية في المنصة لا في الواجهة وحدها.** تقرر المنصة نفسها من يصل إلى ماذا، فلا يكون ما تُظهره الشاشة أو تُخفيه "
        "هو الضابط الوحيد."),
       ("**Grant the least privilege needed.** Use roles, teams and explicit permissions to limit what each person and each component can do.",
        "**أقل صلاحية لازمة.** تُستخدم الأدوار والفرق والأذونات الصريحة للحدّ مما يستطيع كل شخص وكل مكوّن فعله."),
       ("**Treat input as untrusted.** Handle customer text and requests that arrive from outside the platform as data to be checked, "
        "not as instructions to be followed.",
        "**المُدخَل غير موثوق.** يُعامَل نص العميل والطلبات الواردة من خارج المنصة بوصفها بيانات تُفحص، لا تعليمات تُتَّبع."),
       ("**Keep only what is needed, for as long as it is needed.** Copy as little customer content as possible, and decide how long it is kept.",
        "**الاحتفاظ بالقدر اللازم وللمدة اللازمة فقط.** يُنسخ أقل قدر ممكن من محتوى العميل، وتُحدَّد مدة الاحتفاظ به.")),

    H2("Safeguards and how they are substantiated", "تدابير الحماية وكيف يُستدَل عليها"),
    P("For each area, the table gives the design objective and the safeguards that can be traced to the project's code, automated tests and "
      "documented practice. “Existing” means present in that code and covered by tests where noted. It does not mean externally audited, and it "
      "does not mean that every case is covered.",
      "يعرض الجدول لكل مجال الهدف التصميمي وتدابير الحماية التي يمكن تتبّعها إلى شيفرة المشروع واختباراته الآلية وممارساته الموثَّقة. و«قائم» "
      "تعني موجودًا في تلك الشيفرة ومغطًّى باختبارات حيث يُذكر ذلك، ولا تعني خضوعه لتدقيق خارجي ولا أن كل الحالات مغطاة."),
    TABLE([("Area", "المجال"), ("Design objective and safeguards", "الهدف التصميمي وتدابير الحماية"), ("Stage", "المرحلة")], [
        [("**Authentication and authorization**", "**المصادقة والتفويض**"),
         ("Access to account data requires sign-in. Authorization is treated as an architectural responsibility rather than a property of "
          "individual pages: access rules are designed to be enforced by the platform, based on the identity of the person making the request.",
          "يتطلب الوصول إلى بيانات الحساب تسجيل الدخول. ويُعامَل التفويض بوصفه مسؤولية معمارية لا خاصية في الصفحات: فقواعد الوصول "
          "مصمَّمة لتفرضها المنصة اعتمادًا على هوية صاحب الطلب."),
         ("{{E}}", "{{E}}")],
        [("**Least privilege and controlled permissions**", "**أقل الصلاحيات والأذونات المنضبطة**"),
         ("Platform staff, company roles and platform ownership are separate authority domains. Support agents work with the conversations "
          "assigned to them or to their team, and supervisors have a wider view. In Relay, giving work to another person is an explicit "
          "permission, not a default.",
          "طاقم المنصة وأدوار الشركات ومالك المنصة نطاقات سلطة منفصلة. ويعمل وكلاء الدعم على المحادثات المسندة إليهم أو إلى فريقهم، "
          "وللمشرفين رؤية أوسع. وفي Relay يكون إسناد العمل إلى شخص آخر إذنًا صريحًا لا وضعًا افتراضيًا."),
         ("{{E}}", "{{E}}")],
        [("**Protection of conversations and sensitive information**", "**حماية المحادثات والمعلومات الحساسة**"),
         ("Access to a conversation determines who can see anything derived from it: Relay shows a saved excerpt only to people who still have "
          "access to the original conversation. Relay asks for explicit confirmation before saving captured messages that appear to contain "
          "sensitive personal or payment data. SIE is designed to treat customer text as untrusted data.",
          "يحدّد الوصول إلى المحادثة من يرى أي شيء مشتق منها: فلا تعرض Relay المقتطف المحفوظ إلا لمن ما زال له حق الوصول إلى المحادثة "
          "الأصلية. وتطلب Relay تأكيدًا صريحًا قبل حفظ رسائل ملتقطة يبدو أنها تتضمن بيانات شخصية أو مالية حساسة. وصُمّم SIE ليعامل نص "
          "العميل بوصفه بيانات غير موثوقة."),
         ("{{E}}", "{{E}}")],
        [("**Secure integrations and credential protection**", "**التكاملات الآمنة وحماية بيانات الاعتماد**"),
         ("Integrations use open standards: OAuth 2.1 for application access, scoped tokens, and a page where users revoke connected "
          "applications. API tokens can be revoked. Credentials are kept out of the code. Requests that arrive from outside the platform "
          "are designed to be verified before they are acted on.",
          "تعتمد التكاملات معايير مفتوحة: OAuth 2.1 لوصول التطبيقات، ورموزًا محدودة النطاق، وصفحة يسحب منها المستخدمون صلاحية "
          "التطبيقات المتصلة. ويمكن إبطال رموز API. وتُحفظ بيانات الاعتماد خارج الشيفرة. والطلبات الواردة من خارج المنصة مصمَّمة "
          "ليُتحقق منها قبل التصرف بناءً عليها."),
         ("{{E}}", "{{E}}")],
        [("**Data minimization, retention and deletion**", "**تقليل البيانات والاحتفاظ والحذف**"),
         ("Relay stores only the excerpts that a user selects, hides them a defined period after a record closes and then redacts them "
          "irreversibly; its history keeps identifiers and changes rather than message content. A published process lets people ask for "
          "their data to be deleted.",
          "تخزّن Relay المقتطفات التي يحدّدها المستخدم فقط، وتخفيها بعد مدة محددة من إغلاق السجل ثم تمحوها محوًا لا رجعة فيه؛ ويحتفظ "
          "سجلها التاريخي بالمعرّفات والتغييرات لا بمحتوى الرسائل. وتتيح عملية منشورة للأشخاص طلب حذف بياناتهم."),
         ("{{E}}", "{{E}}")],
        [("**Change management and security review**", "**إدارة التغيير والمراجعة الأمنية**"),
         ("Changes to data structures are designed to be versioned and safely re-runnable. Automated checks run on changes to the core "
          "platform and the engine, including unit and browser tests, tests of access rules, and code scanning. Changes to production are "
          "designed to follow a documented approval step.",
          "صُمّمت التغييرات على هياكل البيانات لتكون مرقَّمة ويمكن إعادة تشغيلها بأمان. وتعمل فحوص آلية على تغييرات المنصة الأساسية "
          "والمحرك، منها اختبارات وحدة واختبارات متصفح، واختبارات لقواعد الوصول، وفحص للشيفرة. وصُمّمت التغييرات على الإنتاج لتمر "
          "بخطوة موافقة موثَّقة."),
         ("{{E}}", "{{E}}")],
    ], widths=[22, 62, 16], cls="compact long",
        caption=("Security areas, design objectives and the safeguards that can be traced to the project.",
                 "مجالات الأمان وأهدافها التصميمية وتدابير الحماية التي يمكن تتبّعها إلى المشروع.")),

    H2("Governance and continuous improvement", "الحوكمة والتحسين المستمر"),
    UL(("Security is considered during development as an internal practice. It is not an independent assessment.",
        "يُراعى الأمان أثناء التطوير بوصفه ممارسة داخلية، وليس تقييمًا مستقلًا."),
       ("Security, privacy and operability are treated as part of every capability rather than as a separate phase. Mad3oom has not "
        "launched, and a controlled pilot is the intended first step.",
        "يُعامَل الأمان والخصوصية وقابلية التشغيل بوصفها جزءًا من كل إمكانية لا مرحلةً منفصلة. ولم تُطلَق مدعوم بعد، والبدء بتجربة "
        "تشغيلية محدودة هو الخطوة الأولى المقصودة."),
       ("No independent security assessment has taken place, and none is claimed.",
        "لم يجرِ تقييم أمني مستقل، ولا يُدَّعى أي تقييم."),
       ("Later editions of this paper will follow the same rule: describe only what can be substantiated.",
        "وستلتزم الإصدارات اللاحقة من هذه الورقة بالقاعدة نفسها: ألا يُوصف إلا ما يمكن إثباته.")),
])
