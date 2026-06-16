/**
 * =====================================================
 * message-scheduler.js
 * جدولة وإرسال الرسائل المتأخرة - Enterprise Level
 * =====================================================
 */

import { SupabaseIntegration } from '../supabase-integration.js';
import { WhatsAppAPI } from './whatsapp-api.js';

export class MessageScheduler {
    constructor() {
        this.pollingInterval = 10000; // 10 seconds
        this.isRunning = false;
        this.scheduledJobs = new Map();
    }

    /**
     * بدء مراقبة الرسائل المجدولة
     */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.poll();
        console.log('[MessageScheduler] Started');
    }

    /**
     * إيقاف المراقبة
     */
    stop() {
        this.isRunning = false;
        console.log('[MessageScheduler] Stopped');
    }

    /**
     * جدولة رسالة متأخرة
     */
    async scheduleMessage(userId, phoneNumber, message, delaySeconds, metadata = {}) {
        const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { data, error } = await supabase
                .from('scheduled_messages')
                .insert({
                    user_id: userId,
                    phone_number: phoneNumber,
                    message: message,
                    scheduled_at: scheduledAt,
                    status: 'pending',
                    metadata: metadata
                })
                .select()
                .single();
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('[MessageScheduler] Schedule failed:', error);
            return null;
        }
    }

    /**
     * مراقبة وإرسال الرسائل المستحقة
     */
    async poll() {
        while (this.isRunning) {
            await this.processPendingMessages();
            await new Promise(r => setTimeout(r, this.pollingInterval));
        }
    }

    /**
     * معالجة الرسائل المعلقة
     */
    async processPendingMessages() {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const now = new Date().toISOString();
            
            const { data: messages, error } = await supabase
                .from('scheduled_messages')
                .select('*')
                .eq('status', 'pending')
                .lte('scheduled_at', now)
                .limit(50);
            
            if (error) throw error;
            
            for (const msg of messages || []) {
                await this.sendScheduledMessage(msg);
            }
        } catch (error) {
            console.error('[MessageScheduler] Poll failed:', error);
        }
    }

    /**
     * إرسال رسالة مجدولة
     */
    async sendScheduledMessage(scheduledMsg) {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            
            // إرسال الرسالة
            const result = await WhatsAppAPI.sendMessage(
                scheduledMsg.user_id,
                scheduledMsg.phone_number,
                scheduledMsg.message
            );
            
            if (result.success) {
                // تحديث الحالة إلى مرسل
                await supabase
                    .from('scheduled_messages')
                    .update({
                        status: 'sent',
                        sent_at: new Date().toISOString(),
                        whatsapp_message_id: result.messageId
                    })
                    .eq('id', scheduledMsg.id);
                
                console.log(`[MessageScheduler] Sent message ${scheduledMsg.id}`);
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error(`[MessageScheduler] Send failed for ${scheduledMsg.id}:`, error);
            
            // تحديث الحالة إلى فشل
            const supabase = await SupabaseIntegration.initializeSupabase();
            await supabase
                .from('scheduled_messages')
                .update({
                    status: 'failed',
                    error_message: error.message
                })
                .eq('id', scheduledMsg.id);
        }
    }

    /**
     * إلغاء رسالة مجدولة
     */
    async cancelScheduledMessage(messageId) {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { error } = await supabase
                .from('scheduled_messages')
                .update({ status: 'cancelled' })
                .eq('id', messageId);
            
            if (error) throw error;
            return true;
        } catch (error) {
            console.error('[MessageScheduler] Cancel failed:', error);
            return false;
        }
    }

    /**
     * الحصول على الرسائل المجدولة للمستخدم
     */
    async getScheduledMessages(userId, status = 'pending') {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { data, error } = await supabase
                .from('scheduled_messages')
                .select('*')
                .eq('user_id', userId)
                .eq('status', status)
                .order('scheduled_at', { ascending: true });
            
            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('[MessageScheduler] Get scheduled failed:', error);
            return [];
        }
    }
}

export const messageScheduler = new MessageScheduler();
