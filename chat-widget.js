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
        this.renderUnread?.();
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
      <div class="floating-chat-widget" id="floatingChatWidget" dir="rtl">
        <button type="button" class="chat-bubble-btn" id="chatBubbleBtn" aria-label="فتح الدعم المباشر" aria-controls="chatWidgetPanel" aria-expanded="false">
          <span class="chat-bubble-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              <path d="M8 9h8M8 13h5"></path>
            </svg>
          </span>
          <span class="chat-bubble-badge" id="chatBubbleBadge" hidden></span>
        </button>

        <div class="chat-widget-panel" id="chatWidgetPanel" role="dialog" aria-labelledby="chatWidgetTitle" data-state="idle">
          <!-- Header -->
          <div class="chat-widget-header" id="chatWidgetHeader">
            <div class="chat-widget-header-title">
              <div class="chat-widget-header-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                  <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
                </svg>
                <span class="chat-widget-presence"></span>
              </div>
              <div>
                <h3 id="chatWidgetTitle">الدعم المباشر</h3>
                <p id="headerStatus">فريق مدعوم جاهز لمساعدتك</p>
              </div>
            </div>
            <div class="chat-widget-header-actions">
              <button type="button" class="chat-header-icon-btn" id="chatSettingsBtn" aria-label="خيارات المحادثة" aria-haspopup="true" aria-expanded="false" aria-controls="chatSettingsPanel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
              </button>
              <button type="button" class="chat-header-icon-btn" id="chatMaximizeBtn" aria-label="تكبير النافذة" data-desktop-only>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
              </button>
              <button type="button" class="chat-header-icon-btn" id="chatMinimizeBtn" aria-label="تصغير">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <button type="button" class="chat-header-icon-btn chat-widget-close" id="chatWidgetClose" aria-label="إغلاق">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
          </div>

          <!-- بانر "عرض كعضو" - يظهر بس وقت الـimpersonation، فيه اسم العضو وزرار رجوع واضح -->
          <div id="chatImpersonationBanner" style="display:none;"></div>

          <!-- Settings dropdown -->
          <div class="chat-settings-panel" id="chatSettingsPanel" role="menu" aria-label="خيارات المحادثة">
            <div class="chat-settings-item" id="contactDetailsItem">
              <span class="chat-settings-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              </span>
              <span class="chat-settings-label">إرسال بيانات التواصل</span>
              <a href="/login.html" class="chat-settings-action" id="chatLoginLink">تسجيل الدخول</a>
              <button type="button" class="chat-settings-action chat-settings-provide-btn" id="chatProvideBtn" style="display:none;">إرسال</button>
            </div>
            <div class="chat-settings-item chat-settings-item-clickable" id="chatModeItem" role="menuitem" tabindex="0">
              <span class="chat-settings-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9h10M7 13h6"></path></svg>
              </span>
              <span class="chat-settings-label">وضع الرد الآلي</span>
              <span class="chat-settings-value" id="chatModeCurrentLabel">تقليدي</span>
            </div>
            <div class="chat-settings-item chat-settings-item-clickable" id="downloadTranscriptItem" role="menuitem" tabindex="0">
              <span class="chat-settings-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              </span>
              <span class="chat-settings-label">تحميل نص المحادثة</span>
            </div>
            <div class="chat-settings-item chat-settings-item-clickable" id="maximizeItem" role="menuitem" tabindex="0">
              <span class="chat-settings-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"></path></svg>
              </span>
              <span class="chat-settings-label" id="maximizeLabel">تكبير النافذة</span>
            </div>
            <div class="chat-settings-item">
              <span class="chat-settings-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>
              </span>
              <label class="chat-settings-label" for="notificationsToggle">تنبيه بالرسائل الجديدة</label>
              <label class="chat-toggle-switch">
                <input type="checkbox" id="notificationsToggle" role="switch" ${this.notificationsEnabled ? 'checked' : ''}>
                <span class="chat-toggle-slider" aria-hidden="true"></span>
              </label>
            </div>
          </div>

          <!-- Body -->
          <div class="chat-widget-body" id="chatWidgetBody" role="log" aria-live="polite" aria-relevant="additions"></div>

          <div id="chatWidgetTyping" class="chat-widget-typing-row" style="display:none;" aria-live="polite">
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
        const maximizeBtn = document.getElementById('chatMaximizeBtn');
        const settingsBtn = document.getElementById('chatSettingsBtn');
        const downloadItem = document.getElementById('downloadTranscriptItem');
        const maximizeItem = document.getElementById('maximizeItem');
        const notifToggle = document.getElementById('notificationsToggle');
        const provideBtn = document.getElementById('chatProvideBtn');
        const chatModeItem = document.getElementById('chatModeItem');
        const header = document.getElementById('chatWidgetHeader');

        if (!bubbleBtn || !closeBtn) {
            console.error('[ChatWidget] Failed to find chat elements');
            return;
        }

        bubbleBtn.addEventListener('click', () => {
            const panel = document.getElementById('chatWidgetPanel');
            if (panel?.classList.contains('active') && !this.isMinimized) this.closeWidget();
            else this.openWidget();
        });
        closeBtn.addEventListener('click', () => this.closeWidget());
        minimizeBtn.addEventListener('click', () => this.toggleMinimize());
        maximizeBtn?.addEventListener('click', () => this.toggleMaximize());
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleSettingsPanel();
        });
        downloadItem.addEventListener('click', () => this.downloadTranscript());
        maximizeItem.addEventListener('click', () => {
            this.toggleMaximize();
            this.toggleSettingsPanel(false);
        });
        notifToggle.addEventListener('change', (e) => this.setNotificationsPref(e.target.checked));
        provideBtn.addEventListener('click', () => this.submitContactDetails());
        chatModeItem.addEventListener('click', () => this.openChatModeDialog());

        // عناصر القائمة القابلة للنقر تعمل بلوحة المفاتيح أيضًا (Enter / Space)
        [downloadItem, maximizeItem, chatModeItem].forEach(item => {
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    item.click();
                }
            });
        });

        // الرأس في الوضع المصغّر = شريط يُستعاد بالنقر (ما لم يكن سحبًا)
        header?.addEventListener('click', (e) => {
            if (!this.isMinimized || this.didDrag) return;
            if (e.target.closest('.chat-header-icon-btn')) return;
            this.toggleMinimize();
        });

        document.addEventListener('click', (e) => {
            const panel = document.getElementById('chatSettingsPanel');
            const settingsButton = document.getElementById('chatSettingsBtn');
            if (this.isSettingsOpen && panel && !panel.contains(e.target) && !settingsButton?.contains(e.target)) {
                this.toggleSettingsPanel(false);
            }
        });

        // Escape: يغلق القائمة أولًا، ثم النافذة — ويعيد التركيز لزر الإطلاق
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const root = document.getElementById('floatingChatWidget');
            if (!root || !root.contains(document.activeElement)) return;
            if (this.isSettingsOpen) {
                this.toggleSettingsPanel(false);
                document.getElementById('chatSettingsBtn')?.focus();
                return;
            }
            this.closeWidget();
            document.getElementById('chatBubbleBtn')?.focus();
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

        // على الجوال النافذة ورقة كاملة (chat-widget.css) — لا معنى للسحب هناك،
        // وأي موضع مسحوب محفوظ كان سيُخرجها عن الشاشة.
        const isCompact = () => window.matchMedia('(max-width: 640px)').matches;

        const beginDrag = (clientX, clientY, target) => {
            this.didDrag = false;
            if (isOnActionButton(target) || isCompact() || this.isMinimized) return;
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
            if (Math.abs(deltaX) + Math.abs(deltaY) > 3) this.didDrag = true;
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

        // الانتقال لشاشة صغيرة يلغي أي موضع مسحوب حتى لا تبقى النافذة خارجها
        window.matchMedia('(max-width: 640px)').addEventListener?.('change', (e) => {
            if (e.matches) this.resetPanelPosition();
        });
    }

    resetPanelPosition() {
        const panel = document.getElementById('chatWidgetPanel');
        if (!panel) return;
        ['position', 'left', 'top', 'bottom', 'right'].forEach(prop => panel.style.removeProperty(prop));
        this.dragPosition = null;
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
            window.location.href = '/login.html';
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
    async insertSieTemporaryProblem() {
        await supabase.from('chat_messages').insert({
            session_id: this.currentSessionId,
            sender_id: null,
            message_text: 'محرك الدعم الذكي (SIE) واجه مشكلة مؤقتة في الرد على رسالتك. جرّب تبعتها تاني، أو اختار وضع تاني من إعدادات الشات.',
            is_admin_reply: false,
            is_bot_reply: true
        });
    }

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
        this.syncOpenState();
        this.clearUnread();

        if (!this.chatInitialized) {
            this.chatInitialized = true;
            await this.startChat();
        } else {
            this.focusComposer();
        }
    }

    closeWidget() {
        const panel = document.getElementById('chatWidgetPanel');
        if (!panel) return;
        panel.classList.remove('active');
        this.toggleSettingsPanel(false);
        this.syncOpenState();
        // ملاحظة: إغلاق النافذة مايقفلش المحادثة نفسها - الجلسة تفضل شغالة
        // ولو العميل فتح الويدجت تاني هيكمل من نفس مكانه.
    }

    toggleMinimize() {
        const panel = document.getElementById('chatWidgetPanel');
        if (!panel) return;
        this.isMinimized = !this.isMinimized;
        panel.classList.toggle('minimized', this.isMinimized);
        if (this.isMinimized) this.toggleSettingsPanel(false);
        else { this.clearUnread(); this.focusComposer(); }

        const btn = document.getElementById('chatMinimizeBtn');
        if (btn) {
            btn.setAttribute('aria-label', this.isMinimized ? 'استعادة النافذة' : 'تصغير');
            btn.innerHTML = this.isMinimized
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
        }
        this.syncOpenState();
    }

    toggleMaximize() {
        const panel = document.getElementById('chatWidgetPanel');
        const label = document.getElementById('maximizeLabel');
        const btn = document.getElementById('chatMaximizeBtn');
        if (!panel) return;
        this.isMaximized = !this.isMaximized;
        panel.classList.toggle('maximized', this.isMaximized);
        // نافذة مسحوبة لمكان بعينه قد لا تتسع للحجم الأكبر — نعيدها لركنها
        if (this.isMaximized) this.resetPanelPosition();
        if (label) label.textContent = this.isMaximized ? 'استعادة الحجم' : 'تكبير النافذة';
        if (btn) {
            btn.setAttribute('aria-label', this.isMaximized ? 'استعادة الحجم' : 'تكبير النافذة');
            btn.innerHTML = this.isMaximized
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
        }
    }

    toggleSettingsPanel(force) {
        const panel = document.getElementById('chatSettingsPanel');
        if (!panel) return;
        this.isSettingsOpen = force !== undefined ? force : !this.isSettingsOpen;
        panel.classList.toggle('active', this.isSettingsOpen);
        document.getElementById('chatSettingsBtn')?.setAttribute('aria-expanded', String(this.isSettingsOpen));
    }

    /** حالة الفتح على الجذر وزر الإطلاق و<body> — مساعد الإعداد يختفي حين تكون المحادثة مفتوحة. */
    syncOpenState() {
        const panel = document.getElementById('chatWidgetPanel');
        const open = !!panel?.classList.contains('active');
        const root = document.getElementById('floatingChatWidget');
        root?.classList.toggle('is-open', open);
        root?.classList.toggle('is-minimized', open && this.isMinimized);
        document.body.classList.toggle('chat-widget-open', open && !this.isMinimized);
        const bubble = document.getElementById('chatBubbleBtn');
        if (bubble) {
            bubble.setAttribute('aria-expanded', String(open && !this.isMinimized));
            bubble.setAttribute('aria-label', open && !this.isMinimized ? 'إغلاق الدعم المباشر' : 'فتح الدعم المباشر');
        }
    }

    focusComposer() {
        // لا نسرق التركيز على الشاشات اللمسية: لوحة المفاتيح ستغطي نصف المحادثة
        if (window.matchMedia('(pointer: coarse)').matches) return;
        document.getElementById('chatWidgetTextInput')?.focus({ preventScroll: true });
    }

    /* ==================== الرسائل غير المقروءة ==================== */

    /** رسالة وصلت والنافذة مغلقة أو مصغّرة — العدّاد يتبع خيار «تنبيه بالرسائل الجديدة». */
    noteIncoming() {
        const panel = document.getElementById('chatWidgetPanel');
        const visible = panel?.classList.contains('active') && !this.isMinimized;
        if (visible || !this.notificationsEnabled) return;
        this.unreadCount = (this.unreadCount || 0) + 1;
        this.renderUnread();
    }

    clearUnread() {
        this.unreadCount = 0;
        this.renderUnread();
    }

    renderUnread() {
        const badge = document.getElementById('chatBubbleBadge');
        if (!badge) return;
        const n = this.notificationsEnabled ? (this.unreadCount || 0) : 0;
        badge.hidden = n === 0;
        badge.textContent = n > 9 ? '9+' : String(n);
        badge.setAttribute('aria-label', `${n} رسائل جديدة`);
    }

    /** نص الحالة في الرأس + نقطة الحضور (idle / online / agent / error / offline). */
    setHeaderStatus(text, state) {
        const headerStatus = document.getElementById('headerStatus');
        if (headerStatus) headerStatus.textContent = text;
        const panel = document.getElementById('chatWidgetPanel');
        if (panel && state) panel.dataset.state = state;
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
        this.lastRendered = null;
        this.renderIntro();

        (messages || []).forEach(msg => this.renderMessageBubble(msg));
        body.scrollTop = body.scrollHeight;
        this.focusComposer();

        if (!messages || messages.length === 0) {
            await this.sendInitialGreeting();
        } else if (!this.currentSession?.is_manual_mode) {
            this.renderQuickOptions(getOptionsForFlow(this.currentSession?.bot_state?.flow));
        }

        if (this.agentJoined) this.setHeaderStatus('فريق الدعم متصل الآن', 'agent');
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
        this.setHeaderStatus('فريق الدعم متصل الآن', 'agent');
    }

    markAgentLeft() {
        if (!this.agentJoined) return;
        this.agentJoined = false;
        this.appendSystemEvent('فريق الدعم غادر المحادثة');
        this.setHeaderStatus('المساعد الآلي يتابع معك', 'online');
    }

    /* ==================== عرض الرسائل ==================== */

    /** بطاقة الترحيب أعلى المحادثة — ثابتة، لا تُحسب رسالة ولا تدخل النص المحمَّل. */
    renderIntro() {
        const body = document.getElementById('chatWidgetBody');
        if (!body) return;
        const intro = document.createElement('div');
        intro.className = 'chat-widget-intro';
        intro.innerHTML = `
      <span class="chat-widget-intro-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 12 2 2 4-4"></path></svg>
      </span>
      <p class="chat-widget-intro-title">دعم مدعوم</p>
      <p class="chat-widget-intro-text">المساعد الآلي يرد فورًا، وفريق الدعم ينضم للمحادثة عند الحاجة.</p>
    `;
        body.appendChild(intro);
    }

    dayLabel(date) {
        const d = new Date(date);
        const today = new Date();
        const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
        if (diff === 0) return 'اليوم';
        if (diff === 1) return 'أمس';
        return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
    }

    senderOf(msg) {
        const isOwn = !!(this.currentUser && msg.sender_id === this.currentUser.id);
        if (isOwn) return { key: 'self', who: 'أنت', isOwn: true };
        if (msg.is_admin_reply) return { key: `agent:${msg.sender_id || ''}`, who: 'فريق الدعم', isAgent: true };
        return { key: 'bot', who: 'المساعد الآلي' };
    }

    renderMessageBubble(msg) {
        const body = document.getElementById('chatWidgetBody');
        if (!body) return;

        const sender = this.senderOf(msg);
        const created = msg.created_at ? new Date(msg.created_at) : new Date();
        const time = created.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const text = msg.message_text || '';

        // فاصل يوم عند تغيّر التاريخ، وتجميع الرسائل المتتالية من نفس المرسل
        const dayKey = created.toDateString();
        if (this.lastRendered?.day !== dayKey) {
            const sep = document.createElement('div');
            sep.className = 'chat-widget-day';
            sep.textContent = this.dayLabel(created);
            body.appendChild(sep);
        }
        const continued = this.lastRendered?.day === dayKey
            && this.lastRendered?.sender === sender.key
            && created - this.lastRendered.at < 5 * 60 * 1000;

        const div = document.createElement('div');
        div.className = `chat-widget-message ${sender.isOwn ? 'user' : 'bot'}${sender.isAgent ? ' is-agent' : ''}${continued ? ' is-continued' : ''}`;
        const avatar = sender.isOwn ? '' : `<span class="chat-widget-msg-avatar" aria-hidden="true">${sender.isAgent
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"></rect><path d="M12 8V4M9 14h.01M15 14h.01"></path></svg>'}</span>`;
        div.innerHTML = `
      ${avatar}
      <div class="chat-widget-message-content">
        <div class="chat-widget-bubble">${iconize(escapeHtml(text)).replace(/\n/g, '<br>')}</div>
        <div class="chat-widget-msg-meta">${continued ? '' : `<span class="chat-widget-msg-who">${sender.who}</span>`}<time class="chat-widget-msg-time" datetime="${created.toISOString()}">${time}</time></div>
      </div>
    `;
        if (msg.id) div.dataset.msgId = String(msg.id);
        body.appendChild(div);
        this.lastRendered = { day: dayKey, sender: sender.key, at: created };

        const who = sender.isOwn ? 'أنا' : (msg.is_admin_reply ? 'الدعم الفني' : 'البوت');
        this.transcriptLines.push(`[${time}] ${who}: ${text}`);
    }

    /**
     * الرسالة الجاية من الاشتراك الفوري (realtime) - بترندر البابل، وكمان
     * بتكتشف أول رد بشري (is_admin_reply) عشان تظهر حدث "انضم إلى المحادثة".
     */
    appendMessage(msg) {
        if (msg.is_admin_reply) this.markAgentJoined();

        // الاشتراك الفوري قد يعيد رسالة رُسمت للتو (أو يصل بعد إعادة تحميل)
        if (msg.id && document.querySelector(`#chatWidgetBody [data-msg-id="${CSS.escape(String(msg.id))}"]`)) return;

        this.renderMessageBubble(msg);
        const body = document.getElementById('chatWidgetBody');
        // الرسالة السريعة تبقى آخر عنصر، تحت الرد لا فوقه
        const quick = document.getElementById('botQuickOptions');
        if (quick && body) body.appendChild(quick);
        if (body) body.scrollTop = body.scrollHeight;
        if (!(this.currentUser && msg.sender_id === this.currentUser.id)) this.noteIncoming();
    }

    appendSystemEvent(text) {
        const body = document.getElementById('chatWidgetBody');
        if (!body) return;

        const time = new Date();
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-widget-system-event';
        wrapper.setAttribute('role', 'status');
        wrapper.innerHTML = `
      <span class="chat-widget-system-text">${escapeHtml(text)}</span>
      <time class="chat-widget-system-time" datetime="${time.toISOString()}">${time.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</time>
    `;
        body.appendChild(wrapper);
        body.scrollTop = body.scrollHeight;
        this.lastRendered = null;

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
        // ضغطتان سريعتان على Enter كانتا ترسلان الرسالة مرتين
        if (this.isSending) return;
        this.isSending = true;
        this.setComposerBusy(true);
        this.showComposerError(null);

        if (presetText === undefined && input) {
            input.value = '';
            this.autoSizeComposer();
        }
        const quickOptions = document.getElementById('botQuickOptions');
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
            // الرسالة لم تصل: نعيد النص لمكانه بدل أن يختفي بصمت، ونعرض سببًا وإعادة محاولة
            this.isSending = false;
            this.setComposerBusy(false);
            if (presetText === undefined && input && !input.value) {
                input.value = text;
                this.autoSizeComposer();
            }
            if (quickOptions) {
                quickOptions.querySelectorAll('button').forEach(b => (b.disabled = false));
                document.getElementById('chatWidgetBody')?.appendChild(quickOptions);
            }
            this.showComposerError('تعذّر إرسال رسالتك. تحقّق من الاتصال وحاول مرة أخرى.', () => this.sendMessage(presetText));
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
                // عطل مؤقت في التحقق (شبكة، 5xx، circuit مفتوح) مش سحب
                // صلاحية: منحوّلش العميل ومنحفظش "تقليدي" على أساسه.
                if (sieAccess.checkFailed) {
                    await this.insertSieTemporaryProblem();
                    return;
                }
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
                    await this.insertSieTemporaryProblem();
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
            this.isSending = false;
            this.setComposerBusy(false);
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

        const { error } = await supabase
            .from('chat_sessions')
            .update({ status: 'closed' })
            .eq('id', this.currentSessionId);

        if (error) {
            console.error('خطأ في إنهاء المحادثة:', error);
            this.showComposerError('تعذّر إنهاء المحادثة. حاول مرة أخرى.');
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

    stateHtml({ tone = '', icon, title, text, action = '' }) {
        const icons = {
            lock: '<path d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z"></path><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
            alert: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
            check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
        };
        return `
      <div class="chat-widget-center-state ${tone}">
        <span class="chat-widget-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[icon] || ''}</svg></span>
        <p class="chat-widget-center-title">${title}</p>
        <p>${text}</p>
        ${action}
      </div>`;
    }

    renderLoadingState() {
        const body = document.getElementById('chatWidgetBody');
        const footer = document.getElementById('chatWidgetFooter');
        this.setHeaderStatus('جاري الاتصال…', 'idle');
        if (body) {
            body.innerHTML = `
        <div class="chat-widget-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
        <p class="visually-hidden">جاري تحميل المحادثة...</p>`;
            body.setAttribute('aria-busy', 'true');
        }
        if (footer) footer.innerHTML = '';
    }

    renderLoggedOutState() {
        const body = document.getElementById('chatWidgetBody');
        const footer = document.getElementById('chatWidgetFooter');
        this.setHeaderStatus('يجب تسجيل الدخول', 'offline');

        if (body) {
            body.removeAttribute('aria-busy');
            body.innerHTML = this.stateHtml({
                icon: 'lock',
                title: 'سجّل دخولك للبدء',
                text: 'محتاج تسجّل دخولك الأول عشان تقدر تبدأ محادثة مع فريق الدعم.',
                action: '<a href="/login.html" class="chat-widget-primary-link">تسجيل الدخول</a>'
            });
        }
        if (footer) footer.innerHTML = '';
    }

    renderErrorState() {
        const body = document.getElementById('chatWidgetBody');
        const footer = document.getElementById('chatWidgetFooter');
        this.setHeaderStatus('تعذّر الاتصال', 'error');
        // لو الخطأ حصل وقت "الدخول كعضو" تحديدًا، الرسالة العامة مضلّلة -
        // بتوحي إن فيه مشكلة عشوائية، بينما فعليًا السبب الأرجح معروف (فرق
        // بين جلسة Supabase الحقيقية وuser_id المستهدف، على مستوى RLS في
        // الباك إند) ومحتاج تدخل هناك، مش مجرد "جرب تاني".
        const message = this.isImpersonated
            ? 'تعذّر فتح محادثة باسم هذا العضو أثناء "الدخول كعضو". هذه مشكلة معروفة في صلاحيات قاعدة البيانات (RLS) تحتاج تعديل من فريق التطوير الخلفي، وليست مشكلة في المتصفح.'
            : 'حصل خطأ في تحميل المحادثة. تحقّق من اتصالك وحاول مرة أخرى.';
        if (body) {
            body.removeAttribute('aria-busy');
            body.innerHTML = this.stateHtml({
                tone: 'is-error',
                icon: 'alert',
                title: 'تعذّر تحميل المحادثة',
                text: message,
                action: this.isImpersonated ? '' : '<button type="button" class="chat-widget-primary-link" id="chatRetryBtn">إعادة المحاولة</button>'
            });
            body.querySelector('#chatRetryBtn')?.addEventListener('click', () => {
                this.chatInitialized = true;
                this.startChat();
            });
        }
        if (footer) footer.innerHTML = '';
    }

    renderEndedState() {
        const body = document.getElementById('chatWidgetBody');
        const footer = document.getElementById('chatWidgetFooter');
        this.setHeaderStatus('انتهت المحادثة', 'offline');
        this.clearQuickOptions();
        if (body) {
            const div = document.createElement('div');
            div.innerHTML = this.stateHtml({
                tone: 'is-done',
                icon: 'check',
                title: 'تم إنهاء المحادثة',
                text: 'شكرًا لتواصلك معنا. نص المحادثة متاح للتحميل من قائمة الخيارات.',
                action: '<button type="button" class="chat-widget-primary-link" data-new-chat>بدء محادثة جديدة</button>'
            });
            const state = div.firstElementChild;
            body.appendChild(state);
            state.querySelector('[data-new-chat]')?.addEventListener('click', () => {
                this.chatInitialized = true;
                this.startChat();
            });
            body.scrollTop = body.scrollHeight;
        }
        if (footer) footer.innerHTML = '';
    }

    /* ==================== شريط الإدخال ==================== */

    autoSizeComposer() {
        const input = document.getElementById('chatWidgetTextInput');
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
        const send = document.querySelector('#chatWidgetFooter .chat-widget-send-btn');
        if (send && !this.isSending) send.disabled = !input.value.trim();
    }

    setComposerBusy(busy) {
        const send = document.querySelector('#chatWidgetFooter .chat-widget-send-btn');
        if (!send) return;
        send.classList.toggle('is-busy', busy);
        send.setAttribute('aria-busy', String(busy));
        send.disabled = busy || !document.getElementById('chatWidgetTextInput')?.value.trim();
    }

    /** خطأ ظاهر فوق حقل الكتابة (null يخفيه). onRetry اختياري. */
    showComposerError(message, onRetry) {
        const footer = document.getElementById('chatWidgetFooter');
        if (!footer) return;
        footer.querySelector('.chat-widget-inline-error')?.remove();
        if (!message) return;
        const box = document.createElement('div');
        box.className = 'chat-widget-inline-error';
        box.setAttribute('role', 'alert');
        box.innerHTML = `<span>${escapeHtml(message)}</span>`;
        if (onRetry) {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'chat-widget-link-btn';
            retry.textContent = 'إعادة المحاولة';
            retry.addEventListener('click', () => { box.remove(); onRetry(); });
            box.appendChild(retry);
        }
        footer.prepend(box);
    }

    renderChatShell() {
        if (!this.agentJoined) this.setHeaderStatus('المساعد الآلي يرد فورًا', 'online');
        document.getElementById('chatWidgetBody')?.removeAttribute('aria-busy');

        const footer = document.getElementById('chatWidgetFooter');
        if (!footer) return;
        footer.innerHTML = '';

        const row = document.createElement('div');
        row.className = 'chat-widget-input-row';

        const input = document.createElement('textarea');
        input.id = 'chatWidgetTextInput';
        input.className = 'chat-widget-text-input';
        input.rows = 1;
        input.placeholder = 'اكتب رسالتك هنا...';
        input.setAttribute('aria-label', 'رسالتك');
        input.autocomplete = 'off';
        input.dir = 'auto';
        input.addEventListener('input', () => this.autoSizeComposer());
        input.addEventListener('keydown', (e) => {
            // Enter يرسل، وShift+Enter سطر جديد. isComposing: لا نرسل أثناء
            // تركيب حروف لوحة مفاتيح IME.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'chat-widget-send-btn';
        sendBtn.setAttribute('aria-label', 'إرسال');
        sendBtn.disabled = true;
        sendBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"></path></svg>`;
        sendBtn.addEventListener('click', () => this.sendMessage());

        row.appendChild(input);
        row.appendChild(sendBtn);
        footer.appendChild(row);

        // إنهاء المحادثة بتأكيد داخل الشريط بدل confirm() الخاصة بالمتصفح
        const meta = document.createElement('div');
        meta.className = 'chat-widget-footer-meta';
        const hint = document.createElement('span');
        hint.textContent = 'Enter للإرسال · Shift+Enter لسطر جديد';
        const endBtn = document.createElement('button');
        endBtn.type = 'button';
        endBtn.className = 'chat-widget-end-btn';
        const idleEnd = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg><span>إنهاء المحادثة</span>';
        endBtn.innerHTML = idleEnd;
        let confirmTimer = null;
        endBtn.addEventListener('click', () => {
            if (endBtn.dataset.confirm === '1') {
                clearTimeout(confirmTimer);
                endBtn.disabled = true;
                this.endChat().finally(() => { endBtn.disabled = false; });
                return;
            }
            endBtn.dataset.confirm = '1';
            endBtn.innerHTML = '<span>اضغط مرة أخرى للتأكيد</span>';
            confirmTimer = setTimeout(() => {
                delete endBtn.dataset.confirm;
                endBtn.innerHTML = idleEnd;
            }, 4000);
        });
        meta.appendChild(hint);
        meta.appendChild(endBtn);
        footer.appendChild(meta);
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
