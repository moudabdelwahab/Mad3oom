import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { logActivity } from '/activity-service.js';

let user = null;
let currentSettings = {};
let allRoles = [];

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    await loadAllSettings();
    setupEventListeners();
    renderWorkingHours();
}

async function loadAllSettings() {
    try {
        // 1. Load Profile Data
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError) throw profileError;

        document.getElementById('fullName').value = profile.full_name || '';
        document.getElementById('email').value = user.email || '';
        document.getElementById('bio').value = profile.bio || '';
        updateAvatarUI(profile.full_name, profile.avatar_url);

        // 2. Load Platform Control Settings
        const { data: platformSettings } = await supabase
            .from('advanced_settings')
            .select('*')
            .eq('key', 'platform_control')
            .maybeSingle();

        if (platformSettings?.value) {
            const settings = platformSettings.value;
            document.getElementById('sessionTimeout').value = settings.session_timeout || '30';
            document.getElementById('preventMultipleSessions').checked = settings.prevent_multiple_sessions || false;
            document.getElementById('restrictByCountry').checked = settings.restrict_by_country || false;
            document.getElementById('allowedCountries').value = settings.allowed_countries || '';
            document.getElementById('restrictByIP').checked = settings.restrict_by_ip || false;
            document.getElementById('ipRestrictionType').value = settings.ip_restriction_type || 'whitelist';
            document.getElementById('ipList').value = settings.ip_list || '';
            
            if (settings.restrict_by_country) document.getElementById('countryRestrictionSettings').style.display = 'block';
            if (settings.restrict_by_ip) document.getElementById('ipRestrictionSettings').style.display = 'block';
        }

        // 3. Load Communication Control Settings
        const { data: commSettings } = await supabase
            .from('advanced_settings')
            .select('*')
            .eq('key', 'communication_control')
            .maybeSingle();

        if (commSettings?.value) {
            const settings = commSettings.value;
            document.getElementById('maxOpenTickets').value = settings.max_open_tickets || '5';
            document.getElementById('preventDuplicateTickets').checked = settings.prevent_duplicate_tickets !== false;
            document.getElementById('bannedWords').value = settings.banned_words || '';
            document.getElementById('maxMessagesPerMinute').value = settings.max_messages_per_minute || '10';
            document.getElementById('maxMessagesPerHour').value = settings.max_messages_per_hour || '100';
        }

        // 4. Load Emergency Mode Settings
        const { data: emergencySettings } = await supabase
            .from('advanced_settings')
            .select('*')
            .eq('key', 'emergency_mode')
            .maybeSingle();

        if (emergencySettings?.value) {
            const settings = emergencySettings.value;
            document.getElementById('emergencyModeEnabled').checked = settings.enabled || false;
            document.getElementById('disableTicketCreation').checked = settings.disable_ticket_creation || false;
            document.getElementById('disableReplies').checked = settings.disable_replies || false;
            document.getElementById('botOnlyMode').checked = settings.bot_only_mode || false;
            document.getElementById('emergencyMessageCreation').value = settings.message_creation || '';
            document.getElementById('emergencyMessageReplies').value = settings.message_replies || '';
            
            if (settings.enabled) document.getElementById('emergencySettings').style.display = 'block';
        }

        // 5. Load Account Policies
        const { data: accountPolicies } = await supabase
            .from('advanced_settings')
            .select('*')
            .eq('key', 'account_policies')
            .maybeSingle();

        if (accountPolicies?.value) {
            const settings = accountPolicies.value;
            document.getElementById('passwordChangeInterval').value = settings.password_change_interval || '90';
            document.getElementById('passwordStrength').value = settings.password_strength || 'medium';
            document.getElementById('failedLoginAttempts').value = settings.failed_login_attempts || '5';
            document.getElementById('lockoutDuration').value = settings.lockout_duration || '30';
            document.getElementById('force2FAForAdmins').checked = settings.force_2fa_admins || false;
        }

        // 6. Load Customer Experience Settings
        const { data: customerExpSettings } = await supabase
            .from('advanced_settings')
            .select('*')
            .eq('key', 'customer_experience')
            .maybeSingle();

        if (customerExpSettings?.value) {
            const settings = customerExpSettings.value;
            document.getElementById('allowNewRegistrations').checked = settings.allow_new_registrations !== false;
            document.getElementById('enableRewardsSystem').checked = settings.enable_rewards_system !== false;
            document.getElementById('customerWelcomeMessage').value = settings.customer_welcome_message || '';
            document.getElementById('allowTicketAttachments').checked = settings.allow_ticket_attachments !== false;
            document.getElementById('allowTicketRating').checked = settings.allow_ticket_rating !== false;
            document.getElementById('showSupportOnlineStatus').checked = settings.show_support_online_status !== false;
        }

        // 7. Load Working Hours
        const { data: workingHours } = await supabase
            .from('working_hours')
            .select('*')
            .order('day_of_week', { ascending: true });

        if (workingHours) {
            currentSettings.workingHours = workingHours;
        }

        const { data: afterHoursSettings } = await supabase
            .from('advanced_settings')
            .select('*')
            .eq('key', 'after_hours')
            .maybeSingle();

        if (afterHoursSettings?.value) {
            const settings = afterHoursSettings.value;
            document.getElementById('afterHoursAutoReply').value = settings.auto_reply || '';
            document.getElementById('botAfterHours').checked = settings.bot_after_hours || false;
        }

        // 8. Load Bot Settings
        const { data: botSettings } = await supabase.from('bot_settings').select('*').limit(1).maybeSingle();
        if (botSettings) {
            document.getElementById('smartMemoryEnabled').checked = botSettings.smart_memory_enabled || false;
            document.getElementById('botSystemPrompt').value = botSettings.system_prompt || '';
        }

        // 9. Load Ads Settings
        const { data: adsSettings } = await supabase.from('ads_settings').select('*').limit(1).maybeSingle();
        if (adsSettings) {
            document.getElementById('topAdsEnabled').checked = adsSettings.enabled || false;
            document.getElementById('adsContent').value = adsSettings.content || '';
            document.getElementById('adsLink').value = adsSettings.link || '';
        }

        // 10. Load API Keys
        const { data: apiKeys } = await supabase.from('api_keys').select('*').limit(1).maybeSingle();
        if (apiKeys) {
            document.getElementById('openaiKey').value = apiKeys.openai_key || '';
            document.getElementById('telegramBotToken').value = apiKeys.telegram_token || '';
        }

        // 11. Load Rules, Roles & Users
        await loadRules();
        await loadCustomRoles();
        await loadUsers();
        await loadActiveDevices();

    } catch (error) {
        console.error('Error loading settings:', error);
        showAlert('حدث خطأ أثناء تحميل الإعدادات', 'error');
    }
}

async function loadRules() {
    try {
        const { data: rules } = await supabase
            .from('rules_engine')
            .select('*')
            .order('priority', { ascending: false });

        const rulesBody = document.getElementById('rulesBody');
        if (!rulesBody) return;

        if (!rules || rules.length === 0) {
            rulesBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 2rem;">لا توجد قواعد محددة</td></tr>';
            return;
        }

        rulesBody.innerHTML = rules.map(rule => `
            <tr>
                <td>${rule.name}</td>
                <td>${rule.trigger_event}</td>
                <td>${JSON.stringify(rule.conditions).substring(0, 30)}...</td>
                <td>${JSON.stringify(rule.actions).substring(0, 30)}...</td>
                <td><span class="badge ${rule.is_active ? 'badge-success' : 'badge-warning'}">${rule.is_active ? 'نشط' : 'معطل'}</span></td>
                <td>
                    <button class="btn btn-secondary btn-sm edit-rule-btn" data-rule-id="${rule.id}">تعديل</button>
                    <button class="btn btn-danger btn-sm delete-rule-btn" data-rule-id="${rule.id}">حذف</button>
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.delete-rule-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteRule(btn.dataset.ruleId));
        });
        
        document.querySelectorAll('.edit-rule-btn').forEach(btn => {
            btn.addEventListener('click', () => editRule(btn.dataset.ruleId));
        });
    } catch (error) {
        console.error('Error loading rules:', error);
    }
}

async function loadCustomRoles() {
    try {
        const { data: roles } = await supabase
            .from('custom_roles')
            .select('*')
            .order('created_at', { ascending: false });

        allRoles = roles || [];
        const rolesBody = document.getElementById('rolesBody');
        const userRoleSelect = document.getElementById('userRole');
        if (!rolesBody) return;

        if (!roles || roles.length === 0) {
            rolesBody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem;">لا توجد أدوار مخصصة</td></tr>';
            return;
        }

        rolesBody.innerHTML = roles.map(role => {
            const permCount = Object.keys(role.permissions || {}).filter(k => role.permissions[k]).length;
            return `
                <tr>
                    <td>${role.name}</td>
                    <td>${role.description || '-'}</td>
                    <td>${permCount}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm edit-role-btn" data-role-id="${role.id}">تعديل</button>
                        <button class="btn btn-danger btn-sm delete-role-btn" data-role-id="${role.id}">حذف</button>
                    </td>
                </tr>
            `;
        }).join('');

        // Update user role select
        if (userRoleSelect) {
            userRoleSelect.innerHTML = '<option value="">اختر دوراً...</option>' + 
                roles.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
        }

        document.querySelectorAll('.delete-role-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteRole(btn.dataset.roleId));
        });
        
        document.querySelectorAll('.edit-role-btn').forEach(btn => {
            btn.addEventListener('click', () => editRole(btn.dataset.roleId));
        });
    } catch (error) {
        console.error('Error loading roles:', error);
    }
}

async function loadUsers() {
    try {
        const { data: users, error } = await supabase
            .from('profiles')
            .select('*, custom_roles(name)')
            .not('role', 'eq', 'customer')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const usersBody = document.getElementById('usersBody');
        if (!usersBody) return;

        if (!users || users.length === 0) {
            usersBody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem;">لا يوجد مستخدمين إداريين</td></tr>';
            return;
        }

        usersBody.innerHTML = users.map(u => `
            <tr>
                <td>${u.full_name || 'بدون اسم'}</td>
                <td>${u.email || '-'}</td>
                <td><span class="badge badge-info">${u.custom_roles?.name || u.role}</span></td>
                <td>
                    <button class="btn btn-secondary btn-sm edit-user-btn" data-user-id="${u.id}">تعديل</button>
                    <button class="btn btn-danger btn-sm delete-user-btn" data-user-id="${u.id}">حذف</button>
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.delete-user-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteUser(btn.dataset.userId));
        });
        
        document.querySelectorAll('.edit-user-btn').forEach(btn => {
            btn.addEventListener('click', () => editUser(btn.dataset.userId));
        });
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

function setupEventListeners() {
    // Navigation Logic
    const handleNavigation = (targetId) => {
        if (!targetId) targetId = 'profile';
        
        // Update Nav Links
        document.querySelectorAll('.nav-link').forEach(link => {
            const href = link.getAttribute('href').substring(1);
            if (href === targetId) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
        
        // Update Sections Visibility
        document.querySelectorAll('.settings-card').forEach(card => {
            if (card.id === targetId) {
                card.style.display = 'block';
            } else {
                card.style.display = 'none';
            }
        });

        // Load section specific data if needed
        if (targetId === 'device-management') {
            loadActiveDevices();
        }
    };

    // Listen for hash changes
    window.addEventListener('hashchange', () => {
        const targetId = window.location.hash.substring(1);
        handleNavigation(targetId);
    });

    // Initial navigation based on current hash
    if (window.location.hash) {
        handleNavigation(window.location.hash.substring(1));
    }

    // Navigation Click Handler
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            // Let the hashchange event handle the visibility
            // but we can also call it directly for smoother feel
            const targetId = link.getAttribute('href').substring(1);
            handleNavigation(targetId);
        });
    });

    // Save Buttons
    document.getElementById('saveProfileBtn')?.addEventListener('click', saveProfile);
    
    document.getElementById('changeAvatarBtn')?.addEventListener('click', () => {
        document.getElementById('avatarInput').click();
    });

    document.getElementById('avatarInput')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Preview local image
        const reader = new FileReader();
        reader.onload = (e) => {
            const preview = document.getElementById('avatarPreview');
            if (preview) {
                preview.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
            }
        };
        reader.readAsDataURL(file);
    });
    
    document.getElementById('savePlatformBtn')?.addEventListener('click', () => {
        const settings = {
            session_timeout: document.getElementById('sessionTimeout').value,
            prevent_multiple_sessions: document.getElementById('preventMultipleSessions').checked,
            restrict_by_country: document.getElementById('restrictByCountry').checked,
            allowed_countries: document.getElementById('allowedCountries').value,
            restrict_by_ip: document.getElementById('restrictByIP').checked,
            ip_restriction_type: document.getElementById('ipRestrictionType').value,
            ip_list: document.getElementById('ipList').value
        };
        saveAdvancedSetting('platform_control', settings);
    });

    document.getElementById('saveCommunicationBtn')?.addEventListener('click', () => {
        const settings = {
            max_open_tickets: document.getElementById('maxOpenTickets').value,
            prevent_duplicate_tickets: document.getElementById('preventDuplicateTickets').checked,
            banned_words: document.getElementById('bannedWords').value,
            max_messages_per_minute: document.getElementById('maxMessagesPerMinute').value,
            max_messages_per_hour: document.getElementById('maxMessagesPerHour').value
        };
        saveAdvancedSetting('communication_control', settings);
    });

    document.getElementById('saveEmergencyBtn')?.addEventListener('click', () => {
        const settings = {
            enabled: document.getElementById('emergencyModeEnabled').checked,
            disable_ticket_creation: document.getElementById('disableTicketCreation').checked,
            disable_replies: document.getElementById('disableReplies').checked,
            bot_only_mode: document.getElementById('botOnlyMode').checked,
            message_creation: document.getElementById('emergencyMessageCreation').value,
            message_replies: document.getElementById('emergencyMessageReplies').value
        };
        saveAdvancedSetting('emergency_mode', settings);
    });

    document.getElementById('saveSecurityBtn')?.addEventListener('click', () => {
        const settings = {
            password_change_interval: document.getElementById('passwordChangeInterval').value,
            password_strength: document.getElementById('passwordStrength').value,
            failed_login_attempts: document.getElementById('failedLoginAttempts').value,
            lockout_duration: document.getElementById('lockoutDuration').value,
            force_2fa_admins: document.getElementById('force2FAForAdmins').checked
        };
        saveAdvancedSetting('account_policies', settings);
    });

    document.getElementById('saveCustomerExpBtn')?.addEventListener('click', () => {
        const settings = {
            allow_new_registrations: document.getElementById('allowNewRegistrations').checked,
            enable_rewards_system: document.getElementById('enableRewardsSystem').checked,
            customer_welcome_message: document.getElementById('customerWelcomeMessage').value,
            allow_ticket_attachments: document.getElementById('allowTicketAttachments').checked,
            allow_ticket_rating: document.getElementById('allowTicketRating').checked,
            show_support_online_status: document.getElementById('showSupportOnlineStatus').checked
        };
        saveAdvancedSetting('customer_experience', settings);
    });

    document.getElementById('saveWorkingHoursBtn')?.addEventListener('click', saveWorkingHours);
    document.getElementById('saveBotBtn')?.addEventListener('click', saveBotSettings);
    document.getElementById('saveAdsBtn')?.addEventListener('click', saveAdsSettings);
    document.getElementById('saveApiKeysBtn')?.addEventListener('click', saveApiKeys);

    document.getElementById('logoutAllDevicesBtn')?.addEventListener('click', async () => {
        if (confirm('هل أنت متأكد من رغبتك في تسجيل الخروج من جميع الأجهزة الأخرى؟')) {
            try {
                const { error } = await supabase.auth.signOut({ scope: 'others' });
                if (error) throw error;
                showAlert('تم تسجيل الخروج من جميع الأجهزة الأخرى بنجاح', 'success');
                loadActiveDevices();
            } catch (err) {
                console.error('Error logging out other devices:', err);
                showAlert('حدث خطأ أثناء تسجيل الخروج', 'error');
            }
        }
    });

    // Roles & Users
    document.getElementById('addRoleBtn')?.addEventListener('click', () => {
        document.getElementById('roleFormModal').style.display = 'block';
        document.getElementById('roleModalTitle').textContent = 'إضافة دور جديد';
        document.getElementById('editRoleId').value = '';
        document.getElementById('roleName').value = '';
        document.getElementById('roleDescription').value = '';
        document.querySelectorAll('[id^="perm-"]').forEach(cb => cb.checked = false);
    });

    document.getElementById('cancelRoleBtn')?.addEventListener('click', () => {
        document.getElementById('roleFormModal').style.display = 'none';
    });

    document.getElementById('saveRoleBtn')?.addEventListener('click', saveRole);

    document.getElementById('addUserBtn')?.addEventListener('click', () => {
        document.getElementById('userFormModal').style.display = 'block';
        document.getElementById('userModalTitle').textContent = 'إضافة مستخدم جديد';
        document.getElementById('editUserId').value = '';
        document.getElementById('userFullName').value = '';
        document.getElementById('userEmail').value = '';
        document.getElementById('userEmail').readOnly = false;
        document.getElementById('userPassword').value = '';
        document.getElementById('userPassword').placeholder = 'كلمة المرور';
        document.getElementById('userRole').value = '';
    });

    document.getElementById('cancelUserBtn')?.addEventListener('click', () => {
        document.getElementById('userFormModal').style.display = 'none';
    });

    document.getElementById('saveUserBtn')?.addEventListener('click', saveUser);

    // Rules
    document.getElementById('addRuleBtn')?.addEventListener('click', () => {
        document.getElementById('ruleFormModal').style.display = 'block';
        document.getElementById('ruleModalTitle').textContent = 'إضافة قاعدة جديدة';
        document.getElementById('editRuleId').value = '';
        document.getElementById('ruleName').value = '';
        document.getElementById('ruleTrigger').value = 'ticket_created';
        document.getElementById('ruleCondition').value = '';
        document.getElementById('ruleAction').value = 'set_priority_high';
    });

    document.getElementById('cancelRuleBtn')?.addEventListener('click', () => {
        document.getElementById('ruleFormModal').style.display = 'none';
    });

    document.getElementById('saveRuleBtn')?.addEventListener('click', saveRule);

    // Visibility Toggles
    document.getElementById('restrictByCountry')?.addEventListener('change', (e) => {
        document.getElementById('countryRestrictionSettings').style.display = e.target.checked ? 'block' : 'none';
    });

    document.getElementById('restrictByIP')?.addEventListener('change', (e) => {
        document.getElementById('ipRestrictionSettings').style.display = e.target.checked ? 'block' : 'none';
    });

    document.getElementById('emergencyModeEnabled')?.addEventListener('change', (e) => {
        document.getElementById('emergencySettings').style.display = e.target.checked ? 'block' : 'none';
    });
}

async function saveProfile() {
    const btn = document.getElementById('saveProfileBtn');
    const avatarInput = document.getElementById('avatarInput');
    setLoading(btn, true);
    
    try {
        let avatarUrl = null;

        // 1. Handle Avatar Upload if a new file is selected
        if (avatarInput.files && avatarInput.files[0]) {
            const file = avatarInput.files[0];
            const fileExt = file.name.split('.').pop();
            const fileName = `${user.id}/${Math.random()}.${fileExt}`;
            const filePath = `${fileName}`;

            const { error: uploadError } = await supabase.storage
                .from('avatars')
                .upload(filePath, file, { upsert: true });

            if (uploadError) throw uploadError;

            const { data: { publicUrl } } = supabase.storage
                .from('avatars')
                .getPublicUrl(filePath);
            
            avatarUrl = publicUrl;
        }

        // 2. Prepare Updates
        const updates = {
            full_name: document.getElementById('fullName').value,
            bio: document.getElementById('bio').value,
            updated_at: new Date()
        };

        if (avatarUrl) {
            updates.avatar_url = avatarUrl;
        }

        // 3. Save to Profiles
        const { error } = await supabase.from('profiles').update(updates).eq('id', user.id);
        if (error) throw error;

        // 4. Update UI
        showAlert('تم تحديث الملف الشخصي بنجاح', 'success');
        
        // Fetch fresh profile to ensure updateAdminUI has all data
        const { data: updatedProfile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        updateAdminUI({ ...user, profile: updatedProfile });
        updateAvatarUI(updatedProfile.full_name, updatedProfile.avatar_url);
        
        // Clear file input
        avatarInput.value = '';
        
    } catch (error) {
        console.error('Update error:', error);
        showAlert('خطأ في التحديث: ' + error.message, 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function saveAdvancedSetting(key, value) {
    try {
        const { data: existing } = await supabase.from('advanced_settings').select('id').eq('key', key).maybeSingle();
        
        let error;
        if (existing) {
            const { error: err } = await supabase.from('advanced_settings').update({ value, updated_at: new Date() }).eq('key', key);
            error = err;
        } else {
            const { error: err } = await supabase.from('advanced_settings').insert({ key, value });
            error = err;
        }

        if (error) throw error;
        showAlert('تم حفظ الإعدادات بنجاح', 'success');
        logActivity('update_settings', `Updated ${key} settings`);
    } catch (error) {
        showAlert('خطأ في الحفظ: ' + error.message, 'error');
    }
}

async function saveWorkingHours() {
    const btn = document.getElementById('saveWorkingHoursBtn');
    setLoading(btn, true);
    try {
        // Logic to gather and save working hours
        // ... implementation ...
        
        // Also save after hours settings
        const afterHours = {
            auto_reply: document.getElementById('afterHoursAutoReply').value,
            bot_after_hours: document.getElementById('botAfterHours').checked
        };
        await saveAdvancedSetting('after_hours', afterHours);
        
        showAlert('تم حفظ ساعات العمل والردود التلقائية', 'success');
    } catch (error) {
        showAlert('خطأ في الحفظ: ' + error.message, 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function saveBotSettings() {
    const btn = document.getElementById('saveBotBtn');
    setLoading(btn, true);
    try {
        const settings = {
            smart_memory_enabled: document.getElementById('smartMemoryEnabled').checked,
            system_prompt: document.getElementById('botSystemPrompt').value,
            updated_at: new Date()
        };

        const { data: existing } = await supabase.from('bot_settings').select('id').limit(1).maybeSingle();
        let error;
        if (existing) {
            const { error: err } = await supabase.from('bot_settings').update(settings).eq('id', existing.id);
            error = err;
        } else {
            const { error: err } = await supabase.from('bot_settings').insert(settings);
            error = err;
        }

        if (error) throw error;
        showAlert('تم حفظ إعدادات البوت بنجاح', 'success');
    } catch (error) {
        showAlert('خطأ في الحفظ: ' + error.message, 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function saveAdsSettings() {
    const btn = document.getElementById('saveAdsBtn');
    setLoading(btn, true);
    try {
        const settings = {
            enabled: document.getElementById('topAdsEnabled').checked,
            content: document.getElementById('adsContent').value,
            link: document.getElementById('adsLink').value,
            updated_at: new Date()
        };

        const { data: existing } = await supabase.from('ads_settings').select('id').limit(1).maybeSingle();
        let error;
        if (existing) {
            const { error: err } = await supabase.from('ads_settings').update(settings).eq('id', existing.id);
            error = err;
        } else {
            const { error: err } = await supabase.from('ads_settings').insert(settings);
            error = err;
        }

        if (error) throw error;
        showAlert('تم حفظ إعدادات الإعلانات بنجاح', 'success');
    } catch (error) {
        showAlert('خطأ في الحفظ: ' + error.message, 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function saveApiKeys() {
    const btn = document.getElementById('saveApiKeysBtn');
    setLoading(btn, true);
    try {
        const keys = {
            openai_key: document.getElementById('openaiKey').value,
            telegram_token: document.getElementById('telegramBotToken').value,
            updated_at: new Date()
        };

        const { data: existing } = await supabase.from('api_keys').select('id').limit(1).maybeSingle();
        let error;
        if (existing) {
            const { error: err } = await supabase.from('api_keys').update(keys).eq('id', existing.id);
            error = err;
        } else {
            const { error: err } = await supabase.from('api_keys').insert(keys);
            error = err;
        }

        if (error) throw error;
        showAlert('تم حفظ مفاتيح API بنجاح', 'success');
    } catch (error) {
        showAlert('خطأ في الحفظ: ' + error.message, 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function saveRole() {
    const btn = document.getElementById('saveRoleBtn');
    const id = document.getElementById('editRoleId').value;
    const name = document.getElementById('roleName').value;
    const description = document.getElementById('roleDescription').value;
    
    const permissions = {};
    document.querySelectorAll('[id^="perm-"]').forEach(cb => {
        permissions[cb.id.replace('perm-', '').replace(/-/g, '_')] = cb.checked;
    });

    setLoading(btn, true);
    try {
        let error;
        if (id) {
            const { error: err } = await supabase.from('custom_roles').update({ name, description, permissions }).eq('id', id);
            error = err;
        } else {
            const { error: err } = await supabase.from('custom_roles').insert({ name, description, permissions });
            error = err;
        }

        if (error) throw error;
        showAlert('تم حفظ الدور بنجاح', 'success');
        document.getElementById('roleFormModal').style.display = 'none';
        loadCustomRoles();
    } catch (error) {
        showAlert('خطأ في الحفظ: ' + error.message, 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function deleteRole(id) {
    if (!confirm('هل أنت متأكد من حذف هذا الدور؟')) return;
    try {
        const { error } = await supabase.from('custom_roles').delete().eq('id', id);
        if (error) throw error;
        showAlert('تم حذف الدور بنجاح', 'success');
        loadCustomRoles();
    } catch (error) {
        showAlert('خطأ في الحذف: ' + error.message, 'error');
    }
}

async function editRole(id) {
    const role = allRoles.find(r => r.id === id);
    if (!role) return;

    document.getElementById('roleFormModal').style.display = 'block';
    document.getElementById('roleModalTitle').textContent = 'تعديل الدور';
    document.getElementById('editRoleId').value = role.id;
    document.getElementById('roleName').value = role.name;
    document.getElementById('roleDescription').value = role.description || '';
    
    const perms = role.permissions || {};
    document.querySelectorAll('[id^="perm-"]').forEach(cb => {
        const key = cb.id.replace('perm-', '').replace(/-/g, '_');
        cb.checked = !!perms[key];
    });
}

async function saveUser() {
    const btn = document.getElementById('saveUserBtn');
    const id = document.getElementById('editUserId').value;
    const fullName = document.getElementById('userFullName').value;
    const email = document.getElementById('userEmail').value;
    const password = document.getElementById('userPassword').value;
    const roleId = document.getElementById('userRole').value;

    setLoading(btn, true);
    try {
        if (id) {
            // Update existing user profile
            const { error } = await supabase.from('profiles').update({ 
                full_name: fullName, 
                role_id: roleId || null 
            }).eq('id', id);
            if (error) throw error;
        } else {
            // In a real app, you'd use a server-side function or Edge Function to create users
            // For now, we'll show a message that this requires admin privileges in Supabase
            throw new Error('إنشاء مستخدم جديد يتطلب استخدام Supabase Auth API أو Edge Function');
        }

        showAlert('تم حفظ بيانات المستخدم بنجاح', 'success');
        document.getElementById('userFormModal').style.display = 'none';
        loadUsers();
    } catch (error) {
        showAlert('خطأ: ' + error.message, 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function deleteUser(id) {
    if (!confirm('هل أنت متأكد من حذف هذا المستخدم؟ سيتم حذف ملفه الشخصي فقط.')) return;
    try {
        const { error } = await supabase.from('profiles').delete().eq('id', id);
        if (error) throw error;
        showAlert('تم حذف ملف المستخدم بنجاح', 'success');
        loadUsers();
    } catch (error) {
        showAlert('خطأ في الحذف: ' + error.message, 'error');
    }
}

async function editUser(id) {
    try {
        const { data: u, error } = await supabase.from('profiles').select('*').eq('id', id).single();
        if (error) throw error;

        document.getElementById('userFormModal').style.display = 'block';
        document.getElementById('userModalTitle').textContent = 'تعديل المستخدم';
        document.getElementById('editUserId').value = u.id;
        document.getElementById('userFullName').value = u.full_name || '';
        document.getElementById('userEmail').value = u.email || '';
        document.getElementById('userEmail').readOnly = true;
        document.getElementById('userPassword').value = '';
        document.getElementById('userPassword').placeholder = '(اتركه فارغاً للحفاظ على الحالية)';
        document.getElementById('userRole').value = u.role_id || '';
    } catch (error) {
        showAlert('خطأ في تحميل بيانات المستخدم', 'error');
    }
}

async function saveRule() {
    const btn = document.getElementById('saveRuleBtn');
    const id = document.getElementById('editRuleId').value;
    const name = document.getElementById('ruleName').value;
    const trigger = document.getElementById('ruleTrigger').value;
    const conditionStr = document.getElementById('ruleCondition').value;
    const action = document.getElementById('ruleAction').value;

    setLoading(btn, true);
    try {
        const ruleData = {
            name,
            trigger_event: trigger,
            conditions: { raw: conditionStr },
            actions: [{ type: action }],
            is_active: true
        };

        let error;
        if (id) {
            const { error: err } = await supabase.from('rules_engine').update(ruleData).eq('id', id);
            error = err;
        } else {
            const { error: err } = await supabase.from('rules_engine').insert(ruleData);
            error = err;
        }

        if (error) throw error;
        showAlert('تم حفظ القاعدة بنجاح', 'success');
        document.getElementById('ruleFormModal').style.display = 'none';
        loadRules();
    } catch (error) {
        showAlert('خطأ في الحفظ: ' + error.message, 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function deleteRule(id) {
    if (!confirm('هل أنت متأكد من حذف هذه القاعدة؟')) return;
    try {
        const { error } = await supabase.from('rules_engine').delete().eq('id', id);
        if (error) throw error;
        showAlert('تم حذف القاعدة بنجاح', 'success');
        loadRules();
    } catch (error) {
        showAlert('خطأ في الحذف: ' + error.message, 'error');
    }
}

async function editRule(id) {
    try {
        const { data: rule, error } = await supabase.from('rules_engine').select('*').eq('id', id).single();
        if (error) throw error;

        document.getElementById('ruleFormModal').style.display = 'block';
        document.getElementById('ruleModalTitle').textContent = 'تعديل القاعدة';
        document.getElementById('editRuleId').value = rule.id;
        document.getElementById('ruleName').value = rule.name;
        document.getElementById('ruleTrigger').value = rule.trigger_event;
        document.getElementById('ruleCondition').value = rule.conditions?.raw || '';
        document.getElementById('ruleAction').value = rule.actions?.[0]?.type || '';
    } catch (error) {
        showAlert('خطأ في تحميل القاعدة', 'error');
    }
}

async function loadActiveDevices() {
    const container = document.getElementById('activeDevicesList');
    if (!container) return;

    try {
        const { data: devices, error } = await supabase
            .from('trusted_devices')
            .select('*')
            .eq('user_id', user.id)
            .order('last_login', { ascending: false });

        if (error) throw error;

        if (!devices || devices.length === 0) {
            container.innerHTML = '<p style="text-align: center; padding: 1rem;">لا توجد أجهزة موثوقة مسجلة حالياً.</p>';
            return;
        }

        container.innerHTML = devices.map(device => {
            const isMobile = /Mobile|Android|iPhone/i.test(device.device_name || '');
            return `
                <div class="device-item" style="display: flex; justify-content: space-between; align-items: center; padding: 1.25rem; background: var(--color-background); border: 1px solid var(--color-border); border-radius: 0.75rem; margin-bottom: 1rem;">
                    <div style="display: flex; align-items: center; gap: 1rem;">
                        <div style="width: 40px; height: 40px; background: var(--color-surface); border-radius: 0.5rem; display: flex; align-items: center; justify-content: center; color: var(--color-text-secondary); border: 1px solid var(--color-border);">
                            ${isMobile ? '📱' : '💻'}
                        </div>
                        <div>
                            <h4 style="margin: 0; font-size: 1rem;">${device.device_name || 'جهاز غير معروف'}</h4>
                            <p style="margin: 0.15rem 0 0; font-size: 0.8rem; color: var(--color-text-secondary);">آخر ظهور: ${new Date(device.last_login).toLocaleString('ar-EG')} • IP: ${device.ip_address || 'غير معروف'}</p>
                        </div>
                    </div>
                    <button class="btn btn-danger btn-sm" onclick="removeDevice('${device.id}')">حذف</button>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Error loading devices:', err);
        container.innerHTML = '<p style="text-align: center; padding: 1rem; color: var(--color-danger);">فشل تحميل قائمة الأجهزة.</p>';
    }
}

window.removeDevice = async (deviceId) => {
    if (!confirm('هل أنت متأكد من حذف هذا الجهاز؟')) return;
    try {
        const { error } = await supabase.from('trusted_devices').delete().eq('id', deviceId);
        if (error) throw error;
        showAlert('تم حذف الجهاز بنجاح', 'success');
        loadActiveDevices();
    } catch (error) {
        showAlert('خطأ في الحذف: ' + error.message, 'error');
    }
};

function getBrowserName(ua) {
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("SamsungBrowser")) return "Samsung Browser";
    if (ua.includes("Opera") || ua.includes("OPR")) return "Opera";
    if (ua.includes("Edge")) return "Edge";
    if (ua.includes("Chrome")) return "Chrome";
    if (ua.includes("Safari")) return "Safari";
    return "متصفح غير معروف";
}

function renderWorkingHours() {
    const container = document.getElementById('workingHoursContainer');
    if (!container) return;

    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const hours = currentSettings.workingHours || [];

    container.innerHTML = days.map((day, index) => {
        const dayData = hours.find(h => h.day_of_week === index) || { is_closed: true, open_time: '09:00', close_time: '17:00' };
        return `
            <div class="form-row" style="align-items: center; margin-bottom: 1rem; background: var(--color-muted); padding: 0.75rem; border-radius: 0.75rem;">
                <div style="width: 100px; font-weight: 700;">${day}</div>
                <div class="time-input-group">
                    <input type="time" class="form-control" value="${dayData.open_time}" ${dayData.is_closed ? 'disabled' : ''}>
                    <span>إلى</span>
                    <input type="time" class="form-control" value="${dayData.close_time}" ${dayData.is_closed ? 'disabled' : ''}>
                </div>
                <div class="switch-group" style="margin-bottom: 0; padding: 0.25rem 0.75rem; background: transparent;">
                    <label class="switch">
                        <input type="checkbox" ${!dayData.is_closed ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                    <span style="margin-right: 0.5rem; font-size: 0.85rem;">${dayData.is_closed ? 'مغلق' : 'مفتوح'}</span>
                </div>
            </div>
        `;
    }).join('');
}

function updateAvatarUI(name, url) {
    const preview = document.getElementById('avatarPreview');
    if (!preview) return;

    if (url) {
        preview.innerHTML = `<img src="${url}" alt="${name}">`;
    } else {
        preview.textContent = (name || 'A')[0].toUpperCase();
    }
}

function showAlert(message, type = 'success') {
    const alert = document.getElementById('settingsAlert');
    if (!alert) return;

    alert.textContent = message;
    alert.className = `alert alert-${type}`;
    alert.style.display = 'block';

    setTimeout(() => {
        alert.style.display = 'none';
    }, 5000);
}

function setLoading(btn, isLoading) {
    if (!btn) return;
    if (isLoading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.textContent;
        btn.textContent = 'جاري المعالجة...';
    } else {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText;
    }
}

init();
