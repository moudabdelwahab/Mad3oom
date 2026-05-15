/**
 * =====================================================
 * modules/whatsapp/app.js
 * WhatsApp Module Main Controller
 * منصة مدعوم - متحكم وحدة الواتساب الرئيسي
 * =====================================================
 */

import { SupabaseIntegration } from './supabase-integration.js';
import { OAuthService } from './oauth.js';
import ProvisioningStatus from './ProvisioningStatus.js';
import { InboxPage } from './pages/InboxPage.js';
import { TemplatesPage } from './pages/TemplatesPage.js';
import { AutoReplyPageV2 } from './pages/AutoReplyPageV2.js';
import { UsersManagementPage } from './pages/UsersManagementPage.js';
import { StatusPage } from './pages/StatusPage.js';
import { WhatsAppAPI } from './services/whatsapp-api.js';

// ─── Navigation ───────────────────────────────────────

function navigateTo(page, element) {
  // Cleanup previous page if needed
  if (page !== 'users' && usersPage) {
    window.cleanupUsersPage();
  }
  
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageElement = document.getElementById(`page-${page}`);
  if (pageElement) pageElement.classList.add('active');
  if (element) element.classList.add('active');

  const titleMap = {
    dashboard: 'الرئيسية',
    connect:   'ربط رقم واتساب',
    templates: 'إدارة القوالب',
    status:    'حالة الرقم',
    messages:  'الرسائل',
    users:     'إدارة المستخدمين',
    settings:  'الإعدادات',
    autoreply: 'الرد الآلي',
  };
  
  // Update subtitle for users page
  const subtitle = page === 'users' 
    ? 'إدارة مستخدمي منصة mad3oom.online وتفعيل الصلاحيات' 
    : 'منصة مدعوم - إدارة WhatsApp Business API';

  document.getElementById('page-title').textContent =
    titleMap[page] || 'الرئيسية';
  document.getElementById('page-subtitle').textContent = subtitle;

  // تحميل البيانات تلقائياً 
  if (page === 'messages') { loadMessages(); }
  if (page === 'templates') { loadTemplates(); }
  if (page === 'autoreply') { loadAutoReply(); }
  if (page === 'status') { loadStatus(); }
  if (page === 'users') { loadUsers(); }
  if (page === 'connect') { updateConnectionStatus(); }
}

window.navigateTo = navigateTo;

// ─── State ───────────────────────────────────────────
let provisioningStatus  = null;
let currentChannelId    = null;
let channelSubscription = null;
let inboxPage = null;
let templatesPage = null;
let autoReplyPage = null;
let usersPage = null;
let statusPage = null;
let businessPhoneNumber = '';

// ─── Initialization ──────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  console.log('[App] Initializing WhatsApp module...');
  try {
    const supabase = await SupabaseIntegration.initializeSupabase();
    
    // Check for session first
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      console.warn('[App] No active session, redirecting to login...');
      // Redirect to login page if no session
      window.location.href = '/sign-in.html?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }

    const profile = await loadUserProfile();
    
    // Check if WhatsApp is enabled for this user
    if (profile && profile.email !== 'support@mad3oom.online' && profile.role !== 'admin' && !profile.whatsapp_enabled) {
      showNoPermissionMessage();
      return;
    }

    await updateConnectionStatus();
    await updateDashboard();

    OAuthService.subscribe((state) => {
      console.log('[App] OAuth state changed:', state);
      handleOAuthStateChange(state);
    });

    const handled = await OAuthService.handleCallback();
    if (handled) console.log('[App] OAuth callback handled');

  } catch (error) {
    console.error('[App] Initialization error:', error);
    // Don't show toast if it's just a 401 we're already handling
    if (error.status !== 401) {
      showToast('حدث خطأ أثناء تهيئة التطبيق', 'error');
    }
  }
});

// ─── User Profile ─────────────────────────────────────

async function loadUserProfile() {
  try {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profile) {
      const fullName = profile.full_name || 'المستخدم';
      const firstName = fullName.split(' ')[0];
      const initial = firstName.charAt(0).toUpperCase();
      
      // Update user name
      document.getElementById('user-name').textContent = fullName;
      
      // Update user role
      const roleMap = {
        'admin': 'مدير النظام',
        'support': 'الدعم الفني',
        'customer': 'عميل'
      };
      document.getElementById('user-role').textContent = roleMap[profile.role] || 'مستخدم';
      
      // Update user avatar
      const avatarEl = document.getElementById('user-avatar');
      if (avatarEl) {
        avatarEl.textContent = initial;
      }
      
      // Update welcome name
      document.getElementById('welcome-name').textContent = firstName + '!';
      
      // Hide users tab if not support/admin
      const usersTab = document.querySelector('[data-page="users"]');
      if (usersTab && profile.email !== 'support@mad3oom.online' && profile.role !== 'admin') {
        usersTab.style.display = 'none';
      }
    }
    return profile;
  } catch (error) {
    console.error('[App] Error loading user profile:', error);
    return null;
  }
}

function showNoPermissionMessage() {
  const mainContent = document.querySelector('.page-content');
  if (mainContent) {
    mainContent.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 60vh; text-align: center; padding: 20px;">
        <div style="background: rgba(255, 179, 0, 0.1); padding: 30px; border-radius: 20px; border: 1px solid rgba(255, 179, 0, 0.2); max-width: 500px;">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 64px; height: 64px; color: var(--status-warning); margin-bottom: 20px;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <h2 style="margin-bottom: 10px; color: var(--text-primary);">صلاحية الواتساب غير مفعلة</h2>
          <p style="color: var(--text-secondary); line-height: 1.6;">عذراً، حسابك لا يملك صلاحية الوصول إلى خدمات الواتساب حالياً. يرجى التواصل مع الدعم الفني لتفعيل الخدمة لك.</p>
          <a href="mailto:support@mad3oom.online" class="btn btn-primary" style="margin-top: 20px; display: inline-flex;">تواصل مع الدعم</a>
        </div>
      </div>
    `;
  }
}


// ─── Messages / Inbox ─────────────────────────────────

async function loadMessages() {
  const container = document.getElementById('whatsapp-inbox-root');
  if (!container) return;

  if (!inboxPage) {
    inboxPage = new InboxPage(container, {
      getBusinessPhone: () => businessPhoneNumber,
    });
    inboxPage.mount();
    return;
  }

  await inboxPage.load();
}

window.loadMessages = loadMessages;

async function loadTemplates() {
  const container = document.getElementById('whatsapp-templates-root');
  if (!container) return;

  if (!templatesPage) {
    templatesPage = new TemplatesPage(container);
  }

  await templatesPage.load();
}

window.loadTemplates = loadTemplates;

window.deleteTemplate = async function(name) {
  if (!confirm(`هل أنت متأكد من حذف القالب "${name}"؟`)) return;
  try {
    await WhatsAppAPI.deleteTemplate(name);
    showToast('تم حذف القالب بنجاح', 'success');
    const session = await supabase.auth.getSession();

    if (session?.data?.session) {
       await loadTemplates();
    } else {
       console.error('No active session');
    }
  } catch (error) {
    showToast(`خطأ في حذف القالب: ${error.message}`, 'error');
  }
};

async function loadAutoReply() {
  const container = document.getElementById('whatsapp-autoreply-root');
  if (!container) return;

  if (!autoReplyPage) {
    autoReplyPage = new AutoReplyPageV2(container);
  }

  await autoReplyPage.load();
}

window.loadAutoReply = loadAutoReply;

async function loadStatus() {
  const container = document.getElementById('whatsapp-status-root');
  if (!container) return;

  if (!statusPage) {
    statusPage = new StatusPage(container);
  }

  await statusPage.load();
}

window.loadStatus = loadStatus;

window.openNewAutoReplyModal = () => {
  const modal = document.getElementById('autoreply-modal');
  if (modal) modal.style.display = 'flex';
};

window.saveNewAutoReply = async function() {
  const keywords = document.getElementById('ar-keywords').value;
  const message = document.getElementById('ar-message').value;

  if (!keywords || !message) {
    showToast('يرجى ملء جميع الحقول', 'warning');
    return;
  }

  try {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const userId = await SupabaseIntegration.getCurrentUserId();
    const { error } = await supabase.from('bot_settings').insert({
      user_id: userId,
      keywords: keywords,
      welcome_message: message,
      is_enabled: true,
      bot_enabled: true
    });

    if (error) throw error;

    showToast('تم حفظ قاعدة الرد بنجاح', 'success');
    document.getElementById('autoreply-modal').style.display = 'none';
    loadAutoReply();
  } catch (error) {
    showToast(`خطأ في الحفظ: ${error.message}`, 'error');
  }
};

window.deleteAutoReply = async function(id) {
  if (!confirm('هل أنت متأكد من حذف هذه القاعدة؟')) return;
  try {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const { error } = await supabase.from('bot_settings').delete().eq('id', id);
    if (error) throw error;
    showToast('تم حذف القاعدة بنجاح', 'success');
    loadAutoReply();
  } catch (error) {
    showToast(`خطأ في الحذف: ${error.message}`, 'error');
  }
};

// ─── Users Management ────────────────────────────

async function loadUsers() {
  const container = document.getElementById('whatsapp-users-root');
  if (!container) return;

  if (!usersPage) {
    usersPage = new UsersManagementPage(container);
    await usersPage.mount();
    return;
  }

  await usersPage.load();
}

window.loadUsers = loadUsers;

window.toggleUserWhatsAppPermission = async function(userId, currentState) {
  if (usersPage) {
    await usersPage.toggleWhatsAppPermission(userId, currentState);
  }
};

window.cleanupUsersPage = async function() {
  if (usersPage) {
    await usersPage.unmount();
    usersPage = null;
  }
};

// ─── Connection Status ────────────────────────────────

async function updateConnectionStatus() {
  try {
    const integrations = await SupabaseIntegration.getWhatsAppChannels();
    const container = document.getElementById('connection-status-list');
    if (!container) return;

    if (integrations.length === 0) {
      container.innerHTML = `
        <div style="padding: 20px; text-align: center; background: rgba(255, 179, 0, 0.05); border: 1px dashed var(--border-subtle); border-radius: var(--radius-md); color: var(--text-secondary);">
          لا يوجد أرقام مرتبطة حالياً.
        </div>
      `;
      
      document.getElementById('dash-status-val').textContent    = 'غير متصل';
      document.getElementById('dash-status-change').textContent = '! اضغط للربط';
      document.getElementById('dash-status-change').style.color = 'var(--status-warning)';
      
      const badge = document.getElementById('connect-badge');
      if (badge) badge.style.display = 'inline-block';
      return;
    }

    const currentPhoneId = localStorage.getItem('mad3oom_wa_phone_id');

    container.innerHTML = integrations.map(int => {
      const isSelected = int.metadata?.phone_number_id === currentPhoneId;
      return `
        <div class="connection-item" style="display: flex; align-items: center; justify-content: space-between; padding: 16px; background: ${isSelected ? 'rgba(0, 200, 83, 0.05)' : 'var(--bg-elevated)'}; border: 1px solid ${isSelected ? 'var(--border-brand)' : 'var(--border-subtle)'}; border-radius: var(--radius-md); margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 40px; height: 40px; border-radius: 50%; background: var(--brand-primary); display: flex; align-items: center; justify-content: center; color: white;">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 20px; height: 20px;">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" stroke="currentColor" stroke-width="2"></path>
              </svg>
            </div>
            <div>
              <div style="font-weight: 600; color: var(--text-primary);">${int.metadata?.phone_number || 'رقم غير معروف'}</div>
              <div style="font-size: 12px; color: var(--text-muted);">ID: ${int.metadata?.phone_number_id}</div>
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            ${isSelected 
              ? '<span style="font-size: 11px; font-weight: 700; color: var(--status-success); background: rgba(0, 200, 83, 0.1); padding: 4px 8px; border-radius: 4px;">نشط حالياً</span>'
              : `<button class="btn btn-sm btn-ghost" onclick="window.switchActivePhone('${int.metadata?.phone_number_id}')">تفعيل</button>`
            }
            <button class="btn btn-sm btn-ghost" style="color: var(--status-error);" onclick="window.handleDisconnect('${int.metadata?.phone_number_id}')">حذف</button>
          </div>
        </div>
      `;
    }).join('');

    // Update Dashboard Summary
    document.getElementById('dash-status-val').textContent    = 'متصل';
    document.getElementById('dash-status-change').textContent = `✓ ${integrations.length} أرقام مرتبطة`;
    document.getElementById('dash-status-change').style.color = 'var(--status-success)';
    
    const badge = document.getElementById('connect-badge');
    if (badge) badge.style.display = 'none';

  } catch (error) {
    console.error('[App] Error updating connection status:', error);
  }
}

window.switchActivePhone = async function(phoneId) {
  const integrations = await SupabaseIntegration.getWhatsAppChannels();
  const target = integrations.find(i => i.metadata?.phone_number_id === phoneId);
  if (target) {
    SupabaseIntegration.saveLocalIntegration(target.metadata, target.access_token);
    showToast('تم تبديل الرقم النشط', 'success');
    updateConnectionStatus();
    updateDashboard();
  }
};

// ─── Dashboard Stats ──────────────────────────────

async function updateDashboard() {
  try {
    const stats = await SupabaseIntegration.getDashboardStats();

    if (!stats) {
      const integrations = await SupabaseIntegration.getWhatsAppChannels();
      if (integrations.length > 0) {
        // We have integrations but none selected or token expired
        document.getElementById('dash-status-val').textContent    = 'متصل';
        document.getElementById('dash-status-change').textContent = '! اختر رقم نشط';
        document.getElementById('dash-status-change').style.color = 'var(--status-warning)';
      } else {
        document.getElementById('dash-status-val').textContent    = 'غير متصل';
        document.getElementById('dash-status-change').textContent = '! اضغط للربط';
        document.getElementById('dash-status-change').style.color = 'var(--status-warning)';
      }
      
      const welcomeSub = document.getElementById('welcome-sub');
      if (welcomeSub) {
        welcomeSub.textContent = 'لوحة تحكم WhatsApp Business API جاهزة. ابدأ بربط رقمك الآن.';
      }
      return;
    }

    document.getElementById('dash-status-val').textContent    = 'متصل';
    document.getElementById('dash-status-change').textContent = '✓ تم الربط';
    document.getElementById('dash-status-change').style.color = 'var(--status-success)';

    businessPhoneNumber = stats.phoneNumber || businessPhoneNumber;

    const welcomeName = document.getElementById('welcome-name');
    if (welcomeName) {
      welcomeName.textContent = (stats.verifiedName || 'صديقي') + '!';
    }
    
    const welcomeSub = document.getElementById('welcome-sub');
    if (welcomeSub) {
      welcomeSub.textContent = 'لوحة تحكم WhatsApp Business API جاهزة ونشطة الآن.';
    }

    // Update Real Stats
    document.getElementById('stat-sent-count').textContent = '—';
    document.getElementById('stat-sent-change').textContent = 'جاري التحديث...';
    
    document.getElementById('stat-delivery-rate').textContent = (stats.qualityRating || '—');
    document.getElementById('stat-delivery-change').textContent = 'من Meta';

    document.getElementById('stat-templates-count').textContent = '—';
    document.getElementById('stat-templates-change').textContent = 'جاري التحديث...';

  } catch (error) {
    console.error('[App] Error updating dashboard:', error);
  }
}

// ─── OAuth State Change Handler ──────────────────
async function registerWhatsAppNumber(phoneNumberId, accessToken) {

  try {

    console.log('[Register] Registering WhatsApp number...');

    const response = await fetch(
      'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/register-whatsapp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          phoneNumberId,
          accessToken
        })
      }
    );

    const data = await response.json();

    console.log('[Register] Response:', data);

    return data;

  } catch (error) {

    console.error('[Register] Error:', error);

  }

}
function handleOAuthStateChange(state) {

  console.log('[App] Handling OAuth state change:', state);

  if (state.status === 'success') {

    showToast('تم الربط بنجاح! 🎉', 'success');

    // تسجيل الرقم تلقائياً
    if (
      state.phoneId &&
      state.accessToken
    ) {

      registerWhatsAppNumber(
        state.phoneId,
        state.accessToken
      );

    }

    setTimeout(() => {
      updateConnectionStatus();
      updateDashboard();
    }, 1000);

  } else if (state.status === 'error') {

    showToast(`خطأ: ${state.errorMsg}`, 'error');

  }

}

// ─── Disconnect Handler ──────────────────────────

window.handleDisconnect = async function(phoneId = null) {
  if (!confirm('هل أنت متأكد من رغبتك في حذف هذا الربط؟')) return;
  
  try {
    await SupabaseIntegration.deleteIntegration(phoneId);
    showToast('تم حذف الربط بنجاح', 'success');
    updateConnectionStatus();
    updateDashboard();
  } catch (error) {
    showToast(`خطأ: ${error.message}`, 'error');
  }
};

// ─── Sync Handler ────────────────────────────────

window.handleSync = async function() {
  const btn = document.getElementById('sync-btn');
  if (btn) btn.style.opacity = '0.5';
  
  try {
    await updateDashboard();
    showToast('تم المزامنة بنجاح', 'success');
  } catch (error) {
    showToast('خطأ في المزامنة', 'error');
  } finally {
    if (btn) btn.style.opacity = '1';
  }
};

// ─── Reports Handler ────────────────────────────

window.handleReports = function() {
  showToast('التقارير قيد التطوير', 'info');
};

// ─── Notifications Handler ──────────────────────

window.handleNotifications = function() {
  showToast('لا توجد إشعارات جديدة', 'info');
};

// ─── User Menu Handler ──────────────────────────

window.handleUserMenu = function() {
  showToast('قائمة المستخدم قيد التطوير', 'info');
};
// ─── Toast Notifications ──────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    padding: 12px 24px; border-radius: 8px; color: white; font-weight: 600;
    z-index: 9999; opacity: 0; transition: opacity 0.3s;
    background: ${type === 'success' ? '#00c853' : type === 'error' ? '#f44336' : type === 'warning' ? '#ffb300' : '#2196f3'};
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.style.opacity = '1');
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

window.showToast = showToast;
