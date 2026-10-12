from lib import *

CHAPTER = chapter(12, ("Conclusion", "الخاتمة"),
    ("Mad3oom's mission is to make technical support more organized, more context-aware, more accountable and more intelligent.",
     "رسالة مدعوم أن يصبح الدعم الفني أكثر تنظيمًا، وأوعى بالسياق، وأقدر على المساءلة، وأكثر ذكاءً."),
    [
    P("This paper has described how the platform pursues that mission. It brings tickets, conversations, customer records and knowledge into one "
      "structured environment. Workspace lets agents work across several contexts without losing what they are doing. Relay keeps follow-up work "
      "attached to its evidence, its owner and its deadline. SIE, a layered and explainable engine, interprets what customers write and decides the "
      "next step from a closed set of actions.",
      "وصفت هذه الورقة كيف تسعى المنصة إلى هذه الرسالة. فهي تجمع التذاكر والمحادثات وسجلات العملاء والمعرفة في بيئة منظَّمة واحدة. "
      "ويتيح Workspace للوكلاء العمل عبر عدة سياقات دون أن يفقدوا ما يعملون عليه. وتُبقي Relay أعمال المتابعة مرتبطة بدليلها ومسؤولها وموعدها. "
      "ويفسّر SIE، وهو محرك متعدد الطبقات وقابل للتفسير، ما يكتبه العملاء، ويقرر الخطوة التالية من مجموعة إجراءات مغلقة."),
    P("What exists today is a foundation, not a finished product. The core support features, Workspace, the first parts of Relay and the SIE engine "
      "exist in code and are tested. Handovers, reminders, grounded answers, further channels and external APIs are still to come, and the platform has not "
      "launched. The paper has kept those two statements side by side, because a credible direction depends on being exact about the starting point.",
      "ما هو قائم اليوم أساس وليس منتجًا مكتملًا. فميزات الدعم الأساسية وWorkspace والأجزاء الأولى من Relay ومحرك SIE قائمة في الشيفرة "
      "ومختبَرة. أما التسليم والتذكيرات والإجابات المرتكزة على المعرفة والقنوات الإضافية والواجهات الخارجية فما زالت قادمة، والمنصة لم تُطلَق بعد. "
      "وقد أبقت الورقة هذين البيانين جنبًا إلى جنب، لأن الاتجاه الموثوق يتوقف على الدقة في وصف نقطة الانطلاق."),
    P("The direction is consistent. Structure comes first, then context, then accountability, then intelligence, each added in a controlled way. "
      "Internal reviews favor validating the design in a controlled pilot before open availability, and they set out hardening work in security and "
      "operability that should accompany every new capability. This paper reports no result that has not been measured, and later editions should hold "
      "to the same rule.",
      "الاتجاه متسق: البنية أولًا، ثم السياق، ثم المساءلة، ثم الذكاء، تُضاف كلٌّ منها بصورة منضبطة. وتفضّل المراجعات الداخلية التحقق من "
      "التصميم في تجربة تشغيلية محدودة قبل الإتاحة المفتوحة، وتحدّد أعمال تعزيز في الأمان وقابلية التشغيل ينبغي أن ترافق كل إمكانية جديدة. "
      "ولا تورد هذه الورقة نتيجة لم تُقَس، وينبغي أن تلتزم الإصدارات اللاحقة بالقاعدة نفسها."),
    P("No business outcome is guaranteed. What the platform can credibly offer is a disciplined architecture, honest reporting of its own status, "
      "and steady progress along the roadmap.",
      "ولا يُضمَن أي أثر تجاري. وما تستطيع المنصة أن تقدّمه بمصداقية هو معمارية منضبطة، وإفصاح أمين عن حالتها، وتقدّم ثابت على خارطة الطريق."),
])
