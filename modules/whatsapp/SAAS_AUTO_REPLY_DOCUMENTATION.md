# نظام الرد الآلي المتقدم - نسخة SaaS Enterprise

## 🎯 نظرة عامة

تم تطوير نظام رد آلي شامل بمستوى **Enterprise SaaS** يضاهي أنظمة عالمية مثل:
- Intercom
- ManyChat  
- Chatbot.com
- Tidio
- Drift

---

## ✨ الميزات الجديدة

### 1. إدارة الحالة (State Management)
- **حفظ موضع المستخدم**: تتبع مكان المستخدم في التدفق
- **استمرارية الجلسات**: استئناف المحادثة حتى بعد 24 ساعة
- **سياق المستخدم**: تخزين بيانات المستخدم عبر التدفق

**ملف**: `services/state-manager.js`

```javascript
import { stateManager } from './services/state-manager.js';

// حفظ الحالة
await stateManager.saveUserState(userId, phoneNumber, nodeId, context);

// جلب الحالة
const state = await stateManager.getUserState(userId, phoneNumber);

// تحديث السياق فقط
await stateManager.updateContext(userId, phoneNumber, { name: 'أحمد' });

// مسح الحالة (عند انتهاء التدفق)
await stateManager.clearUserState(userId, phoneNumber);
```

---

### 2. جدولة الرسائل (Message Scheduling)
- **إرسال متأخر**: جدولة رسائل للإرسال لاحقاً
- **مراقبة تلقائية**: نظام Polling يفحص كل 10 ثوان
- **إدارة الحالة**: تتبع (pending, sent, failed, cancelled)

**ملف**: `services/message-scheduler.js`

```javascript
import { messageScheduler } from './services/message-scheduler.js';

// بدء المجدول
messageScheduler.start();

// جدولة رسالة بعد 60 ثانية
await messageScheduler.scheduleMessage(
    userId,
    phoneNumber,
    'مرحباً! هذه رسالة متأخرة',
    60,
    { nodeId: 'msg_1', flowId: 'welcome' }
);

// إلغاء رسالة مجدولة
await messageScheduler.cancelScheduledMessage(messageId);

// الحصول على الرسائل المعلقة
const pending = await messageScheduler.getScheduledMessages(userId);
```

---

### 3. تحليلات متقدمة (Advanced Analytics)
- **تتبع الأحداث**: تسجيل كل حدث في التدفق
- **إحصائيات الأداء**: معدل الإكمال، متوسط المدة، معدل الأخطاء
- **رحلات المستخدمين**: تتبع مسار كل مستخدم
- **تحليل العقد**: أكثر العقد زيارة وأداءً

**ملف**: `services/flow-analytics.js`

```javascript
import { flowAnalytics } from './services/flow-analytics.js';

// تتبع دخول عقدة
await flowAnalytics.trackNodeEntry(userId, phone, flowId, nodeId, nodeType);

// تتبع نتيجة شرط
await flowAnalytics.trackConditionResult(userId, phone, flowId, nodeId, condition, result);

// تتبع إكمال التدفق
await flowAnalytics.trackFlowCompletion(userId, phone, flowId, duration, nodesCount);

// الحصول على إحصائيات
const stats = await flowAnalytics.getFlowStats(userId, flowId, startDate, endDate);
// Returns: { totalExecutions, avgDuration, errorRate, errorCount, nodeStats }

// الحصول على رحلات المستخدمين
const journeys = await flowAnalytics.getUserJourneys(userId, flowId, limit);
```

---

### 4. محرك تنفيذ محسّن (Enhanced Engine)
- **دعم AI**: تكامل مع OpenAI GPT
- **طلبات HTTP**: استدعاء APIs خارجية
- **معالجة الأخطاء**: تتبع وتسجيل الأخطاء
- **متغيرات السياق**: {{variable}} replacement

**ملف**: `services/auto-reply-engine.js` (V3.0)

```javascript
import { autoReplyEngine } from './services/auto-reply-engine.js';

// تنفيذ تدفق
const result = await autoReplyEngine.executeFlow(
    flow,
    incomingMessage,
    userId,
    phoneNumber,
    flowId
);

// معالجة النتائج
result.responses.forEach(async (response) => {
    if (response.type === 'text') {
        await WhatsAppAPI.sendMessage(userId, phoneNumber, response.content);
    } else if (response.type === 'buttons') {
        await WhatsAppAPI.sendButtons(userId, phoneNumber, response.content, response.buttons);
    }
});
```

---

### 5. صفحة تحليلات Dashboard
واجهة احترافية لمراقبة الأداء

**ملف**: `pages/FlowAnalyticsPage.js`

**المكونات**:
- **بطاقات الإحصائيات**: إجمالي التنفيذات، معدل الإكمال، متوسط المدة، معدل الأخطاء
- **مخطط أداء العقد**: أكثر العقد زيارة
- **نقاط الخروج**: أين يغادر المستخدمون
- **رحلات المستخدمين**: مسار كل مستخدم
- **سجل الأحداث**: Timeline للأحداث

```javascript
import { FlowAnalyticsPage } from './pages/FlowAnalyticsPage.js';

const container = document.getElementById('analytics-container');
const page = new FlowAnalyticsPage(container);
await page.load();
```

---

## 🗄️ جداول قاعدة البيانات المطلوبة

### 1. bot_user_states
```sql
CREATE TABLE bot_user_states (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    phone_number VARCHAR(20) NOT NULL,
    current_node_id VARCHAR(100),
    context JSONB DEFAULT '{}',
    last_interaction TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, phone_number)
);

CREATE INDEX idx_bot_user_states_user_phone ON bot_user_states(user_id, phone_number);
CREATE INDEX idx_bot_user_states_last_interaction ON bot_user_states(last_interaction);
```

### 2. scheduled_messages
```sql
CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    phone_number VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, sent, failed, cancelled
    sent_at TIMESTAMP WITH TIME ZONE,
    whatsapp_message_id VARCHAR(100),
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_scheduled_messages_status_time ON scheduled_messages(status, scheduled_at);
CREATE INDEX idx_scheduled_messages_user ON scheduled_messages(user_id);
```

### 3. flow_analytics_events
```sql
CREATE TABLE flow_analytics_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    phone_number VARCHAR(20) NOT NULL,
    flow_id VARCHAR(100) NOT NULL,
    node_id VARCHAR(100),
    node_type VARCHAR(50),
    event_type VARCHAR(50) NOT NULL, -- node_entry, node_exit, flow_completed, flow_error, button_click, condition_result
    duration_ms INTEGER,
    success BOOLEAN,
    error_message TEXT,
    total_duration_ms INTEGER,
    nodes_visited INTEGER,
    condition VARCHAR(255),
    result BOOLEAN,
    button_text VARCHAR(255),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_flow_events_user_flow ON flow_analytics_events(user_id, flow_id);
CREATE INDEX idx_flow_events_timestamp ON flow_analytics_events(timestamp DESC);
CREATE INDEX idx_flow_events_type ON flow_analytics_events(event_type);
```

### 4. bot_settings (تحديث)
```sql
-- إضافة حقل للتدفقات إذا لم يكن موجوداً
ALTER TABLE bot_settings 
ADD COLUMN IF NOT EXISTS custom_replies JSONB;
```

---

## 🚀 كيفية الاستخدام

### خطوة 1: تهيئة قاعدة البيانات
قم بتنفيذ الـ SQL أعلاه في Supabase SQL Editor.

### خطوة 2: إضافة الملفات
تأكد من وجود جميع الملفات الجديدة:
- ✅ `services/state-manager.js`
- ✅ `services/message-scheduler.js`
- ✅ `services/flow-analytics.js`
- ✅ `services/auto-reply-engine.js` (محدث)
- ✅ `pages/FlowAnalyticsPage.js`

### خطوة 3: تفعيل المجدول
في ملف التطبيق الرئيسي:

```javascript
import { messageScheduler } from './services/message-scheduler.js';

// عند تحميل الصفحة
messageScheduler.start();
```

### خطوة 4: استخدام النظام الجديد
```javascript
// عند استقبال رسالة واردة من WhatsApp
import { autoReplyEngine } from './services/auto-reply-engine.js';

async function handleIncomingMessage(from, message, userId) {
    try {
        // جلب التدفق من قاعدة البيانات
        const flow = await getFlowFromDatabase(userId);
        
        // تنفيذ التدفق
        const result = await autoReplyEngine.executeFlow(
            flow,
            message,
            userId,
            from,
            'main_flow'
        );
        
        // إرسال الردود
        for (const response of result.responses) {
            if (response.type === 'text') {
                await WhatsAppAPI.sendMessage(userId, from, response.content);
            }
        }
    } catch (error) {
        console.error('Flow execution failed:', error);
    }
}
```

### خطوة 5: عرض التحليلات
أضف صفحة التحليلات إلى التطبيق:

```javascript
// في app.js أو index.html
import { FlowAnalyticsPage } from './pages/FlowAnalyticsPage.js';

// إضافة زر في القائمة
<div class="nav-item" data-page="analytics" onclick="navigateTo('analytics', this)">
    <span>تحليلات التدفقات</span>
</div>

// في دالة navigateTo
if (page === 'analytics') {
    const container = document.getElementById('analytics-container');
    window.flowAnalyticsPage = new FlowAnalyticsPage(container);
    await window.flowAnalyticsPage.load();
}
```

---

## 📊 أمثلة على السيناريوهات

### سيناريو 1: ترحيب + جمع بيانات
```
Start → Message ("مرحباً! ما اسمك؟") [wait=true] 
     → AI Node (استخراج الاسم وحفظه في context.name) 
     → Message ("أهلاً {{name}}! كيف يمكننا مساعدتك؟")
     → End
```

### سيناريو 2: شرط + تأخير
```
Start → Condition (keyword="سعر", type=contains)
     ├─ YES → Message ("السعر هو 500 ريال")
     │      → Delay (5 seconds)
     │      → Message ("هل تريد الشراء؟") [wait=true]
     │      → End
     └─ NO → Message ("عذراً، لم أفهم طلبك")
           → End
```

### سيناريو 3: تكامل API
```
Start → Message ("جاري التحقق من رصيدك...")
     → HTTP Node (GET https://api.example.com/balance?user={{phone}})
     → Message ("رصيدك الحالي: {{balance}} ريال")
     → End
```

---

## 🔒 الأمان والحدود

### الحدود المطبقة
- ⏱️ **مهلة التنفيذ**: 30 ثانية كحد أقصى
- 🔄 **اكتشاف الحلقات**: منع الحلقات اللانهائية
- 📦 **حد التأخير**: 10 ثواني كحد أقصى لعقدة التأخير
- 🌐 **مهلة HTTP**: 10 ثواني للطلبات الخارجية
- 💾 **تنظيف التخزين**: مسح السجلات القديمة تلقائياً

### الأمان
- 🔐 **مصادقة المستخدم**: التحقق من userId في كل طلب
- 🛡️ **Row Level Security**: استخدام RLS في Supabase
- 🔒 **تشفير البيانات**: حفظ البيانات الحساسة مشفرة
- 📝 **تسجيل الأحداث**: تتبع جميع الإجراءات

---

## 📈 مقاييس الأداء

### مؤشرات الأداء الرئيسية (KPIs)
1. **معدل الإكمال**: نسبة المستخدمين الذين أكملوا التدفق
2. **متوسط المدة**: الوقت المستغرق لإكمال التدفق
3. **معدل الأخطاء**: نسبة التنفيذات الفاشلة
4. **نقاط التسرب**: أين يترك المستخدمون التدفق
5. **تفاعل العقد**: أكثر العقد استخداماً

### التحسينات المستقبلية
- [ ] A/B Testing للرسائل
- [ ] تكامل مع Zapier
- [ ] دعم الوسائط المتعددة المتقدم
- [ ] قوالب تدفقات جاهزة
- [ ] تصدير التقارير PDF/Excel
- [ ] إشعارات Slack/Email عند الأخطاء
- [ ] لوحة تحكم مباشرة (Real-time)

---

## 🐛 استكشاف الأخطاء

### المشكلة: الرسائل المجدولة لا ترسل
**الحل**:
```javascript
// تأكد من تشغيل المجدول
messageScheduler.start();

// تحقق من السجلات
console.log(messageScheduler.isRunning); // should be true
```

### المشكلة: الحالة لا تحفظ
**الحل**:
```javascript
// تحقق من جدول bot_user_states
const state = await stateManager.getUserState(userId, phoneNumber);
console.log(state);
```

### المشكلة: التحليلات فارغة
**الحل**:
```javascript
// تأكد من تتبع الأحداث
await flowAnalytics.trackNodeEntry(...);

// تحقق من الجدول
SELECT * FROM flow_analytics_events ORDER BY timestamp DESC LIMIT 10;
```

---

## 📞 الدعم

للمساعدة أو الإبلاغ عن مشاكل:
- 📧 **البريد**: support@mad3oom.online
- 🌐 **الموقع**: https://mad3oom.online
- 📚 **التوثيق**: https://docs.mad3oom.online

---

## 📄 الترخيص

جميع الحقوق محفوظة © 2024 mad3oom.online

---

**الإصدار**: 3.0.0 Enterprise  
**تاريخ الإطلاق**: 2024  
**الحالة**: ✅ جاهز للإنتاج  
**المستوى**: 🏆 Enterprise SaaS Grade
