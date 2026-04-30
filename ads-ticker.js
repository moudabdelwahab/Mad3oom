import { supabase } from './api-config.js';

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

    const content = ads.link 
        ? `${ads.content} <a href="${ads.link}" target="_blank">اضغط هنا للمزيد</a>`
        : ads.content;

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
