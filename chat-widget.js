/**
 * ويدجت الدردشة المباشرة العائم (الفقاعة) - Client Side
 * ------------------------------------------------------------
 * ملاحظة مهمة: النسخة دي بقت بتستخدم بالظبط نفس المنطق والجداول اللي
 * بيستخدمها chat-customer.html (chat_sessions / chat_messages، والرد
 * من محرك SIE عبر assets/js/sie-client.js)، بدل الـ chatService
 * الوهمي (in-memory) اللي كان بيشتغل ببيانات تجريبية بس.
 *
 * هذا الملف الآن ES Module، فلازم يتحمّل بـ:
 *   <script type="module" src="chat-widget.js"></script>
 * (بدل <script src="chat-widget.js" defer></script> القديمة)
 * ------------------------------------------------------------
 */

import { supabase } from '/api-config.js';
import { requireAuth } from '/auth-client.js';
import { getSieReply } from '/assets/js/sie-client.js';
import { iconize } from '/assets/js/chat-icons.js';
import { signedUrls, SIGNED_URL_TTL, SIGNED_URL_TTL_DOWNLOAD } from '/storage-urls.js';
import { fetchEntitlement, downgradePlan } from '/assets/js/sie-plan-service.js';
import { usageView } from '/assets/js/sie-plan-model.js';
import {
    CHAT_ATTACHMENTS_BUCKET, MAX_ATTACHMENTS_PER_SEND, FILE_PICKER_ACCEPT, validateFile, buildObjectPath,
    messageFieldsFor, attachmentFromMessage, renderAttachmentHtml, hydrateAttachments, downscaleImage,
    uploadAttachment, uploadErrorText, formatBytes, formatDuration, autoLabelFor
} from '/assets/js/chat-attachments.js';
import { VoiceRecorder, isVoiceRecordingSupported } from '/assets/js/voice-recorder.js';

/**
 * ردود البداية بعد الترحيب. SIE هو وضع الرد الوحيد، فهذه نصوص عادية يفهمها
 * SIE (مُختبرة على الإصدار المجاني: «عندي مشكلة» سؤال توضيحي، «عندي استفسار»
 * رد مباشر) — لا أوامر لمحرك قوائم.
 */
const STARTER_OPTIONS = Object.freeze([
    { label: '[[icon:inquiry]] عندي استفسار', value: 'عندي استفسار' },
    { label: '[[icon:problem]] عندي مشكلة', value: 'عندي مشكلة' }
]);

const ICONS = {
    attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M19 10v1a7 7 0 0 1-14 0v-1"></path><line x1="12" y1="18" x2="12" y2="22"></line></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"></path></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"></polyline></svg>',
    sie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"></path><path d="M9.5 12l1.8 1.8L15 10"></path></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>'
};

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
        // خطة SIE والاستخدام كما يراها الخادم (sie_my_entitlement) — عرض فقط؛
        // الفرض عند كل رسالة في sie_consume_message. null = لم تُحمَّل بعد.
        this.entitlement = null;
        this.isModeMenuOpen = false;
        // مرفقات مختارة لم تُرسل بعد: {id, file, kind, previewUrl, state, progress, error}
        this.pendingAttachments = [];
        this.recorder = null;
        this.recording = null; // {blob, mime, durationMs, url} بعد الإيقاف وقبل الإرسال
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

        // عناصر القائمة القابلة للنقر تعمل بلوحة المفاتيح أيضًا (Enter / Space)
        [downloadItem, maximizeItem].forEach(item => {
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
            // composedPath() ثابت منذ بداية الحدث: زر داخل القائمة أعيد رسمه
            // أثناء معالجة الضغطة (رد سريع من الخادم) يبقى «داخلها».
            const menu = document.getElementById('cwModeMenu');
            const chip = document.getElementById('cwModeChip');
            const path = e.composedPath();
            if (this.isModeMenuOpen && menu && !path.includes(menu) && !(chip && path.includes(chip))) {
                this.toggleModeMenu(false);
            }
        });

        // Escape: يغلق القائمة أولًا، ثم النافذة — ويعيد التركيز لزر الإطلاق
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const root = document.getElementById('floatingChatWidget');
            if (!root || !root.contains(document.activeElement)) return;
            if (document.getElementById('cwImageViewer')) { this.closeImageViewer(); return; }
            if (this.isModeMenuOpen) {
                this.toggleModeMenu(false);
                document.getElementById('cwModeChip')?.focus();
                return;
            }
            if (this.isSettingsOpen) {
                this.toggleSettingsPanel(false);
                document.getElementById('chatSettingsBtn')?.focus();
                return;
            }
            this.closeWidget();
            document.getElementById('chatBubbleBtn')?.focus();
        });

        // الصور داخل المحادثة: ضغطة تفتح عارضًا أكبر (مستمع واحد على الجسم كله)
        document.getElementById('chatWidgetBody')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.cw-att-image');
            const img = btn?.querySelector('img');
            if (btn && img?.src && !img.hidden) this.openImageViewer(img.src, img.alt, btn);
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

    /* ==================== وضع الرد وخطة SIE (منتقي داخل شريط الكتابة) ==================== */

    /**
     * SIE هو وضع الرد الوحيد. الخطة والاستخدام والتنزيلات المسموحة كلها من
     * الخادم (sie_my_entitlement)؛ هنا عرض فقط. فشل القراءة لا يوقف الشات:
     * الحدود مفروضة على الخادم مع كل رسالة مهما عرضت الواجهة.
     */
    async refreshEntitlement() {
        if (!this.currentUser) return this.entitlement;
        this.entitlement = await fetchEntitlement(supabase);
        this.renderModeChip();
        if (this.isModeMenuOpen) this.renderModeMenu();
        return this.entitlement;
    }

    renderModeChip() {
        const chip = document.getElementById('cwModeChip');
        if (!chip) return;
        const ent = this.entitlement;
        const plan = ent?.status === 'ok' ? ent.planLabel : null;
        const tone = ent?.status === 'ok' ? usageView(ent).tone : 'ok';
        chip.querySelector('.cw-mode-chip-plan').textContent = plan || '';
        chip.dataset.tone = ent?.status === 'ok' && !ent.hasAccess ? 'full' : tone;
        chip.setAttribute('aria-label', `وضع الرد: SIE${plan ? `، خطة ${plan}` : ''}. عرض الخطة والاستخدام`);
    }

    toggleModeMenu(force) {
        const open = force !== undefined ? force : !this.isModeMenuOpen;
        this.isModeMenuOpen = open;
        const chip = document.getElementById('cwModeChip');
        chip?.setAttribute('aria-expanded', String(open));
        let menu = document.getElementById('cwModeMenu');
        if (!open) { menu?.remove(); return; }
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'cwModeMenu';
            menu.className = 'cw-mode-menu';
            menu.setAttribute('role', 'dialog');
            menu.setAttribute('aria-label', 'وضع الرد وخطة SIE');
            document.getElementById('chatWidgetFooter')?.prepend(menu);
            menu.addEventListener('keydown', (e) => this.trapModeMenuFocus(e));
        }
        this.renderModeMenu();
        // بعد الرسم: التركيز على أول عنصر تفاعلي، أو على القائمة نفسها
        const first = menu.querySelector('button:not([disabled])');
        (first || menu).focus({ preventScroll: true });
        this.refreshEntitlement();
    }

    trapModeMenuFocus(e) {
        if (e.key !== 'Tab') return;
        const menu = document.getElementById('cwModeMenu');
        const items = Array.from(menu?.querySelectorAll('button:not([disabled])') || []);
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    renderModeMenu({ force = false } = {}) {
        const menu = document.getElementById('cwModeMenu');
        if (!menu) return;
        menu.tabIndex = -1;
        const ent = this.entitlement;
        // تحديث صامت بنفس البيانات لا يعيد الرسم: كان يُسقط التركيز من لوحة
        // المفاتيح ويمسح «تأكيد النزول» الجاري.
        const sig = JSON.stringify(ent ?? null);
        if (!force && sig === menu.dataset.sig) return;
        menu.dataset.sig = sig;
        const focusKey = menu.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
        const v = usageView(ent);

        let usageHtml;
        if (!ent) {
            usageHtml = '<div class="cw-usage-skeleton" aria-hidden="true"></div><p class="visually-hidden">جاري تحميل الاستخدام…</p>';
        } else if (ent.status !== 'ok') {
            usageHtml = '<p class="cw-mode-note">تعذّر تحميل بيانات الاستخدام الآن. الشات يعمل كالمعتاد.</p>';
        } else if (!v.available) {
            usageHtml = '<p class="cw-mode-note">لا توجد بيانات استخدام بعد.</p>';
        } else {
            usageHtml = `
            <div class="cw-usage" data-tone="${v.tone}">
              <div class="cw-usage-row"><span class="cw-usage-title">الاستخدام</span>${v.percent !== null ? `<span class="cw-usage-pct">${v.percent}%</span>` : ''}</div>
              ${v.percent !== null ? `<div class="cw-usage-bar" role="progressbar" aria-label="نسبة الاستخدام" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v.percent}"><span style="width:${v.percent}%"></span></div>` : ''}
              <div class="cw-usage-row cw-usage-nums"><span dir="ltr">${escapeHtml(v.usedText)}</span><span>${escapeHtml(v.remainingText)}</span></div>
              ${v.resetText ? `<div class="cw-usage-reset">${escapeHtml(v.resetText)}</div>` : ''}
            </div>`;
        }

        const reason = ent?.status === 'ok' && !ent.hasAccess && ent.reasonText
            ? `<p class="cw-mode-alert" role="status">${escapeHtml(ent.reasonText)} رسائلك تصل لفريق الدعم وهيرد عليك هنا.</p>` : '';

        const downgrades = ent?.status === 'ok' && ent.downgradeTo.length
            ? `<div class="cw-mode-section">
                 <span class="cw-mode-section-title">تغيير الخطة</span>
                 <div class="cw-downgrade-list">${ent.downgradeTo.map((d) => `
                   <button type="button" class="cw-downgrade-btn" data-plan="${escapeHtml(d.plan)}" data-focus-key="down-${escapeHtml(d.plan)}">النزول إلى ${escapeHtml(d.label)}</button>`).join('')}
                 </div>
                 <p class="cw-mode-hint">الترقية لخطة أعلى بتتم من فريق المنصة.</p>
               </div>` : '';

        menu.innerHTML = `
          <div class="cw-mode-section">
            <span class="cw-mode-section-title">وضع الرد</span>
            <button type="button" class="cw-mode-option is-selected" data-focus-key="mode" aria-pressed="true" aria-describedby="cwModeDesc">
              <span class="cw-mode-option-icon">${ICONS.sie}</span>
              <span class="cw-mode-option-text"><span class="cw-mode-option-name">محرك الدعم الذكي (SIE)</span>
              <span class="cw-mode-option-desc" id="cwModeDesc">يفهم المشكلة، يشخّصها، ويرد أو يفتح تذكرة بنفسه.</span></span>
              <span class="cw-mode-option-check" aria-hidden="true">✓</span>
            </button>
          </div>
          <div class="cw-mode-section">
            <div class="cw-plan-row"><span class="cw-mode-section-title">الخطة الحالية</span>
              <span class="cw-plan-badge">${ent?.status === 'ok' ? `SIE ${escapeHtml(ent.planLabel)}` : '—'}</span></div>
            ${usageHtml}
            ${reason}
          </div>
          ${downgrades}
          <p class="cw-mode-error" role="alert" hidden></p>`;

        menu.querySelectorAll('.cw-downgrade-btn').forEach((btn) => {
            btn.addEventListener('click', () => this.confirmDowngrade(btn));
        });
        if (focusKey !== null) {
            (menu.querySelector(`[data-focus-key="${focusKey}"]`) || menu.querySelector('button:not([disabled])') || menu).focus({ preventScroll: true });
        }
    }

    /** ضغطة أولى تطلب التأكيد (نفس نمط «إنهاء المحادثة»)، والثانية تنفّذ على الخادم. */
    async confirmDowngrade(btn) {
        const plan = btn.dataset.plan;
        const label = this.entitlement?.downgradeTo.find((d) => d.plan === plan)?.label || plan;
        if (btn.dataset.confirm !== '1') {
            btn.dataset.confirm = '1';
            btn.textContent = `تأكيد النزول إلى ${label}؟`;
            btn.classList.add('is-confirm');
            clearTimeout(this.downgradeConfirmTimer);
            this.downgradeConfirmTimer = setTimeout(() => this.renderModeMenu({ force: true }), 5000);
            return;
        }
        clearTimeout(this.downgradeConfirmTimer);
        btn.disabled = true;
        btn.textContent = 'جاري التغيير…';
        const result = await downgradePlan(supabase, plan);
        if (!result.ok) {
            await this.refreshEntitlement();
            this.renderModeMenu({ force: true });
            const err = document.querySelector('#cwModeMenu .cw-mode-error');
            if (err) { err.textContent = result.errorText; err.hidden = false; }
            return;
        }
        await this.refreshEntitlement();
        this.renderModeMenu({ force: true });
        this.appendSystemEvent(`تم تغيير خطة SIE إلى ${label}`);
    }

    /**
     * SIE غير متاح لهذا العميل الآن (موقوف / منتهي / استهلك حده). لا بوت
     * بديل: رسالة واضحة بالسبب داخل المحادثة نفسها، والرسالة تبقى لفريق الدعم.
     */
    async notifySieUnavailable(ent) {
        const why = ent?.reasonText || 'محرك الدعم الذكي (SIE) غير متاح لحسابك حاليًا.';
        await supabase.from('chat_messages').insert({
            session_id: this.currentSessionId,
            sender_id: null,
            message_text: `${why} رسالتك وصلت لفريق الدعم وهيرد عليك هنا في أقرب وقت.`,
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
        if (this.isModeMenuOpen) this.toggleModeMenu(false);
        // تسجيل جارٍ لا يبقى يعمل في الخلفية بعد إغلاق النافذة: الميكروفون يُطفأ
        if (this.recorder?.state === 'recording' || this.recorder?.state === 'requesting') this.recorder.cancel();
        this.closeImageViewer();
        this.syncOpenState();
        // ملاحظة: إغلاق النافذة مايقفلش المحادثة نفسها - الجلسة تفضل شغالة
        // ولو العميل فتح الويدجت تاني هيكمل من نفس مكانه.
    }

    toggleMinimize() {
        const panel = document.getElementById('chatWidgetPanel');
        if (!panel) return;
        this.isMinimized = !this.isMinimized;
        panel.classList.toggle('minimized', this.isMinimized);
        if (this.isMinimized) {
            this.toggleSettingsPanel(false);
            if (this.isModeMenuOpen) this.toggleModeMenu(false);
        }
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
        this.refreshEntitlement();

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

        (messages || []).forEach(msg => this.renderMessageBubble(msg, { deferHydrate: true }));
        this.hydrateAll(body);
        body.scrollTop = body.scrollHeight;
        this.focusComposer();

        // خيارات SIE مرتبطة بالرد نفسه ولا تُحفظ؛ عند إعادة الفتح تُعرض ردود
        // البداية فقط لمحادثة فاضية.
        if (!messages || messages.length === 0) {
            await this.sendInitialGreeting();
        }

        if (this.agentJoined) this.setHeaderStatus('فريق الدعم متصل الآن', 'agent');
    }

    async sendInitialGreeting() {
        if (!this.currentSessionId) return;
        const welcome = this.botSettings?.welcome_message || 'أهلاً بيك في منصة مدعوم! 👋';
        const greetingText = `${welcome}\nاختار من الاختيارات دي 👇 أو اكتبلي طلبك بحريتك:`;

        await supabase.from('chat_sessions').update({ bot_state: { greeted: true } }).eq('id', this.currentSessionId);

        // الإدراج هيوصل عن طريق الاشتراك الفوري (subscribeRealtime) ويتعرض تلقائياً
        await supabase.from('chat_messages').insert({
            session_id: this.currentSessionId,
            sender_id: null,
            message_text: greetingText,
            is_admin_reply: false,
            is_bot_reply: true
        });

        this.renderQuickOptions(STARTER_OPTIONS);
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

    renderMessageBubble(msg, { deferHydrate = false } = {}) {
        const body = document.getElementById('chatWidgetBody');
        if (!body) return;

        const sender = this.senderOf(msg);
        const created = msg.created_at ? new Date(msg.created_at) : new Date();
        const time = created.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const att = attachmentFromMessage(msg);
        const rawText = msg.message_text || '';
        // نص «صورة مرفقة» / «رسالة صوتية» المحفوظ للقوائم لا يُكرَّر تحت المرفق نفسه
        const text = att && rawText === autoLabelFor(att) ? '' : rawText;

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
        <div class="chat-widget-bubble${att ? ' has-attachment' : ''}">${att ? renderAttachmentHtml(att, escapeHtml) : ''}${text ? `<span class="chat-widget-bubble-text">${iconize(escapeHtml(text)).replace(/\n/g, '<br>')}</span>` : ''}</div>
        <div class="chat-widget-msg-meta">${continued ? '' : `<span class="chat-widget-msg-who">${sender.who}</span>`}<time class="chat-widget-msg-time" datetime="${created.toISOString()}">${time}</time></div>
      </div>
    `;
        if (msg.id) div.dataset.msgId = String(msg.id);
        body.appendChild(div);
        this.lastRendered = { day: dayKey, sender: sender.key, at: created };

        const who = sender.isOwn ? 'أنا' : (msg.is_admin_reply ? 'الدعم الفني' : 'البوت');
        this.transcriptLines.push(`[${time}] ${who}: ${[att ? `[${autoLabelFor(att)}]` : '', text].filter(Boolean).join(' ')}`);
        if (att && !deferHydrate) this.hydrateAll(div);
    }

    /** يوقّع مرفقات جزء من المحادثة دفعة واحدة (روابط قصيرة العمر، لا تُحفظ). */
    hydrateAll(root) {
        hydrateAttachments(root, (paths, { download }) =>
            signedUrls(CHAT_ATTACHMENTS_BUCKET, paths, download ? SIGNED_URL_TTL_DOWNLOAD : SIGNED_URL_TTL));
    }

    /** عرض الصورة أكبر داخل الصفحة؛ Escape أو الخلفية أو زر الإغلاق يغلقه ويعيد التركيز. */
    openImageViewer(src, alt, returnFocusTo) {
        this.closeImageViewer();
        const root = document.getElementById('floatingChatWidget');
        const viewer = document.createElement('div');
        viewer.id = 'cwImageViewer';
        viewer.className = 'cw-image-viewer';
        viewer.setAttribute('role', 'dialog');
        viewer.setAttribute('aria-modal', 'true');
        viewer.setAttribute('aria-label', alt || 'صورة مرفقة');
        viewer.innerHTML = `<button type="button" class="cw-image-viewer-close" aria-label="إغلاق">${ICONS.close}</button><img alt="${escapeHtml(alt || '')}">`;
        viewer.querySelector('img').src = src;
        this.viewerReturnFocus = returnFocusTo || null;
        viewer.addEventListener('click', (e) => { if (e.target === viewer || e.target.closest('.cw-image-viewer-close')) this.closeImageViewer(); });
        root.appendChild(viewer);
        viewer.querySelector('.cw-image-viewer-close').focus();
    }

    closeImageViewer() {
        const viewer = document.getElementById('cwImageViewer');
        if (!viewer) return;
        viewer.remove();
        this.viewerReturnFocus?.focus?.();
        this.viewerReturnFocus = null;
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

    /**
     * يرسل ما في شريط الكتابة: النص، والمرفقات المختارة، أو التسجيل الصوتي.
     *   1) رفع كل مرفق (بتقدّم) — فشل أي رفع يوقف الإرسال ويُبقي كل شيء مكانه.
     *   2) رسالة لكل مرفق (النص يصاحب أول مرفق)، أو رسالة نصية وحدها.
     *   3) لو فيه نص: SIE يرد (وضع الرد الوحيد). المرفق وحده لا يستهلك SIE.
     */
    async sendMessage(presetText) {
        const input = document.getElementById('chatWidgetTextInput');
        const fromComposer = presetText === undefined;
        const text = (fromComposer ? input?.value || '' : presetText).trim();
        const files = fromComposer ? this.pendingAttachments.filter((a) => a.state !== 'invalid') : [];
        const voice = fromComposer ? this.recording : null;
        if ((!text && !files.length && !voice) || !this.currentSessionId || !this.currentUser) return;
        // ضغطتان سريعتان على Enter كانتا ترسلان الرسالة مرتين
        if (this.isSending) return;
        this.isSending = true;
        this.setComposerBusy(true);
        this.showComposerError(null);

        const quickOptions = document.getElementById('botQuickOptions');
        const typingIndicator = document.getElementById('chatWidgetTyping');
        const typingText = document.getElementById('chatWidgetTypingText');
        const restore = (message, retry) => {
            this.isSending = false;
            this.setComposerBusy(false);
            if (fromComposer && input && !input.value) { input.value = text; this.autoSizeComposer(); }
            if (quickOptions) {
                quickOptions.querySelectorAll('button').forEach(b => (b.disabled = false));
                document.getElementById('chatWidgetBody')?.appendChild(quickOptions);
            }
            this.showComposerError(message, retry);
        };

        // ── 1) الرفع ─────────────────────────────────────────────────────
        const uploaded = [];
        const items = voice
            ? [{ id: 'voice', kind: 'audio', file: new File([voice.blob], `voice.${voice.ext}`, { type: voice.mime }), durationMs: voice.durationMs }]
            : files;
        for (const item of items) {
            item.state = 'uploading';
            item.progress = 0;
            this.renderAttachmentTray();
            try {
                const body = item.kind === 'image' ? await downscaleImage(item.file) : item.file;
                const check = validateFile(body, item.kind);
                if (!check.ok) throw new Error(check.error);
                const path = buildObjectPath(this.currentUser.id, this.currentSessionId, check.ext);
                await uploadAttachment({
                    supabase, path, file: body, contentType: check.mime,
                    onProgress: (p) => { item.progress = p; this.renderAttachmentProgress(item); }
                });
                item.state = 'uploaded';
                uploaded.push({ path, fields: messageFieldsFor({ kind: item.kind, path, name: body.name || item.file.name, mime: check.mime, size: body.size, durationMs: item.durationMs }) });
            } catch (err) {
                item.state = 'error';
                // رسائل التحقق عندنا عربية أصلًا؛ أي خطأ آخر (خادم/شبكة) يُترجم
                item.error = /[\u0600-\u06FF]/.test(err?.message || '') ? err.message : uploadErrorText(err);
                console.error('[ChatWidget] upload failed:', err);
                await this.cleanupUploads(uploaded.map((u) => u.path));
                this.renderAttachmentTray();
                restore(voice ? `تعذّر إرسال التسجيل: ${item.error}` : `تعذّر رفع «${item.file.name}»: ${item.error}`,
                    () => this.sendMessage());
                return;
            }
        }

        if (fromComposer && input) { input.value = ''; this.autoSizeComposer(); }
        this.clearQuickOptions();

        // ── 2) الرسائل ───────────────────────────────────────────────────
        const rows = uploaded.length
            ? uploaded.map((u, i) => ({ ...u.fields, message_text: i === 0 && text ? text : autoLabelFor(u.fields.attachment) }))
            : [{ message_text: text }];
        for (const row of rows) {
            const { error: sendError } = await supabase.from('chat_messages').insert({
                session_id: this.currentSessionId,
                sender_id: this.currentUser.id,
                is_admin_reply: false,
                ...row
            });
            if (sendError) {
                console.error('خطأ في إرسال الرسالة:', sendError);
                const sentPaths = new Set(rows.slice(0, rows.indexOf(row)).map((r) => r.attachment?.path));
                await this.cleanupUploads(uploaded.map((u) => u.path).filter((p) => !sentPaths.has(p)));
                items.forEach((it) => { if (it.state === 'uploaded') it.state = 'ready'; });
                this.renderAttachmentTray();
                restore('تعذّر إرسال رسالتك. تحقّق من الاتصال وحاول مرة أخرى.', () => this.sendMessage(fromComposer ? undefined : presetText));
                return;
            }
        }

        // أُرسل كل شيء: تفريغ الشريط
        if (fromComposer) {
            this.clearPendingAttachments();
            if (voice) this.discardRecording();
        }

        if (!text) {
            // مرفق بلا نص: لا نستهلك SIE على شيء لا يقرؤه — فريق الدعم يراه
            this.isSending = false;
            this.setComposerBusy(false);
            this.appendSystemEvent('وصل المرفق. اكتب وصف المشكلة لو حابب المساعد يساعدك فيها.');
            return;
        }

        // ── 3) رد SIE ────────────────────────────────────────────────────
        try {
            if (typingText) typingText.textContent = 'جاري اتخاذ القرار...';
            if (typingIndicator) typingIndicator.style.display = 'flex';

            if (this.currentSession?.is_manual_mode) return;

            const { data: freshSession } = await supabase
                .from('chat_sessions')
                .select('bot_state, is_manual_mode')
                .eq('id', this.currentSessionId)
                .single();

            if (freshSession?.is_manual_mode) return;

            // الواجهة تعرف مسبقًا أن SIE غير متاح (موقوف/منتهي/وصل حده)؟ لا
            // نطلب ردًا سيُرفض — نشرح السبب. معلومة غير متاحة (null/خطأ) لا
            // تمنع المحاولة: الخادم هو من يقرر مع كل رسالة.
            if (this.entitlement?.status === 'ok' && !this.entitlement.hasAccess) {
                await this.notifySieUnavailable(this.entitlement);
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
                // رفض الخادم (حد/إيقاف) يصل هنا كـ null: نسأل الخادم عن السبب
                const ent = await this.refreshEntitlement();
                if (ent?.status === 'ok' && !ent.hasAccess) {
                    await this.notifySieUnavailable(ent);
                } else {
                    await supabase.from('chat_messages').insert({
                        session_id: this.currentSessionId,
                        sender_id: null,
                        message_text: 'محرك الدعم الذكي (SIE) واجه مشكلة مؤقتة في الرد على رسالتك. جرّب تبعتها تاني، ورسالتك وصلت لفريق الدعم كمان.',
                        is_admin_reply: false,
                        is_bot_reply: true
                    });
                }
                return;
            }

            // SIE بيكتب دور المحادثة بنفسه لما يقول alreadyPersisted — رسالة
            // البوت و bot_state والتذكرة لو اتفتحت، في معاملة واحدة عنده.
            if (!sieResult.alreadyPersisted) {
                if (sieResult.botState !== undefined) {
                    await supabase.from('chat_sessions').update({ bot_state: sieResult.botState }).eq('id', this.currentSessionId);
                }
                await supabase.from('chat_messages').insert({
                    session_id: this.currentSessionId,
                    sender_id: null,
                    message_text: sieResult.reply,
                    is_admin_reply: false,
                    is_bot_reply: true
                });
            }
            this.renderQuickOptions(sieResult.options);
        } catch (err) {
            console.error('خطأ في SIE:', err);
            await supabase.from('chat_messages').insert({
                session_id: this.currentSessionId,
                sender_id: null,
                message_text: 'عذراً، حدث خطأ بسيط أثناء معالجة طلبك. رسالتك وصلت لفريق الدعم وهيرد عليك هنا.',
                is_admin_reply: false,
                is_bot_reply: true
            });
        } finally {
            if (typingIndicator) typingIndicator.style.display = 'none';
            this.isSending = false;
            this.setComposerBusy(false);
            // الاستخدام تغيّر: تحديث صامت لمربع الاستخدام
            this.refreshEntitlement();
        }
    }

    /** رفع اكتمل لرسالة لم تُرسل: يُحذف (السياسة تسمح فقط بملف غير مُشار إليه). */
    async cleanupUploads(paths) {
        const list = paths.filter(Boolean);
        if (!list.length) return;
        try {
            await supabase.storage.from(CHAT_ATTACHMENTS_BUCKET).remove(list);
        } catch (err) {
            console.warn('[ChatWidget] cleanup of unsent uploads failed:', err?.message || err);
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
        this.updateActionButton();
    }

    /** زر واحد في نهاية الشريط: ميكروفون حين لا شيء للإرسال، وإرسال حين يوجد نص أو مرفق. */
    hasSomethingToSend() {
        const input = document.getElementById('chatWidgetTextInput');
        return !!(input?.value.trim() || this.pendingAttachments.some((a) => a.state !== 'invalid'));
    }

    updateActionButton() {
        const btn = document.getElementById('cwActionBtn');
        if (!btn) return;
        const canRecord = this.voiceSupported && !this.hasSomethingToSend();
        btn.dataset.action = canRecord ? 'mic' : 'send';
        btn.innerHTML = canRecord ? ICONS.mic : ICONS.send;
        btn.setAttribute('aria-label', canRecord ? 'تسجيل رسالة صوتية' : 'إرسال');
        btn.classList.toggle('is-mic', canRecord);
        btn.disabled = !!this.isSending || (!canRecord && !this.hasSomethingToSend());
    }

    setComposerBusy(busy) {
        const btn = document.getElementById('cwActionBtn');
        const attach = document.getElementById('cwAttachBtn');
        if (attach) attach.disabled = busy;
        if (!btn) return;
        this.updateActionButton();
        btn.classList.toggle('is-busy', busy);
        btn.setAttribute('aria-busy', String(busy));
        if (busy) btn.disabled = true;
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
        const composer = footer.querySelector('.cw-composer');
        composer ? composer.before(box) : footer.prepend(box);
    }

    /* ---------- المرفقات ---------- */

    addFiles(fileList) {
        this.showComposerError(null);
        const incoming = Array.from(fileList || []);
        const errors = [];
        for (const file of incoming) {
            if (this.pendingAttachments.length >= MAX_ATTACHMENTS_PER_SEND) {
                errors.push(`حد أقصى ${MAX_ATTACHMENTS_PER_SEND} مرفقات في الرسالة الواحدة.`);
                break;
            }
            const check = validateFile(file);
            if (!check.ok) { errors.push(`«${file.name}»: ${check.error}`); continue; }
            this.pendingAttachments.push({
                id: `a${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
                file, kind: check.kind, state: 'ready', progress: 0,
                previewUrl: check.kind === 'image' ? URL.createObjectURL(file) : null
            });
        }
        this.renderAttachmentTray();
        this.updateActionButton();
        if (errors.length) this.showComposerError(errors.join(' '));
    }

    removeAttachment(id) {
        const i = this.pendingAttachments.findIndex((a) => a.id === id);
        if (i < 0) return;
        const [a] = this.pendingAttachments.splice(i, 1);
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        this.renderAttachmentTray();
        this.updateActionButton();
        document.getElementById('chatWidgetTextInput')?.focus({ preventScroll: true });
    }

    clearPendingAttachments() {
        this.pendingAttachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
        this.pendingAttachments = [];
        this.renderAttachmentTray();
        this.updateActionButton();
    }

    renderAttachmentTray() {
        const tray = document.getElementById('cwAttachTray');
        if (!tray) return;
        tray.hidden = this.pendingAttachments.length === 0;
        tray.innerHTML = this.pendingAttachments.map((a) => `
          <div class="cw-chip" data-id="${a.id}" data-state="${a.state}">
            ${a.kind === 'image'
                ? `<img class="cw-chip-thumb" src="${a.previewUrl}" alt="">`
                : `<span class="cw-chip-icon">${ICONS.file}</span>`}
            <span class="cw-chip-text">
              <span class="cw-chip-name" dir="auto">${escapeHtml(a.file.name)}</span>
              <span class="cw-chip-meta" dir="${a.state === 'ready' ? 'ltr' : 'auto'}">${a.state === 'error' ? escapeHtml(a.error || 'فشل الرفع') : a.state === 'uploading' ? 'جاري الرفع…' : formatBytes(a.file.size)}</span>
            </span>
            ${a.state === 'uploading' ? `<span class="cw-chip-progress" role="progressbar" aria-label="تقدّم رفع ${escapeHtml(a.file.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(a.progress * 100)}"><span style="width:${Math.round(a.progress * 100)}%"></span></span>` : ''}
            <button type="button" class="cw-chip-remove" aria-label="إزالة ${escapeHtml(a.file.name)}" ${a.state === 'uploading' ? 'disabled' : ''}>${ICONS.close}</button>
          </div>`).join('');
        tray.querySelectorAll('.cw-chip-remove').forEach((btn) => {
            btn.addEventListener('click', () => this.removeAttachment(btn.closest('.cw-chip').dataset.id));
        });
    }

    renderAttachmentProgress(item) {
        const bar = document.querySelector(`#cwAttachTray .cw-chip[data-id="${item.id}"] .cw-chip-progress`);
        if (!bar) return;
        const pct = Math.round(item.progress * 100);
        bar.setAttribute('aria-valuenow', String(pct));
        bar.firstElementChild.style.width = `${pct}%`;
    }

    /* ---------- التسجيل الصوتي ---------- */

    async startRecording() {
        if (this.isSending) return;
        this.showComposerError(null);
        if (!this.recorder) {
            this.recorder = new VoiceRecorder({
                onState: (state, detail) => this.onRecorderState(state, detail),
                onTick: (ms) => {
                    const el = document.getElementById('cwRecTime');
                    if (el) el.textContent = formatDuration(ms);
                }
            });
        }
        this.setComposerMode('recording');
        await this.recorder.start();
    }

    onRecorderState(state, detail) {
        if (state === 'error') {
            this.setComposerMode('text');
            this.showComposerError(detail?.message || 'تعذّر التسجيل.');
        } else if (state === 'stopped' && detail) {
            const check = validateFile({ name: '', type: detail.mime, size: detail.blob.size }, 'audio');
            if (!check.ok) {
                this.setComposerMode('text');
                this.showComposerError(check.error);
                return;
            }
            this.recording = { ...detail, mime: check.mime, ext: check.ext, url: URL.createObjectURL(detail.blob) };
            this.setComposerMode('preview');
        } else if (state === 'idle') {
            this.setComposerMode('text');
        }
    }

    discardRecording() {
        if (this.recording?.url) URL.revokeObjectURL(this.recording.url);
        this.recording = null;
        this.setComposerMode('text');
    }

    /** text | recording | preview — نفس الشريط، بلا تغيير في ارتفاع المحادثة. */
    setComposerMode(mode) {
        const composer = document.querySelector('#chatWidgetFooter .cw-composer');
        if (!composer) return;
        composer.dataset.mode = mode;
        const rec = document.getElementById('cwRecorder');
        const row = composer.querySelector('.chat-widget-input-row');
        if (mode === 'text') {
            rec.hidden = true;
            rec.innerHTML = '';
            row.hidden = false;
            this.updateActionButton();
            return;
        }
        row.hidden = true;
        rec.hidden = false;
        if (mode === 'recording') {
            rec.innerHTML = `
              <button type="button" class="cw-icon-btn" id="cwRecCancel" aria-label="إلغاء التسجيل">${ICONS.close}</button>
              <span class="cw-rec-status" role="status"><span class="cw-rec-dot" aria-hidden="true"></span>جاري التسجيل <time id="cwRecTime" dir="ltr">0:00</time></span>
              <button type="button" class="cw-icon-btn cw-rec-stop" id="cwRecStop" aria-label="إيقاف التسجيل">${ICONS.stop}</button>`;
            rec.querySelector('#cwRecCancel').addEventListener('click', () => this.recorder?.cancel());
            rec.querySelector('#cwRecStop').addEventListener('click', () => this.recorder?.stop());
            rec.querySelector('#cwRecStop').focus({ preventScroll: true });
        } else if (mode === 'preview') {
            rec.innerHTML = `
              <button type="button" class="cw-icon-btn" id="cwRecDiscard" aria-label="حذف التسجيل">${ICONS.trash}</button>
              <audio class="cw-rec-audio" controls preload="metadata" aria-label="معاينة التسجيل"></audio>
              <span class="cw-rec-len" dir="ltr">${formatDuration(this.recording?.durationMs)}</span>
              <button type="button" class="chat-widget-send-btn" id="cwRecSend" aria-label="إرسال التسجيل">${ICONS.send}</button>`;
            rec.querySelector('audio').src = this.recording.url;
            rec.querySelector('#cwRecDiscard').addEventListener('click', () => this.discardRecording());
            rec.querySelector('#cwRecSend').addEventListener('click', () => this.sendMessage());
            rec.querySelector('#cwRecSend').focus({ preventScroll: true });
        }
    }

    renderChatShell() {
        if (!this.agentJoined) this.setHeaderStatus('المساعد الآلي يرد فورًا', 'online');
        document.getElementById('chatWidgetBody')?.removeAttribute('aria-busy');

        const footer = document.getElementById('chatWidgetFooter');
        if (!footer) return;
        footer.innerHTML = '';
        this.isModeMenuOpen = false;
        this.voiceSupported = isVoiceRecordingSupported();

        const composer = document.createElement('div');
        composer.className = 'cw-composer';
        composer.dataset.mode = 'text';
        composer.innerHTML = `
          <div class="cw-attach-tray" id="cwAttachTray" hidden></div>
          <div class="cw-recorder" id="cwRecorder" hidden></div>
          <div class="chat-widget-input-row">
            <button type="button" class="cw-icon-btn" id="cwAttachBtn" aria-label="إرفاق صورة أو ملف">${ICONS.attach}</button>
            <input type="file" id="cwFileInput" accept="${FILE_PICKER_ACCEPT}" multiple hidden>
            <textarea id="chatWidgetTextInput" class="chat-widget-text-input" rows="1" placeholder="اكتب رسالتك هنا..." aria-label="رسالتك" autocomplete="off" dir="auto"></textarea>
            <button type="button" class="cw-mode-chip" id="cwModeChip" aria-haspopup="dialog" aria-expanded="false" aria-controls="cwModeMenu" aria-label="وضع الرد: SIE. عرض الخطة والاستخدام">
              <span class="cw-mode-chip-dot" aria-hidden="true"></span><span class="cw-mode-chip-name">SIE</span><span class="cw-mode-chip-plan"></span>${ICONS.chevron}
            </button>
            <button type="button" class="chat-widget-send-btn" id="cwActionBtn" aria-label="إرسال" disabled>${ICONS.send}</button>
          </div>`;
        footer.appendChild(composer);

        const input = composer.querySelector('#chatWidgetTextInput');
        const fileInput = composer.querySelector('#cwFileInput');
        input.addEventListener('input', () => this.autoSizeComposer());
        input.addEventListener('keydown', (e) => {
            // Enter يرسل، وShift+Enter سطر جديد. isComposing: لا نرسل أثناء
            // تركيب حروف لوحة مفاتيح IME.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        // لصق صورة من الحافظة مباشرة
        input.addEventListener('paste', (e) => {
            const files = Array.from(e.clipboardData?.files || []);
            if (files.length) { e.preventDefault(); this.addFiles(files); }
        });
        composer.querySelector('#cwAttachBtn').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
        fileInput.addEventListener('change', () => this.addFiles(fileInput.files));
        composer.querySelector('#cwModeChip').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleModeMenu();
        });
        composer.querySelector('#cwActionBtn').addEventListener('click', () => {
            if (composer.querySelector('#cwActionBtn').dataset.action === 'mic') this.startRecording();
            else this.sendMessage();
        });

        this.renderModeChip();
        this.renderAttachmentTray();
        this.updateActionButton();

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
