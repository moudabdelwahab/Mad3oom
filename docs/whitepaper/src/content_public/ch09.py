from lib import *

CHAPTER = chapter(9, ("Security, Privacy and Governance", "الأمان والخصوصية والحوكمة"),
    ("A customer-support platform holds conversations, identities and operational history. This chapter describes the principles Mad3oom follows "
     "to protect that information, the safeguards that can be traced to its code and engineering records, and how security is governed. "
     "It states design intent and practice. It does not describe any control as complete or independently verified.",
     "تحتفظ منصة دعم العملاء بمحادثات وهويات وتاريخ تشغيلي. يصف هذا الفصل المبادئ التي تلتزم بها مدعوم لحماية هذه المعلومات، "
     "والضمانات التي يمكن تتبّعها إلى شيفرة المنصة وسجلاتها الهندسية، وكيفية حوكمة الأمان. وهو يعرض النية التصميمية والممارسة، "
     "ولا يصف أي ضابط بأنه مكتمل أو متحقَّق منه باستقلال."),
    [
    NOTE("Mad3oom makes no claim of compliance with, or certification against, GDPR, ISO 27001, SOC 2 or any other standard, because none has "
         "been independently assessed. No independent penetration test or third-party security audit is documented. The descriptions in this "
         "chapter are design objectives and safeguards that can be traced to the product's code and engineering records. They are not guarantees, "
         "and they do not mean that every control has been independently verified. The chapter deliberately omits credentials, customer data "
         "and implementation detail that could help an attacker.",
         "لا تدّعي مدعوم الامتثال لـ GDPR أو ISO 27001 أو SOC 2 أو أي معيار آخر، ولا الحصول على شهادة وفقه، لأن شيئًا من ذلك لم يخضع "
         "لتقييم مستقل. ولا يوجد اختبار اختراق مستقل ولا تدقيق أمني من طرف ثالث موثَّق. والأوصاف الواردة في هذا الفصل أهداف تصميمية وضمانات "
         "يمكن تتبّعها إلى شيفرة المنتج وسجلاته الهندسية؛ وهي ليست ضمانات مطلقة، ولا تعني أن كل ضابط قد جرى التحقق منه باستقلال. "
         "ويخلو هذا الفصل عمدًا من بيانات الاعتماد وبيانات العملاء وأي تفصيل تنفيذي قد يفيد مهاجمًا.",
         kind="limit", title=("Compliance and assurance statement", "بيان الامتثال والتحقق")),

    H2("Security by design", "الأمان بالتصميم"),
    P("Mad3oom treats security as part of the architecture rather than as a layer added at the end. Four principles guide design decisions "
      "across the platform, Workspace, Relay and SIE.",
      "تتعامل مدعوم مع الأمان بوصفه جزءًا من المعمارية لا طبقةً تُضاف في النهاية. وتهتدي قرارات التصميم في المنصة وWorkspace وRelay وSIE "
      "بأربعة مبادئ."),
    UL(("**Decide access close to the data.** Access rules are designed to live in the database, next to the records they protect, so that the "
        "interface is never the only place where access is decided.",
        "**تُقرَّر الصلاحية قرب البيانات.** صُمِّمت قواعد الوصول لتقيم في قاعدة البيانات إلى جوار السجلات التي تحميها، فلا تكون الواجهة "
        "المكان الوحيد الذي يُقرَّر فيه الوصول."),
       ("**Grant the least privilege needed.** Roles, teams and explicit permissions limit what each person and each component can do.",
        "**أقل صلاحية لازمة.** تحدّ الأدوار والفرق والأذونات الصريحة مما يستطيع كل شخص وكل مكوّن فعله."),
       ("**Treat input as untrusted.** Customer text and requests that arrive from outside the platform are handled as data to be checked, "
        "not as instructions to be followed.",
        "**المُدخَل غير موثوق.** يُعامَل نص العميل والطلبات الواردة من خارج المنصة بوصفها بيانات تُفحص، لا تعليمات تُتَّبع."),
       ("**Keep only what is needed, for as long as it is needed.** Features copy as little customer content as they can and define how it is retired.",
        "**الاحتفاظ بالقدر اللازم وللمدة اللازمة فقط.** تنسخ الميزات أقل قدر ممكن من محتوى العميل وتحدّد كيف يُتخلَّص منه.")),

    H2("Safeguards and how they are substantiated", "الضمانات وكيف يُستدَل عليها"),
    P("For each area, the table gives the design objective and the safeguards that can be traced to the project's code, automated tests and "
      "engineering records. “Existing” means present in that code and covered by tests where noted. It does not mean externally audited, and it "
      "does not mean that every case is covered.",
      "يعرض الجدول لكل مجال الهدف التصميمي والضمانات التي يمكن تتبّعها إلى شيفرة المشروع واختباراته الآلية وسجلاته الهندسية. و«قائم» "
      "تعني موجودًا في تلك الشيفرة ومغطًّى باختبارات حيث يُذكر ذلك، ولا تعني خضوعه لتدقيق خارجي ولا أن كل الحالات مغطاة."),
    TABLE([("Area", "المجال"), ("Design objective and safeguards", "الهدف التصميمي والضمانات"), ("Stage", "المرحلة")], [
        [("**Authentication and authorization**", "**المصادقة والتفويض**"),
         ("Sign-in and account sessions are handled by a managed authentication service, with several sign-in methods and an optional second factor. "
          "Authorization is an architectural responsibility, not a property of individual pages: decisions about who may read or change a record "
          "are designed to be taken in the database layer, using the caller's identity.",
          "تتولى خدمة مصادقة مُدارة تسجيل الدخول وجلسات الحسابات، مع عدة طرق للدخول وعامل ثانٍ اختياري. والتفويض مسؤولية معمارية "
          "وليس خاصية في الصفحات: فالقرارات بشأن من يقرأ السجل أو يغيّره مصمَّمة لتُتَّخذ في طبقة قاعدة البيانات اعتمادًا على هوية المستدعي."),
         ("{{E}}", "{{E}}")],
        [("**Least privilege and controlled permissions**", "**أقل الصلاحيات والأذونات المنضبطة**"),
         ("Platform staff, company roles and platform ownership are separate authority domains. Support agents work with the conversations "
          "assigned to them or to their team, and supervisors have a wider view. In Relay, giving work to another person is an explicit "
          "permission, not a default.",
          "طاقم المنصة وأدوار الشركات ومالك المنصة نطاقات سلطة منفصلة. ويعمل وكلاء الدعم على المحادثات المسندة إليهم أو إلى فريقهم، "
          "وللمشرفين رؤية أوسع. وفي Relay يكون إسناد العمل إلى شخص آخر إذنًا صريحًا لا وضعًا افتراضيًا."),
         ("{{E}}", "{{E}}")],
        [("**Protection of conversations and sensitive information**", "**حماية المحادثات والمعلومات الحساسة**"),
         ("Access to a conversation determines who can see anything derived from it. Relay re-checks access to the original conversation each time a "
          "saved excerpt is shown, and withholds the excerpt if the check cannot be completed. Relay asks for explicit confirmation before saving "
          "content that looks like a card number, a one-time code, a password or a national identifier. SIE treats customer text as untrusted data.",
          "يحدّد الوصول إلى المحادثة من يرى أي شيء مشتق منها. وتعيد Relay فحص الوصول إلى المحادثة الأصلية عند كل عرض لمقتطف محفوظ، "
          "وتحجب المقتطف إن تعذّر إتمام الفحص. وتطلب Relay تأكيدًا صريحًا قبل حفظ محتوى يشبه رقم بطاقة أو رمزًا لمرة واحدة أو كلمة مرور "
          "أو رقمًا قوميًا. ويعامل SIE نص العميل بوصفه بيانات غير موثوقة."),
         ("{{E}}", "{{E}}")],
        [("**Secure integrations and credential protection**", "**التكاملات الآمنة وحماية بيانات الاعتماد**"),
         ("Integrations use open standards: OAuth 2.1 with PKCE for application access, scoped tokens, and a page where users revoke connected "
          "applications. Integration keys are shown once, when they are created, and can be rotated or revoked. Issued tokens and integration "
          "keys are stored as one-way hashes. Secrets are supplied by the deployment environment rather than written into code, and an "
          "automated test checks that token-shaped values are not committed in the channel code. Each messaging adapter is responsible for "
          "verifying requests from its provider.",
          "تعتمد التكاملات معايير مفتوحة: OAuth 2.1 مع PKCE لوصول التطبيقات، ورموزًا محدودة النطاق، وصفحة يسحب منها المستخدمون صلاحية "
          "التطبيقات المتصلة. وتُعرض مفاتيح التكامل مرة واحدة عند إنشائها، ويمكن تدويرها أو إبطالها. وتُخزَّن الرموز ومفاتيح التكامل "
          "الصادرة مجزَّأة بدالة اتجاه واحد. وتُوفَّر الأسرار من بيئة التشغيل بدل كتابتها في الشيفرة، ويتحقق اختبار آلي من أن قيمًا بشكل "
          "رموز لا تُدرج في شيفرة القنوات. ويتولى كل محوِّل مراسلة مسؤولية التحقق من الطلبات الواردة من مزوّده."),
         ("{{E}}", "{{E}}")],
        [("**Data minimization, retention and deletion**", "**تقليل البيانات والاحتفاظ والحذف**"),
         ("Relay stores only the excerpts that a user selects, hides them a defined period after a record closes and then redacts them "
          "irreversibly. Its history keeps identifiers and changes rather than message content. A published process lets people ask for their "
          "data to be deleted. Broader data-lifecycle controls are part of the roadmap ({{ch11}}).",
          "تخزّن Relay المقتطفات التي يحدّدها المستخدم فقط، وتخفيها بعد مدة محددة من إغلاق السجل ثم تمحوها محوًا لا رجعة فيه. ويحتفظ "
          "سجلها التاريخي بالمعرّفات والتغييرات لا بمحتوى الرسائل. وتتيح عملية منشورة للأشخاص طلب حذف بياناتهم. وضوابط أوسع لدورة "
          "حياة البيانات جزء من خارطة الطريق ({{ch11}})."),
         ("{{E}} {{P}}", "{{E}} {{P}}")],
        [("**Change management and security review**", "**إدارة التغيير والمراجعة الأمنية**"),
         ("Database changes are versioned migrations written to be re-run safely, with rollback scripts for recent changes. Automated checks run on "
          "changes: unit and browser tests, database tests of access rules on a real Postgres instance, a comparison of the repository against "
          "production, and code scanning. Changes to production are applied only after explicit approval from the platform owner and after "
          "read-only verification.",
          "تغييرات قاعدة البيانات ترحيلات مرقَّمة تُكتب لتُعاد بأمان، مع سكربتات تراجع للتغييرات الأحدث. وتعمل فحوص آلية على التغييرات: "
          "اختبارات وحدة واختبارات متصفح، واختبارات لقواعد الوصول على Postgres حقيقية، ومقارنة بين المستودع والإنتاج، وفحص للشيفرة. "
          "ولا تُطبَّق التغييرات على الإنتاج إلا بعد موافقة صريحة من مالك المنصة وبعد تحقق بالقراءة فقط."),
         ("{{E}}", "{{E}}")],
    ], widths=[22, 62, 16], cls="compact long",
        caption=("Security areas, design objectives and the safeguards that can be traced to the project.",
                 "مجالات الأمان وأهدافها التصميمية والضمانات التي يمكن تتبّعها إلى المشروع.")),

    H2("Governance and continuous improvement", "الحوكمة والتحسين المستمر"),
    UL(("Internal engineering reviews take place during development and inform priorities. They are an internal quality practice, not an "
        "independent assessment.",
        "تجري مراجعات هندسية داخلية أثناء التطوير وتسهم في تحديد الأولويات. وهي ممارسة جودة داخلية، وليست تقييمًا مستقلًا."),
       ("Security, privacy and operability hardening is tracked as part of the product work and is a condition of general availability. "
        "Mad3oom has not launched, and a controlled pilot is the intended first step.",
        "يُتابَع تعزيز الأمان والخصوصية وقابلية التشغيل بوصفه جزءًا من العمل على المنتج، وهو شرط للإتاحة العامة. ولم تُطلَق مدعوم بعد، "
        "والبدء بتجربة تشغيلية محدودة هو الخطوة الأولى المقصودة."),
       ("No independent security assessment has taken place, and none is claimed.",
        "لم يجرِ تقييم أمني مستقل، ولا يُدَّعى أي تقييم."),
       ("Later editions of this paper will follow the same rule: describe only what can be substantiated.",
        "وستلتزم الإصدارات اللاحقة من هذه الورقة بالقاعدة نفسها: ألا يُوصف إلا ما يمكن إثباته.")),
])
