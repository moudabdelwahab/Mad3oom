/**
 * تخزين جلسة Supabase حسب اختيار «تذكرني» — assets/js/auth-storage.js
 *
 * المشكلة: عميل Supabase يُنشَأ افتراضيًا بتخزين localStorage دائم،
 * وcheckbox «تذكرني» في login.html لم يكن يُقرأ أصلًا، فكانت كل الجلسات
 * دائمة سواء اختار المستخدم «تذكرني» أم لا.
 *
 * الحل: محوّل تخزين ديناميكي (Storage adapter) يُمرَّر لعميل Supabase عبر
 * `auth.storage`. المحوّل يقرأ علامة `mad3oom-remember-me` (في
 * localStorage دائمًا — هي تفضيل وليست سرًا) عند كل عملية قراءة/كتابة،
 * فيوجّه الجلسة إلى:
 *   - localStorage     عند اختيار «تذكرني»      → تبقى بعد إغلاق المتصفح
 *   - sessionStorage   عند عدم اختياره          → تنتهي بإغلاق المتصفح،
 *     وتبقى سارية عند إعادة تحميل الصفحة في التبويب نفسه.
 *
 * بلا علامة محفوظة (جلسات قديمة من قبل الإصلاح) الافتراضي هو التخزين
 * الدائم، حتى لا تُفقَد جلسة قديمة صالحة.
 *
 * يستخدم هذا الملفَ كلُّ منشئٍ لعميل Supabase في مسار الدخول:
 * api-config.js (العميل المشترك لكل الصفحات) وlogin.html (عميلها المضمّن)،
 * بنفس العلامة ونفس المفتاح، حتى ترى كل الصفحات الجلسة نفسها أينما حُفظت.
 * لا يُغيّر هذا الملف أي مفتاح تخزين: مفتاح الجلسة الافتراضي
 * `sb-<project-ref>-auth-token` يبقى كما هو.
 */

/** مفتاح علامة اختيار «تذكرني» — تفضيل فقط، لا يحتوي أي سر. */
export const REMEMBER_ME_FLAG_KEY = 'mad3oom-remember-me';

const REMEMBER_ON = '1';
const REMEMBER_OFF = '0';

/* بديل في الذاكرة إن كان التخزين غير متاح (وضع خاص/مقيد) — يحافظ على
   عمل الدخول بدل رمي استثناء. */
function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
        get length() { return map.size; },
        key: (index) => [...map.keys()][index] ?? null,
    };
}

function storageAvailable(store) {
    try {
        const probe = '__mad3oom_storage_probe__';
        store.setItem(probe, '1');
        store.removeItem(probe);
        return true;
    } catch {
        return false;
    }
}

const localStore =
    (typeof localStorage !== 'undefined' && storageAvailable(localStorage))
        ? localStorage
        : createMemoryStorage();
const sessionStore =
    (typeof sessionStorage !== 'undefined' && storageAvailable(sessionStorage))
        ? sessionStorage
        : createMemoryStorage();

/**
 * اختيار «تذكرني» المحفوظ: true/false، أو null إن لم يختر المستخدم بعد
 * (جلسة قديمة من قبل الإصلاح).
 */
export function getRememberMeChoice() {
    try {
        const value = localStore.getItem(REMEMBER_ME_FLAG_KEY);
        if (value === REMEMBER_ON) return true;
        if (value === REMEMBER_OFF) return false;
        return null;
    } catch {
        return null;
    }
}

/** هل الجلسة دائمة؟ الافتراضي true (بلا علامة = جلسات ما قبل الإصلاح). */
export function isRememberMeEnabled() {
    return getRememberMeChoice() !== false;
}

export function setRememberMeChoice(remember) {
    try {
        localStore.setItem(REMEMBER_ME_FLAG_KEY, remember ? REMEMBER_ON : REMEMBER_OFF);
    } catch {
        /* تجاهل: فشل حفظ التفضيل لا يمنع الدخول */
    }
}

/** إعادة العلامة لقيمتها السابقة (تُستخدم عند فشل الدخول بعد ضبطها). */
export function restoreRememberMeChoice(previousChoice) {
    try {
        if (previousChoice === null || previousChoice === undefined) {
            localStore.removeItem(REMEMBER_ME_FLAG_KEY);
        } else {
            localStore.setItem(
                REMEMBER_ME_FLAG_KEY,
                previousChoice ? REMEMBER_ON : REMEMBER_OFF
            );
        }
    } catch {
        /* تجاهل */
    }
}

function activeStore() {
    return isRememberMeEnabled() ? localStore : sessionStore;
}

function inactiveStore() {
    return isRememberMeEnabled() ? sessionStore : localStore;
}

/**
 * محوّل تخزين Supabase (auth.storage): يقرأ العلامة عند كل عملية،
 * فيكتب Supabase توكن الجلسة في التخزين الصحيح حتى لو تغيّر الاختيار
 * بعد إنشاء العميل.
 */
export function createAuthStorage() {
    return {
        getItem: (key) => {
            try {
                return activeStore().getItem(key);
            } catch {
                return null;
            }
        },
        setItem: (key, value) => {
            try {
                activeStore().setItem(key, value);
            } catch {
                /* تجاهل: فشل الكتابة يظهر كخطأ جلسة من Supabase نفسه */
            }
        },
        removeItem: (key) => {
            try {
                activeStore().removeItem(key);
            } catch {
                /* تجاهل */
            }
        },
    };
}

function collectSupabaseTokenKeys(store) {
    const keys = [];
    try {
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
                keys.push(key);
            }
        }
    } catch {
        /* تجاهل */
    }
    return keys;
}

/**
 * يمسح توكن الجلسة من التخزين غير النشط فقط.
 * يُستدعى بعد دخول ناجح: جلسة قديمة في التخزين الآخر يجب ألا تبقى
 * (مثال: جلسة دائمة قديمة + دخول جديد دون «تذكرني»).
 * لا يمسح مفتاح code-verifier الخاص بـ OAuth (ينتهي بـ -code-verifier).
 */
export function purgeSessionFromInactiveStorage() {
    const store = inactiveStore();
    collectSupabaseTokenKeys(store).forEach((key) => {
        try {
            store.removeItem(key);
        } catch {
            /* تجاهل */
        }
    });
}

/** يمسح توكن الجلسة من كلا التخزينين (يستخدمه تسجيل الخروج). */
export function clearSupabaseSessionFromAllStorages() {
    [localStore, sessionStore].forEach((store) => {
        collectSupabaseTokenKeys(store).forEach((key) => {
            try {
                store.removeItem(key);
            } catch {
                /* تجاهل */
            }
        });
    });
}
