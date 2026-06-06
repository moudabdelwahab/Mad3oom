import { SupabaseIntegration } from '../supabase-integration.js';

const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function getConnection() {
  const integration = await SupabaseIntegration.getIntegration();
  const local = SupabaseIntegration.getLocalIntegration();
  const source = integration || local;
  const metadata = integration?.metadata || local || {};
  const accessToken = source?.access_token;
  const phoneNumberId = metadata.phone_number_id || source?.phone_number_id;

  if (!accessToken || !phoneNumberId) {
    throw new Error('يرجى ربط رقم WhatsApp Business قبل الإرسال.');
  }

  return { accessToken, phoneNumberId };
}

async function graphFetch(path, options = {}) {
  const { accessToken } = await getConnection();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${GRAPH_BASE}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || payload.message || `Graph API HTTP ${response.status}`);
  }
  return payload;
}

function buildMediaMessage(type, mediaId, caption, fileName) {
  const media = { id: mediaId };
  if (caption && ['image', 'video', 'document'].includes(type)) media.caption = caption;
  if (fileName && type === 'document') media.filename = fileName;
  return { type, [type]: media };
}

export class WhatsAppAPI {
  static async sendText({ to, text }) {
    const { phoneNumberId } = await getConnection();
    return graphFetch(`/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: true, body: text },
      }),
    });
  }

  static async uploadMedia(file) {
    const { phoneNumberId } = await getConnection();
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', file, file.name || 'upload');
    return graphFetch(`/${phoneNumberId}/media`, { method: 'POST', body: formData });
  }

  static async sendMedia({ to, type, mediaId, caption = '', fileName = '' }) {
    const { phoneNumberId } = await getConnection();
    return graphFetch(`/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        ...buildMediaMessage(type, mediaId, caption, fileName),
      }),
    });
  }

  static async getTemplates() {
    const integration = await SupabaseIntegration.getIntegration();
    const wabaId = integration?.metadata?.waba_account_id;
    if (!wabaId) throw new Error('WABA Account ID not found.');
    return graphFetch(`/${wabaId}/message_templates`);
  }

  static async createTemplate(templateData) {
    const integration = await SupabaseIntegration.getIntegration();
    const wabaId = integration?.metadata?.waba_account_id;
    if (!wabaId) throw new Error('WABA Account ID not found. يرجى التأكد من ربط حساب WhatsApp Business بشكل صحيح.');
    
    // Ensure data format is correct for Meta API
    const payload = {
      name: templateData.name,
      category: templateData.category,
      language: templateData.language,
      components: templateData.components
    };

    return graphFetch(`/${wabaId}/message_templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  static async deleteTemplate(templateName) {
    const integration = await SupabaseIntegration.getIntegration();
    const wabaId = integration?.metadata?.waba_account_id;
    if (!wabaId) throw new Error('WABA Account ID not found.');
    return graphFetch(`/${wabaId}/message_templates?name=${templateName}`, {
      method: 'DELETE',
    });
  }

  static async getBillingStatus() {
    const integration = await SupabaseIntegration.getIntegration();
    const wabaId = integration?.metadata?.waba_account_id;
    if (!wabaId) throw new Error('WABA Account ID not found.');
    // Check billing info from Meta Business API
    // Updated fields for Meta Graph API v25.0 - billing_event_type is removed/deprecated in some contexts
    return graphFetch(`/${wabaId}?fields=currency,message_template_namespace`);
  }

  static async updateBusinessProfile(profileData) {
    const { phoneNumberId } = await getConnection();
    return graphFetch(`/${phoneNumberId}/whatsapp_business_profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...profileData
      }),
    });
  }

  static async sendTemplate({ to, templateName, languageCode, components = [] }) {
    const { phoneNumberId } = await getConnection();
    return graphFetch(`/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components
        }
      }),
    });
  }

  static async verifyContacts(contacts) {
    const { phoneNumberId } = await getConnection();
    // Meta API for contact verification
    return graphFetch(`/${phoneNumberId}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocking: 'wait',
        contacts,
        force_check: true
      }),
    });
  }

  static async checkTemplateEligibility(phoneNumbers) {
    try {
      const supabase = await SupabaseIntegration.initializeSupabase();
      
      // Call the Supabase Edge Function using the client to handle CORS and Auth automatically
      const { data, error } = await supabase.functions.invoke('check-template-eligibility', {
        body: { phone_numbers: phoneNumbers }
      });

      if (error) {
        console.error('[WhatsAppAPI] Eligibility check error:', error);
        throw new Error(error.message || 'فشل التحقق من الأهلية');
      }

      return data;
    } catch (error) {
      console.error('[WhatsAppAPI] Eligibility check failed:', error);
      throw error;
    }
  }
}
