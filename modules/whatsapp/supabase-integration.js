/**
 * =====================================================
 * modules/whatsapp/supabase-integration.js
 * Supabase Integration Service for WhatsApp Module
 * منصة مدعوم - خدمة التكامل مع Supabase
 * =====================================================
 */

import { SUPABASE_CONFIG, validateSupabaseConfig } from '../../supabase-config.js';

// ─── Supabase Client Initialization ───────────────────
let supabaseClient = null;
let initPromise = null;

// ─── 1. initializeSupabase ────────────────────────────
async function initializeSupabase() {
  if (supabaseClient) return supabaseClient;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      validateSupabaseConfig(SUPABASE_CONFIG);
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.38.0/+esm');
      supabaseClient = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
      console.log('[WhatsApp Integration] Supabase client initialized');
      return supabaseClient;
    } catch (error) {
      console.error('[WhatsApp Integration] Failed to initialize Supabase:', error);
      initPromise = null;
      throw error;
    }
  })();

  return initPromise;
}

// ─── 2. Authentication Helpers ────────────────────────

async function getCurrentSession() {
  try {
    const supabase = await initializeSupabase();
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
      console.error('[WhatsApp Integration] Failed to get session:', error);
      return null;
    }
    return session;
  } catch (error) {
    console.error('[WhatsApp Integration] Session error:', error);
    return null;
  }
}

async function getCurrentUserId() {
  const session = await getCurrentSession();
  return session?.user?.id || null;
}

// ─── 3. Database Operations ───────────────────────────

async function saveIntegration(integrationData) {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) {
      throw new Error('المستخدم غير مصرح. يرجى تسجيل الدخول أولاً.');
    }

    const { data, error } = await supabase
      .from('integrations')
      .upsert(
        {
          user_id:      userId,
          provider:     'whatsapp',
          access_token: integrationData.access_token,
          token_type:   integrationData.token_type || 'Bearer',
          expires_in:   integrationData.expires_in,
          metadata: {
            phone_number_id:     integrationData.phone_number_id,
            waba_account_id:     integrationData.waba_account_id,
            business_account_id: integrationData.business_account_id,
            connected_at:        new Date().toISOString(),
          },
        },
        { onConflict: 'user_id,provider' }
      )
      .select()
      .single();

    if (error) {
      console.error('[WhatsApp Integration] Database error:', error);
      throw new Error(`فشل حفظ البيانات: ${error.message}`);
    }

    console.log('[WhatsApp Integration] Integration saved successfully:', data);
    return { success: true, data };
  } catch (error) {
    console.error('[WhatsApp Integration] Save failed:', error);
    return { success: false, error: error.message };
  }
}

async function getIntegration() {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) {
      console.warn('[WhatsApp Integration] No user session found');
      return null;
    }

    const { data, error } = await supabase
      .from('integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'whatsapp')
      .maybeSingle();

    if (error) {
      if (error.code === 'PGRST116' || error.status === 404) {
        console.warn('[WhatsApp Integration] Integration table not found or empty');
        return null;
      }
      console.error('[WhatsApp Integration] Fetch error:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('[WhatsApp Integration] Fetch failed:', error);
    return null;
  }
}

async function updateIntegration(updates) {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) throw new Error('المستخدم غير مصرح.');

    const { data, error } = await supabase
      .from('integrations')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('provider', 'whatsapp')
      .select()
      .single();

    if (error) throw new Error(`فشل التحديث: ${error.message}`);

    return { success: true, data };
  } catch (error) {
    console.error('[WhatsApp Integration] Update failed:', error);
    return { success: false, error: error.message };
  }
}

async function deleteIntegration() {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) throw new Error('المستخدم غير مصرح.');

    const { error } = await supabase
      .from('integrations')
      .delete()
      .eq('user_id', userId)
      .eq('provider', 'whatsapp');

    if (error) throw new Error(`فشل الحذف: ${error.message}`);

    console.log('[WhatsApp Integration] Integration deleted successfully');
    return { success: true };
  } catch (error) {
    console.error('[WhatsApp Integration] Delete failed:', error);
    return { success: false, error: error.message };
  }
}

// ─── 4. LocalStorage Helpers ─────────────────────────

function getLocalIntegration() {
  try {
    const token = localStorage.getItem('mad3oom_wa_access_token');
    if (!token) return null;
    return {
      access_token:    token,
      phone_number_id: localStorage.getItem('mad3oom_wa_phone_id'),
      waba_account_id: localStorage.getItem('mad3oom_wa_waba_id'),
      connected_at:    localStorage.getItem('mad3oom_wa_connected_at'),
    };
  } catch (error) {
    console.error('[WhatsApp Integration] Local storage error:', error);
    return null;
  }
}

function saveLocalIntegration(data) {
  try {
    localStorage.setItem('mad3oom_wa_access_token', data.access_token    || '');
    localStorage.setItem('mad3oom_wa_phone_id',     data.phone_number_id || '');
    localStorage.setItem('mad3oom_wa_waba_id',      data.waba_account_id || '');
    localStorage.setItem('mad3oom_wa_connected_at', new Date().toISOString());
  } catch (error) {
    console.error('[WhatsApp Integration] Failed to save to local storage:', error);
  }
}

function clearLocalIntegration() {
  try {
    ['mad3oom_wa_access_token', 'mad3oom_wa_phone_id',
     'mad3oom_wa_waba_id', 'mad3oom_wa_connected_at',
     'mad3oom_wa_status'].forEach(k => localStorage.removeItem(k));
  } catch (error) {
    console.error('[WhatsApp Integration] Failed to clear local storage:', error);
  }
}

// ─── 5. Dashboard & Channels ─────────────────────────

async function getDashboardStats() {
  try {
    const integration = await getIntegration();
    if (!integration) return null;

    const accessToken = integration.access_token;
    const phoneId     = integration.metadata?.phone_number_id;

    if (!accessToken || !phoneId) return null;

    const phoneResponse = await fetch(
      `https://graph.facebook.com/v25.0/${phoneId}?fields=display_phone_number,verified_name,quality_rating,account_mode&access_token=${accessToken}`
    );
    const phoneData = await phoneResponse.json();

    if (phoneData.error) {
      console.error('[WhatsApp Integration] Meta API error:', phoneData.error);
      return null;
    }

    return {
      phoneNumber:   phoneData.display_phone_number || '—',
      verifiedName:  phoneData.verified_name        || '—',
      qualityRating: phoneData.quality_rating       || '—',
      accountMode:   phoneData.account_mode         || '—',
    };
  } catch (error) {
    console.error('[WhatsApp Integration] getDashboardStats failed:', error);
    return null;
  }
}

async function getWhatsAppChannels() {
  try {
    const supabase = await initializeSupabase();
    const userId   = await getCurrentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'whatsapp');

    if (error) {
      console.error('[WhatsApp Integration] getWhatsAppChannels error:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('[WhatsApp Integration] getWhatsAppChannels failed:', error);
    return [];
  }
}

// ─── Export ───────────────────────────────────────────

export const SupabaseIntegration = {
  initializeSupabase,
  getCurrentSession,
  getCurrentUserId,
  saveIntegration,
  getIntegration,
  updateIntegration,
  deleteIntegration,
  getLocalIntegration,
  saveLocalIntegration,
  clearLocalIntegration,
  getDashboardStats,
  getWhatsAppChannels,
};
