/**
 * =====================================================
 * auto-reply-engine.js
 * محرك الرد الآلي المتقدم (V2.1)
 * يدعم: إدارة الحالة (State Management)، سياق المستخدم (User Context)،
 * الاستمرارية (Persistence)، والانتظار للمدخلات (Waiting for Input).
 * =====================================================
 */

import { WhatsAppAPI } from './whatsapp-api.js';
import { SupabaseIntegration } from '../supabase-integration.js';

export class AutoReplyEngine {
    constructor() {
        this.flowCache = new Map();
        this.executionLog = [];
        this.maxExecutionTime = 30000; // 30 seconds
        this.sessionTimeout = 24 * 60 * 60 * 1000; // 24 hours
    }

    /**
     * تنفيذ التدفق بناءً على رسالة واردة مع إدارة الحالة
     */
    async executeFlow(flow, incomingMessage, userId, phone_number) {
        const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const startTime = Date.now();

        try {
            // 1. جلب حالة المستخدم الحالية من قاعدة البيانات
            const userState = await this.getUserState(userId, phone_number);
            let currentNodeId = userState?.current_node_id;
            let context = userState?.context || {};

            // 2. تحديد نقطة البداية
            let startNodeId;
            if (currentNodeId && this.isSessionValid(userState.last_interaction)) {
                // إذا كان هناك حالة سابقة وجلسة صالحة، نكمل من العقدة التالية
                // ملاحظة: العقدة الحالية هي العقدة التي كان ينتظر عندها الرد
                startNodeId = currentNodeId;
                console.log(`[AutoReplyEngine] Resuming flow for ${phone_number} from node ${startNodeId}`);
            } else {
                // إذا لم تكن هناك حالة أو الجلسة منتهية، نبدأ من البداية
                const startNode = this.findNodeByType(flow, 'start');
                if (!startNode) throw new Error('لم يتم العثور على نقطة البداية في التدفق');
                startNodeId = startNode.id;
                context = {}; // إعادة تعيين السياق للبداية الجديدة
                console.log(`[AutoReplyEngine] Starting new flow for ${phone_number}`);
            }

            // 3. تنفيذ التدفق
            const result = await this.executeNode(
                flow,
                startNodeId,
                incomingMessage,
                userId,
                executionId,
                [],
                context,
                phone_number
            );

            // 4. تحديث حالة المستخدم في قاعدة البيانات
            await this.updateUserState(userId, phone_number, result.nextNodeId, result.context);

            const executionTime = Date.now() - startTime;

            // Log execution
            this.logExecution({
                executionId,
                userId,
                phone_number,
                message: incomingMessage,
                result,
                duration: executionTime,
                timestamp: new Date().toISOString()
            });

            return result;
        } catch (error) {
            console.error(`[AutoReplyEngine] Execution failed: ${error.message}`);
            this.logExecution({
                executionId,
                userId,
                phone_number,
                message: incomingMessage,
                error: error.message,
                duration: Date.now() - startTime,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    /**
     * تنفيذ عقدة واحدة مع دعم السياق والانتظار
     */
    async executeNode(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number) {
        // Prevent infinite loops
        if (visitedNodes.includes(nodeId)) {
            throw new Error('تم اكتشاف حلقة لا نهائية في التدفق');
        }

        const node = flow.drawflow.Home.data[nodeId];
        if (!node) {
            return { responses: [], nextNodeId: null, context };
        }

        visitedNodes.push(nodeId);
        let responses = [];
        let nextNodeId = null;

        switch (node.class) {
            case 'start-node-v2':
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number);

            case 'message-node-v2':
                const messageText = this.replaceVariables(node.data.message || '', context);
                const delay = parseInt(node.data.delay) || 0;

                if (delay > 0) await this.sleep(Math.min(delay * 1000, 5000));

                responses.push({ type: 'text', content: messageText });
                
                // إذا كانت العقدة مهيأة لانتظار الرد، نتوقف هنا ونخزن العقدة التالية
                if (node.data.waitForInput) {
                    const nextId = this.findNextNode(flow.drawflow.Home.links, nodeId, 1);
                    return { responses, nextNodeId: nextId, context };
                }

                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, responses);

            case 'condition-node-v2':
                const keyword = node.data.keyword || '';
                const matchType = node.data.matchType || 'contains';
                const conditionMet = this.evaluateCondition(message, keyword, matchType);

                nextNodeId = conditionMet ? 
                    this.findNextNode(flow.drawflow.Home.links, nodeId, 1) :
                    this.findNextNode(flow.drawflow.Home.links, nodeId, 2);

                if (nextNodeId) {
                    return await this.executeNode(flow, nextNodeId, message, userId, executionId, visitedNodes, context, phone_number);
                }
                return { responses: [], nextNodeId: null, context };

            case 'ai-node-v2':
                const prompt = this.replaceVariables(node.data.prompt || '', context);
                const model = node.data.model || 'gpt-3.5-turbo';
                
                try {
                    const aiResponse = await this.generateAIResponse(prompt, message, model, context);
                    responses.push({ type: 'text', content: aiResponse });
                    
                    // تخزين الرد في السياق إذا طلب ذلك
                    if (node.data.saveToContext) {
                        context[node.data.contextVar || 'ai_last_response'] = aiResponse;
                    }
                } catch (error) {
                    console.error(`[AI Node Error] ${error.message}`);
                }

                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, responses);

            case 'http-node-v2':
                // تنفيذ طلب HTTP وتخزين النتيجة في السياق
                try {
                    const httpRes = await this.makeHttpRequest(node.data.url, node.data.method, { message, context });
                    if (node.data.saveToContext && node.data.contextVar) {
                        context[node.data.contextVar] = httpRes.data;
                    }
                } catch (e) { console.error(e); }
                
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number);

            case 'end-node-v2':
                return { responses, nextNodeId: null, context: {} }; // مسح السياق عند النهاية

            default:
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, responses);
        }
    }

    /**
     * تنفيذ العقدة التالية وجمع الردود
     */
    async executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, currentResponses = []) {
        const nextId = this.findNextNode(flow.drawflow.Home.links, nodeId, 1);
        if (!nextId) return { responses: currentResponses, nextNodeId: null, context };

        const nextResult = await this.executeNode(flow, nextId, message, userId, executionId, visitedNodes, context, phone_number);
        return {
            responses: [...currentResponses, ...nextResult.responses],
            nextNodeId: nextResult.nextNodeId,
            context: nextResult.context
        };
    }

    /**
     * جلب حالة المستخدم من Supabase
     */
    async getUserState(userId, phone_number) {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { data, error } = await supabase
                .from('bot_user_states')
                .select('*')
                .eq('user_id', userId)
                .eq('phone_number', phone_number)
                .maybeSingle();
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('[AutoReplyEngine] Failed to get user state:', error);
            return null;
        }
    }

    /**
     * تحديث حالة المستخدم في Supabase
     */
    async updateUserState(userId, phone_number, nextNodeId, context) {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { error } = await supabase
                .from('bot_user_states')
                .upsert({
                    user_id: userId,
                    phone_number: phone_number,
                    current_node_id: nextNodeId,
                    context: context,
                    last_interaction: new Date().toISOString()
                }, { onConflict: 'user_id, phone_number' });
            
            if (error) throw error;
        } catch (error) {
            console.error('[AutoReplyEngine] Failed to update user state:', error);
        }
    }

    /**
     * استبدال المتغيرات في النصوص من السياق
     * مثال: "مرحباً {{name}}" -> "مرحباً محمد"
     */
    replaceVariables(text, context) {
        return text.replace(/\{\{(.*?)\}\}/g, (match, varName) => {
            return context[varName.trim()] || match;
        });
    }

    /**
     * التحقق من صلاحية الجلسة (أقل من 24 ساعة)
     */
    isSessionValid(lastInteraction) {
        if (!lastInteraction) return false;
        const lastDate = new Date(lastInteraction);
        const now = new Date();
        return (now - lastDate) < this.sessionTimeout;
    }

    /**
     * تقييم الشرط
     */
    evaluateCondition(message, keyword, matchType) {
        const msg = (message || '').toLowerCase();
        const key = (keyword || '').toLowerCase();
        if (matchType === 'contains') return msg.includes(key);
        if (matchType === 'equals') return msg === key;
        if (matchType === 'startsWith') return msg.startsWith(key);
        return false;
    }

    /**
     * البحث عن العقدة التالية في الروابط
     */
    findNextNode(links, nodeId, outputIndex) {
        for (const id in links) {
            const link = links[id];
            if (link.origin_node == nodeId && link.origin_output == outputIndex) {
                return link.target_node;
            }
        }
        return null;
    }

    /**
     * البحث عن عقدة حسب النوع
     */
    findNodeByType(flow, type) {
        const data = flow.drawflow.Home.data;
        for (const id in data) {
            if (data[id].class === `${type}-node-v2` || data[id].class === `${type}-node`) {
                return { id, ...data[id] };
            }
        }
        return null;
    }

    async sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async generateAIResponse(prompt, message, model, context) {
        // محاكاة استدعاء AI (يجب ربطه بـ API حقيقي)
        return `رد ذكي محاكى بناءً على: ${message}`;
    }

    async makeHttpRequest(url, method, body) {
        // محاكاة طلب HTTP
        return { data: { status: 'success' } };
    }

    logExecution(log) {
        this.executionLog.push(log);
        if (this.executionLog.length > 100) this.executionLog.shift();
    }
}

export const autoReplyEngine = new AutoReplyEngine();
