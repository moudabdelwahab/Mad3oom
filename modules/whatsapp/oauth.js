/**
 * =====================================================
 * modules/whatsapp/oauth.js
 * Meta WhatsApp OAuth Service
 * منصة مدعوم - خدمة التفويض
 * =====================================================
 */

import { SupabaseIntegration } from './supabase-integration.js';

const OAuthService = (() => {

  // ─── Configuration ───────────────────────────────────
  const CONFIG = {
    META_APP_ID:      '1510313544014876',
    REDIRECT_URI:     'https://mad3oom.online/modules/whatsapp/index.html',
    SCOPE:            'whatsapp_business_management,whatsapp_business_messaging',
    RESPONSE_TYPE:    'code',
    EXCHANGE_ENDPOINT: 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/exchange-token',
  };

  // ─── State ───────────────────────────────────────────
  let _state = {
    status:      'idle',
    accessToken: null,
    phoneId:     null,
    wabaId:      null,
    errorMsg:    null,
    connectedAt: null,
  };

  let _listeners = [];

  // ─── Public API ──────────────────────────────────────
  function startOAuthFlow() {
    _setStatus('loading');

    FB.login(
      function(response) {
        console.log('[OAuth] FB.login raw response:', response);
        console.log(
    "SESSION INFO:",
    response.authResponse?.sessionInfo
);

        if (response.authResponse) {
          const code = response.authResponse.code;
          
          let phoneId = null;
          let wabaId = null;

          try {
            // Meta غالباً ما ترجع sessionInfo كـ JSON string في Embedded Signup v3
            let sessionInfo = response.authResponse.sessionInfo;
            
            if (typeof sessionInfo === 'string') {
              sessionInfo = JSON.parse(sessionInfo);
            }

            if (sessionInfo) {
              console.log('[OAuth] Parsed sessionInfo:', sessionInfo);
              
              // 1. محاولة استخراج المعرفات المباشرة
              wabaId = sessionInfo.waba_id;
              phoneId = sessionInfo.phone_number_id;

              // 2. محاولة استخراج من المصفوفات (في حال وجود عدة أرقام)
              if (!wabaId && sessionInfo.waba_ids && sessionInfo.waba_ids.length > 0) {
                wabaId = sessionInfo.waba_ids[0];
              }
              if (!phoneId && sessionInfo.phone_number_ids && sessionInfo.phone_number_ids.length > 0) {
                phoneId = sessionInfo.phone_number_ids[0];
              }
            }
          } catch (e) {
            console.error('[OAuth] Error parsing sessionInfo:', e);
          }

          console.log('[OAuth] Final extracted IDs to send:', { phoneId, wabaId });

          _exchangeCode(code, { phoneId, wabaId })
            .catch(error => {
              console.error('[OAuth] Exchange process failed:', error);
              _setStatus('error', { errorMsg: error.message });
            });

        } else {
          _setStatus('error', { errorMsg: 'تم إلغاء عملية الربط أو فشل التفويض من Meta' });
        }
      },
      {
        config_id: '2268694463535485',
        response_type: 'code',
        override_default_response_type: true,
        // إزالة redirect_uri من هنا قد يساعد في استقرار الـ callback في بعض المتصفحات
        extras: {
          setup: {},
          version: "v4",
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3"
        }
      }
    );
  }

  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');

    if (!code && !error) return false;

    if (error) {
      const desc = params.get('error_description') || 'رفض المستخدم الأذونات';
      _setStatus('error', { errorMsg: desc });
      _cleanUrl();
      return true;
    }

    _cleanUrl();
    _setStatus('loading');
    
    try {
      // في حالة الـ redirect callback المباشر، لا نملك sessionInfo
      await _exchangeCode(code);
    } catch (error) {
      console.error('[OAuthService] Error during code exchange:', error);
    }
    return true;
  }

  async function _exchangeCode(code, providedIds = {}) {
    try {
      const session = await SupabaseIntegration.getCurrentSession();
      const authHeader = session?.access_token ? `Bearer ${session.access_token}` : undefined;

      console.log('[OAuth] Sending to exchange endpoint:', { 
        hasCode: !!code, 
        phoneId: providedIds.phoneId, 
        wabaId: providedIds.wabaId 
      });

      const response = await fetch(CONFIG.EXCHANGE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader && { 'Authorization': authHeader }),
        },
        body: JSON.stringify({
          code,
          redirect_uri: CONFIG.REDIRECT_URI,
          phone_number_id: providedIds.phoneId,
          waba_account_id: providedIds.wabaId
        })
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error?.message || errBody.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log('[OAuth] Exchange successful, received data:', data);

      if (session?.user?.id) {
        await SupabaseIntegration.saveIntegration({
          access_token: data.access_token,
          token_type: data.token_type || 'Bearer',
          expires_in: data.expires_in,
          phone_number_id: data.phone_number_id,
          waba_account_id: data.waba_account_id,
          phone_number:    data.phone_number,
          business_account_id: data.business_account_id,
        });
      }

      SupabaseIntegration.saveLocalIntegration({
        phone_number_id: data.phone_number_id,
        waba_account_id: data.waba_account_id,
        phone_number:    data.phone_number,
        connected_at:    new Date().toISOString()
      }, data.access_token);

      _setStatus('success', {
        accessToken: data.access_token,
        phoneId:     data.phone_number_id,
        wabaId:      data.waba_account_id,
        connectedAt: new Date().toISOString(),
      });

    } catch (err) {
      console.error('[OAuthService] _exchangeCode error:', err);
      _setStatus('error', { errorMsg: err.message || 'فشل في تبادل الرموز مع الخادم' });
      throw err;
    }
  }

  async function getConnectionStatus() {
    const supabaseData = await SupabaseIntegration.getIntegration();
    if (supabaseData) {
      return {
        isConnected:  true,
        accessToken:  supabaseData.access_token,
        phoneId:      supabaseData.metadata?.phone_number_id,
        phoneNumber:  supabaseData.metadata?.phone_number,
        wabaId:       supabaseData.metadata?.waba_account_id,
        connectedAt:  supabaseData.metadata?.connected_at,
        source:       'supabase',
      };
    }

    const localData = SupabaseIntegration.getLocalIntegration();
    return {
      isConnected:  !!localData,
      accessToken:  localData?.access_token,
      phoneId:      localData?.phone_number_id,
      phoneNumber:  localData?.phone_number,
      wabaId:       localData?.waba_account_id,
      connectedAt:  localData?.connected_at,
      source:       'localStorage',
    };
  }
  
  async function disconnect() {
    await SupabaseIntegration.deleteIntegration();
    SupabaseIntegration.clearLocalIntegration();
    _setStatus('idle');
  }

  function getState() { return { ..._state }; }

  function subscribe(fn) {
    _listeners.push(fn);
    return () => { _listeners = _listeners.filter(l => l !== fn); };
  }

  function _setStatus(status, extra = {}) {
    _state = { ..._state, status, ...extra };
    _listeners.forEach(fn => fn(_state));
  }

  function _cleanUrl() {
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }

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

if (typeof window !== 'undefined') {
  window.OAuthService = OAuthService;
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    OAuthService.handleCallback();
  });
}

export { OAuthService };
