// telegram-webhook/<user_id>
// ---------------------------------------------------------------------
// Telegram بينادي على الـ URL ده مباشرة (مفيش JWT بتاع Supabase) أول ما
// حد يبعت رسالة لبوت عميل معين. بنتحقق من الطلب عن طريق secret_token
// اللي Telegram بيرجّعه في هيدر X-Telegram-Bot-Api-Secret-Token ولازم
// يطابق webhook_secret المخزن لنفس العميل.
//
// Auth: verify_jwt = false (لازم كده، تليجرام مش هيبعت JWT بتاعنا)
// ---------------------------------------------------------------------

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const userId = segments[segments.length - 1]; // .../telegram-webhook/<user_id>

    if (!userId) return new Response('missing user id', { status: 400 });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: bot, error } = await admin
      .from('customer_telegram_bots')
      .select('bot_token, webhook_secret, chat_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !bot) return new Response('not found', { status: 404 });

    const secretHeader = req.headers.get('x-telegram-bot-api-secret-token');
    if (secretHeader !== bot.webhook_secret) {
      return new Response('unauthorized', { status: 401 });
    }

    const update = await req.json();
    const chatId = update?.message?.chat?.id;

    if (chatId && String(chatId) !== String(bot.chat_id)) {
      await admin
        .from('customer_telegram_bots')
        .update({ chat_id: String(chatId), connected_at: new Date().toISOString() })
        .eq('user_id', userId);

      // رسالة تأكيد للعميل جوه بوته الخاص
      await fetch(`https://api.telegram.org/bot${bot.bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: 'تم ربط بوتك بمنصة مدعوم بنجاح ✅\nمن دلوقتي هتوصلك هنا رسالة فورية كل ما حد يفتح تذكرة من نطاقك الفرعي.',
        }),
      });
    }

    // لازم نرجّع 200 بسرعة عشان Telegram ميعملش retry غير ضروري
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('telegram-webhook error:', err);
    // نرجّع 200 برضه عشان تليجرام ما يعيدش المحاولة على حاجة مش هتتحل بإعادة المحاولة
    return new Response('ok', { status: 200 });
  }
});
