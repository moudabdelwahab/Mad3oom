// نفس آلية التشفير المستخدمة في manage-external-integration / test-integration-connection
// بالحرف (AES-GCM بمفتاح مشتق SHA-256 من INTEGRATIONS_ENC_KEY) — أي اختلاف هنا
// يعني عدم القدرة على قراءة المفاتيح المحفوظة بالفعل.

async function getAesKey(usages: KeyUsage[]): Promise<CryptoKey> {
    const secret = Deno.env.get("INTEGRATIONS_ENC_KEY");
    if (!secret) throw new Error("INTEGRATIONS_ENC_KEY is not configured");
    const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, usages);
}

export async function decryptJson(b64: string): Promise<Record<string, any>> {
    const key = await getAesKey(["decrypt"]);
    const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const cipherBuf = combined.slice(12);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBuf);
    return JSON.parse(new TextDecoder().decode(plainBuf));
}
