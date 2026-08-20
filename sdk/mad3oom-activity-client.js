/**
 * ═══════════════════════════════════════════════════════════════
 * Mad3oom Activity Client — عميل تتبّع النشاط لمنصة مدعوم
 * ═══════════════════════════════════════════════════════════════
 *
 * ملف واحد، بلا أي اعتماديات، يُنسخ إلى مستودع منصة مدعوم.
 * لا يعدّل شيئًا في المنصة ولا يحتاج مفاتيح جديدة: يستخدم عميل Supabase
 * الموجود أصلًا في المنصة، فتصل الأحداث بهوية الموظف نفسها وتُفحص على
 * الخادم كما لو أُرسلت من لوحة العمليات.
 *
 * ── التركيب ──────────────────────────────────────────────────
 *   import { Mad3oomActivity } from './mad3oom-activity-client.js';
 *   import { supabase } from './lib/supabaseClient';   // عميل المنصة الحالي
 *
 *   const activity = Mad3oomActivity.init({ supabase });
 *
 * ── تسجيل عملية حقيقية ───────────────────────────────────────
 *   activity.track('ticket_reply', { entityType: 'ticket', entityId: ticket.id });
 *   activity.track('ticket_status', { entityType: 'ticket', entityId: id,
 *                                     metadata: { from: 'open', to: 'resolved' } });
 *
 * ── ما يُرسَل بالضبط ─────────────────────────────────────────
 *   • نوع العملية (من كتالوج معرَّف في قاعدة البيانات)
 *   • معرّف الكيان (رقم التذكرة مثلًا)
 *   • عدّاد رقمي لعدد التفاعلات منذ آخر نبضة
 *   • هل تبويب مدعوم ظاهر، وهل عليه Focus، وعدد التبويبات المفتوحة
 *
 * ── متى يُحتسب Active Time ───────────────────────────────────
 *   فقط بينما يكون على الجهاز تبويب مدعوم واحد على الأقل: ظاهرًا
 *   (visibilityState) وعليه Focus (focus/blur)، مع تفاعل حقيقي داخل
 *   نافذة الخمول. الانتقال إلى تبويب أو تطبيق آخر يوقف الاحتساب فورًا
 *   بينما يستمر الشيفت كما هو — الفصل بين الاثنين مقصود.
 *
 * ── ما لا يُرسَل إطلاقًا ─────────────────────────────────────
 *   • أي حرف يكتبه الموظف (المفاتيح تُعدّ عدًّا ولا تُقرأ)
 *   • محتوى التذاكر أو الردود · لقطات شاشة · إحداثيات فأرة
 *   • أي نشاط خارج صفحات منصة مدعوم
 *
 * كل الأوقات تُحسب على الخادم. لا يستطيع هذا الملف — ولا أي تعديل عليه —
 * أن يزيد وقت عمل الموظف: الخادم يرفض أي وقت لا يقابله شيفت مفتوح
 * وتفاعل حقيقي داخل نافذة الخمول.
 */

const DEVICE_KEY = 'eo.device';
const CHANNEL = 'eo.tracker';
const SOURCE_APP = 'mad3oom';

function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return `ephemeral-${Math.random().toString(16).slice(2)}`;
  }
}

class Client {
  constructor({ supabase, autoInteraction = true, onStatus = null, debug = false }) {
    if (!supabase || typeof supabase.rpc !== 'function') {
      throw new Error('Mad3oomActivity: يجب تمرير عميل Supabase الخاص بالمنصة.');
    }
    this.sb = supabase;
    this.onStatus = onStatus;
    this.debug = debug;
    this.autoInteraction = autoInteraction;

    this.device = getDeviceId();
    this.tabId = Math.random().toString(36).slice(2, 10);
    this.interactions = 0;
    this.queue = [];
    this.tabs = new Map([[this.tabId, Date.now()]]);

    // حالة الانخراط: تبويب ظاهر + عليه Focus.
    // visibilityState يكشف الانتقال إلى تبويب آخر داخل النافذة نفسها،
    // و focus/blur يكشفان انتقال المستخدم إلى نافذة أو تطبيق آخر بينما
    // يبقى تبويب مدعوم "ظاهرًا" تقنيًا. الحالتان مطلوبتان معًا.
    this.visible = document.visibilityState === 'visible';
    this.focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    this.peers = new Map();   // tabId -> { v: ظاهر, e: منخرط } لبقية تبويبات الجهاز
    this.intervalSec = 60;
    this.failures = 0;
    this.isLeader = false;
    this.running = false;
    this.hasSession = null;      // null = غير معروف بعد
    this._timer = null;
    this._bc = null;
    this._off = [];
  }

  /* ── التشغيل ─────────────────────────────────────────── */

  start() {
    if (this.running) return this;
    this.running = true;
    if (this.autoInteraction) this._listenInteraction();
    this._listenLifecycle();
    this._openChannel();
    this._electLeader();
    this._schedule(3);
    return this;
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
    this._off.forEach(([t, e, h, o]) => t.removeEventListener(e, h, o));
    this._off = [];
    if (this._bc) { try { this._bc.close(); } catch {} this._bc = null; }
    return this;
  }

  /**
   * تسجيل عملية عمل حقيقية.
   * @param {string} type نوع العملية من كتالوج emp_ops.activity_types
   *   (ticket_open · ticket_reply · ticket_status · ticket_assign · ticket_note
   *    · chat_reply · search · navigation · ui_interaction · tool_use)
   */
  track(type, { entityType = null, entityId = null, metadata = {} } = {}) {
    if (!type || !this.running) return this;
    this.queue.push({
      type,
      entity_type: entityType,
      entity_id: entityId != null ? String(entityId) : null,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      client_time: new Date().toISOString()
    });
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
    this.bump();
    if (this.queue.length >= 10) this._schedule(1);
    return this;
  }

  /** زيادة عدّاد التفاعل (رقم فقط، بلا أي محتوى). */
  bump() {
    if (!this.isLeader && this._bc) { this._bc.postMessage({ t: 'delta', tab: this.tabId, n: 1 }); return; }
    this.interactions++;
  }

  /** هل للموظف شيفت مفتوح الآن؟ (null قبل أول نبضة) */
  get isOnShift() { return this.hasSession; }

  /* ── الاستماع ────────────────────────────────────────── */

  _on(target, event, handler, opts) {
    target.addEventListener(event, handler, opts);
    this._off.push([target, event, handler, opts]);
  }

  _listenInteraction() {
    const bump = () => this.bump();
    this._on(document, 'pointerdown', bump, { passive: true });
    this._on(document, 'keydown', bump, { passive: true });   // عدّ فقط — لا يُقرأ أي مفتاح
    let last = 0;
    this._on(window, 'scroll', () => {
      const now = Date.now();
      if (now - last > 4000) { last = now; this.bump(); }
    }, { passive: true });
  }

  _listenLifecycle() {
    this._on(document, 'visibilitychange', () => {
      this.visible = document.visibilityState === 'visible';
      if (this.visible && typeof document.hasFocus === 'function') this.focused = document.hasFocus();
      this._syncEngagement();
    });
    this._on(window, 'focus', () => { this.focused = true;  this._syncEngagement(); });
    this._on(window, 'blur',  () => { this.focused = false; this._syncEngagement(); });

    this._on(window, 'online', () => this._schedule(1));
    this._on(window, 'pagehide', () => {
      this.visible = false; this.focused = false;
      if (this._bc) {
        this._bc.postMessage({ t: 'engage', tab: this.tabId, v: false, e: false });
        this._bc.postMessage({ t: 'bye', tab: this.tabId });
      }
    });
  }

  /** انخراط هذا التبويب. */
  get engaged() { return this.visible && this.focused; }

  /** انخراط الجهاز كله: يكفي تبويب مدعوم واحد منخرط. */
  _deviceEngagement() {
    let v = this.visible, e = this.engaged;
    for (const st of this.peers.values()) { v = v || !!st.v; e = e || !!st.e; }
    return { visible: v, engaged: e };
  }

  /**
   * تغيّر الانخراط: يُبلَّغ فورًا لا في النبضة التالية.
   * الدخول  ⇒ نبضة فورية حتى يستأنف الاحتساب من هذه اللحظة.
   * الخروج  ⇒ نبضة فورية حتى يتوقف الاحتساب عند هذه اللحظة بالضبط،
   *           فيغلق الخادم نافذة النشاط ولا يمنح فترة الغياب عند العودة.
   */
  _syncEngagement() {
    const now = this.engaged;
    if (now === this._lastEngaged) return;
    this._lastEngaged = now;
    if (this._bc) this._bc.postMessage({ t: 'engage', tab: this.tabId, v: this.visible, e: now });
    if (now) this.bump();
    this._schedule(1);
  }

  _openChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    this._bc = new BroadcastChannel(CHANNEL);
    this._bc.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.tab && m.tab !== this.tabId) this.tabs.set(m.tab, Date.now());
      if (m.t === 'delta' && this.isLeader) this.interactions += m.n || 0;
      if (m.t === 'engage' && m.tab !== this.tabId) {
        this.peers.set(m.tab, { v: !!m.v, e: !!m.e });
        if (this.isLeader) this._schedule(1);   // تغيّر انخراط الجهاز ⇒ أبلغ فورًا
      }
      if (m.t === 'bye') { this.tabs.delete(m.tab); this.peers.delete(m.tab); }
      if (m.t === 'status') { this.hasSession = m.payload?.status === 'ok'; this.onStatus?.(m.payload); }
    };
    const ping = setInterval(() => {
      if (!this.running || !this._bc) { clearInterval(ping); return; }
      this._bc.postMessage({ t: 'ping', tab: this.tabId });
      this._bc.postMessage({ t: 'engage', tab: this.tabId, v: this.visible, e: this.engaged });
      const cutoff = Date.now() - 15000;
      for (const [id, seen] of this.tabs) {
        if (id !== this.tabId && seen < cutoff) { this.tabs.delete(id); this.peers.delete(id); }
      }
    }, 5000);
  }

  /** تبويب واحد فقط يرسل النبضات لكل جهاز. */
  _electLeader() {
    if (!navigator.locks) { this.isLeader = true; return; }
    navigator.locks
      .request('eo-activity-leader', { mode: 'exclusive' },
        () => new Promise((release) => { this.isLeader = true; if (!this.running) release(); }))
      .catch(() => { this.isLeader = true; });
  }

  /* ── الإرسال ─────────────────────────────────────────── */

  _schedule(seconds) {
    clearTimeout(this._timer);
    if (!this.running) return;
    this._timer = setTimeout(() => this._send(), Math.max(1, seconds) * 1000);
  }

  async _send() {
    if (!this.running) return;
    if (!this.isLeader) { this._schedule(this.intervalSec); return; }
    if (!navigator.onLine) { this._schedule(Math.min(this.intervalSec, 20)); return; }

    const events = this.queue;
    const count = this.interactions;
    const dev = this._deviceEngagement();
    // لا ترسل نبضة فارغة تمامًا إذا كان الجهاز غير منخرط ولا يوجد شيفت
    if (!events.length && count === 0 && !dev.visible && this.hasSession === false) {
      this._schedule(this.intervalSec);
      return;
    }
    this.queue = [];
    this.interactions = 0;

    const payload = {
      device_id: this.device,
      source_app: SOURCE_APP,
      interactions: count,
      // الحالة على مستوى الجهاز: يكفي تبويب مدعوم واحد منخرط، حتى لو كان
      // التبويب القائد مخفيًا. الخادم يشترط visible && focused معًا.
      visible: dev.visible,
      focused: dev.engaged,
      tabs: Math.max(1, this.tabs.size),
      client_time: new Date().toISOString(),
      user_agent: navigator.userAgent,
      platform: navigator.platform || '',
      events: events.slice(0, 50)
    };

    try {
      const { data, error } = await this.sb.rpc('eo_ingest_activity', { p_payload: payload });
      if (error) throw error;

      this.failures = 0;
      if (data?.next_heartbeat_seconds) this.intervalSec = Number(data.next_heartbeat_seconds) || this.intervalSec;

      if (data?.status === 'throttled') {
        this.queue = events.concat(this.queue);
        this.interactions += count;
        this._schedule(Number(data.retry_after_seconds) || 30);
        return;
      }

      this.hasSession = data?.status === 'ok';
      this.onStatus?.(data);
      if (this._bc) this._bc.postMessage({ t: 'status', tab: this.tabId, payload: data });
      if (this.debug) console.debug('[Mad3oomActivity]', data);

      this._schedule(data?.status === 'no_session' ? this.intervalSec * 2 : this.intervalSec);
    } catch (err) {
      // لا نفقد شيئًا: تُعاد الحمولة إلى الطابور مع تراجع تدريجي
      this.queue = events.concat(this.queue).slice(-200);
      this.interactions += count;
      this.failures++;
      if (this.debug) console.warn('[Mad3oomActivity] فشل الإرسال', err);

      const code = err?.code || '';
      if (code === 'EO401' || code === 'EO403' || code === 'PGRST301') { this.stop(); return; }

      this._schedule(Math.min(this.intervalSec * Math.pow(2, this.failures), 300));
    }
  }
}

export const Mad3oomActivity = {
  _instance: null,

  /**
   * تهيئة العميل (مرة واحدة لكل صفحة).
   * @param {object}   opts.supabase        عميل Supabase الخاص بمنصة مدعوم (إلزامي)
   * @param {boolean} [opts.autoInteraction=true] عدّ النقر والكتابة والتمرير تلقائيًا
   * @param {function}[opts.onStatus]       يُستدعى بعد كل نبضة بحالة الخادم
   * @param {boolean} [opts.debug=false]
   */
  init(opts) {
    if (this._instance) return this._instance;
    this._instance = new Client(opts).start();
    return this._instance;
  },

  get instance() { return this._instance; },

  track(type, opts) { return this._instance?.track(type, opts); },

  stop() { this._instance?.stop(); this._instance = null; }
};

export default Mad3oomActivity;
