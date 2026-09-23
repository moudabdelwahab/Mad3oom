/**
 * robot.js — مساعد الإعداد (Onboarding Assistant) لمنصة مدعوم
 * =============================================================
 * بيستخدم نفس الكلاسات الجاهزة في robot.css (robot-container, robot-avatar,
 * speech-bubble, robot-header, robot-name, robot-status, tour-btn) + إضافات
 * onboarding-assistant.css عشان يبني محادثة خطوة بخطوة.
 *
 * مطلوب في الصفحة (بالترتيب):
 *   <link rel="stylesheet" href="robot.css">
 *   <link rel="stylesheet" href="onboarding-assistant.css">
 *   ...
 *   <script type="module" src="robot.js"></script>
 *
 * ⚠️ ملحوظة مهمة (تحديث): الملف بقى ES module (type="module") عشان يقدر
 * يستورد supabase ويتحقق من اشتراك العميل. لو استخدمته في صفحة تانية،
 * لازم الـ <script> تبقى type="module".
 *
 * الظهور بقى مشروط باشتراك نشط:
 *   الروبوت مبقاش يظهر لكل العملاء. أول ما الصفحة تحمّل، بيتحقق هل عند
 *   العميل الحالي اشتراك نشط (أي خطة: دعم فني / واتساب / باقة) عن طريق
 *   getActiveSubscription() من whatsapp-subscription-service.js. لو مفيش
 *   اشتراك نشط، الروبوت ماينبنيش في الـ DOM أصلًا (مفيش أفاتار ولا حاجة).
 *
 * التفعيل التلقائي أول مرة يتفعل فيها الاشتراك:
 *   بنسجّل في localStorage قايمة الاشتراكات اللي العميل شافها قبل كده
 *   (seenSubscriptionIds). أول مرة نلاقي id اشتراك نشط مش موجود في القايمة
 *   دي، معناها الاشتراك ده لسه متفعل حديثًا — فالمساعد بيفتح نفسه تلقائيًا.
 *   الاشتراكات القديمة اللي العميل خلّص onboarding بتاعها مش هتفتح تاني
 *   لوحدها كل مرة يدخل الداشبورد.
 *
 * لسه فيه مفتاح madoum_trigger_onboarding كتفعيل يدوي احتياطي (لو حبينا
 * مستقبلًا نجبر فتح المساعد من صفحة تانية زي صفحة نجاح الدفع مباشرة).
 *
 * تنبيهات تيليجرام:
 *   كانت هنا خطوة «إنشاء بوت» وهمية: نموذج + خطوات متحركة ثم رسالة
 *   «تم ربط بوت التيليجرام بنجاح ✅» — بينما OnboardingAPI.createTelegramBot
 *   كانت mock ترجع نجاحًا دائمًا ولا تنشئ شيئًا. العميل كان يُقال له إن
 *   بوته شغّال وهو غير موجود. أُزيلت: لا يوجد مسار خلفي لإنشاء بوت للعميل،
 *   فالمساعد يوجّه لفريق الدعم (المحادثة المباشرة الحقيقية) بدل ادّعاء نجاح.
 */

import { supabase } from '/api-config.js';
import { getActiveSubscription } from '/whatsapp-subscription-service.js';

(function () {
  'use strict';

  const STORAGE_KEY = 'madoum_onboarding_v1';
  const TRIGGER_KEY = 'madoum_trigger_onboarding';

  // أيقونة المساعد — SVG بلون الهوية بدل صورة PNG ثقيلة (260KB)
  const ASSISTANT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="4"></rect><path d="M12 7V4"></path><circle cx="12" cy="3.2" r="0.9" fill="currentColor"></circle><path d="M9 12.5v.5M15 12.5v.5"></path><path d="M10 16c.6.4 1.2.6 2 .6s1.4-.2 2-.6"></path></svg>';
  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"></path></svg>'
  };

  // ---------------------------------------------------------------------
  // OnboardingAPI — نقطة توسعة لتتبّع الخطوات (لا نداء شبكة حاليًا)
  // ---------------------------------------------------------------------
  const OnboardingAPI = {
    /**
     * تسجيل إن العميل مرّ على خطوة onboarding معيّنة (لتحليلات لاحقة).
     * TODO: fetch('/api/onboarding/track', { method:'POST', body: JSON.stringify({...}) })
     */
    async trackStep(stepName) {
      // مفيش استدعاء فعلي دلوقتي — مجرد نقطة توسعة جاهزة
      return true;
    }
  };


  // ---------------------------------------------------------------------
  // الحالة المحفوظة محليًا
  // ---------------------------------------------------------------------
  function getUserId() {
    // بنستخدم نفس المفتاح اللي بيستخدمه chat-widget.js عشان هوية موحّدة
    let id = localStorage.getItem('chat_user_id');
    if (!id) {
      id = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('chat_user_id', id);
    }
    return id;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.seenSubscriptionIds)) parsed.seenSubscriptionIds = [];
        return parsed;
      }
    } catch (e) { /* ignore corrupted state */ }
    return { started: false, completed: false, telegramConnected: false, botUsername: null, seenSubscriptionIds: [] };
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // ---------------------------------------------------------------------
  // بناء الـ DOM
  // ---------------------------------------------------------------------
  function buildDom() {
    if (document.getElementById('madoumRobotContainer')) return; // ما نكررش

    const wrap = document.createElement('div');
    wrap.className = 'robot-container';
    wrap.id = 'madoumRobotContainer';
    wrap.innerHTML = `
      <section class="speech-bubble assistant-mode" id="madoumSpeechBubble" role="dialog" aria-labelledby="madoumAssistantName">
        <div class="robot-header">
          <span class="robot-header-mark">${ASSISTANT_ICON}</span>
          <span class="robot-header-text">
            <span class="robot-name" id="madoumAssistantName">مساعد الإعداد</span>
            <span class="robot-subtitle">خطوات سريعة لتجهيز حسابك</span>
          </span>
          <button type="button" class="bubble-close" id="madoumBubbleClose" aria-label="إغلاق المساعد">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div class="robot-progress" id="madoumProgress" aria-hidden="true"></div>
        <div class="robot-body" id="madoumRobotBody" aria-live="polite"></div>
      </section>
      <button type="button" class="robot-avatar" id="madoumRobotAvatar" aria-controls="madoumSpeechBubble" aria-expanded="false" aria-label="مساعد الإعداد">
        ${ASSISTANT_ICON}
        <span class="robot-avatar-label" aria-hidden="true">مساعد الإعداد</span>
        <span class="robot-notify-dot" id="madoumNotifyDot"></span>
      </button>
    `;
    document.body.appendChild(wrap);
  }

  // ---------------------------------------------------------------------
  // المتحكم الرئيسي
  // ---------------------------------------------------------------------
  function OnboardingController(activeSubscriptionId) {
    this.userId = getUserId();
    this.state = loadState();
    this.activeSubscriptionId = activeSubscriptionId || null;
    this.totalStages = 4; // ترحيب -> سؤال تيليجرام -> خطوات الربط -> واتساب/ختام
    this.stage = 0;
    this.bubble = null;
    this.body = null;
    this.progress = null;
    this.isOpen = false;
  }

  OnboardingController.prototype.mount = function () {
    buildDom();
    this.bubble = document.getElementById('madoumSpeechBubble');
    this.body = document.getElementById('madoumRobotBody');
    this.progress = document.getElementById('madoumProgress');
    this.avatar = document.getElementById('madoumRobotAvatar');
    this.notifyDot = document.getElementById('madoumNotifyDot');

    this.buildProgressRail();

    this.avatar.addEventListener('click', () => this.toggle());
    document.getElementById('madoumBubbleClose').addEventListener('click', () => {
      this.close();
      this.avatar.focus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
        this.avatar.focus();
      }
    });

    // أول مرة نشوف الاشتراك النشط ده (يعني اتفعّل حديثًا) -> افتح المساعد
    // تلقائيًا. لو الاشتراك ده اتشاف قبل كده، سيبه يفضل مقفول واظهر نقطة
    // التنبيه بس لو العميل لسه معملش onboarding خالص.
    const isFreshlyActivatedSubscription = this.activeSubscriptionId &&
      !this.state.seenSubscriptionIds.includes(this.activeSubscriptionId);

    if (isFreshlyActivatedSubscription) {
      this.state.seenSubscriptionIds.push(this.activeSubscriptionId);
      saveState(this.state);
      setTimeout(() => this.open({ forceRestart: true }), 900);
    } else if (!this.state.started) {
      this.notifyDot.classList.add('show');
    }

    // مفتاح تفعيل يدوي احتياطي (لو صفحة تانية عايزة تجبر فتح المساعد
    // بغض النظر عن حالة الاشتراك اللي شافها قبل كده)
    if (localStorage.getItem(TRIGGER_KEY) === '1') {
      localStorage.removeItem(TRIGGER_KEY);
      setTimeout(() => this.open({ forceRestart: true }), 900);
    }
  };

  OnboardingController.prototype.buildProgressRail = function () {
    this.progress.innerHTML = '';
    for (let i = 0; i < this.totalStages; i++) {
      const seg = document.createElement('i');
      seg.innerHTML = '<span></span>';
      this.progress.appendChild(seg);
    }
  };

  OnboardingController.prototype.setStage = function (n) {
    this.stage = n;
    [...this.progress.children].forEach((seg, i) => {
      seg.classList.toggle('done', i < n);
      seg.classList.toggle('active', i === n);
    });
  };

  OnboardingController.prototype.toggle = function () {
    if (this.isOpen) this.close(); else this.open();
  };

  OnboardingController.prototype.open = function (opts) {
    opts = opts || {};
    this.bubble.classList.add('visible');
    this.avatar.setAttribute('aria-expanded', 'true');
    this.isOpen = true;
    this.notifyDot.classList.remove('show');

    if (opts.forceRestart || !this.state.started) {
      this.startFlow();
    } else if (this.state.completed) {
      this.showWelcomeBack();
    } else {
      // بدأ قبل كده بس محصلش يكمّل — نديله نفس شاشة الرجوع مبسطة
      this.showWelcomeBack();
    }
  };

  OnboardingController.prototype.close = function () {
    this.bubble.classList.remove('visible');
    this.avatar.setAttribute('aria-expanded', 'false');
    this.isOpen = false;
  };

  /** يفتح المحادثة المباشرة الحقيقية (chat-widget.js) ويغلق المساعد. */
  OnboardingController.prototype.openSupportChat = function (prefill) {
    this.close();
    if (window.chatWidget && typeof window.chatWidget.openWidget === 'function') {
      window.chatWidget.openWidget().then(() => {
        const input = document.getElementById('chatWidgetTextInput');
        if (prefill && input && !input.value) {
          input.value = prefill;
          input.dispatchEvent(new Event('input'));
        }
      });
    }
  };

  OnboardingController.prototype.scrollDown = function () {
    this.body.scrollTop = this.body.scrollHeight;
  };

  OnboardingController.prototype.showTyping = function (duration) {
    duration = duration || 800;
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'robot-typing';
      el.innerHTML = '<span></span><span></span><span></span>';
      this.body.appendChild(el);
      this.scrollDown();
      setTimeout(() => { el.remove(); resolve(); }, duration);
    });
  };

  OnboardingController.prototype.say = async function (html) {
    await this.showTyping();
    const el = document.createElement('div');
    el.className = 'robot-msg';
    el.innerHTML = html;
    this.body.appendChild(el);
    this.scrollDown();
  };

  OnboardingController.prototype.addChoices = function (options) {
    const wrap = document.createElement('div');
    wrap.className = 'robot-choices';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'robot-choice-btn' + (opt.primary ? ' primary' : '');
      btn.textContent = opt.label;
      btn.onclick = () => {
        [...wrap.querySelectorAll('button')].forEach((b) => (b.disabled = true));
        wrap.style.opacity = '.5';
        opt.onClick();
      };
      wrap.appendChild(btn);
    });
    this.body.appendChild(wrap);
    this.scrollDown();
  };

  OnboardingController.prototype.goToWhatsappStage = async function () {
    this.setStage(3);
    await this.say('بالنسبة لتنبيهات <b>الواتساب</b>، الخدمة قريبة جدًا 🚀 وهتوصلك رسالة أول ما تتفعّل.');
    await this.say('شكرًا لوقتك 🙌 كده خلصنا خطوات الإعداد الأساسية. لو احتجتني أي وقت، أنا موجود دايمًا من هنا.');
    this.setStage(4);
    this.state.completed = true;
    saveState(this.state);
  };

  OnboardingController.prototype.startFlow = async function () {
    this.body.innerHTML = '';
    this.state.started = true;
    saveState(this.state);
    OnboardingAPI.trackStep('welcome_shown');

    this.setStage(0);
    await this.say('أهلاً بيك 👋 نورت مدعوم! وعشان كده هنعدّي سوا شوية خطوات هتخلي تجربتك أفضل، وأنا هكون معاك خطوة بخطوة.');
    this.addChoices([{ label: 'يلا نبدأ 🚀', primary: true, onClick: () => this.stageTicketsAndTelegram() }]);
  };

  OnboardingController.prototype.stageTicketsAndTelegram = async function () {
    this.setStage(1);
    OnboardingAPI.trackStep('telegram_question_shown');
    await this.say('🎉 مبروك، دلوقتي عندك <b>عدد غير محدود</b> من إنشاء التذاكر. تحب تفعّل تنبيهات تيليجرام؟ لو حد دخل على رابطك وعمل تذكرة، هتوصلك رسالة فورية على البوت بتاعك.');
    this.addChoices([
      {
        label: 'أه، عايز أفعّلها', primary: true, onClick: async () => {
          OnboardingAPI.trackStep('telegram_requested');
          // لا يوجد مسار آلي لإنشاء بوت للعميل — التفعيل يتم مع فريق الدعم
          // فعليًا، فنقول ذلك بوضوح بدل محاكاة نجاح.
          await this.say('ربط بوت تيليجرام الخاص بيك بيتم حاليًا مع فريق الدعم مباشرة. ابعتلهم من المحادثة وهيجهّزوه معاك خطوة بخطوة.');
          this.addChoices([
            { label: 'راسل الدعم الآن', primary: true, onClick: () => { this.openSupportChat('عايز أفعّل تنبيهات تيليجرام لحسابي'); this.goToWhatsappStage(); } },
            { label: 'لاحقًا', onClick: () => this.goToWhatsappStage() }
          ]);
        }
      },
      {
        label: 'لأ، مش دلوقتي', onClick: async () => {
          await this.say('تمام، تقدر ترجع تفعّلها في أي وقت من هنا 🙂');
          this.goToWhatsappStage();
        }
      }
    ]);
  };

  OnboardingController.prototype.showWelcomeBack = function () {
    this.body.innerHTML = '';
    this.setStage(this.state.completed ? 4 : this.stage);

    // لا نعرض «بوتك شغّال» اعتمادًا على telegramConnected المحفوظة محليًا:
    // تلك القيمة كتبتها خطوة وهمية قديمة ولا تعني أن بوتًا أُنشئ فعلًا.
    const msg = document.createElement('div');
    msg.className = 'robot-msg';
    msg.textContent = 'أهلاً بيك تاني 👋 أقدر أساعدك في إيه؟';
    this.body.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'robot-quick-actions';

    const button = (icon, label, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `${ICONS[icon]}<span></span>`;
      btn.querySelector('span').textContent = label;
      btn.onclick = onClick;
      actions.appendChild(btn);
    };

    button('send', 'تفعيل تنبيهات تيليجرام مع الدعم', () => this.openSupportChat('عايز أفعّل تنبيهات تيليجرام لحسابي'));
    button('replay', 'إعادة عرض خطوات الإعداد من الأول', () => this.startFlow());
    button('chat', 'محتاج مساعدة؟ تواصل مع الدعم', () => this.openSupportChat());

    this.body.appendChild(actions);
    this.scrollDown();
  };

  // ---------------------------------------------------------------------
  // بوابة الأهلية: الروبوت يظهر بس لو عند العميل اشتراك نشط
  // ---------------------------------------------------------------------
  let controllerInstance = null;

  async function checkEligibility() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null; // مش مسجل دخول (زائر) -> مفيش روبوت

      // أي خطة نشطة (دعم فني / واتساب / باقة) كافية عشان يظهر الروبوت
      const activeSubscription = await getActiveSubscription();
      if (!activeSubscription) return null;

      return activeSubscription;
    } catch (e) {
      console.error('[Onboarding] فشل التحقق من الاشتراك:', e);
      return null;
    }
  }

  async function ensureMounted() {
    if (controllerInstance) return controllerInstance;
    const activeSubscription = await checkEligibility();
    if (!activeSubscription) return null;
    controllerInstance = new OnboardingController(activeSubscription.id);
    controllerInstance.mount();
    return controllerInstance;
  }

  // إتاحة نداء برمجي من أي مكان في المنصة، مثلاً بعد نجاح الدفع مباشرة:
  //   window.MadoumOnboarding.open({ forceRestart: true });
  // (هتشتغل بس لو العميل عنده اشتراك نشط فعلًا، غير كده مش هتعمل حاجة)
  window.MadoumOnboarding = {
    open: async (opts) => {
      const c = await ensureMounted();
      if (c) c.open(opts);
    },
    close: () => { if (controllerInstance) controllerInstance.close(); },
    resetProgress: () => {
      localStorage.removeItem(STORAGE_KEY);
      if (controllerInstance) controllerInstance.state = loadState();
    }
  };

  // ---------------------------------------------------------------------
  // تهيئة عند تحميل الصفحة
  // ---------------------------------------------------------------------
  async function init() {
    await ensureMounted();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
