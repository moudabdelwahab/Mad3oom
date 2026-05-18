import { SupabaseIntegration } from './supabase-integration.js';
import { WhatsAppThemeManager } from './theme-manager.js';

export const SharedUI = {
  async init() {
    console.log('[SharedUI] Initializing...');
    try {
      const supabase = await SupabaseIntegration.initializeSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        window.location.href = '/sign-in.html?redirect=' + encodeURIComponent(window.location.pathname);
        return;
      }

      await this.loadUserProfile();
      this.setupSidebar();
      this.setupTheme();
      this.updateActiveNavLink();
    } catch (error) {
      console.error('[SharedUI] Init error:', error);
    }
  },

  async loadUserProfile() {
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
        const fullName = profile.full_name || 'المستخدم';
        const firstName = fullName.split(' ')[0];
        const initial = firstName.charAt(0).toUpperCase();
        
        const nameEl = document.getElementById('user-name');
        if (nameEl) nameEl.textContent = fullName;
        
        const roleEl = document.getElementById('user-role');
        if (roleEl) {
          const roleMap = { 'admin': 'مدير النظام', 'support': 'الدعم الفني', 'customer': 'عميل' };
          roleEl.textContent = roleMap[profile.role] || 'مستخدم';
        }
        
        const avatarEl = document.getElementById('user-avatar');
        if (avatarEl) avatarEl.textContent = initial;

        const welcomeNameEl = document.getElementById('welcome-name');
        if (welcomeNameEl) welcomeNameEl.textContent = firstName + '!';
        
        const usersTab = document.querySelector('[data-page="users"]');
        if (usersTab && profile.email !== 'support@mad3oom.online' && profile.role !== 'admin') {
          usersTab.style.display = 'none';
        }
      }
    } catch (error) {
      console.error('[SharedUI] Error loading profile:', error);
    }
  },

  setupSidebar() {
    // Sidebar toggle logic if needed
  },

  setupTheme() {
    // Theme is handled by theme-manager.js usually, but we can ensure it's synced
  },

  updateActiveNavLink() {
    const currentPath = window.location.pathname;
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      const page = item.getAttribute('data-page');
      if (currentPath.includes(page + '.html') || (page === 'dashboard' && (currentPath.endsWith('index.html') || currentPath.endsWith('/whatsapp/')))) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }
};

window.handleLogout = async () => {
  try {
    const supabase = await SupabaseIntegration.initializeSupabase();
    await supabase.auth.signOut();
    window.location.replace('/sign-in.html');
  } catch (error) {
    console.error('Logout error:', error);
  }
};

window.handleThemeToggle = () => {
  if (window.waThemeManager) {
    window.waThemeManager.toggleTheme();
  }
};

window.handleNotifications = () => {
  // Placeholder
  console.log('Notifications clicked');
};

// Auto-init on DOM content loaded
document.addEventListener('DOMContentLoaded', () => SharedUI.init());
