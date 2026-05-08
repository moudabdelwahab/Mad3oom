/**
 * utils/toast.js
 * نظام إشعارات Toast
 */

const Toast = (() => {

  const icons = {
    success: '✅',
    error:   '❌',
    warning: '⚠️',
    info:    'ℹ️',
  };

  function show(type, title, message, duration = 4000) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <div class="toast-icon">${icons[type] || icons.info}</div>
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        ${message ? `<div class="toast-msg">${message}</div>` : ''}
      </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return {
    success: (t, m, d) => show('success', t, m, d),
    error:   (t, m, d) => show('error',   t, m, d),
    warning: (t, m, d) => show('warning', t, m, d),
    info:    (t, m, d) => show('info',    t, m, d),
  };
})();
