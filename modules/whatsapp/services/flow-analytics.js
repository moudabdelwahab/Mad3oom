/**
 * =====================================================
 * flow-analytics.js
 * تحليلات متقدمة للتدفقات - SaaS Analytics
 * =====================================================
 */

import { SupabaseIntegration } from '../supabase-integration.js';

export class FlowAnalytics {
    constructor() {
        this.eventQueue = [];
        this.flushInterval = 5000; // 5 seconds
        this.startAutoFlush();
    }

    /**
     * تتبع دخول عقدة
     */
    async trackNodeEntry(userId, phoneNumber, flowId, nodeId, nodeType) {
        const event = {
            user_id: userId,
            phone_number: phoneNumber,
            flow_id: flowId,
            node_id: nodeId,
            node_type: nodeType,
            event_type: 'node_entry',
            timestamp: new Date().toISOString()
        };
        
        this.eventQueue.push(event);
        
        if (this.eventQueue.length >= 100) {
            await this.flush();
        }
    }

    /**
     * تتبع خروج من عقدة
     */
    async trackNodeExit(userId, phoneNumber, flowId, nodeId, duration, success = true) {
        const event = {
            user_id: userId,
            phone_number: phoneNumber,
            flow_id: flowId,
            node_id: nodeId,
            event_type: 'node_exit',
            duration_ms: duration,
            success: success,
            timestamp: new Date().toISOString()
        };
        
        this.eventQueue.push(event);
    }

    /**
     * تتبع إكمال التدفق
     */
    async trackFlowCompletion(userId, phoneNumber, flowId, totalDuration, nodesVisited) {
        const event = {
            user_id: userId,
            phone_number: phoneNumber,
            flow_id: flowId,
            event_type: 'flow_completed',
            total_duration_ms: totalDuration,
            nodes_visited: nodesVisited,
            timestamp: new Date().toISOString()
        };
        
        this.eventQueue.push(event);
        await this.flush();
    }

    /**
     * تتبع فشل التدفق
     */
    async trackFlowError(userId, phoneNumber, flowId, nodeId, errorMessage) {
        const event = {
            user_id: userId,
            phone_number: phoneNumber,
            flow_id: flowId,
            node_id: nodeId,
            event_type: 'flow_error',
            error_message: errorMessage,
            timestamp: new Date().toISOString()
        };
        
        this.eventQueue.push(event);
        await this.flush();
    }

    /**
     * تتبع نقر على زر
     */
    async trackButtonClick(userId, phoneNumber, flowId, nodeId, buttonText) {
        const event = {
            user_id: userId,
            phone_number: phoneNumber,
            flow_id: flowId,
            node_id: nodeId,
            event_type: 'button_click',
            button_text: buttonText,
            timestamp: new Date().toISOString()
        };
        
        this.eventQueue.push(event);
    }

    /**
     * تتبع شرط (نعم/لا)
     */
    async trackConditionResult(userId, phoneNumber, flowId, nodeId, condition, result) {
        const event = {
            user_id: userId,
            phone_number: phoneNumber,
            flow_id: flowId,
            node_id: nodeId,
            event_type: 'condition_result',
            condition: condition,
            result: result,
            timestamp: new Date().toISOString()
        };
        
        this.eventQueue.push(event);
    }

    /**
     * حفظ الأحداث في قاعدة البيانات
     */
    async flush() {
        if (this.eventQueue.length === 0) return;
        
        const events = [...this.eventQueue];
        this.eventQueue = [];
        
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { error } = await supabase
                .from('flow_analytics_events')
                .insert(events);
            
            if (error) throw error;
            console.log(`[FlowAnalytics] Flushed ${events.length} events`);
        } catch (error) {
            console.error('[FlowAnalytics] Flush failed:', error);
            // إعادة الأحداث للمحاولة مرة أخرى
            this.eventQueue.unshift(...events);
        }
    }

    /**
     * بدء الحفظ التلقائي
     */
    startAutoFlush() {
        setInterval(() => {
            this.flush();
        }, this.flushInterval);
    }

    /**
     * الحصول على إحصائيات التدفق
     */
    async getFlowStats(userId, flowId, startDate, endDate) {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            
            // عدد التنفيذات
            const { count: totalExecutions } = await supabase
                .from('flow_analytics_events')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('flow_id', flowId)
                .eq('event_type', 'flow_completed')
                .gte('timestamp', startDate)
                .lte('timestamp', endDate);
            
            // متوسط المدة
            const { data: completions } = await supabase
                .from('flow_analytics_events')
                .select('total_duration_ms')
                .eq('user_id', userId)
                .eq('flow_id', flowId)
                .eq('event_type', 'flow_completed')
                .gte('timestamp', startDate)
                .lte('timestamp', endDate);
            
            const avgDuration = completions && completions.length > 0
                ? completions.reduce((sum, e) => sum + (e.total_duration_ms || 0), 0) / completions.length
                : 0;
            
            // معدل الأخطاء
            const { count: errorCount } = await supabase
                .from('flow_analytics_events')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('flow_id', flowId)
                .eq('event_type', 'flow_error')
                .gte('timestamp', startDate)
                .lte('timestamp', endDate);
            
            const errorRate = totalExecutions > 0 ? (errorCount / totalExecutions) * 100 : 0;
            
            // العقد الأكثر زيارة
            const { data: nodeVisits } = await supabase
                .from('flow_analytics_events')
                .select('node_id, node_type')
                .eq('user_id', userId)
                .eq('flow_id', flowId)
                .eq('event_type', 'node_entry')
                .gte('timestamp', startDate)
                .lte('timestamp', endDate);
            
            const nodeStats = {};
            (nodeVisits || []).forEach(visit => {
                if (!nodeStats[visit.node_id]) {
                    nodeStats[visit.node_id] = { count: 0, type: visit.node_type };
                }
                nodeStats[visit.node_id].count++;
            });
            
            return {
                totalExecutions: totalExecutions || 0,
                avgDuration: Math.round(avgDuration),
                errorRate: Math.round(errorRate * 100) / 100,
                errorCount: errorCount || 0,
                nodeStats
            };
        } catch (error) {
            console.error('[FlowAnalytics] Get stats failed:', error);
            return null;
        }
    }

    /**
     * الحصول على مسار المستخدمين (User Journey)
     */
    async getUserJourneys(userId, flowId, limit = 10) {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            
            const { data, error } = await supabase
                .from('flow_analytics_events')
                .select('phone_number, node_id, node_type, event_type, timestamp')
                .eq('user_id', userId)
                .eq('flow_id', flowId)
                .order('timestamp', { ascending: false })
                .limit(limit * 10);
            
            if (error) throw error;
            
            // تجميع الأحداث حسب رقم الهاتف
            const journeys = {};
            (data || []).forEach(event => {
                if (!journeys[event.phone_number]) {
                    journeys[event.phone_number] = [];
                }
                journeys[event.phone_number].push(event);
            });
            
            return Object.entries(journeys).slice(0, limit).map(([phone, events]) => ({
                phoneNumber: phone,
                path: events.map(e => e.node_id),
                events: events
            }));
        } catch (error) {
            console.error('[FlowAnalytics] Get journeys failed:', error);
            return [];
        }
    }
}

export const flowAnalytics = new FlowAnalytics();
