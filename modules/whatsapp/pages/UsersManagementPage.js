/**
 * =====================================================
 * modules/whatsapp/pages/UsersManagementPage.js
 * Users Management Page Component
 * صفحة إدارة المستخدمين
 * =====================================================
 */

import { SupabaseIntegration } from '../supabase-integration.js';

export class UsersManagementPage {
  constructor(container) {
    this.container = container;
    this.users = [];
    this.currentUserId = null;
  }

  async mount() {
    await this.load();
  }

  async load() {
    try {
      const currentUser = await SupabaseIntegration.getCurrentUserId();
      this.currentUserId = currentUser;

      // Check if current user is support
      const isSupportUser = await this.checkIfSupportUser();
      if (!isSupportUser) {
        this.renderNoAccess();
        return;
      }

      await this.loadUsers();
      this.render();
    } catch (error) {
      console.error('[UsersManagementPage] Error loading:', error);
      this.renderError(error.message);
    }
  }

  async checkIfSupportUser() {
    try {
      const supabase = await SupabaseIntegration.initializeSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;

      const { data: profile } = await supabase
        .from('profiles')
        .select('email, role')
        .eq('id', user.id)
        .single();

      return profile && (profile.email === 'support@mad3oom.online' || profile.role === 'admin');
    } catch (error) {
      console.error('[UsersManagementPage] Error checking support status:', error);
      return false;
    }
  }

  async loadUsers() {
    try {
      const supabase = await SupabaseIntegration.initializeSupabase();

      const { data: users, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, whatsapp_enabled, role, created_at')
        .neq('email', 'support@mad3oom.online')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Enrich users with integration data
      this.users = await Promise.all(
        (users || []).map(async (user) => {
          const integration = await this.getUserIntegration(user.id);
          return {
            ...user,
            hasIntegration: !!integration,
          };
        })
      );
    } catch (error) {
      console.error('[UsersManagementPage] Error loading users:', error);
      throw error;
    }
  }

  async getUserIntegration(userId) {
    try {
      const supabase = await SupabaseIntegration.initializeSupabase();
      const { data, error } = await supabase
        .from('integrations')
        .select('*')
        .eq('user_id', userId)
        .eq('provider', 'whatsapp')
        .maybeSingle();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      console.error('[UsersManagementPage] Error loading integration:', error);
      return null;
    }
  }

  async toggleWhatsAppPermission(userId, currentState) {
    try {
      const supabase = await SupabaseIntegration.initializeSupabase();

      const { error } = await supabase
        .from('profiles')
        .update({ whatsapp_enabled: !currentState })
        .eq('id', userId);

      if (error) throw error;

      // Update UI
      const userIndex = this.users.findIndex(u => u.id === userId);
      if (userIndex !== -1) {
        this.users[userIndex].whatsapp_enabled = !currentState;
        this.render();
      }

      // Show success message
      window.showToast(
        !currentState
          ? 'تم تفعيل صلاحية الواتساب بنجاح'
          : 'تم تعطيل صلاحية الواتساب بنجاح',
        'success'
      );
    } catch (error) {
      console.error('[UsersManagementPage] Error toggling permission:', error);
      window.showToast(`خطأ: ${error.message}`, 'error');
    }
  }

  renderNoAccess() {
    this.container.innerHTML = `
      <div class="section-card">
        <div class="section-card-header">
          <div class="section-card-title">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m2.12 2.12l4.24 4.24M1 12h6m6 0h6m-17.78 7.78l4.24-4.24m2.12-2.12l4.24-4.24"></path>
            </svg>
            إدارة المستخدمين
          </div>
        </div>
        <div class="section-card-body">
          <div style="text-align: center; padding: 40px 20px; color: var(--text-secondary);">
            <p>عذراً، ليس لديك صلاحية للوصول إلى هذه الصفحة.</p>
            <p style="font-size: 12px; margin-top: 10px;">يمكن فقط لحساب الدعم الفني الوصول إلى إدارة المستخدمين.</p>
          </div>
        </div>
      </div>
    `;
  }

  renderError(message) {
    this.container.innerHTML = `
      <div class="section-card">
        <div class="section-card-header">
          <div class="section-card-title">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            خطأ
          </div>
        </div>
        <div class="section-card-body">
          <p style="color: var(--status-error);">${message}</p>
        </div>
      </div>
    `;
  }

  render() {
    const usersHtml = this.users.length === 0
      ? '<p style="text-align: center; color: var(--text-secondary); padding: 40px 20px;">لا توجد مستخدمين حالياً</p>'
      : `
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: var(--bg-elevated); border-bottom: 1px solid var(--border-subtle);">
                <th style="padding: 12px 16px; text-align: right; font-weight: 600; font-size: 13px; color: var(--text-secondary);">البريد الإلكتروني</th>
                <th style="padding: 12px 16px; text-align: right; font-weight: 600; font-size: 13px; color: var(--text-secondary);">الاسم الكامل</th>
                <th style="padding: 12px 16px; text-align: right; font-weight: 600; font-size: 13px; color: var(--text-secondary);">الدور</th>
                <th style="padding: 12px 16px; text-align: center; font-weight: 600; font-size: 13px; color: var(--text-secondary);">حالة الواتساب</th>
                <th style="padding: 12px 16px; text-align: center; font-weight: 600; font-size: 13px; color: var(--text-secondary);">الإجراء</th>
              </tr>
            </thead>
            <tbody>
              ${this.users.map(user => this.renderUserRow(user)).join('')}
            </tbody>
          </table>
        </div>
      `;

    this.container.innerHTML = `
      <div class="section-card">
        <div class="section-card-header">
          <div class="section-card-title">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
            إدارة المستخدمين
          </div>
          <span style="font-size: 12px; color: var(--text-secondary);">${this.users.length} مستخدم</span>
        </div>
        <div class="section-card-body" style="padding: 0;">
          ${usersHtml}
        </div>
      </div>
    `;
  }

  renderUserRow(user) {
    const statusBadge = user.whatsapp_enabled
      ? '<span style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: rgba(0, 200, 83, 0.1); border-radius: 4px; color: var(--status-success); font-size: 12px; font-weight: 600;">✓ مُفعّل</span>'
      : '<span style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: rgba(200, 0, 0, 0.1); border-radius: 4px; color: var(--status-error); font-size: 12px; font-weight: 600;">✕ معطّل</span>';

    return `
      <tr style="border-bottom: 1px solid var(--border-subtle); hover: background: var(--bg-elevated);">
        <td style="padding: 12px 16px; font-size: 13px; color: var(--text-primary);">${user.email}</td>
        <td style="padding: 12px 16px; font-size: 13px; color: var(--text-secondary);">${user.full_name || '—'}</td>
        <td style="padding: 12px 16px; font-size: 13px; color: var(--text-secondary);">
          <span style="display: inline-block; padding: 2px 8px; background: var(--bg-elevated); border-radius: 4px; font-size: 11px;">${user.role || 'عميل'}</span>
        </td>
        <td style="padding: 12px 16px; text-align: center; font-size: 13px;">
          ${statusBadge}
        </td>
        <td style="padding: 12px 16px; text-align: center;">
          <button 
            class="btn btn-sm ${user.whatsapp_enabled ? 'btn-secondary' : 'btn-primary'}"
            onclick="window.toggleUserWhatsAppPermission('${user.id}', ${user.whatsapp_enabled})"
            style="font-size: 12px;"
          >
            ${user.whatsapp_enabled ? 'تعطيل' : 'تفعيل'}
          </button>
        </td>
      </tr>
    `;
  }
}
