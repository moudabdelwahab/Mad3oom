// ✅ لا يوجد أي imports خارجية — TOTP مكتوب بالكامل + Rate Limiting حقيقي
// ضد محاولات التخمين المتكررة للكود

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 10;
const LOCK_MINUTES = 15;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(base32: string): Uint8Array {
  const cleaned = base32.replace(/=+$/, "").toUpperCase().replace(/\s+/g, "");
  let bits = "";
  for (const char of cleaned) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

async function generateTOTP(secretBytes: Uint8Array, counter: number): Promise<string> {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter % 0x100000000);

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binCode % 1000000).toString().padStart(6, "0");
}

/**
 * Resolves the caller's id by asking GoTrue to validate the bearer token,
 * instead of decoding the unverified `sub` claim out of the token. The
 * gateway already enforces verify_jwt, so this is defence in depth — but the
 * id now selects which stored TOTP secret we verify against, so it has to be
 * the authenticated identity and not merely a well-formed one.
 * Same shape as get-attachment-url; deliberately no supabase-js import, since
 * this function has always been dependency-free.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getAuthenticatedUserId(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: authHeader },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id || null;
  } catch {
    return null;
  }
}

const serviceHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
};

/** SHA-256 hex of a normalised recovery code — same as public.hash_recovery_code(). */
async function hashRecoveryCode(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(String(code).trim().toUpperCase());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

type StoredMfa = {
  secret: string;
  /** hashes of the unused recovery codes */
  recoveryHashes: string[];
  source: "private" | "legacy";
  legacyCodes?: string[];
};

/**
 * The enrolled TOTP secret for this user, or null when 2FA is not yet set up.
 *
 * When this returns a secret it is the ONLY secret we will accept, and the
 * caller-supplied `tempSecret` is ignored entirely. That is the fix: before,
 * a user with 2FA enabled could hand us any secret plus a matching code and
 * always get {verified:true}.
 *
 * Since migration 049 the secret lives in user_mfa_secrets (service role only).
 * Until that migration runs the table does not exist, so we fall back to the
 * old profiles columns — which is what lets this function ship first.
 */
async function getStoredMfa(userId: string): Promise<StoredMfa | null> {
  const priv = await fetch(
    `${SUPABASE_URL}/rest/v1/user_mfa_secrets?user_id=eq.${userId}&select=totp_secret,recovery_code_hashes`,
    { headers: serviceHeaders }
  );
  if (priv.ok) {
    const row = (await priv.json())?.[0];
    if (row && typeof row.totp_secret === "string" && row.totp_secret.length > 0) {
      return {
        secret: row.totp_secret,
        recoveryHashes: Array.isArray(row.recovery_code_hashes) ? row.recovery_code_hashes : [],
        source: "private",
      };
    }
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=two_factor_secret,two_factor_enabled,recovery_codes`,
    { headers: serviceHeaders }
  );
  if (!res.ok) throw new Error("profile_lookup_failed");
  const rows = await res.json();
  const secret = rows?.[0]?.two_factor_secret;
  if (typeof secret !== "string" || secret.length === 0) return null;
  const legacyCodes: string[] = Array.isArray(rows?.[0]?.recovery_codes) ? rows[0].recovery_codes : [];
  return {
    secret,
    recoveryHashes: await Promise.all(legacyCodes.map(hashRecoveryCode)),
    source: "legacy",
    legacyCodes,
  };
}

/** Removes one used recovery code so it can never be replayed. */
async function consumeRecoveryCode(userId: string, stored: StoredMfa, usedHash: string): Promise<number> {
  if (stored.source === "private") {
    const remaining = stored.recoveryHashes.filter((h) => h !== usedHash);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_mfa_secrets?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: { ...serviceHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ recovery_code_hashes: remaining, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error("consume_failed");
    return remaining.length;
  }
  const codes = stored.legacyCodes || [];
  const remaining: string[] = [];
  for (const c of codes) if ((await hashRecoveryCode(c)) !== usedHash) remaining.push(c);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: { ...serviceHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ recovery_codes: remaining }),
  });
  if (!res.ok) throw new Error("consume_failed");
  return remaining.length;
}

async function getRateLimit(userId: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/twofa_rate_limits?user_id=eq.${userId}&select=*`,
    {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    }
  );
  const rows = await res.json();
  return rows?.[0] || null;
}

async function upsertRateLimit(userId: string, patch: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/twofa_rate_limits`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ user_id: userId, ...patch }),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("authorization");
    const userId = await getAuthenticatedUserId(authHeader);

    if (!userId) {
      return new Response(
        JSON.stringify({ verified: false, error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { code, tempSecret, recoveryCode } = await req.json();

    if (!code && !recoveryCode) {
      return new Response(
        JSON.stringify({ verified: false, error: "Missing code" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ══════════ Which secret do we verify against? ══════════
    // Enrolled user  -> the secret stored on their profile. The body is ignored.
    // Not yet enrolled -> the enrollment secret they are holding client-side.
    //
    // The enrollment branch is safe because it grants nothing: the caller is
    // proving possession of a secret that they are about to store on their own
    // profile anyway (customer-settings-modal.js writes two_factor_secret right
    // after this returns). Every path that gates *access* on {verified:true} —
    // login.html and 2fa-verify.html — reaches the stored branch, because those
    // users have two_factor_enabled = true by definition.
    let stored: StoredMfa | null;
    try {
      stored = await getStoredMfa(userId);
    } catch {
      return new Response(
        JSON.stringify({ verified: false, error: "Internal Server Error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const storedSecret = stored?.secret ?? null;
    const isEnrollment = storedSecret === null;

    // A recovery code only means something for an enrolled account.
    if (recoveryCode && isEnrollment) {
      return new Response(
        JSON.stringify({ verified: false, error: "Missing code or secret" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const secretToVerify = storedSecret ?? tempSecret;

    if (!secretToVerify) {
      return new Response(
        JSON.stringify({ verified: false, error: "Missing code or secret" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ══════════ Rate Limiting ══════════
    const now = Date.now();
    let rateLimit = await getRateLimit(userId);

    if (rateLimit?.locked_until && new Date(rateLimit.locked_until).getTime() > now) {
      const retryAfterSec = Math.ceil(
        (new Date(rateLimit.locked_until).getTime() - now) / 1000
      );
      return new Response(
        JSON.stringify({
          verified: false,
          error: "too_many_attempts",
          retry_after_seconds: retryAfterSec,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // نافذة المحاولات انتهت صلاحيتها؟ نبدأ من جديد
    let failedAttempts = rateLimit?.failed_attempts ?? 0;
    const windowStart = rateLimit?.window_start
      ? new Date(rateLimit.window_start).getTime()
      : 0;
    if (now - windowStart > WINDOW_MINUTES * 60 * 1000) {
      failedAttempts = 0;
    }

    // ══════════ التحقق من الكود ══════════
    const secretBytes = base32Decode(secretToVerify);
    const period = 30;
    const currentCounter = Math.floor(now / 1000 / period);

    let verified = false;
    let usedRecoveryHash: string | null = null;
    if (code) {
      for (let errorWindow = -1; errorWindow <= 1; errorWindow++) {
        const otp = await generateTOTP(secretBytes, currentCounter + errorWindow);
        if (otp === code) {
          verified = true;
          break;
        }
      }
    } else if (recoveryCode && stored) {
      const suppliedHash = await hashRecoveryCode(recoveryCode);
      for (const h of stored.recoveryHashes) {
        if (constantTimeEquals(h, suppliedHash)) {
          verified = true;
          usedRecoveryHash = h;
          break;
        }
      }
    }

    let remainingRecoveryCodes: number | undefined;
    if (verified && usedRecoveryHash && stored) {
      try {
        remainingRecoveryCodes = await consumeRecoveryCode(userId, stored, usedRecoveryHash);
      } catch {
        // A code we cannot burn must not be accepted — it would be replayable.
        return new Response(
          JSON.stringify({ verified: false, error: "Internal Server Error" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (verified) {
      await upsertRateLimit(userId, {
        failed_attempts: 0,
        window_start: new Date().toISOString(),
        locked_until: null,
      });
    } else {
      failedAttempts += 1;
      const patch: Record<string, unknown> = {
        failed_attempts: failedAttempts,
        window_start: new Date(windowStart && now - windowStart <= WINDOW_MINUTES * 60 * 1000 ? windowStart : now).toISOString(),
      };
      if (failedAttempts >= MAX_ATTEMPTS) {
        patch.locked_until = new Date(now + LOCK_MINUTES * 60 * 1000).toISOString();
      }
      await upsertRateLimit(userId, patch);
    }

    return new Response(
      JSON.stringify({
        verified,
        enrollment: isEnrollment || undefined,
        usedRecoveryCode: usedRecoveryHash ? true : undefined,
        remainingRecoveryCodes,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("verify-2fa error:", err);
    return new Response(
      JSON.stringify({ verified: false, error: "Internal Server Error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
