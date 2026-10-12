// continuity-attachment-cleanup — الحذف الفعلي لملفات مرفقات الاستمرارية (قرار S3).
// المنطق في handler.js (مختبر في tests/continuity-attachment-upload.test.mjs).
// النشر وضبط CONTINUITY_CLEANUP_SECRET وجدولته يحتاج موافقة صريحة.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleCleanup } from "./handler.js";

const BUCKET = "continuity-attachments";
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req: Request) => handleCleanup(req, {
  secret: Deno.env.get("CONTINUITY_CLEANUP_SECRET") ?? "",
  queue: (limit: number) => admin.rpc("continuity_attachment_deletion_queue", { p_limit: limit }),
  remove: (paths: string[]) => admin.storage.from(BUCKET).remove(paths),
}));
