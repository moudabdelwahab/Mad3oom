# WhatsApp Session Messages API

## نظرة عامة

هذا الـ endpoint يسمح بإرسال رسائل حرة (Session Messages) عبر واتساب ضمن نافذة الـ 24 ساعة. هذه الرسائل لا تحتاج إلى استخدام قوالب (templates) وتُرسل مجاناً من قبل Meta.

## المتطلبات

- **API Key**: مفتاح API نشط من لوحة التحكم
- **WhatsApp Integration**: يجب أن يكون لديك حساب WhatsApp Business مربوط
- **Recipient Phone Number**: رقم هاتف المستقبل بالصيغة الدولية (بدون +)

## الاستخدام

### Endpoint

```
POST https://api.mad3oom.online/v1/whatsapp/session/send
```

### Headers

```
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

### Request Body

```json
{
  "to": "201025998920",
  "message": "مرحباً بك، كيف يمكنني مساعدتك؟",
  "phone_number_id": "optional_phone_id"
}
```

#### معاملات الطلب

| المعامل | النوع | مطلوب | الوصف |
|--------|-------|------|-------|
| `to` | string | نعم | رقم هاتف المستقبل بالصيغة الدولية (بدون +) |
| `message` | string | نعم | نص الرسالة المراد إرسالها |
| `phone_number_id` | string | لا | معرف رقم الهاتف في حال وجود أكثر من رقم مربوط |

### Response

#### النجاح (200)

```json
{
  "success": true,
  "message_id": "wamid.xxx"
}
```

#### الأخطاء

| الكود | المعنى |
|------|--------|
| 400 | معاملات مفقودة أو غير صحيحة |
| 401 | مفتاح API غير صالح أو غير نشط |
| 404 | لم يتم العثور على تكامل WhatsApp |
| 500 | خطأ داخلي في الخادم |

### أمثلة

#### JavaScript

```javascript
const response = await fetch('https://api.mad3oom.online/v1/whatsapp/session/send', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    to: '201025998920',
    message: 'مرحباً بك في خدمتنا'
  })
});

const data = await response.json();
console.log(data);
```

#### Python

```python
import requests

url = "https://api.mad3oom.online/v1/whatsapp/session/send"
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}
payload = {
    "to": "201025998920",
    "message": "مرحباً بك في خدمتنا"
}

response = requests.post(url, json=payload, headers=headers)
print(response.json())
```

#### cURL

```bash
curl -X POST https://api.mad3oom.online/v1/whatsapp/session/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "201025998920",
    "message": "مرحباً بك في خدمتنا"
  }'
```

## ملاحظات مهمة

1. **نافذة الـ 24 ساعة**: يمكن إرسال رسائل الجلسة فقط ضمن 24 ساعة من آخر رسالة استقبلتها من العميل
2. **الرسائل الحرة**: لا تحتاج إلى قوالب وتُرسل مجاناً
3. **التسجيل**: يتم تسجيل جميع الرسائل المرسلة في قاعدة البيانات
4. **معرفات متعددة**: إذا كان لديك أكثر من رقم هاتف مربوط، استخدم `phone_number_id` لتحديد أي رقم ستستخدم

## الأخطاء الشائعة

### "No WhatsApp integration found"
- تأكد من ربط حساب WhatsApp Business في لوحة التحكم
- تحقق من أن الحساب نشط وصحيح

### "Invalid or inactive API key"
- تحقق من أن المفتاح صحيح
- تأكد من أن حالة المفتاح "نشط" في لوحة التحكم

### "Failed to send WhatsApp message"
- تحقق من صيغة رقم الهاتف (يجب أن يكون بدون +)
- تأكد من أن الرقم صحيح
- تحقق من أن نافذة الـ 24 ساعة لم تنته بعد
