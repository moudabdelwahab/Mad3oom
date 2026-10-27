import { logout } from '/auth-client.js';
import { guardPage } from '/assets/js/page-guard.js';

/**
 * حارس صفحات لوحة الإدارة.
 *
 * كان يحوّل كل رفض إلى /login.html — بما فيه رفض حساب جلسته سليمة تمامًا
 * (مالك شركة برتبة super_user مثلًا). ولأن login.html بيلاقي الجلسة قائمة
 * فبيرجّعه للوحة شركته، كانت النتيجة حلقة لا نهائية عند أي زر يقود لصفحة
 * إدارية. دلوقتي: مفيش جلسة → صفحة الدخول؛ جلسة بلا صلاحية → رسالة صريحة.
 */
export async function checkAdminAuth() {
    return guardPage('admin');
}

export async function handleLogout() {
    await logout();
    window.location.replace('/login.html');
}

// آخر مستخدم عُرض في الشريط: القائمة تُجلب بعد التحقق أحيانًا، فتعيد sidebar.js
// تطبيق الهوية بعد تركيبها بدل أن يبقى الحرف الافتراضي «A».
let lastAdminUser = null;

export function refreshAdminIdentity() {
    if (lastAdminUser) updateAdminUI(lastAdminUser);
}

/** الاسم بجوار الصورة الرمزية في الشريط العلوي — نص فقط، لا HTML. */
function renderAdminUserName(adminAvatarBtn, displayName) {
    const meta = document.createElement('span');
    meta.className = 'nav-user-meta';
    const name = document.createElement('span');
    name.className = 'nav-user-name';
    name.id = 'adminUserName';
    name.textContent = displayName;
    const greeting = document.createElement('span');
    greeting.className = 'nav-user-greeting';
    greeting.setAttribute('data-i18n', 'nav_greeting');
    greeting.textContent = window.languageManager?.translate?.('nav_greeting') || 'مرحبًا';
    meta.append(name, greeting);
    adminAvatarBtn.prepend(meta);
}

export function updateAdminUI(user) {
    if (user) {
        lastAdminUser = user;
        const profile = user.profile || {};
        const adminInitial = document.getElementById('adminInitial');
        const adminBadgeContainer = document.getElementById('adminBadgeContainer');
        const adminAvatarBtn = document.getElementById('adminAvatarBtn');

        if (adminInitial) {
            const nameForInitial = profile.full_name || user.email || 'A';
            adminInitial.textContent = nameForInitial.charAt(0).toUpperCase();
        }

        // الارتباط بشركة لا يفتح لوحة الإدارة إطلاقًا (C2/H4): الرتبة هوية حساب،
        // وصلاحيات الشركة تأتي من العلاقة، والخدمات من الاشتراك.
        const isAdmin = profile.role === 'admin' || profile.role === 'support';
        if (isAdmin && adminBadgeContainer) {
            adminBadgeContainer.style.display = 'block';
        }

        if (adminAvatarBtn) {
            if (profile.avatar_url) {
                adminAvatarBtn.innerHTML = `<img src="${profile.avatar_url}" class="nav-avatar" alt="Profile">`;
            } else {
                const nameForInitial = profile.full_name || user.email || 'A';
                const initial = nameForInitial.charAt(0).toUpperCase();
                adminAvatarBtn.innerHTML = `<div class="avatar-circle">${initial}</div>`;
            }
            renderAdminUserName(adminAvatarBtn, profile.full_name || user.email || '');
        }
    }
}
