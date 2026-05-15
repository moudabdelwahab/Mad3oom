/**
 * =====================================================
 * auto-reply-engine.js
 * محرك الرد الآلي المتقدم
 * يدعم تنفيذ التدفقات المعقدة والذكاء الاصطناعي
 * =====================================================
 */

import { WhatsAppAPI } from './whatsapp-api.js';

export class AutoReplyEngine {
    constructor() {
        this.flowCache = new Map();
        this.executionLog = [];
        this.maxExecutionTime = 30000; // 30 seconds
    }

    /**
     * تنفيذ التدفق بناءً على رسالة واردة
     */
    async executeFlow(flow, incomingMessage, userId) {
        const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const startTime = Date.now();

        try {
            // Find start node
            const startNode = this.findNodeByType(flow, 'start');
            if (!startNode) {
                throw new Error('لم يتم العثور على نقطة البداية في التدفق');
            }

            // Execute flow from start node
            const result = await this.executeNode(
                flow,
                startNode.id,
                incomingMessage,
                userId,
                executionId,
                []
            );

            const executionTime = Date.now() - startTime;

            // Log execution
            this.logExecution({
                executionId,
                userId,
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
                message: incomingMessage,
                error: error.message,
                duration: Date.now() - startTime,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    /**
     * تنفيذ عقدة واحدة
     */
    async executeNode(flow, nodeId, message, userId, executionId, visitedNodes) {
        // Prevent infinite loops
        if (visitedNodes.includes(nodeId)) {
            throw new Error('تم اكتشاف حلقة لا نهائية في التدفق');
        }

        const node = flow.drawflow.Home.data[nodeId];
        if (!node) {
            throw new Error(`لم يتم العثور على العقدة: ${nodeId}`);
        }

        visitedNodes.push(nodeId);
        const responses = [];

        switch (node.class) {
            case 'start-node-v2':
                // Execute connected nodes
                return await this.executeConnectedNodes(flow, nodeId, message, userId, executionId, visitedNodes);

            case 'message-node-v2':
                // Send text message
                const messageText = node.data.message || '';
                const delay = parseInt(node.data.delay) || 0;

                if (delay > 0) {
                    await this.sleep(Math.min(delay * 1000, 5000)); // Max 5 seconds
                }

                responses.push({
                    type: 'text',
                    content: messageText,
                    timestamp: new Date().toISOString()
                });

                // Continue to next nodes
                return {
                    responses,
                    nextNodes: await this.executeConnectedNodes(flow, nodeId, message, userId, executionId, visitedNodes)
                };

            case 'media-node-v2':
                // Send media (image, video, document)
                const mediaUrl = node.data.mediaUrl || '';
                const mediaType = node.data.mediaType || 'image';
                const caption = node.data.caption || '';

                responses.push({
                    type: 'media',
                    mediaType,
                    url: mediaUrl,
                    caption,
                    timestamp: new Date().toISOString()
                });

                return {
                    responses,
                    nextNodes: await this.executeConnectedNodes(flow, nodeId, message, userId, executionId, visitedNodes)
                };

            case 'buttons-node-v2':
                // Send interactive buttons
                const buttonMessage = node.data.message || '';
                const buttonsText = node.data.buttons || '';
                const buttons = buttonsText.split(',').map(b => b.trim()).filter(b => b);

                responses.push({
                    type: 'buttons',
                    message: buttonMessage,
                    buttons,
                    timestamp: new Date().toISOString()
                });

                return {
                    responses,
                    nextNodes: await this.executeConnectedNodes(flow, nodeId, message, userId, executionId, visitedNodes)
                };

            case 'condition-node-v2':
                // Evaluate condition
                const keyword = node.data.keyword || '';
                const matchType = node.data.matchType || 'contains';
                const conditionMet = this.evaluateCondition(message, keyword, matchType);

                // Route to appropriate next node
                const connections = flow.drawflow.Home.links;
                const nextNodeId = conditionMet ? 
                    this.findNextNode(connections, nodeId, 1) :
                    this.findNextNode(connections, nodeId, 2);

                if (nextNodeId) {
                    return await this.executeNode(flow, nextNodeId, message, userId, executionId, visitedNodes);
                }
                break;

            case 'delay-node-v2':
                // Add delay
                const delaySeconds = parseInt(node.data.seconds) || 1;
                await this.sleep(Math.min(delaySeconds * 1000, 10000)); // Max 10 seconds

                return await this.executeConnectedNodes(flow, nodeId, message, userId, executionId, visitedNodes);

            case 'random-node-v2':
                // Random distribution (A/B testing)
                const ratio = parseInt(node.data.ratio) || 50;
                const random = Math.random() * 100;
                const outputIndex = random < ratio ? 1 : 2;

                const randomConnections = flow.drawflow.Home.links;
                const randomNextNodeId = this.findNextNode(randomConnections, nodeId, outputIndex);

                if (randomNextNodeId) {
                    return await this.executeNode(flow, randomNextNodeId, message, userId, executionId, visitedNodes);
                }
                break;

            case 'http-node-v2':
                // Make HTTP request
                const url = node.data.url || '';
                const method = node.data.method || 'POST';
                const timeout = parseInt(node.data.timeout) || 10;

                try {
                    const httpResponse = await this.makeHttpRequest(url, method, message, timeout);
                    responses.push({
                        type: 'http_response',
                        status: httpResponse.status,
                        data: httpResponse.data,
                        timestamp: new Date().toISOString()
                    });
                } catch (error) {
                    console.error(`[AutoReplyEngine] HTTP request failed: ${error.message}`);
                }

                return {
                    responses,
                    nextNodes: await this.executeConnectedNodes(flow, nodeId, message, userId, executionId, visitedNodes)
                };

            case 'ai-node-v2':
                // AI-powered response
                const prompt = node.data.prompt || '';
                const model = node.data.model || 'gpt-3.5-turbo';
                const temperature = parseFloat(node.data.temperature) || 0.7;

                try {
                    const aiResponse = await this.generateAIResponse(prompt, message, model, temperature);
                    responses.push({
                        type: 'ai_response',
                        content: aiResponse,
                        model,
                        timestamp: new Date().toISOString()
                    });
                } catch (error) {
                    console.error(`[AutoReplyEngine] AI generation failed: ${error.message}`);
                }

                return {
                    responses,
                    nextNodes: await this.executeConnectedNodes(flow, nodeId, message, userId, executionId, visitedNodes)
                };

            case 'end-node-v2':
                // End of flow
                return {
                    responses,
                    isEnd: true
                };

            default:
                throw new Error(`نوع عقدة غير معروف: ${node.class}`);
        }
    }

    /**
     * تنفيذ العقد المتصلة
     */
    async executeConnectedNodes(flow, nodeId, message, userId, executionId, visitedNodes) {
        const connections = flow.drawflow.Home.links;
        const nextNodeIds = this.findAllNextNodes(connections, nodeId);

        const results = [];
        for (const nextNodeId of nextNodeIds) {
            const result = await this.executeNode(flow, nextNodeId, message, userId, executionId, visitedNodes);
            results.push(result);
        }

        return results;
    }

    /**
     * تقييم الشرط
     */
    evaluateCondition(message, keyword, matchType) {
        const messageLower = message.toLowerCase();
        const keywordLower = keyword.toLowerCase();

        switch (matchType) {
            case 'contains':
                return messageLower.includes(keywordLower);
            case 'equals':
                return messageLower === keywordLower;
            case 'startsWith':
                return messageLower.startsWith(keywordLower);
            default:
                return false;
        }
    }

    /**
     * البحث عن العقدة التالية
     */
    findNextNode(connections, nodeId, outputIndex) {
        for (const connectionId in connections) {
            const connection = connections[connectionId];
            if (connection.origin_node === nodeId && connection.origin_output === outputIndex) {
                return connection.target_node;
            }
        }
        return null;
    }

    /**
     * البحث عن جميع العقد التالية
     */
    findAllNextNodes(connections, nodeId) {
        const nextNodes = [];
        for (const connectionId in connections) {
            const connection = connections[connectionId];
            if (connection.origin_node === nodeId) {
                nextNodes.push(connection.target_node);
            }
        }
        return nextNodes;
    }

    /**
     * البحث عن عقدة حسب النوع
     */
    findNodeByType(flow, nodeType) {
        const data = flow.drawflow.Home.data;
        for (const nodeId in data) {
            const node = data[nodeId];
            if (node.class === `${nodeType}-node-v2` || node.class === `${nodeType}-node`) {
                return { id: nodeId, ...node };
            }
        }
        return null;
    }

    /**
     * إرسال طلب HTTP
     */
    async makeHttpRequest(url, method, message, timeout) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

        try {
            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message,
                    timestamp: new Date().toISOString()
                }),
                signal: controller.signal
            });

            const data = await response.json();
            return {
                status: response.status,
                data
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * توليد رد ذكي باستخدام AI
     */
    async generateAIResponse(prompt, message, model, temperature) {
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        {
                            role: 'system',
                            content: prompt
                        },
                        {
                            role: 'user',
                            content: message
                        }
                    ],
                    temperature,
                    max_tokens: 500
                })
            });

            const data = await response.json();
            if (data.choices && data.choices[0]) {
                return data.choices[0].message.content;
            }
            throw new Error('فشل في توليد الرد من AI');
        } catch (error) {
            console.error(`[AutoReplyEngine] AI request failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * تأخير التنفيذ
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * تسجيل التنفيذ
     */
    logExecution(log) {
        this.executionLog.push(log);
        // Keep only last 1000 executions
        if (this.executionLog.length > 1000) {
            this.executionLog.shift();
        }
    }

    /**
     * الحصول على سجل التنفيذ
     */
    getExecutionLog(limit = 100) {
        return this.executionLog.slice(-limit);
    }

    /**
     * مسح سجل التنفيذ
     */
    clearExecutionLog() {
        this.executionLog = [];
    }

    /**
     * التحقق من صحة التدفق
     */
    validateFlow(flow) {
        const errors = [];

        if (!flow.drawflow || !flow.drawflow.Home || !flow.drawflow.Home.data) {
            errors.push('هيكل التدفق غير صحيح');
            return errors;
        }

        const data = flow.drawflow.Home.data;
        const startNodes = Object.values(data).filter(n => n.class === 'start-node-v2' || n.class === 'start-node');

        if (startNodes.length === 0) {
            errors.push('يجب أن يحتوي التدفق على نقطة بداية واحدة على الأقل');
        }

        if (startNodes.length > 1) {
            errors.push('لا يمكن أن يحتوي التدفق على أكثر من نقطة بداية واحدة');
        }

        // Check for orphaned nodes
        const connections = flow.drawflow.Home.links || {};
        const connectedNodes = new Set();
        const originNodes = new Set();

        for (const connectionId in connections) {
            const connection = connections[connectionId];
            connectedNodes.add(connection.target_node);
            originNodes.add(connection.origin_node);
        }

        for (const nodeId in data) {
            if (!originNodes.has(nodeId) && data[nodeId].class !== 'start-node-v2' && data[nodeId].class !== 'start-node') {
                // Node has no outgoing connections but is not a start node
                // This is usually OK for end nodes
            }
        }

        return errors;
    }
}

// Export singleton instance
export const autoReplyEngine = new AutoReplyEngine();
