from lib import *

CHAPTER = chapter(9, ("Security, Privacy and Governance", "الأمان والخصوصية والحوكمة"),
    ("A customer-support platform holds conversations, identities and operational history. This chapter describes the principles Mad3oom follows "
     "to protect that information, the safeguards that can be traced to its code, tests and documented practice, and how security is governed. "
     "It states design intent and practice. It does not describe any control as complete or independently verified.",
     "تحتفظ منصة دعم العملاء بمحادثات وهويات وتاريخ تشغيلي. يصف هذا الفصل المبادئ التي تلتزم بها مدعوم لحماية هذه المعلومات، "
     "والضمانات التي يمكن تتبّعها إلى شيفرتها واختباراتها وممارساتها الموثَّقة، وكيفية حوكمة الأمان. وهو يعرض النية التصميمية والممارسة، "
     "ولا يصف أي ضابط بأنه مكتمل أو متحقَّق منه باستقلال."),
    [
    NOTE("Mad3oom makes no claim of compliance with, or certification against, GDPR, ISO 27001, SOC 2 or any other standard, because none has "
         "been independently assessed. No independent penetration test or third-party security audit is documented. The descriptions in this "
         "chapter are design objectives and safeguards that can be traced to the product's code, tests and documented practice. They are not "
         "guarantees, and they do not mean that every control has been independently verified. For security reasons, the chapter does not publish "
         "credentials, customer data or implementation detail.",
         "لا تدّعي مدعوم الامتثال لـ GDPR أو ISO 27001 أو SOC 2 أو أي معيار آخر، ولا الحصول على شهادة وفقه، لأن شيئًا من ذلك لم يخضع "
         "لتقييم مستقل. ولا يوجد اختبار اختراق مستقل ولا تدقيق أمني من طرف ثالث موثَّق. والأوصاف الواردة في هذا الفصل أهداف تصميمية وضمانات "
         "يمكن تتبّعها إلى شيفرة المنتج واختباراته وممارساته الموثَّقة؛ وهي ليست ضمانات مطلقة، ولا تعني أن كل ضابط قد جرى التحقق منه "
         "باستقلال. ولدواعٍ أمنية، لا ينشر هذا الفصل بيانات اعتماد ولا بيانات عملاء ولا تفاصيل تنفيذية.",
         kind="limit", title=("Compliance and assurance statement", "بيان الامتثال والتحقق")),

    H2("Security by design", "الأمان بالتصميم"),
    P("Mad3oom treats security as part of the architecture rather than as a layer added at the end. Four principles guide design decisions "
      "across the platform, Workspace, Relay and SIE.",
      "تتعامل مدعوم مع الأمان بوصفه جزءًا من المعمارية لا طبقةً تُضاف في النهاية. وتهتدي قرارات التصميم في المنصة وWorkspace وRelay وSIE "
      "بأربعة مبادئ."),
    UL(("**Decide access close to the data.** Access rules belong in the database, next to the records they protect, so that the interface "
        "is not the only place where access is decided.",
        "**تُقرَّر الصلاحية قرب البيانات.** موضع قواعد الوصول قاعدة البيانات، إلى جوار السجلات التي تحميها، فلا تكون الواجهة المكان الوحيد "
        "الذي يُقرَّر فيه الوصول."),
       ("**Grant the least privilege needed.** Use roles, teams and explicit permissions to limit what each person and each component can do.",
        "**أقل صلاحية لازمة.** تُستخدم الأدوار والفرق والأذونات الصريحة للحدّ مما يستطيع كل شخص وكل مكوّن فعله."),
       ("**Treat input as untrusted.** Handle customer text and requests that arrive from outside the platform as data to be checked, "
        "not as instructions to be followed.",
        "**المُدخَل غير موثوق.** يُعامَل نص العميل والطلبات الواردة من خارج المنصة بوصفها بيانات تُفحص، لا تعليمات تُتَّبع."),
       ("**Keep only what is needed, for as long as it is needed.** Copy as little customer content as possible, and decide how long it is kept.",
        "**الاحتفاظ بالقدر اللازم وللمدة اللازمة فقط.** يُنسخ أقل قدر ممكن من محتوى العميل، وتُحدَّد مدة الاحتفاظ به.")),

    H2("Safeguards and how they are substantiated", "الضمانات وكيف يُستدَل عليها"),
    P("For each area, the table gives the design objective and the safeguards that can be traced to the project's code, automated tests and "
      "documented practice. “Existing” means present in that code and covered by tests where noted. It does not mean externally audited, and it "
      "does not mean that every case is covered.",
      "يعرض الجدول لكل مجال الهدف التصميمي والضمانات التي يمكن تتبّعها إلى شيفرة المشروع واختباراته الآلية وممارساته الموثَّقة. و«قائم» "
      "تعني موجودًا في تلك الشيفرة ومغطًّى باختبارات حيث يُذكر ذلك، ولا تعني خضوعه لتدقيق خارجي ولا أن كل الحالات مغطاة."),
    TABLE([("Area", "المجال"), ("Design objective and safeguards", "الهدف التصميمي والضمانات"), ("Stage", "المرحلة")], [
        [("**Authentication and authorization**", "**المصادقة والتفويض**"),
         ("Sign-in and account sessions are handled by a managed authentication service. Authorization is treated as an architectural "
          "responsibility rather than a property of individual pages: access rules are designed to be enforced in the database layer, using "
          "the caller's identity.",
          "تتولى خدمة مصادقة مُدارة تسجيل الدخول وجلسات الحسابات. ويُعامَل التفويض بوصفه مسؤولية معمارية لا خاصية في الصفحات: فقواعد "
          "الوصول مصمَّمة لتُفرض في طبقة قاعدة البيانات اعتمادًا على هوية المستدعي."),
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
          "access to the original conversation. Relay asks for explicit confirmation before saving content that appears to contain sensitive "
          "personal or payment data. SIE treats customer text as untrusted data.",
          "يحدّد الوصول إلى المحادثة من يرى أي شيء مشتق منها: فلا تعرض Relay المقتطف المحفوظ إلا لمن ما زال له حق الوصول إلى المحادثة "
          "الأصلية. وتطلب Relay تأكيدًا صريحًا قبل حفظ محتوى يبدو أنه يتضمن بيانات شخصية أو مالية حساسة. ويعامل SIE نص العميل بوصفه "
          "بيانات غير موثوقة."),
         ("{{E}}", "{{E}}")],
        [("**Secure integrations and credential protection**", "**التكاملات الآمنة وحماية بيانات الاعتماد**"),
         ("Integrations use open standards: OAuth 2.1 with PKCE for application access, scoped tokens, and a page where users revoke connected "
          "applications. Integration keys are shown once, when they are created, and can be revoked. Secrets are supplied by the deployment "
          "environment rather than written into the code. Verifying requests from a messaging provider is one of the duties of that "
          "provider's adapter.",
          "تعتمد التكاملات معايير مفتوحة: OAuth 2.1 مع PKCE لوصول التطبيقات، ورموزًا محدودة النطاق، وصفحة يسحب منها المستخدمون صلاحية "
          "التطبيقات المتصلة. وتُعرض مفاتيح التكامل مرة واحدة عند إنشائها، ويمكن إبطالها. وتُوفَّر الأسرار من بيئة التشغيل بدل كتابتها في "
          "الشيفرة. والتحقق من الطلبات الواردة من مزوّد المراسلة من مهام المحوِّل الخاص بذلك المزوّد."),
         ("{{E}}", "{{E}}")],
        [("**Data minimization, retention and deletion**", "**تقليل البيانات والاحتفاظ والحذف**"),
         ("Relay stores only the excerpts that a user selects, hides them a defined period after a record closes and then redacts them "
          "irreversibly; its history keeps identifiers and changes rather than message content. A published process lets people ask for "
          "their data to be deleted.",
          "تخزّن Relay المقتطفات التي يحدّدها المستخدم فقط، وتخفيها بعد مدة محددة من إغلاق السجل ثم تمحوها محوًا لا رجعة فيه؛ ويحتفظ "
          "سجلها التاريخي بالمعرّفات والتغييرات لا بمحتوى الرسائل. وتتيح عملية منشورة للأشخاص طلب حذف بياناتهم."),
         ("{{E}}", "{{E}}")],
        [("**Change management and security review**", "**إدارة التغيير والمراجعة الأمنية**"),
         ("Database changes are versioned migrations written to be re-run safely, with rollback scripts for recent changes. Automated checks run "
          "on changes: unit and browser tests, database tests of access rules on a real Postgres instance, and code scanning. Changes to "
          "production follow an explicit approval step.",
          "تغييرات قاعدة البيانات ترحيلات مرقَّمة تُكتب لتُعاد بأمان، مع سكربتات تراجع للتغييرات الأحدث. وتعمل فحوص آلية على التغييرات: "
          "اختبارات وحدة واختبارات متصفح، واختبارات لقواعد الوصول على Postgres حقيقية، وفحص للشيفرة. وتمر التغييرات على الإنتاج بخطوة "
          "موافقة صريحة."),
         ("{{E}}", "{{E}}")],
    ], widths=[22, 62, 16], cls="compact long",
        caption=("Security areas, design objectives and the safeguards that can be traced to the project.",
                 "مجالات الأمان وأهدافها التصميمية والضمانات التي يمكن تتبّعها إلى المشروع.")),

    H2("Governance and continuous improvement", "الحوكمة والتحسين المستمر"),
    UL(("Engineering and security reviews are part of development and inform priorities. They are an internal practice, not an "
        "independent assessment.",
        "المراجعات الهندسية والأمنية جزء من التطوير وتسهم في تحديد الأولويات. وهي ممارسة داخلية، وليست تقييمًا مستقلًا."),
       ("Security, privacy and operability are treated as part of every capability rather than as a separate phase. Mad3oom has not "
        "launched, and a controlled pilot is the intended first step.",
        "يُعامَل الأمان والخصوصية وقابلية التشغيل بوصفها جزءًا من كل إمكانية لا مرحلةً منفصلة. ولم تُطلَق مدعوم بعد، والبدء بتجربة "
        "تشغيلية محدودة هو الخطوة الأولى المقصودة."),
       ("No independent security assessment has taken place, and none is claimed.",
        "لم يجرِ تقييم أمني مستقل، ولا يُدَّعى أي تقييم."),
       ("Later editions of this paper will follow the same rule: describe only what can be substantiated.",
        "وستلتزم الإصدارات اللاحقة من هذه الورقة بالقاعدة نفسها: ألا يُوصف إلا ما يمكن إثباته.")),
])
