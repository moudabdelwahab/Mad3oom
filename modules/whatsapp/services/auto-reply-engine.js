/**
 * =====================================================
 * auto-reply-engine.js
 * محرك الرد الآلي المتقدم (V3.0) - Enterprise Grade
 * يدعم: إدارة الحالة، السياق، الجدولة، التحليلات، AI
 * =====================================================
 */

import { WhatsAppAPI } from './whatsapp-api.js';
import { SupabaseIntegration } from '../supabase-integration.js';
import { stateManager } from './state-manager.js';
import { messageScheduler } from './message-scheduler.js';
import { flowAnalytics } from './flow-analytics.js';

export class AutoReplyEngine {
    constructor() {
        this.flowCache = new Map();
        this.executionLog = [];
        this.maxExecutionTime = 30000; // 30 seconds
        this.sessionTimeout = 24 * 60 * 60 * 1000; // 24 hours
        this.aiEnabled = true;
        this.httpTimeout = 10000;
        
        // تشغيل جدولة الرسائل
        messageScheduler.start();
    }

    /**
     * تنفيذ التدفق بناءً على رسالة واردة مع إدارة الحالة
     */
    async executeFlow(flow, incomingMessage, userId, phone_number, flowId = 'default') {
        const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const startTime = Date.now();
        const visitedNodes = [];

        try {
            // 1. جلب حالة المستخدم من StateManager
            const userState = await stateManager.getUserState(userId, phone_number);
            let currentNodeId = userState?.current_node_id;
            let context = userState?.context || {};
            
            // إضافة بيانات الرسالة الواردة للسياق
            context._incoming_message = incomingMessage;
            context._timestamp = new Date().toISOString();

            // 2. تحديد نقطة البداية
            let startNodeId;
            if (currentNodeId && stateManager.isSessionValid(userState?.last_interaction)) {
                // استمرار الجلسة
                startNodeId = currentNodeId;
                console.log(`[AutoReplyEngine] Resuming flow for ${phone_number} from node ${startNodeId}`);
                await flowAnalytics.trackNodeEntry(userId, phone_number, flowId, startNodeId, 'resume');
            } else {
                // بداية جديدة
                const startNode = this.findNodeByType(flow, 'start');
                if (!startNode) throw new Error('لم يتم العثور على نقطة البداية في التدفق');
                startNodeId = startNode.id;
                context = { _incoming_message: incomingMessage, _timestamp: new Date().toISOString() };
                console.log(`[AutoReplyEngine] Starting new flow for ${phone_number}`);
                await flowAnalytics.trackNodeEntry(userId, phone_number, flowId, startNodeId, 'start');
            }

            // 3. تنفيذ التدفق
            const result = await this.executeNode(
                flow,
                startNodeId,
                incomingMessage,
                userId,
                executionId,
                visitedNodes,
                context,
                phone_number,
                flowId
            );

            // 4. حفظ الحالة
            if (result.nextNodeId) {
                await stateManager.saveUserState(userId, phone_number, result.nextNodeId, result.context);
            } else {
                // التدفق انتهى، مسح الحالة
                await stateManager.clearUserState(userId, phone_number);
                await flowAnalytics.trackFlowCompletion(userId, phone_number, flowId, Date.now() - startTime, visitedNodes.length);
            }

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
            await flowAnalytics.trackFlowError(userId, phone_number, flowId, visitedNodes[visitedNodes.length - 1] || 'unknown', error.message);
            
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
    async executeNode(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId = 'default') {
        const nodeStartTime = Date.now();
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
        
        // تتبع دخول العقدة
        await flowAnalytics.trackNodeEntry(userId, phone_number, flowId, nodeId, node.class);

        try {
            await this.executeNodeLogic(node, message, context, userId, phone_number, flowId, flow, nodeId, executionId, visitedNodes, responses);
        } catch (error) {
            await flowAnalytics.trackNodeExit(userId, phone_number, flowId, nodeId, Date.now() - nodeStartTime, false);
            throw error;
        }
        
        await flowAnalytics.trackNodeExit(userId, phone_number, flowId, nodeId, Date.now() - nodeStartTime, true);

        switch (node.class) {
            case 'start-node-v2':
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number);

            case 'message-node-v2':
                const messageText = this.replaceVariables(node.data.message || '', context);
                const delay = parseInt(node.data.delay) || 0;

                if (delay > 0) {
                    // جدولة الرسالة بدلاً من الانتظار المباشر
                    await messageScheduler.scheduleMessage(
                        userId,
                        phone_number,
                        messageText,
                        delay,
                        { nodeId, flowId, executionId }
                    );
                } else {
                    responses.push({ type: 'text', content: messageText });
                }
                
                // إذا كانت العقدة مهيأة لانتظار الرد، نتوقف هنا
                if (node.data.waitForInput) {
                    const nextId = this.findNextNode(flow.drawflow.Home.links, nodeId, 1);
                    return { responses, nextNodeId: nextId, context };
                }

                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId, responses);

            case 'condition-node-v2':
                const keyword = node.data.keyword || '';
                const matchType = node.data.matchType || 'contains';
                const conditionMet = this.evaluateCondition(message, keyword, matchType);
                
                // تتبع نتيجة الشرط
                await flowAnalytics.trackConditionResult(userId, phone_number, flowId, nodeId, keyword, conditionMet);

                nextNodeId = conditionMet ? 
                    this.findNextNode(flow.drawflow.Home.links, nodeId, 1) :
                    this.findNextNode(flow.drawflow.Home.links, nodeId, 2);

                if (nextNodeId) {
                    return await this.executeNode(flow, nextNodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId);
                }
                return { responses: [], nextNodeId: null, context };

            case 'ai-node-v2':
                if (!this.aiEnabled) {
                    console.warn('[AI Node] AI is disabled');
                    return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId, responses);
                }
                
                const prompt = this.replaceVariables(node.data.prompt || '', context);
                const model = node.data.model || 'gpt-3.5-turbo';
                
                try {
                    const aiResponse = await this.generateAIResponse(prompt, message, model, context);
                    responses.push({ type: 'text', content: aiResponse });
                    
                    // تخزين الرد في السياق
                    if (node.data.saveToContext) {
                        const varName = node.data.contextVar || 'ai_last_response';
                        context[varName] = aiResponse;
                        await stateManager.updateContext(userId, phone_number, { [varName]: aiResponse });
                    }
                } catch (error) {
                    console.error(`[AI Node Error] ${error.message}`);
                    responses.push({ type: 'text', content: 'عذراً، حدث خطأ في معالجة طلبك.' });
                }

                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId, responses);

            case 'http-node-v2':
                try {
                    const httpRes = await this.makeHttpRequest(
                        this.replaceVariables(node.data.url, context),
                        node.data.method || 'POST',
                        { message, context, userId, phoneNumber: phone_number }
                    );
                    
                    if (node.data.saveToContext && node.data.contextVar) {
                        context[node.data.contextVar] = httpRes.data;
                        await stateManager.updateContext(userId, phone_number, { [node.data.contextVar]: httpRes.data });
                    }
                } catch (e) {
                    console.error('[HTTP Node Error]', e);
                    if (node.data.onError === 'fail') {
                        throw e;
                    }
                }
                
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId);

            case 'buttons-node-v2':
                const btnMessage = this.replaceVariables(node.data.message || '', context);
                const buttons = (node.data.buttons || '').split(',').map(b => b.trim()).filter(b => b);
                
                responses.push({ type: 'buttons', content: btnMessage, buttons });
                
                if (node.data.waitForInput) {
                    const nextId = this.findNextNode(flow.drawflow.Home.links, nodeId, 1);
                    return { responses, nextNodeId: nextId, context };
                }
                
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId, responses);

            case 'media-node-v2':
                const mediaUrl = this.replaceVariables(node.data.mediaUrl || '', context);
                const caption = this.replaceVariables(node.data.caption || '', context);
                
                responses.push({ type: node.data.mediaType || 'image', url: mediaUrl, caption });
                
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId, responses);

            case 'delay-node-v2':
                const seconds = parseInt(node.data.seconds) || 3;
                await this.sleep(Math.min(seconds * 1000, 10000));
                
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId, responses);

            case 'random-node-v2':
                const ratio = parseInt(node.data.ratio) || 50;
                const random = Math.random() * 100;
                const outputIndex = random < ratio ? 1 : 2;
                
                nextNodeId = this.findNextNode(flow.drawflow.Home.links, nodeId, outputIndex);
                if (nextNodeId) {
                    return await this.executeNode(flow, nextNodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId);
                }
                return { responses, nextNodeId: null, context };

            case 'end-node-v2':
                return { responses, nextNodeId: null, context };

            default:
                return await this.executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId, responses);
        }
    }
    
    async executeNodeLogic(node, message, context, userId, phone_number, flowId, flow, nodeId, executionId, visitedNodes, responses) {
        // Placeholder for custom node logic hooks
    }

    /**
     * تنفيذ العقدة التالية وجمع الردود
     */
    async executeNext(flow, nodeId, message, userId, executionId, visitedNodes, context, phone_number, flowId, currentResponses = []) {
        const nextId = this.findNextNode(flow.drawflow.Home.links, nodeId, 1);
        if (!nextId) return { responses: currentResponses, nextNodeId: null, context };

        const nextResult = await this.executeNode(flow, nextId, message, userId, executionId, visitedNodes, context, phone_number, flowId);
        return {
            responses: [...currentResponses, ...nextResult.responses],
            nextNodeId: nextResult.nextNodeId,
            context: nextResult.context
        };
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

    async generateAIResponse(prompt, userMessage, model, context) {
        try {
            // استدعاء OpenAI API (يتطلب API key)
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content: userMessage }
                    ],
                    temperature: parseFloat(context._ai_temperature || 0.7),
                    max_tokens: 500
                })
            });
            
            if (!response.ok) throw new Error('AI API request failed');
            
            const data = await response.json();
            return data.choices[0]?.message?.content || 'لا يوجد رد من الذكاء الاصطناعي';
        } catch (error) {
            console.error('[AI Error]', error);
            return `رد تلقائي: شكراً لرسالتك "${userMessage}". سنرد عليك قريباً.`;
        }
    }

    async makeHttpRequest(url, method, body) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.httpTimeout);
            
            const response = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: method !== 'GET' ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            return { success: true, data };
        } catch (error) {
            console.error('[HTTP Request Error]', error);
            return { success: false, error: error.message };
        }
    }

    logExecution(log) {
        this.executionLog.push(log);
        if (this.executionLog.length > 100) this.executionLog.shift();
    }
}

export const autoReplyEngine = new AutoReplyEngine();
