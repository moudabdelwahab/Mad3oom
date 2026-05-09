
/**
 * =====================================================
 * modules/whatsapp/app.js (Updated)
 * WhatsApp Module Main Controller
 * منصة مدعوم - متحكم وحدة الواتساب الرئيسي
 * =====================================================
 */

import { SupabaseIntegration } from './supabase-integration.js';
import { OAuthService } from './oauth.js';
import ProvisioningStatus from './components/ProvisioningStatus.js';

// ─── State ───────────────────────────────────────────
let provisioningStatus = null;
let currentChannelId = null;
let channelSubscription = null;

// ─── Initialization ──────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  console.log('[App] Initializing WhatsApp module...');

  try {
    // تهيئة Supabase
    await SupabaseIntegration.initializeSupabase();

    // تحميل معلومات المستخدم
    await loadUserProfile();

    // تحديث حالة الاتصال
    await updateConnectionStatus();

    // الاستماع إلى تغييرات حالة OAuth
    OAuthService.subscribe((state) => {
      console.log('[App] OAuth state changed:', state);
      handleOAuthStateChange(state);
    });

    // معالجة callback من OAuth
    const handled = await OAuthService.handleCallback();
    if (handled) {
      console.log('[App] OAuth callback handled');
    }
  } catch (error) {
    console.error('[App] Initialization error:', error);
    showToast('حدث خطأ أثناء تهيئة التطبيق', 'error');
  }
});

/**
 * تحميل ملف تعريف المستخدم
 */
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
      document.getElementById('user-name').textContent = profile.full_name || 'المستخدم';
      document.getElementById('welcome-name').textContent = (profile.full_name || 'صديقي').split(' ')[0];
    }
  } catch (error) {
    console.error('[App] Error loading user profile:', error);
  }
}

/**
 * تحديث حالة الاتصال
 */
async function updateConnectionStatus() {
  try {
    const status = await OAuthService.getConnectionStatus();

    if (status.isConnected) {
      // عرض حالة الاتصال
      document.getElementById('connection-status').style.display = 'block';
      document.getElementById('status-phone').textContent = status.phoneId || '—';
      document.getElementById('status-date').textContent = new Date(status.connectedAt).toLocaleDateString('ar-SA');

      // إخفاء زر الربط وإظهار زر قطع الاتصال
      document.getElementById('connect-btn').style.display = 'none';
      document.getElementById('disconnect-btn').style.display = 'inline-flex';

      // تحديث حالة الرئيسية
      document.getElementById('dash-status-val').textContent = 'متصل';
      document.getElementById('dash-status-change').textContent = '✓ متصل بنجاح';
      document.getElementById('dash-status-change').style.color = 'var(--status-success)';

      // إخفاء شارة الربط
      const badge = document.getElementById('connect-badge');
      if (badge) badge.style.display = 'none';
    } else {
      // إظهار زر الربط
      document.getElementById('connect-btn').style.display = 'inline-flex';
      document.getElementById('disconnect-btn').style.display = 'none';
      document.getElementById('connection-status').style.display = 'none';

      // تحديث حالة الرئيسية
      document.getElementById('dash-status-val').textContent = 'غير متصل';
      document.getElementById('dash-status-change').textContent = '! اضغط للربط';
      document.getElementById('dash-status-change').style.color = 'var(--status-warning)';

      // إظهار شارة الربط
      const badge = document.getElementById('connect-badge');
      if (badge) badge.style.display = 'inline-block';
    }
  } catch (error) {
    console.error('[App] Error updating connection status:', error);
  }
}

/**
 * معالجة تغييرات حالة OAuth
 */
async function handleOAuthStateChange(state) {
  console.log('[App] Handling OAuth state change:', state.status);

  switch (state.status) {
    case 'loading':
      showToast('جاري الربط...', 'info');
      break;

    case 'success':
      showToast('تم الربط بنجاح! جاري تفعيل القناة...', 'success');
      await updateConnectionStatus();
      // بدء عرض شاشة الـ provisioning
      await startProvisioningUI(state);
      break;

    case 'error':
      showToast(`خطأ في الربط: ${state.errorMsg}`, 'error');
      break;

    case 'idle':
      // تم قطع الاتصال
      await updateConnectionStatus();
      break;
  }
}

/**
 * بدء عرض واجهة الـ provisioning
 */
async function startProvisioningUI(oauthState) {
  try {
    // الحصول على آخر قناة تم إنشاؤها
    const channels = await SupabaseIntegration.getWhatsAppChannels();
    if (channels.length === 0) {
      console.error('[App] No channels found');
      return;
    }

    const channel = channels[0];
    currentChannelId = channel.id;

    // إنشاء مكون عرض الحالة
    if (!provisioningStatus) {
      // إنشاء container للـ provisioning
      const container = document.createElement('div');
      container.id = 'provisioning-status-container';
      document.body.appendChild(container);

      provisioningStatus = new ProvisioningStatus('provisioning-status-container');
    }

    // عرض الحالة الحالية
    provisioningStatus.updateStatus(channel.status, channel.error_message);

    // الاستماع إلى تحديثات القناة
    subscribeToChannelUpdates(channel.id);
  } catch (error) {
    console.error('[App] Error starting provisioning UI:', error);
  }
}

/**
 * الاستماع إلى تحديثات القناة
 */
function subscribeToChannelUpdates(channelId) {
  try {
    SupabaseIntegration.subscribeToChannelUpdates(channelId, (updatedChannel) => {
      console.log('[App] Channel updated:', updatedChannel);

      if (provisioningStatus) {
        provisioningStatus.updateStatus(updatedChannel.status, updatedChannel.error_message);
      }

      // إذا اكتملت عملية التفعيل بنجاح
      if (updatedChannel.status === 'active') {
        setTimeout(() => {
          showToast('تم تفعيل القناة بنجاح!', 'success');
          // إعادة التوجيه إلى الرئيسية بعد 2 ثانية
          setTimeout(() => {
            navigateTo('dashboard', document.querySelector('[data-page=dashboard]'));
          }, 2000);
        }, 500);
      }

      // إذا حدث خطأ
      if (updatedChannel.status === 'error') {
        showToast(`خطأ في التفعيل: ${updatedChannel.error_message}`, 'error');
      }
    });
  } catch (error) {
    console.error('[App] Error subscribing to channel updates:', error);
  }
}

/**
 * معالج قطع الاتصال
 */
window.handleDisconnect = async function() {
  if (!confirm('هل أنت متأكد من رغبتك في قطع الاتصال؟')) {
    return;
  }

  try {
    await OAuthService.disconnect();
    await SupabaseIntegration.deleteIntegration();
    await updateConnectionStatus();
    showToast('تم قطع الاتصال بنجاح', 'success');
  } catch (error) {
    console.error('[App] Error disconnecting:', error);
    showToast('خطأ في قطع الاتصال', 'error');
  }
};

/**
 * دالة التنقل بين الصفحات
 */
window.navigateTo = function(page, element) {
  // إخفاء جميع الصفحات
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));

  // إظهار الصفحة المطلوبة
  const pageElement = document.getElementById(`page-${page}`);
  if (pageElement) {
    pageElement.classList.add('active');
  }

  // تحديث العنصر النشط في القائمة الجانبية
  if (element) {
    element.classList.add('active');
  }

  // تحديث العنوان
  const titleMap = {
    dashboard: 'الرئيسية',
    connect: 'ربط رقم واتساب',
    templates: 'إدارة القوالب',
    status: 'حالة الرقم',
    messages: 'الرسائل',
    settings: 'الإعدادات',
  };

  document.getElementById('page-title').textContent = titleMap[page] || 'الرئيسية';
  document.getElementById('page-subtitle').textContent = 'منصة مدعوم - إدارة WhatsApp Business API';
};

/**
 * معالج المزامنة
 */
window.handleSync = function() {
  const btn = document.getElementById('sync-btn');
  btn.classList.add('spinning');

  setTimeout(() => {
    btn.classList.remove('spinning');
    showToast('تم المزامنة بنجاح', 'success');
  }, 2000);
};

/**
 * معالج الإشعارات
 */
window.handleNotifications = function() {
  showToast('لا توجد إشعارات جديدة', 'info');
};

/**
 * معالج التقارير
 */
window.handleReports = function() {
  showToast('التقارير قيد التطوير', 'info');
};

/**
 * معالج قائمة المستخدم
 */
window.handleUserMenu = function() {
  showToast('قائمة المستخدم قيد التطوير', 'info');
};

/**
 * معالج فتح نموذج القالب الجديد
 */
window.openNewTemplateModal = function() {
  showToast('إنشاء قالب جديد قيد التطوير', 'info');
};

/**
 * عرض رسالة Toast
 */
function showToast(message, type = 'info') {
  if (typeof Toast !== 'undefined' && Toast.show) {
    Toast.show(message, type);
  } else {
    console.log(`[${type.toUpperCase()}] ${message}`);
  }
}

// Export
export { loadUserProfile, updateConnectionStatus, startProvisioningUI };
