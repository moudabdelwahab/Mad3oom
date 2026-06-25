/* =========================================================
   data.js
   بيانات تجريبية (Mock Data) لمحاكاة عملاء منصة "مدعوم".
   استبدل دالة fetchCustomers / fetchCustomerTimeline لاحقًا
   باستدعاءات API حقيقية (fetch) بنفس الشكل (نفس المفاتيح)
   عشان باقي الكود (app.js) يفضل يعمل بدون أي تعديل.
   ========================================================= */

// قاعدة بيانات تجريبية للعملاء
const MOCK_CUSTOMERS = [
  {
    id: "c1",
    name: "أحمد السيد",
    phone: "+20 100 123 4567",
    email: "ahmed.sayed@example.com",
    plan: "paid", // free | paid
    tags: ["vip", "paid"],
    status: "open", // open | resolved
    lastAgent: { name: "سارة محمود", role: "أخصائية دعم", time: "اليوم 11:42 ص" }
  },
  {
    id: "c2",
    name: "منى عبد الرحمن",
    phone: "+20 111 987 6543",
    email: "mona.ar@example.com",
    plan: "free",
    tags: ["free"],
    status: "resolved",
    lastAgent: { name: "كريم عادل", role: "مهندس دعم فني", time: "أمس 04:15 م" }
  },
  {
    id: "c3",
    name: "محمد الجندي",
    phone: "+20 122 456 7890",
    email: "m.elgendy@example.com",
    plan: "paid",
    tags: ["paid", "atrisk"],
    status: "open",
    lastAgent: { name: "سارة محمود", role: "أخصائية دعم", time: "منذ 3 أيام" }
  },
  {
    id: "c4",
    name: "ياسمين فتحي",
    phone: "+20 155 222 3344",
    email: "yasmin.fathy@example.com",
    plan: "free",
    tags: ["free"],
    status: "resolved",
    lastAgent: { name: "عمر حسن", role: "مهندس دعم فني", time: "منذ أسبوع" }
  }
];

// كل تاريخ تفاعل (Timeline) لكل عميل — مرتب من الأحدث للأقدم
const MOCK_TIMELINE = {
  c1: [
    {
      type: "note",
      time: "اليوم 11:45 ص",
      agent: "سارة محمود",
      title: "ملاحظة داخلية",
      body: "العميل VIP، عنده مشروع توسعة WhatsApp API الأسبوع الجاي. أولوية عالية."
    },
    {
      type: "ticket",
      time: "اليوم 11:40 ص",
      agent: "سارة محمود",
      title: "تذكرة #4521 — مشكلة في ربط واتساب بالـCRM",
      body: "العميل أبلغ عن انقطاع تكامل واتساب مع نظام CRM الخاص بشركته بعد آخر تحديث.",
      status: "open"
    },
    {
      type: "whatsapp",
      time: "اليوم 11:32 ص",
      agent: "سارة محمود",
      title: "محادثة واتساب",
      body: "العميل: \"الرسائل بقت بتتأخر كتير من امبارح، ممكن تشوفوا المشكلة فين؟\""
    },
    {
      type: "message",
      time: "اليوم 10:50 ص",
      agent: "سارة محمود",
      title: "محادثة فورية (Live Chat)",
      body: "بدأ العميل محادثة جديدة عبر الشات الفوري بخصوص تأخر إرسال الرسائل."
    },
    {
      type: "note",
      time: "أمس 02:10 م",
      agent: "كريم عادل",
      title: "ملاحظة داخلية",
      body: "تم ترقية العميل للخطة المدفوعة. متابعة الإعداد الأولي لحساب WhatsApp Business."
    },
    {
      type: "ticket",
      time: "منذ 4 أيام",
      agent: "كريم عادل",
      title: "تذكرة #4488 — طلب تفعيل العلامة الخضراء",
      body: "طلب العميل بدء إجراءات توثيق حسابه للحصول على العلامة الخضراء من Meta.",
      status: "closed"
    },
    {
      type: "message",
      time: "منذ أسبوع",
      agent: "سارة محمود",
      title: "محادثة فورية (Live Chat)",
      body: "استفسار عام عن خطط الاشتراك والفرق بين واتساب العادي وCloud API."
    }
  ],

  c2: [
    {
      type: "ticket",
      time: "أمس 04:10 م",
      agent: "كريم عادل",
      title: "تذكرة #4502 — استفسار عن نظام النقاط",
      body: "العميلة استفسرت عن طريقة حساب نقاط البلاغات واستخدامها للحصول على خصومات.",
      status: "closed"
    },
    {
      type: "message",
      time: "أمس 04:02 م",
      agent: "كريم عادل",
      title: "محادثة فورية (Live Chat)",
      body: "بدأت محادثة في ساعات العمل الرسمية للاستفسار عن مزايا الخطة المجانية."
    },
    {
      type: "note",
      time: "منذ 5 أيام",
      agent: "عمر حسن",
      title: "ملاحظة داخلية",
      body: "عميلة جديدة على الخطة المجانية، مهتمة بالترقية مستقبلًا لو زاد حجم استخدامها."
    }
  ],

  c3: [
    {
      type: "ticket",
      time: "منذ 3 أيام",
      agent: "سارة محمود",
      title: "تذكرة #4470 — تعطل البوت الآلي (Chatbot)",
      body: "ردود البوت الآلي توقفت عن الرد على استفسارات العملاء منذ صباح اليوم.",
      status: "open"
    },
    {
      type: "whatsapp",
      time: "منذ 3 أيام",
      agent: "سارة محمود",
      title: "محادثة واتساب",
      body: "العميل: \"البوت بتاعي مش بيرد على حد من الصبح، ده مؤثر على شغلي.\""
    },
    {
      type: "note",
      time: "منذ 3 أيام",
      agent: "سارة محمود",
      title: "ملاحظة داخلية",
      body: "تم تصعيد المشكلة للفريق التقني (إعادة تشغيل خدمة الأتمتة). العميل متضرر تجاريًا، يحتاج متابعة مستمرة حتى الحل."
    },
    {
      type: "message",
      time: "منذ أسبوعين",
      agent: "عمر حسن",
      title: "محادثة فورية (Live Chat)",
      body: "استفسار عن كيفية بناء تدفقات عمل (Workflows) جديدة للبوت الآلي."
    }
  ],

  c4: [
    {
      type: "ticket",
      time: "منذ أسبوع",
      agent: "عمر حسن",
      title: "تذكرة #4391 — مشكلة تسجيل الدخول",
      body: "العميلة لم تتمكن من الدخول لحسابها بعد محاولة تغيير كلمة المرور.",
      status: "closed"
    },
    {
      type: "message",
      time: "منذ أسبوع",
      agent: "عمر حسن",
      title: "محادثة فورية (Live Chat)",
      body: "تم إرسال رابط إعادة تعيين كلمة المرور وتأكيد نجاح تسجيل الدخول."
    },
    {
      type: "note",
      time: "منذ أسبوعين",
      agent: "كريم عادل",
      title: "ملاحظة داخلية",
      body: "عميلة هادئة، تتفاعل بسرعة مع التعليمات. لا تحتاج متابعة خاصة."
    }
  ]
};

/* ---------------------------------------------------------
   "واجهات API" مبدئية تحاكي async fetch — لتسهيل الاستبدال
   لاحقًا بطلبات حقيقية لباك إند مدعوم بدون تغيير app.js
   --------------------------------------------------------- */

function fetchCustomers() {
  return Promise.resolve(MOCK_CUSTOMERS);
}

function fetchCustomerTimeline(customerId) {
  const items = MOCK_TIMELINE[customerId] || [];
  return Promise.resolve(items);
}

function saveInternalNote(customerId, noteBody) {
  if (!MOCK_TIMELINE[customerId]) MOCK_TIMELINE[customerId] = [];
  const newNote = {
    type: "note",
    time: "الآن",
    agent: "أنت", // المستخدم الحالي (موظف الدعم)
    title: "ملاحظة داخلية",
    body: noteBody
  };
  MOCK_TIMELINE[customerId].unshift(newNote);
  return Promise.resolve(newNote);
}
