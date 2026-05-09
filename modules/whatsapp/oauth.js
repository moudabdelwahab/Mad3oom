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
    REDIRECT_URI:     window.location.origin + '/modules/whatsapp/index.html',
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

      console.log('Embedded Signup Response:', response);

      if (response.authResponse) {

        const code = response.authResponse.code;

        console.log('Authorization Code:', code);

_exchangeCode(code)
  .catch(error => {

    console.error(error);

    _setStatus('error', {
      errorMsg: error.message
    });

  });


      } else {

        _setStatus('error', {
          errorMsg: 'تم إلغاء عملية الربط'
        });

      }

    },
    {
      config_id: '2268694463535485',

      response_type: 'code',

      override_default_response_type: true,
redirect_uri: window.location.origin + '/modules/whatsapp/index.html',
      extras: {
        version: 'v4'
      }
    }
  );

}

  
  async function handleCallback() {
    const params    = new URLSearchParams(window.location.search);
    const code      = params.get('code');
    const stateBack = params.get('state');
    const error     = params.get('error');

    if (!code && !error) return false;

    if (error) {
      const desc = params.get('error_description') || 'رفض المستخدم الأذونات';
      _setStatus('error', { errorMsg: desc });
      _cleanUrl();
      return true;
    }

    const savedState = sessionStorage.getItem('oauth_state');
    if (stateBack && savedState && stateBack !== savedState) {
      _setStatus('error', { errorMsg: 'خطأ في التحقق من الأمان (state mismatch)' });
      _cleanUrl();
      return true;
    }

    _cleanUrl();
    sessionStorage.removeItem('oauth_state');

    _setStatus('loading');
    try {
      await _exchangeCode(code);
    } catch (error) {
      console.error('[OAuthService] Error during code exchange:', error);
    }
    return true;
  }

  async function _exchangeCode(code) {
    try {
      const session = await SupabaseIntegration.getCurrentSession();
      const authHeader = session?.access_token ? `Bearer ${session.access_token}` : undefined;

      const response = await fetch(CONFIG.EXCHANGE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader && { 'Authorization': authHeader }),
        },
body: JSON.stringify({
  code,
  redirect_uri: window.location.origin + '/modules/whatsapp/index.html'
})

,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
console.error(
  'Exchange Error Body:',
  errBody
);

throw new Error(
  errBody.error?.message ||
  errBody.message ||
  `HTTP ${response.status}`
);

      }

      const data = await response.json();

      if (session?.user?.id) {
        await SupabaseIntegration.saveIntegration({
          access_token: data.access_token,
          token_type: data.token_type || 'Bearer',
          expires_in: data.expires_in,
          refresh_token: data.refresh_token,
          phone_number_id: data.phone_number_id,
          waba_account_id: data.waba_account_id,
          business_account_id: data.business_account_id,
        });
      }

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

  async function getConnectionStatus() {
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


// Export for global access
if (typeof window !== 'undefined') {
  window.OAuthService = OAuthService;
}

// Auto-handle callback on load
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    OAuthService.handleCallback();
  });
}

// Make service globally available
window.OAuthService = OAuthService;
// ES6 Export
export { OAuthService };
