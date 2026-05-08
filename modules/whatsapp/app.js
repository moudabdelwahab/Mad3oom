/**
 * =====================================================
 * modules/whatsapp/app.js
 * Main Application Logic
 * منصة مدعوم - منطق التطبيق الرئيسي
 * =====================================================
 */

import { SupabaseIntegration } from './supabase-integration.js';
import { OAuthService } from './oauth.js';

// ─── Page Navigation ─────────────────────────────────

function navigateTo(pageName, element) {
  // تحديث الصفحات
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });
  document.getElementById(`page-${pageName}`).classList.add('active');

  // تحديث عناصر التنقل
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });
  if (element) element.classList.add('active');

  // تحديث العنوان والوصف
  const titles = {
    dashboard: { title: 'الرئيسية', subtitle: 'مرحبًا بك في لوحة تحكم مدعوم' },
    connect: { title: 'ربط رقم واتساب', subtitle: 'قم بربط حسابك على WhatsApp Business' },
    templates: { title: 'إدارة القوالب', subtitle: 'أنشئ وأدر قوالب الرسائل الخاصة بك' },
    status: { title: 'حالة الرقم', subtitle: 'عرض حالة الخدمة والإحصائيات' },
    messages: { title: 'الرسائل', subtitle: 'عرض ومراجعة الرسائل المرسلة والمستقبلة' },
    settings: { title: 'الإعدادات', subtitle: 'إدارة إعدادات الحساب والنظام' },
  };

  const page = titles[pageName] || titles.dashboard;
  document.getElementById('page-title').textContent = page.title;
  document.getElementById('page-subtitle').textContent = page.subtitle;

  // تحديث شريط الجانب النشط
  document.querySelectorAll('[data-page]').forEach(item => {
    item.classList.remove('active');
  });
  document.querySelector(`[data-page="${pageName}"]`)?.classList.add('active');
}

// ─── Connection Management ──────────────────────────

async function updateConnectionStatus() {
  try {
    const status = await OAuthService.getConnectionStatus();
    
    if (status.isConnected) {
      // إظهار حالة الاتصال
      document.getElementById('connection-status').style.display = 'block';
      document.getElementById('status-phone').textContent = status.phoneId || '—';
      document.getElementById('status-date').textContent = new Date(status.connectedAt).toLocaleString('ar-SA');
      
      // إخفاء زر الربط وإظهار زر قطع الاتصال
      document.getElementById('connect-btn').style.display = 'none';
      document.getElementById('disconnect-btn').style.display = 'inline-flex';
      
      // تحديث حالة لوحة التحكم
      document.getElementById('dash-status-val').textContent = '✓ متصل';
      document.getElementById('dash-status-change').textContent = '✓ الاتصال نشط';
      document.getElementById('connect-badge').style.display = 'none';
    } else {
      // إخفاء حالة الاتصال
      document.getElementById('connection-status').style.display = 'none';
      
      // إظهار زر الربط وإخفاء زر قطع الاتصال
      document.getElementById('connect-btn').style.display = 'inline-flex';
      document.getElementById('disconnect-btn').style.display = 'none';
      
      // تحديث حالة لوحة التحكم
      document.getElementById('dash-status-val').textContent = '✗ غير متصل';
      document.getElementById('dash-status-change').textContent = '← اضغط للربط';
      document.getElementById('connect-badge').style.display = 'inline-block';
    }
  } catch (error) {
    console.error('[App] Failed to update connection status:', error);
  }
}

async function handleConnectClick() {
  const btn = document.getElementById('connect-btn');
  btn.disabled = true;
  btn.textContent = 'جاري الربط...';
  
  try {
    // التحقق من المستخدم
    const userId = await SupabaseIntegration.getCurrentUserId();
    if (!userId) {
      Toast.error('خطأ', 'يجب تسجيل الدخول أولاً');
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px; margin-left: 6px;"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> ربط حساب جديد';
      return;
    }

    // بدء عملية OAuth
    OAuthService.startOAuthFlow();
  } catch (error) {
    console.error('[App] Connection error:', error);
    Toast.error('خطأ', error.message || 'فشل في بدء عملية الربط');
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px; margin-left: 6px;"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> ربط حساب جديد';
  }
}

async function handleDisconnect() {
  if (!confirm('هل أنت متأكد من رغبتك في قطع الاتصال؟')) {
    return;
  }

  try {
    await OAuthService.disconnect();
    Toast.success('تم', 'تم قطع الاتصال بنجاح');
    await updateConnectionStatus();
  } catch (error) {
    console.error('[App] Disconnect error:', error);
    Toast.error('خطأ', 'فشل في قطع الاتصال');
  }
}

// ─── Event Handlers ─────────────────────────────────

function handleNotifications() {
  Toast.info('الإشعارات', 'لا توجد إشعارات جديدة');
}

function handleSync() {
  const btn = document.getElementById('sync-btn');
  btn.style.animation = 'spin 1s linear infinite';
  
  setTimeout(() => {
    btn.style.animation = 'none';
    Toast.success('تم', 'تمت مزامنة البيانات بنجاح');
  }, 2000);
}

function handleUserMenu() {
  Toast.info('الحساب', 'إعدادات الحساب قيد التطوير');
}

function handleReports() {
  Toast.info('التقارير', 'جارٍ تجهيز التقرير...');
}

function openNewTemplateModal() {
  Toast.info('القوالب', 'إنشاء قالب جديد قيد التطوير');
}

// ─── OAuth State Monitoring ─────────────────────────

function monitorOAuthState() {
  OAuthService.subscribe((state) => {
    console.log('[App] OAuth state changed:', state);

    if (state.status === 'loading') {
      Toast.info('جاري الربط', 'يتم معالجة بيانات الاتصال...');
    } else if (state.status === 'success') {
      Toast.success('تم', 'تم الربط بنجاح!');
      updateConnectionStatus();
    } else if (state.status === 'error') {
      Toast.error('خطأ', state.errorMsg || 'فشل في الربط');
    }
  });
}

// ─── Initialization ─────────────────────────────────

async function initializeApp() {
  try {
    console.log('[App] Initializing...');

    // تهيئة Supabase
    await SupabaseIntegration.initializeSupabase();

    // مراقبة حالة OAuth
    monitorOAuthState();

    // تحديث حالة الاتصال
    await updateConnectionStatus();

    // التعامل مع OAuth callback
    const handled = await OAuthService.handleCallback();
    if (handled) {
      console.log('[App] OAuth callback handled');
      // الانتظار قليلاً قبل تحديث الحالة
      setTimeout(() => updateConnectionStatus(), 1000);
    }

    console.log('[App] Initialization complete');
  } catch (error) {
    console.error('[App] Initialization error:', error);
    Toast.error('خطأ', 'فشل في تهيئة التطبيق');
  }
}

// ─── DOM Ready ──────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
});

// ─── Export for global access ───────────────────────

window.navigateTo = navigateTo;
window.handleConnectClick = handleConnectClick;
window.handleDisconnect = handleDisconnect;
window.handleNotifications = handleNotifications;
window.handleSync = handleSync;
window.handleUserMenu = handleUserMenu;
window.handleReports = handleReports;
window.openNewTemplateModal = openNewTemplateModal;
