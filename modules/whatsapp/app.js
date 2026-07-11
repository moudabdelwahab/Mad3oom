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
import { SettingsPage } from './pages/SettingsPage.js';
import { DeveloperSettingsPage } from './pages/DeveloperSettingsPage.js';
import { SendMessagePage } from './pages/SendMessagePage.js';
import { CampaignReportPage } from './pages/CampaignReportPage.js';
import { ActivityFeedPage } from './pages/ActivityFeedPage.js';
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
    developer: 'إعدادات المطور',
    autoreply: 'الرد الآلي',
    send:      'إرسال رسالة',
    reports:   'تقارير الحملات',
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
  if (page === 'settings') { loadSettings(); }
  if (page === 'developer') { loadDeveloperSettings(); }
  if (page === 'send') { loadSendMessage(); }
  if (page === 'reports') { loadReports(); }
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
let settingsPage = null;
let developerSettingsPage = null;
let sendMessagePage = null;
let campaignReportPage = null;
let activityFeedPage = null;
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
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
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
    await loadActivityFeed();
    await loadPhoneSwitcher();

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
    await loadTemplates();
  } catch (error) {
    showToast(`خطأ في حذف القالب: ${error.message}`, 'error');
  }
};

window.openNewTemplateModal = (editTemplate = null) => {
  const modal = document.getElementById('template-modal');
  if (modal) {
    modal.style.display = 'flex';
    // Reset form
    document.getElementById('template-form').reset();
    document.getElementById('buttons-container').innerHTML = '';
    document.getElementById('variables-list').innerHTML = '';
    document.getElementById('variables-examples-container').style.display = 'none';
    
    // Reset Header UI
    document.getElementById('tpl-header-type').value = 'NONE';
    document.getElementById('header-text-wrap').style.display = 'none';
    document.getElementById('header-media-wrap').style.display = 'none';
    document.getElementById('header-file-status').textContent = '';
    window.headerMediaId = null;

    if (editTemplate) {
        // Fill form for editing (rejected templates)
        document.getElementById('tpl-name').value = editTemplate.name;
        document.getElementById('tpl-category').value = editTemplate.category;
        document.getElementById('tpl-lang').value = editTemplate.language;
        
        const bodyComp = editTemplate.components.find(c => c.type === 'BODY');
        if (bodyComp) {
            document.getElementById('tpl-body').value = bodyComp.text;
            handleBodyInput();
            // Fill examples if they exist
            if (bodyComp.example?.body_text?.[0]) {
                const examples = bodyComp.example.body_text[0];
                examples.forEach((ex, idx) => {
                    const input = document.querySelector(`input[data-var="${idx + 1}"]`);
                    if (input) input.value = ex;
                });
            }
        }

        const headerComp = editTemplate.components.find(c => c.type === 'HEADER');
        if (headerComp) {
            document.getElementById('tpl-header-type').value = headerComp.format;
            handleHeaderTypeChange();
            if (headerComp.format === 'TEXT') {
                document.getElementById('tpl-header-text').value = headerComp.text;
            }
        }

        const footerComp = editTemplate.components.find(c => c.type === 'FOOTER');
        if (footerComp) {
            document.getElementById('tpl-footer').value = footerComp.text;
        }

        const btnComp = editTemplate.components.find(c => c.type === 'BUTTONS');
        if (btnComp) {
            btnComp.buttons.forEach(btn => {
                addTemplateButton(btn);
            });
        }
    }
    
    updateTemplatePreview();
  }
};

window.closeTemplateModal = () => {
  const modal = document.getElementById('template-modal');
  if (modal) modal.style.display = 'none';
};

window.editRejectedTemplate = async (tpl) => {
    if (confirm(`لتعديل القالب "${tpl.name}"، يجب حذفه أولاً من ميتا ثم إعادة إرساله. هل تريد المتابعة؟`)) {
        try {
            showToast('جاري حذف القالب القديم...', 'info');
            await WhatsAppAPI.deleteTemplate(tpl.name);
            window.openNewTemplateModal(tpl);
        } catch (error) {
            showToast('خطأ أثناء الحذف: ' + error.message, 'error');
            // Even if delete fails (maybe already deleted), try to open modal
            window.openNewTemplateModal(tpl);
        }
    }
};

window.handleHeaderTypeChange = () => {
    const type = document.getElementById('tpl-header-type').value;
    const textWrap = document.getElementById('header-text-wrap');
    const mediaWrap = document.getElementById('header-media-wrap');
    
    textWrap.style.display = (type === 'TEXT') ? 'block' : 'none';
    mediaWrap.style.display = (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(type)) ? 'block' : 'none';
    
    updateTemplatePreview();
};

window.handleHeaderFileChange = async () => {
    const fileInput = document.getElementById('tpl-header-file');
    const status = document.getElementById('header-file-status');
    const file = fileInput.files[0];
    
    if (!file) return;
    
    status.textContent = 'جاري الرفع...';
    try {
        const upload = await WhatsAppAPI.uploadMedia(file);
        window.headerMediaId = upload.id;
        status.textContent = '✅ تم الرفع';
        updateTemplatePreview();
    } catch (error) {
        status.textContent = '❌ فشل الرفع';
        showToast('فشل رفع الوسائط: ' + error.message, 'error');
    }
};

window.handleBodyInput = () => {
    const body = document.getElementById('tpl-body').value;
    const container = document.getElementById('variables-examples-container');
    const list = document.getElementById('variables-list');
    
    // Find variables like {{1}}, {{2}}
    const matches = body.match(/\{\{(\d+)\}\}/g);
    
    if (matches && matches.length > 0) {
        container.style.display = 'block';
        const uniqueVars = [...new Set(matches)].sort((a, b) => {
            return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]);
        });
        
        // Keep existing values if possible
        const currentValues = {};
        list.querySelectorAll('input').forEach(inp => {
            currentValues[inp.dataset.var] = inp.value;
        });
        
        list.innerHTML = uniqueVars.map(v => {
            const num = v.match(/\d+/)[0];
            return `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 12px; font-weight: 700; color: var(--text-muted); width: 30px;">{{${num}}}</span>
                    <input type="text" class="form-input var-example" data-var="${num}" placeholder="مثال للمتغير ${num}" value="${currentValues[num] || ''}" oninput="updateTemplatePreview()" style="flex: 1; padding: 6px 12px; font-size: 13px;">
                </div>
            `;
        }).join('');
    } else {
        container.style.display = 'none';
        list.innerHTML = '';
    }
    
    updateTemplatePreview();
};

window.addTemplateButton = (data = null) => {
  const container = document.getElementById('buttons-container');
  const btnCount = container.children.length;
  if (btnCount >= 3) {
    showToast('الحد الأقصى 3 أزرار', 'warning');
    return;
  }

  const btnHtml = `
    <div class="button-row" style="display: flex; gap: 10px; margin-bottom: 10px; background: var(--bg-elevated); padding: 10px; border-radius: 8px;">
      <select class="form-input btn-type" style="flex: 1;" onchange="updateTemplatePreview()">
        <option value="QUICK_REPLY" ${data?.type === 'QUICK_REPLY' ? 'selected' : ''}>رد سريع</option>
        <option value="URL" ${data?.type === 'URL' ? 'selected' : ''}>رابط موقع</option>
        <option value="PHONE_NUMBER" ${data?.type === 'PHONE_NUMBER' ? 'selected' : ''}>رقم هاتف</option>
      </select>
      <input type="text" class="form-input btn-text" placeholder="نص الزر" style="flex: 1;" value="${data?.text || ''}" oninput="updateTemplatePreview()">
      <input type="text" class="form-input btn-value" placeholder="الرابط/الرقم" style="flex: 1; display: ${data?.type && data.type !== 'QUICK_REPLY' ? 'block' : 'none'};" value="${data?.url || data?.phone_number || ''}" oninput="updateTemplatePreview()">
      <button class="btn btn-ghost" onclick="this.parentElement.remove(); updateTemplatePreview()" style="color: var(--status-error); padding: 0 5px;">✕</button>
    </div>
  `;
  const div = document.createElement('div');
  div.innerHTML = btnHtml;
  container.appendChild(div.firstElementChild);
  
  const lastRow = container.lastElementChild;
  const typeSelect = lastRow.querySelector('.btn-type');
  const valueInput = lastRow.querySelector('.btn-value');
  typeSelect.addEventListener('change', (e) => {
    valueInput.style.display = (e.target.value === 'QUICK_REPLY') ? 'none' : 'block';
  });
};

window.updateTemplatePreview = () => {
  const headerType = document.getElementById('tpl-header-type').value;
  const headerText = document.getElementById('tpl-header-text').value;
  const body = document.getElementById('tpl-body').value || 'محتوى الرسالة سيظهر هنا...';
  const footer = document.getElementById('tpl-footer').value;
  
  const preview = document.getElementById('template-preview-content');
  if (!preview) return;

  let html = '';
  
  // Header Preview
  if (headerType === 'TEXT' && headerText) {
      html += `<div style="font-weight: 700; margin-bottom: 8px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 5px; color: var(--text-primary);">${headerText}</div>`;
  } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType)) {
      const icon = headerType === 'IMAGE' ? '🖼️' : (headerType === 'VIDEO' ? '🎥' : '📄');
      html += `<div style="background: var(--bg-surface); height: 100px; border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-bottom: 10px; border: 1px dashed var(--border-subtle); font-size: 24px;">${icon}</div>`;
  }

  // Body Preview with variables replaced by examples
  let previewBody = body;
  document.querySelectorAll('.var-example').forEach(inp => {
      const num = inp.dataset.var;
      const val = inp.value || `[متغير ${num}]`;
      previewBody = previewBody.replace(new RegExp(`\\{\\{${num}\\}\\}`, 'g'), `<span style="color: var(--brand-primary); font-weight: 700;">${val}</span>`);
  });
  
  html += `<div style="white-space: pre-wrap; color: var(--text-primary); line-height: 1.5;">${previewBody}</div>`;
  
  if (footer) {
      html += `<div style="margin-top: 10px; font-size: 11px; color: var(--text-muted); border-top: 1px dashed var(--border-subtle); padding-top: 5px;">${footer}</div>`;
  }
  
  preview.innerHTML = html;

  // Preview Buttons
  const btnContainer = document.getElementById('buttons-container');
  const previewBtns = document.getElementById('template-preview-buttons');
  previewBtns.innerHTML = '';
  
  Array.from(btnContainer.querySelectorAll('.button-row')).forEach(row => {
    const text = row.querySelector('.btn-text').value || 'زر';
    const btn = document.createElement('div');
    btn.style.cssText = 'background: white; color: #00a884; border: 1px solid #e9edef; padding: 8px; border-radius: 8px; text-align: center; font-size: 12px; font-weight: 600; margin-top: 8px;';
    btn.textContent = text;
    previewBtns.appendChild(btn);
  });
};

window.saveTemplate = async () => {
  const submitBtn = document.querySelector('#template-modal .btn-primary');
  const originalText = submitBtn.textContent;
  
  try {
    const name = document.getElementById('tpl-name').value.toLowerCase().replace(/\s+/g, '_');
    const category = document.getElementById('tpl-category').value;
    const language = document.getElementById('tpl-lang').value;
    const headerType = document.getElementById('tpl-header-type').value;
    const headerText = document.getElementById('tpl-header-text').value;
    const bodyText = document.getElementById('tpl-body').value;
    const footerText = document.getElementById('tpl-footer').value;
    
    if (!name || !bodyText) {
      showToast('يرجى إدخال اسم القالب ومحتوى الرسالة', 'warning');
      return;
    }

    // Validate variables examples
    const varInputs = document.querySelectorAll('.var-example');
    const examples = [];
    let allExamplesFilled = true;
    varInputs.forEach(inp => {
        if (!inp.value) allExamplesFilled = false;
        examples.push(inp.value);
    });

    if (varInputs.length > 0 && !allExamplesFilled) {
        showToast('يرجى إدخال أمثلة لجميع المتغيرات', 'warning');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'جاري الحفظ...';

    const components = [];

    // Header Component
    if (headerType !== 'NONE') {
        const headerComp = {
            type: 'HEADER',
            format: headerType
        };
        if (headerType === 'TEXT') {
            headerComp.text = headerText;
        } else {
            if (!window.headerMediaId) {
                throw new Error('يرجى رفع ملف الوسائط للرأس');
            }
            headerComp.example = {
                header_handle: [window.headerMediaId]
            };
        }
        components.push(headerComp);
    }

    // Body Component
    const bodyComp = {
        type: 'BODY',
        text: bodyText
    };
    if (examples.length > 0) {
        bodyComp.example = {
            body_text: [examples]
        };
    }
    components.push(bodyComp);

    // Footer Component
    if (footerText) {
      components.push({
        type: 'FOOTER',
        text: footerText
      });
    }

    // Buttons Component
    const btnRows = Array.from(document.querySelectorAll('#buttons-container .button-row'));
    if (btnRows.length > 0) {
      const buttons = btnRows.map(row => {
        const type = row.querySelector('.btn-type').value;
        const text = row.querySelector('.btn-text').value;
        const value = row.querySelector('.btn-value').value;
        
        const btn = { type, text };
        if (type === 'URL') btn.url = value;
        if (type === 'PHONE_NUMBER') btn.phone_number = value;
        return btn;
      });
      components.push({
        type: 'BUTTONS',
        buttons: buttons
      });
    }

    // If we are editing a rejected template, we might need to delete the old one first 
    // or Meta might reject it because the name already exists.
    // However, the safest way is to ask the user to change the name slightly or handle it via API.
    // For now, let's ensure the payload is perfectly clean.

    const cleanComponents = components.map(c => {
        const clean = { type: c.type };
        if (c.text) clean.text = c.text;
        if (c.format) clean.format = c.format;
        if (c.example) clean.example = c.example;
        if (c.buttons) clean.buttons = c.buttons;
        return clean;
    });

    await WhatsAppAPI.createTemplate({
      name: name.trim(),
      category,
      language,
      components: cleanComponents
    });

    showToast('تم إرسال القالب للمراجعة بنجاح', 'success');
    window.closeTemplateModal();
    loadTemplates();
  } catch (error) {
    showToast(`خطأ: ${error.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
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

async function loadSettings() {
  const container = document.getElementById('whatsapp-settings-root');
  if (!container) return;

  if (!settingsPage) {
    settingsPage = new SettingsPage(container);
  }

  await settingsPage.load();
}

window.loadSettings = loadSettings;

async function loadDeveloperSettings() {
  const container = document.getElementById('whatsapp-developer-root');
  if (!container) return;

  if (!developerSettingsPage) {
    developerSettingsPage = new DeveloperSettingsPage(container);
  }

  await developerSettingsPage.mount();
}

window.loadDeveloperSettings = loadDeveloperSettings;

async function loadSendMessage() {
  const container = document.getElementById('whatsapp-send-root');
  if (!container) return;

  if (!sendMessagePage) {
    sendMessagePage = new SendMessagePage(container);
  }

  await sendMessagePage.load();
}

window.loadSendMessage = loadSendMessage;

async function loadReports(campaignData = null) {
  const container = document.getElementById('whatsapp-reports-root');
  if (!container) return;

  if (!campaignReportPage) {
    campaignReportPage = new CampaignReportPage(container);
  }

  await campaignReportPage.load(campaignData);
}

window.loadReports = loadReports;

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

// ─── Phone Number Switcher (الشريط العلوي) ────────────

async function loadPhoneSwitcher() {
  try {
    const wrap  = document.getElementById('phone-switcher');
    const menu  = document.getElementById('phone-switcher-menu');
    const label = document.getElementById('phone-switcher-label');
    if (!wrap || !menu || !label) return;

    const channels = await SupabaseIntegration.getWhatsAppChannels();

    if (!channels || channels.length === 0) {
      wrap.style.display = 'none';
      return;
    }

    const activeId = localStorage.getItem('mad3oom_wa_phone_id');
    const active = channels.find(c => c.metadata?.phone_number_id === activeId) || channels[0];
    const activeIdResolved = active?.metadata?.phone_number_id || '';

    label.textContent = active?.metadata?.phone_number || activeIdResolved || 'اختر رقم';

    menu.innerHTML = channels.map(c => {
      const id = c.metadata?.phone_number_id || '';
      const name = c.metadata?.phone_number || id || '—';
      const isActive = id === activeIdResolved;
      return `
        <a href="#" onclick="window.selectActivePhone('${id}'); return false;" style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <span>${name}</span>
          ${isActive ? `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14" style="color: var(--brand-primary); flex-shrink: 0;"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}
        </a>
      `;
    }).join('');

    wrap.style.display = 'block';
  } catch (error) {
    console.error('[App] loadPhoneSwitcher failed:', error);
  }
}

window.loadPhoneSwitcher = loadPhoneSwitcher;

window.togglePhoneSwitcher = function(event) {
  event.stopPropagation();
  document.getElementById('phone-switcher-menu')?.classList.toggle('show');
};

window.selectActivePhone = function(phoneId) {
  if (!phoneId) return;
  localStorage.setItem('mad3oom_wa_phone_id', phoneId);
  document.getElementById('phone-switcher-menu')?.classList.remove('show');
  location.reload();
};

document.addEventListener('click', () => {
  document.getElementById('phone-switcher-menu')?.classList.remove('show');
});

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
              <div style="font-weight: 600; color: var(--text-primary);">${int.metadata?.phone_number || int.phone || 'رقم غير معروف'}</div>
              <div style="font-size: 12px; color: var(--text-muted);">ID: ${int.metadata?.phone_number_id || 'غير متوفر'}</div>
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
    updateStatsCounters();
    
    document.getElementById('stat-delivery-rate').textContent = (stats.qualityRating || '—');
    document.getElementById('stat-delivery-change').textContent = 'من Meta';

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
      loadPhoneSwitcher();
    }, 1000);

  } else if (state.status === 'error') {

    showToast(`خطأ: ${state.errorMsg}`, 'error');

  }

}

// ─── Disconnect Handler ──────────────────────────

window.handleDisconnect = function(phoneId = null) {
  const modal = document.getElementById('delete-confirm-modal');
  const confirmBtn = document.getElementById('confirm-delete-btn');
  
  if (!modal || !confirmBtn) return;

  modal.style.display = 'flex';

  // تنظيف أي مستمعات أحداث سابقة لتجنب الحذف المتعدد
  const newConfirmBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

  newConfirmBtn.onclick = async () => {
    newConfirmBtn.disabled = true;
    newConfirmBtn.textContent = 'جاري الحذف...';
    
    // التأكد من تحويل القيم النصية غير الصالحة إلى null
    const cleanPhoneId = (phoneId === 'undefined' || phoneId === 'null' || !phoneId) ? null : phoneId;
    
    try {
      const result = await SupabaseIntegration.deleteIntegration(cleanPhoneId);
      if (result.success) {
        showToast('تم حذف الربط بنجاح', 'success');
        closeDeleteModal();
        updateConnectionStatus();
        updateDashboard();
        loadPhoneSwitcher();
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      showToast(`خطأ: ${error.message}`, 'error');
    } finally {
      newConfirmBtn.disabled = false;
      newConfirmBtn.textContent = 'حذف الآن';
    }
  };
};

window.closeDeleteModal = function() {
  const modal = document.getElementById('delete-confirm-modal');
  if (modal) modal.style.display = 'none';
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

// ─── Activity Feed Handler ──────────────────────

async function loadActivityFeed() {
  const container = document.getElementById('activity-feed-container');
  if (!container) return;

  if (!activityFeedPage) {
    activityFeedPage = new ActivityFeedPage(container);
  }

  await activityFeedPage.load();
}

window.loadActivityFeed = loadActivityFeed;

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
    padding: 12px 24px; border-radius: 12px; color: white; font-weight: 600;
    z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    animation: toastIn 0.3s ease-out;
  `;
  
  if (type === 'success') toast.style.background = '#00c853';
  else if (type === 'error') toast.style.background = '#ff5252';
  else if (type === 'warning') toast.style.background = '#ffab00';
  else toast.style.background = '#2196f3';

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

window.showToast = showToast;

async function updateStatsCounters() {
  try {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const userId = await SupabaseIntegration.getCurrentUserId();
    if (!userId) return;

    // 1. Get Today's Sent Messages Count
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { count: sentToday, error: msgError } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('direction', 'outbound')
      .gte('timestamp', today.toISOString());

    if (!msgError) {
      document.getElementById('stat-sent-count').textContent = sentToday || 0;
      document.getElementById('stat-sent-change').textContent = 'اليوم';
      document.getElementById('stat-sent-change').style.color = 'var(--status-success)';
    }

    // 2. Get Active Templates Count from Meta API
    try {
      const templatesResponse = await WhatsAppAPI.getTemplates();
      if (templatesResponse && templatesResponse.data) {
        const activeTemplates = templatesResponse.data.filter(t => t.status === 'APPROVED').length;
        document.getElementById('stat-templates-count').textContent = activeTemplates;
        document.getElementById('stat-templates-change').textContent = 'قوالب معتمدة';
        document.getElementById('stat-templates-change').style.color = 'var(--status-success)';
      }
    } catch (tplError) {
      console.error('[App] Error fetching templates count:', tplError);
      document.getElementById('stat-templates-count').textContent = '0';
      document.getElementById('stat-templates-change').textContent = 'تحقق من الربط';
    }

  } catch (error) {
    console.error('[App] Error updating stats counters:', error);
  }
}

window.updateStatsCounters = updateStatsCounters;
