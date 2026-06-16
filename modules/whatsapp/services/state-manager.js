/**
 * =====================================================
 * state-manager.js
 * إدارة حالة المستخدمين في التدفقات - SaaS Grade
 * =====================================================
 */

import { SupabaseIntegration } from '../supabase-integration.js';

export class StateManager {
    constructor() {
        this.sessionTimeout = 24 * 60 * 60 * 1000; // 24 hours
        this.cache = new Map();
    }

    /**
     * جلب حالة المستخدم
     */
    async getUserState(userId, phoneNumber) {
        const cacheKey = `${userId}_${phoneNumber}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { data, error } = await supabase
                .from('bot_user_states')
                .select('*')
                .eq('user_id', userId)
                .eq('phone_number', phoneNumber)
                .maybeSingle();
            
            if (error) throw error;
            
            if (data) this.cache.set(cacheKey, data);
            return data;
        } catch (error) {
            console.error('[StateManager] Get state failed:', error);
            return null;
        }
    }

    /**
     * حفظ حالة المستخدم
     */
    async saveUserState(userId, phoneNumber, nodeId, context = {}) {
        const cacheKey = `${userId}_${phoneNumber}`;
        const state = {
            user_id: userId,
            phone_number: phoneNumber,
            current_node_id: nodeId,
            context: context,
            last_interaction: new Date().toISOString()
        };

        this.cache.set(cacheKey, state);

        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { error } = await supabase
                .from('bot_user_states')
                .upsert(state, { onConflict: 'user_id,phone_number' });
            
            if (error) throw error;
        } catch (error) {
            console.error('[StateManager] Save state failed:', error);
        }
    }

    /**
     * مسح حالة المستخدم (عند إنهاء التدفق)
     */
    async clearUserState(userId, phoneNumber) {
        const cacheKey = `${userId}_${phoneNumber}`;
        this.cache.delete(cacheKey);

        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            await supabase
                .from('bot_user_states')
                .delete()
                .eq('user_id', userId)
                .eq('phone_number', phoneNumber);
        } catch (error) {
            console.error('[StateManager] Clear state failed:', error);
        }
    }

    /**
     * التحقق من صلاحية الجلسة
     */
    isSessionValid(lastInteraction) {
        if (!lastInteraction) return false;
        const lastDate = new Date(lastInteraction);
        const now = new Date();
        return (now - lastDate) < this.sessionTimeout;
    }

    /**
     * تحديث السياق فقط
     */
    async updateContext(userId, phoneNumber, contextUpdates) {
        const state = await this.getUserState(userId, phoneNumber);
        if (!state) return;

        const newContext = { ...state.context, ...contextUpdates };
        await this.saveUserState(userId, phoneNumber, state.current_node_id, newContext);
    }
}

export const stateManager = new StateManager();
