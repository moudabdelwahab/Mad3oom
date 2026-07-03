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
 *   <script src="robot.js" defer></script>
 *
 * التفعيل التلقائي بعد الاشتراك:
 *   قبل ما توجّه العميل للوحة التحكم بعد نجاح الدفع، سيب صفحة الـ checkout تعمل:
 *     localStorage.setItem('madoum_trigger_onboarding', '1');
 *   والمساعد هيفتح لوحده أول ما الداشبورد تحمّل، ويمسح الفلاج ده تلقائيًا.
 *
 * ربط الباك إند لاحقًا:
 *   كل نداءات الشبكة معزولة جوه OnboardingAPI تحت. دلوقتي بترجع بيانات
 *   وهمية (mock) بعد تأخير بسيط عشان تجربة UI متسقة. لما الـ backend يجهز،
 *   استبدل جسم كل دالة بنداء fetch حقيقي (الأماكن متعلّم عليها بـ TODO).
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'madoum_onboarding_v1';
  const TRIGGER_KEY = 'madoum_trigger_onboarding';
  const IMG_SRC = 'assets/images/mad3oom-robot.png';

  // ---------------------------------------------------------------------
  // OnboardingAPI — طبقة معزولة لكل نداءات الباك إند المستقبلية
  // ---------------------------------------------------------------------
  const OnboardingAPI = {
    /**
     * إنشاء بوت تيليجرام وربطه بحساب العميل.
     * TODO: استبدلها بنداء حقيقي، مثال:
     *   return fetch('/api/telegram/create-bot', {
     *     method: 'POST',
     *     headers: { 'Content-Type': 'application/json' },
     *     body: JSON.stringify({ userId, botName, botUsername })
     *   }).then(r => r.json());
     * المتوقع من الباك إند إنه يرجّع:
     *   { success: true, token: '...', botUsername: '...' }
     *   أو { success: false, error: 'رسالة الخطأ' }
     */
    async createTelegramBot({ userId, botName, botUsername }) {
      await wait(1400);
      return { success: true, token: 'MOCK_TOKEN_' + Date.now(), botUsername };
    },

    /**
     * تسجيل إن العميل مرّ على خطوة onboarding معيّنة (لتحليلات لاحقة).
     * TODO: fetch('/api/onboarding/track', { method:'POST', body: JSON.stringify({...}) })
     */
    async trackStep(stepName) {
      // مفيش استدعاء فعلي دلوقتي — مجرد نقطة توسعة جاهزة
      return true;
    }
  };

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore corrupted state */ }
    return { started: false, completed: false, telegramConnected: false, botUsername: null };
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
      <div class="speech-bubble assistant-mode" id="madoumSpeechBubble">
        <div class="robot-header">
          <span class="robot-status"></span>
          <span class="robot-name">مساعد الإعداد</span>
          <button class="bubble-close" id="madoumBubbleClose" aria-label="إغلاق">×</button>
        </div>
        <div class="robot-progress" id="madoumProgress"></div>
        <div class="robot-body" id="madoumRobotBody"></div>
      </div>
      <div class="robot-avatar active" id="madoumRobotAvatar">
        <span class="robot-notify-dot" id="madoumNotifyDot"></span>
        <img src="${IMG_SRC}" alt="مساعد مدعوم">
        <span class="fallback-icon">
          <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </span>
      </div>
    `;
    document.body.appendChild(wrap);

    // fallback لو صورة الروبوت مش موجودة على السيرفر لسه
    const img = wrap.querySelector('#madoumRobotAvatar img');
    img.addEventListener('error', () => {
      document.getElementById('madoumRobotAvatar').classList.add('img-error');
    });
  }

  // ---------------------------------------------------------------------
  // المتحكم الرئيسي
  // ---------------------------------------------------------------------
  function OnboardingController() {
    this.userId = getUserId();
    this.state = loadState();
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
    document.getElementById('madoumBubbleClose').addEventListener('click', () => this.close());

    // لو لسه محدش بدأ الـ onboarding، حط نقطة تنبيه على الروبوت
    if (!this.state.started) this.notifyDot.classList.add('show');

    // تفعيل تلقائي بعد الاشتراك (شوف تعليمات أعلى الملف)
    if (localStorage.getItem(TRIGGER_KEY) === '1') {
      localStorage.removeItem(TRIGGER_KEY);
      // نستنى شوية لحد ما الصفحة تستقر بصريًا
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
    this.isOpen = false;
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

  OnboardingController.prototype.addStepList = function (title, steps, onDone) {
    const box = document.createElement('div');
    box.className = 'robot-steplist';
    const list = document.createElement('ul');
    steps.forEach((s) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="robot-step-dot"><svg viewBox="0 0 24 24" fill="none"><path d="M4 12l5 5L20 6" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>${s}</span>`;
      list.appendChild(li);
    });
    box.innerHTML = `<div class="cap">${title}</div>`;
    box.appendChild(list);
    this.body.appendChild(box);
    this.scrollDown();

    const items = [...list.children];
    let i = 0;
    const self = this;
    (function next() {
      if (i > 0) items[i - 1].classList.remove('spin');
      if (i >= items.length) { onDone && onDone(); return; }
      items[i].classList.add('spin');
      setTimeout(() => {
        items[i].classList.remove('spin');
        items[i].classList.add('on');
        i++;
        self.scrollDown();
        setTimeout(next, 250);
      }, 480);
    })();
  };

  OnboardingController.prototype.addBotForm = function () {
    const row = document.createElement('div');
    row.className = 'robot-field-card';
    row.innerHTML = `
      <label>اسم البوت</label>
      <input type="text" id="madoumBotName" placeholder="مثال: Madoum Support Bot">
      <label>يوزر البوت (لازم ينتهي بـ bot)</label>
      <input type="text" id="madoumBotUser" placeholder="مثال: MadoumSupport_bot">
      <button id="madoumCreateBotBtn" disabled>Create Bot</button>
    `;
    this.body.appendChild(row);
    this.scrollDown();

    const nameInput = row.querySelector('#madoumBotName');
    const userInput = row.querySelector('#madoumBotUser');
    const createBtn = row.querySelector('#madoumCreateBotBtn');

    const validate = () => {
      createBtn.disabled = !(nameInput.value.trim().length > 1 &&
        userInput.value.trim().toLowerCase().endsWith('bot'));
    };
    nameInput.addEventListener('input', validate);
    userInput.addEventListener('input', validate);

    createBtn.onclick = () => {
      nameInput.disabled = true;
      userInput.disabled = true;
      createBtn.disabled = true;
      createBtn.textContent = 'جاري الإنشاء...';
      this.runTelegramFlow(nameInput.value.trim(), userInput.value.trim());
    };
  };

  OnboardingController.prototype.runTelegramFlow = async function (botName, botUsername) {
    this.setStage(2);
    await wait(250);

    this.addStepList('بيتم الاتصال بـ BotFather', [
      'فتح BotFather تلقائيًا',
      'إنشاء البوت (أقل من دقيقة)',
      'استلام الـ Token ونسخه',
      'لصقه في إعدادات موقعك'
    ], async () => {
      await wait(150);
      this.addStepList('موقعك بيجهّز كل حاجة تلقائيًا', [
        'حفظ الـ Token',
        'إنشاء قاعدة البيانات',
        'إعداد الـ Webhook',
        'تشغيل السيرفر',
        'إضافة الأوامر',
        'إرسال رسالة "تم إنشاء البوت" ✅'
      ], async () => {
        // نداء الباك إند الحقيقي (حاليًا mock)
        const result = await OnboardingAPI.createTelegramBot({
          userId: this.userId, botName, botUsername
        });

        if (result.success) {
          this.state.telegramConnected = true;
          this.state.botUsername = result.botUsername;
          saveState(this.state);
          await this.say(`تم ربط بوت التيليجرام بنجاح ✅ من دلوقتي هتوصلك رسالة فورية أول ما حد يدخل رابطك وينشئ تذكرة.`);
        } else {
          await this.say(`حصلت مشكلة أثناء إنشاء البوت 😕 تقدر تحاول تاني في أي وقت من هنا.`);
        }
        this.goToWhatsappStage();
      });
    });
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
        label: 'أه، يلا نربط', primary: true, onClick: async () => {
          await this.say('تمام! اكتب اسم البوت واليوزر اللي عايزه، وأنا هظبط الباقي.');
          this.addBotForm();
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

    const msg = document.createElement('div');
    msg.className = 'robot-msg';
    msg.innerHTML = this.state.telegramConnected
      ? `أهلاً بيك تاني 👋 بوت التيليجرام (<b>@${this.state.botUsername || ''}</b>) شغال تمام. محتاج أي مساعدة تانية؟`
      : 'أهلاً بيك تاني 👋 لسه معندكش بوت تيليجرام متصل، تحب نربطه دلوقتي؟';
    this.body.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'robot-quick-actions';

    if (!this.state.telegramConnected) {
      const connectBtn = document.createElement('button');
      connectBtn.textContent = '🔗 ربط تيليجرام دلوقتي';
      connectBtn.onclick = () => { this.body.innerHTML = ''; this.setStage(1); this.addBotForm(); };
      actions.appendChild(connectBtn);
    }

    const replayBtn = document.createElement('button');
    replayBtn.textContent = '🔁 إعادة عرض خطوات الإعداد من الأول';
    replayBtn.onclick = () => this.startFlow();
    actions.appendChild(replayBtn);

    const supportBtn = document.createElement('button');
    supportBtn.textContent = '💬 محتاج مساعدة؟ تواصل مع الدعم';
    supportBtn.onclick = () => {
      this.close();
      if (window.chatWidget && typeof window.chatWidget.openWidget === 'function') {
        window.chatWidget.openWidget();
      }
    };
    actions.appendChild(supportBtn);

    this.body.appendChild(actions);
    this.scrollDown();
  };

  // ---------------------------------------------------------------------
  // تهيئة عند تحميل الصفحة
  // ---------------------------------------------------------------------
  function init() {
    const controller = new OnboardingController();
    controller.mount();
    // إتاحة نداء برمجي من أي مكان في المنصة، مثلاً بعد نجاح الدفع مباشرة:
    //   window.MadoumOnboarding.open({ forceRestart: true });
    window.MadoumOnboarding = {
      open: (opts) => controller.open(opts),
      close: () => controller.close(),
      resetProgress: () => {
        localStorage.removeItem(STORAGE_KEY);
        controller.state = loadState();
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
