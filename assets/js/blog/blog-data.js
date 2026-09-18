/**
 * blog-data.js — طبقة قراءة/كتابة المدوّنة.
 *
 * نفس اصطلاح company-data.js: كل دالة ترجّع { ok, data, error } بدل أن ترمي
 * استثناءً، فسقوط قسم لا يُسقط الصفحة كلها.
 *
 * فارق واحد جوهري عن بقية طبقات البيانات في المنصة: **القارئ هنا قد يكون
 * بلا جلسة**. المدوّنة سطح عام، وكل ما في هذا الملف يعمل بمفتاح anon وحده.
 * ولذلك لا سطر واحد هنا يقرأ profiles أو يفترض وجود مستخدم — اسم الكاتب
 * يأتي على صف المقال (لقطة عرض)، وهو سبب وجود العمود أصلًا.
 *
 * التفويض كله في القاعدة: نفس النداءات تمامًا تخدم الزائر والمحرّر، والفارق
 * هو ما ترجّعه RLS لكلٍّ منهما. لا فرع «إن كنت أدمن فاقرأ من هنا» — فرع كهذا
 * هو تحديدًا ما ينتج مسار قراءة ثانيًا بقواعد مختلفة.
 */

import { supabase } from '/api-config.js';
import { PAGE_SIZE } from '/assets/js/blog/blog-model.js';

async function safe(label, fn) {
    try {
        const data = await fn();
        return { ok: true, data, error: null };
    } catch (err) {
        console.error(`[BlogData] ${label}:`, err?.message || err);
        return { ok: false, data: null, error: err?.message || 'تعذّر تحميل المحتوى' };
    }
}

/* =========================================================
   قراءة عامة
========================================================= */

/**
 * فهرس المدوّنة / نتيجة البحث.
 * العدد الكلي يأتي على الصفوف نفسها (total_count)، فلا نداء ثانٍ للترقيم.
 */
export async function fetchFeed({
    query = null, category = null, tag = null, featured = null,
    limit = PAGE_SIZE, offset = 0
} = {}) {
    return safe('feed', async () => {
        const { data, error } = await supabase.rpc('blog_feed', {
            p_query: query || null,
            p_category: category || null,
            p_tag: tag || null,
            p_featured: featured === null ? null : Boolean(featured),
            p_limit: limit,
            p_offset: offset
        });
        if (error) throw error;

        const rows = data || [];
        return { rows, total: Number(rows[0]?.total_count || 0) };
    });
}

/**
 * مقال واحد بالـslug.
 *
 * قراءة جدولية مباشرة لا RPC: لا انضمام يحتاج دالة، وRLS تكفي تمامًا —
 * المسودّة تعود `null` للزائر ومقالًا كاملًا للمحرّر من نفس السطر.
 * maybeSingle لأن «غير موجود» حالة عرض لا خطأ.
 */
export async function fetchPost(slug) {
    return safe('post', async () => {
        const { data, error } = await supabase
            .from('blog_posts')
            .select(`
                id, slug, title, subtitle, excerpt, content,
                cover_url, cover_alt, tags, status, is_featured,
                reading_minutes, word_count, view_count,
                seo_title, seo_description,
                author_name, author_title,
                published_at, created_at, updated_at,
                category:blog_categories ( slug, name )
            `)
            .eq('slug', slug)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    });
}

export async function fetchRelated(slug, limit = 3) {
    return safe('related', async () => {
        const { data, error } = await supabase.rpc('blog_related', {
            p_slug: slug,
            p_limit: limit
        });
        if (error) throw error;
        return data || [];
    });
}

export async function fetchCategories() {
    return safe('categories', async () => {
        const { data, error } = await supabase.rpc('blog_categories_with_counts');
        if (error) throw error;
        return data || [];
    });
}

export async function fetchTags(limit = 18) {
    return safe('tags', async () => {
        const { data, error } = await supabase.rpc('blog_tags', { p_limit: limit });
        if (error) throw error;
        return data || [];
    });
}

/**
 * عدّاد المشاهدة.
 *
 * لا ترجّع شيئًا ولا تُعطّل الصفحة عند الفشل: القارئ لا يعنيه أن العدّاد لم
 * يُزَد، ورسالة خطأ هنا كانت ستكون ضجيجًا خالصًا.
 */
export async function countView(slug) {
    try {
        await supabase.rpc('increment_blog_view', { p_slug: slug });
    } catch (err) {
        console.warn('[BlogData] countView:', err?.message || err);
    }
}

/* =========================================================
   التحرير — لوحة الإدارة / لوحة المالك
========================================================= */
/*
 * لا بوابة صلاحية مكتوبة هنا.
 *
 * في company-data.js توجد بوابات تسبق النداء (createCompanyMember مثلًا)،
 * وسببها هناك أن المسار Edge Function: البوابة توفّر رحلة فاشلة وتُظهر سبب
 * الرفض. هنا المسار جدول محكوم بـRLS، فالرفض يأتي من القاعدة بنفس السرعة
 * ومع رسالته — وأي فحص إضافي في المتصفح كان سيصير **مصدر قرار ثانيًا**
 * يتفرّع عن الأول عند أول تعديل على السياسة.
 *
 * ما يفعله المتصفح هو إخفاء أزرار لا يملكها المستخدم؛ وذلك تهذيبُ واجهة
 * لا أمان، والأمان في السياسات وحدها.
 */

/**
 * كل المقالات كما يراها المنادي — RLS تقرّر إن كان ذلك كل شيء أم المنشور.
 *
 * بلا مُعاملات تصفية عمدًا: اللوحة تُصفّي وتبحث في المتصفح على هذه الصفوف
 * نفسها، فالتصفية فورية بلا رحلة شبكة لكل ضغطة. الحدّ 200 هو ما يجعل ذلك
 * صحيحًا ومحدودًا معًا، واللوحة تقول للمحرّر حين تبلغه بدل أن تقتطع صامتةً.
 */
export const ADMIN_POST_LIMIT = 200;

export async function fetchAllPosts() {
    return safe('allPosts', async () => {
        const { data, error } = await supabase
            .from('blog_posts')
            .select(`
                id, slug, title, excerpt, status, is_featured, tags,
                reading_minutes, view_count, author_name,
                published_at, created_at, updated_at,
                category:blog_categories ( id, slug, name )
            `)
            .order('updated_at', { ascending: false })
            .limit(ADMIN_POST_LIMIT);

        if (error) throw error;
        return data || [];
    });
}

/** مقال كامل للتحرير — بما فيه المسودّات، إن سمحت RLS للمنادي. */
export async function fetchPostForEdit(id) {
    return safe('postForEdit', async () => {
        const { data, error } = await supabase
            .from('blog_posts')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    });
}

/**
 * الحمولة المرسَلة للقاعدة.
 *
 * ما لا يُرسَل هنا مقصود بقدر ما يُرسَل:
 *   • reading_minutes / word_count — يحسبهما المحفّز. إرسالهما كان سيسمح
 *     بصفٍّ يقول «دقيقة» ومتنه ألف كلمة.
 *   • view_count — تكتبه increment_blog_view وحدها.
 *   • published_at — يضبطه المحفّز عند أول نشر، إلا حين يختار المحرّر
 *     موعدًا صراحةً (الجدولة)، وحينها القيمة قراره لا اشتقاقنا.
 */
function toRow(values, { authorId, authorName } = {}) {
    const row = {
        slug: String(values.slug || '').trim(),
        title: String(values.title || '').trim(),
        subtitle: values.subtitle?.trim() || null,
        excerpt: values.excerpt?.trim() || null,
        content: String(values.content || ''),
        cover_url: values.cover_url?.trim() || null,
        cover_alt: values.cover_alt?.trim() || null,
        category_id: values.category_id || null,
        tags: Array.isArray(values.tags) ? values.tags : [],
        status: values.status || 'draft',
        is_featured: Boolean(values.is_featured),
        seo_title: values.seo_title?.trim() || null,
        seo_description: values.seo_description?.trim() || null,
        author_name: String(values.author_name || authorName || 'فريق مدعوم').trim()
    };

    if (values.author_title !== undefined) row.author_title = values.author_title?.trim() || null;
    if (authorId) row.author_id = authorId;

    if (values.publish_at) row.published_at = new Date(values.publish_at).toISOString();
    else if (values.clear_schedule) row.published_at = null;

    return row;
}

export async function createPost(values, context = {}) {
    return safe('createPost', async () => {
        const { data, error } = await supabase
            .from('blog_posts')
            .insert([toRow(values, context)])
            .select('id, slug')
            .single();
        if (error) throw new Error(friendlyWriteError(error));
        return data;
    });
}

export async function updatePost(id, values, context = {}) {
    return safe('updatePost', async () => {
        const { data, error } = await supabase
            .from('blog_posts')
            .update(toRow(values, context))
            .eq('id', id)
            .select('id, slug')
            .maybeSingle();
        if (error) throw new Error(friendlyWriteError(error));

        // صفر صفوف = السياسة لم تطابق. الرسالة الصامتة هنا أسوأ من الخطأ:
        // المحرّر كان سيرى «تم الحفظ» ولا شيء تغيّر.
        if (!data) throw new Error('لم يُحفظ التعديل: حسابك غير مخوَّل بتحرير المدوّنة، أو حُذف المقال.');
        return data;
    });
}

export async function deletePost(id) {
    return safe('deletePost', async () => {
        const { data, error } = await supabase
            .from('blog_posts')
            .delete()
            .eq('id', id)
            .select('id');
        if (error) throw new Error(friendlyWriteError(error));
        if (!data || data.length === 0) {
            throw new Error('لم يُحذف المقال: حسابك غير مخوَّل بتحرير المدوّنة.');
        }
        return true;
    });
}

/** تبديل حالة سريع من قائمة اللوحة (نشر / أرشفة / تمييز). */
export async function patchPost(id, patch) {
    return safe('patchPost', async () => {
        const { data, error } = await supabase
            .from('blog_posts')
            .update(patch)
            .eq('id', id)
            .select('id, status, is_featured, published_at')
            .maybeSingle();
        if (error) throw new Error(friendlyWriteError(error));
        if (!data) throw new Error('لم يُنفَّذ التغيير: حسابك غير مخوَّل بتحرير المدوّنة.');
        return data;
    });
}

/* =========================================================
   التصنيفات — إدارة
========================================================= */

export async function fetchAllCategories() {
    return safe('allCategories', async () => {
        const { data, error } = await supabase
            .from('blog_categories')
            .select('id, slug, name, description, sort_order, is_active')
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });
        if (error) throw error;
        return data || [];
    });
}

export async function saveCategory(values) {
    return safe('saveCategory', async () => {
        const row = {
            slug: String(values.slug || '').trim(),
            name: String(values.name || '').trim(),
            description: values.description?.trim() || null,
            sort_order: Number(values.sort_order) || 100,
            is_active: values.is_active !== false
        };

        const request = values.id
            ? supabase.from('blog_categories').update(row).eq('id', values.id).select('id').maybeSingle()
            : supabase.from('blog_categories').insert([row]).select('id').single();

        const { data, error } = await request;
        if (error) throw new Error(friendlyWriteError(error));
        if (!data) throw new Error('لم يُحفظ التصنيف: حسابك غير مخوَّل بتحرير المدوّنة.');
        return data;
    });
}

export async function deleteCategory(id) {
    return safe('deleteCategory', async () => {
        const { data, error } = await supabase
            .from('blog_categories').delete().eq('id', id).select('id');
        if (error) throw new Error(friendlyWriteError(error));
        if (!data || data.length === 0) {
            throw new Error('لم يُحذف التصنيف: حسابك غير مخوَّل بتحرير المدوّنة.');
        }
        return true;
    });
}

/* =========================================================
   رسائل الخطأ
========================================================= */

/**
 * يترجم أخطاء القاعدة إلى ما يفيد المحرّر.
 *
 * رسالة PostgREST الخام («duplicate key value violates unique constraint
 * blog_posts_slug_key») صحيحة ولا تقول للمحرّر ما يفعله. والترجمة هنا على
 * **رمز** الخطأ لا على نصّه، فلا تنكسر بتغيّر صياغة الخادم.
 */
function friendlyWriteError(error) {
    const code = error?.code || '';

    if (code === '23505') return 'الرابط المختصر مستخدَم في مقال آخر. اختر رابطًا غيره.';
    if (code === '23514') return 'الرابط المختصر غير صالح: حروف وأرقام وشرطات فقط، بلا فراغات أو علامات.';
    if (code === '23503') return 'التصنيف المختار لم يعد موجودًا. حدّث الصفحة واختر تصنيفًا آخر.';
    if (code === '42501') return 'حسابك غير مخوَّل بتحرير المدوّنة. التحرير من لوحة الإدارة أو لوحة المالك فقط.';

    return error?.message || 'تعذّر الحفظ. حاول مرة أخرى.';
}
