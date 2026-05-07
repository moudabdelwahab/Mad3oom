import { supabase } from './api-config.js';
import { updateProfile, updatePassword } from './auth-client.js';

let currentUser = null;
let currentSecret = null;
let currentRecoveryCodes = [];

/**
 * Initialize the customer settings modal
 */
export async function initCustomerSettingsModal() {
    const container = document.createElement('div');
    container.id = 'settings-modal-container';
    document.body.appendChild(container);

    // Load the modal HTML
    try {
        const response = await fetch('/customer-settings-modal.html');
        const html = await response.text();
        container.innerHTML = html;
        setupSettingsModalLogic();
    } catch (err) {
        console.error('Error loading settings modal:', err);
    }
}

/**
 * Setup all modal logic and event listeners
 */
async function setupSettingsModalLogic() {
    const modal = document.getElementById('customerSettingsModal');
    const closeBtn = document.getElementById('closeSettingsModal');
    const closeFooterBtn = document.getElementById('closeSettingsBtn');
    const setupModal = document.getElementById('setupModal');
    const recoveryModal = document.getElementById('recoveryModal');

    if (!modal) return;

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        console.error('No user logged in');
        return;
    }

    currentUser = user;

    // Load user profile data
    await loadUserProfile();

    // Setup tab switching
    setupTabSwitching();

    // Setup general settings
    setupGeneralSettings();

    // Setup account settings
    setupAccountSettings();

    // Setup security settings
    await setupSecuritySettings();

    // Close modal handlers
    if (closeBtn) {
        closeBtn.addEventListener('click', () => closeSettingsModal());
    }

    if (closeFooterBtn) {
        closeFooterBtn.addEventListener('click', () => closeSettingsModal());
    }

    // Close on outside click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeSettingsModal();
        }
    });

    // Close nested modals on outside click
    if (setupModal) {
        setupModal.addEventListener('click', (e) => {
            if (e.target === setupModal) {
                setupModal.classList.remove('active');
            }
        });
    }

    if (recoveryModal) {
        recoveryModal.addEventListener('click', (e) => {
            if (e.target === recoveryModal) {
                recoveryModal.classList.remove('active');
            }
        });
    }

    // Close nested modals with buttons
    document.getElementById('closeSetupModal')?.addEventListener('click', () => {
        setupModal.classList.remove('active');
    });

    document.getElementById('closeRecoveryModal')?.addEventListener('click', () => {
        recoveryModal.classList.remove('active');
    });

    document.getElementById('closeRecoveryBtn')?.addEventListener('click', () => {
        recoveryModal.classList.remove('active');
    });
}

/**
 * Load user profile data from Supabase
 */
async function loadUserProfile() {
    try {
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', currentUser.id)
            .single();

        if (error) throw error;

        if (profile) {
            document.getElementById('fullNameInput').value = profile.full_name || '';
            document.getElementById('emailInput').value = profile.email || currentUser.email || '';
            document.getElementById('bioInput').value = profile.bio || '';

            // Update 2FA UI based on profile
            if (profile.two_factor_enabled) {
                updateTwoFaUI(true);
            }
        }
    } catch (err) {
        console.error('Error loading profile:', err);
    }
}

/**
 * Setup tab switching functionality
 */
function setupTabSwitching() {
    const tabButtons = document.querySelectorAll('.settings-tab-btn');
    const tabContents = document.querySelectorAll('.settings-tab-content');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.getAttribute('data-tab');

            // Update active button
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update active content
            tabContents.forEach(content => {
                if (content.getAttribute('data-tab') === tabName) {
                    content.classList.add('active');
                    content.style.display = 'block';
                } else {
                    content.classList.remove('active');
                    content.style.display = 'none';
                }
            });
        });
    });
}

/**
 * Setup general settings (language and theme)
 */
function setupGeneralSettings() {
    const languageSelect = document.getElementById('languageSelect');
    const themeButtons = document.querySelectorAll('.theme-option-btn');

    // Load saved language
    const savedLanguage = localStorage.getItem('mad3oom-language') || 'ar';
    languageSelect.value = savedLanguage;

    // Language change handler
    languageSelect.addEventListener('change', (e) => {
        const lang = e.target.value;
        localStorage.setItem('mad3oom-language', lang);

        if (window.languageManager) {
            window.languageManager.setLanguage(lang);
        } else {
            const html = document.documentElement;
            html.lang = lang;
            html.dir = lang === 'ar' ? 'rtl' : 'ltr';
            document.body.style.direction = lang === 'ar' ? 'rtl' : 'ltr';
        }

        showAlert('تم تغيير اللغة بنجاح', 'success');
    });

    // Load saved theme
    const savedTheme = localStorage.getItem('theme-preference') || 'light';
    themeButtons.forEach(btn => {
        if (btn.getAttribute('data-theme') === savedTheme) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }

        btn.addEventListener('click', () => {
            const theme = btn.getAttribute('data-theme');
            localStorage.setItem('theme-preference', theme);

            if (window.themeManager) {
                window.themeManager.setTheme(theme);
            } else {
                document.documentElement.setAttribute('data-theme', theme);
            }

            // Update button states
            themeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            showAlert('تم تغيير السمة بنجاح', 'success');
        });
    });
}

/**
 * Setup account settings (profile and password)
 */
function setupAccountSettings() {
    const saveProfileBtn = document.getElementById('saveProfileBtn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');

    // Save profile handler
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', async () => {
            const fullName = document.getElementById('fullNameInput').value.trim();
            const bio = document.getElementById('bioInput').value.trim();

            if (!fullName) {
                showAlert('يرجى إدخال الاسم الكامل', 'error');
                return;
            }

            saveProfileBtn.disabled = true;
            saveProfileBtn.textContent = 'جاري الحفظ...';

            try {
                const { error } = await updateProfile({
                    full_name: fullName,
                    bio: bio
                });

                if (error) {
                    throw error;
                }

                showAlert('تم حفظ البيانات بنجاح', 'success');
            } catch (err) {
                console.error('Error saving profile:', err);
                showAlert(err.message || 'فشل حفظ البيانات', 'error');
            } finally {
                saveProfileBtn.disabled = false;
                saveProfileBtn.textContent = 'حفظ التغييرات';
            }
        });
    }

    // Change password handler
    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', async () => {
            const newPassword = document.getElementById('newPasswordInput').value;
            const confirmPassword = document.getElementById('confirmPasswordInput').value;

            if (!newPassword || !confirmPassword) {
                showAlert('يرجى إدخال كلمة المرور الجديدة والتأكيد', 'error');
                return;
            }

            if (newPassword !== confirmPassword) {
                showAlert('كلمات المرور غير متطابقة', 'error');
                return;
            }

            if (newPassword.length < 8) {
                showAlert('يجب أن تكون كلمة المرور 8 أحرف على الأقل', 'error');
                return;
            }

            changePasswordBtn.disabled = true;
            changePasswordBtn.textContent = 'جاري التحديث...';

            try {
                const { error } = await updatePassword(newPassword);

                if (error) {
                    throw error;
                }

                document.getElementById('newPasswordInput').value = '';
                document.getElementById('confirmPasswordInput').value = '';
                showAlert('تم تحديث كلمة المرور بنجاح', 'success');
            } catch (err) {
                console.error('Error changing password:', err);
                showAlert(err.message || 'فشل تحديث كلمة المرور', 'error');
            } finally {
                changePasswordBtn.disabled = false;
                changePasswordBtn.textContent = 'تحديث كلمة المرور';
            }
        });
    }
}

/**
 * Setup security settings (2FA and trusted devices)
 */
async function setupSecuritySettings() {
    const setupTwoFaBtn = document.getElementById('setupTwoFaBtn');
    const viewRecoveryCodesBtn = document.getElementById('viewRecoveryCodesBtn');
    const disableTwoFaBtn = document.getElementById('disableTwoFaBtn');
    const setupModal = document.getElementById('setupModal');

    // Load 2FA status
    await load2FAStatus();

    // Load trusted devices
    await loadTrustedDevices();

    // Setup 2FA button
    if (setupTwoFaBtn) {
        setupTwoFaBtn.addEventListener('click', async () => {
            try {
                // Generate 2FA secret
                const { data, error } = await supabase.functions.invoke('generate-2fa-secret');

                if (error) throw error;

                const { base32, otpauth_url } = data;
                currentSecret = base32;
                sessionStorage.setItem('temp_2fa_secret', base32);

                // Display QR code and secret
                document.getElementById('secretKeyDisplay').value = base32;
                const qrContainer = document.getElementById('qrCodeContainer');
                qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpauth_url)}" alt="QR Code">`;

                // Reset steps
                document.getElementById('setupStep1').style.display = 'block';
                document.getElementById('setupStep2').style.display = 'none';

                setupModal.classList.add('active');
            } catch (err) {
                console.error('Error generating 2FA secret:', err);
                showAlert('فشل إنشاء التحقق بخطوتين', 'error');
            }
        });
    }

    // Verify and enable 2FA
    document.getElementById('verifyAndEnableBtn')?.addEventListener('click', async () => {
        const code = document.getElementById('verificationCode').value;

        if (code.length !== 6) {
            showAlert('يرجى إدخال رمز مكون من 6 أرقام', 'error');
            return;
        }

        try {
            // Verify code
            const { data, error } = await supabase.functions.invoke('verify-2fa-code', {
                body: { code, tempSecret: currentSecret }
            });

            if (error || !data.valid) {
                throw new Error('الرمز غير صحيح');
            }

            // Generate recovery codes
            const recoveryCodes = generateRecoveryCodes();
            currentRecoveryCodes = recoveryCodes;

            // Enable 2FA in database
            const { error: updateError } = await supabase
                .from('profiles')
                .update({
                    two_factor_enabled: true,
                    two_factor_secret: currentSecret,
                    recovery_codes: recoveryCodes
                })
                .eq('id', currentUser.id);

            if (updateError) throw updateError;

            setupModal.classList.remove('active');
            document.getElementById('verificationCode').value = '';
            await load2FAStatus();
            showRecoveryCodes();
            showAlert('تم تفعيل التحقق بخطوتين بنجاح', 'success');
        } catch (err) {
            console.error('Error enabling 2FA:', err);
            showAlert(err.message || 'فشل تفعيل التحقق بخطوتين', 'error');
        }
    });

    // View recovery codes
    if (viewRecoveryCodesBtn) {
        viewRecoveryCodesBtn.addEventListener('click', async () => {
            try {
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('recovery_codes')
                    .eq('id', currentUser.id)
                    .single();

                if (profile?.recovery_codes) {
                    currentRecoveryCodes = profile.recovery_codes;
                    showRecoveryCodes();
                }
            } catch (err) {
                console.error('Error loading recovery codes:', err);
                showAlert('فشل تحميل رموز الاستعادة', 'error');
            }
        });
    }

    // Disable 2FA
    if (disableTwoFaBtn) {
        disableTwoFaBtn.addEventListener('click', async () => {
            if (!confirm('هل أنت متأكد من تعطيل التحقق بخطوتين؟ سيقلل هذا من أمان حسابك.')) {
                return;
            }

            try {
                const { error } = await supabase
                    .from('profiles')
                    .update({
                        two_factor_enabled: false,
                        two_factor_secret: null,
                        recovery_codes: null
                    })
                    .eq('id', currentUser.id);

                if (error) throw error;

                await load2FAStatus();
                showAlert('تم تعطيل التحقق بخطوتين', 'success');
            } catch (err) {
                console.error('Error disabling 2FA:', err);
                showAlert('فشل تعطيل التحقق بخطوتين', 'error');
            }
        });
    }

    // Copy secret button
    document.getElementById('copySecretBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(currentSecret);
        const btn = document.getElementById('copySecretBtn');
        btn.textContent = 'تم النسخ!';
        setTimeout(() => {
            btn.textContent = 'نسخ';
        }, 2000);
    });

    // Print recovery codes
    document.getElementById('printCodesBtn')?.addEventListener('click', () => {
        window.print();
    });

    // Step navigation
    document.getElementById('goToStep2')?.addEventListener('click', () => {
        document.getElementById('setupStep1').style.display = 'none';
        document.getElementById('setupStep2').style.display = 'block';
    });

    document.getElementById('backToStep1')?.addEventListener('click', () => {
        document.getElementById('setupStep1').style.display = 'block';
        document.getElementById('setupStep2').style.display = 'none';
    });
}

/**
 * Load 2FA status
 */
async function load2FAStatus() {
    try {
        const { data: profile } = await supabase
            .from('profiles')
            .select('two_factor_enabled')
            .eq('id', currentUser.id)
            .single();

        updateTwoFaUI(profile?.two_factor_enabled || false);
    } catch (err) {
        console.error('Error loading 2FA status:', err);
    }
}

/**
 * Update 2FA UI based on status
 */
function updateTwoFaUI(enabled) {
    const statusIcon = document.getElementById('twoFaStatusIcon');
    const statusTitle = document.getElementById('twoFaStatusTitle');
    const statusDesc = document.getElementById('twoFaStatusDesc');
    const setupBtn = document.getElementById('setupTwoFaBtn');
    const managementSection = document.getElementById('twoFaManagementSection');

    if (enabled) {
        statusIcon.classList.remove('disabled');
        statusIcon.classList.add('enabled');
        statusIcon.style.background = 'rgba(46, 138, 58, 0.1)';
        statusIcon.style.color = 'var(--color-success)';
        statusTitle.textContent = 'التحقق بخطوتين مفعل';
        statusDesc.textContent = 'حسابك محمي بالتحقق بخطوتين.';
        setupBtn.style.display = 'none';
        managementSection.style.display = 'block';
    } else {
        statusIcon.classList.add('disabled');
        statusIcon.classList.remove('enabled');
        statusIcon.style.background = 'rgba(217, 83, 79, 0.1)';
        statusIcon.style.color = 'var(--color-danger)';
        statusTitle.textContent = 'التحقق بخطوتين غير مفعل';
        statusDesc.textContent = 'أضف طبقة أمان إضافية لحسابك لمنع الوصول غير المصرح به.';
        setupBtn.style.display = 'inline-block';
        managementSection.style.display = 'none';
    }
}

/**
 * Load trusted devices
 */
async function loadTrustedDevices() {
    try {
        const { data: devices, error } = await supabase
            .from('trusted_devices')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('last_used_at', { ascending: false });

        if (error) throw error;

        const devicesList = document.getElementById('trustedDevicesList');
        if (!devicesList) return;

        if (!devices || devices.length === 0) {
            devicesList.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--color-text-secondary);">لا توجد أجهزة موثوقة</div>';
            return;
        }

        devicesList.innerHTML = devices.map(device => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: var(--color-background); border: 1px solid var(--color-border); border-radius: 0.75rem;">
                <div style="flex: 1;">
                    <h4 style="margin: 0; font-size: 1rem; font-weight: 600; color: var(--color-text);">${device.device_name || 'جهاز بدون اسم'}</h4>
                    <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
                        <span style="display: inline-block; background: var(--color-muted); padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-family: monospace; font-size: 0.75rem;">${device.ip_address || 'N/A'}</span>
                    </p>
                    <p style="margin: 0.25rem 0 0; font-size: 0.8rem; color: var(--color-text-secondary);">آخر استخدام: ${new Date(device.last_used_at).toLocaleString('ar-EG')}</p>
                </div>
                <button onclick="window.removeDevice('${device.id}')" style="padding: 0.5rem 1rem; background: rgba(217, 83, 79, 0.1); color: var(--color-danger); border: 1px solid var(--color-danger); border-radius: 0.5rem; font-weight: 600; cursor: pointer;">إزالة</button>
            </div>
        `).join('');
    } catch (err) {
        console.error('Error loading trusted devices:', err);
    }
}

/**
 * Remove device
 */
window.removeDevice = async (deviceId) => {
    if (!confirm('هل أنت متأكد من إزالة هذا الجهاز؟')) {
        return;
    }

    try {
        const { error } = await supabase
            .from('trusted_devices')
            .delete()
            .eq('id', deviceId);

        if (error) throw error;

        await loadTrustedDevices();
        showAlert('تم إزالة الجهاز بنجاح', 'success');
    } catch (err) {
        console.error('Error removing device:', err);
        showAlert('فشل إزالة الجهاز', 'error');
    }
};

/**
 * Generate recovery codes
 */
function generateRecoveryCodes(count = 8) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        const code = Math.random().toString(36).substring(2, 10).toUpperCase();
        codes.push(code);
    }
    return codes;
}

/**
 * Show recovery codes modal
 */
function showRecoveryCodes() {
    const grid = document.getElementById('recoveryCodesGrid');
    grid.innerHTML = currentRecoveryCodes.map(code => `<div class="recovery-code">${code}</div>`).join('');
    document.getElementById('recoveryModal').classList.add('active');
}

/**
 * Show alert message
 */
function showAlert(message, type) {
    const alert = document.getElementById('settingsAlert');
    if (!alert) return;

    alert.textContent = message;
    alert.className = `alert alert-${type}`;
    alert.style.display = 'block';

    setTimeout(() => {
        alert.style.display = 'none';
    }, 5000);
}

/**
 * Open settings modal
 */
export function openSettingsModal() {
    const modal = document.getElementById('customerSettingsModal');
    if (modal) {
        modal.classList.add('active');
    }
}

/**
 * Close settings modal
 */
function closeSettingsModal() {
    const modal = document.getElementById('customerSettingsModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

/**
 * Export for global access
 */
window.openSettingsModal = openSettingsModal;
