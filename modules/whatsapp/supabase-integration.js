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
      supabaseClient = createClient(
  SUPABASE_CONFIG.url,
  SUPABASE_CONFIG.anonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      storage: window.localStorage
    }
  }
);
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
      if (error.status !== 401 && error.status !== 403) {
        console.error('[WhatsApp Integration] Session error:', error);
      }
      return null;
    }
    return session;
  } catch (error) {
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

    // Check if this specific phone number already exists for this user to avoid duplicates
    const { data: existing } = await supabase
      .from('integrations')
      .select('id, metadata')
      .eq('user_id', userId)
      .eq('provider', 'whatsapp');

    const existingIntegration = existing?.find(i => i.metadata?.phone_number_id === integrationData.phone_number_id);
const payload = {
  user_id:      userId,
  provider:     'whatsapp',
  phone:        integrationData.phone_number,

  access_token: integrationData.access_token,
  token_type:   integrationData.token_type || 'Bearer',
  expires_in:   integrationData.expires_in,

  metadata: {
    phone_number_id:     integrationData.phone_number_id,
    phone_number:        integrationData.phone_number,
    waba_account_id:     integrationData.waba_account_id,
    business_account_id: integrationData.business_account_id,
    connected_at:        new Date().toISOString(),
  },
};

    let result;
    if (existingIntegration) {
      result = await supabase
        .from('integrations')
        .update(payload)
        .eq('id', existingIntegration.id)
        .select()
        .single();
    } else {
      result = await supabase
        .from('integrations')
        .insert(payload)
        .select()
        .single();
    }

    if (result.error) {
      console.error('[WhatsApp Integration] Database error:', result.error);
      throw new Error(`فشل حفظ البيانات: ${result.error.message}`);
    }

    console.log('[WhatsApp Integration] Integration saved successfully:', result.data);
    
    // Update local storage for the currently active/selected connection
    saveLocalIntegration(result.data.metadata, result.data.access_token);
    
    return { success: true, data: result.data };
  } catch (error) {
    console.error('[WhatsApp Integration] Save failed:', error);
    return { success: false, error: error.message };
  }
}

async function getIntegration(phoneId = null) {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) return null;

    let query = supabase
      .from('integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'whatsapp');

    const { data, error } = await query;

    if (error) {
      console.error('[WhatsApp Integration] Fetch error:', error);
      return null;
    }

    if (!data || data.length === 0) return null;

    // If a specific phone ID is requested
    if (phoneId) {
      return data.find(i => i.metadata?.phone_number_id === phoneId) || null;
    }

    // Default: use the one from localStorage if it exists and is valid
    const localPhoneId = localStorage.getItem('mad3oom_wa_phone_id');
    if (localPhoneId) {
      const preferred = data.find(i => i.metadata?.phone_number_id === localPhoneId);
      if (preferred) return preferred;
    }

    // Fallback to the first one
    return data[0];
  } catch (error) {
    console.error('[WhatsApp Integration] Fetch failed:', error);
    return null;
  }
}

async function getAllIntegrations() {
  return getWhatsAppChannels();
}

async function updateIntegration(updates, phoneId = null) {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) throw new Error('المستخدم غير مصرح.');

    const target = await getIntegration(phoneId);
    if (!target) throw new Error('لم يتم العثور على الربط المطلوب.');

    const { data, error } = await supabase
      .from('integrations')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', target.id)
      .select()
      .single();

    if (error) throw new Error(`فشل التحديث: ${error.message}`);

    return { success: true, data };
  } catch (error) {
    console.error('[WhatsApp Integration] Update failed:', error);
    return { success: false, error: error.message };
  }
}

async function deleteIntegration(phoneId = null) {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) throw new Error('المستخدم غير مصرح.');

    const target = await getIntegration(phoneId);
    if (!target) throw new Error('لم يتم العثور على الربط المطلوب.');

    const { error } = await supabase
      .from('integrations')
      .delete()
      .eq('id', target.id);

    if (error) throw new Error(`فشل الحذف: ${error.message}`);

    // If we deleted the one currently in localStorage, clear it
    if (localStorage.getItem('mad3oom_wa_phone_id') === target.metadata?.phone_number_id) {
      clearLocalIntegration();
    }

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
      phone_number:    localStorage.getItem('mad3oom_wa_phone_number'), 
      connected_at:    localStorage.getItem('mad3oom_wa_connected_at'),
    };
  } catch (error) {
    console.error('[WhatsApp Integration] Local storage error:', error);
    return null;
  }
}

function saveLocalIntegration(metadata, accessToken) {
  try {
    localStorage.setItem('mad3oom_wa_access_token', accessToken || '');
    localStorage.setItem('mad3oom_wa_phone_id',     metadata.phone_number_id || '');
    localStorage.setItem('mad3oom_wa_waba_id',      metadata.waba_account_id || '');
    localStorage.setItem('mad3oom_wa_phone_number', metadata.phone_number    || '');
    localStorage.setItem('mad3oom_wa_connected_at', metadata.connected_at || new Date().toISOString());
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

async function getDashboardStats(phoneId = null) {
  try {
    const integration = await getIntegration(phoneId);
    if (!integration) return null;

    const accessToken = integration.access_token;
    const targetPhoneId = phoneId || integration.metadata?.phone_number_id;

    if (!accessToken || !targetPhoneId) return null;

    const phoneResponse = await fetch(
      `https://graph.facebook.com/v25.0/${targetPhoneId}?fields=display_phone_number,verified_name,quality_rating,account_mode,messaging_limit_tier,status,code_verification_status&access_token=${accessToken}`
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
      limitTier:     phoneData.messaging_limit_tier || '—',
      status:        phoneData.status               || '—',
      verification:  phoneData.code_verification_status || '—',
      wabaId:        integration.metadata?.waba_account_id || '—'
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
  getAllIntegrations,
  updateIntegration,
  deleteIntegration,
  getLocalIntegration,
  saveLocalIntegration,
  clearLocalIntegration,
  getDashboardStats,
  getWhatsAppChannels,
  async checkConversationWindow(phone) {
    try {
      const supabase = await initializeSupabase();
      const userId = await getCurrentUserId();
      if (!userId) return null;

      // Ensure phone number is clean (digits only)
      const cleanPhone = String(phone).replace(/\D/g, '');
      if (!cleanPhone) return { isOpen: false };

      // In the database, the column is 'last_interaction' based on ActivityFeedPage.js
      // We'll also check for 'last_inbound_message_at' just in case, but using last_interaction for 24h window
      const { data, error } = await supabase
        .from('bot_user_states')
        .select('*')
        .eq('user_id', userId)
        .eq('phone_number', cleanPhone)
        .maybeSingle();

      if (error) {
        console.error('[WhatsApp Integration] Window check error:', error);
        return null;
      }

      // Use last_inbound_message_at if available, otherwise last_interaction
      const lastInteractionTime = data?.last_inbound_message_at || data?.last_interaction;
      if (!lastInteractionTime) return { isOpen: false };

      const lastInbound = new Date(lastInteractionTime);
      const now = new Date();
      const diffHours = (now - lastInbound) / (1000 * 60 * 60);

      return {
        isOpen: diffHours < 24,
        lastInboundAt: data.last_inbound_message_at,
        hoursRemaining: Math.max(0, 24 - diffHours)
      };
    } catch (error) {
      console.error('[WhatsApp Integration] Window check failed:', error);
      return null;
    }
  }
};
