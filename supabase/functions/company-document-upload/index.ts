// company-document-upload — رفع إصدار مستند شركة (migrations/100_company_documents.sql).
// المنطق في handler.js (مختبر في tests/company-documents-functions.test.mjs). هنا الربط فقط:
//   • begin/commit بهوية المستخدم (مفتاح anon + رأسه): كل قرار صلاحية في القاعدة.
//   • مفتاح الخدمة للرفع إلى المسار الذي ولّدته القاعدة فقط، ولحذف ملف فشل تأكيده، وللتأكيد
//     (document_upload_commit_server، 104): البصمة تُحسب هنا ولا يرسلها المستخدم.
// النشر يحتاج موافقة صريحة، والمفتاح company_documents_enabled يبقى مطفأً حتى قرار منفصل.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleUpload } from "./handler.js";
import { BUCKET } from "../_shared/company-documents.js";

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
  commit: (version: string, actor: string, sha256: string | null) =>
    admin.rpc("document_upload_commit_server", { p_version: version, p_actor: actor, p_sha256: sha256 }),
  upload: (path: string, bytes: Uint8Array, contentType: string) =>
    admin.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false, cacheControl: "private, max-age=0" }),
  download: async (path: string) => {
    const { data, error } = await admin.storage.from(BUCKET).download(path);
    return error || !data ? null : new Uint8Array(await data.arrayBuffer());
  },
  remove: (path: string) => admin.storage.from(BUCKET).remove([path]),
  sha256: async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes)),
}));
