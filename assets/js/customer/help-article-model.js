/**
 * help-article-model.js — تحويل المقال إلى عرض آمن، وربط البحث بحالة النظام.
 *
 * مفيش هنا DOM ولا استعلامات: منطق خالص يتّختبر لوحده.
 *
 * ليه بنكتب مُحوِّل بدل ما نحقن content كما هو؟
 *   الكود القديم كان بيعمل innerHTML للمتن مباشرة. المتن بيكتبه فريق الدعم،
 *   بس ده مش سبب كافٍ لحقن HTML خام في صفحة فيها جلسة العميل — أي لصق من
 *   مصدر خارجي بيبقى سكربت شغّال. بنهرب كل شيء وبندعم مجموعة تنسيق صغيرة
 *   ومقصودة، وبنستخرج العناوين للفهرس في نفس المرور.
 */

const HEADING_RE = /^\s{0,3}#{2,3}\s+(.+)$/;
const LIST_RE = /^\s{0,3}[-*]\s+(.+)$/;

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** معرّف ثابت للعنوان يصلح لمرساة الفهرس. */
function headingId(text, index) {
    const slug = String(text)
        .trim()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .slice(0, 60);
    return `sec-${index}-${slug || 'part'}`;
}

/**
 * يفكّ متن المقال إلى كتل + قائمة عناوين.
 * التنسيق المدعوم متعمَّد وصغير: `## عنوان`، و`- عنصر قائمة`، وفقرات مفصولة
 * بسطر فارغ. أي شيء آخر يُعرض كنص عادي.
 */
export function parseArticleBody(content) {
    const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    const headings = [];
    let paragraph = [];
    let list = [];

    const flushParagraph = () => {
        if (paragraph.length) {
            blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() });
            paragraph = [];
        }
    };
    const flushList = () => {
        if (list.length) {
            blocks.push({ type: 'list', items: [...list] });
            list = [];
        }
    };

    for (const line of lines) {
        const heading = line.match(HEADING_RE);
        if (heading) {
            flushParagraph(); flushList();
            const text = heading[1].trim();
            const id = headingId(text, headings.length);
            headings.push({ id, text });
            blocks.push({ type: 'heading', text, id });
            continue;
        }

        const item = line.match(LIST_RE);
        if (item) {
            flushParagraph();
            list.push(item[1].trim());
            continue;
        }

        if (!line.trim()) {
            flushParagraph(); flushList();
            continue;
        }

        flushList();
        paragraph.push(line.trim());
    }

    flushParagraph();
    flushList();
    return { blocks, headings };
}

/** HTML آمن للمتن — كل نص مهروب، والوسوم من عندنا. */
export function renderArticleHtml(content) {
    const { blocks } = parseArticleBody(content);
    return blocks.map(block => {
        if (block.type === 'heading') {
            return `<h3 id="${escapeHtml(block.id)}" class="article-heading">${escapeHtml(block.text)}</h3>`;
        }
        if (block.type === 'list') {
            return `<ul class="article-list">${block.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
        }
        return `<p>${escapeHtml(block.text)}</p>`;
    }).join('');
}

/** الفهرس يظهر للمقالات الطويلة فقط — عنوانان فأكثر. */
export function tableOfContents(content) {
    const { headings } = parseArticleBody(content);
    return headings.length >= 2 ? headings : [];
}

/* =========================================================
   ربط البحث بحالة النظام وبحالة العميل
========================================================= */

/** تطبيع عربي خفيف: يوحّد الألف والياء والتاء المربوطة ويسقط التشكيل. */
function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[ً-ْٰ]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .trim();
}

const STOP_WORDS = new Set(['في', 'من', 'على', 'عن', 'لا', 'ما', 'هل', 'مش', 'the', 'a', 'is', 'not']);

function meaningfulWords(text) {
    return normalize(text)
        .split(/[\s،,.:؟?!/\\-]+/)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * هل بحث العميل يخص خدمة معطّلة معروفة؟
 *
 * لو أيوه، الأفضل نقول له "فيه عطل معلن" قبل ما يقرا خمس مقالات أو يفتح
 * تذكرة لمشكلة إحنا عارفينها. المطابقة على اسم الخدمة ومفتاحها — بيانات
 * حقيقية من جدول services، مش قائمة كلمات مكتوبة في الكود.
 *
 * @param {string} term نص البحث
 * @param {Array<{service:object}>} impaired مخرجات impairedForCustomer
 */
export function incidentMatchingSearch(term, impaired = []) {
    const words = meaningfulWords(term);
    if (!words.length) return null;

    return impaired.find(entry => {
        const haystack = meaningfulWords(
            `${entry.service?.name || ''} ${entry.service?.service_key || ''} ${entry.service?.description || ''}`
        );
        return words.some(word => haystack.some(h => h.includes(word) || word.includes(h)));
    }) || null;
}

/**
 * مقالات مقترحة حسب ما يملكه العميل فعلاً.
 * مفيش اختراع تصنيفات: بنطابق كلمات التصنيف/العنوان مع الخدمات المفعّلة له.
 */
const ENTITLEMENT_TERMS = Object.freeze({
    whatsapp: ['واتساب', 'whatsapp'],
    sie: ['المحرك الذكي', 'sie', 'الذكاء'],
    aqar: ['عقار', 'aqar']
});

export function recommendedFor(articles = [], entitlements = {}) {
    const active = Object.keys(ENTITLEMENT_TERMS).filter(key => entitlements[key] === true);
    if (!active.length) return [];

    const terms = active.flatMap(key => ENTITLEMENT_TERMS[key].map(normalize));
    return articles.filter(article => {
        const haystack = normalize(`${article.title} ${article.category} ${article.excerpt || ''}`);
        return terms.some(term => haystack.includes(term));
    });
}

/**
 * هل عند العميل تذكرة مفتوحة تشبه ما يبحث عنه؟
 * غرضه إنه ما يفتحش تذكرة تانية لنفس المشكلة، ويشوف حالة اللي فتحه.
 */
export function openTicketMatching(term, tickets = [], isClosed = () => false) {
    const words = meaningfulWords(term);
    if (words.length < 1) return null;

    return tickets.find(ticket => {
        if (isClosed(ticket)) return false;
        const haystack = meaningfulWords(ticket.title || '');
        return words.some(word => haystack.some(h => h.includes(word) || word.includes(h)));
    }) || null;
}
