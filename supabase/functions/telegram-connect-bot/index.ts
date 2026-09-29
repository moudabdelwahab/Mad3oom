// telegram-connect-bot
// ---------------------------------------------------------------------
// بتستدعيها الواجهة الأمامية (robot.js) بعد ما العميل يلصق التوكن اللي
// وصله من BotFather. الدالة بتتحقق من التوكن، تحفظه، وتسجّل الـ webhook
// بتاع بوت التيليجرام ده عشان يرجعلنا chat_id أول ما العميل يبعت /start.
//
// Auth: verify_jwt = true (لازم المستخدم يكون مسجل دخول في مدعوم)
// ---------------------------------------------------------------------

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';

    // عميل مربوط بهوية المستخدم اللي بعت الطلب (عشان نتأكد مين هو)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ success: false, error: 'غير مصرح — سجّل الدخول وحاول تاني.' }, 401);
    }
    const userId = userData.user.id;

    const { token } = await req.json();
    if (!token || typeof token !== 'string' || !token.trim()) {
      return json({ success: false, error: 'التوكن مطلوب.' }, 400);
    }
    const botToken = token.trim();

    // 1) التحقق من التوكن عبر Telegram API
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = await meRes.json();
    if (!meData.ok) {
      return json({ success: false, error: 'التوكن غير صالح، تأكد إنك نسخته صح من BotFather.' }, 400);
    }
    const botUsername: string = meData.result.username;

    // عميل بصلاحيات كاملة (service role) عشان يكتب في الجدول متجاوزًا RLS
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 2) هل العميل ده عنده صف موجود بالفعل؟ (نحافظ على نفس webhook_secret لو موجود)
    const { data: existing } = await admin
      .from('customer_telegram_bots')
      .select('webhook_secret')
      .eq('user_id', userId)
      .maybeSingle();

    let webhookSecret: string;

    if (existing) {
      webhookSecret = existing.webhook_secret;
      const { error: updErr } = await admin
        .from('customer_telegram_bots')
        .update({
          bot_token: botToken,
          bot_username: botUsername,
          is_active: true,
        })
        .eq('user_id', userId);
      if (updErr) throw updErr;
    } else {
      const { data: inserted, error: insErr } = await admin
        .from('customer_telegram_bots')
        .insert({ user_id: userId, bot_token: botToken, bot_username: botUsername })
        .select('webhook_secret')
        .single();
      if (insErr) throw insErr;
      webhookSecret = inserted.webhook_secret;
    }

    // 3) تسجيل الـ webhook بتاع بوت العميل ده عشان يرجّعلنا chat_id أول ما يبعت /start
    const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-webhook/${userId}`;
    const setHookRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ['message'],
      }),
    });
    const setHookData = await setHookRes.json();
    if (!setHookData.ok) {
      // البوت اتسجل بس تسجيل الـ webhook فشل - نرجّع تحذير بدل ما نفشل كل حاجة
      return json({
        success: true,
        botUsername,
        warning: 'اتحفظ البوت بس حصلت مشكلة في تفعيل الاستقبال التلقائي، حاول تاني بعدين.',
      });
    }

    return json({ success: true, botUsername });
  } catch (err) {
    console.error('telegram-connect-bot error:', err);
    return json({ success: false, error: 'حصلت مشكلة غير متوقعة، حاول تاني.' }, 500);
  }
});
