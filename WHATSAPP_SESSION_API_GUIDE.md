# دليل تطبيق API رسائل جلسة واتساب

## نظرة عامة

تم إضافة **REST API endpoint** جديد لإرسال رسائل الجلسة (Session Messages) عبر واتساب. هذه الرسائل:

- **حرة تماماً**: لا تُحتسب ضمن رسائل القالب المدفوعة
- **ضمن نافذة 24 ساعة**: يمكن إرسالها فقط خلال 24 ساعة من آخر رسالة استقبلتها من العميل
- **بدون قالب**: لا تحتاج إلى استخدام قوالب معرّفة مسبقاً
- **مسجلة**: يتم حفظ جميع الرسائل في قاعدة البيانات

## الملفات المضافة

### 1. Supabase Edge Function
**المسار**: `/supabase/functions/whatsapp-session/`

```
├── index.ts          # الكود الرئيسي للـ function
├── README.md         # التوثيق
└── test.js          # ملف اختبار
```

**الميزات**:
- التحقق من صحة مفتاح API
- الحصول على بيانات التكامل مع واتساب
- إرسال الرسالة عبر Meta Graph API
- تسجيل الرسالة في قاعدة البيانات

### 2. ملف الهجرة (Migration)
**المسار**: `/supabase/migrations/20250605_whatsapp_session_messages.sql`

يضيف الأعمدة والفهارس اللازمة:
- `session_message_type`: نوع الرسالة (جلسة)
- `api_key_id`: معرف مفتاح API الذي أرسل الرسالة
- `sent_via_api`: هل تم إرسالها عبر API
- `within_24h_window`: هل كانت ضمن نافذة 24 ساعة

### 3. توثيق API
**المسار**: `/api-docs.html`

تم تحديث صفحة التوثيق لتشمل:
- شرح الـ endpoint الجديد
- معاملات الطلب والاستجابة
- أمثلة برمجية (JavaScript, Python, cURL)

## كيفية الاستخدام

### 1. الحصول على مفتاح API

من لوحة التحكم:
1. اذهب إلى **إدارة API** → **مفاتيح API**
2. انقر على **توليد مفتاح جديد**
3. أدخل اسم التطبيق
4. انسخ المفتاح وحفظه بأمان

### 2. إرسال رسالة

```bash
curl -X POST https://api.mad3oom.online/v1/whatsapp/session/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "201025998920",
    "message": "مرحباً بك في خدمتنا"
  }'
```

### 3. معالجة الاستجابة

**النجاح**:
```json
{
  "success": true,
  "message_id": "wamid.xxx"
}
```

**الخطأ**:
```json
{
  "error": "No WhatsApp integration found for this user"
}
```

## أمثلة برمجية

### JavaScript

```javascript
async function sendWhatsAppMessage(phoneNumber, message) {
  const response = await fetch('https://api.mad3oom.online/v1/whatsapp/session/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer YOUR_API_KEY',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: phoneNumber,
      message: message
    })
  });

  const data = await response.json();
  if (data.success) {
    console.log('Message sent:', data.message_id);
  } else {
    console.error('Error:', data.error);
  }
}

// الاستخدام
sendWhatsAppMessage('201025998920', 'مرحباً بك');
```

### Python

```python
import requests

def send_whatsapp_message(phone_number, message):
    url = "https://api.mad3oom.online/v1/whatsapp/session/send"
    headers = {
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json"
    }
    payload = {
        "to": phone_number,
        "message": message
    }
    
    response = requests.post(url, json=payload, headers=headers)
    return response.json()

# الاستخدام
result = send_whatsapp_message('201025998920', 'مرحباً بك')
print(result)
```

### PHP

```php
<?php
function sendWhatsAppMessage($phoneNumber, $message) {
    $url = "https://api.mad3oom.online/v1/whatsapp/session/send";
    $apiKey = "YOUR_API_KEY";
    
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json'
    ]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        "to" => $phoneNumber,
        "message" => $message
    ]));
    
    $response = curl_exec($ch);
    curl_close($ch);
    
    return json_decode($response, true);
}

// الاستخدام
$result = sendWhatsAppMessage('201025998920', 'مرحباً بك');
print_r($result);
?>
```

## حالات الاستخدام

### 1. تنبيهات العملاء
إرسال تنبيهات فورية للعملاء عن طلباتهم:

```javascript
await sendWhatsAppMessage(
  customerPhone,
  `تم استقبال طلبك برقم #${orderId}\nسيتم معالجته قريباً`
);
```

### 2. تأكيد المواعيد
تأكيد حجوزات أو مواعيد:

```javascript
await sendWhatsAppMessage(
  customerPhone,
  `تم تأكيد موعدك يوم ${date} الساعة ${time}`
);
```

### 3. رسائل المتابعة
متابعة العملاء بعد الشراء:

```javascript
await sendWhatsAppMessage(
  customerPhone,
  `شكراً لك على شرائك! كيف كانت تجربتك معنا؟`
);
```

## معالجة الأخطاء

### الخطأ: "Invalid or inactive API key"
**السبب**: المفتاح غير صحيح أو غير نشط
**الحل**: 
- تحقق من نسخ المفتاح بشكل صحيح
- تأكد من أن حالة المفتاح "نشط" في لوحة التحكم

### الخطأ: "No WhatsApp integration found"
**السبب**: لم يتم ربط حساب واتساب
**الحل**:
- اذهب إلى إعدادات واتساب
- اربط حساب WhatsApp Business

### الخطأ: "Failed to send WhatsApp message"
**السبب**: مشكلة في الرسالة أو الرقم
**الحل**:
- تحقق من صيغة الرقم (بدون +)
- تأكد من أن الرقم صحيح
- تحقق من أن نافذة 24 ساعة لم تنته

## الحدود والقيود

| الحد | القيمة |
|-----|--------|
| حد الطلبات (Rate Limit) | 100 طلب/دقيقة |
| طول الرسالة | 4096 حرف |
| نافذة الـ 24 ساعة | من آخر رسالة استقبلتها من العميل |
| عدد الأرقام المربوطة | غير محدود |

## الأمان

### نقاط مهمة:
1. **احفظ مفتاح API بأمان**: لا تشاركه أو تضعه في الكود العام
2. **استخدم HTTPS فقط**: جميع الطلبات يجب أن تكون عبر HTTPS
3. **قيّد النطاقات**: في إعدادات المفتاح، حدد النطاقات المسموحة
4. **راقب الاستخدام**: تحقق من سجل الطلبات بانتظام

## الدعم والمساعدة

للمزيد من المعلومات:
- اطلع على [توثيق API](/api-docs.html)
- اقرأ [ملف README](/supabase/functions/whatsapp-session/README.md)
- استخدم ملف الاختبار: `/supabase/functions/whatsapp-session/test.js`

## التحديثات المستقبلية

المميزات المخطط إضافتها:
- [ ] دعم الرسائل مع الوسائط (صور، فيديو)
- [ ] جدولة الرسائل
- [ ] إرسال جماعي
- [ ] تتبع تفصيلي للتسليم والقراءة
- [ ] إعادة محاولة تلقائية
