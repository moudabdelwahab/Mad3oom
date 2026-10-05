// ============================================================
// aqar-auth — تبادل توكن منصة مدعوم بجلسة على مشروع عقار
// ------------------------------------------------------------
// أين تعمل هذه الدالة: **على مشروع المنصة (مدعوم)**.
//   التطبيق يناديها قبل امتلاكه أي جلسة، فلا بد أن تكون على المشروع الذي يملك
//   الهوية. وهي تخاطب مشروعين:
//     • المنصة  — عبر HTTP بتوكن المستخدم (PLATFORM_URL / PLATFORM_ANON_KEY)
//     • عقار    — عبر عميل خدمة مُعنوَن صراحةً (AQAR_URL / AQAR_SERVICE_ROLE_KEY)
//   ولا تستخدم SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY المحقونين للوصول إلى
//   بيانات عقار: هما يشيران إلى المشروع المضيف — أي المنصة.
//
// حدود صارمة:
//   • الهوية تأتي من توكن المنصة وحده. الطلب لا يحمل — ولا يُقرأ منه — أي
//     user_id أو owner_id؛ كل معرّف يُشتقّ مما تؤكده المنصة.
//   • لا عملية واحدة على عقار قبل نجاح التحقق من التوكن وقراءة التفعيل.
//   • المسار الوحيد المقبول هو `exchange`. لا استعلام حرّ ولا RPC عام ولا وصول
//     إلى جدول باختيار المتصل.
//   • لا يُسجّل توكن المنصة ولا مفتاح خدمة عقار في أي سجل أو رد.
//
// لماذا التبادل أصلًا:
//   المشروعان لهما مصادقة منفصلة. توكن المنصة موقّع بسرّها (HS256) ولا
//   تُصدِر مفتاحًا عامًا (jwks فارغ)، فلا يستطيع مشروع التطبيق التحقق منه.
//   وحتى لو أمكن، فـ auth.users هنا لا تحوي ذلك المستخدم بينما كل جداول
//   التطبيق تشير إليها بمفتاح أجنبي.
//
// المسار:
//   POST /aqar-auth/exchange  { platform_access_token }
//     → { token_hash, email, has_access }
//   يستخدمه التطبيق مع supabase.auth.verifyOtp للحصول على جلسة كاملة.
//
// التحقق يتم بسؤال المنصة نفسها (GET /auth/v1/user)، فلا نحتاج سرّها ولا
// أي صلاحية أدمن عليها. وقراءة التفعيل تتم بتوكن المستخدم نفسه، فتحكمها
// سياسات RLS على المنصة.
//
// ⚠️ verify_jwt = false عن قصد ولا يجوز قلبها:
//   هذه هي نقطة دخول المستخدم قبل امتلاكه أي جلسة على مشروع التطبيق —
//   منها يحصل على الجلسة أصلًا. التطبيق يستدعيها بلا ترويسة Authorization
//   (انظر lib/supabase/platformAuth.ts). تفعيل verify_jwt يجعل البوابة
//   ترفض الطلب بـ 401 قبل تنفيذ الكود، فينكسر تسجيل الدخول كلياً.
//   المصادقة هنا مُنفَّذة داخل الدالة: التوكن يُتحقَّق منه بسؤال المنصة.
//
// الأسرار المطلوبة (تُضبط على مشروع المنصة حيث تُنشر الدالة):
//   PLATFORM_URL           عنوان مشروع المنصة
//   PLATFORM_ANON_KEY      مفتاحه العام
//   AQAR_URL               عنوان مشروع عقار
//   AQAR_SERVICE_ROLE_KEY  مفتاح خدمة عقار — لا يخرج من هذه الدالة أبدًا
//   PROVISIONING_SECRET    سرّ التزويد لـwhatsapp-dispatch على عقار — مقصور على
//                          store_credential. غيابه يُعطّل التزويد وحده.
//   AQAR_ANON_KEY          مفتاح عقار العام. لازم لاجتياز بوابة Supabase لأن
//                          whatsapp-dispatch منشورة بـverify_jwt = true، فترفض
//                          البوابة أي طلب بلا Authorization **قبل تنفيذ الكود**.
//                          عام ومضمَّن في الـAPK أصلًا، وليس حارسًا: الحارس هو
//                          PROVISIONING_SECRET الذي يقرؤه gate.ts.
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { CORS_HEADERS } from './_shared/cors.ts';
import {
  provisionLiveCredentials,
  revokeCredentialsForLostChannels,
  type PlatformProvisionRow,
} from './_shared/provisioning.ts';

/** يُقرأ من profiles على المنصة؛ غيابه يعني أن العمود لم يُضَف بعد. */
const ENABLED_COLUMN = 'aqar_enabled';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function platformConfig() {
  const url = Deno.env.get('PLATFORM_URL');
  const anonKey = Deno.env.get('PLATFORM_ANON_KEY');
  if (!url || !anonKey) throw new Error('إعدادات مشروع المنصة غير مكتملة');
  return { url: url.replace(/\/+$/, ''), anonKey };
}

/**
 * عميل **مشروع عقار** بصلاحية الخدمة.
 *
 * ⚠️ يُعنوَن باسمه صراحةً ولا يرث المشروع المضيف. هذه الدالة تُنشر على مشروع
 * المنصة، و`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` تحقنهما المنصة تلقائيًا
 * فتشير إلى **المنصة** لا إلى عقار — واستخدامهما هنا كان سيكتب هوية عقار
 * وقنواته في قاعدة المنصة، ويُصدر جلسة على المشروع الخطأ. الاسمان محجوزان ولا
 * يمكن تجاوزهما بسرّ مطابق، فالاسمان الجديدان إلزاميان لا تفضيل.
 *
 * القيمتان سرّا دالة ولا تخرجان أبدًا: لا في رد ولا في سجل ولا إلى العميل.
 */
function adminClient() {
  const url = Deno.env.get('AQAR_URL');
  const serviceKey = Deno.env.get('AQAR_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    // بلا اسم المشروع ولا قيمته — رسالة تشخيص لا تسريب.
    throw new Error('إعدادات مشروع عقار غير مكتملة (AQAR_URL / AQAR_SERVICE_ROLE_KEY)');
  }
  return createClient(url, serviceKey, {
    db: { schema: 'aqar' },
    auth: { persistSession: false },
  });
}

interface PlatformUser {
  id: string;
  email: string;
}

/**
 * عميل **مشروع المنصة** بصلاحية الخدمة.
 *
 * هذه الدالة منشورة على المنصة، فـSUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * المحقونان يشيران إليها هي. وهو الاستخدام الصحيح الوحيد لهما هنا: نداء دوال
 * التزويد المحليّة. أي وصول إلى عقار يمرّ بـadminClient() المُعنوَن صراحةً.
 */
function platformServiceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('إعدادات مشروع المنصة غير مكتملة');
  return createClient(url, key, { auth: { persistSession: false } });
}

/** يتحقق من التوكن بسؤال المنصة — لا نتحقق من التوقيع بأنفسنا. */
async function verifyPlatformToken(token: string): Promise<PlatformUser | null> {
  const { url, anonKey } = platformConfig();

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return null;

  const user = (await response.json()) as { id?: string; email?: string };
  if (!user?.id || !user?.email) return null;

  return { id: user.id, email: user.email.toLowerCase() };
}

/**
 * يقرأ حالة تفعيل تطبيق عقار من profiles على المنصة.
 *
 * يُقرأ بتوكن المستخدم نفسه لا بمفتاح خدمة، فتحكمه سياسات RLS هناك ولا نحتاج
 * أي صلاحية إضافية على المنصة.
 *
 * يرجع null إذا تعذّرت القراءة (العمود غير موجود، أو RLS تمنع) — والمستدعي
 * يعامل ذلك كرفض صريح لا كسماح ضمني.
 */
async function readPlatformEnabled(token: string, platformUserId: string): Promise<boolean | null> {
  const { url, anonKey } = platformConfig();

  const response = await fetch(
    `${url}/rest/v1/profiles?id=eq.${platformUserId}&select=${ENABLED_COLUMN}`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    console.error('[aqar-auth] تعذّرت قراءة التفعيل:', response.status, await response.text());
    return null;
  }

  const rows = (await response.json()) as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) return null;

  return rows[0][ENABLED_COLUMN] === true;
}

/** حقول القناة الآمنة للعرض. أي مفتاح خارجها لا يُنسَخ ولو ظهر في metadata. */
interface PlatformChannel {
  platform_integration_id: string;
  phone_number_id: string;
  phone_number: string;
  label: string;
}

/**
 * يقرأ أرقام واتساب المربوطة بحساب المالك على المنصة.
 *
 * بتوكن المستخدم نفسه — فتحكمه RLS هناك ولا نحتاج أي صلاحية إضافية، تمامًا
 * كقراءة التفعيل أعلاه.
 *
 * ⚠️ `select=id,metadata` حصرًا: صفّ `integrations` يحمل عمود `access_token`
 * الخاص بواتساب، و`select=*` كان سيجلبه إلى ذاكرة هذه الدالة بلا داعٍ. عقار
 * لا تقرأ ذلك التوكن ولا تخزّنه ولا تمرّره — هذا حدّ معماري لا تحسين.
 * والحقول تُنسخ بقائمة بيضاء صريحة لا بتمرير `metadata` كما هو.
 *
 * يرجع null عند أي تعذّر — والمستدعي يكمل تسجيل الدخول بلا مزامنة.
 */
async function readPlatformChannels(
  token: string,
  platformUserId: string,
): Promise<PlatformChannel[] | null> {
  const { url, anonKey } = platformConfig();

  const response = await fetch(
    `${url}/rest/v1/integrations?user_id=eq.${platformUserId}` +
      `&provider=eq.whatsapp&select=id,metadata`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    console.error('[aqar-auth] تعذّرت قراءة قنوات واتساب:', response.status);
    return null;
  }

  const rows = (await response.json()) as { id?: string; metadata?: Record<string, unknown> }[];
  if (!Array.isArray(rows)) return null;

  return rows
    .map(row => {
      const meta = row?.metadata ?? {};
      return {
        platform_integration_id: String(row?.id ?? ''),
        phone_number_id: String(meta.phone_number_id ?? '').trim(),
        phone_number: String(meta.phone_number ?? '').trim(),
        label: String(meta.verified_name ?? '').trim(),
      };
    })
    .filter(channel => channel.phone_number_id !== '');
}

/** يجد مستخدم التطبيق المقابل أو ينشئه. */
async function resolveAppUser(platformUser: PlatformUser): Promise<string> {
  const admin = adminClient();

  const { data: existingId } = await admin.rpc('find_app_user_for_platform', {
    p_platform_user_id: platformUser.id,
  });
  if (existingId) return existingId as string;

  // قد يكون البريد مسجلاً هنا من قبل الربط — نعيد استخدامه بدل إنشاء نسخة
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const byEmail = list?.users?.find(u => u.email?.toLowerCase() === platformUser.email);
  if (byEmail) return byEmail.id;

  const { data: created, error } = await admin.auth.admin.createUser({
    email: platformUser.email,
    email_confirm: true,
    user_metadata: { platform_user_id: platformUser.id, source: 'mad3oom' },
  });

  if (error || !created?.user) {
    throw new Error(`تعذّر إنشاء حساب التطبيق: ${error?.message ?? 'سبب غير معروف'}`);
  }
  return created.user.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Only POST is supported' }, 405);

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/aqar-auth\/?/, '').replace(/\/+$/, '') || 'exchange';

  if (route !== 'exchange') {
    return json({ error: `مسار غير معروف: ${route}`, available: ['exchange'] }, 404);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { platform_access_token?: string };
    const token = body.platform_access_token?.trim();
    if (!token) return json({ error: 'platform_access_token مطلوب' }, 400);

    // 1) التحقق من التوكن لدى المنصة
    const platformUser = await verifyPlatformToken(token);
    if (!platformUser) {
      return json({ error: 'توكن المنصة غير صالح', reason: 'invalid_platform_token' }, 401);
    }

    // 2) قراءة التفعيل من المنصة — المصدر الوحيد للحقيقة
    const enabled = await readPlatformEnabled(token, platformUser.id);
    if (enabled === null) {
      return json(
        {
          error: 'تعذّر قراءة حالة تفعيل تطبيق عقار من المنصة',
          reason: 'enabled_flag_unreadable',
        },
        502,
      );
    }

    // 3) إيجاد/إنشاء المستخدم المقابل هنا
    const appUserId = await resolveAppUser(platformUser);

    // 4) الربط ومزامنة التفعيل في معاملة واحدة
    const admin = adminClient();
    const { error: linkErr } = await admin.rpc('link_platform_identity', {
      p_app_user_id: appUserId,
      p_platform_user_id: platformUser.id,
      p_email: platformUser.email,
      p_enabled: enabled,
    });
    if (linkErr) return json({ error: `تعذّر الربط: ${linkErr.message}` }, 500);

    // 5) مزامنة قنوات واتساب — بيانات وصفية فقط، ولا تفشل تسجيل الدخول.
    //
    // هنا لأن هذه هي اللحظة الوحيدة التي يملك فيها عقار توكن المنصة: التوكن
    // يُستهلك ولا يُحفظ (lib/supabase/platformAuth.ts). والبديل — تخزينه —
    // مرفوض.
    //
    // الفشل يُبتلع عمدًا: تعذُّر قراءة القنوات لا يعني أن الحساب بلا صلاحية،
    // ومنع الدخول بسببه يحوّل عطلًا في المزامنة إلى انقطاع كامل عن التطبيق.
    // وsync_whatsapp_channels نفسها لا تمحو شيئًا عند قائمة فارغة، فانقطاع
    // مؤقّت لا يبدو كفكّ ربط.
    let channels: PlatformChannel[] | null = null;
    try {
      channels = await readPlatformChannels(token, platformUser.id);
      if (channels && channels.length > 0) {
        const { error: syncErr } = await admin.rpc('sync_whatsapp_channels', {
          p_owner_id: appUserId,
          p_mad3oom_user_id: platformUser.id,
          p_channels: channels,
        });
        if (syncErr) console.error('[aqar-auth] فشلت مزامنة القنوات:', syncErr.message);
      }
    } catch (err) {
      console.error(
        '[aqar-auth] استثناء أثناء مزامنة القنوات:',
        err instanceof Error ? err.message : String(err),
      );
    }

    // 5.5) التزويد الآلي لاعتمادات Live — **لا يفشل تسجيل الدخول أبدًا**
    //
    // هنا لأن هذه هي اللحظة التي اجتمع فيها كل ما يلزم: هوية المنصة
    // متحقّقة، وحالة التفعيل معروفة، والقنوات مزامنة لتوّها.
    //
    // الحدّ في كل نداء هو (owner_user_id، phone_number_id) صريحين معًا. لا
    // «أول قناة» ولا موضع في مصفوفة ولا NULL — دالة المنصة ترفض الفراغ أصلًا
    // وتتحقق من الملكية بنفسها من public.integrations.
    //
    // الاستدعاء إلى عقار يستخدم PROVISIONING_SECRET لا DISPATCH_SECRET: الأول
    // مقصور على store_credential، والثاني كان سيمنح تفريغ الطابور — أي إرسال
    // رسائل — مع كل نداء تزويد.
    let provisioningSummary: Record<string, unknown> | null = null;
    try {
      const platform = platformServiceClient();
      const dispatchUrl = `${(Deno.env.get('AQAR_URL') ?? '').replace(/\/+$/, '')}/functions/v1/whatsapp-dispatch`;
      const provisioningSecret = Deno.env.get('PROVISIONING_SECRET') ?? '';
      // بوابة Supabase على whatsapp-dispatch (verify_jwt = true) ترفض أي طلب
      // بلا Authorization قبل تنفيذ سطر واحد من الكود. فغياب هذا المفتاح كان
      // يعني 401 من البوابة، لا من gate.ts — وهو ما أوقف التزويد كليًّا في
      // أول تشغيل. نفشل مغلقين بسبب مكتوب بدل تكرار 401 صامت.
      const aqarAnonKey = Deno.env.get('AQAR_ANON_KEY') ?? '';

      if (!provisioningSecret) {
        console.error('[aqar-auth] PROVISIONING_SECRET غير مضبوط — تخطّي التزويد');
      } else if (!aqarAnonKey) {
        console.error('[aqar-auth] AQAR_ANON_KEY غير مضبوط — تخطّي التزويد (بوابة عقار سترفض بلا Authorization)');
      } else {
        // قنوات عقار بعد المزامنة: النشطة تُزوَّد، والمفقودة تُبطَل.
        const { data: channelRows } = await admin
          .from('whatsapp_channels')
          .select('phone_number_id, status')
          .eq('owner_id', appUserId);

        const rows = (channelRows ?? []) as Array<{ phone_number_id: string; status: string }>;

        const deps = {
          async provisionOnPlatform(ownerUserId: string, phoneNumberId: string) {
            const { data, error } = await platform.rpc('aqar_provision_live_credential', {
              p_owner_user_id: ownerUserId,
              p_phone_number_id: phoneNumberId,
            });
            if (error) throw new Error(`aqar_provision_live_credential: ${error.message}`);
            const row = (Array.isArray(data) ? data[0] : data) as PlatformProvisionRow | null;
            if (!row) throw new Error('التزويد لم يُرجع صفًّا');
            return row;
          },
          async revokeOnPlatform(ownerUserId: string, phoneNumberId: string) {
            const { data, error } = await platform.rpc('aqar_revoke_live_credential', {
              p_owner_user_id: ownerUserId,
              p_phone_number_id: phoneNumberId,
            });
            if (error) throw new Error(`aqar_revoke_live_credential: ${error.message}`);
            return (data as number | null) ?? 0;
          },
          async aqarHasActiveLive(ownerId: string, phoneNumberId: string) {
            const { data } = await admin
              .from('mad3oom_credentials')
              .select('status')
              .eq('owner_id', ownerId)
              .eq('phone_number_id', phoneNumberId)
              .eq('environment', 'live')
              .eq('status', 'active')
              .limit(1);
            return Array.isArray(data) && data.length > 0;
          },
          async storeInAqar(input: {
            ownerId: string; phoneNumberId: string; apiKey: string; clientSlug: string;
          }) {
            const response = await fetch(dispatchUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // الحارس الفعلي — يقرؤه gate.ts ويقصر الصلاحية على
                // store_credential وحده.
                'x-provisioning-secret': provisioningSecret,
                // لاجتياز بوابة Supabase فقط. المفتاح عام، وgate.ts لا يقرؤه،
                // فهو ليس تفويضًا بل تذكرة دخول للبوابة.
                Authorization: `Bearer ${aqarAnonKey}`,
                apikey: aqarAnonKey,
              },
              body: JSON.stringify({
                action: 'store_credential',
                owner_id: input.ownerId,
                phone_number_id: input.phoneNumberId,
                environment: 'live',
                api_key: input.apiKey,
                client_slug: input.clientSlug,
              }),
            });
            const payload = await response.json().catch(() => ({}));
            // النجاح = تخزين مشفّر مؤكَّد بجولة فكّ تشفير. أي شيء أقلّ فشلٌ،
            // فلا يُعَدّ التزويد ناجحًا لمجرد أن المفتاح أُنشئ على المنصة.
            if (!response.ok || payload?.ok !== true || payload?.stored !== true) {
              throw new Error(String(payload?.error ?? `store_credential أعادت ${response.status}`));
            }
            if (payload?.round_trip_ok !== true) {
              throw new Error('فشل التحقق من فكّ تشفير الاعتماد بعد تخزينه');
            }
          },
          async markAqarRevoked(ownerId: string, phoneNumberId: string) {
            // صفّ عقار يُبطَل أيضًا، وإلا بقي يعرض «فعّالًا» لمفتاح ميت.
            const { error } = await admin
              .from('mad3oom_credentials')
              .update({ status: 'revoked', revoked_at: new Date().toISOString() })
              .eq('owner_id', ownerId)
              .eq('phone_number_id', phoneNumberId)
              .eq('environment', 'live')
              .eq('status', 'active');
            if (error) throw new Error(`mark_revoked: ${error.message}`);
          },
          log: (message: string) => console.log(`[aqar-auth] ${message}`),
        };

        const provisionReport = await provisionLiveCredentials(deps, {
          enabled,
          platformUserId: platformUser.id,
          aqarOwnerId: appUserId,
          channels: rows,
        });

        const revokeReport = await revokeCredentialsForLostChannels(deps, {
          platformUserId: platformUser.id,
          aqarOwnerId: appUserId,
          lostChannels: rows.filter(r => r.status !== 'active').map(r => r.phone_number_id),
        });

        // ملخّص بلا أي مفتاح — آخر أربعة محارف على الأكثر.
        provisioningSummary = {
          attempted: provisionReport.attempted,
          provisioned: provisionReport.provisioned,
          already_active: provisionReport.alreadyActive,
          failed: provisionReport.failed,
          revoked: revokeReport.revokedChannels.length,
        };

        if (provisionReport.failed > 0) {
          console.error(
            '[aqar-auth] فشل تزويد جزئي:',
            JSON.stringify(provisionReport.outcomes.filter(o => o.result !== 'provisioned' && o.result !== 'already_active')),
          );
        }
      }
    } catch (err) {
      // الفشل يُسجّل ولا يمنع الدخول: تعذُّر التزويد لا يعني أن الحساب بلا
      // صلاحية، ومنع الدخول بسببه يحوّل عطلًا في التكامل إلى انقطاع كامل.
      console.error(
        '[aqar-auth] استثناء أثناء التزويد الآلي:',
        err instanceof Error ? err.message : String(err),
      );
    }

    // الربط صار معلومًا فعلًا. «مفعَّل للإرسال» قرار منفصل يعتمد على وجود
    // مفتاح تكامل للرقم، ولا يُقرَأ من هنا.
    const whatsapp = {
      linked: (channels?.length ?? 0) > 0,
      channels_count: channels?.length ?? 0,
      phone_number: channels?.[0]?.phone_number ?? '',
      status: channels === null
        ? 'sync_unavailable'
        : channels.length === 0
          ? 'no_channels'
          : 'synced',
    };

    // 6) إصدار توكن لمرة واحدة يبدّله التطبيق بجلسة كاملة
    const { data: link, error: linkGenErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: platformUser.email,
    });

    if (linkGenErr || !link?.properties?.hashed_token) {
      return json({ error: `تعذّر إصدار الجلسة: ${linkGenErr?.message ?? ''}` }, 500);
    }

    return json({
      token_hash: link.properties.hashed_token,
      email: platformUser.email,
      has_access: enabled,
      app_user_id: appUserId,
      whatsapp,
      // أعداد فقط — لا معرّف قناة ولا أي جزء من مفتاح.
      provisioning: provisioningSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'خطأ غير متوقّع';
    console.error('[aqar-auth]', message);
    return json({ error: message }, 500);
  }
});
