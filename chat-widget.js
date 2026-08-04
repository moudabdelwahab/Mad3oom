/**
 * ويدجت الدردشة المباشرة العائم (الفقاعة) - Client Side
 * ------------------------------------------------------------
 * ملاحظة مهمة: النسخة دي بقت بتستخدم بالظبط نفس المنطق والجداول اللي
 * بيستخدمها chat-customer.html (chat_sessions / chat_messages / محرك
 * الردود المحلي chatbot-engine.js عبر Supabase)، بدل الـ chatService
 * الوهمي (in-memory) اللي كان بيشتغل ببيانات تجريبية بس.
 *
 * هذا الملف الآن ES Module، فلازم يتحمّل بـ:
 *   <script type="module" src="chat-widget.js"></script>
 * (بدل <script src="chat-widget.js" defer></script> القديمة)
 * ------------------------------------------------------------
 */

import { supabase } from '/api-config.js';
import { requireAuth } from '/auth-client.js';
import { getBotReply, MAIN_MENU_OPTIONS, getOptionsForFlow } from '/assets/js/chatbot-engine.js';
import { openChatbotModeDialog } from '/assets/js/chatbot-mode-selector.js';
import { CHATBOT_MODE_LABELS, fetchChatbotModeState, getSieAccessInfo, saveChatbotModeState } from '/assets/js/chatbot-mode-service.js';
import { getSieReply } from '/assets/js/sie-client.js';
import { iconize } from '/assets/js/chat-icons.js';

/**
 * تنقية أي نص قبل حقنه في innerHTML لمنع XSS - نفس المنطق المستخدم في chat-logic.js
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

class ChatWidget {
    constructor() {
        this.currentUser = null;
        this.userProfile = null;
        this.currentSessionId = null;
        this.currentSession = null;
        this.botSettings = null;
        this.messageChannel = null;
        // كاش لوضع الشات بوت المختار من العميل، بنفس منطق chat-logic.js -
        // بيتحدّث في refreshChatModeLabel() وبعد كل تغيير من نافذة الإعدادات.
        this.cachedChatbotMode = 'traditional';
        // هل الجلسة الحالية "دخول كعضو" (impersonation) من أدمن/super_user؟
        this.isImpersonated = false;

        this.chatInitialized = false; // هل بدأنا تحميل الجلسة فعلاً؟
        this.isLoggedIn = false;
        this.agentJoined = false; // هل فريق الدعم منضم للمحادثة حالياً (is_manual_mode)؟

        this.isMinimized = false;
        this.isMaximized = false;
        this.isSettingsOpen = false;
        this.notificationsEnabled = this.getNotificationsPref();

        this.transcriptLines = []; // لتحميل نص المحادثة كاملاً لاحقاً

        this.init();
    }

    /* ==================== إعدادات محلية (تخص الجهاز، مش الباك إند) ==================== */

    getNotificationsPref() {
        const stored = localStorage.getItem('chat_notifications_enabled');
        return stored === null ? true : stored === 'true';
    }

    setNotificationsPref(value) {
        this.notificationsEnabled = value;
        localStorage.setItem('chat_notifications_enabled', String(value));
    }

    getAvatarGradient(seed) {
        let hash = 0;
        const s = String(seed || 'system');
        for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
        const hue1 = Math.abs(hash) % 360;
        const hue2 = (hue1 + 60) % 360;
        return `linear-gradient(135deg, hsl(${hue1}, 70%, 55%), hsl(${hue2}, 70%, 55%))`;
    }

    formatEventTimestamp(date) {
        const d = new Date(date);
        const datePart = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        return `${datePart}, ${timePart}`;
    }

    /* ==================== تهيئة عامة (بتحصل مرة واحدة عند تحميل الصفحة) ==================== */

    async init() {
        this.createWidgetHTML();
        this.attachEventListeners();

        // نتحقق بدري (بدون فتح الشات) من حالة تسجيل الدخول عشان نظبط
        // زرار "تسجيل الدخول" / "تقديم" في قائمة الإعدادات من أول لحظة
        const { data: { user } } = await supabase.auth.getUser();
        this.isLoggedIn = !!user;
        this.updateContactDetailsUI();
    }

    /* ==================== بناء الواجهة ==================== */

    createWidgetHTML() {
        if (document.getElementById('chatBubbleBtn')) {
            console.log('[ChatWidget] Widget already exists, skipping creation');
            return;
        }

        const widgetHTML = `
      <div class="floating-chat-widget" id="floatingChatWidget">
        <button class="chat-bubble-btn" id="chatBubbleBtn" title="فتح الدردشة">
          <div class="chat-bubble-icon">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
          </div>
        </button>

        <div class="chat-widget-panel" id="chatWidgetPanel">
          <!-- Header -->
          <div class="chat-widget-header" id="chatWidgetHeader">
            <div class="chat-widget-header-title">
              <div class="chat-widget-header-icon">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
              </div>
              <div>
                <h3>الدردشة المباشرة</h3>
                <p id="headerStatus">كيف يمكننا مساعدتك؟</p>
              </div>
            </div>
            <div class="chat-widget-header-actions">
              <button class="chat-header-icon-btn" id="chatSettingsBtn" title="الإعدادات">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>
              </button>
              <button class="chat-header-icon-btn" id="chatMinimizeBtn" title="تصغير">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <button class="chat-header-icon-btn chat-widget-close" id="chatWidgetClose" title="إغلاق">×</button>
            </div>
          </div>

          <!-- بانر "عرض كعضو" - يظهر بس وقت الـimpersonation، فيه اسم العضو وزرار رجوع واضح -->
          <div id="chatImpersonationBanner" style="display:none;"></div>

          <!-- Settings dropdown -->
          <div class="chat-settings-panel" id="chatSettingsPanel">
            <div class="chat-settings-item" id="contactDetailsItem">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              </div>
              <span class="chat-settings-label">تقديم بيانات التواصل</span>
              <a href="/sign-in.html" class="chat-settings-action" id="chatLoginLink">
                تسجيل الدخول
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </a>
              <button type="button" class="chat-settings-action chat-settings-provide-btn" id="chatProvideBtn" style="display:none;">تقديم</button>
            </div>
            <div class="chat-settings-item chat-settings-item-clickable" id="chatModeItem">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9h10M7 13h6"></path></svg>
              </div>
              <span class="chat-settings-label">وضع الشات بوت</span>
              <span class="chat-settings-action" id="chatModeCurrentLabel" style="color: var(--chat-text-secondary); font-weight: 600;">تقليدي</span>
            </div>
            <div class="chat-settings-item chat-settings-item-clickable" id="downloadTranscriptItem">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
              </div>
              <span class="chat-settings-label">تحميل نص المحادثة</span>
            </div>
            <div class="chat-settings-item chat-settings-item-clickable" id="maximizeItem">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"></path></svg>
              </div>
              <span class="chat-settings-label" id="maximizeLabel">تكبير النافذة</span>
            </div>
            <div class="chat-settings-item">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>
              </div>
              <span class="chat-settings-label">الإشعارات</span>
              <label class="chat-toggle-switch">
                <input type="checkbox" id="notificationsToggle" ${this.notificationsEnabled ? 'checked' : ''}>
                <span class="chat-toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- Body -->
          <div class="chat-widget-body" id="chatWidgetBody"></div>

          <div id="chatWidgetTyping" class="chat-widget-typing-row" style="display:none;">
            <div class="chat-widget-typing">
              <span class="chat-widget-typing-dot"></span>
              <span class="chat-widget-typing-dot"></span>
              <span class="chat-widget-typing-dot"></span>
              <span class="chat-widget-typing-text" id="chatWidgetTypingText">جاري التفكير...</span>
            </div>
          </div>

          <!-- Footer -->
          <div class="chat-widget-footer" id="chatWidgetFooter"></div>
        </div>
      </div>
    `;

        document.body.insertAdjacentHTML('beforeend', widgetHTML);
    }

    attachEventListeners() {
        const bubbleBtn = document.getElementById('chatBubbleBtn');
        const closeBtn = document.getElementById('chatWidgetClose');
        const minimizeBtn = document.getElementById('chatMinimizeBtn');
        const settingsBtn = document.getElementById('chatSettingsBtn');
        const downloadItem = document.getElementById('downloadTranscriptItem');
        const maximizeItem = document.getElementById('maximizeItem');
        const notifToggle = document.getElementById('notificationsToggle');
        const provideBtn = document.getElementById('chatProvideBtn');
        const chatModeItem = document.getElementById('chatModeItem');

        if (!bubbleBtn || !closeBtn) {
            console.error('[ChatWidget] Failed to find chat elements');
            return;
        }

        bubbleBtn.addEventListener('click', () => this.openWidget());
        closeBtn.addEventListener('click', () => this.closeWidget());
        minimizeBtn.addEventListener('click', () => this.toggleMinimize());
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleSettingsPanel();
        });
        downloadItem.addEventListener('click', () => this.downloadTranscript());
        maximizeItem.addEventListener('click', () => this.toggleMaximize());
        notifToggle.addEventListener('change', (e) => this.setNotificationsPref(e.target.checked));
        provideBtn.addEventListener('click', () => this.submitContactDetails());
        chatModeItem.addEventListener('click', () => this.openChatModeDialog());

        document.addEventListener('click', (e) => {
            const panel = document.getElementById('chatSettingsPanel');
            const settingsButton = document.getElementById('chatSettingsBtn');
            if (this.isSettingsOpen && panel && !panel.contains(e.target) && e.target !== settingsButton) {
                this.toggleSettingsPanel(false);
            }
        });

        this.setupDragging();
    }

    /**
     * يسمح بسحب نافذة الشات بالماوس (أو باللمس على الموبايل) من أي مكان في
     * الهيدر (ما عدا الأزرار نفسها: الإعدادات/تصغير/إغلاق) وتحريكها لأي
     * مكان في الصفحة. آخر موضع بيتفظ ويتطبّق تاني لو العميل قفل وفتح
     * الويدجت من غير ما يعمل ريفريش للصفحة.
     */
    setupDragging() {
        const panel = document.getElementById('chatWidgetPanel');
        const header = document.getElementById('chatWidgetHeader');
        if (!panel || !header) return;

        this.dragPosition = null; // { left, top } بالبكسل لو اتسحبت قبل كده
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        const isOnActionButton = (target) => !!target.closest('.chat-header-icon-btn');

        const beginDrag = (clientX, clientY, target) => {
            if (isOnActionButton(target)) return;
            const rect = panel.getBoundingClientRect();
            dragging = true;
            startX = clientX;
            startY = clientY;
            startLeft = rect.left;
            startTop = rect.top;

            // نحوّل من التموضع الافتراضي (absolute جوه floating-chat-widget) إلى
            // fixed بإحداثيات مطلقة على الشاشة عشان تقدر تتحرك لأي مكان بحرية
            panel.style.position = 'fixed';
            panel.style.left = `${startLeft}px`;
            panel.style.top = `${startTop}px`;
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            panel.classList.add('dragging');
        };

        const moveDrag = (clientX, clientY) => {
            if (!dragging) return;
            const deltaX = clientX - startX;
            const deltaY = clientY - startY;

            const maxLeft = window.innerWidth - panel.offsetWidth - 8;
            const maxTop = window.innerHeight - panel.offsetHeight - 8;
            const newLeft = Math.min(Math.max(8, startLeft + deltaX), Math.max(8, maxLeft));
            const newTop = Math.min(Math.max(8, startTop + deltaY), Math.max(8, maxTop));

            panel.style.left = `${newLeft}px`;
            panel.style.top = `${newTop}px`;
            this.dragPosition = { left: newLeft, top: newTop };
        };

        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            panel.classList.remove('dragging');
        };

        header.addEventListener('mousedown', (e) => {
            beginDrag(e.clientX, e.clientY, e.target);
            if (dragging) e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
        document.addEventListener('mouseup', endDrag);

        header.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            beginDrag(touch.clientX, touch.clientY, e.target);
        }, { passive: true });
        document.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            const touch = e.touches[0];
            moveDrag(touch.clientX, touch.clientY);
        }, { passive: true });
        document.addEventListener('touchend', endDrag);
    }

    /**
     * يظهر زر "تسجيل الدخول" لو مفيش مستخدم داخل، أو زر "تقديم" (اللي بيبعت
     * بيانات العميل تلقائيًا في الشات) لو هو مسجل دخول فعلاً.
     */
    updateContactDetailsUI() {
        const loginLink = document.getElementById('chatLoginLink');
        const provideBtn = document.getElementById('chatProvideBtn');
        if (!loginLink || !provideBtn) return;
        loginLink.style.display = this.isLoggedIn ? 'none' : 'flex';
        provideBtn.style.display = this.isLoggedIn ? 'flex' : 'none';
    }

    /* ==================== بانر "الدخول كعضو" (impersonation) ==================== */

    /**
     * يعرض بانر واضح فوق الشات لو الأدمن/super_user فاتح المحادثة دي "كعضو"
     * (impersonation)، فيه اسم العضو المستهدف وزرار "رجوع لحسابي" - عشان
     * يكون واضح دايمًا مين بيكلم مين، وعشان يكون في طريقة أكيدة يرجع بيها
     * لحسابه الحقيقي بدون أي لبس.
     */
    renderImpersonationBanner() {
        const container = document.getElementById('chatImpersonationBanner');
        if (!container) return;

        if (!this.isImpersonated) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        const memberName = this.currentUser?.profile?.full_name || this.currentUser?.profile?.email || 'هذا العضو';
        container.style.display = 'block';
        container.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; padding:0.5rem 0.9rem; background:#fff3cd; border-bottom:1px solid #ffe08a; font-size:0.78rem; color:#8a6300;">
                <span>بتشوف الشات كـ <strong>${escapeHtml(memberName)}</strong></span>
                <button type="button" id="chatExitImpersonationBtn" style="background:#8a6300; color:#fff; border:none; border-radius:6px; padding:0.3rem 0.7rem; font-size:0.74rem; font-weight:700; cursor:pointer; white-space:nowrap;">رجوع لحسابي</button>
            </div>
        `;

        const exitBtn = document.getElementById('chatExitImpersonationBtn');
        if (exitBtn) {
            exitBtn.addEventListener('click', () => this.exitImpersonation());
        }
    }

    /** يرجّع الأدمن لصفحته الأصلية بمسح ?impersonate= من العنوان - الجلسة الحقيقية (Supabase auth) أصلاً ما اتغيّرتش، فمفيش أي session-switching محتاج نرجّعه. */
    exitImpersonation() {
        const url = new URL(window.location.href);
        url.searchParams.delete('impersonate');
        window.location.href = url.pathname + url.search;
    }

    /* ==================== وضع الشات بوت (تقليدي / نموذج ذكاء اصطناعي / تلقائي / SIE) ==================== */

    async refreshChatModeLabel() {
        if (!this.currentUser) return;
        try {
            const state = await fetchChatbotModeState(this.currentUser.id);
            this.cachedChatbotMode = state.chatbot_mode || 'traditional';
            const label = document.getElementById('chatModeCurrentLabel');
            if (label) {
                label.textContent = CHATBOT_MODE_LABELS[this.cachedChatbotMode] || CHATBOT_MODE_LABELS.traditional;
            }
        } catch (err) {
            console.warn('[ChatWidget] تعذّر تحديث تسمية وضع الشات بوت:', err?.message || err);
        }
    }

    openChatModeDialog() {
        if (!this.currentUser) {
            window.location.href = '/sign-in.html';
            return;
        }
        this.toggleSettingsPanel(false);
        openChatbotModeDialog({
            userId: this.currentUser.id,
            onModeChanged: () => this.refreshChatModeLabel()
        });
    }

    /**
     * نفس منطق chat-logic.js: العميل مختار SIE لكن صلاحيته اتسحبت وهو في نص
     * محادثة - نحفظ التحويل للتقليدي فعليًا في قاعدة البيانات، نحدّث الحالة
     * المحلية، ونكتب رسالة واضحة داخل نص المحادثة (مش toast ممكن يفوته).
     */
    async handleSieRevokedMidConversation(sieAccess) {
        this.cachedChatbotMode = 'traditional';
        const label = document.getElementById('chatModeCurrentLabel');
        if (label) label.textContent = CHATBOT_MODE_LABELS.traditional;

        try {
            await saveChatbotModeState(this.currentUser.id, { mode: 'traditional', integrationId: null, modelId: null });
        } catch (err) {
            console.warn('[ChatWidget] تعذّر حفظ التحويل التلقائي عن SIE:', err?.message || err);
        }

        const reason = sieAccess?.statusLabel;
        let why = 'صلاحية استخدامك لمحرك الدعم الذكي (SIE) لم تعد متاحة.';
        if (reason === 'انتهت الكوتة') why = 'استهلكت كل رسائل محرك الدعم الذكي (SIE) المتاحة لك.';
        else if (reason === 'انتهت الصلاحية') why = 'انتهت صلاحية استخدامك لمحرك الدعم الذكي (SIE).';
        else if (reason === 'غير مفعّل') why = 'تم إلغاء تفعيل محرك الدعم الذكي (SIE) لحسابك.';

        await supabase.from('chat_messages').insert({
            session_id: this.currentSessionId,
            sender_id: null,
            message_text: `${why} تم تحويلك تلقائيًا للوضع التقليدي. تقدر تختار وضعًا آخر من إعدادات الشات، أو تتواصل مع الدعم لتفعيل SIE مرة أخرى.`,
            is_admin_reply: false,
            is_bot_reply: true
        });
    }

    /* ==================== فتح / إغلاق / تصغير / تكبير ==================== */

    async openWidget() {
        const panel = document.getElementById('chatWidgetPanel');
        if (!panel) return;
        panel.classList.add('active');
        this.isMinimized = false;
        panel.classList.remove('minimized');

        if (!this.chatInitialized) {
            this.chatInitialized = true;
            await this.startChat();
        }
    }

    closeWidget() {
        const panel = document.getElementById('chatWidgetPanel');
        if (!panel) return;
        panel.classList.remove('active');
        this.toggleSettingsPanel(false);
        // ملاحظة: إغلاق النافذة مايقفلش المحادثة نفسها - الجلسة تفضل شغالة
        // ولو العميل فتح الويدجت تاني هيكمل من نفس مكانه.
    }

    toggleMinimize() {
        const panel = document.getElementById('chatWidgetPanel');
        if (!panel) return;
        this.isMinimized = !this.isMinimized;
        panel.classList.toggle('minimized', this.isMinimized);
        if (this.isMinimized) this.toggleSettingsPanel(false);
    }

    toggleMaximize() {
        const panel = document.getElementById('chatWidgetPanel');
        const label = document.getElementById('maximizeLabel');
        if (!panel) return;
        this.isMaximized = !this.isMaximized;
        panel.classList.toggle('maximized', this.isMaximized);
        if (label) label.textContent = this.isMaximized ? 'استعادة الحجم' : 'تكبير النافذة';
    }

    toggleSettingsPanel(force) {
        const panel = document.getElementById('chatSettingsPanel');
        if (!panel) return;
        this.isSettingsOpen = force !== undefined ? force : !this.isSettingsOpen;
        panel.classList.toggle('active', this.isSettingsOpen);
    }

    /* ==================== تحميل نص المحادثة ==================== */

    downloadTranscript() {
        const blob = new Blob([this.transcriptLines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-transcript-${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        this.toggleSettingsPanel(false);
    }

    /* ==================== بدء / تحميل المحادثة الحقيقية (Supabase) ==================== */

    async startChat() {
        this.renderLoadingState();

        // ملحوظة مهمة: الويدجت ده بقى شغال في customer-dashboard.html
        // و admin-dashboard.html مع بعض. requireAuth('user') بترفض أي أدمن
        // مش عامل impersonation - وده غلط هنا: أدمن داخل بحسابه العادي على
        // لوحة الإدارة *لازم* يقدر يستخدم الويدجت برضه (هو مش بيشوف حساب
        // حد تاني، هو بيشوف حسابه). فبنستخدم requireAuth(null) بدل 'user' -
        // كده بيرجع بيانات المستخدم الحقيقي (أدمن أو عميل) في الحالة
        // العادية، وبرضه بيرجع بروفايل العضو المستهدف صح لو فيه ?impersonate=
        // (لأن شرط الـimpersonation في requireAuth() مستقل عن requiredRole).
        const user = await requireAuth(null);
        if (!user || user.banned) {
            this.isLoggedIn = false;
            this.updateContactDetailsUI();
            this.renderLoggedOutState();
            return;
        }

        this.currentUser = user;
        this.isImpersonated = !!user.isImpersonated;
        this.isLoggedIn = true;
        this.updateContactDetailsUI();
        this.renderImpersonationBanner();
        this.refreshChatModeLabel();

        await Promise.all([this.loadProfile(), this.loadBotSettings()]);
        await this.loadOrCreateSession();
        if (!this.currentSessionId) {
            this.renderErrorState();
            return;
        }

        // نشترك في التحديثات الفورية *قبل* أي إرسال رسائل (تحسبًا لرسالة
        // الترحيب الأولى)، عشان محدش يفوتنا.
        this.subscribeRealtime();
        await this.loadMessages();
    }

    async loadProfile() {
        if (!this.currentUser) return;
        const { data, error } = await supabase
            .from('profiles')
            .select('full_name, first_name, last_name, email, phone, created_at')
            .eq('id', this.currentUser.id)
            .maybeSingle();

        if (error) {
            console.error('خطأ في جلب بيانات البروفايل:', error);
            return;
        }
        this.userProfile = data;
    }

    async loadBotSettings() {
        const { data, error } = await supabase.from('bot_settings').select('*').single();
        if (error) {
            console.error('خطأ في جلب إعدادات البوت:', error);
            this.botSettings = {};
            return;
        }
        this.botSettings = data;
    }

    async loadOrCreateSession() {
        let { data: session, error } = await supabase
            .from('chat_sessions')
            .select('*')
            .eq('user_id', this.currentUser.id)
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !session) {
            const { data: newSession, error: createError } = await supabase
                .from('chat_sessions')
                .insert({ user_id: this.currentUser.id, status: 'active' })
                .select()
                .single();

            if (createError) {
                console.error('خطأ في إنشاء جلسة دردشة:', createError);
                // ملحوظة معروفة (مش مصلّحة من الفرونت إند): في وضع "الدخول
                // كعضو" (impersonation)، جلسة Supabase الحقيقية (auth.uid())
                // لسه بتاعة الأدمن، لكن هنا بنحاول نعمل insert بـ user_id
                // بتاع العضو المستهدف. لو الـRLS policy على chat_sessions من
                // نوع auth.uid() = user_id (الشكل الشائع)، الـinsert هيترفض
                // هنا بالظبط - وده على الأغلب سبب "حدث خطأ" وقت الـimpersonation.
                // الإصلاح الحقيقي محتاج تعديل في الباك إند (policy تسمح
                // للأدمن/super_user يكتبوا نيابة عن غيرهم، أو RPC بصلاحية
                // SECURITY DEFINER)، ده خارج نطاق تعديلات الفرونت إند.
                this.sessionCreateError = createError;
                return;
            }
            session = newSession;
        }

        this.currentSessionId = session.id;
        this.currentSession = session;
        this.agentJoined = !!session.is_manual_mode;
    }

    subscribeRealtime() {
        if (this.messageChannel) supabase.removeChannel(this.messageChannel);

        this.messageChannel = supabase
            .channel(`chat-widget:${this.currentSessionId}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'chat_messages',
                filter: `session_id=eq.${this.currentSessionId}`
            }, payload => this.appendMessage(payload.new))
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'chat_sessions',
                filter: `id=eq.${this.currentSessionId}`
            }, payload => this.handleSessionUpdate(payload.new))
            .subscribe();
    }

    async loadMessages() {
        const { data: messages, error } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('session_id', this.currentSessionId)
            .order('created_at', { ascending: true });

        if (error) {
            console.error('خطأ في جلب الرسائل:', error);
            this.renderErrorState();
            return;
        }

        this.renderChatShell();
        const body = document.getElementById('chatWidgetBody');
        body.innerHTML = '';
        this.transcriptLines = [];

        (messages || []).forEach(msg => this.renderMessageBubble(msg));
        body.scrollTop = body.scrollHeight;

        if (!messages || messages.length === 0) {
            await this.sendInitialGreeting();
        } else if (!this.currentSession?.is_manual_mode) {
            this.renderQuickOptions(getOptionsForFlow(this.currentSession?.bot_state?.flow));
        }

        if (this.agentJoined) {
            const headerStatus = document.getElementById('headerStatus');
            if (headerStatus) headerStatus.textContent = 'فريق الدعم متصل الآن';
        }
    }

    async sendInitialGreeting() {
        if (!this.currentSessionId) return;
        const welcome = this.botSettings?.welcome_message || 'أهلاً بيك في منصة مدعوم! 👋';
        const greetingText = `${welcome}\nاختار من الاختيارات دي 👇 أو اكتبلي طلبك بحريتك:`;

        await supabase.from('chat_sessions').update({ bot_state: { greeted: true, flow: 'main_menu' } }).eq('id', this.currentSessionId);

        // الإدراج هيوصل عن طريق الاشتراك الفوري (subscribeRealtime) ويتعرض تلقائياً
        await supabase.from('chat_messages').insert({
            session_id: this.currentSessionId,
            sender_id: null,
            message_text: greetingText,
            is_admin_reply: false,
            is_bot_reply: true
        });

        this.renderQuickOptions(MAIN_MENU_OPTIONS);
    }

    /* ==================== أحداث الجلسة الفورية (انضمام/مغادرة فريق الدعم) ==================== */

    handleSessionUpdate(newSession) {
        const wasManual = !!this.currentSession?.is_manual_mode;
        this.currentSession = newSession;

        if (!wasManual && newSession.is_manual_mode) {
            this.markAgentJoined();
        }
        if (newSession.status === 'closed' && this.agentJoined) {
            this.markAgentLeft();
        }
    }

    markAgentJoined() {
        if (this.agentJoined) return;
        this.agentJoined = true;
        this.appendSystemEvent('فريق الدعم انضم إلى المحادثة');
        const headerStatus = document.getElementById('headerStatus');
        if (headerStatus) headerStatus.textContent = 'فريق الدعم متصل الآن';
    }

    markAgentLeft() {
        if (!this.agentJoined) return;
        this.agentJoined = false;
        this.appendSystemEvent('فريق الدعم غادر المحادثة');
        const headerStatus = document.getElementById('headerStatus');
        if (headerStatus) headerStatus.textContent = 'المحادثة';
    }

    /* ==================== عرض الرسائل ==================== */

    renderMessageBubble(msg) {
        const body = document.getElementById('chatWidgetBody');
        if (!body) return;

        const isOwn = this.currentUser && msg.sender_id === this.currentUser.id;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const text = msg.message_text || '';

        const div = document.createElement('div');
        div.className = `chat-widget-message ${isOwn ? 'user' : 'bot'}`;
        div.innerHTML = `
      <div class="chat-widget-bubble">
        ${iconize(escapeHtml(text)).replace(/\n/g, '<br>')}
        <div class="chat-widget-msg-time">${time}</div>
      </div>
    `;
        body.appendChild(div);

        const who = isOwn ? 'أنا' : (msg.is_admin_reply ? 'الدعم الفني' : 'البوت');
        this.transcriptLines.push(`[${time}] ${who}: ${text}`);
    }

    /**
     * الرسالة الجاية من الاشتراك الفوري (realtime) - بترندر البابل، وكمان
     * بتكتشف أول رد بشري (is_admin_reply) عشان تظهر حدث "انضم إلى المحادثة".
     */
    appendMessage(msg) {
        if (msg.is_admin_reply) this.markAgentJoined();

        this.renderMessageBubble(msg);
        const body = document.getElementById('chatWidgetBody');
        if (body) body.scrollTop = body.scrollHeight;
    }

    appendSystemEvent(text) {
        const body = document.getElementById('chatWidgetBody');
        if (!body) return;

        const time = new Date();
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-widget-system-event';
        wrapper.innerHTML = `
      <div class="chat-widget-avatar" style="background:${this.getAvatarGradient('agent')}"></div>
      <div class="chat-widget-system-text">${escapeHtml(text)}</div>
      <div class="chat-widget-system-time">${this.formatEventTimestamp(time)}</div>
    `;
        body.appendChild(wrapper);
        body.scrollTop = body.scrollHeight;

        this.transcriptLines.push(`[${this.formatEventTimestamp(time)}] * ${text}`);
    }

    /* ==================== الأزرار السريعة (Quick replies) ==================== */

    clearQuickOptions() {
        const existing = document.getElementById('botQuickOptions');
        if (existing) existing.remove();
    }

    renderQuickOptions(options) {
        this.clearQuickOptions();
        if (!options || options.length === 0) return;

        const body = document.getElementById('chatWidgetBody');
        if (!body) return;

        const wrap = document.createElement('div');
        wrap.className = 'bot-quick-options';
        wrap.id = 'botQuickOptions';

        options.forEach(opt => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'bot-quick-option-btn';
            btn.innerHTML = iconize(escapeHtml(opt.label));
            btn.addEventListener('click', () => {
                wrap.querySelectorAll('button').forEach(b => (b.disabled = true));
                this.sendMessage(opt.value);
            });
            wrap.appendChild(btn);
        });

        body.appendChild(wrap);
        body.scrollTop = body.scrollHeight;
    }

    /* ==================== إرسال رسالة (عبر محرك البوت المحلي) ==================== */

    async sendMessage(presetText) {
        const input = document.getElementById('chatWidgetTextInput');
        const text = (presetText !== undefined ? presetText : input?.value || '').trim();
        if (!text || !this.currentSessionId || !this.currentUser) return;

        if (presetText === undefined && input) input.value = '';
        this.clearQuickOptions();
        const typingIndicator = document.getElementById('chatWidgetTyping');
        const typingText = document.getElementById('chatWidgetTypingText');

        const { error: sendError } = await supabase.from('chat_messages').insert({
            session_id: this.currentSessionId,
            sender_id: this.currentUser.id,
            message_text: text,
            is_admin_reply: false
        });

        if (sendError) {
            console.error('خطأ في إرسال الرسالة:', sendError);
            return;
        }

        try {
            if (typingText) {
                // "جاري اتخاذ القرار..." لوضع SIE (محرك تشخيص/قرار)، وإلا نص عام
                // "جاري التفكير..." للمحرك التقليدي. بيفضل ظاهر طول مراحل المعالجة
                // كلها (مش بس نداء الـ API) لحد ما finally يقفله تحت.
                typingText.textContent = this.cachedChatbotMode === 'sie' ? 'جاري اتخاذ القرار...' : 'جاري التفكير...';
            }
            if (typingIndicator) typingIndicator.style.display = 'flex';

            if (this.currentSession?.is_manual_mode) return;

            const { data: freshSession } = await supabase
                .from('chat_sessions')
                .select('bot_state, is_manual_mode')
                .eq('id', this.currentSessionId)
                .single();

            if (freshSession?.is_manual_mode) return;

            // نفس منطق البوابتين المزدوج الموجود في chat-logic.js، لكن دلوقتي
            // بدون silent fallback: لو العميل مختار SIE (this.cachedChatbotMode)
            // لكن صلاحيته اتسحبت من الإدارة وهو في نص محادثة، بنوقف ونبلّغه
            // بوضوح جوه الشات نفسه، بدل ما نرجّعه صامت للمحرك التقليدي.
            let reply;
            let options;

            if (this.cachedChatbotMode === 'sie') {
                const sieAccess = await getSieAccessInfo(this.currentUser.id);
                if (!sieAccess.available) {
                    await this.handleSieRevokedMidConversation(sieAccess);
                    return;
                }
                const sieResult = await getSieReply({
                    text,
                    supabase,
                    sessionId: this.currentSessionId,
                    userId: this.currentUser.id,
                    botState: freshSession?.bot_state || {}
                });
                if (!sieResult) {
                    await supabase.from('chat_messages').insert({
                        session_id: this.currentSessionId,
                        sender_id: null,
                        message_text: 'محرك الدعم الذكي (SIE) واجه مشكلة مؤقتة في الرد على رسالتك. جرّب تبعتها تاني، أو اختار وضع تاني من إعدادات الشات.',
                        is_admin_reply: false,
                        is_bot_reply: true
                    });
                    return;
                }
                // نفس منطق chat-logic.js: SIE بيكتب دور المحادثة بنفسه
                // لما يقول alreadyPersisted - رسالة البوت و bot_state
                // والتذكرة لو اتفتحت، كلهم في معاملة واحدة عنده. لو
                // كتبنا هنا كمان، العميل هيشوف نفس الرد مرتين.
                if (sieResult.alreadyPersisted) {
                    this.renderQuickOptions(sieResult.options);
                    return;
                }

                // الشكل القديم: SIE بيرجّع بيانات بس والكتابة علينا.
                reply = sieResult.reply;
                options = sieResult.options;
                if (sieResult.botState !== undefined) {
                    await supabase.from('chat_sessions').update({ bot_state: sieResult.botState }).eq('id', this.currentSessionId);
                }
            } else {
                const botReply = await getBotReply({
                    text,
                    supabase,
                    sessionId: this.currentSessionId,
                    userId: this.currentUser.id,
                    botState: freshSession?.bot_state || {},
                    botSettings: this.botSettings
                });
                reply = botReply.reply;
                options = botReply.options;
            }

            await supabase.from('chat_messages').insert({
                session_id: this.currentSessionId,
                sender_id: null,
                message_text: reply,
                is_admin_reply: false,
                is_bot_reply: true
            });

            this.renderQuickOptions(options);
        } catch (err) {
            console.error('خطأ في البوت:', err);
            await supabase.from('chat_messages').insert({
                session_id: this.currentSessionId,
                sender_id: null,
                message_text: 'عذراً، حدث خطأ بسيط أثناء معالجة طلبك. تقدر تكتب "عندي مشكلة" وهافتحلك تذكرة دعم مباشرة.',
                is_admin_reply: false,
                is_bot_reply: true
            });
        } finally {
            if (typingIndicator) typingIndicator.style.display = 'none';
        }
    }

    /* ==================== تقديم بيانات التواصل تلقائياً ==================== */

    async submitContactDetails() {
        if (!this.currentUser) return;

        if (!this.userProfile) await this.loadProfile();
        const p = this.userProfile || {};

        const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || 'غير محدد';
        const email = p.email || this.currentUser.email || 'غير متوفر';
        const phone = p.phone || 'غير متوفر';
        const joinedDate = p.created_at
            ? new Date(p.created_at).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'غير متوفر';

        const text = `بيانات التواصل الخاصة بي:\nالاسم: ${name}\nالبريد الإلكتروني: ${email}\nرقم الهاتف: ${phone}\nتاريخ التسجيل: ${joinedDate}`;

        if (!this.currentSessionId) {
            // لو المستخدم فتح الإعدادات قبل ما تخلص تهيئة المحادثة، ننتظرها
            await this.startChat();
        }
        if (!this.currentSessionId) return;

        const { error } = await supabase.from('chat_messages').insert({
            session_id: this.currentSessionId,
            sender_id: this.currentUser.id,
            message_text: text,
            is_admin_reply: false
        });

        if (error) console.error('خطأ في إرسال بيانات التواصل:', error);

        this.toggleSettingsPanel(false);
    }

    /* ==================== إنهاء المحادثة ==================== */

    async endChat() {
        if (!this.currentSessionId) return;
        if (!confirm('هل تريد إنهاء المحادثة؟')) return;

        const { error } = await supabase
            .from('chat_sessions')
            .update({ status: 'closed' })
            .eq('id', this.currentSessionId);

        if (error) {
            console.error('خطأ في إنهاء المحادثة:', error);
            return;
        }

        if (this.agentJoined) this.markAgentLeft();
        this.renderEndedState();

        if (this.messageChannel) {
            supabase.removeChannel(this.messageChannel);
            this.messageChannel = null;
        }
        this.chatInitialized = false;
        this.currentSessionId = null;
        this.currentSession = null;
    }

    /* ==================== حالات عرض مختلفة (تحميل / خروج / خطأ / إنهاء) ==================== */

    renderLoadingState() {
        const body = document.getElementById('chatWidgetBody');
        const footer = document.getElementById('chatWidgetFooter');
        if (body) body.innerHTML = `<div class="chat-widget-center-state">جاري تحميل المحادثة...</div>`;
        if (footer) footer.innerHTML = '';
    }

    renderLoggedOutState() {
        const body = document.getElementById('chatWidgetBody');
        const footer = document.getElementById('chatWidgetFooter');
        const header = document.getElementById('headerStatus');
        if (header) header.textContent = 'يجب تسجيل الدخول';

        if (body) {
            body.innerHTML = `
        <div class="chat-widget-center-state">
          <p>محتاج تسجّل دخولك الأول عشان تقدر تبدأ محادثة مع فريق الدعم.</p>
          <a href="/sign-in.html" class="chat-widget-primary-link">تسجيل الدخول</a>
        </div>
      `;
        }
        if (footer) footer.innerHTML = '';
    }

    renderErrorState() {
        const body = document.getElementById('chatWidgetBody');
        const footer = document.getElementById('chatWidgetFooter');
        // لو الخطأ حصل وقت "الدخول كعضو" تحديدًا، الرسالة العامة مضلّلة -
        // بتوحي إن فيه مشكلة عشوائية، بينما فعليًا السبب الأرجح معروف (فرق
        // بين جلسة Supabase الحقيقية وuser_id المستهدف، على مستوى RLS في
        // الباك إند) ومحتاج تدخل هناك، مش مجرد "جرب تاني".
        const message = this.isImpersonated
            ? 'تعذّر فتح محادثة باسم هذا العضو أثناء "الدخول كعضو". هذه مشكلة معروفة في صلاحيات قاعدة البيانات (RLS) تحتاج تعديل من فريق التطوير الخلفي، وليست مشكلة في المتصفح.'
            : 'حصل خطأ في تحميل المحادثة، جرب تقفل وتفتح الويدجت تاني.';
        if (body) body.innerHTML = `<div class="chat-widget-center-state">${message}</div>`;
        if (footer) footer.innerHTML = '';
    }

    renderEndedState() {
        const body = document.getElementById('chatWidgetBody');
        const footer = document.getElementById('chatWidgetFooter');
        const header = document.getElementById('headerStatus');
        if (header) header.textContent = 'انتهت المحادثة';
        if (body) {
            const div = document.createElement('div');
            div.className = 'chat-widget-center-state';
            div.innerHTML = `<p>تم إنهاء المحادثة 🌟<br>شكراً لتواصلك معنا.</p>`;
            body.appendChild(div);
            body.scrollTop = body.scrollHeight;
        }
        if (footer) footer.innerHTML = '';
    }

    renderChatShell() {
        const header = document.getElementById('headerStatus');
        if (header && !this.agentJoined) header.textContent = 'المحادثة';

        const footer = document.getElementById('chatWidgetFooter');
        if (!footer) return;
        footer.innerHTML = '';

        const row = document.createElement('div');
        row.className = 'chat-widget-input-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'chatWidgetTextInput';
        input.className = 'chat-widget-text-input';
        input.placeholder = 'اكتب رسالتك هنا...';
        input.autocomplete = 'off';
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });

        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'chat-widget-send-btn';
        sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform: rotate(180deg);"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"></path></svg>`;
        sendBtn.addEventListener('click', () => this.sendMessage());

        row.appendChild(input);
        row.appendChild(sendBtn);
        footer.appendChild(row);

        const endBtn = document.createElement('button');
        endBtn.type = 'button';
        endBtn.textContent = 'إنهاء المحادثة';
        endBtn.className = 'chat-widget-end-btn';
        endBtn.addEventListener('click', () => this.endChat());
        footer.appendChild(endBtn);
    }
}

// تهيئة الويدجت عند تحميل الصفحة
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.chatWidget = new ChatWidget();
    });
} else {
    window.chatWidget = new ChatWidget();
}
