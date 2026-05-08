/**
 * =====================================================
 * modules/whatsapp/supabase-integration.js
 * Supabase Integration Service for WhatsApp Module
 * منصة مدعوم - خدمة التكامل مع Supabase
 * =====================================================
 *
 * هذا الملف يتعامل مع:
 * 1. إنشاء اتصال Supabase آمن
 * 2. حفظ بيانات التكامل في جدول integrations
 * 3. جلب بيانات التكامل المحفوظة
 * 4. تحديث وحذف التكاملات
 * 5. إدارة الأخطاء والمصادقة
 */

import { SUPABASE_CONFIG, validateSupabaseConfig } from '../../supabase-config.js';

// ─── Supabase Client Initialization ───────────────────
let supabaseClient = null;

async function initializeSupabase() {
  if (supabaseClient) return supabaseClient;

  try {
    // التحقق من صحة الإعدادات
    validateSupabaseConfig(SUPABASE_CONFIG);

    // استيراد Supabase من CDN
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.38.0/+esm');

    // إنشاء العميل
    supabaseClient = createClient(
      SUPABASE_CONFIG.url,
      SUPABASE_CONFIG.anonKey
    );

    console.log('[WhatsApp Integration] Supabase client initialized');
    return supabaseClient;
  } catch (error) {
    console.error('[WhatsApp Integration] Failed to initialize Supabase:', error);
    throw error;
  }
}

// ─── Authentication Helpers ──────────────────────────

/**
 * الحصول على جلسة المستخدم الحالية
 */
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

/**
 * الحصول على معرف المستخدم الحالي
 */
async function getCurrentUserId() {
  const session = await getCurrentSession();
  return session?.user?.id || null;
}

// ─── Database Operations ─────────────────────────────

/**
 * حفظ بيانات التكامل في Supabase
 * @param {Object} integrationData - بيانات التكامل
 * @returns {Promise<Object>} - البيانات المحفوظة أو الخطأ
 */
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
          user_id: userId,
          provider: 'whatsapp',
          access_token: integrationData.access_token,
          token_type: integrationData.token_type || 'Bearer',
          expires_in: integrationData.expires_in,
          refresh_token: integrationData.refresh_token || null,
          scope: integrationData.scope || 'whatsapp_business_management,whatsapp_business_messaging',
          metadata: {
            phone_number_id: integrationData.phone_number_id,
            waba_account_id: integrationData.waba_account_id,
            business_account_id: integrationData.business_account_id,
            connected_at: new Date().toISOString(),
          },
        },
        {
          onConflict: 'user_id,provider', // تحديث إذا كان موجوداً
        }
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

/**
 * جلب بيانات التكامل المحفوظة
 * @returns {Promise<Object>} - بيانات التكامل أو null
 */
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
      console.error('[WhatsApp Integration] Fetch error:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('[WhatsApp Integration] Fetch failed:', error);
    return null;
  }
}

/**
 * تحديث بيانات التكامل
 * @param {Object} updates - البيانات المراد تحديثها
 * @returns {Promise<Object>} - النتيجة
 */
async function updateIntegration(updates) {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) {
      throw new Error('المستخدم غير مصرح.');
    }

    const { data, error } = await supabase
      .from('integrations')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('provider', 'whatsapp')
      .select()
      .single();

    if (error) {
      throw new Error(`فشل التحديث: ${error.message}`);
    }

    return { success: true, data };
  } catch (error) {
    console.error('[WhatsApp Integration] Update failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * حذف بيانات التكامل
 * @returns {Promise<Object>} - النتيجة
 */
async function deleteIntegration() {
  try {
    const supabase = await initializeSupabase();
    const userId = await getCurrentUserId();

    if (!userId) {
      throw new Error('المستخدم غير مصرح.');
    }

    const { error } = await supabase
      .from('integrations')
      .delete()
      .eq('user_id', userId)
      .eq('provider', 'whatsapp');

    if (error) {
      throw new Error(`فشل الحذف: ${error.message}`);
    }

    console.log('[WhatsApp Integration] Integration deleted successfully');
    return { success: true };
  } catch (error) {
    console.error('[WhatsApp Integration] Delete failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * جلب بيانات التكامل من localStorage (للاستخدام المؤقت)
 */
function getLocalIntegration() {
  try {
    const token = localStorage.getItem('mad3oom_wa_access_token');
    const phoneId = localStorage.getItem('mad3oom_wa_phone_id');
    const wabaId = localStorage.getItem('mad3oom_wa_waba_id');
    const connectedAt = localStorage.getItem('mad3oom_wa_connected_at');

    if (!token) return null;

    return {
      access_token: token,
      phone_number_id: phoneId,
      waba_account_id: wabaId,
      connected_at: connectedAt,
    };
  } catch (error) {
    console.error('[WhatsApp Integration] Local storage error:', error);
    return null;
  }
}

/**
 * حفظ بيانات التكامل في localStorage (للاستخدام المؤقت)
 */
function saveLocalIntegration(data) {
  try {
    localStorage.setItem('mad3oom_wa_access_token', data.access_token || '');
    localStorage.setItem('mad3oom_wa_phone_id', data.phone_number_id || '');
    localStorage.setItem('mad3oom_wa_waba_id', data.waba_account_id || '');
    localStorage.setItem('mad3oom_wa_connected_at', new Date().toISOString());
  } catch (error) {
    console.error('[WhatsApp Integration] Failed to save to local storage:', error);
  }
}

/**
 * مسح بيانات التكامل من localStorage
 */
function clearLocalIntegration() {
  try {
    localStorage.removeItem('mad3oom_wa_access_token');
    localStorage.removeItem('mad3oom_wa_phone_id');
    localStorage.removeItem('mad3oom_wa_waba_id');
    localStorage.removeItem('mad3oom_wa_connected_at');
    localStorage.removeItem('mad3oom_wa_status');
  } catch (error) {
    console.error('[WhatsApp Integration] Failed to clear local storage:', error);
  }
}

// ─── Export ──────────────────────────────────────────

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
};
