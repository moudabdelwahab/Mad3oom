// company-document-download — رابط تنزيل موقَّع 60 ثانية بعد قرار القاعدة وتسجيله.
// المنطق في handler.js (مختبر في tests/company-documents-functions.test.mjs). النشر يحتاج موافقة صريحة.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleDownload } from "./handler.js";
import { BUCKET } from "../_shared/company-documents.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const asUser = (token: string) => createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});

Deno.serve((req: Request) => handleDownload(req, {
  getUser: async (token: string) => {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user;
  },
  rpc: (token: string, fn: string, args: Record<string, unknown>) => asUser(token).rpc(fn, args),
  sign: async (path: string, seconds: number, fileName: string) => {
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, seconds, { download: fileName || true });
    return error ? { error } : { signedUrl: data.signedUrl };
  },
}));
