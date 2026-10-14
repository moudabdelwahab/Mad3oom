// document-scan-callback — يستقبل نتيجة فحص موقَّعة من عامل الفحص ويسجّلها بمفتاح الخدمة.
// المنطق في handler.js (مختبر في tests/company-documents-functions.test.mjs). النشر يحتاج موافقة صريحة،
// والسر DOCUMENT_SCAN_SECRET لا يُضبط إلا مع عامل فحص حقيقي (docs/tenancy/DOCUMENT_SCANNER_RUNBOOK.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleScanCallback } from "./handler.js";

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } });
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve((req: Request) => handleScanCallback(req, {
  secret: Deno.env.get("DOCUMENT_SCAN_SECRET") ?? "",
  now: () => Date.now(),
  hmac: async (secret: string, message: string) => {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  },
  scanResult: (args: Record<string, unknown>) => admin.rpc("document_scan_result", args),
}));
