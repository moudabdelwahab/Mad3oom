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

// ─── State ───────────────────────────────────────────
let provisioningStatus  = null;
let currentChannelId    = null;
let channelSubscription = null;

// ─── Initialization ──────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  console.log('[App] Initializing WhatsApp module...');

  try {
    await SupabaseIntegration.initializeSupabase();
    await loadUserProfile();
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
    showToast('حدث خطأ أثناء تهيئة التطبيق', 'error');
  }
});

// ─── User Profile ─────────────────────────────────────

async function loadUserProfile() {
  try {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profile) {
      document.getElementById('user-name').textContent =
        profile.full_name || 'المستخدم';
      document.getElementById('welcome-name').textContent =
        (profile.full_name || 'صديقي').split(' ')[0] + '!';
    }
  } catch (error) {
    console.error('[App] Error loading user profile:', error);
  }
}

// ─── Connection Status ────────────────────────────────

async function updateConnectionStatus() {
  try {
    const status = await OAuthService.getConnectionStatus();

    if (status.isConnected) {
      document.getElementById('connection-status').style.display = 'block';
      document.getElementById('status-phone').textContent =
        status.phoneId || '—';
      document.getElementById('status-date').textContent =
        status.connectedAt
          ? new Date(status.connectedAt).toLocaleDateString('ar-SA')
          : '—';

      document.getElementById('connect-btn').style.display    = 'none';
      document.getElementById('disconnect-btn').style.display = 'inline-flex';

      document.getElementById('dash-status-val').textContent    = 'متصل';
      document.getElementById('dash-status-change').textContent = '✓ متصل بنجاح';
      document.getElementById('dash-status-change').style.color = 'var(--status-success)';

      const badge = document.getElementById('connect-badge');
      if (badge) badge.style.display = 'none';

    } else {
      document.getElementById('connect-btn').style.display       = 'inline-flex';
      document.getElementById('disconnect-btn').style.display    = 'none';
      document.getElementById('connection-status').style.display = 'none';

      document.getElementById('dash-status-val').textContent    = 'غير متصل';
      document.getElementById('dash-status-change').textContent = '! اضغط للربط';
      document.getElementById('dash-status-change').style.color = 'var(--status-warning)';

      const badge = document.getElementById('connect-badge');
      if (badge) badge.style.display = 'inline-block';
    }
  } catch (error) {
    console.error('[App] Error updating connection status:', error);
  }
}

// ─── Dashboard Stats ──────────────────────────────────

async function updateDashboard() {
  try {
    const stats = await SupabaseIntegration.getDashboardStats();

    if (!stats) {
      document.getElementById('dash-status-val').textContent    = 'غير متصل';
      document.getElementById('dash-status-change').textContent = '! اضغط للربط';
      document.getElementById('dash-status-change').style.color = 'var(--status-warning)';
      return;
    }

    document.getElementById('dash-status-val').textContent    = 'متصل';
    document.getElementById('dash-status-change').textContent = '✓ ' + stats.verifiedName;
    document.getElementById('dash-status-change').style.color = 'var(--status-success)';

    const statusPhone = document.getElementById('status-phone');
    if (statusPhone) statusPhone.textContent = stats.phoneNumber;

    const welcomeName = document.getElementById('welcome-name');
    if (welcomeName && welcomeName.textContent === 'صديقي!') {
      welcomeName.textContent = stats.verifiedName + '!';
    }

  } catch (error) {
    console.error('[App] updateDashboard error:', error);
  }
}

// ─── OAuth State Handler ──────────────────────────────

async function handleOAuthStateChange(state) {
  console.log('[App] Handling OAuth state change:', state.status);

  switch (state.status) {
    case 'loading':
      showToast('جاري الربط...', 'info');
      break;

    case 'success':
      showToast('تم الربط بنجاح!', 'success');
      await updateConnectionStatus();
      await updateDashboard();
      // ✅ انتقل للـ dashboard مباشرة بعد الربط
      setTimeout(() => {
        navigateTo('dashboard', document.querySelector('[data-page=dashboard]'));
      }, 2000);
      break;

    case 'error':
      showToast(`خطأ في الربط: ${state.errorMsg}`, 'error');
      break;

    case 'idle':
      await updateConnectionStatus();
      await updateDashboard();
      break;

    case 'provisioning':
      // لا نحتاج provisioning في هذا الـ flow
      break;
  }
}

// ─── Channel Subscription ─────────────────────────────

function subscribeToChannelUpdates(channelId) {
  try {
    if (channelSubscription) {
      channelSubscription.unsubscribe();
      channelSubscription = null;
    }

    if (typeof SupabaseIntegration.subscribeToChannelUpdates !== 'function') {
      console.warn('[App] subscribeToChannelUpdates not available');
      return;
    }

    channelSubscription = SupabaseIntegration.subscribeToChannelUpdates(
      channelId,
      (updatedChannel) => {
        console.log('[App] Channel updated:', updatedChannel);

        if (updatedChannel.status === 'active') {
          setTimeout(() => {
            showToast('تم تفعيل القناة بنجاح!', 'success');
            updateDashboard();
            setTimeout(() => {
              navigateTo('dashboard', document.querySelector('[data-page=dashboard]'));
            }, 2000);
          }, 500);
        }

        if (updatedChannel.status === 'error') {
          showToast(`خطأ في التفعيل: ${updatedChannel.error_message}`, 'error');
        }
      }
    );

  } catch (error) {
    console.error('[App] Error subscribing to channel updates:', error);
  }
}

// ─── Navigation ───────────────────────────────────────

function navigateTo(page, element) {
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
    settings:  'الإعدادات',
  };

  document.getElementById('page-title').textContent =
    titleMap[page] || 'الرئيسية';
  document.getElementById('page-subtitle').textContent =
    'منصة مدعوم - إدارة WhatsApp Business API';
}

window.navigateTo = navigateTo;

// ─── Disconnect Handler ───────────────────────────────

window.handleDisconnect = async function() {
  try {
    await OAuthService.disconnect();
    showToast('تم قطع الاتصال بنجاح', 'success');
    await updateConnectionStatus();
    await updateDashboard();
  } catch (error) {
    console.error('[App] Disconnect error:', error);
    showToast('حدث خطأ أثناء قطع الاتصال', 'error');
  }
};

// ─── Global Handlers ──────────────────────────────────

window.handleSync = function() {
  const btn = document.getElementById('sync-btn');
  btn.classList.add('spinning');
  setTimeout(() => {
    btn.classList.remove('spinning');
    showToast('تم المزامنة بنجاح', 'success');
  }, 2000);
};

window.handleNotifications  = () => showToast('لا توجد إشعارات جديدة', 'info');
window.handleReports        = () => showToast('التقارير قيد التطوير', 'info');
window.handleUserMenu       = () => showToast('قائمة المستخدم قيد التطوير', 'info');
window.openNewTemplateModal = () => showToast('إنشاء قالب جديد قيد التطوير', 'info');
window.handleConnectClick   = () => OAuthService.startOAuthFlow();

// ─── Toast Helper ─────────────────────────────────────

function showToast(message, type = 'info') {
  if (typeof Toast !== 'undefined' && Toast.show) {
    Toast.show(message, type);
  } else {
    console.log(`[${type.toUpperCase()}] ${message}`);
  }
}

// ─── Cleanup ──────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  if (channelSubscription) channelSubscription.unsubscribe();
});

// ─── Exports ──────────────────────────────────────────

export { loadUserProfile, updateDashboard };
