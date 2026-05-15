import { SupabaseIntegration } from '../supabase-integration.js';

/**
 * =====================================================
 * AutoReplyPageV2.js - محرر الرد الآلي المحسّن
 * نسخة SaaS احترافية مع ميزات متقدمة
 * =====================================================
 */

export class AutoReplyPageV2 {
    constructor(container) {
        this.container = container;
        this.editor = null;
        this.saveTimeout = null;
        this.selectedNode = null;
        this.propertiesPanel = null;
        this.nodeCounter = {};
        this.flowHistory = [];
        this.historyIndex = -1;
    }

    async load() {
        this.renderBase();
        this.initEditor();
        this.setupEventListeners();
        await this.loadFlowData();
    }

    renderBase() {
        this.container.innerHTML = `
            <div class="flow-editor-container-v2">
                <!-- Header Toolbar -->
                <div class="flow-toolbar-v2">
                    <div style="flex: 1; display: flex; align-items: center; gap: 15px;">
                        <div>
                            <h3 style="margin:0; font-size: 18px; font-weight: 700;">محرر الرد الآلي البصري</h3>
                            <p style="margin: 4px 0 0 0; font-size: 12px; color: var(--text-muted);">صمّم تدفقات الرد الآلي بسهولة</p>
                        </div>
                        <div class="save-status-v2" id="flow-save-status">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
                            <span>تم حفظ جميع التغييرات</span>
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <button class="btn btn-ghost btn-sm" id="undo-btn" title="تراجع">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/></svg>
                        </button>
                        <button class="btn btn-ghost btn-sm" id="redo-btn" title="إعادة">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7"/></svg>
                        </button>
                        <div style="width: 1px; height: 20px; background: var(--border-subtle);"></div>
                        <button class="btn btn-ghost btn-sm" id="test-flow-btn" title="اختبار التدفق">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                            <span style="margin-right: 4px;">اختبار</span>
                        </button>
                        <button class="btn btn-secondary btn-sm" id="clear-btn">مسح الكل</button>
                        <button class="btn btn-primary btn-sm" id="save-btn">حفظ الآن</button>
                    </div>
                </div>

                <!-- Main Content -->
                <div class="flow-main-v2">
                    <!-- Sidebar with Nodes -->
                    <div class="flow-sidebar-v2">
                        <div class="sidebar-section">
                            <div class="sidebar-title">📌 البداية والنهاية</div>
                            <div class="drag-item-v2" draggable="true" data-node="start">
                                <div class="node-icon">🏁</div>
                                <div class="node-label">نقطة البداية</div>
                            </div>
                            <div class="drag-item-v2" draggable="true" data-node="end">
                                <div class="node-icon">🛑</div>
                                <div class="node-label">نهاية التدفق</div>
                            </div>
                        </div>

                        <div class="sidebar-section">
                            <div class="sidebar-title">💬 الرسائل</div>
                            <div class="drag-item-v2" draggable="true" data-node="message">
                                <div class="node-icon">💬</div>
                                <div class="node-label">نص عادي</div>
                            </div>
                            <div class="drag-item-v2" draggable="true" data-node="media">
                                <div class="node-icon">🖼️</div>
                                <div class="node-label">صورة/فيديو</div>
                            </div>
                            <div class="drag-item-v2" draggable="true" data-node="buttons">
                                <div class="node-icon">🔘</div>
                                <div class="node-label">أزرار تفاعلية</div>
                            </div>
                        </div>

                        <div class="sidebar-section">
                            <div class="sidebar-title">⚙️ التحكم</div>
                            <div class="drag-item-v2" draggable="true" data-node="condition">
                                <div class="node-icon">⚖️</div>
                                <div class="node-label">شرط (Branch)</div>
                            </div>
                            <div class="drag-item-v2" draggable="true" data-node="delay">
                                <div class="node-icon">⏱️</div>
                                <div class="node-label">تأخير</div>
                            </div>
                            <div class="drag-item-v2" draggable="true" data-node="random">
                                <div class="node-icon">🎲</div>
                                <div class="node-label">توزيع عشوائي</div>
                            </div>
                        </div>

                        <div class="sidebar-section">
                            <div class="sidebar-title">🔗 التكاملات</div>
                            <div class="drag-item-v2" draggable="true" data-node="http">
                                <div class="node-icon">🌐</div>
                                <div class="node-label">طلب HTTP</div>
                            </div>
                            <div class="drag-item-v2" draggable="true" data-node="ai">
                                <div class="node-icon">🤖</div>
                                <div class="node-label">رد ذكي (AI)</div>
                            </div>
                        </div>
                    </div>

                    <!-- Canvas Area -->
                    <div class="flow-canvas-wrapper">
                        <div id="drawflow" class="flow-canvas-v2"></div>
                        
                        <!-- Zoom Controls -->
                        <div class="flow-controls-v2">
                            <div class="control-btn-v2" id="zoom-in-btn" title="تكبير">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            </div>
                            <div class="control-btn-v2" id="zoom-out-btn" title="تصغير">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            </div>
                            <div class="control-btn-v2" id="reset-zoom-btn" title="إعادة تعيين">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
                            </div>
                        </div>
                    </div>

                    <!-- Properties Panel -->
                    <div class="flow-properties-panel" id="properties-panel">
                        <div class="properties-header">
                            <h4>خصائص العقدة</h4>
                            <button class="btn btn-ghost btn-sm" id="close-properties" title="إغلاق">✕</button>
                        </div>
                        <div class="properties-content" id="properties-content">
                            <p style="color: var(--text-muted); text-align: center; padding: 20px;">اختر عقدة لتعديل خصائصها</p>
                        </div>
                    </div>
                </div>

                <!-- Test Modal -->
                <div class="modal" id="test-modal" style="display: none;">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h3>اختبار التدفق</h3>
                            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('test-modal').style.display='none'">✕</button>
                        </div>
                        <div class="modal-body">
                            <p style="margin-bottom: 16px;">أرسل رسالة اختبار لمحاكاة التدفق:</p>
                            <input type="text" id="test-input" placeholder="اكتب رسالة اختبار..." style="width: 100%; padding: 10px; border: 1px solid var(--border-subtle); border-radius: 8px; margin-bottom: 16px;">
                            <div id="test-output" style="background: var(--bg-elevated); padding: 12px; border-radius: 8px; max-height: 300px; overflow-y: auto; font-size: 12px;"></div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" onclick="document.getElementById('test-modal').style.display='none'">إغلاق</button>
                            <button class="btn btn-primary" id="test-run-btn">تشغيل الاختبار</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    initEditor() {
        const canvas = document.getElementById('drawflow');
        canvas.style.direction = 'ltr';

        this.editor = new Drawflow(canvas);
        this.editor.reroute = true;
        this.editor.editor_mode = 'edit';
        this.editor.draggable_inputs = false;
        this.editor.force_first_input = false;
        this.editor.start();

        // Setup global flow editor object
        window.flowEditor = {
            drag: (ev) => this.handleDrag(ev),
            drop: (ev) => this.handleDrop(ev),
            nodeClick: (id) => this.selectNode(id),
            nodeDoubleClick: (id) => this.editNode(id),
        };

        // Event listeners
        this.editor.on('nodeCreated', (id) => {
            this.triggerAutosave();
            this.saveHistory();
        });
        this.editor.on('nodeRemoved', (id) => {
            this.triggerAutosave();
            this.saveHistory();
        });
        this.editor.on('connectionCreated', () => {
            this.triggerAutosave();
            this.saveHistory();
        });
        this.editor.on('connectionRemoved', () => {
            this.triggerAutosave();
            this.saveHistory();
        });
        this.editor.on('nodeMoved', () => {
            this.triggerAutosave();
        });
        this.editor.on('nodeSelected', (id) => {
            this.selectNode(id);
        });
    }

    setupEventListeners() {
        // Drag and drop
        document.querySelectorAll('.drag-item-v2').forEach(item => {
            item.addEventListener('dragstart', (e) => this.handleDrag(e));
        });

        document.getElementById('drawflow').addEventListener('drop', (e) => this.handleDrop(e));
        document.getElementById('drawflow').addEventListener('dragover', (e) => e.preventDefault());

        // Buttons
        document.getElementById('undo-btn').addEventListener('click', () => this.undo());
        document.getElementById('redo-btn').addEventListener('click', () => this.redo());
        document.getElementById('test-flow-btn').addEventListener('click', () => this.openTestModal());
        document.getElementById('clear-btn').addEventListener('click', () => this.clearAll());
        document.getElementById('save-btn').addEventListener('click', () => this.saveFlowData());

        // Zoom controls
        document.getElementById('zoom-in-btn').addEventListener('click', () => this.editor.zoom_in());
        document.getElementById('zoom-out-btn').addEventListener('click', () => this.editor.zoom_out());
        document.getElementById('reset-zoom-btn').addEventListener('click', () => this.editor.zoom_reset());

        // Properties panel
        document.getElementById('close-properties').addEventListener('click', () => {
            document.getElementById('properties-panel').classList.remove('active');
        });

        // Test modal
        document.getElementById('test-run-btn').addEventListener('click', () => this.runTest());
    }

    handleDrag(ev) {
        const nodeType = ev.target.closest('.drag-item-v2')?.getAttribute('data-node');
        if (nodeType) {
            ev.dataTransfer.effectAllowed = 'copy';
            ev.dataTransfer.setData('nodeType', nodeType);
        }
    }

    handleDrop(ev) {
        ev.preventDefault();
        const nodeType = ev.dataTransfer.getData('nodeType');
        if (nodeType) {
            const rect = document.getElementById('drawflow').getBoundingClientRect();
            const x = ev.clientX - rect.left;
            const y = ev.clientY - rect.top;
            this.addNodeToEditor(nodeType, x, y);
        }
    }

    addNodeToEditor(type, x, y) {
        // Adjust coordinates for zoom
        const zoom = this.editor.zoom;
        const adjustedX = x / zoom;
        const adjustedY = y / zoom;

        // Initialize counter for this node type
        if (!this.nodeCounter[type]) {
            this.nodeCounter[type] = 0;
        }
        this.nodeCounter[type]++;

        const nodeId = `${type}_${this.nodeCounter[type]}`;

        switch (type) {
            case 'start':
                this.editor.addNode(nodeId, 0, 1, adjustedX, adjustedY, 'start-node-v2', {}, `
                    <div class="title">🏁 نقطة البداية</div>
                    <div class="content">عند استلام أي رسالة جديدة</div>
                `);
                break;

            case 'end':
                this.editor.addNode(nodeId, 1, 0, adjustedX, adjustedY, 'end-node-v2', {}, `
                    <div class="title">🛑 نهاية التدفق</div>
                    <div class="content">انتهاء المحادثة</div>
                `);
                break;

            case 'message':
                this.editor.addNode(nodeId, 1, 1, adjustedX, adjustedY, 'message-node-v2', { message: '', delay: 0 }, `
                    <div class="title">💬 إرسال رسالة نصية</div>
                    <div class="content">
                        <textarea class="node-textarea" df-message placeholder="اكتب نص الرسالة..."></textarea>
                        <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">تأخير (ثانية):</div>
                        <input type="number" class="node-input" df-delay placeholder="0" min="0" max="300">
                    </div>
                `);
                break;

            case 'media':
                this.editor.addNode(nodeId, 1, 1, adjustedX, adjustedY, 'media-node-v2', { mediaUrl: '', mediaType: 'image', caption: '' }, `
                    <div class="title">🖼️ إرسال وسائط</div>
                    <div class="content">
                        <select class="node-input" df-mediaType>
                            <option value="image">صورة</option>
                            <option value="video">فيديو</option>
                            <option value="document">ملف</option>
                        </select>
                        <input type="text" class="node-input" df-mediaUrl placeholder="رابط الوسائط">
                        <textarea class="node-textarea" df-caption placeholder="تعليق (اختياري)"></textarea>
                    </div>
                `);
                break;

            case 'buttons':
                this.editor.addNode(nodeId, 1, 1, adjustedX, adjustedY, 'buttons-node-v2', { buttons: [] }, `
                    <div class="title">🔘 أزرار تفاعلية</div>
                    <div class="content">
                        <div style="font-size: 11px; margin-bottom: 8px;">الرسالة:</div>
                        <textarea class="node-textarea" df-message placeholder="اكتب الرسالة..."></textarea>
                        <div style="font-size: 11px; margin-top: 8px; margin-bottom: 4px;">الأزرار (مفصولة بفاصلة):</div>
                        <input type="text" class="node-input" df-buttons placeholder="زر 1, زر 2, زر 3">
                    </div>
                `);
                break;

            case 'condition':
                this.editor.addNode(nodeId, 1, 2, adjustedX, adjustedY, 'condition-node-v2', { keyword: '', matchType: 'contains' }, `
                    <div class="title">⚖️ شرط (Branch)</div>
                    <div class="content">
                        <select class="node-input" df-matchType>
                            <option value="contains">يحتوي على</option>
                            <option value="equals">يساوي</option>
                            <option value="startsWith">يبدأ بـ</option>
                        </select>
                        <input type="text" class="node-input" df-keyword placeholder="الكلمة المفتاحية">
                        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:10px; color:var(--text-muted);">
                            <span>✓ نعم (1)</span>
                            <span>✗ لا (2)</span>
                        </div>
                    </div>
                `);
                break;

            case 'delay':
                this.editor.addNode(nodeId, 1, 1, adjustedX, adjustedY, 'delay-node-v2', { seconds: 3 }, `
                    <div class="title">⏱️ تأخير</div>
                    <div class="content">
                        <div style="font-size: 11px; margin-bottom: 4px;">الانتظار (ثانية):</div>
                        <input type="number" class="node-input" df-seconds placeholder="3" min="1" max="300">
                    </div>
                `);
                break;

            case 'random':
                this.editor.addNode(nodeId, 1, 2, adjustedX, adjustedY, 'random-node-v2', { ratio: 50 }, `
                    <div class="title">🎲 توزيع عشوائي (A/B)</div>
                    <div class="content">
                        <div style="font-size: 11px; margin-bottom: 4px;">نسبة المسار A (%):</div>
                        <input type="number" class="node-input" df-ratio placeholder="50" min="0" max="100">
                        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:10px; color:var(--text-muted);">
                            <span>مسار A</span>
                            <span>مسار B</span>
                        </div>
                    </div>
                `);
                break;

            case 'http':
                this.editor.addNode(nodeId, 1, 1, adjustedX, adjustedY, 'http-node-v2', { url: '', method: 'POST', timeout: 10 }, `
                    <div class="title">🌐 طلب HTTP</div>
                    <div class="content">
                        <select class="node-input" df-method>
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                        </select>
                        <input type="text" class="node-input" df-url placeholder="https://api.example.com">
                        <div style="font-size: 11px; margin-top: 4px; margin-bottom: 4px;">المهلة الزمنية (ثانية):</div>
                        <input type="number" class="node-input" df-timeout placeholder="10" min="1" max="60">
                    </div>
                `);
                break;

            case 'ai':
                this.editor.addNode(nodeId, 1, 1, adjustedX, adjustedY, 'ai-node-v2', { prompt: '', model: 'gpt-3.5-turbo', temperature: 0.7 }, `
                    <div class="title">🤖 رد ذكي (AI)</div>
                    <div class="content">
                        <select class="node-input" df-model>
                            <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                            <option value="gpt-4">GPT-4</option>
                        </select>
                        <textarea class="node-textarea" df-prompt placeholder="أدخل التعليمات للذكاء الاصطناعي..."></textarea>
                        <div style="font-size: 11px; margin-top: 4px;">درجة الإبداع: <span df-temperature-display>0.7</span></div>
                        <input type="range" class="node-input" df-temperature min="0" max="1" step="0.1" value="0.7">
                    </div>
                `);
                break;
        }

        this.saveHistory();
    }

    selectNode(id) {
        // Remove previous selection
        document.querySelectorAll('.drawflow-node').forEach(node => {
            node.classList.remove('selected');
        });

        // Select new node
        const nodeElement = document.querySelector(`[data-node="${id}"]`);
        if (nodeElement) {
            nodeElement.classList.add('selected');
            this.selectedNode = id;
            this.showNodeProperties(id);
        }
    }

    showNodeProperties(id) {
        const node = this.editor.getNodeFromId(id);
        if (!node) return;

        const panel = document.getElementById('properties-panel');
        const content = document.getElementById('properties-content');

        let propertiesHTML = `
            <div class="properties-form">
                <div class="form-group">
                    <label>معرّف العقدة</label>
                    <input type="text" value="${id}" readonly style="background: var(--bg-elevated); cursor: not-allowed;">
                </div>
        `;

        // Add node-specific properties
        const nodeData = node.data;
        if (nodeData.message !== undefined) {
            propertiesHTML += `
                <div class="form-group">
                    <label>نص الرسالة</label>
                    <textarea class="node-textarea" id="prop-message">${nodeData.message || ''}</textarea>
                </div>
            `;
        }

        if (nodeData.keyword !== undefined) {
            propertiesHTML += `
                <div class="form-group">
                    <label>الكلمة المفتاحية</label>
                    <input type="text" class="node-input" id="prop-keyword" value="${nodeData.keyword || ''}">
                </div>
            `;
        }

        if (nodeData.url !== undefined) {
            propertiesHTML += `
                <div class="form-group">
                    <label>رابط API</label>
                    <input type="text" class="node-input" id="prop-url" value="${nodeData.url || ''}">
                </div>
            `;
        }

        propertiesHTML += `
                <div style="margin-top: 16px; display: flex; gap: 8px;">
                    <button class="btn btn-danger btn-sm" onclick="window.flowEditor.deleteNode('${id}')">حذف العقدة</button>
                </div>
            </div>
        `;

        content.innerHTML = propertiesHTML;
        panel.classList.add('active');

        // Add event listeners for property updates
        const inputs = content.querySelectorAll('input, textarea');
        inputs.forEach(input => {
            input.addEventListener('change', () => {
                const propName = input.id.replace('prop-', '');
                nodeData[propName] = input.value;
                this.triggerAutosave();
            });
        });
    }

    editNode(id) {
        this.selectNode(id);
    }

    openTestModal() {
        document.getElementById('test-modal').style.display = 'flex';
        document.getElementById('test-input').focus();
    }

    async runTest() {
        const testMessage = document.getElementById('test-input').value;
        const output = document.getElementById('test-output');

        if (!testMessage.trim()) {
            output.innerHTML = '<span style="color: var(--status-error);">يرجى إدخال رسالة اختبار</span>';
            return;
        }

        output.innerHTML = '<span style="color: var(--text-muted);">جاري محاكاة التدفق...</span>';

        try {
            // Simulate flow execution
            const result = await this.simulateFlow(testMessage);
            output.innerHTML = `
                <div style="color: var(--status-success); margin-bottom: 12px;">✓ تم تنفيذ التدفق بنجاح</div>
                <div style="font-size: 11px;">
                    <div style="margin-bottom: 8px;"><strong>المخرجات:</strong></div>
                    ${result.messages.map(msg => `<div style="margin-bottom: 4px; padding: 8px; background: var(--bg-surface); border-radius: 4px;">${msg}</div>`).join('')}
                </div>
            `;
        } catch (error) {
            output.innerHTML = `<span style="color: var(--status-error);">خطأ: ${error.message}</span>`;
        }
    }

    async simulateFlow(message) {
        // This is a placeholder for flow simulation logic
        // In production, this would traverse the flow graph and execute nodes
        const messages = ['رسالة اختبار تم إرسالها بنجاح'];
        return { messages };
    }

    clearAll() {
        if (confirm('هل أنت متأكد من مسح جميع العقد؟')) {
            this.editor.clearModuleSelected();
            this.nodeCounter = {};
            this.saveHistory();
            this.triggerAutosave();
        }
    }

    saveHistory() {
        // Save current state to history
        this.historyIndex++;
        this.flowHistory = this.flowHistory.slice(0, this.historyIndex);
        this.flowHistory.push(JSON.stringify(this.editor.export()));

        // Update button states
        document.getElementById('undo-btn').disabled = this.historyIndex <= 0;
        document.getElementById('redo-btn').disabled = this.historyIndex >= this.flowHistory.length - 1;
    }

    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.editor.import(JSON.parse(this.flowHistory[this.historyIndex]));
            document.getElementById('redo-btn').disabled = false;
            if (this.historyIndex === 0) document.getElementById('undo-btn').disabled = true;
        }
    }

    redo() {
        if (this.historyIndex < this.flowHistory.length - 1) {
            this.historyIndex++;
            this.editor.import(JSON.parse(this.flowHistory[this.historyIndex]));
            document.getElementById('undo-btn').disabled = false;
            if (this.historyIndex === this.flowHistory.length - 1) document.getElementById('redo-btn').disabled = true;
        }
    }

    triggerAutosave() {
        const statusEl = document.getElementById('flow-save-status');
        if (statusEl) {
            statusEl.classList.remove('saved');
            statusEl.querySelector('span').textContent = 'جاري الحفظ...';
        }

        clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            this.saveFlowData();
        }, 2000);
    }

    async saveFlowData() {
        try {
            const data = this.editor.export();
            const supabase = await SupabaseIntegration.initializeSupabase();
            const userId = await SupabaseIntegration.getCurrentUserId();

            const { error } = await supabase
                .from('bot_settings')
                .upsert({
                    user_id: userId,
                    custom_replies: data,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });

            if (error) throw error;

            const statusEl = document.getElementById('flow-save-status');
            if (statusEl) {
                statusEl.classList.add('saved');
                statusEl.querySelector('span').textContent = 'تم حفظ جميع التغييرات';
            }
        } catch (error) {
            console.error('Flow save failed:', error);
            const statusEl = document.getElementById('flow-save-status');
            if (statusEl) {
                statusEl.style.color = 'var(--status-error)';
                statusEl.querySelector('span').textContent = 'فشل الحفظ التلقائي';
            }
        }
    }

    async loadFlowData() {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const userId = await SupabaseIntegration.getCurrentUserId();

            const { data, error } = await supabase
                .from('bot_settings')
                .select('custom_replies')
                .eq('user_id', userId)
                .maybeSingle();

            if (error) throw error;

            if (data && data.custom_replies && typeof data.custom_replies === 'object') {
                this.editor.import(data.custom_replies);
                this.saveHistory();
            } else {
                // Add default start node if empty
                this.addNodeToEditor('start', 100, 100);
            }
        } catch (error) {
            console.error('Flow load failed:', error);
        }
    }
}
