// continuity-attachment-upload — رفع مرفقات الاستمرارية (migrations/080_continuity_attachments.sql).
//
// المنطق كله في handler.js (مختبر في tests/continuity-attachment-upload.test.mjs). هنا الربط فقط:
//   • JWT المستخدم يُتحقق منه، و begin/commit تُنادى **بهويته** (مفتاح anon + رأسه) فكل
//     قرار صلاحية في القاعدة.
//   • مفتاح الخدمة لا يُستخدم إلا للرفع إلى المسار الذي ولّدته القاعدة، ولحذف ملف فشل تأكيده.
//     لا يصل للمتصفح أبدًا.
//
// النشر يحتاج موافقة صريحة. قبل النشر تظل المرفقات غير قابلة للرفع (لا سياسة كتابة على
// المستودع)، وبعده تظل مطفأة حتى تفعيل attachments_enabled بقرار منفصل.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { BUCKET, handleUpload } from "./handler.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const asUser = (token: string) => createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve((req: Request) => handleUpload(req, {
  getUser: async (token: string) => {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user;
  },
  rpc: (token: string, fn: string, args: Record<string, unknown>) => asUser(token).rpc(fn, args),
  upload: (path: string, bytes: Uint8Array, contentType: string) =>
    admin.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false, cacheControl: "private, max-age=300" }),
  remove: (path: string) => admin.storage.from(BUCKET).remove([path]),
  sha256: async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes)),
}));
