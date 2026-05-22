/**
 * modules/whatsapp/services/whatsapp-reports.js
 * خدمة إدارة تقارير حملات الواتساب - منصة مدعوم
 */

import { SupabaseIntegration } from '../supabase-integration.js';

export const WhatsAppReports = {
    /**
     * حفظ حملة جديدة مع تقاريرها
     */
    async saveCampaign(campaignData, reports) {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const userId = await SupabaseIntegration.getCurrentUserId();

            if (!userId) throw new Error('User not authenticated');

            // 1. إدراج الحملة
            const { data: campaign, error: cError } = await supabase
                .from('whatsapp_campaigns')
                .insert({
                    user_id: userId,
                    name: campaignData.name || `حملة ${new Date().toLocaleString('ar-EG')}`,
                    template_name: campaignData.templateName,
                    language_code: campaignData.languageCode,
                    total_recipients: reports.length,
                    success_count: reports.filter(r => r.status === 'success').length,
                    fail_count: reports.filter(r => r.status === 'failed').length,
                    status: 'completed'
                })
                .select()
                .single();

            if (cError) throw cError;

            // 2. إدراج التقارير
            const reportsToInsert = reports.map(r => ({
                campaign_id: campaign.id,
                recipient: r.recipient,
                status: r.status,
                error_message: r.error || null,
                metadata: r.metadata || {}
            }));

            const { error: rError } = await supabase
                .from('whatsapp_campaign_reports')
                .insert(reportsToInsert);

            if (rError) throw rError;

            return { success: true, campaignId: campaign.id };
        } catch (error) {
            console.error('[WhatsAppReports] Save error:', error);
            return { success: false, error: error.message };
        }
    },

    /**
     * جلب جميع الحملات للمستخدم الحالي
     */
    async getCampaigns() {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { data, error } = await supabase
                .from('whatsapp_campaigns')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return data;
        } catch (error) {
            console.error('[WhatsAppReports] Fetch campaigns error:', error);
            return [];
        }
    },

    /**
     * جلب تفاصيل حملة معينة مع تقاريرها
     */
    async getCampaignDetails(campaignId) {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            
            const { data: campaign, error: cError } = await supabase
                .from('whatsapp_campaigns')
                .select('*')
                .eq('id', campaignId)
                .single();

            if (cError) throw cError;

            const { data: reports, error: rError } = await supabase
                .from('whatsapp_campaign_reports')
                .select('*')
                .eq('campaign_id', campaignId);

            if (rError) throw rError;

            return { ...campaign, reports };
        } catch (error) {
            console.error('[WhatsAppReports] Fetch details error:', error);
            return null;
        }
    }
};
