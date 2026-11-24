// login-location.js — التقاط موقع المتصفح الدقيق بعد نجاح تسجيل الدخول.
//
// الفكرة: اللوكيشن من الـ IP تقريبي على مستوى المدينة فقط. الموقع الدقيق
// يأتي من المتصفح نفسه (Geolocation API) — لكنه يحتاج إذن المستخدم، فلا
// يُطلب إلا لحساب المالك وحده، ولا يوقف الدخول أبدًا: الالتقاط في الخلفية
// (fire-and-forget)، وإن رُفض الإذن أو لم يكتمل قبل الانتقال يرجع تقرير
// تسجيل الدخول لموقع الـ IP تلقائيًا.
//
// الاستخدام (login.html، بعد نجاح signInWithPassword مباشرةً):
//   captureLoginLocation(supabase, data.user);
// بلا await عمدًا — الدخول لا ينتظر الموقع.
//
// نافذة المطابقة: الجسر يربط الصف بالجلسة إن كان captured_at بعد وقت إنشاء
// الجلسة بأقل من LOGIN_LOCATION_MATCH_WINDOW_MS (10 دقائق) — الالتقاط يتم
// ثواني بعد الدخول، فالنافذة واسعة عمدًا لتغطية تأخر الإذن.

/** الحساب الوحيد الذي يُلتقط موقعه — لا يظهر طلب الإذن لأي حساب آخر. */
export const LOGIN_LOCATION_OWNER_EMAIL = 'mahmoud@mad3oom.com';

/** أقصى انتظار لإجابة المتصفح (إذن + إحداثيات) قبل التخلي بصمت. */
export const LOGIN_LOCATION_TIMEOUT_MS = 8000;

/** نافذة ربط صف الموقع بجلسة تسجيل الدخول (من إنشاء الجلسة). */
export const LOGIN_LOCATION_MATCH_WINDOW_MS = 10 * 60 * 1000;

/**
 * يلتقط موقع المتصفح ويدرجه في login_locations. لا يرمي أبدًا ولا يرفض
 * الوعد أبدًا — يُرجع الصف المُدرج أو null عند أي فشل (حساب غير المالك،
 * بلا دعم Geolocation، رفض الإذن، انتهاء المهلة، خطأ الإدراج).
 */
export async function captureLoginLocation(supabase, user, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? LOGIN_LOCATION_TIMEOUT_MS;
  if (!user || user.email !== LOGIN_LOCATION_OWNER_EMAIL) return null;
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          clearTimeout(timer);
          try {
            const row = {
              user_id: user.id,
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy_m: Math.round(pos.coords.accuracy),
              source: 'browser',
            };
            const { error } = await supabase.from('login_locations').insert(row);
            finish(error ? null : row);
          } catch {
            finish(null);
          }
        },
        () => {
          clearTimeout(timer);
          finish(null);
        },
        {
          enableHighAccuracy: true,
          timeout: Math.max(timeoutMs - 500, 1000),
          maximumAge: 0,
        },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}
