/**
 * مثال على استخدام نظام Shared Inbox
 * يوضح كيفية استخدام الخدمات المختلفة
 */

import { SharedInboxService } from '../services/shared-inbox-service.js';
import { InboxIntegration } from '../services/inbox-integration.js';

// ═══════════════════════════════════════════════════════════════════════
// 1. جلب المحادثات
// ═══════════════════════════════════════════════════════════════════════

async function example_getConversations() {
  try {
    // جلب أول 50 محادثة
    const conversations = await SharedInboxService.getConversations({ 
      limit: 50, 
      offset: 0 
    });

    console.log('المحادثات:', conversations);
    
    // عرض معلومات كل محادثة
    conversations.forEach(conv => {
      console.log(`
        رقم الهاتف: ${conv.phone_number}
        آخر رسالة: ${conv.last_message}
        الحالة: ${conv.status}
        غير مقروءة: ${conv.unread_count}
        المعين: ${conv.assigned_agent?.name || 'غير معين'}
      `);
    });
  } catch (error) {
    console.error('خطأ في جلب المحادثات:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 2. تعيين محادثة لوكيل
// ═══════════════════════════════════════════════════════════════════════

async function example_assignConversation() {
  try {
    const conversationId = 1;
    const agentId = 2;

    const result = await SharedInboxService.assignConversation(
      conversationId, 
      agentId
    );

    console.log('تم التعيين بنجاح:', result);
  } catch (error) {
    console.error('خطأ في التعيين:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 3. إضافة ملاحظة داخلية
// ═══════════════════════════════════════════════════════════════════════

async function example_addNote() {
  try {
    const conversationId = 1;
    const noteContent = 'العميل يسأل عن المنتج X، يحتاج متابعة غداً';

    const note = await SharedInboxService.addNote(
      conversationId, 
      noteContent
    );

    console.log('تمت إضافة الملاحظة:', note);
  } catch (error) {
    console.error('خطأ في إضافة الملاحظة:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 4. إضافة وسم
// ═══════════════════════════════════════════════════════════════════════

async function example_addTag() {
  try {
    const conversationId = 1;
    const tagName = 'عميل VIP';

    const tag = await SharedInboxService.addTag(
      conversationId, 
      tagName
    );

    console.log('تمت إضافة الوسم:', tag);
  } catch (error) {
    console.error('خطأ في إضافة الوسم:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 5. تحديث حالة المحادثة
// ═══════════════════════════════════════════════════════════════════════

async function example_updateStatus() {
  try {
    const conversationId = 1;
    const newStatus = 'closed'; // open, pending, closed

    const result = await SharedInboxService.updateConversationStatus(
      conversationId, 
      newStatus
    );

    console.log('تم تحديث الحالة:', result);
  } catch (error) {
    console.error('خطأ في تحديث الحالة:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. البحث عن محادثات
// ═══════════════════════════════════════════════════════════════════════

async function example_search() {
  try {
    const searchQuery = '+966501234567'; // رقم أو نص

    const results = await SharedInboxService.searchConversations(searchQuery);

    console.log('نتائج البحث:', results);
  } catch (error) {
    console.error('خطأ في البحث:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. تصفية حسب الحالة
// ═══════════════════════════════════════════════════════════════════════

async function example_filterByStatus() {
  try {
    const status = 'open'; // open, pending, closed

    const conversations = await SharedInboxService.filterByStatus(status);

    console.log(`المحادثات ذات الحالة "${status}":`, conversations);
  } catch (error) {
    console.error('خطأ في التصفية:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. تصفية حسب الوكيل
// ═══════════════════════════════════════════════════════════════════════

async function example_filterByAgent() {
  try {
    const agentId = 2;

    const conversations = await SharedInboxService.filterByAgent(agentId);

    console.log(`المحادثات المعينة للوكيل ${agentId}:`, conversations);
  } catch (error) {
    console.error('خطأ في التصفية:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. جلب المحادثات غير المقروءة
// ═══════════════════════════════════════════════════════════════════════

async function example_getUnreadConversations() {
  try {
    const unreadConversations = await SharedInboxService.getUnreadConversations();

    console.log('المحادثات غير المقروءة:', unreadConversations);
    console.log(`عدد المحادثات غير المقروءة: ${unreadConversations.length}`);
  } catch (error) {
    console.error('خطأ في جلب المحادثات غير المقروءة:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 10. جلب الإحصائيات
// ═══════════════════════════════════════════════════════════════════════

async function example_getStats() {
  try {
    const stats = await SharedInboxService.getStats();

    console.log('إحصائيات صندوق الوارد:');
    console.log(`  إجمالي المحادثات: ${stats.total}`);
    console.log(`  مفتوحة: ${stats.open}`);
    console.log(`  معلقة: ${stats.pending}`);
    console.log(`  مغلقة: ${stats.closed}`);
    console.log(`  غير مقروءة: ${stats.unread}`);
  } catch (error) {
    console.error('خطأ في جلب الإحصائيات:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 11. معالجة رسالة واردة
// ═══════════════════════════════════════════════════════════════════════

async function example_handleIncomingMessage() {
  try {
    const incomingMessage = {
      from_number: '+966501234567',
      to_number: '+966551234567',
      message_text: 'السلام عليكم، هل المنتج متوفر؟',
      message_type: 'text',
      timestamp: new Date().toISOString(),
      wa_message_id: 'wamid.xxx'
    };

    const result = await InboxIntegration.handleIncomingMessage(incomingMessage);

    console.log('تمت معالجة الرسالة الواردة:', result);
  } catch (error) {
    console.error('خطأ في معالجة الرسالة الواردة:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 12. معالجة رسالة صادرة
// ═══════════════════════════════════════════════════════════════════════

async function example_handleOutgoingMessage() {
  try {
    const conversationId = 1;
    const messageText = 'نعم، المنتج متوفر حالياً. السعر 99.99 ريال';
    const agentId = 2;

    const result = await InboxIntegration.handleOutgoingMessage(
      conversationId,
      messageText,
      agentId
    );

    console.log('تمت معالجة الرسالة الصادرة:', result);
  } catch (error) {
    console.error('خطأ في معالجة الرسالة الصادرة:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 13. تسجيل قراءة المحادثة
// ═══════════════════════════════════════════════════════════════════════

async function example_markAsRead() {
  try {
    const conversationId = 1;
    const agentId = 2;

    await InboxIntegration.markConversationAsRead(conversationId, agentId);

    console.log('تم تسجيل قراءة المحادثة');
  } catch (error) {
    console.error('خطأ في تسجيل القراءة:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 14. جلب من قرأ المحادثة
// ═══════════════════════════════════════════════════════════════════════

async function example_getReaders() {
  try {
    const conversationId = 1;

    const readers = await SharedInboxService.getReaders(conversationId);

    console.log('من قرأ هذه المحادثة:');
    readers.forEach(reader => {
      console.log(`  - ${reader.agent?.name} في ${reader.read_at}`);
    });
  } catch (error) {
    console.error('خطأ في جلب قائمة القراء:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 15. جلب تفاصيل المحادثة الكاملة
// ═══════════════════════════════════════════════════════════════════════

async function example_getConversationDetails() {
  try {
    const conversationId = 1;

    const details = await InboxIntegration.getConversationDetails(conversationId);

    console.log('تفاصيل المحادثة:');
    console.log('  المحادثة:', details.conversation);
    console.log('  الملاحظات:', details.notes);
    console.log('  الوسوم:', details.tags);
    console.log('  من قرأ:', details.readers);
  } catch (error) {
    console.error('خطأ في جلب التفاصيل:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 16. جلب نشاط المحادثة
// ═══════════════════════════════════════════════════════════════════════

async function example_getConversationActivity() {
  try {
    const conversationId = 1;

    const activity = await InboxIntegration.getConversationActivity(conversationId);

    console.log('نشاط المحادثة:');
    activity.forEach(log => {
      console.log(`  - ${log.action} بواسطة ${log.agent?.name} في ${log.created_at}`);
      if (log.details) {
        console.log(`    التفاصيل: ${JSON.stringify(log.details)}`);
      }
    });
  } catch (error) {
    console.error('خطأ في جلب النشاط:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// تشغيل الأمثلة
// ═══════════════════════════════════════════════════════════════════════

// قم بتشغيل الأمثلة التي تريدها:
// await example_getConversations();
// await example_assignConversation();
// await example_addNote();
// await example_addTag();
// await example_updateStatus();
// await example_search();
// await example_filterByStatus();
// await example_filterByAgent();
// await example_getUnreadConversations();
// await example_getStats();
// await example_handleIncomingMessage();
// await example_handleOutgoingMessage();
// await example_markAsRead();
// await example_getReaders();
// await example_getConversationDetails();
// await example_getConversationActivity();

export {
  example_getConversations,
  example_assignConversation,
  example_addNote,
  example_addTag,
  example_updateStatus,
  example_search,
  example_filterByStatus,
  example_filterByAgent,
  example_getUnreadConversations,
  example_getStats,
  example_handleIncomingMessage,
  example_handleOutgoingMessage,
  example_markAsRead,
  example_getReaders,
  example_getConversationDetails,
  example_getConversationActivity
};
