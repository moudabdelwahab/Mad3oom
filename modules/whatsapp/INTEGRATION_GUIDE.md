# دليل التكامل - نظام الرد الآلي المحسّن

## 🔗 خطوات التكامل مع التطبيق الرئيسي

### الخطوة 1: تحديث ملف app.js

في `modules/whatsapp/app.js`، استبدل الاستيراد القديم:

```javascript
// القديم
import { AutoReplyPage } from './pages/AutoReplyPage.js';

// الجديد
import { AutoReplyPageV2 } from './pages/AutoReplyPageV2.js';
```

### الخطوة 2: تحديث دالة التحميل

في نفس الملف، حدّث دالة `loadAutoReply()`:

```javascript
// القديم
async function loadAutoReply() {
    const container = document.getElementById('page-autoreply');
    autoReplyPage = new AutoReplyPage(container);
    await autoReplyPage.load();
}

// الجديد
async function loadAutoReply() {
    const container = document.getElementById('page-autoreply');
    autoReplyPage = new AutoReplyPageV2(container);
    await autoReplyPage.load();
}
```

### الخطوة 3: إضافة ملف CSS الجديد

في `modules/whatsapp/index.html`، أضف:

```html
<!-- قبل </head> -->
<link rel="stylesheet" href="./flow-editor-v2.css">
```

### الخطوة 4: استيراد محرك التنفيذ

في `modules/whatsapp/app.js`، أضف:

```javascript
import { autoReplyEngine } from './services/auto-reply-engine.js';
```

### الخطوة 5: تحديث معالج الرسائل الواردة

في `modules/whatsapp/realtime/message-realtime.js` أو حيث تتم معالجة الرسائل الواردة:

```javascript
import { autoReplyEngine } from '../services/auto-reply-engine.js';
import { SupabaseIntegration } from '../supabase-integration.js';

async function handleIncomingMessage(message, userId) {
    try {
        // جلب التدفق من قاعدة البيانات
        const supabase = await SupabaseIntegration.initializeSupabase();
        const { data: botSettings } = await supabase
            .from('bot_settings')
            .select('custom_replies')
            .eq('user_id', userId)
            .maybeSingle();

        if (botSettings && botSettings.custom_replies) {
            // تنفيذ التدفق
            const result = await autoReplyEngine.executeFlow(
                botSettings.custom_replies,
                message.body,
                userId
            );

            // إرسال الردود
            for (const response of result.responses || []) {
                await sendResponse(response, message.from);
            }
        }
    } catch (error) {
        console.error('Error executing auto-reply flow:', error);
    }
}

async function sendResponse(response, recipientPhone) {
    const { WhatsAppAPI } = await import('../services/whatsapp-api.js');
    
    switch (response.type) {
        case 'text':
            await WhatsAppAPI.sendText({
                to: recipientPhone,
                text: response.content
            });
            break;

        case 'media':
            // Upload media first if needed
            const mediaId = response.mediaUrl; // or upload if URL
            await WhatsAppAPI.sendMedia({
                to: recipientPhone,
                type: response.mediaType,
                mediaId,
                caption: response.caption
            });
            break;

        case 'buttons':
            // Send interactive buttons
            // Note: Requires WhatsApp Business API v2.39+
            await WhatsAppAPI.sendInteractiveButtons({
                to: recipientPhone,
                message: response.message,
                buttons: response.buttons
            });
            break;
    }
}
```

---

## 🔄 تدفق البيانات

```
رسالة واردة
    ↓
handleIncomingMessage()
    ↓
جلب التدفق من قاعدة البيانات
    ↓
autoReplyEngine.executeFlow()
    ↓
تنفيذ العقد بالتسلسل
    ↓
جمع الردود
    ↓
إرسال الردود عبر WhatsApp API
    ↓
تسجيل الرسائل المرسلة
```

---

## 📦 متطلبات قاعدة البيانات

### جدول bot_settings

تأكد من وجود الأعمدة التالية:

```sql
CREATE TABLE bot_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    custom_replies JSONB,
    ai_enabled BOOLEAN DEFAULT false,
    ai_model VARCHAR(50) DEFAULT 'gpt-3.5-turbo',
    ai_temperature FLOAT DEFAULT 0.7,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id)
);

CREATE INDEX idx_bot_settings_user_id ON bot_settings(user_id);
```

---

## 🧪 اختبار التكامل

### 1. اختبار محرر الواجهة

```javascript
// في وحدة التحكم
const container = document.getElementById('page-autoreply');
const page = new AutoReplyPageV2(container);
await page.load();

// يجب أن ترى محرر الرد الآلي المحسّن
```

### 2. اختبار محرك التنفيذ

```javascript
import { autoReplyEngine } from './services/auto-reply-engine.js';

// مثال على تدفق بسيط
const flow = {
    drawflow: {
        Home: {
            data: {
                '1': {
                    id: 1,
                    class: 'start-node-v2',
                    data: {},
                    html: '',
                    typenode: 'start',
                    inputs: {},
                    outputs: { 1: { connections: [{ node: '2', output: 1 }] } },
                    pos_x: 100,
                    pos_y: 100
                },
                '2': {
                    id: 2,
                    class: 'message-node-v2',
                    data: { message: 'مرحبا بك!', delay: 0 },
                    html: '',
                    typenode: 'message',
                    inputs: { 1: { connections: [{ node: '1', output: 1 }] } },
                    outputs: { 1: { connections: [] } },
                    pos_x: 300,
                    pos_y: 100
                }
            },
            links: {
                '1': {
                    origin_node: '1',
                    origin_output: 1,
                    target_node: '2',
                    target_input: 1
                }
            }
        }
    }
};

// تنفيذ التدفق
const result = await autoReplyEngine.executeFlow(flow, 'مرحبا', 'user-123');
console.log('النتائج:', result);
```

### 3. اختبار الحفظ والتحميل

```javascript
// الحفظ
await page.saveFlowData();

// إعادة التحميل
await page.loadFlowData();

// يجب أن يظهر نفس التدفق
```

---

## 🚨 معالجة الأخطاء

### في معالج الرسائل

```javascript
async function handleIncomingMessage(message, userId) {
    try {
        const supabase = await SupabaseIntegration.initializeSupabase();
        const { data: botSettings, error } = await supabase
            .from('bot_settings')
            .select('custom_replies')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error('Database error:', error);
            return;
        }

        if (!botSettings?.custom_replies) {
            console.log('No auto-reply flow configured');
            return;
        }

        // التحقق من صحة التدفق
        const validationErrors = autoReplyEngine.validateFlow(botSettings.custom_replies);
        if (validationErrors.length > 0) {
            console.error('Flow validation errors:', validationErrors);
            return;
        }

        // تنفيذ التدفق
        const result = await autoReplyEngine.executeFlow(
            botSettings.custom_replies,
            message.body,
            userId
        );

        // إرسال الردود
        for (const response of result.responses || []) {
            try {
                await sendResponse(response, message.from);
            } catch (sendError) {
                console.error('Failed to send response:', sendError);
            }
        }
    } catch (error) {
        console.error('Auto-reply execution failed:', error);
        // يمكن إرسال رسالة خطأ للمستخدم
    }
}
```

---

## 📊 المراقبة والتسجيل

### الوصول إلى سجل التنفيذ

```javascript
// الحصول على آخر 50 تنفيذ
const logs = autoReplyEngine.getExecutionLog(50);

logs.forEach(log => {
    console.log(`
        ID: ${log.executionId}
        الرسالة: ${log.message}
        المدة: ${log.duration}ms
        الوقت: ${log.timestamp}
        الحالة: ${log.error ? 'خطأ' : 'نجاح'}
    `);
});

// مسح السجل
autoReplyEngine.clearExecutionLog();
```

---

## 🔐 الأمان

### نقاط أمان مهمة

1. **التحقق من المستخدم**: تأكد من أن المستخدم مصرح بتعديل التدفق
   ```javascript
   const userId = await SupabaseIntegration.getCurrentUserId();
   if (userId !== flowOwnerId) {
       throw new Error('Unauthorized');
   }
   ```

2. **التحقق من صحة المدخلات**: تحقق من جميع المدخلات قبل التنفيذ
   ```javascript
   const errors = autoReplyEngine.validateFlow(flow);
   if (errors.length > 0) {
       throw new Error(errors.join(', '));
   }
   ```

3. **حدود المهلة الزمنية**: لا تسمح بتدفقات طويلة جداً
   ```javascript
   if (executionTime > 30000) {
       throw new Error('Execution timeout exceeded');
   }
   ```

4. **تحديد معدل الطلبات**: حد من عدد التدفقات المنفذة
   ```javascript
   const rateLimiter = new Map();
   if (rateLimiter.get(userId) > 100) {
       throw new Error('Rate limit exceeded');
   }
   ```

---

## 🎯 أفضل الممارسات

1. **استخدم التأخيرات بحكمة**: لا تضف تأخيرات طويلة جداً
2. **اختبر التدفقات**: استخدم ميزة الاختبار قبل النشر
3. **راقب الأخطاء**: تحقق من سجلات التنفيذ بانتظام
4. **حدّث التدفقات**: قم بتحديث التدفقات بناءً على تعليقات المستخدمين
5. **استخدم الشروط**: استخدم عقد الشروط لتوجيه الرسائل بشكل صحيح

---

## 📞 الدعم

للمساعدة في التكامل:
- راجع التوثيق الكاملة في `AUTO_REPLY_V2_DOCUMENTATION.md`
- تحقق من الأمثلة في `examples/` (إن وجدت)
- تواصل مع فريق الدعم: support@mad3oom.online

---

**آخر تحديث**: 15 مايو 2026
