# دمج إدارة الشات في `admin/inbox.html` وشيل `chat-admin.html`

## نتيجة المراجعة (قبل التعديل)

الفرضية كانت إن `chat-admin.html` هي اللي شغالة ببيانات تجريبية. المراجعة أثبتت **العكس**:

| الصفحة | مصدر البيانات | الحالة |
|---|---|---|
| `chat-admin.html` | `assets/js/chat-logic.js` (فرع الأدمن) ← `chat_sessions` / `chat_messages` الحقيقيين | بيانات حقيقية، لكن: أزرار ميتة بلا handlers (إعدادات البوت، التصدير Excel/PDF، الأرشفة، البحث في المحادثة، إرفاق صورة، تسجيل صوتي، محادثة جديدة)، ومابتقراش `?session=` من الإشعارات |
| `admin/inbox.html` | `assets/js/admin/inbox-data.js` — **بيانات وهمية في الذاكرة بالكامل** (عملاء `example.com`، محادثات ثابتة، بانر «البيانات كلها تجريبية»، مبدّل دور للمعاينة) | تصميم أغنى، مش متوصل بأي حاجة |

الجداول الحقيقية (مقروءة من القاعدة): `chat_sessions(id, user_id, guest_id, status 'active'|'closed', is_manual_mode, bot_state, created_at, updated_at)` و `chat_messages(id, session_id, sender_id, message_text, image_url, audio_url, is_admin_reply, is_bot_reply, created_at)`.

## الاعتماديات اللي كانت ممكن تتكسر

| الاعتمادية | المعالجة |
|---|---|
| دالتين في القاعدة `notify_admin_on_new_chat` و `handle_new_chat_message` بيكتبوا روابط إشعارات `chat-admin.html?session=<id>` (واحدة منهم من غير `/`، فبتتفتح `/admin/chat-admin.html` من صفحة الإشعارات) + الإشعارات القديمة المحفوظة | تحويل في `vercel.json` للمسارين ← `/admin/inbox.html` (الـ query بيتنقل)، والصندوق بيفتح المحادثة من `?session=`. **من غير migration ومن غير تعديل القاعدة.** |
| `chat-logic.js` مشترك بين `chat-admin.html` و `chat-customer.html` | اتشال فرع الأدمن بس. مسار العميل و SIE (`getSieReply` / `getSieAccessInfo` / `alreadyPersisted` / التحويل عند سحب الصلاحية) ماتلمسش. |
| روابط: `assets/components/sidebar.html`، `admin-dashboard.html`، `tickets.html` (مرتين)، `customer-history.js`، `api-management.html` | اتحوّلت لـ `/admin/inbox.html` (ومعاها `?session=` لما الجلسة معروفة). رابط الرجوع في `api-management.html` بقى للوحة التحكم. |
| `STAFF_ONLY_LINK_IDS` و مفتاح الترجمة `sidebar_chat` | اتشالوا (مابقاش ليهم عنصر). |
| `tests/sql/help-and-reports-migrations.test.sql` | **ماتغيّرش**: الرابط فيه بيانات اختبار بتطابق اللي الدالة في القاعدة لسه بتكتبه. |

## اللي اتنقل من `chat-admin.html`

- ترتيب محادثات الفريق (admin/support بيستخدموا الشات كعملاء) فوق مع وسم «فريق العمل».
- عرض الصور المرفقة بتوقيع وقت العرض من مستودع `chat-attachments` الخاص.
- حالة المحادثة (نشطة/مقفولة) في القايمة والعنوان.
- عقد الرد مع الويدجت: `is_manual_mode = true` ثم رسالة `is_admin_reply = true` — بنفس الترتيب.

الـ CSS بتاع `chat-admin.html` ماتنقلش: ألوانه ثابتة ومابتدعمش الوضع الداكن، والصندوق عنده مقابل لكل عنصر مبني على متغيرات التصميم.

## اللي اتشال من `admin/inbox.html` ولماذا

أي خاصية مالهاش عمود في الجداول الحقيقية اتشالت، لأن عرضها كان هيبقى وعد كداب ولأن التعليمات منعت جداول/migrations جديدة: الإسناد، الوسوم، الملاحظات الداخلية، الأرشفة، الكتم، المجموعات، المحادثة الجديدة مع أي عضو، التفاعلات، التثبيت، التمييز، التعديل/السحب، التحويل، الجدولة، المرفقات والتسجيل الصوتي من الأدمن، إيصالات القراءة، مبدّل الدور، وبانر المعاينة.

## الشكل الحالي

- `assets/js/admin/inbox-model.js` — منطق خالص بلا قاعدة (مين كتب الرسالة، «بانتظار رد»، المشاهد، البحث، الترتيب).
- `assets/js/admin/inbox-data.js` — Supabase: تحميل الجلسات برسايلها، رد الدعم، الإقفال، الردود الجاهزة من `canned_responses` (نفس دالة صفحة التذاكر)، Realtime.
- `assets/js/admin/inbox.js` — الواجهة. مابتنادي SIE ولا محرك البوت؛ بتعرض ردودهم زي ما اتكتبت.
- المشاهد: الكل / بانتظار رد / النشطة / الدعم ماسكها / مع البوت / المقفولة.
- الصفحة محروسة بـ `guardPage('admin')`، والرابط في القايمة للأدمن والدعم (السوبر يوزر كان هيشوف صندوق فاضي بسبب RLS).

## لسه برّه النطاق (مااتلمسش)

- `admin-chat-dashboard.html` / `admin-chat-dashboard.js`: صفحة يتيمة (مفيش أي رابط ليها) شغالة على `chat-service.js` الوهمي. مش مرتبطة بـ `chat-admin.html`، فماتشالتش — تستاهل قرار منفصل.
- تحديث الرابط اللي بتكتبه دالتين القاعدة لـ `/admin/inbox.html?session=` محتاج migration؛ التحويل في `vercel.json` بيغطيه لحد ما يتعمل.
