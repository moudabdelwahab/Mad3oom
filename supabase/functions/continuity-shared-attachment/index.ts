// continuity-shared-attachment — عرض مرفق داخل نطاق تسليم محدود (migrations/091_continuity_scoped_handover.sql).
//
// المنطق كله في handler.js (مختبر في tests/continuity-shared-attachment.test.mjs). هنا الربط فقط:
//   • JWT المستخدم يُتحقق منه، وفحص البوابة يُنادى **بهويته** (مفتاح anon + رأسه): كل قرار في القاعدة.
//   • مفتاح الخدمة لا يُستخدم إلا لتوقيع المسار الذي أعادته القاعدة، بالمدة التي أعادتها (≤ 60 ثانية).
//     لا يصل للمتصفح أبدًا.
// يُنشر بـ verify_jwt (يناديه المستخدم من المتصفح).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { BUCKET, handleShared } from "./handler.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const asUser = (token: string) => createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});

Deno.serve((req: Request) => handleShared(req, {
  getUser: async (token: string) => {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user;
  },
  rpc: (token: string, fn: string, args: Record<string, unknown>) => asUser(token).rpc(fn, args),
  sign: (path: string, ttl: number) => admin.storage.from(BUCKET).createSignedUrl(path, ttl),
}));
