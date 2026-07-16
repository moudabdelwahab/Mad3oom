import { supabase } from '../../api-config.js';

document.addEventListener('DOMContentLoaded', async () => {
    const apiKeysList = document.getElementById('apiKeysList');
    const firewallRulesList = document.getElementById('firewallRulesList');
    const createBtn = document.getElementById('createNewKeyBtn');
    const confirmCreateBtn = document.getElementById('confirmCreateBtn');
    const newKeyModal = document.getElementById('newKeyModal');
    const toast = document.getElementById('toast');

    let currentUser = null;

    // 1. التحقق من الهوية
    async function checkAuth() {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            window.location.href = '/login.html';
            return;
        }
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        if (!profile || profile.role !== 'admin') {
            alert('غير مصرح لك بالدخول لهذه الصفحة');
            window.location.href = '/';
            return;
        }
        currentUser = user;
        loadApiKeys();
        loadFirewallRules();
    }

    function showToast(msg) {
        toast.innerText = msg;
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 3000);
    }

    // 2. تحميل مفاتيح API
    async function loadApiKeys() {
        apiKeysList.innerHTML = '<div style="text-align:center; padding:2rem;">جاري التحميل...</div>';
        const { data: keys, error } = await supabase.from('bot_api_keys').select('*').order('created_at', { ascending: false });
        
        if (error) {
            apiKeysList.innerHTML = `<div style="color:red;">خطأ: ${error.message}</div>`;
            return;
        }

        if (!keys || keys.length === 0) {
            apiKeysList.innerHTML = '<div style="text-align:center; padding:2rem; color:#888;">لا توجد مفاتيح حالياً. قم بتوليد مفتاح جديد للبدء.</div>';
            return;
        }

        apiKeysList.innerHTML = '';
        keys.forEach(key => {
            const card = document.createElement('div');
            card.className = 'api-key-card';
            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:15px;">
                    <div>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <strong style="font-size:1.1rem; color:var(--primary-blue);">${key.name}</strong>
                            <span class="status-badge status-${key.status}">${key.status === 'active' ? 'نشط' : key.status === 'read_only' ? 'للقراءة فقط' : key.status === 'rate_limited' ? 'محدد السرعة' : 'صيانة'}</span>
                        </div>
                        <div style="color:#666; font-size:0.85rem; margin-top:5px;">🌐 ${key.website_url || 'جميع المواقع'}</div>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <select class="status-select" data-id="${key.id}" style="padding:8px; border-radius:5px; border:1px solid #ddd; font-family:inherit;">
                            <option value="active" ${key.status === 'active' ? 'selected' : ''}>نشط</option>
                            <option value="read_only" ${key.status === 'read_only' ? 'selected' : ''}>للقراءة فقط</option>
                            <option value="rate_limited" ${key.status === 'rate_limited' ? 'selected' : ''}>محدد السرعة</option>
                            <option value="maintenance" ${key.status === 'maintenance' ? 'selected' : ''}>صيانة</option>
                        </select>
                        <button class="delete-key-btn" data-id="${key.id}" style="background:#fff5f5; color:#ff4d4d; border:1px solid #ffebeb; padding:8px 15px; border-radius:5px; cursor:pointer; font-weight:600; font-family:inherit;">حذف</button>
                    </div>
                </div>
                
                <div class="key-display">
                    <span id="key-${key.id}">${key.key_value.substring(0, 10)}****************${key.key_value.substring(key.key_value.length - 5)}</span>
                    <button class="copy-btn" data-key="${key.key_value}" style="background:none; border:none; color:var(--primary-blue); cursor:pointer; font-weight:700; font-family:inherit;">نسخ المفتاح</button>
                </div>

                <div class="advanced-settings">
                    <h4>الإعدادات المتقدمة</h4>
                    <div class="setting-grid">
                        <div class="setting-row full-width">
                            <label>النطاقات / عناوين IP المسموحة (Allowed domains / IPs)</label>
                            <input type="text" class="allowed-domains-input" data-id="${key.id}" value="${(key.allowed_domains || []).join(', ')}" placeholder="example.com, 1.2.3.4">
                        </div>
                        <div class="setting-row">
                            <label>ربط المنصة (Platform binding)</label>
                            <select class="platform-binding-select" data-id="${key.id}">
                                <option value="" ${!key.platform_binding ? 'selected' : ''}>بدون ربط</option>
                                <option value="web" ${key.platform_binding === 'web' ? 'selected' : ''}>Web Browser</option>
                                <option value="mobile" ${key.platform_binding === 'mobile' ? 'selected' : ''}>Mobile App</option>
                                <option value="server" ${key.platform_binding === 'server' ? 'selected' : ''}>Server Side</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label>توثيق HMAC (اختياري)</label>
                            <div class="switch-container">
                                <label class="switch">
                                    <input type="checkbox" class="hmac-toggle" data-id="${key.id}" ${key.hmac_enabled ? 'checked' : ''}>
                                    <span class="slider"></span>
                                </label>
                                <span style="font-size: 0.8rem; color: #666;">تفعيل HMAC للطلبات</span>
                            </div>
                        </div>
                    </div>
                    <button class="save-advanced-btn btn btn-primary" data-id="${key.id}" style="padding: 8px 20px; font-size: 0.85rem; margin-top: 10px;">حفظ الإعدادات المتقدمة</button>
                </div>

                <div style="font-size:0.8rem; color:#888; margin-top: 15px;">
                    الصلاحيات: ${key.permissions.join(' | ')}
                </div>
            `;
            apiKeysList.appendChild(card);
        });

        // Attach events
        document.querySelectorAll('.copy-btn').forEach(btn => {
            btn.onclick = () => {
                navigator.clipboard.writeText(btn.dataset.key);
                showToast('تم نسخ المفتاح إلى الحافظة');
            };
        });

        document.querySelectorAll('.status-select').forEach(select => {
            select.onchange = async () => {
                const id = select.dataset.id;
                const status = select.value;
                const { error } = await supabase.from('bot_api_keys').update({ status }).eq('id', id);
                if (!error) {
                    showToast('تم تحديث حالة المفتاح');
                    loadApiKeys();
                }
            };
        });

        document.querySelectorAll('.delete-key-btn').forEach(btn => {
            btn.onclick = async () => {
                if (!confirm('هل أنت متأكد من حذف هذا المفتاح؟')) return;
                const id = btn.dataset.id;
                const { error } = await supabase.from('bot_api_keys').delete().eq('id', id);
                if (!error) {
                    showToast('تم حذف المفتاح بنجاح');
                    loadApiKeys();
                }
            };
        });

        document.querySelectorAll('.save-advanced-btn').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                const card = btn.closest('.api-key-card');
                const domains = card.querySelector('.allowed-domains-input').value.split(',').map(d => d.trim()).filter(d => d);
                const platform = card.querySelector('.platform-binding-select').value;
                const hmac = card.querySelector('.hmac-toggle').checked;

                const { error } = await supabase.from('bot_api_keys').update({
                    allowed_domains: domains,
                    platform_binding: platform,
                    hmac_enabled: hmac
                }).eq('id', id);

                if (error) alert('خطأ في الحفظ: ' + error.message);
                else showToast('تم حفظ الإعدادات المتقدمة بنجاح');
            };
        });
    }

    // 3. توليد مفتاح جديد
    createBtn.onclick = () => {
        newKeyModal.style.display = 'flex';
    };

    confirmCreateBtn.onclick = async () => {
        const name = document.getElementById('modal_key_name').value;
        const website = document.getElementById('modal_website_url').value;
        
        if (!name) {
            alert('يرجى إدخال اسم المفتاح');
            return;
        }
        
        const newKey = 'mb_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        
        const { error } = await supabase.from('bot_api_keys').insert([{
            name: name,
            website_url: website,
            key_value: newKey,
            status: 'active',
            permissions: ['chat:send', 'memory:read'],
            created_by: currentUser.id,
            allowed_domains: [],
            hmac_enabled: false
        }]);

        if (error) alert('خطأ: ' + error.message);
        else {
            newKeyModal.style.display = 'none';
            document.getElementById('modal_key_name').value = '';
            document.getElementById('modal_website_url').value = '';
            showToast('تم توليد المفتاح بنجاح');
            loadApiKeys();
        }
    };

    // 4. تحميل قواعد الجدار الناري
    async function loadFirewallRules() {
        const { data: rules, error } = await supabase.from('memory_firewall_rules').select('*');
        if (error) return;

        firewallRulesList.innerHTML = '';
        rules.forEach(rule => {
            const div = document.createElement('div');
            div.style = 'display:flex; justify-content:space-between; align-items:center; padding:1rem; border:1px solid #eee; border-radius:10px; margin-bottom:0.5rem;';
            div.innerHTML = `
                <div>
                    <strong style="color:var(--primary-blue);">${rule.rule_type}</strong>
                    <div style="font-size:0.8rem; color:#666;">${rule.description}</div>
                </div>
                <label class="switch">
                    <input type="checkbox" class="rule-toggle" data-id="${rule.id}" ${rule.is_active ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            `;
            firewallRulesList.appendChild(div);
        });

        document.querySelectorAll('.rule-toggle').forEach(toggle => {
            toggle.onchange = async () => {
                const id = toggle.dataset.id;
                const is_active = toggle.checked;
                await supabase.from('memory_firewall_rules').update({ is_active }).eq('id', id);
                showToast('تم تحديث قاعدة الحماية');
            };
        });
    }

    checkAuth();
});
