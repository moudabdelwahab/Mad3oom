// ==============================
// Supabase static project config
// ==============================

export const SUPABASE_CONFIG = {
  url: "https://kbecntklwmdtyjlwgegx.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtiZWNudGtsd21kdHlqbHdnZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4Mzk2MzYsImV4cCI6MjA5MzQxNTYzNn0.AJZSdR1HtFM7f7Xm14VgxD9k1hHXU1xAaOckibu0Tms",
};

const EXPECTED_PROJECT_REF = "kbecntklwmdtyjlwgegx";

// ==============================
// Helpers
// ==============================

function extractProjectRef(url) {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return null;
  }
}

function isLocalhost() {
  return (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );
}

// ==============================
// Validation (Fail Fast)
// ==============================

export function validateSupabaseConfig(config = SUPABASE_CONFIG) {
  if (!config?.url) {
    throw new Error("Missing SUPABASE_URL in SUPABASE_CONFIG");
  }

  if (!config?.anonKey) {
    throw new Error("Missing SUPABASE_ANON_KEY in SUPABASE_CONFIG");
  }

  const projectRef = extractProjectRef(config.url);

  if (!projectRef) {
    throw new Error(`Invalid SUPABASE_URL: ${config.url}`);
  }

  if (projectRef !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `Supabase project mismatch: expected ${EXPECTED_PROJECT_REF}, got ${projectRef}`
    );
  }

  if (isLocalhost()) {
    console.info("[Supabase] URL:", config.url);
    console.info("[Supabase] project ref:", projectRef);
  }

  return {
    url: config.url,
    anonKey: config.anonKey,
    projectRef,
  };
}

// ==============================
// Dev auth diagnostics
// ==============================

export function debugSupabaseAuthError(error) {
  if (!error || !isLocalhost()) return;

  console.info("[Supabase auth diagnostics]", {
    message: error.message || "unknown",
    code: error.code || "unknown",
    status: error.status || "unknown",
  });
}
