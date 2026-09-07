/**
 * help-data.js — طبقة قراءة مركز المساعدة.
 *
 * المصدر: جدول knowledge_base (migrations/013) اللي بتديره واجهة الإدارة
 * admin/knowledge-base-admin.html، وجدول suggested_questions للأسئلة الشائعة.
 *
 * كل استعلام هنا محكوم بـRLS: العميل بيقرا المنشور غير الداخلي بس. مفيش
 * تصفية أمنية في الواجهة — الواجهة بتعرض اللي القاعدة سمحت بيه.
 *
 * زي customer-data.js: كل دالة بترجّع { ok, data, error } بدل ما ترمي، عشان
 * فشل قسم واحد ما يوقّعش الصفحة كلها.
 */

import { supabase } from '/api-config.js';

async function safe(label, fn) {
    try {
        const data = await fn();
        return { ok: true, data, error: null };
    } catch (err) {
        console.error(`[HelpData] ${label}:`, err?.message || err);
        return { ok: false, data: null, error: err?.message || 'تعذّر تحميل المحتوى' };
    }
}

/** الأعمدة اللي بتكفي للقوائم — المتن الكامل بيتجاب عند فتح المقال بس. */
const LIST_COLUMNS = 'id, title, category, excerpt, updated_at, published_at, view_count';

/**
 * صفحة من المقالات. الترقيم مقصود: مركز المساعدة لازم يفضل سريع مع مئات
 * المقالات، فما بنجيبش الكل ولا بنجيب المتن في القائمة.
 */
export async function fetchArticles({ category = null, limit = 12, offset = 0 } = {}) {
    return safe('articles', async () => {
        let query = supabase
            .from('knowledge_base')
            .select(LIST_COLUMNS, { count: 'exact' })
            .order('updated_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (category) query = query.eq('category', category);

        const { data, error, count } = await query;
        if (error) throw error;
        return { items: data || [], total: count ?? (data || []).length };
    });
}

/**
 * بحث حقيقي في العنوان والمقتطف والمتن، مرتّب بالصلة.
 * الترتيب بيتم في القاعدة (search_help_articles) مش في المتصفح، فالبحث
 * بيفضل صحيح حتى لو المقالات أكتر من صفحة واحدة.
 */
export async function searchArticles(term, { category = null, limit = 20, offset = 0 } = {}) {
    return safe('searchArticles', async () => {
        const { data, error } = await supabase.rpc('search_help_articles', {
            p_query: term || null,
            p_category: category,
            p_limit: limit,
            p_offset: offset
        });
        if (error) throw error;
        return data || [];
    });
}

/** المقال كاملاً. المتن بيتجاب هنا بس. */
export async function fetchArticle(id) {
    return safe('article', async () => {
        const { data, error } = await supabase
            .from('knowledge_base')
            .select('id, title, category, excerpt, content, updated_at, published_at, view_count')
            .eq('id', id)
            .maybeSingle();
        if (error) throw error;
        return data;
    });
}

/**
 * التصنيفات الموجودة فعلاً مع عدد مقالات كل واحد.
 * مش قائمة ثابتة في الكود: التصنيف اللي مفيهوش مقال ما بيظهرش، فما بنعرضش
 * تصنيفات وهمية.
 */
export async function fetchCategories() {
    return safe('categories', async () => {
        const { data, error } = await supabase
            .from('knowledge_base')
            .select('category');
        if (error) throw error;

        const counts = new Map();
        for (const row of data || []) {
            const key = (row.category || '').trim();
            if (!key) continue;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts.entries()]
            .map(([category, count]) => ({ category, count }))
            .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, 'ar'));
    });
}

/**
 * الأكثر قراءة — من عدّاد حقيقي (view_count).
 * بنرجّع اللي عليه قراءات فعلية بس: عدّاد على صفر مش "شائع"، وعرضه كده
 * بيخترع شعبية غير موجودة.
 */
export async function fetchPopularArticles(limit = 5) {
    return safe('popularArticles', async () => {
        const { data, error } = await supabase
            .from('knowledge_base')
            .select(LIST_COLUMNS)
            .gt('view_count', 0)
            .order('view_count', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data || [];
    });
}

/** مقالات مرتبطة: نفس التصنيف، ما عدا المقال الحالي. */
export async function fetchRelatedArticles(article, limit = 4) {
    return safe('relatedArticles', async () => {
        if (!article?.category) return [];
        const { data, error } = await supabase
            .from('knowledge_base')
            .select(LIST_COLUMNS)
            .eq('category', article.category)
            .neq('id', article.id)
            .order('updated_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data || [];
    });
}

/** الأسئلة الشائعة النشطة (محتوى تحريري قائم، كان محجوبًا بـRLS بلا سياسات). */
export async function fetchFaq() {
    return safe('faq', async () => {
        const { data, error } = await supabase
            .from('suggested_questions')
            .select('id, question, answer, category')
            .eq('is_active', true)
            .order('id', { ascending: true });
        if (error) throw error;
        return data || [];
    });
}

/** زيادة عدّاد القراءة عبر دالة محصورة (العميل ماعندوش UPDATE على الجدول). */
export async function markArticleViewed(articleId) {
    try {
        await supabase.rpc('increment_article_view', { p_article_id: articleId });
    } catch (err) {
        // العدّاد إحصائي بحت — فشله ما يمنعش قراءة المقال
        console.error('[HelpData] markArticleViewed:', err?.message || err);
    }
}

/** تقييم العميل لمقال. upsert لأن القيد الفريد بيمنع تكرار التصويت. */
export async function submitArticleFeedback(articleId, isHelpful) {
    return safe('articleFeedback', async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('جلسة غير صالحة');

        const { error } = await supabase
            .from('kb_article_feedback')
            .upsert(
                { article_id: articleId, user_id: user.id, is_helpful: isHelpful, updated_at: new Date().toISOString() },
                { onConflict: 'article_id,user_id' }
            );
        if (error) throw error;
        return true;
    });
}

/** تقييم العميل الحالي لمقال، عشان الواجهة تعرض اختياره السابق. */
export async function fetchMyArticleFeedback(articleId) {
    return safe('myArticleFeedback', async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;

        const { data, error } = await supabase
            .from('kb_article_feedback')
            .select('is_helpful')
            .eq('article_id', articleId)
            .eq('user_id', user.id)
            .maybeSingle();
        if (error) throw error;
        return data;
    });
}
