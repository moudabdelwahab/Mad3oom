from lib import *

CHAPTER = chapter(9, ("Security, Privacy and Governance", "الأمان والخصوصية والحوكمة"),
    ("A customer-support platform holds conversations, identities and operational history. This chapter lists the principles such a platform "
     "should follow, states which safeguards are implemented today, and names the gaps and future work. The principles are design requirements; "
     "they are not automatically verified features.",
     "تحتفظ منصة دعم العملاء بمحادثات وهويات وتاريخ تشغيلي. يسرد هذا الفصل المبادئ التي ينبغي أن تلتزم بها منصة كهذه، ويبيّن الضمانات "
     "المنفَّذة منها اليوم، ويسمّي الفجوات والأعمال المستقبلية. والمبادئ متطلبات تصميمية، وليست ميزات متحقَّقًا منها تلقائيًا."),
    [
    NOTE("Mad3oom makes no claim of compliance with, or certification against, GDPR, ISO 27001, SOC 2 or any other standard, because none has "
         "been independently assessed. No independent penetration test is documented in the repositories. This chapter also omits credentials, "
         "tokens, customer data and any detail that could help an attacker.",
         "لا تدّعي مدعوم الامتثال لـ GDPR أو ISO 27001 أو SOC 2 أو أي معيار آخر، ولا الحصول على شهادة وفقه، لأن شيئًا من ذلك لم يخضع "
         "لتقييم مستقل. ولا يُوثَّق في المستودعات أي اختبار اختراق مستقل. ويخلو هذا الفصل كذلك من بيانات الاعتماد والرموز وبيانات العملاء "
         "وأي تفصيل قد يفيد مهاجمًا.",
         kind="limit", title=("Compliance statement", "بيان الامتثال")),

    H2("Principles, safeguards and gaps", "المبادئ والضمانات والفجوات"),
    P("For each principle the table separates what is implemented today in the repositories from the gaps and the work that follows. "
      "“Implemented” means present in the code and covered by tests where noted. It does not mean externally audited.",
      "يفصل الجدول لكل مبدأ بين ما هو منفَّذ اليوم في المستودعات وبين الفجوات والأعمال اللاحقة. و«منفَّذ» تعني موجودًا في الشيفرة "
      "ومغطًّى باختبارات حيث يُذكر ذلك، ولا تعني خضوعه لتدقيق خارجي."),
    TABLE([("Principle", "المبدأ"), ("Implemented today", "المنفَّذ اليوم"), ("Gaps and future work", "الفجوات والأعمال المستقبلية")], [
        [("**Authentication and authorization**", "**المصادقة والتفويض**"),
         ("Managed sign-in with several methods and an optional time-based second factor. Authorization rules live in the database: functions check the caller's identity, and page guards only control what is shown. {{E}}",
          "تسجيل دخول مُدار بعدة طرق، وعامل ثانٍ اختياري قائم على الوقت. وتعيش قواعد التفويض في قاعدة البيانات: فالدوال تفحص هوية المستدعي، ولا تتحكم حراسة الصفحات إلا فيما يُعرض. {{E}}"),
         ("Verify the second factor wherever sensitive data is reached, not only at sign-in; enable leaked-password checks; confirm bot protection on sign-in forms, whose integration exists in code but whose production configuration is not documented. {{R}}",
          "التحقق من العامل الثاني حيثما يُتوصَّل إلى بيانات حساسة وليس عند الدخول فقط؛ وتفعيل فحص كلمات المرور المسرَّبة؛ والتثبت من الحماية من الروبوتات في نماذج الدخول، فتكاملها موجود في الشيفرة لكن إعدادها في الإنتاج غير موثَّق. {{R}}")],
        [("**Role-based and least-privilege access**", "**الوصول القائم على الأدوار وأقل الصلاحيات**"),
         ("Separate authority domains for platform staff, company roles and the platform owner. Agents see assigned or team conversations and supervisors see all. In Relay, assigning work to others is an explicit grant. Newer tables have no direct access and are reached only through checked functions. {{E}}",
          "نطاقات سلطة منفصلة لطاقم المنصة وأدوار الشركات ومالك المنصة. يرى الوكلاء المحادثات المسندة إليهم أو إلى فريقهم، ويرى المشرفون الجميع. وفي Relay يكون إسناد العمل للآخرين منحة صريحة. والجداول الأحدث بلا وصول مباشر ولا يُتوصَّل إليها إلا عبر دوال مفحوصة. {{E}}"),
         ("Continue reviewing broadly executable database functions against least privilege. {{R}} Owner-only erase and privilege grants in Relay are written, not applied. {{D}}",
          "مواصلة مراجعة دوال قاعدة البيانات الواسعة التنفيذ وفق أقل الصلاحيات. {{R}} والمحو والمنح الخاصان بالمالك في Relay مكتوبان وغير مطبَّقين. {{D}}")],
        [("**Tenant and customer data isolation**", "**عزل بيانات المستأجرين والعملاء**"),
         ("Row-level security on tables, a restrictive account-active gate on newer ones, company relations, and an explicit workspace boundary in Relay. SQL tests exercise isolation, including concurrent sessions. {{E}}",
          "أمان على مستوى الصفوف في الجداول، وبوابة مقيِّدة لنشاط الحساب في الأحدث منها، وعلاقات الشركات، وحد صريح لمساحة العمل في Relay. وتختبر اختبارات SQL العزل، بما في ذلك الجلسات المتزامنة. {{E}}"),
         ("Some configuration, such as bot settings, webhooks and automation, is platform-wide rather than per tenant, and several products share one database. Per-tenant configuration and product separation are recommended. {{R}}",
          "بعض الإعدادات، كإعدادات الروبوت والويب هوك والأتمتة، عامة على مستوى المنصة لا لكل مستأجر، وتتشارك عدة منتجات قاعدة بيانات واحدة. ويوصى بإعدادات لكل مستأجر وبفصل المنتجات. {{R}}")],
        [("**Secure API access**", "**الوصول الآمن إلى الواجهات**"),
         ("OAuth tokens and API keys are stored hashed, and integration keys are shown once, at creation. OAuth 2.1 uses mandatory PKCE, scoped tokens, rotating refresh tokens and user revocation. Telegram webhooks are checked with a constant-time comparison and are refused if no secret is set; WhatsApp webhooks verify Meta's signature. Token use is rate-limited. {{E}}",
          "تُخزَّن رموز OAuth ومفاتيح API مجزَّأة، وتُعرض مفاتيح التكامل مرة واحدة عند إنشائها. ويستخدم OAuth 2.1 معيار PKCE إلزاميًا ورموزًا محدودة النطاق ورموز تجديد متغيّرة وسحبًا من المستخدم. وتُفحص ويب هوك تيليجرام بمقارنة بزمن ثابت وتُرفض إن لم يُضبط سر؛ وتتحقق ويب هوك واتساب من توقيع Meta. ويُحدَّد معدل استخدام الرموز. {{E}}"),
         ("Detect reuse of refresh tokens and make their rotation atomic before wider client release; make the inbound-mail webhook fail closed and replay-resistant. {{R}}",
          "اكتشاف إعادة استخدام رموز التجديد وجعل تدويرها ذريًا قبل إتاحة عملاء أوسع؛ وجعل ويب هوك البريد الوارد يُغلَق عند الإخفاق ويقاوم إعادة الإرسال. {{R}}")],
        [("**Secret management**", "**إدارة الأسرار**"),
         ("Secrets come from the environment, and a test fails if a token-shaped value is committed in the channel code. Integration tokens used by the WhatsApp request proxy are encrypted at rest. {{E}}",
          "تأتي الأسرار من البيئة، ويفشل اختبار إذا أُدرجت قيمة بشكل رمز في شيفرة القنوات. وتُشفَّر رموز التكامل التي يستخدمها وسيط طلبات واتساب عند التخزين. {{E}}"),
         ("Move any remaining legacy plain-text credential storage to encryption or a vault, and never return secrets to the browser. {{R}}",
          "نقل أي تخزين قديم متبقٍّ لبيانات الاعتماد بنص صريح إلى التشفير أو خزنة أسرار، وعدم إعادة الأسرار إلى المتصفح. {{R}}")],
        [("**Auditability of sensitive operations**", "**قابلية تدقيق العمليات الحساسة**"),
         ("Relay history is append-only, and a trigger rejects edits and deletions. Inbox actions are logged. Each paid SIE turn is traced with the decision's intent and outcome kept apart. {{E}}",
          "تاريخ Relay لا يُعدَّل ويرفض محفِّز أي تعديل أو حذف. وتُسجَّل إجراءات الصندوق. ويُتتبَّع كل دور مدفوع في SIE مع فصل نية القرار عن نتيجته. {{E}}"),
         ("Attribute automated actions to a dedicated system actor rather than to an administrator account. {{R}}",
          "نسبة الإجراءات الآلية إلى فاعل نظام مخصص بدل حساب مسؤول. {{R}}")],
        [("**Data minimization, retention and deletion**", "**تقليل البيانات والاحتفاظ والحذف**"),
         ("Relay stores only selected excerpts, hides them 365 days after closure, redacts them irreversibly with a daily job, and supports deletion requests. A scheduled job archives old tickets. A deletion-request process is published. {{E}}",
          "تخزّن Relay مقتطفات مختارة فقط، وتخفيها بعد 365 يومًا من الإغلاق، وتمحوها محوًا لا رجعة فيه بمهمة يومية، وتدعم طلبات الحذف. وتؤرشف مهمة مجدولة التذاكر القديمة. وتوجد عملية منشورة لطلبات الحذف. {{E}}"),
         ("Chat messages have no retention policy today, and retention for engine traces is not documented. Policies and automated deletion workflows are needed. {{P}}",
          "لا توجد سياسة احتفاظ للرسائل اليوم، ولا يوجد توثيق للاحتفاظ بآثار المحرك. والحاجة قائمة إلى سياسات وسير عمل حذف آلية. {{P}}")],
        [("**Protection of conversation content and customer information**", "**حماية محتوى المحادثات ومعلومات العملاء**"),
         ("Access rules decide who can read a conversation; Relay re-checks access to the original conversation on every excerpt read and fails closed. SIE's trust boundary treats customer text as untrusted data. Attachment paths are validated by a database trigger. {{E}}",
          "تحدّد قواعد الوصول من يقرأ المحادثة؛ وتعيد Relay فحص الوصول إلى المحادثة الأصلية عند كل قراءة لمقتطف وتُغلَق عند الشك. ويعامل حد الثقة في SIE نص العميل بوصفه بيانات غير موثوقة. ويتحقق محفِّز في قاعدة البيانات من مسارات المرفقات. {{E}}"),
         ("Add a content security policy and reduce reliance on manual escaping in the front end. {{R}}",
          "إضافة سياسة أمان للمحتوى وتقليل الاعتماد على الترميز اليدوي في الواجهة. {{R}}")],
    ], widths=[19, 44, 37], cls="compact long",
        caption=("Security principles against the implemented safeguards and the gaps.", "المبادئ الأمنية مقابل الضمانات المنفَّذة والفجوات.")),

    H2("Governance and assurance", "الحوكمة والتحقق"),
    H3("How change is governed", "كيف يُحكَم التغيير"),
    UL(("Database changes are numbered migrations, written to be re-run safely, with a rollback script for recent ones and an automatic check of the preconditions they rely on.",
        "تغييرات قاعدة البيانات ترحيلات مرقَّمة تُكتب لتُعاد بأمان، مع سكربت تراجع للأحدث منها وفحص آلي للشروط المسبقة التي تعتمد عليها."),
       ("Production changes are applied only after explicit approval from the platform owner, which the engineering notes record case by case. Merging code is not treated as approval to change production.",
        "لا تُطبَّق التغييرات على الإنتاج إلا بعد موافقة صريحة من مالك المنصة، وتسجّلها الملاحظات الهندسية حالةً بحالة. ولا يُعدّ دمج الشيفرة موافقة على تغيير الإنتاج."),
       ("Read-only verification precedes each application, and a daily drift check compares the repository's inventory with production.",
        "يسبق كل تطبيق تحقق بالقراءة فقط، ويقارن فحص يومي للانحراف جرد المستودع بالإنتاج."),
       ("Engine deployments pin an exact commit, and behavioral changes ship behind flags that default to current behavior.",
        "تثبّت عمليات نشر المحرك إصدارًا محددًا، وتُطرح التغييرات السلوكية خلف أعلام افتراضيها السلوك الحالي.")),
    H3("What assurance exists", "ما هو قائم من التحقق"),
    UL(("Internal engineering audits in September and October 2026 covered the platform, the nine SIE layers and the conversation core. Their findings drive the recommendations in this paper.",
        "غطّت تدقيقات هندسية داخلية في سبتمبر وأكتوبر 2026 المنصة وطبقات SIE التسع ونواة المحادثات. وتقود نتائجها التوصيات الواردة في هذه الورقة."),
       ("Automated checks include code scanning, SQL tests for access rules on a real Postgres, and browser tests.",
        "تشمل الفحوص الآلية فحص الشيفرة، واختبارات SQL لقواعد الوصول على Postgres حقيقية، واختبارات المتصفح."),
       ("There is no external penetration test, third-party certification or independent audit documented. None is claimed.",
        "لا يوجد اختبار اختراق خارجي أو شهادة طرف ثالث أو تدقيق مستقل موثَّق. ولا يُدَّعى أي منها.")),
])
