# تدقيق تجربة العميل ومصادر محتوى قاعدة المعرفة

وثيقة **داخلية**. مش موجّهة للعميل، ومش مرتبطة من أي صفحة عامة.

الغرض منها إن كل معلومة في `knowledgebase.html` يكون ورا كل جملة فيها
مرجع في الكود يمكن الرجوع له والتحقق منه. القاعدة الحاكمة:
**لا دليل = لا ادعاء.**

- **الملف المحدَّث:** `knowledgebase.html` (صفحة قاعدة المعرفة العامة).
- **تاريخ التدقيق:** 2026-09-20.
- **النطاق:** الوظائف المتاحة للعميل فقط. أي شيء يخص `admin/` أو
  `owner-*` أو رتب `admin/support/platform_owner` مستبعد بالكامل.

---

## 1) ملخص التدقيق (Audit Summary)

### 1.1 اللوحات المتاحة للعميل

| اللوحة | المسار | متى يصل لها العميل |
|---|---|---|
| بوابة العميل | `customer-dashboard.html` | الوجهة الافتراضية بعد الدخول لحساب بدون شركة |
| لوحة الشركة | `/company-dashboard/` | الوجهة بعد الدخول لحساب مرتبط بشركة |
| مركز المساعدة | `knowledge-base.html` | من القائمة الجانبية |
| المحادثة الفورية | `chat-customer.html` | من القائمة الجانبية |
| قاعدة المعرفة العامة | `knowledgebase.html` | صفحة عامة |

قرار الوجهة بعد الدخول في `assets/js/account-destination.js`
(`accountHomeFor` / `resolveAccountHome`): `platform_owner` →
`owner-contexts.html`، رتب الطاقم → لوحة الإدارة، `hasCompany` →
`/company-dashboard/`، غير ذلك → `customer-dashboard.html`.

### 1.2 أقسام بوابة العميل

من `assets/components/customer-sidebar.html` و`customer-dashboard.html`:

نظرة عامة · مركز الدعم · تذاكري · الإشعارات · مركز المساعدة (صفحة) ·
المحادثة الفورية (صفحة) · الاستهلاك والحدود · لوحة الشركة (مخفي حتى
`hasCompany()`) · الباقات والاشتراك (صفحة) · نشاط الحساب · الأمان ·
الملف الشخصي · المكافآت والنقاط · الشارات · مجتمع مدعوم (صفحة) ·
خارطة الطريق (صفحة) · واتساب (مخفي حتى وجود اشتراك فعّال أو
`profiles.whatsapp_enabled`، عبر `assets/js/sidebar-subscription-handler.js`).

### 1.3 أقسام لوحة الشركة

من `assets/components/company-sidebar.html` و`company-dashboard/index.html`
وثابت `SECTIONS` في `assets/js/company/company-dashboard.js`:

`overview` · `members` · `subscriptions` · `tickets` · `customerTickets` ·
`support` · `notifications` · `api` · `reports` · `activity` · `profile` ·
`security`. كلها أقسام داخل نفس الصفحة (روابط hash)، ولا يوجد رابط خارج
اللوحة إلى بوابة العميل.

### 1.4 حالات التذكرة

مصدر واحد: `assets/js/customer/ticket-view-model.js` → `TICKET_STATUS`.

| القيمة | التسمية المعروضة | مغلقة؟ |
|---|---|---|
| `open` | مفتوحة | لا |
| `in-progress` | قيد المعالجة | لا |
| `resolved` | تم الحل | نعم |
| `confirmed` | مكتملة | نعم |
| `rejected` | مرفوضة | نعم |

ومجموعات العرض (`TICKET_VIEWS`): كل التذاكر / مفتوحة / بانتظار ردّك /
مغلقة. لا توجد في النظام حالات `pending` أو `on-hold` أو `escalated` أو
`reopened` — ولم تُذكر في المحتوى.

### 1.5 دورة حياة التذكرة (كما هي فعلًا)

1. `createTicket()` في `tickets-service.js:131` — يكتب `status: 'open'`
   ويرفض عنوانًا أو وصفًا فارغًا، ويجبر الأولوية على `medium` لو القيمة
   غير صالحة.
2. إشعار الإنشاء يذهب **للأدمن فقط** (`tickets-service.js:166-177`).
3. `addTicketReply()` (`tickets-service.js:529`):
   - ينشئ إشعارًا للطرف المقابل: «رد جديد على تذكرتك #…» للعميل حين
     يكون الرادّ غير صاحب التذكرة.
   - ينقل الحالة `open → in-progress` **فقط** حين
     `ticket.user_id !== user.id` (أي ردّ الطاقم)، وبشرط
     `autoTransition` (`tickets-service.js:605-628`).
   - رد العميل على تذكرته **لا يغيّر الحالة إطلاقًا**.
4. `track_first_response()` (ترحيل 034) يكتب `first_response_at` عند أول
   ردّ غير داخلي من غير صاحب التذكرة.
5. `reopen_ticket_in_my_scope()` (ترحيل 034): `resolved → open` فقط،
   ويزيد `reopen_count` ويصفّر `resolved_at`.
6. `close_ticket_in_my_scope()` (ترحيل 034): `open|in-progress →
   resolved` ويكتب `resolved_at`.
7. ترحيل 034 **حذف** المحفّز `trg_reopen_ticket_on_owner_reply`، فالردّ
   لم يعد يعيد الفتح تلقائيًا (كان سلوك ترحيل 012).

### 1.6 آلية SLA

- الإعداد: `advanced_settings.sla_config` بمفاتيح
  `enabled / high_hours / medium_hours / low_hours`، يقرأها العميل عبر
  `get_customer_platform_settings()` (ترحيل 010) ثم
  `assets/js/customer/platform-settings.js` (`slaTargetHours`).
- **ما يُقاس: أول ردّ**، لا زمن الحل. الدليل: `slaFriendlyHint()` في
  `customer-dashboard.js:896` يخفي الشارة بمجرد وجود `first_response_at`،
  و`check_sla_breaches()` (ترحيل 035) يفحص `first_response_at IS NULL`.
- ما يراه العميل:
  - `customer-dashboard.js:901` → «تأخر الرد — الفريق يتابعها».
  - `customer-dashboard.js:907` → «الرد المتوقع …».
  - `customer-dashboard.js:1045-1046` → «هدف أول رد: …» و«أول رد وصل: …».
  - `renderSupportAvailability()` → صف «هدف أول رد» بشارة لكل أولوية.
- **تجاوز SLA لا يصل للعميل**: `check_sla_breaches()` يرسل رسائل تيليجرام
  إلى `platform_owner/admin/support` فقط. لذلك لم يُذكر أي تصعيد أو
  إشعار تجاوز في محتوى العميل.
- حالة خاصة موثّقة: `whatsapp-subscription-service.js:101,301` — طلبات
  الدفع الخارجي تُكتب بهدف أول رد = ساعة واحدة.

### 1.7 واتساب

| السلوك | موجود؟ | الدليل |
|---|---|---|
| زر «متابعة على الواتساب» داخل التذكرة | نعم | `customer-dashboard.js:1218-1233` — يبني نص فيه الرقم والعنوان والحالة وتاريخ الإنشاء والوصف ويفتح `wa.me` |
| ظهور الزر مشروط برقم واتساب من الإدارة | نعم | `cx.support_whatsapp` من `customer_experience` |
| رابط «تواصل مباشر» في «توفّر فريق الدعم» | نعم | `renderSupportAvailability()` |
| عنصر «واتساب» في القائمة الجانبية | نعم، مشروط | `assets/js/sidebar-subscription-handler.js` |
| طلب اشتراك واتساب يفتح تذكرة | نعم | `whatsapp-subscription-service.js:290-310` |
| إنشاء تذكرة تلقائيًا من رسالة واتساب واردة | **لا** | `supabase/functions/meta-webhook/index.ts` لا يلمس `tickets` إطلاقًا؛ ويكتب فقط في `whatsapp_templates` / `template_status_logs` (والرأس يوثّق أن الجدولين غير موجودَين) |
| ربط محادثة واتساب بسياق التذكرة | **لا** | لا يوجد أي مسار يكتب رسائل واتساب في `ticket_replies` |
| تحديث حالة التذكرة عبر واتساب | **لا** | لا يوجد |

### 1.8 قنوات ووظائف أخرى مرتبطة بالدعم

- **الإشعارات**: `notifications-service.js` +
  `assets/js/customer/notification-router.js` — عشرة تصنيفات، وتوجيه
  الإشعار إلى تذكرة بعينها أو قسم داخل اللوحة.
- **البريد**: `supabase/functions/send-ticket-email/index.ts` — قوالب
  `INSERT` / `UPDATE` / `REPLY` / `CUSTOM`، والمرسلون المسموح بهم
  `support@` و`no-reply@` و`info@mad3oom.online`.
- **حالة النظام**: `fetchSystemStatus` + `service-status-model.js`.
- **مركز المساعدة**: `assets/js/customer/help-data.js` +
  `help-center.js` — تصنيفات، بحث، الأكثر قراءة، مقالات ذات صلة،
  تقييم 👍/👎.

---

## 2) مصفوفة الأدلة (Evidence Matrix)

| الادعاء / الميزة | الدليل | للعميل؟ | الثقة |
|---|---|---|---|
| إنشاء تذكرة (عنوان + وصف + تصنيف + أهمية) | `customer-dashboard.html:578-618`, `customer-dashboard.js:2275-2325`, `tickets-service.js:131` | نعم | Confirmed |
| حد أدنى 5 أحرف للعنوان و15 للوصف | `customer-dashboard.js:2288-2296` | نعم | Confirmed |
| إنشاء تذكرة من لوحة الشركة (بدون أولوية/مرفقات) | `assets/js/company/company-support.js:41-73,117-124` | نعم | Confirmed |
| حد أدنى 3 أحرف للعنوان و10 للوصف في نموذج الشركة | `company-support.js:validateTicketForm` | نعم | Confirmed |
| المرفقات: 5 ملفات × 5MB، صور/PDF/txt/log/csv | `customer-dashboard.html:610-617`, `customer-dashboard.js:2249-2264` | نعم، مشروط بـ`allow_ticket_attachments` | Confirmed |
| لا رفع مرفقات مع الرد في واجهة العميل | لا يوجد `input[type=file]` في كتلة الرد (`customer-dashboard.js:1126-1140`) | — | Confirmed (نفي) |
| الحالات الخمس وتسمياتها | `ticket-view-model.js:TICKET_STATUS` | نعم | Confirmed |
| المجموعات الأربع وعدّادها | `ticket-view-model.js:TICKET_VIEWS`, `countByView` | نعم | Confirmed |
| «بانتظار ردّك» = آخر محدِّث ليس العميل والتذكرة مفتوحة | `ticket-view-model.js:needsCustomerReply` | نعم | Confirmed |
| الردّ لا يغيّر الحالة | ترحيل 034 §2 (حذف المحفّز) + تعليق `customer-dashboard.js:1266` | نعم | Confirmed |
| الردّ على تذكرة مغلقة مسموح ويُسجَّل | `availableActions.canReply: true` + نص التنبيه `customer-dashboard.js:1131` | نعم | Confirmed |
| «إعادة الفتح» من `resolved` فقط | `canReopen()` + `reopen_ticket_in_my_scope` (034) | نعم | Confirmed |
| `confirmed`/`rejected` لا تُعاد فتحها | شرط `v_status <> 'resolved'` في دالة الترحيل 034 | نعم (نفي) | Confirmed |
| «إغلاق التذكرة» من `open`/`in-progress` فقط | `canClose()` + `close_ticket_in_my_scope` (034) | نعم | Confirmed |
| عدّاد «أُعيد فتحها X مرة» | `customer-dashboard.js:1040` + `reopen_count` | نعم | Confirmed |
| `open → in-progress` عند ردّ الطاقم | `tickets-service.js:605-628` | نعم (أثر مرئي) | Confirmed |
| إشعار «رد جديد على تذكرتك» | `tickets-service.js:566-573` | نعم | Confirmed |
| إشعار «تحديث حالة التذكرة» | `tickets-service.js:272-283` | نعم | Confirmed |
| تصنيفات الإشعارات العشرة | `notification-router.js:NOTIFICATION_CATEGORIES` | نعم | Confirmed |
| «إخفاء من قائمتي» = أرشفة من جانب العميل | `tickets-service.js:497` + `fetchUserTickets` يستثني `archived_by_customer` | نعم | Confirmed |
| لا يوجد إلغاء للإخفاء في واجهة العميل | لا مسار يكتب `archived_by_customer = false` خارج الإدارة | — | Confirmed (نفي) |
| تقييم الخدمة 1–5 + تعليق عند `resolved` | `availableActions.canRate`, `customer-dashboard.js:1088-1108` | نعم، مشروط بـ`allow_ticket_rating` | Confirmed |
| الحد الأقصى للتذاكر المفتوحة يعطّل الإرسال | `customer-dashboard.js:2194-2218` | نعم، مشروط | Confirmed |
| منع التذاكر المكررة بنفس العنوان | `customer-dashboard.js:2299-2317` | نعم، مشروط | Confirmed |
| تنبيهات ما قبل الإرسال (عطل/خدمة متأثرة/تذكرة مشابهة) | `renderSelfHelp()` `customer-dashboard.js:2129-2182` | نعم | Confirmed |
| «تُؤرشف التذاكر تلقائياً بعد N يومًا» كنص في الواجهة | `updateTicketLimitHint()` `customer-dashboard.js:882-893` | نعم | Confirmed (كنص معروض) |
| SLA = هدف أول رد | `slaFriendlyHint`, `check_sla_breaches` (035) | نعم | Confirmed |
| شارة «الرد المتوقع …» / «تأخر الرد» | `customer-dashboard.js:896-908` | نعم | Confirmed |
| صف «هدف أول رد» بشارة لكل أولوية | `renderSupportAvailability()` + `slaTargetHours` | نعم، مشروط بـ`sla.enabled` | Confirmed |
| حالة الفريق «متاح الآن / خارج ساعات العمل» | `supportAvailability()` + `show_support_online_status` | نعم، مشروط | Confirmed |
| ساعات العمل من إعدادات الإدارة لا قيمة ثابتة | `working_hours` عبر ترحيل 010 | نعم | Confirmed |
| هدف ساعة واحدة لطلبات الدفع الخارجي | `whatsapp-subscription-service.js:101,301` | نعم | Confirmed |
| كل تذكرة يُكتب لها `sla_response_due_at` تلقائيًا | تعليق `whatsapp-subscription-service.js:296-299` يشير لمحفّز `set_ticket_sla()`؛ **تعريف المحفّز غير موجود في هذا المستودع** | نعم (الأثر) | Partially Confirmed → صيغت في المحتوى بشرط «لو التذكرة عليها هدف زمني» |
| تنبيه تجاوز SLA | `check_sla_breaches()` → تيليجرام للطاقم فقط | لا | Admin Only — لم يُذكر |
| `sla_resolution_due_at` (هدف زمن الحل) | يُقرأ في `assets/js/admin/tickets.js` فقط | لا | Admin Only — لم يُذكر |
| إيقاف/استئناف SLA، ساعات عمل تُجمِّد العدّاد | لا يوجد أي كود | — | Not Found — لم يُذكر |
| زر «متابعة على الواتساب» ومحتوى الرسالة | `customer-dashboard.js:1218-1233` | نعم، مشروط | Confirmed |
| تذكرة من رسالة واتساب واردة | لا دليل | لا | Not Found — ذُكر نفيه صراحة |
| رسائل واتساب تدخل سياق التذكرة | لا دليل | لا | Not Found — ذُكر نفيه صراحة |
| طلب الاشتراك ينشئ تذكرة | `whatsapp-subscription-service.js:290-310` | نعم | Confirmed |
| إثبات التحويل إلزامي للدفع الخارجي (صورة/PDF ≤ 8MB) | `whatsapp-subscription-service.js:95-140` | نعم | Confirmed |
| عنصر «واتساب» مشروط بالاشتراك/التفعيل | `sidebar-subscription-handler.js:20-43` | نعم | Confirmed |
| مسارا التذاكر في لوحة الشركة | `company-tickets.js:TICKET_STREAMS` | نعم | Confirmed |
| «تذاكر العملاء» بلا زر إنشاء وباسم العميل | `TICKET_STREAMS.customers.canCreate=false, showsCustomer=true` | نعم | Confirmed |
| دورا الشركة ووصفهما | `company-model.js:COMPANY_ROLE_LABELS` | نعم | Confirmed |
| إضافة مستخدم (اسم/بريد/كلمة مرور/تأكيد) | `company-dashboard/index.html:261-299`, `company-dashboard.js:onCreateMember` | نعم، مشروط بـ`can_manage` | Confirmed |
| نص تأكيد إزالة العضو | `company-dashboard.js:onRemoveMember` | نعم | Confirmed |
| بطاقات نظرة عامة الأربع | `company-dashboard.js:renderKpis` | نعم | Confirmed |
| حقول بيانات الشركة وتعديلها للمالك | `renderProfile()` + `editCompanyBtn` | نعم | Confirmed |
| حالات الاشتراك و«ملاحظات على التواريخ» | `subscription-model.js`, `anomalyPanel()` | نعم | Confirmed |
| «الخدمات المتاحة» مشتقّة من الاشتراكات | `renderEntitlements()` | نعم | Confirmed |
| قسم API: إنشاء مفتاح، الصلاحيات، 60 نداء/دقيقة | `company-api.js:139-200`, `api-token-modal.js` | نعم، مشروط بامتياز `api_tokens` | Confirmed |
| التقارير: المؤشرات والمرشحات والتصدير CSV/XLSX/PDF | `company-reports.js:62-190`, `report-model.js:summarizeTickets` | نعم | Confirmed |
| «متوسط أول استجابة» و«متوسط زمن الإغلاق» | `report-model.js:154-190` | نعم | Confirmed |
| مجموعات قسم النشاط | `company-activity.js:GROUP_LABELS` | نعم | Confirmed |
| الملف الشخصي/الأمان في لوحة الشركة | `company-account.js` | نعم | Confirmed |
| «البريد يُغيَّر عبر الدعم» | `company-account.js:99` | نعم | Confirmed |
| قواعد كلمة المرور (8 أحرف + كبير + صغير + رقم) | `company-account.js:validatePasswordForm` | نعم | Confirmed |
| بحث لوحة الشركة واختصار `/` | `company-sidebar.html` + `company-dashboard.js:120-129` | نعم | Confirmed |
| رصيد الواتساب وسجل آخر 5 حركات | `customer-dashboard.js:1668-1697` | نعم (قراءة فقط) | Confirmed |
| شحن الرصيد ذاتيًا من لوحة العميل | لا يوجد؛ النص يقول «تواصل مع الدعم للشحن» | لا | Not Found — وُثّق النص كما هو |
| مركز المساعدة: تصنيفات/بحث/الأكثر قراءة/تقييم المقال | `help-center.js`, `knowledge-base.html` | نعم | Confirmed |
| قوالب بريد التذاكر الثلاثة | `supabase/functions/send-ticket-email/index.ts:144-186` | نعم (كمُستقبِل) | Confirmed |
| إرسال البريد **تلقائيًا** عند كل حدث تذكرة | المنادون الوحيدون `admin/mailbox.js` و`admin/send-email.js`؛ لا محفّز في هذا المستودع ينادي الدالة | — | **Unverified** — أُزيل الادعاء القاطع |
| `tickets@mad3oom.online` كعنوان إشعارات | غير موجود في `ALLOWED_SENDERS`؛ يظهر كخيار في `admin/automation.html` فقط | لا | Not Found — أُزيل واستُبدل بـ`no-reply@` |
| ساعات دعم ثابتة 9ص–6م الأحد–الجمعة | لا يوجد؛ الساعات من `working_hours` | لا | Not Found — أُزيل |
| «الرد على تذكرة محلولة يعيد فتحها تلقائيًا» | ملغى صراحةً بترحيل 034 | لا | Not Found — أُزيل وصُحِّح |
| «رسالة تأكيد على بريدك مباشرة بعد الإرسال» | لا دليل على إرسال تلقائي | لا | Unverified — أُزيل |

---

## 3) ما صُحِّح في المحتوى القديم

| الادعاء القديم في `knowledgebase.html` | الحالة الفعلية | الإجراء |
|---|---|---|
| «بعد الإرسال هتوصلك رسالة تأكيد على بريدك مباشرة» | لا إرسال تلقائي مثبت | حُذف؛ ووُضِع مكانه ما يحدث فعلًا (فتح التذكرة + رسالة نجاح داخل اللوحة) |
| «تم الحل … اعمل رد على نفس التذكرة وهتترجع تلقائيًا» | الردّ لا يعيد الفتح (ترحيل 034) | صُحِّح: إعادة الفتح إجراء صريح بزرّ، ومن حالة `resolved` فقط |
| ثلاث حالات فقط (مفتوحة/قيد المعالجة/محلولة) | خمس حالات | أُضيفت «مكتملة» و«مرفوضة» بجدول كامل |
| «تقدر ترفق صورة … أو ضمن الرد» | لا رفع مع الرد في واجهة العميل | صُحِّح وحُدِّدت القيود الفعلية |
| ساعات دعم ثابتة 9ص–6م (الأحد–الجمعة) | من إعدادات الإدارة | صُحِّح للإحالة إلى «توفّر فريق الدعم» |
| «بيوصلك إيميل تلقائي في 3 حالات» | غير مثبت | أُعيدت الصياغة، وأُبرزت الإشعارات داخل المنصة كقناة مضمونة |
| `tickets@mad3oom.online` | غير مسموح به كمرسل | اسُتبدل بـ`no-reply@mad3oom.online` |
| «الإعداد كله من تبويب شبكة MCP في **لوحة الإدارة**» | إحالة العميل إلى لوحة الإدارة | حُذفت؛ وأُحيل العميل إلى `/mcp/mcp.html` (لوحة المطوّرين) كما تحيل `api-docs.html` |
| «تقدر تسجّل رابط Webhook خاص بيك لأحداث التذاكر» | Webhooks تُدار من `admin/settings.html` فقط؛ لا واجهة عميل (`assets/js/admin/settings.js:344`) | صُحِّح إلى نفي صريح مع البديل المتاح (مفاتيح API) |
| «من صفحة إدارة API تقدر تنشئ مفتاح» | `api-management.html` صفحة إدارية (ترجع إلى `chat-admin.html`)؛ مسار العميل هو لوحة الشركة ← API | صُحِّح بالمسار الحقيقي وحقول النافذة وشرط الامتياز |
| «تقدر تغيّر خطتك (ترقية أو **تخفيض**) في أي وقت» و«تقدر تلغي اشتراكك في أي وقت» | لا مسار عميل للتخفيض ولا لإلغاء اشتراك فعّال (`whatsapp-subscription-service.js` يعرف: جديد / تجديد / ترقية فقط؛ و`cancel_my_subscription_request` تراجُع داخلي عند فشل رفع الإثبات) | صُحِّح: ترقية وتجديد فقط، والباقي عبر تذكرة دعم |
| «بنقبل بطاقات الائتمان، التحويلات البنكية، والمحافظ الرقمية» | `PAYMENT_METHODS` = تحويل بنكي / محفظة كاش / إنستاباي / بوابة دفع داخلية | صُحِّح للقائمة الفعلية + شرط إثبات التحويل + مهلة الساعة |
| «النقاط تقدر تستبدلها بخصومات على الخطط» | لا مسار استبدال في `rewards-service.js` ولا في واجهة العميل | صُحِّح إلى نفي، مع الإبقاء على عرض الرصيد |
| «النطاق الفرعي بييجي مجانًا مع خطة الدعم الفني أو الباقة الشاملة» | ربط المزايا بالباقات في جدول `plan_features` خارج المستودع | صُحِّح إلى الإحالة إلى «الخدمات المتاحة» في لوحة الشركة |
| «تقدر تربط بوت تيليجرام خاص بنطاقك للتنبيه عند فتح تذكرة» | لا وجود لأي ربط تيليجرام في `subdomains/manage-subdomains.html`؛ تنبيهات تيليجرام للطاقم فقط | اسُتبدل السؤال بالمسار الحقيقي: «تذاكر العملاء» في لوحة الشركة |

---

## 4) توثيق ناقص أو يحتاج تحقّقًا (Missing / Needs Verification)

1. **محفّز `set_ticket_sla()`** — مذكور في تعليق
   `whatsapp-subscription-service.js:296-299` لكن تعريفه غير موجود في
   `migrations/`. الأثر مرئي في واجهة العميل (الشارة تُرسم من
   `sla_response_due_at`)، لكن لا يمكن الجزم بأن **كل** تذكرة تحصل على
   هدف زمني. المحتوى صيغ بشرط، ويُستحسن تثبيت التعريف في ترحيل.
2. **إرسال البريد تلقائيًا** — هل يوجد محفّز في قاعدة الإنتاج ينادي
   `send-ticket-email` بـ`X-Internal-Trigger-Secret`؟ غير موجود في
   المستودع. لو موجود فعلًا، تُحدَّث فقرة البريد لتصبح قاطعة.
3. **خدمة `whatsapp.mad3oom.online`** — عنصر في القائمة الجانبية يفتح
   نطاقًا خارج هذا المستودع، فلم توثَّق وظائفه الداخلية إطلاقًا.
4. **إلغاء «إخفاء من قائمتي»** — لا مسار في واجهة العميل. المحتوى ينصح
   بالتواصل مع الدعم؛ يُفضَّل تأكيد أن الدعم يقدر فعلًا يرجّعها.
5. **مدة الأرشفة التلقائية** — النص معروض في الواجهة
   (`ticket_retention_days`)، لكن لم أجد في المستودع المهمة التي تنفّذ
   الأرشفة. وُثّق بوصفه «نص يظهر حسب الإعدادات» لا كسلوك مؤكَّد.
6. **`chat-customer.html`** — وُثّق على مستوى «قناة تواصل سريعة» فقط.
   تفاصيل سير المحادثة (البوت، إنهاء المحادثة، التقييم) خارج نطاق هذه
   المهمة ولم تُوسَّع.

---

## 5) استبعاد لوحة الإدارة (Admin Exclusion Check)

راجعت المحتوى النهائي في `knowledgebase.html`، ولا يحتوي على:

- أي رابط أو ذكر لـ`admin/*` أو `admin-dashboard.html` أو
  `owner-dashboard.html` أو `owner-contexts.html`.
- أي شرح لإعدادات الإدارة (`advanced_settings`, `working_hours`,
  `sla_config`) كشاشات يستخدمها العميل — ذُكرت فقط بوصفها «قيم يحددها
  فريق الإدارة» وتظهر للعميل كنتيجة.
- أي إجراء إداري: تغيير حالة تذكرة عميل آخر، تغيير الأولوية، الردود
  الداخلية (`is_internal`)، الوسوم، الردود الجاهزة، الإسناد لموظف،
  الإجراءات الجماعية، أو إحصاءات المنصة.
- أي ذكر لتنبيهات تيليجرام لتجاوز SLA (وهي للطاقم فقط).
- أي ذكر لـ`sla_resolution_due_at` أو فلتر «مخالفة SLA» (لوحة الإدارة).

الوظائف الوحيدة المشروحة هي ما يصل له العميل من `customer-dashboard.html`
و`/company-dashboard/` و`knowledge-base.html` و`chat-customer.html`.

---

## 6) اقتراحات تحسين على التوثيق (منفصلة عن المحتوى)

مسجّلة هنا فقط، وغير مدمجة في محتوى العميل:

1. تثبيت تعريف `set_ticket_sla()` في ترحيل داخل المستودع حتى يصير سلوك
   SLA قابلًا للتوثيق القاطع.
2. لو المطلوب إشعارات بريد تلقائية، يُضاف محفّز صريح ويُوثَّق — الوضع
   الحالي يجعل البريد إجراءً يدويًا من الطاقم.
3. إضافة إجراء «إظهار التذكرة مرة أخرى» في واجهة العميل، لأن الإخفاء
   حاليًا بلا تراجع.
4. توحيد نموذجَي إنشاء التذكرة (بوابة العميل فيه أولوية ومرفقات، ولوحة
   الشركة لا) — الفرق حاليًا موثَّق لكنه مربك للعميل الذي يستخدم اللوحتين.
