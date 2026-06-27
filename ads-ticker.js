import { supabase } from './api-config.js';

/**
 * تنقية أي نص قادم من قاعدة البيانات قبل حقنه داخل innerHTML
 * لمنع هجمات XSS (Cross-Site Scripting).
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * يسمح فقط بروابط http/https لمنع حقن بروتوكولات خطيرة مثل javascript:
 */
function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^https?:\/\//i.test(trimmed)) {
        return escapeHtml(trimmed);
    }
    return '';
}

async function initAdsTicker() {
    try {
        const { data: ads, error } = await supabase
            .from('ads_settings')
            .select('*')
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        if (ads && ads.enabled && ads.content) {
            renderTicker(ads);
        }
    } catch (err) {
        console.error('Error loading ads:', err);
    }
}

function renderTicker(ads) {
    // Check if ticker already exists
    if (document.querySelector('.news-ticker-container')) return;

    const ticker = document.createElement('div');
    ticker.className = 'news-ticker-container';
    ticker.style.display = 'block';

    const safeContent = escapeHtml(ads.content);
    const safeLink = sanitizeUrl(ads.link);

    const content = safeLink
        ? `${safeContent} <a href="${safeLink}" target="_blank" rel="noopener noreferrer">اضغط هنا للمزيد</a>`
        : safeContent;

    ticker.innerHTML = `
        <div class="news-ticker-content">
            <div class="news-ticker-item">${content}</div>
            <div class="news-ticker-item">${content}</div>
            <div class="news-ticker-item">${content}</div>
        </div>
    `;

    // Insert at the very top of the body
    document.body.prepend(ticker);
}

// Run when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdsTicker);
} else {
    initAdsTicker();
}
