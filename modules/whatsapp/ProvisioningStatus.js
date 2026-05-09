/**
 * =====================================================
 * modules/whatsapp/components/ProvisioningStatus.js
 * WhatsApp Provisioning Status Component
 * منصة مدعوم - مكون عرض حالة التفعيل
 * =====================================================
 */

class ProvisioningStatus {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.currentStatus = null;
    this.statusMessages = {
      provisioning: {
        label: 'جاري إنشاء القناة...',
        icon: 'spinner',
        color: 'blue',
        description: 'يتم إنشاء قناة WhatsApp Business جديدة',
      },
      installing_server: {
        label: 'جاري تنصيب السيرفر...',
        icon: 'server',
        color: 'blue',
        description: 'يتم تنصيب وتهيئة خوادم الاتصال',
      },
      connecting_webhook: {
        label: 'جاري ربط Webhook...',
        icon: 'link',
        color: 'blue',
        description: 'يتم ربط الـ webhook لاستقبال الرسائل',
      },
      syncing_assets: {
        label: 'جاري مزامنة البيانات...',
        icon: 'sync',
        color: 'blue',
        description: 'يتم مزامنة القوالب والبيانات الأخرى',
      },
      active: {
        label: 'تم التفعيل بنجاح',
        icon: 'check-circle',
        color: 'green',
        description: 'القناة جاهزة للاستخدام',
      },
      error: {
        label: 'حدث خطأ',
        icon: 'alert-circle',
        color: 'red',
        description: 'حدث خطأ أثناء التفعيل',
      },
    };
  }

  /**
   * تحديث حالة التفعيل
   */
  updateStatus(status, errorMessage = null) {
    this.currentStatus = status;
    this.render(errorMessage);
  }

  /**
   * رسم المكون
   */
  render(errorMessage = null) {
    if (!this.container) return;

    const statusInfo = this.statusMessages[this.currentStatus] || {};
    const isLoading = ['provisioning', 'installing_server', 'connecting_webhook', 'syncing_assets'].includes(
      this.currentStatus
    );
    const isSuccess = this.currentStatus === 'active';
    const isError = this.currentStatus === 'error';

    const html = `
      <div class="provisioning-status-container">
        <div class="provisioning-card">
          <!-- Header -->
          <div class="provisioning-header">
            <div class="provisioning-icon ${statusInfo.color}">
              ${this.getIcon(statusInfo.icon, isLoading)}
            </div>
            <div class="provisioning-header-text">
              <h3 class="provisioning-title">${statusInfo.label}</h3>
              <p class="provisioning-description">${statusInfo.description}</p>
            </div>
          </div>

          <!-- Progress Bar -->
          <div class="provisioning-progress">
            <div class="progress-bar-container">
              <div class="progress-bar-fill" style="width: ${this.getProgressPercentage()}%"></div>
            </div>
            <div class="progress-text">${this.getProgressText()}</div>
          </div>

          <!-- Steps -->
          <div class="provisioning-steps">
            ${this.renderSteps()}
          </div>

          <!-- Error Message -->
          ${isError && errorMessage ? `
            <div class="error-message">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>${errorMessage}</span>
            </div>
          ` : ''}

          <!-- Actions -->
          <div class="provisioning-actions">
            ${isError ? `
              <button class="btn btn-primary" onclick="location.reload()">
                إعادة المحاولة
              </button>
            ` : ''}
            ${isSuccess ? `
              <button class="btn btn-primary" onclick="navigateTo('dashboard', document.querySelector('[data-page=dashboard]'))">
                العودة إلى الرئيسية
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;

    this.container.innerHTML = html;
  }

  /**
   * الحصول على أيقونة SVG
   */
  getIcon(iconType, isLoading) {
    const icons = {
      spinner: `
        <svg class="spinner-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"></circle>
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="2" fill="none"></path>
        </svg>
      `,
      server: `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="3" width="20" height="8" rx="1" stroke="currentColor" stroke-width="2"></rect>
          <rect x="2" y="13" width="20" height="8" rx="1" stroke="currentColor" stroke-width="2"></rect>
          <circle cx="6" cy="7" r="1" fill="currentColor"></circle>
          <circle cx="6" cy="17" r="1" fill="currentColor"></circle>
        </svg>
      `,
      link: `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
        </svg>
      `,
      sync: `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
        </svg>
      `,
      'check-circle': `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <polyline points="22 4 12 14.01 9 11.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"></polyline>
        </svg>
      `,
      'alert-circle': `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"></circle>
          <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line>
          <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line>
        </svg>
      `,
    };

    return icons[iconType] || '';
  }

  /**
   * رسم خطوات التفعيل
   */
  renderSteps() {
    const steps = [
      { key: 'provisioning', label: 'إنشاء القناة' },
      { key: 'installing_server', label: 'تنصيب السيرفر' },
      { key: 'connecting_webhook', label: 'ربط Webhook' },
      { key: 'syncing_assets', label: 'مزامنة البيانات' },
      { key: 'active', label: 'التفعيل' },
    ];

    const statusOrder = ['provisioning', 'installing_server', 'connecting_webhook', 'syncing_assets', 'active'];
    const currentIndex = statusOrder.indexOf(this.currentStatus);

    return steps
      .map((step, index) => {
        const isCompleted = index < currentIndex || (index === currentIndex && this.currentStatus === 'active');
        const isActive = index === currentIndex;

        return `
          <div class="step ${isCompleted ? 'completed' : ''} ${isActive ? 'active' : ''}">
            <div class="step-indicator">
              ${isCompleted ? '✓' : index + 1}
            </div>
            <div class="step-label">${step.label}</div>
          </div>
        `;
      })
      .join('');
  }

  /**
   * الحصول على نسبة التقدم
   */
  getProgressPercentage() {
    const statusOrder = ['provisioning', 'installing_server', 'connecting_webhook', 'syncing_assets', 'active'];
    const currentIndex = statusOrder.indexOf(this.currentStatus);
    return ((currentIndex + 1) / statusOrder.length) * 100;
  }

  /**
   * الحصول على نص التقدم
   */
  getProgressText() {
    const statusOrder = ['provisioning', 'installing_server', 'connecting_webhook', 'syncing_assets', 'active'];
    const currentIndex = statusOrder.indexOf(this.currentStatus);
    return `${currentIndex + 1} من ${statusOrder.length}`;
  }
}

// Export
if (typeof window !== 'undefined') {
  window.ProvisioningStatus = ProvisioningStatus;
}

export default ProvisioningStatus;


