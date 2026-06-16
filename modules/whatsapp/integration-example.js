/**
 * =====================================================
 * integration-example.js
 * مثال عملي لدمج نظام الرد الآلي المتقدم
 * =====================================================
 */

import { autoReplyEngine } from './services/auto-reply-engine.js';
import { stateManager } from './services/state-manager.js';
import { messageScheduler } from './services/message-scheduler.js';
import { flowAnalytics } from './services/flow-analytics.js';
import { SupabaseIntegration } from './supabase-integration.js';
import { WhatsAppAPI } from './services/whatsapp-api.js';

/**
 * ═══════════════════════════════════════════════
 * 1. تهيئة النظام عند تحميل الصفحة
 * ═══════════════════════════════════════════════
 */
export function initializeAutoReplySystem() {
    console.log('🚀 Initializing Auto Reply System...');
    
    // تشغيل مجدول الرسائل
    messageScheduler.start();
    console.log('✅ Message Scheduler started');
    
    // إعداد webhook listener إذا كان متاحاً
    setupWhatsAppWebhook();
    console.log('✅ WhatsApp Webhook configured');
    
    console.log('✅ Auto Reply System ready!');
}

/**
 * ═══════════════════════════════════════════════
 * 2. معالجة الرسائل الواردة من WhatsApp
 * ═══════════════════════════════════════════════
 */
export async function handleIncomingWhatsAppMessage(webhookData) {
    try {
        const { from, message, userId, timestamp } = parseWebhookData(webhookData);
        
        console.log(`📨 Incoming message from ${from}: "${message}"`);
        
        // جلب التدفق من قاعدة البيانات
        const flow = await getFlowForUser(userId);
        
        if (!flow) {
            console.warn(`⚠️ No flow configured for user ${userId}`);
            return;
        }
        
        // تنفيذ التدفق
        const result = await autoReplyEngine.executeFlow(
            flow,
            message,
            userId,
            from,
            'main_flow'  // يمكن تغييره حسب التدفق المطلوب
        );
        
        // إرسال الردود
        await sendResponses(userId, from, result.responses);
        
        console.log(`✅ Flow executed successfully for ${from}`);
        
    } catch (error) {
        console.error('❌ Error handling incoming message:', error);
        
        // إرسال رسالة خطأ للمستخدم (اختياري)
        // await WhatsAppAPI.sendMessage(userId, from, 'عذراً، حدث خطأ. يرجى المحاولة لاحقاً.');
    }
}

/**
 * ═══════════════════════════════════════════════
 * 3. إرسال الردود للمستخدم
 * ═══════════════════════════════════════════════
 */
async function sendResponses(userId, phoneNumber, responses) {
    for (const response of responses) {
        try {
            switch (response.type) {
                case 'text':
                    await WhatsAppAPI.sendMessage(userId, phoneNumber, response.content);
                    console.log(`📤 Sent text message to ${phoneNumber}`);
                    break;
                
                case 'buttons':
                    await WhatsAppAPI.sendButtons(
                        userId, 
                        phoneNumber, 
                        response.content, 
                        response.buttons
                    );
                    console.log(`📤 Sent buttons to ${phoneNumber}`);
                    break;
                
                case 'image':
                    await WhatsAppAPI.sendMedia(
                        userId,
                        phoneNumber,
                        response.url,
                        'image',
                        response.caption
                    );
                    console.log(`📤 Sent image to ${phoneNumber}`);
                    break;
                
                case 'video':
                    await WhatsAppAPI.sendMedia(
                        userId,
                        phoneNumber,
                        response.url,
                        'video',
                        response.caption
                    );
                    console.log(`📤 Sent video to ${phoneNumber}`);
                    break;
                
                default:
                    console.warn(`⚠️ Unknown response type: ${response.type}`);
            }
            
            // تأخير صغير بين الرسائل
            await sleep(500);
            
        } catch (error) {
            console.error(`❌ Failed to send response to ${phoneNumber}:`, error);
        }
    }
}

/**
 * ═══════════════════════════════════════════════
 * 4. جلب التدفق من قاعدة البيانات
 * ═══════════════════════════════════════════════
 */
async function getFlowForUser(userId) {
    try {
        const supabase = await SupabaseIntegration.initializeSupabase();
        
        const { data, error } = await supabase
            .from('bot_settings')
            .select('custom_replies, automation_enabled')
            .eq('user_id', userId)
            .single();
        
        if (error) throw error;
        
        // تحقق من تفعيل الأتمتة
        if (data.automation_enabled === false) {
            console.log(`⏸️ Automation disabled for user ${userId}`);
            return null;
        }
        
        return data.custom_replies;
        
    } catch (error) {
        console.error('❌ Failed to fetch flow:', error);
        return null;
    }
}

/**
 * ═══════════════════════════════════════════════
 * 5. إعداد WhatsApp Webhook
 * ═══════════════════════════════════════════════
 */
function setupWhatsAppWebhook() {
    // هذا يعتمد على طريقة استقبال الـ webhooks في تطبيقك
    // مثال باستخدام polling من قاعدة البيانات:
    
    setInterval(async () => {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const userId = await SupabaseIntegration.getCurrentUserId();
            
            // جلب الرسائل غير المعالجة
            const { data: newMessages, error } = await supabase
                .from('messages')
                .select('*')
                .eq('user_id', userId)
                .eq('direction', 'inbound')
                .eq('processed', false)
                .order('created_at', { ascending: true })
                .limit(10);
            
            if (error) throw error;
            
            // معالجة كل رسالة
            for (const msg of newMessages || []) {
                await handleIncomingWhatsAppMessage({
                    from: msg.phone_number,
                    message: msg.content,
                    userId: msg.user_id,
                    timestamp: msg.created_at
                });
                
                // تحديث الرسالة كمعالجة
                await supabase
                    .from('messages')
                    .update({ processed: true })
                    .eq('id', msg.id);
            }
            
        } catch (error) {
            console.error('❌ Webhook polling error:', error);
        }
    }, 5000); // كل 5 ثوانٍ
}

/**
 * ═══════════════════════════════════════════════
 * 6. API للمطورين - تشغيل تدفق يدوياً
 * ═══════════════════════════════════════════════
 */
export async function triggerFlowManually(userId, phoneNumber, flowId = 'main_flow') {
    try {
        const flow = await getFlowForUser(userId);
        
        if (!flow) {
            throw new Error('No flow configured');
        }
        
        // تشغيل التدفق برسالة افتراضية
        const result = await autoReplyEngine.executeFlow(
            flow,
            'بدء يدوي',
            userId,
            phoneNumber,
            flowId
        );
        
        await sendResponses(userId, phoneNumber, result.responses);
        
        return { success: true, result };
        
    } catch (error) {
        console.error('❌ Manual trigger failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * ═══════════════════════════════════════════════
 * 7. API للمطورين - إعادة تعيين حالة المستخدم
 * ═══════════════════════════════════════════════
 */
export async function resetUserSession(userId, phoneNumber) {
    try {
        await stateManager.clearUserState(userId, phoneNumber);
        console.log(`✅ Session reset for ${phoneNumber}`);
        return { success: true };
    } catch (error) {
        console.error('❌ Session reset failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * ═══════════════════════════════════════════════
 * 8. API للمطورين - الحصول على حالة المستخدم
 * ═══════════════════════════════════════════════
 */
export async function getUserSession(userId, phoneNumber) {
    try {
        const state = await stateManager.getUserState(userId, phoneNumber);
        
        if (!state) {
            return { success: true, state: null, message: 'No active session' };
        }
        
        const isValid = stateManager.isSessionValid(state.last_interaction);
        
        return {
            success: true,
            state: {
                currentNode: state.current_node_id,
                context: state.context,
                lastInteraction: state.last_interaction,
                isValid: isValid
            }
        };
    } catch (error) {
        console.error('❌ Get session failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * ═══════════════════════════════════════════════
 * 9. API للمطورين - جدولة رسالة
 * ═══════════════════════════════════════════════
 */
export async function scheduleMessageAPI(userId, phoneNumber, message, delaySeconds) {
    try {
        const result = await messageScheduler.scheduleMessage(
            userId,
            phoneNumber,
            message,
            delaySeconds
        );
        
        if (result) {
            console.log(`✅ Message scheduled for ${phoneNumber} in ${delaySeconds}s`);
            return { success: true, messageId: result.id };
        } else {
            throw new Error('Scheduling failed');
        }
    } catch (error) {
        console.error('❌ Schedule failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * ═══════════════════════════════════════════════
 * 10. API للمطورين - الحصول على إحصائيات
 * ═══════════════════════════════════════════════
 */
export async function getFlowStatsAPI(userId, flowId = 'main_flow', days = 7) {
    try {
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
        
        const stats = await flowAnalytics.getFlowStats(
            userId,
            flowId,
            startDate.toISOString(),
            endDate.toISOString()
        );
        
        return { success: true, stats };
    } catch (error) {
        console.error('❌ Get stats failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * ═══════════════════════════════════════════════
 * Utility Functions
 * ═══════════════════════════════════════════════
 */

function parseWebhookData(data) {
    // تخصيص حسب بنية الـ webhook الخاصة بك
    return {
        from: data.from || data.phone_number || data.sender,
        message: data.message || data.text || data.body,
        userId: data.user_id || data.userId,
        timestamp: data.timestamp || new Date().toISOString()
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ═══════════════════════════════════════════════
 * Global Exports
 * ═══════════════════════════════════════════════
 */

window.AutoReplyIntegration = {
    initialize: initializeAutoReplySystem,
    handleMessage: handleIncomingWhatsAppMessage,
    triggerFlow: triggerFlowManually,
    resetSession: resetUserSession,
    getSession: getUserSession,
    scheduleMessage: scheduleMessageAPI,
    getStats: getFlowStatsAPI
};

/**
 * ═══════════════════════════════════════════════
 * مثال على الاستخدام
 * ═══════════════════════════════════════════════
 */

/*

// في app.js أو index.html:

import { initializeAutoReplySystem } from './integration-example.js';

// عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', () => {
    initializeAutoReplySystem();
});

// تشغيل يدوي
await AutoReplyIntegration.triggerFlow(
    userId,
    '+966500000000',
    'main_flow'
);

// إعادة تعيين الجلسة
await AutoReplyIntegration.resetSession(userId, '+966500000000');

// جدولة رسالة
await AutoReplyIntegration.scheduleMessage(
    userId,
    '+966500000000',
    'تذكير: لديك موعد غداً',
    86400  // بعد 24 ساعة
);

// الحصول على إحصائيات
const stats = await AutoReplyIntegration.getStats(userId, 'main_flow', 30);
console.log('Stats:', stats);

*/
