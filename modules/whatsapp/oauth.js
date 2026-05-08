/**
 * =====================================================
 * modules/whatsapp/oauth.js
 * Meta WhatsApp OAuth Service
 * منصة مدعوم - خدمة التفويض
 * =====================================================
 *
 * هذا الملف يتعامل مع:
 * 1. بناء رابط OAuth لـ Meta
 * 2. استخراج authorization code من URL
 * 3. إرسال الـ code إلى Supabase Edge Function
 * 4. تخزين النتائج في Supabase وlocalStorage
 */

import { SupabaseIntegration } from './supabase-integration.js';

const OAuthService = (() => {

  // ─── Configuration ───────────────────────────────────
  const CONFIG = {
    META_APP_ID:      'YOUR_META_APP_ID',           // App ID من Meta for Developers
    REDIRECT_URI:     window.location.origin + '/', // Redirect URI مسجّل في Meta App
    SCOPE:            'whatsapp_business_management,whatsapp_business_messaging',
    RESPONSE_TYPE:    'code',

    // ─── Supabase Edge Function Endpoint ───
    // يجب أن يكون الـ endpoint جاهزاً بالفعل
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
      // الحصول على جلسة المستخدم
      const session = await SupabaseIntegration.getCurrentSession();
      const authHeader = session?.access_token 
        ? `Bearer ${session.access_token}` 
        : undefined;

      // إنشاء رابط Edge Function الكامل
      const baseUrl = new URL(CONFIG.EXCHANGE_ENDPOINT, window.location.origin).toString();

      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader && { 'Authorization': authHeader }),
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

      // حفظ البيانات في Supabase
      if (session?.user?.id) {
        const saveResult = await SupabaseIntegration.saveIntegration({
          access_token: data.access_token,
          token_type: data.token_type || 'Bearer',
          expires_in: data.expires_in,
          refresh_token: data.refresh_token,
          phone_number_id: data.phone_number_id,
          waba_account_id: data.waba_account_id,
          business_account_id: data.business_account_id,
        });

        if (!saveResult.success) {
          console.warn('[OAuthService] Failed to save to Supabase:', saveResult.error);
        }
      }

      // تخزين مؤقت في localStorage
      SupabaseIntegration.saveLocalIntegration({
        access_token: data.access_token,
        phone_number_id: data.phone_number_id,
        waba_account_id: data.waba_account_id,
      });

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
   * قراءة حالة الاتصال الحالية من localStorage و Supabase
   */
  async function getConnectionStatus() {
    // محاولة جلب البيانات من Supabase أولاً
    const supabaseData = await SupabaseIntegration.getIntegration();
    
    if (supabaseData) {
      return {
        isConnected:  true,
        accessToken:  supabaseData.access_token,
        phoneId:      supabaseData.metadata?.phone_number_id,
        wabaId:       supabaseData.metadata?.waba_account_id,
        connectedAt:  supabaseData.metadata?.connected_at,
        source:       'supabase',
      };
    }

    // الرجوع إلى localStorage كبديل
    const localData = SupabaseIntegration.getLocalIntegration();
    return {
      isConnected:  !!localData,
      accessToken:  localData?.access_token,
      phoneId:      localData?.phone_number_id,
      wabaId:       localData?.waba_account_id,
      connectedAt:  localData?.connected_at,
      source:       'localStorage',
    };
  }

  /**
   * قطع الاتصال ومسح البيانات
   */
  async function disconnect() {
    // حذف من Supabase
    const deleteResult = await SupabaseIntegration.deleteIntegration();
    if (!deleteResult.success) {
      console.warn('[OAuthService] Failed to delete from Supabase:', deleteResult.error);
    }

    // مسح localStorage
    SupabaseIntegration.clearLocalIntegration();
    
    _setStatus('idle');
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
