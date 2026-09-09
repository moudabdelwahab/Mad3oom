import { supabase } from '/api-config.js';

/**
 * توقيع روابط التخزين الخاص.
 *
 * لماذا هذا الملف موجود
 *   مستودعا `tickets` و`chat-attachments` كانا عامّين: الرابط المخزَّن في
 *   قاعدة البيانات كان `/object/public/...`، أي **صالحًا للأبد بلا مصادقة**،
 *   ومن يراه مرة يمرّره لأي أحد. بعد قلبهما إلى خاصّين لم يعد هناك رابط دائم:
 *   يُوقَّع رابط قصير الأجل عند كل عرض، وRLS على storage.objects هي التي تقرر
 *   إن كان المنادي يستحقه أصلًا.
 *
 * لماذا 300 ثانية
 *   الرابط الموقَّع سرّ قابل للتمرير: من ينسخه يستطيع إعطاءه لغير مصرَّح له،
 *   وRLS لا تُسأل ثانيةً بعد التوقيع. فالمدة هي حجم نافذة إعادة التمرير.
 *   والصفحة تملك جلسة دائمًا، فإعادة التوقيع عند كل عرض مجانية عمليًّا —
 *   ولا سبب لإطالة المدة. خمس دقائق تكفي لفتح PDF أو صورة، وتُنزل النافذة
 *   من **الأبد** إلى دقائق. التنزيل الصريح الذي قد يُنقر بعد حين يأخذ 900.
 */
export const SIGNED_URL_TTL = 300;
export const SIGNED_URL_TTL_DOWNLOAD = 900;

/**
 * يستخرج مسار الكائن من قيمة مخزَّنة، أيًّا كان شكلها.
 *
 * الصفوف القديمة تحمل رابطًا عامًّا مطلقًا، والجديدة تحمل المسار وحده. الاثنان
 * يمرّان من هنا فلا يحتاج المستدعي أن يعرف أيّهما عنده.
 */
export function toObjectPath(bucket, value) {
    if (!value || typeof value !== 'string') return null;
    const marker = `/object/public/${bucket}/`;
    const at = value.indexOf(marker);
    if (at !== -1) return decodeURIComponent(value.slice(at + marker.length).split('?')[0]);
    const signedMarker = `/object/sign/${bucket}/`;
    const atSigned = value.indexOf(signedMarker);
    if (atSigned !== -1) return decodeURIComponent(value.slice(atSigned + signedMarker.length).split('?')[0]);
    // ليس رابطًا: نعتبره مسارًا كما هو
    if (value.startsWith('http://') || value.startsWith('https://')) return null;
    return value.replace(/^\/+/, '');
}

/** يوقّع مسارًا واحدًا. يعيد null بدل أن يرمي: مرفق واحد لا يُسقط الصفحة. */
export async function signedUrl(bucket, value, expiresIn = SIGNED_URL_TTL) {
    const path = toObjectPath(bucket, value);
    if (!path) return null;
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
    if (error) {
        // الرفض هنا قرار صلاحية مشروع في الأغلب (RLS)، لا عطل.
        console.warn(`[storage-urls] تعذّر توقيع ${bucket}/${path}:`, error.message);
        return null;
    }
    return data?.signedUrl ?? null;
}

/**
 * يوقّع عدة مسارات في نداء واحد.
 *
 * createSignedUrls يعيد النتائج **بترتيب المدخلات**، لكن العناصر التي فشل
 * توقيعها تعود بـ error وsignedUrl فارغ — فنطابق بالترتيب لا بالمسار، ونترك
 * الفاشل null بدل أن نزيح البقية.
 */
export async function signedUrls(bucket, values, expiresIn = SIGNED_URL_TTL) {
    const paths = values.map(v => toObjectPath(bucket, v));
    const wanted = paths.filter(Boolean);
    if (wanted.length === 0) return paths.map(() => null);

    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(wanted, expiresIn);
    if (error) {
        console.warn(`[storage-urls] تعذّر توقيع دفعة من ${bucket}:`, error.message);
        return paths.map(() => null);
    }

    const byPath = new Map();
    (data ?? []).forEach((row, i) => {
        const key = row?.path ?? wanted[i];
        if (key) byPath.set(key, row?.signedUrl ?? null);
    });
    return paths.map(p => (p ? (byPath.get(p) ?? null) : null));
}
