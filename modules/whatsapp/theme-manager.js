/**
 * =====================================================
 * WhatsApp Theme Manager
 * Handles dark/light mode switching with persistence
 * ===================================================== */

export class WhatsAppThemeManager {
  constructor() {
    this.STORAGE_KEY = 'wa-theme-preference';
    this.THEME_ATTR = 'data-wa-theme';
    this.DEFAULT_THEME = 'dark';
    this.init();
  }

  init() {
    // Load saved theme or use system preference
    const savedTheme = this.getSavedTheme();
    const theme = savedTheme || this.getSystemTheme();
    this.setTheme(theme);
  }

  getSavedTheme() {
    return localStorage.getItem(this.STORAGE_KEY);
  }

  getSystemTheme() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return this.DEFAULT_THEME;
  }

  setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') {
      theme = this.DEFAULT_THEME;
    }

    // Apply theme to document
    document.documentElement.setAttribute(this.THEME_ATTR, theme);

    // Save preference
    localStorage.setItem(this.STORAGE_KEY, theme);

    // Dispatch event for other components
    window.dispatchEvent(new CustomEvent('wa-theme-changed', { detail: { theme } }));
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute(this.THEME_ATTR) || this.DEFAULT_THEME;
    const next = current === 'light' ? 'dark' : 'light';
    this.setTheme(next);
    return next;
  }

  getCurrentTheme() {
    return document.documentElement.getAttribute(this.THEME_ATTR) || this.DEFAULT_THEME;
  }

  isDarkMode() {
    return this.getCurrentTheme() === 'dark';
  }

  isLightMode() {
    return this.getCurrentTheme() === 'light';
  }
}

// Create global instance
window.waThemeManager = new WhatsAppThemeManager();
