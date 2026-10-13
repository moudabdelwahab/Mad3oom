// continuity-attachment-cleanup — الحذف الفعلي لملفات مرفقات الاستمرارية (قرار S3).
// المنطق في handler.js (مختبر في tests/continuity-attachments.test.mjs).
//
// المصادقة: سر مشترك فقط (X-Cleanup-Secret)، بمقارنة بزمن ثابت. يُنشر بلا verify_jwt مثل باقي
// الدوال الداخلية (wf-executor، send-ticket-email): من يناديها هو pg_cron (088) بلا JWT.
// السر: CONTINUITY_CLEANUP_SECRET من البيئة لو مضبوط، وإلا صف internal_service_secrets
// ('continuity_attachment_cleanup') الذي يولّده 088 داخل القاعدة (لا يمر بأي ملف أو أداة).
// الطلب بلا ترويسة السر يُرفض قبل أي قراءة من القاعدة.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleCleanup } from "./handler.js";

const BUCKET = "continuity-attachments";
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function expectedSecret(): Promise<string> {
  const fromEnv = Deno.env.get("CONTINUITY_CLEANUP_SECRET") ?? "";
  if (fromEnv) return fromEnv;
  const { data, error } = await admin.from("internal_service_secrets").select("value")
    .eq("key", "continuity_attachment_cleanup").maybeSingle();
  return error ? "" : (data?.value ?? "");
}

Deno.serve(async (req: Request) => handleCleanup(req, {
  secret: req.headers.get("x-cleanup-secret") ? await expectedSecret() : "",
  queue: (limit: number) => admin.rpc("continuity_attachment_deletion_queue", { p_limit: limit }),
  remove: (paths: string[]) => admin.storage.from(BUCKET).remove(paths),
}));
