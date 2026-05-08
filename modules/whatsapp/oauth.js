/**
 * =====================================================
 * services/oauth.js
 * Meta WhatsApp OAuth Service
 * منصة مدعوم - خدمة التفويض
 * =====================================================
 *
 * هذا الملف يتعامل مع:
 * 1. بناء رابط OAuth لـ Meta
 * 2. استخراج authorization code من URL
 * 3. إرسال الـ code إلى Supabase Edge Function
 * 4. تخزين النتائج مؤقتًا في localStorage
 *
 * ⚠️ Supabase Integration Points:
 * - استبدل EXCHANGE_ENDPOINT بالـ URL الحقيقي لـ Edge Function
 * - أضف Supabase Auth headers إذا لزم (Authorization: Bearer <token>)
 */

const OAuthService = (() => {

  // ─── Configuration ───────────────────────────────────
  // TODO: استبدل هذه القيم بالقيم الحقيقية من Meta App Dashboard
  const CONFIG = {
    META_APP_ID:      'YOUR_META_APP_ID',           // App ID من Meta for Developers
    REDIRECT_URI:     window.location.origin + '/', // Redirect URI مسجّل في Meta App
    SCOPE:            'whatsapp_business_management,whatsapp_business_messaging',
    RESPONSE_TYPE:    'code',

    // ─── Supabase Edge Function Endpoint ───
    // TODO: استبدل بـ URL الحقيقي بعد نشر Edge Function
    // مثال: https://your-project.supabase.co/functions/v1/exchange-token
    EXCHANGE_ENDPOINT: '/functions/v1/exchange-token',

    // localStorage keys
    STORAGE_KEY_TOKEN:    'mad3oom_wa_access_token',
    STORAGE_KEY_PHONE_ID: 'mad3oom_wa_phone_id',
    STORAGE_KEY_WABA_ID:  'mad3oom_wa_waba_id',
    STORAGE_KEY_STATUS:   'mad3oom_wa_status',
    STORAGE_KEY_TS:       'mad3oom_wa_connected_at',
  };

  // ─── State ───────────────────────────────────────────
  let _state = {
    status:      'idle',   // idle | loading | success | error
    accessToken: null,
    phoneId:     null,
    wabaId:      null,
    errorMsg:    null,
    connectedAt: null,
  };

  let _listeners = [];

  // ─── Public API ──────────────────────────────────────

  /**
   * بناء رابط OAuth وإعادة توجيه المستخدم إلى Meta
   * يُستدعى عند النقر على "Connect WhatsApp"
   */
  function startOAuthFlow() {
    const state = _generateState();
    sessionStorage.setItem('oauth_state', state);

    const params = new URLSearchParams({
      client_id:     CONFIG.META_APP_ID,
      redirect_uri:  CONFIG.REDIRECT_URI,
      scope:         CONFIG.SCOPE,
      response_type: CONFIG.RESPONSE_TYPE,
      state:         state,
    });

    const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;

    // ─── Supabase Auth Note ───
    // إذا كنت تستخدم Supabase Auth للمستخدمين، أضف هنا:
    // const supabaseUser = supabase.auth.getUser();
    // sessionStorage.setItem('supabase_user_id', supabaseUser.id);

    window.location.href = authUrl;
  }

  /**
   * استخراج الـ code من URL وإرساله للـ Edge Function
   * يُستدعى تلقائيًا عند تحميل الصفحة إذا وُجد code في URL
   */
  async function handleCallback() {
    const params    = new URLSearchParams(window.location.search);
    const code      = params.get('code');
    const stateBack = params.get('state');
    const error     = params.get('error');

    // لا يوجد callback في URL
    if (!code && !error) return false;

    // خطأ من Meta
    if (error) {
      const desc = params.get('error_description') || 'رفض المستخدم الأذونات';
      _setStatus('error', { errorMsg: desc });
      _cleanUrl();
      return true;
    }

    // التحقق من state لمنع CSRF
    const savedState = sessionStorage.getItem('oauth_state');
    if (stateBack && savedState && stateBack !== savedState) {
      _setStatus('error', { errorMsg: 'خطأ في التحقق من الأمان (state mismatch)' });
      _cleanUrl();
      return true;
    }

    // تنظيف URL فورًا
    _cleanUrl();
    sessionStorage.removeItem('oauth_state');

    // إرسال الـ code للـ Edge Function
    _setStatus('loading');
    await _exchangeCode(code);
    return true;
  }

  /**
   * إرسال code إلى Supabase Edge Function واستلام token
   * @param {string} code - Authorization code من Meta
   */
  async function _exchangeCode(code) {
    try {
      // ─── Supabase Integration Point ───────────────
      // عند الربط الفعلي مع Supabase، أضف:
      // const { data: { session } } = await supabase.auth.getSession();
      // const authHeader = `Bearer ${session.access_token}`;
      //
      // ثم أضف الـ headers أدناه:
      // headers: {
      //   'Content-Type': 'application/json',
      //   'Authorization': authHeader,  // ← Supabase Auth
      // }
      // ───────────────────────────────────────────────

      const response = await fetch(CONFIG.EXCHANGE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 'Authorization': `Bearer ${supabaseAccessToken}`, // TODO: Supabase auth
        },
        body: JSON.stringify({
          code:         code,
          redirect_uri: CONFIG.REDIRECT_URI,
        }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.message || `HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── Supabase DB Persistence Point ──────────
      // بعد استلام الـ token، احفظه في Supabase DB:
      // await supabase.from('whatsapp_connections').upsert({
      //   user_id: supabaseUserId,
      //   access_token: data.access_token,
      //   phone_number_id: data.phone_number_id,
      //   waba_id: data.waba_account_id,
      //   connected_at: new Date().toISOString(),
      // });
      // ────────────────────────────────────────────

      // تخزين مؤقت في localStorage
      localStorage.setItem(CONFIG.STORAGE_KEY_TOKEN,    data.access_token);
      localStorage.setItem(CONFIG.STORAGE_KEY_PHONE_ID, data.phone_number_id || '');
      localStorage.setItem(CONFIG.STORAGE_KEY_WABA_ID,  data.waba_account_id || '');
      localStorage.setItem(CONFIG.STORAGE_KEY_STATUS,   'connected');
      localStorage.setItem(CONFIG.STORAGE_KEY_TS,       new Date().toISOString());

      _setStatus('success', {
        accessToken: data.access_token,
        phoneId:     data.phone_number_id,
        wabaId:      data.waba_account_id,
        connectedAt: new Date().toISOString(),
      });

    } catch (err) {
      console.error('[OAuthService] Exchange failed:', err);
      _setStatus('error', { errorMsg: err.message || 'فشل في الاتصال مع الخادم' });
    }
  }

  /**
   * قراءة حالة الاتصال الحالية من localStorage
   */
  function getConnectionStatus() {
    return {
      isConnected:  localStorage.getItem(CONFIG.STORAGE_KEY_STATUS) === 'connected',
      accessToken:  localStorage.getItem(CONFIG.STORAGE_KEY_TOKEN),
      phoneId:      localStorage.getItem(CONFIG.STORAGE_KEY_PHONE_ID),
      wabaId:       localStorage.getItem(CONFIG.STORAGE_KEY_WABA_ID),
      connectedAt:  localStorage.getItem(CONFIG.STORAGE_KEY_TS),
    };
  }

  /**
   * قطع الاتصال ومسح البيانات
   */
  function disconnect() {
    localStorage.removeItem(CONFIG.STORAGE_KEY_TOKEN);
    localStorage.removeItem(CONFIG.STORAGE_KEY_PHONE_ID);
    localStorage.removeItem(CONFIG.STORAGE_KEY_WABA_ID);
    localStorage.removeItem(CONFIG.STORAGE_KEY_STATUS);
    localStorage.removeItem(CONFIG.STORAGE_KEY_TS);
    _setStatus('idle');

    // ─── Supabase Cleanup Point ───
    // await supabase.from('whatsapp_connections').delete().eq('user_id', userId);
  }

  function getState() { return { ..._state }; }

  function subscribe(fn) {
    _listeners.push(fn);
    return () => { _listeners = _listeners.filter(l => l !== fn); };
  }

  // ─── Private Helpers ─────────────────────────────────

  function _setStatus(status, extra = {}) {
    _state = { ..._state, status, ...extra };
    _listeners.forEach(fn => fn(_state));
  }

  function _generateState() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function _cleanUrl() {
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }

  // ─── Expose ──────────────────────────────────────────
  return {
    startOAuthFlow,
    handleCallback,
    getConnectionStatus,
    disconnect,
    getState,
    subscribe,
    CONFIG,
  };

})();

// Auto-handle callback on load
window.addEventListener('DOMContentLoaded', () => {
  OAuthService.handleCallback();
});
