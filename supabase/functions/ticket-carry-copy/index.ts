// ticket-carry-copy — ينسخ مرفقات العميل للتذاكر المنسوخة (101) بمفتاح الخدمة، بطلب من مُجدول بسر مشترك.
// المنطق في handler.js (مختبر في tests/ticket-carry-copy.test.mjs). النشر يحتاج موافقة صريحة، والسر
// CARRY_COPY_SECRET لا يُضبط إلا مع تفعيل ticket_carry_enabled (docs/tenancy/H2_CUSTOMER_TRANSFERS_CARRY_101_PROD_INSTALL.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleCarryCopy } from "./handler.js";

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = "tickets";
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve((req: Request) => handleCarryCopy(req, {
  secret: Deno.env.get("CARRY_COPY_SECRET") ?? "",
  sha256: async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes)),
  queue: (limit: number) => admin.rpc("carry_copy_queue", { p_limit: limit }),
  download: async (path: string) => {
    const { data, error } = await admin.storage.from(BUCKET).download(path);
    if (error) {
      const status = (error as { statusCode?: string | number }).statusCode;
      return { notFound: String(status) === "404" || /not.?found/i.test(error.message), error };
    }
    return { bytes: new Uint8Array(await data.arrayBuffer()) };
  },
  upload: async (path: string, bytes: Uint8Array, mime: string) => {
    const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
    const status = String((error as { statusCode?: string | number } | null)?.statusCode ?? "");
    return { error, exists: !!error && (status === "409" || /exists|duplicate/i.test(error.message)) };
  },
  complete: (args: Record<string, unknown>) => admin.rpc("carry_copy_complete", args),
}));
