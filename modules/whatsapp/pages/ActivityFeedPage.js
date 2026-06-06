/**
 * =====================================================
 * modules/whatsapp/pages/ActivityFeedPage.js
 * Activity Feed Management - Real-time activities from Supabase
 * منصة مدعوم - إدارة تغذية الأنشطة
 * =====================================================
 */

import { SupabaseIntegration } from '../supabase-integration.js';

export class ActivityFeedPage {
  constructor(container) {
    this.container = container;
    this.activities = [];
    this.maxActivities = 10;
  }

  /**
   * Load activities from Supabase
   * جلب الأنشطة من Supabase
   */
  async load() {
    try {
      this.activities = await this.fetchActivities();
      this.render();
    } catch (error) {
      console.error('[ActivityFeedPage] Error loading activities:', error);
      this.renderError(error.message);
    }
  }

  /**
   * Fetch activities from multiple sources in Supabase
   * جلب الأنشطة من مصادر متعددة
   */
  async fetchActivities() {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const userId = await SupabaseIntegration.getCurrentUserId();

    if (!userId) return [];

    const activities = [];

    try {
      // 1. Fetch recent messages (sent and received)
      const { data: messages, error: msgError } = await supabase
        .from('messages')
        .select('*')
        .eq('user_id', userId)
        .order('timestamp', { ascending: false })
        .limit(20);

      if (!msgError && messages) {
        messages.forEach(msg => {
          activities.push({
            id: `msg-${msg.id}`,
            type: 'message',
            title: msg.direction === 'outbound' ? 'رسالة مُرسلة' : 'رسالة واردة',
            description: msg.message_text || '(بدون نص)',
            phone: msg.direction === 'outbound' ? msg.to_number : msg.from_number,
            status: msg.status || msg.delivery_status,
            timestamp: msg.timestamp,
            icon: msg.direction === 'outbound' ? 'send' : 'receive',
            color: msg.status === 'delivered' || msg.status === 'read' ? 'green' : 
                   msg.status === 'failed' ? 'red' : 
                   msg.status === 'pending' ? 'orange' : 'blue',
            metadata: {
              messageType: msg.message_type,
              waMessageId: msg.wa_message_id,
              direction: msg.direction
            }
          });
        });
      }

      // 2. Fetch bot settings changes (template approvals, etc.)
      const { data: botSettings, error: botError } = await supabase
        .from('bot_settings')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(10);

      if (!botError && botSettings) {
        botSettings.forEach(setting => {
          if (setting.updated_at) {
            activities.push({
              id: `bot-${setting.id}`,
              type: 'bot_setting',
              title: 'تحديث إعدادات البوت',
              description: `تم تحديث: ${setting.setting_name || 'إعداد'}`,
              status: 'completed',
              timestamp: setting.updated_at,
              icon: 'settings',
              color: 'blue',
              metadata: {
                settingName: setting.setting_name,
                settingValue: setting.setting_value
              }
            });
          }
        });
      }

      // 3. Fetch campaign activities
      const { data: campaigns, error: campError } = await supabase
        .from('whatsapp_campaigns')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!campError && campaigns) {
        campaigns.forEach(campaign => {
          activities.push({
            id: `camp-${campaign.id}`,
            type: 'campaign',
            title: 'حملة واتساب',
            description: `${campaign.name} - ${campaign.total_recipients} مستقبل`,
            status: campaign.status,
            timestamp: campaign.created_at,
            icon: 'broadcast',
            color: campaign.status === 'completed' ? 'green' : 
                   campaign.status === 'failed' ? 'red' : 'orange',
            metadata: {
              campaignName: campaign.name,
              successCount: campaign.success_count,
              failCount: campaign.fail_count,
              totalRecipients: campaign.total_recipients,
              templateName: campaign.template_name
            }
          });
        });
      }

      // 4. Fetch user state changes (interactions)
      const { data: userStates, error: stateError } = await supabase
        .from('bot_user_states')
        .select('*')
        .eq('user_id', userId)
        .order('last_interaction', { ascending: false })
        .limit(10);

      if (!stateError && userStates) {
        userStates.forEach(state => {
          if (state.last_interaction) {
            activities.push({
              id: `state-${state.id}`,
              type: 'user_interaction',
              title: 'تفاعل عميل',
              description: `آخر تفاعل من ${state.phone_number}`,
              phone: state.phone_number,
              status: 'active',
              timestamp: state.last_interaction,
              icon: 'user',
              color: 'teal',
              metadata: {
                phoneNumber: state.phone_number,
                lastInboundAt: state.last_inbound_message_at,
                stateData: state.state_data
              }
            });
          }
        });
      }

      // Sort all activities by timestamp (newest first)
      activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Return only the most recent activities
      return activities.slice(0, this.maxActivities);
    } catch (error) {
      console.error('[ActivityFeedPage] Error fetching activities:', error);
      return [];
    }
  }

  /**
   * Render activities to the DOM
   * عرض الأنشطة في الصفحة
   */
  render() {
    if (!this.container) return;

    if (this.activities.length === 0) {
      this.container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--text-secondary);">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 48px; height: 48px; margin-bottom: 12px; color: var(--text-muted);">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"></path>
          </svg>
          <p>لا توجد أنشطة حتى الآن</p>
        </div>
      `;
      return;
    }

    const html = this.activities.map(activity => this.renderActivityItem(activity)).join('');
    this.container.innerHTML = html;
  }

  /**
   * Render a single activity item
   * عرض عنصر نشاط واحد
   */
  renderActivityItem(activity) {
    const timeAgo = this.getTimeAgo(activity.timestamp);
    const dotColor = activity.color || 'blue';
    const icon = this.getActivityIcon(activity.type);

    let metaContent = '';
    if (activity.metadata) {
      if (activity.metadata.messageType) {
        metaContent += `<span class="activity-meta-badge">نوع: ${activity.metadata.messageType}</span>`;
      }
      if (activity.metadata.successCount !== undefined) {
        metaContent += `<span class="activity-meta-badge">نجح: ${activity.metadata.successCount}</span>`;
      }
      if (activity.metadata.failCount !== undefined) {
        metaContent += `<span class="activity-meta-badge">فشل: ${activity.metadata.failCount}</span>`;
      }
      if (activity.phone) {
        metaContent += `<span class="activity-meta-badge">📱 ${activity.phone}</span>`;
      }
    }

    return `
      <div class="activity-item-expanded">
        <div class="activity-dot ${dotColor}"></div>
        <div class="activity-content">
          <div class="activity-header">
            <div>
              <div class="activity-title">${icon} ${activity.title}</div>
              <div class="activity-description">${activity.description}</div>
            </div>
            <div class="activity-time">${timeAgo}</div>
          </div>
          ${metaContent ? `<div class="activity-meta">${metaContent}</div>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Get icon based on activity type
   * الحصول على الأيقونة بناءً على نوع النشاط
   */
  getActivityIcon(type) {
    const icons = {
      'message': '💬',
      'bot_setting': '⚙️',
      'campaign': '📢',
      'user_interaction': '👤',
      'template': '📋',
      'webhook': '🔗'
    };
    return icons[type] || '📌';
  }

  /**
   * Calculate time ago from timestamp
   * حساب الوقت المنقضي
   */
  getTimeAgo(timestamp) {
    const now = new Date();
    const date = new Date(timestamp);
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 60) return 'منذ للتو';
    if (seconds < 3600) return `منذ ${Math.floor(seconds / 60)} د`;
    if (seconds < 86400) return `منذ ${Math.floor(seconds / 3600)} س`;
    if (seconds < 604800) return `منذ ${Math.floor(seconds / 86400)} ي`;
    
    return date.toLocaleDateString('ar-EG');
  }

  /**
   * Render error state
   * عرض حالة الخطأ
   */
  renderError(message) {
    if (!this.container) return;
    this.container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--status-error);">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 48px; height: 48px; margin-bottom: 12px;">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <p>حدث خطأ في تحميل الأنشطة</p>
        <p style="font-size: 12px; color: var(--text-muted);">${message}</p>
      </div>
    `;
  }
}
