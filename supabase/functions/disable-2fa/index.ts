// ============================================================
// disable-2fa
// ------------------------------------------------------------
// Turning 2FA OFF now requires proving possession of the second factor.
//
// WHY THIS EXISTS
// login.html calls signInWithPassword FIRST and challenges for the TOTP
// code SECOND. Between those two steps the browser holds a fully valid
// session, and profiles_update_policy lets a user update their own row.
// So an attacker who had only the password could PATCH
// two_factor_enabled=false straight through PostgREST and walk past the
// challenge. verify-2fa being correct did not help: the attacker never
// called it.
//
// The companion trigger enforce_2fa_change_requires_challenge blocks that
// PATCH for any caller with an auth.uid(). This function is the sanctioned
// way back out, and it costs a current TOTP code or a recovery code —
// neither of which a password-only attacker has.
//
// Enrollment is deliberately NOT routed through here: it starts from
// two_factor_enabled = false, which the trigger does not guard, so the
// existing browser flow keeps working untouched.
//
// No imports on purpose — same as verify-2fa, which keeps it runnable
// under a plain Node test harness.
// ============================================================

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

  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binCode % 1000000).toString().padStart(6, "0");
}

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

/** SHA-256 hex of a normalised recovery code — same as public.hash_recovery_code(). */
async function hashRecoveryCode(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(String(code).trim().toUpperCase());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 2FA state for the caller. Since migration 049 the secret and the recovery
 * code hashes live in user_mfa_secrets (service role only) and the profiles
 * columns are always NULL. Before that migration the table does not exist, so
 * we fall back to the old columns — which is what lets this function ship first.
 */
async function getProfile(userId: string) {
  const headers = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=two_factor_enabled,two_factor_secret,recovery_codes`,
    { headers }
  );
  if (!res.ok) throw new Error("profile_lookup_failed");
  const rows = await res.json();
  const profile = rows?.[0];
  if (!profile) return null;

  const priv = await fetch(
    `${SUPABASE_URL}/rest/v1/user_mfa_secrets?user_id=eq.${userId}&select=totp_secret,recovery_code_hashes`,
    { headers }
  );
  const row = priv.ok ? (await priv.json())?.[0] : null;
  if (row?.totp_secret) {
    return {
      two_factor_enabled: profile.two_factor_enabled,
      two_factor_secret: row.totp_secret as string,
      recoveryHashes: (Array.isArray(row.recovery_code_hashes) ? row.recovery_code_hashes : []) as string[],
    };
  }
  const legacy: string[] = Array.isArray(profile.recovery_codes) ? profile.recovery_codes : [];
  return {
    two_factor_enabled: profile.two_factor_enabled,
    two_factor_secret: profile.two_factor_secret as string | null,
    recoveryHashes: await Promise.all(legacy.map(hashRecoveryCode)),
  };
}

async function getRateLimit(userId: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/twofa_rate_limits?user_id=eq.${userId}&select=*`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
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

/** Clears 2FA using the service role, which has no auth.uid() and is therefore
 *  the one caller the trigger lets through. */
async function clearTwoFactor(userId: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ two_factor_enabled: false, two_factor_secret: null, recovery_codes: null }),
  });
  return res.ok;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ disabled: false, error: "Method not allowed" }, 405);

  try {
    const userId = await getAuthenticatedUserId(req.headers.get("authorization"));
    if (!userId) return json({ disabled: false, error: "Unauthorized" }, 401);

    const { code, recoveryCode } = await req.json().catch(() => ({}));
    if (!code && !recoveryCode) {
      return json({ disabled: false, error: "Missing code" }, 400);
    }

    let profile;
    try {
      profile = await getProfile(userId);
    } catch {
      return json({ disabled: false, error: "Internal Server Error" }, 500);
    }
    if (!profile) return json({ disabled: false, error: "Unauthorized" }, 401);

    // Idempotent: nothing to prove if 2FA is already off.
    if (!profile.two_factor_enabled || !profile.two_factor_secret) {
      return json({ disabled: true, alreadyDisabled: true });
    }

    // ══════════ Rate limiting — same table and thresholds as verify-2fa ══════════
    const now = Date.now();
    const rateLimit = await getRateLimit(userId);

    if (rateLimit?.locked_until && new Date(rateLimit.locked_until).getTime() > now) {
      return json(
        {
          disabled: false,
          error: "too_many_attempts",
          retry_after_seconds: Math.ceil((new Date(rateLimit.locked_until).getTime() - now) / 1000),
        },
        429
      );
    }

    let failedAttempts = rateLimit?.failed_attempts ?? 0;
    const windowStart = rateLimit?.window_start ? new Date(rateLimit.window_start).getTime() : 0;
    const windowLive = windowStart && now - windowStart <= WINDOW_MINUTES * 60 * 1000;
    if (!windowLive) failedAttempts = 0;

    // ══════════ Proof of possession ══════════
    let verified = false;
    let usedRecoveryCode: string | null = null;

    if (code) {
      const secretBytes = base32Decode(profile.two_factor_secret);
      const counter = Math.floor(now / 1000 / 30);
      for (let w = -1; w <= 1; w++) {
        if ((await generateTOTP(secretBytes, counter + w)) === code) {
          verified = true;
          break;
        }
      }
    } else if (recoveryCode) {
      const supplied = await hashRecoveryCode(String(recoveryCode));
      for (const candidate of profile.recoveryHashes) {
        if (constantTimeEquals(candidate, supplied)) {
          verified = true;
          usedRecoveryCode = candidate;
          break;
        }
      }
    }

    if (!verified) {
      failedAttempts += 1;
      const patch: Record<string, unknown> = {
        failed_attempts: failedAttempts,
        window_start: new Date(windowLive ? windowStart : now).toISOString(),
      };
      if (failedAttempts >= MAX_ATTEMPTS) {
        patch.locked_until = new Date(now + LOCK_MINUTES * 60 * 1000).toISOString();
      }
      await upsertRateLimit(userId, patch);
      return json({ disabled: false, error: "invalid_code" }, 401);
    }

    if (!(await clearTwoFactor(userId))) {
      return json({ disabled: false, error: "Internal Server Error" }, 500);
    }

    await upsertRateLimit(userId, {
      failed_attempts: 0,
      window_start: new Date().toISOString(),
      locked_until: null,
    });

    return json({ disabled: true, usedRecoveryCode: usedRecoveryCode ? true : undefined });
  } catch (err) {
    console.error("disable-2fa error:", err);
    return json({ disabled: false, error: "Internal Server Error" }, 500);
  }
});
