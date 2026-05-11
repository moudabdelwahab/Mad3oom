import { SupabaseIntegration } from '../supabase-integration.js';

export class AutoReplyPage {
    constructor(container) {
        this.container = container;
        this.editor = null;
        this.saveTimeout = null;
    }

    async load() {
        this.renderBase();
        this.initEditor();
        await this.loadFlowData();
    }

    renderBase() {
        this.container.innerHTML = `
            <div class="flow-editor-container">
                <div class="flow-toolbar">
                    <div style="flex: 1; display: flex; align-items: center; gap: 15px;">
                        <h3 style="margin:0; font-size: 16px;">محرر الرد الآلي البصري</h3>
                        <div class="save-status" id="flow-save-status">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
                            <span>تم حفظ جميع التغييرات</span>
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-secondary btn-sm" onclick="window.flowEditor.clear()">مسح الكل</button>
                        <button class="btn btn-primary btn-sm" onclick="window.flowEditor.save()">حفظ الآن</button>
                    </div>
                </div>
                
                <div class="flow-main">
                    <div class="flow-sidebar">
                        <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px;">العناصر المتاحة</div>
                        
                        <div class="drag-item" draggable="true" ondragstart="window.flowEditor.drag(event)" data-node="start">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8l4 4-4 4M8 12h7"/></svg>
                            <span>نقطة البداية</span>
                        </div>
                        
                        <div class="drag-item" draggable="true" ondragstart="window.flowEditor.drag(event)" data-node="message">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                            <span>إرسال رسالة</span>
                        </div>
                        
                        <div class="drag-item" draggable="true" ondragstart="window.flowEditor.drag(event)" data-node="condition">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                            <span>شرط (Branches)</span>
                        </div>
                        
                        <div class="drag-item" draggable="true" ondragstart="window.flowEditor.drag(event)" data-node="random">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12l-9-4-9 4 9 4 9-4z"/><path d="M3 12v6l9 4 9-4v-6"/></svg>
                            <span>عشوائي (Random)</span>
                        </div>
                        
                        <div class="drag-item" draggable="true" ondragstart="window.flowEditor.drag(event)" data-node="http">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                            <span>طلب HTTP</span>
                        </div>
                    </div>
                    
                    <div id="drawflow" class="flow-canvas" ondrop="window.flowEditor.drop(event)" ondragover="event.preventDefault()"></div>
                    
                    <div class="flow-controls">
                        <div class="control-btn" onclick="window.flowEditor.zoomIn()">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </div>
                        <div class="control-btn" onclick="window.flowEditor.zoomOut()">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </div>
                        <div class="control-btn" onclick="window.flowEditor.resetZoom()">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    initEditor() {
        const id = document.getElementById("drawflow");
    id.style.direction = "ltr";

        this.editor = new Drawflow(id);
            // مهم جدًا لحل مشاكل RTL

    // إعدادات مهمة
    this.editor.reroute = true;
    this.editor.editor_mode = 'edit';
    this.editor.draggable_inputs = false;
    this.editor.force_first_input = false;

        this.editor.start();
        
        // Export to window for global access from HTML attributes
        window.flowEditor = {
            drag: (ev) => {
                ev.dataTransfer.setData("node", ev.target.closest('.drag-item').getAttribute('data-node'));
            },
            drop: (ev) => {
                ev.preventDefault();
                const data = ev.dataTransfer.getData("node");
                this.addNodeToEditor(data, ev.clientX, ev.clientY);
            },
            zoomIn: () => this.editor.zoom_in(),
            zoomOut: () => this.editor.zoom_out(),
            resetZoom: () => this.editor.zoom_reset(),
            clear: () => {
                if(confirm('هل أنت متأكد من مسح جميع العقد؟')) this.editor.clearModuleSelected();
            },
            save: () => this.saveFlowData()
        };

        // Listen for changes for autosave
        this.editor.on('nodeCreated', () => this.triggerAutosave());
        this.editor.on('nodeRemoved', () => this.triggerAutosave());
        this.editor.on('connectionCreated', () => this.triggerAutosave());
        this.editor.on('connectionRemoved', () => this.triggerAutosave());
        this.editor.on('nodeMoved', () => this.triggerAutosave());
    }

    addNodeToEditor(name, pos_x, pos_y) {
        if(this.editor.editor_mode === 'fixed') return false;
        
        pos_x = pos_x * ( this.editor.precanvas.clientWidth / (this.editor.precanvas.clientWidth * this.editor.zoom)) - (this.editor.precanvas.getBoundingClientRect().x * ( this.editor.precanvas.clientWidth / (this.editor.precanvas.clientWidth * this.editor.zoom)));
        pos_y = pos_y * ( this.editor.precanvas.clientHeight / (this.editor.precanvas.clientHeight * this.editor.zoom)) - (this.editor.precanvas.getBoundingClientRect().y * ( this.editor.precanvas.clientHeight / (this.editor.precanvas.clientHeight * this.editor.zoom)));

        switch (name) {
            case 'start':
                this.editor.addNode('start', 0, 1, pos_x, pos_y, 'start-node', {}, `
                    <div class="title">🏁 نقطة البداية</div>
                    <div class="content">عند استلام أي رسالة جديدة</div>
                `);
                break;
            case 'message':
                this.editor.addNode('message', 1, 1, pos_x, pos_y, 'message-node', { message: '' }, `
                    <div class="title">💬 إرسال رسالة</div>
                    <div class="content">
                        <textarea class="node-textarea" df-message placeholder="اكتب نص الرسالة هنا..."></textarea>
                    </div>
                `);
                break;
            case 'condition':
                this.editor.addNode('condition', 1, 2, pos_x, pos_y, 'condition-node', { keyword: '' }, `
                    <div class="title">⚖️ شرط (Branch)</div>
                    <div class="content">
                        <div style="font-size:10px">إذا كانت الرسالة تحتوي:</div>
                        <input type="text" class="node-input" df-keyword placeholder="الكلمة المفتاحية">
                        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:10px; color:var(--text-muted);">
                            <span>نعم (1)</span>
                            <span>لا (2)</span>
                        </div>
                    </div>
                `);
                break;
            case 'random':
                this.editor.addNode('random', 1, 2, pos_x, pos_y, 'random-node', {}, `
                    <div class="title">🎲 مسار عشوائي</div>
                    <div class="content">
                        توزيع عشوائي للرسائل (A/B)
                        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:10px; color:var(--text-muted);">
                            <span>مسار A</span>
                            <span>مسار B</span>
                        </div>
                    </div>
                `);
                break;
            case 'http':
                this.editor.addNode('http', 1, 1, pos_x, pos_y, 'http-node', { url: '', method: 'POST' }, `
                    <div class="title">🌐 طلب HTTP</div>
                    <div class="content">
                        <select class="node-input" df-method>
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                        </select>
                        <input type="text" class="node-input" df-url placeholder="https://api.example.com">
                    </div>
                `);
                break;
        }
    }

    triggerAutosave() {
        const statusEl = document.getElementById('flow-save-status');
        if(statusEl) {
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
            
            // Save to bot_settings (using custom_replies to store the JSON flow)
            const { error } = await supabase
                .from('bot_settings')
                .upsert({
                    user_id: userId,
                    custom_replies: data,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });

            if (error) throw error;

            const statusEl = document.getElementById('flow-save-status');
            if(statusEl) {
                statusEl.classList.add('saved');
                statusEl.querySelector('span').textContent = 'تم حفظ جميع التغييرات';
            }
        } catch (error) {
            console.error('Flow save failed:', error);
            const statusEl = document.getElementById('flow-save-status');
            if(statusEl) {
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
            } else {
                // Add default start node if empty
                this.addNodeToEditor('start', 100, 100);
            }
        } catch (error) {
            console.error('Flow load failed:', error);
        }
    }
}
