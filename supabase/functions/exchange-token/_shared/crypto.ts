async function getKey(): Promise<CryptoKey> {
  const b64 = Deno.env.get("WHATSAPP_TOKEN_ENC_KEY");
  if (!b64) {
    throw new Error("WHATSAPP_TOKEN_ENC_KEY is not set as a Supabase secret.");
  }
  const rawKey = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (rawKey.length !== 32) {
    throw new Error("WHATSAPP_TOKEN_ENC_KEY must decode to exactly 32 bytes (256-bit).");
  }
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function encryptSecret(plainText: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plainText);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${toB64(iv)}:${toB64(new Uint8Array(cipherBuf))}`;
}

export async function decryptSecret(stored: string): Promise<string> {
  const key = await getKey();
  const [ivB64, dataB64] = stored.split(":");
  if (!ivB64 || !dataB64) {
    throw new Error("Invalid encrypted value format (expected iv:ciphertext).");
  }
  const iv = fromB64(ivB64);
  const data = fromB64(dataB64);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plainBuf);
}
