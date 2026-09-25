/**
 * chat-message-state.js
 * ------------------------------------------------------------
 * حالة رسالة الشات بعد 056_inbox_attachments_reactions_edits: فريق الدعم
 * يقدر يعدّل رده أو يحذفه من صندوق الرسائل (admin/inbox.html).
 *
 *   edited_at  — الرد اتعدّل؛ النص في الصف هو النص الجديد.
 *   deleted_at — الرد اتحذف؛ النص والمرفق اتمحوا من الصف نفسه.
 *
 * مصدر واحد لويدجت الشات (chat-widget.js) وصفحة شات العميل (chat-logic.js)
 * حتى يقول الاتنين نفس الكلام بنفس الشرط. مستقل عن SIE تمامًا: SIE لا يعدّل
 * ولا يحذف رسائل، ورسائل العميل والبوت لا تُعدَّل أبدًا (مفروض في القاعدة).
 * ------------------------------------------------------------
 */

export const DELETED_MESSAGE_TEXT = 'تم حذف هذه الرسالة';
export const EDITED_LABEL = 'معدّلة';

export function isDeletedMessage(msg) {
    return !!msg?.deleted_at;
}

export function isEditedMessage(msg) {
    return !!msg?.edited_at && !msg?.deleted_at;
}
