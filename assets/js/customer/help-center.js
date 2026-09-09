/**
 * help-center.js — مركز المساعدة.
 *
 * الصفحة دي كانت knowledge-base.html وبتعرض "فشل تحميل المقالات" دايمًا،
 * لأن الاستعلام كان بيضرب على جدول غير موجود (شوف migrations/013).
 * بعد ما اتعمل الجدول، الصفحة اتحوّلت من قائمة مقالات إلى رحلة:
 *
 *     بحث → فهم المشكلة → تجربة الحل → حلّها أو الوصول للدعم
 *
 * المبادئ:
 *   • مفيش مقالات وهمية. لو الجدول فاضي، بنقول كده بوضوح ونودّي للدعم.
 *   • العطل المعلن بيسبق أي مقال: ما ينفعش العميل يقرا خمس مقالات لمشكلة
 *     إحنا عارفين إنها عطل عام.
 *   • كل حالة (تحميل/فراغ/خطأ) بتستخدم نفس مكوّنات اللوحة من portal-ui.js.
 */

import { guardPage } from '/assets/js/page-guard.js';
import { initCustomerSidebar } from '/assets/js/customer-sidebar.js';
import {
    escapeHtml, formatDate, timeAgo,
    renderState, renderSkeletonCards, setText
} from '/assets/js/customer/portal-ui.js';
import * as helpData from '/assets/js/customer/help-data.js';
import {
    renderArticleHtml, tableOfContents,
    incidentMatchingSearch, recommendedFor, openTicketMatching
} from '/assets/js/customer/help-article-model.js';
import { fetchSystemStatus, fetchAccountStatus, fetchSieAccess, fetchWhatsappSubscription }
    from '/assets/js/customer/customer-data.js';
import { impairedForCustomer } from '/assets/js/customer/service-status-model.js';
import { fetchUserTickets } from '/tickets-service.js';
import { isClosed } from '/assets/js/customer/ticket-view-model.js';

const PAGE_SIZE = 12;

(async function () {
    const user = await guardPage('user');
    if (!user) return;

    initCustomerSidebar({});

    /* ================= الحالة ================= */
    let activeCategory = null;
    let searchTerm = '';
    let offset = 0;
    let totalArticles = 0;
    let allLoaded = [];          // ما وصل من مقالات (للاقتراح حسب الخدمات)
    let impaired = [];           // أعطال تخصّ هذا العميل
    let openTickets = [];

    const homeView = document.getElementById('helpHomeView');
    const articleView = document.getElementById('helpArticleView');
    const listEl = document.getElementById('helpArticlesList');
    const resultsSection = document.getElementById('helpResultsSection');
    const resultsList = document.getElementById('helpResultsList');
    const searchInput = document.getElementById('helpSearchInput');
    const clearBtn = document.getElementById('helpSearchClear');

    /* ================= السياق: الأعطال والتذاكر ================= */
    // بيتحمّل بالتوازي مع المقالات؛ فشله ما يمنعش مركز المساعدة من الشغل.
    loadCustomerContext();

    async function loadCustomerContext() {
        const [status, account, sie, waSub] = await Promise.all([
            fetchSystemStatus(), fetchAccountStatus(), fetchSieAccess(), fetchWhatsappSubscription()
        ]);

        if (status.ok) {
            const snapshot = { account, sie, waSub };
            const entitlements = {
                whatsapp: (account.ok && account.data?.whatsapp_enabled === true)
                    || (waSub.ok && waSub.data?.isActive === true),
                sie: sie.ok && sie.data?.is_enabled === true,
                aqar: account.ok && account.data?.aqar_enabled === true
            };
            impaired = impairedForCustomer(status.data, entitlements);
            renderRecommended(entitlements);
            void snapshot;
        }

        try {
            const tickets = await fetchUserTickets({});
            openTickets = (tickets || []).filter(t => !isClosed(t));
        } catch (err) {
            console.error('[HelpCenter] tickets:', err);
        }
    }

    /* ================= التحميل الأول ================= */
    loadArticles({ reset: true });
    loadCategories();
    loadPopular();
    loadFaq();

    async function loadArticles({ reset = false } = {}) {
        if (reset) { offset = 0; allLoaded = []; renderSkeletonCards(listEl, 3); }

        const result = await helpData.fetchArticles({ category: activeCategory, limit: PAGE_SIZE, offset });
        if (!result.ok) {
            renderState(listEl, {
                variant: 'error',
                title: 'تعذّر تحميل المقالات',
                text: result.error || 'تحقّق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', act: 'retry-articles' }
            });
            return;
        }

        totalArticles = result.data.total;
        allLoaded = reset ? result.data.items : allLoaded.concat(result.data.items);

        if (!allLoaded.length) {
            renderState(listEl, {
                variant: 'empty',
                title: activeCategory ? 'لا توجد مقالات في هذا الموضوع بعد' : 'لم تُنشر مقالات مساعدة بعد',
                text: activeCategory
                    ? 'جرّب موضوعاً آخر، أو اسأل فريق الدعم مباشرة.'
                    : 'فريق الدعم يجهّز المحتوى. حتى ذلك الحين تواصل معنا مباشرة وسنساعدك.',
                action: { label: 'إنشاء تذكرة', goto: '/customer-dashboard.html#support', variant: 'btn-primary' }
            });
            document.getElementById('helpLoadMore').hidden = true;
            return;
        }

        listEl.innerHTML = allLoaded.map(articleCard).join('');
        document.getElementById('helpLoadMore').hidden = allLoaded.length >= totalArticles;
    }

    async function loadCategories() {
        const container = document.getElementById('helpCategories');
        const result = await helpData.fetchCategories();
        if (!result.ok || !result.data.length) {
            document.getElementById('helpCategoriesSection').hidden = true;
            return;
        }
        sectionsWithContent.add('helpCategoriesSection');

        container.innerHTML = result.data.map(({ category, count }) => `
            <button type="button" class="filter-chip" data-category="${escapeHtml(category)}">
                ${escapeHtml(category)}<span class="chip-count">${count}</span>
            </button>`).join('');
    }

    async function loadPopular() {
        const result = await helpData.fetchPopularArticles(4);
        // "الأكثر قراءة" بيظهر لما يبقى فيه قراءات فعلية بس — بدون ذلك القسم
        // كان هيعرض ترتيبًا عشوائيًا ويسمّيه شعبية.
        if (!result.ok || !result.data.length) return;
        sectionsWithContent.add('helpPopularSection');
        document.getElementById('helpPopularSection').hidden = false;
        document.getElementById('helpPopularList').innerHTML = result.data.map(articleCard).join('');
    }

    async function loadFaq() {
        const result = await helpData.fetchFaq();
        if (!result.ok || !result.data.length) return;

        sectionsWithContent.add('helpFaqSection');
        document.getElementById('helpFaqSection').hidden = false;
        document.getElementById('helpFaqList').innerHTML = result.data.map(q => `
            <details class="faq-item">
                <summary>${escapeHtml(q.question)}</summary>
                <p>${escapeHtml(q.answer)}</p>
            </details>`).join('');
    }

    function renderRecommended(entitlements) {
        const section = document.getElementById('helpRecommendedSection');
        const matches = recommendedFor(allLoaded, entitlements).slice(0, 3);
        if (!matches.length) { section.hidden = true; return; }

        sectionsWithContent.add('helpRecommendedSection');
        section.hidden = false;
        document.getElementById('helpRecommendedList').innerHTML = matches.map(articleCard).join('');
    }

    function articleCard(article) {
        const summary = article.excerpt || '';
        return `
            <button type="button" class="article-card" data-article="${escapeHtml(article.id)}">
                <span class="article-card-category">${escapeHtml(article.category)}</span>
                <span class="article-card-title">${escapeHtml(article.title)}</span>
                ${summary ? `<span class="article-card-excerpt">${escapeHtml(summary)}</span>` : ''}
                <span class="article-card-meta">آخر تحديث ${escapeHtml(timeAgo(article.updated_at))}</span>
            </button>`;
    }

    /* ================= البحث ================= */
    let searchDebounce = null;

    searchInput?.addEventListener('input', (e) => {
        const value = e.target.value;
        clearBtn.hidden = !value.trim();
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => runSearch(value), 250);
    });

    clearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.hidden = true;
        runSearch('');
        searchInput.focus();
    });

    async function runSearch(value) {
        searchTerm = value.trim();

        // العطل المعلن أولاً: أهم من أي مقال لو المشكلة اللي بيدوّر عليها
        // إحنا عارفينها وقايمة دلوقتي.
        renderIncidentBanner();
        renderTicketHint();

        if (!searchTerm) {
            resultsSection.hidden = true;
            toggleBrowseSections(true);
            return;
        }

        toggleBrowseSections(false);
        resultsSection.hidden = false;
        renderSkeletonCards(resultsList, 2);

        const result = await helpData.searchArticles(searchTerm, { category: activeCategory });
        if (!result.ok) {
            renderState(resultsList, {
                variant: 'error',
                title: 'تعذّر تنفيذ البحث',
                text: result.error || 'حاول مرة أخرى بعد قليل.',
                action: { label: 'إعادة المحاولة', act: 'retry-search' }
            });
            return;
        }

        setText('helpResultsTitle', `نتائج البحث عن "${searchTerm}"`);

        if (!result.data.length) {
            renderState(resultsList, {
                variant: 'empty',
                title: 'لم نجد مقالاً مطابقاً لبحثك',
                text: 'جرّب كلمات أخرى أقصر، أو تواصل مع فريق الدعم وسنساعدك مباشرة.',
                action: { label: 'إنشاء تذكرة', goto: '/customer-dashboard.html#support', variant: 'btn-primary' }
            });
            return;
        }

        resultsList.innerHTML = result.data.map(articleCard).join('');
    }

    /**
     * أثناء البحث بنخفي التصفّح عشان النتيجة تبقى هي الشاشة.
     * القسم اللي مالوش محتوى أصلاً بيفضل مخفي: الرجوع من البحث ما ينفعش
     * يفتح قسمًا فاضيًا كان مخفيًا لسبب وجيه.
     */
    const sectionsWithContent = new Set(['helpQuickAccess']);

    function toggleBrowseSections(show) {
        ['helpQuickAccess', 'helpCategoriesSection', 'helpPopularSection',
         'helpFaqSection', 'helpRecommendedSection'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.hidden = show ? !sectionsWithContent.has(id) : true;
        });
    }

    function renderIncidentBanner() {
        const banner = document.getElementById('helpIncidentBanner');
        const match = searchTerm ? incidentMatchingSearch(searchTerm, impaired) : null;

        if (!match) { banner.hidden = true; return; }

        banner.hidden = false;
        banner.innerHTML = `
            <div class="alert-item alert-item--warning">
                <span class="alert-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
                <div class="alert-body">
                    <p class="alert-title">⚠️ يوجد عطل حالي في ${escapeHtml(match.service.name)}</p>
                    <p class="alert-text">
                        ${escapeHtml(match.info.label)}${match.startedAt ? ` — بدأت ${escapeHtml(timeAgo(match.startedAt))}` : ''}.
                        فريقنا يعمل على حل المشكلة.
                    </p>
                </div>
                <a class="btn btn-secondary btn-sm" href="/customer-dashboard.html#support">عرض حالة النظام</a>
            </div>`;
    }

    function renderTicketHint() {
        const hint = document.getElementById('helpTicketHint');
        const match = searchTerm ? openTicketMatching(searchTerm, openTickets, isClosed) : null;

        if (!match) { hint.hidden = true; return; }

        hint.hidden = false;
        hint.innerHTML = `
            <div class="alert-item alert-item--info">
                <span class="alert-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>
                <div class="alert-body">
                    <p class="alert-title">لديك بالفعل تذكرة مفتوحة مرتبطة بهذه المشكلة</p>
                    <p class="alert-text">#${escapeHtml(String(match.ticket_number ?? ''))} — ${escapeHtml(match.title)}</p>
                </div>
                <a class="btn btn-secondary btn-sm" href="/customer-dashboard.html?ticket=${escapeHtml(match.id)}">عرض التذكرة</a>
            </div>`;
    }

    /* ================= عرض المقال ================= */
    let currentArticle = null;

    async function openArticle(id) {
        homeView.hidden = true;
        articleView.hidden = false;
        window.scrollTo({ top: 0, behavior: 'auto' });

        setText('articleTitle', 'جارٍ التحميل…');
        setText('articleCategory', '');
        setText('articleMeta', '');
        document.getElementById('articleBody').innerHTML = '';

        const result = await helpData.fetchArticle(id);
        if (!result.ok || !result.data) {
            renderState(document.getElementById('articleBody'), {
                variant: 'error',
                title: 'تعذّر فتح المقال',
                text: 'ربما أُزيل المقال أو لم يعد منشوراً.',
                action: { label: 'العودة إلى مركز المساعدة', act: 'back-to-help' }
            });
            return;
        }

        currentArticle = result.data;
        setText('articleTitle', currentArticle.title);
        setText('articleCategory', currentArticle.category);
        setText('articleMeta', `آخر تحديث ${formatDate(currentArticle.updated_at)}`);
        document.getElementById('articleBody').innerHTML = renderArticleHtml(currentArticle.content);

        renderToc(currentArticle.content);
        resetFeedback();
        loadMyFeedback(currentArticle.id);
        loadRelated(currentArticle);

        helpData.markArticleViewed(currentArticle.id);

        const url = new URL(window.location.href);
        url.searchParams.set('article', currentArticle.id);
        history.pushState({ article: currentArticle.id }, '', url);
    }

    function renderToc(content) {
        const toc = document.getElementById('articleToc');
        const headings = tableOfContents(content);
        if (!headings.length) { toc.hidden = true; return; }

        toc.hidden = false;
        document.getElementById('articleTocList').innerHTML = headings
            .map(h => `<li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`)
            .join('');
    }

    async function loadRelated(article) {
        const section = document.getElementById('articleRelatedSection');
        const result = await helpData.fetchRelatedArticles(article);
        if (!result.ok || !result.data.length) { section.hidden = true; return; }

        section.hidden = false;
        document.getElementById('articleRelatedList').innerHTML = result.data.map(articleCard).join('');
    }

    function showHome() {
        articleView.hidden = true;
        homeView.hidden = false;
        currentArticle = null;
        const url = new URL(window.location.href);
        url.searchParams.delete('article');
        history.pushState({}, '', url);
    }

    /* ================= التقييم ================= */
    function resetFeedback() {
        document.getElementById('articleFeedbackFollowup').hidden = true;
        document.getElementById('articleFeedbackThanks').hidden = true;
        document.querySelectorAll('[data-feedback]').forEach(btn => {
            btn.disabled = false;
            btn.classList.remove('is-chosen');
        });
    }

    async function loadMyFeedback(articleId) {
        const result = await helpData.fetchMyArticleFeedback(articleId);
        if (!result.ok || !result.data) return;
        markFeedbackChosen(result.data.is_helpful);
    }

    function markFeedbackChosen(isHelpful) {
        const key = isHelpful ? 'yes' : 'no';
        document.querySelectorAll('[data-feedback]').forEach(btn => {
            btn.classList.toggle('is-chosen', btn.dataset.feedback === key);
        });
        document.getElementById('articleFeedbackThanks').hidden = false;
        document.getElementById('articleFeedbackFollowup').hidden = isHelpful;
    }

    document.getElementById('articleFeedback')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-feedback]');
        if (!btn || !currentArticle) return;

        const isHelpful = btn.dataset.feedback === 'yes';
        markFeedbackChosen(isHelpful);
        // upsert فالتصويت المكرر بيحدّث الرأي بدل ما يزوّد العدد
        await helpData.submitArticleFeedback(currentArticle.id, isHelpful);
    });

    /* ================= تفويض الأحداث ================= */
    document.addEventListener('click', (e) => {
        const card = e.target.closest('.article-card');
        if (card) { openArticle(card.dataset.article); return; }

        const chip = e.target.closest('.filter-chip[data-category]');
        if (chip) {
            const value = chip.dataset.category;
            activeCategory = activeCategory === value ? null : value;
            document.querySelectorAll('.filter-chip[data-category]').forEach(c =>
                c.classList.toggle('is-active', c.dataset.category === activeCategory));
            setText('helpArticlesTitle', activeCategory ? `مقالات: ${activeCategory}` : 'أحدث المقالات');
            document.getElementById('helpClearCategory').hidden = !activeCategory;
            if (searchTerm) runSearch(searchTerm); else loadArticles({ reset: true });
            return;
        }

        if (e.target.closest('#helpClearCategory')) {
            activeCategory = null;
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('is-active'));
            setText('helpArticlesTitle', 'أحدث المقالات');
            document.getElementById('helpClearCategory').hidden = true;
            loadArticles({ reset: true });
            return;
        }

        if (e.target.closest('#helpLoadMore')) {
            offset += PAGE_SIZE;
            loadArticles({ reset: false });
            return;
        }

        if (e.target.closest('#helpBackBtn') || e.target.closest('[data-action="back-to-help"]')) {
            showHome();
            return;
        }

        if (e.target.closest('[data-action="retry-articles"]')) { loadArticles({ reset: true }); return; }
        if (e.target.closest('[data-action="retry-search"]')) { runSearch(searchTerm); return; }

        const goto = e.target.closest('[data-goto]');
        if (goto) window.location.href = goto.dataset.goto;
    });

    // زر الرجوع في المتصفح يتنقّل بين المقال والصفحة الرئيسية
    window.addEventListener('popstate', () => {
        const id = new URLSearchParams(window.location.search).get('article');
        if (id) openArticle(id); else showHome();
    });

    // رابط عميق لمقال بعينه (يصلح للمشاركة ولروابط البريد)
    const deepArticle = new URLSearchParams(window.location.search).get('article');
    if (deepArticle) openArticle(deepArticle);

    // بحث قادم من الشريط العلوي في صفحة أخرى
    const deepQuery = new URLSearchParams(window.location.search).get('q');
    if (deepQuery && searchInput) {
        searchInput.value = deepQuery;
        clearBtn.hidden = false;
        runSearch(deepQuery);
    }
})();
