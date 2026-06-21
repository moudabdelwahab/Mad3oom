# نظام صندوق الوارد المشترك (Shared Inbox)

## نظرة عامة

نظام صندوق الوارد المشترك (Shared Inbox) هو حل متكامل يسمح لفريق من الوكلاء بإدارة المحادثات مع العملاء بكفاءة. يوفر النظام ميزات متقدمة لتنظيم وتتبع وإدارة المحادثات.

## الميزات الرئيسية

### 1. **تعيين المحادثات (Assign Conversation)**
- تعيين المحادثات للوكلاء المختلفين
- تتبع من يعمل على أي محادثة
- إعادة التعيين عند الحاجة

### 2. **الملاحظات الداخلية (Internal Notes)**
- إضافة ملاحظات خاصة بالفريق
- تتبع من أضاف الملاحظة والوقت
- مرئية فقط للفريق الداخلي

### 3. **الوسوم (Tags)**
- تصنيف المحادثات بوسوم مخصصة
- تصفية سريعة حسب الوسوم
- ألوان مخصصة لكل وسم

### 4. **حالات المحادثة (Conversation Status)**
- مفتوحة (Open)
- معلقة (Pending)
- مغلقة (Closed)

### 5. **المحادثات غير المقروءة (Unread)**
- عداد للرسائل غير المقروءة
- تصفية سريعة للمحادثات غير المقروءة
- إشعارات تلقائية

### 6. **تصفية حسب الوكيل (Filter by Agent)**
- عرض المحادثات المعينة لوكيل معين
- إحصائيات لكل وكيل
- تحميل متوازن للعمل

### 7. **البحث المتقدم (Search)**
- البحث برقم الهاتف
- البحث في نص الرسائل
- نتائج فورية

### 8. **الرد من لوحة التحكم (Reply from Dashboard)**
- إرسال الرسائل مباشرة من الواجهة
- تتبع الرسائل المرسلة
- دعم الرسائل النصية والوسائط

### 9. **رؤية من قرأ الرسالة (Read Receipts)**
- معرفة من قرأ المحادثة
- وقت القراءة الدقيق
- تتبع تفاعل الفريق

## البنية التقنية

### الملفات الرئيسية

```
modules/whatsapp/
├── shared-inbox.html              # واجهة المستخدم الرئيسية
├── services/
│   ├── shared-inbox-service.js    # خدمات Shared Inbox
│   ├── inbox-integration.js       # دمج النظام مع الرسائل
│   └── supabase-message-helper.js # مساعد الرسائل
├── migrations/
│   └── 001_create_shared_inbox_tables.sql  # هجرة قاعدة البيانات
└── SHARED_INBOX_README.md         # هذا الملف
```

### جداول قاعدة البيانات

#### 1. `shared_inbox_conversations`
المحادثات الرئيسية

```sql
- id: معرف فريد
- user_id: معرف المستخدم (المالك)
- phone_number: رقم هاتف العميل
- last_message: آخر رسالة
- last_message_at: وقت آخر رسالة
- status: حالة المحادثة (open/pending/closed)
- unread_count: عدد الرسائل غير المقروءة
- assigned_to: معرف الوكيل المعين
- created_at: وقت الإنشاء
- updated_at: آخر تحديث
```

#### 2. `shared_inbox_agents`
الوكلاء/الموظفون

```sql
- id: معرف فريد
- user_id: معرف المستخدم
- name: اسم الوكيل
- email: بريد الوكيل
- avatar_url: صورة الملف الشخصي
- status: حالة الوكيل (active/inactive/away)
- created_at: وقت الإنشاء
```

#### 3. `shared_inbox_notes`
الملاحظات الداخلية

```sql
- id: معرف فريد
- conversation_id: معرف المحادثة
- content: محتوى الملاحظة
- created_by: معرف من أضاف الملاحظة
- created_at: وقت الإضافة
- updated_at: آخر تحديث
```

#### 4. `shared_inbox_tags`
الوسوم

```sql
- id: معرف فريد
- conversation_id: معرف المحادثة
- name: اسم الوسم
- color: لون الوسم (hex)
- created_by: معرف من أضاف الوسم
- created_at: وقت الإضافة
```

#### 5. `shared_inbox_readers`
تتبع القراءة

```sql
- id: معرف فريد
- conversation_id: معرف المحادثة
- agent_id: معرف الوكيل
- read_at: وقت القراءة
```

#### 6. `shared_inbox_activity_log`
سجل النشاط

```sql
- id: معرف فريد
- conversation_id: معرف المحادثة
- agent_id: معرف الوكيل
- action: نوع الإجراء
- details: تفاصيل إضافية (JSON)
- created_at: وقت الإجراء
```

## الواجهة البرمجية (API)

### SharedInboxService

#### المحادثات
```javascript
// جلب المحادثات
await SharedInboxService.getConversations({ limit: 100, offset: 0 });

// جلب محادثة واحدة
await SharedInboxService.getConversation(conversationId);

// تحديث حالة المحادثة
await SharedInboxService.updateConversationStatus(conversationId, 'closed');

// تحديث عدد غير المقروءة
await SharedInboxService.updateUnreadCount(conversationId, 0);
```

#### التعيين
```javascript
// تعيين محادثة لوكيل
await SharedInboxService.assignConversation(conversationId, agentId);

// إزالة التعيين
await SharedInboxService.unassignConversation(conversationId);
```

#### الملاحظات
```javascript
// إضافة ملاحظة
await SharedInboxService.addNote(conversationId, 'محتوى الملاحظة');

// تحديث ملاحظة
await SharedInboxService.updateNote(noteId, 'محتوى جديد');

// حذف ملاحظة
await SharedInboxService.deleteNote(noteId);

// جلب الملاحظات
await SharedInboxService.getNotes(conversationId);
```

#### الوسوم
```javascript
// إضافة وسم
await SharedInboxService.addTag(conversationId, 'وسم جديد');

// حذف وسم
await SharedInboxService.removeTag(tagId);

// جلب الوسوم
await SharedInboxService.getTags(conversationId);
```

#### القراءة
```javascript
// تسجيل قراءة
await SharedInboxService.markAsRead(conversationId, agentId);

// جلب من قرأ
await SharedInboxService.getReaders(conversationId);
```

#### البحث والتصفية
```javascript
// البحث
await SharedInboxService.searchConversations('رقم أو نص');

// تصفية حسب الحالة
await SharedInboxService.filterByStatus('open');

// تصفية حسب الوكيل
await SharedInboxService.filterByAgent(agentId);

// المحادثات غير المقروءة
await SharedInboxService.getUnreadConversations();
```

#### الإحصائيات
```javascript
// جلب الإحصائيات
await SharedInboxService.getStats();
```

### InboxIntegration

```javascript
// معالجة رسالة واردة
await InboxIntegration.handleIncomingMessage(message);

// معالجة رسالة صادرة
await InboxIntegration.handleOutgoingMessage(conversationId, text, agentId);

// تحديث الحالة مع التسجيل
await InboxIntegration.updateConversationStatus(conversationId, 'closed', agentId);

// تعيين مع التسجيل
await InboxIntegration.assignConversationToAgent(conversationId, agentId, assignedBy);

// إضافة ملاحظة مع التسجيل
await InboxIntegration.addNoteWithLog(conversationId, content, agentId);

// إضافة وسم مع التسجيل
await InboxIntegration.addTagWithLog(conversationId, tagName, agentId);

// تسجيل القراءة
await InboxIntegration.markConversationAsRead(conversationId, agentId);

// جلب التفاصيل الكاملة
await InboxIntegration.getConversationDetails(conversationId);

// جلب النشاط
await InboxIntegration.getConversationActivity(conversationId);
```

## الاستخدام

### 1. تثبيت الهجرة

```bash
# في Supabase، قم بتشغيل ملف الهجرة
# migrations/001_create_shared_inbox_tables.sql
```

### 2. فتح الواجهة

```
https://your-domain.com/modules/whatsapp/shared-inbox.html
```

### 3. استخدام الخدمات

```javascript
import { SharedInboxService } from './services/shared-inbox-service.js';
import { InboxIntegration } from './services/inbox-integration.js';

// جلب المحادثات
const conversations = await SharedInboxService.getConversations();

// تعيين محادثة
await SharedInboxService.assignConversation(1, 2);

// إضافة ملاحظة
await SharedInboxService.addNote(1, 'ملاحظة مهمة');
```

## الأمان

### Row Level Security (RLS)

جميع الجداول محمية بـ RLS:
- المستخدمون يرون فقط بيانات حسابهم
- الوكلاء يرون فقط محادثات شركتهم
- الملاحظات والوسوم محمية بنفس الطريقة

### المصادقة

- جميع العمليات تتطلب مصادقة Supabase
- معرف المستخدم يُستخرج من `auth.uid()`

## الأداء

### الفهارس المُحسّنة

```sql
- idx_conversations_user_status
- idx_conversations_user_assigned
- idx_conversations_user_unread
- idx_notes_conversation_created
- idx_tags_conversation_name
```

### الاستعلامات المُحسّنة

- استخدام العلاقات (relationships) لتقليل الاستعلامات
- استخدام الـ Views للاستعلامات المعقدة
- تخزين مؤقت للبيانات الثابتة

## الإشعارات (اختياري)

يمكن إضافة الإشعارات من خلال:

```javascript
// إشعار عند تعيين محادثة
await supabase
  .from('shared_inbox_conversations')
  .on('*', payload => {
    if (payload.new.assigned_to === currentAgentId) {
      showNotification('تم تعيين محادثة جديدة');
    }
  })
  .subscribe();
```

## الخطوات التالية

1. **تطبيق الهجرة**: تشغيل ملف الهجرة في Supabase
2. **اختبار الواجهة**: فتح `shared-inbox.html` واختبار الميزات
3. **دمج الخدمات**: استخدام `InboxIntegration` في الكود الموجود
4. **إضافة الإشعارات**: تطبيق Realtime Subscriptions
5. **تحسين الأداء**: إضافة Caching و Pagination

## استكشاف الأخطاء

### المحادثات لا تظهر
- تحقق من أن المستخدم مصرح
- تحقق من RLS policies
- تحقق من أن البيانات موجودة في قاعدة البيانات

### الرسائل لا تُرسل
- تحقق من توفر رقم WhatsApp
- تحقق من صحة رقم العميل
- تحقق من الأخطاء في الـ Console

### الأداء بطيء
- تحقق من الفهارس
- استخدم EXPLAIN ANALYZE
- أضف Pagination

## الدعم

للمزيد من المعلومات:
- [Supabase Documentation](https://supabase.com/docs)
- [WhatsApp Business API](https://www.whatsapp.com/business/api)
- [Cairo Font Documentation](https://fonts.google.com/specimen/Cairo)
