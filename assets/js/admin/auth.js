import { supabase } from '/api-config.js';
import { requireAuth, logout } from '/auth-client.js';

export async function checkAdminAuth() {
    try {
        const user = await requireAuth('admin');
        if (!user) {
            window.location.replace('/sign-in.html');
            return null;
        }
        return user;
    } catch (err) {
        console.error('Auth error:', err);
        window.location.replace('/sign-in.html');
        return null;
    }
}

export async function handleLogout() {
    await logout();
    window.location.replace('/sign-in.html');
}

export function updateAdminUI(user) {
    if (user) {
        const profile = user.profile || {};
        const adminInitial = document.getElementById('adminInitial');
        const adminBadgeContainer = document.getElementById('adminBadgeContainer');
        const adminAvatarBtn = document.getElementById('adminAvatarBtn');

        if (adminInitial) {
            const nameForInitial = profile.full_name || user.email || 'A';
            adminInitial.textContent = nameForInitial.charAt(0).toUpperCase();
        }

        const isAdmin = profile.role === 'admin' || profile.role === 'support' || profile.role === 'super_user';
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
        }
    }
}
