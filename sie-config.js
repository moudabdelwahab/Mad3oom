// ==============================
// SIE (Support Intelligence Engine) — environment configuration
// ------------------------------------------------------------
// SIE is a fully independent product (see architecture rules in
// CLAUDE.md / project root docs). This file is the ONLY place that
// knows which base URL to use per environment — assets/js/sie-client.js
// never hardcodes a URL, it only calls getSieBaseUrl() from here.
//
// Same static-config convention as supabase-config.js (this project has
// no build step / bundler, so "environment variables" here means a
// small, explicit, override-able config object plus hostname-based
// detection — not process.env, which isn't available in a plain
// browser ES module served statically).
//
// Resolution order (first match wins), so ops can override per
// deployment WITHOUT touching this file or any other source file:
//   1. window.__SIE_CONFIG__.baseUrl        (set via a small inline
//      <script> tag injected by the hosting platform per environment,
//      e.g. Vercel project/environment settings)
//   2. <meta name="sie-api-base-url" content="...">  (set per deployed
//      HTML, e.g. by a deploy-time templating step)
//   3. Hostname-based automatic detection (dev/staging/production)
//   4. The hardcoded PRODUCTION fallback below, so the app never throws
//      just because SIE config wasn't explicitly provided.
// ==============================

// ------------------------------------------------------------
// لازم يكون العنوان ده بيرد فعلاً على /api/v1/*
//
// كان مضبوط على https://sie.mad3oom.com — والدومين ده بيقدّم موقع SIE
// نفسه (صفحة العرض + لوحة sie-admin) كملفات ثابتة، ومفيش عليه أي مسار
// /api. يعني كل نداء من الملف ده كان بيرجع صفحة 404، getSieReply()
// بترجّع null، والعميل بيشوف «محرك الدعم الذكي (SIE) واجه مشكلة مؤقتة
// في الرد على رسالتك». وضع SIE في المنصة عمره ما اشتغل بسبب كده — رغم
// إن نفس المحرك شغال عادي على تيليجرام.
//
// الواجهة نفسها (sie-api) منشورة كـ Supabase Edge Function، فالعنوان
// بقى بيوصّل لها مباشرة. مرجع المشروع مكتوب هنا بنفس طريقة
// supabase-config.js بالظبط، لأن المشروع مافيهوش خطوة بناء.
//
// أول ما يتظبط rewrite على sie.mad3oom.com/api/* يوصّل للدالة، رجّع
// العنوان للدومين — من غير ما تعدّل أي ملف، عن طريق
// window.__SIE_CONFIG__.baseUrl أو <meta name="sie-api-base-url">.
// الدالة بتقبل الشكلين أصلاً.
const SIE_FUNCTIONS_ORIGIN = "https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/sie-api";

const SIE_ENVIRONMENT_BASE_URLS = Object.freeze({
    development: SIE_FUNCTIONS_ORIGIN,
    staging: SIE_FUNCTIONS_ORIGIN,
    production: SIE_FUNCTIONS_ORIGIN,
});

const DEFAULT_ENVIRONMENT = "production";

function isLocalhost() {
    try {
        return (
            location.hostname === "localhost" ||
            location.hostname === "127.0.0.1" ||
            location.hostname === ""
        );
    } catch {
        return false;
    }
}

/** Detects the current environment purely from the hostname — no build-time flags needed. */
function detectEnvironmentFromHostname() {
    try {
        const host = location.hostname || "";
        if (isLocalhost()) return "development";
        if (/(^|\.)dev\./.test(host) || host.includes("dev.mad3oom")) return "development";
        if (/(^|\.)staging\./.test(host) || host.includes("staging.mad3oom")) return "staging";
        return "production";
    } catch {
        return DEFAULT_ENVIRONMENT;
    }
}

function readWindowOverride() {
    try {
        const override = window.__SIE_CONFIG__ && window.__SIE_CONFIG__.baseUrl;
        return typeof override === "string" && override.trim() !== "" ? override.trim() : null;
    } catch {
        return null;
    }
}

function readMetaTagOverride() {
    try {
        const tag = document.querySelector('meta[name="sie-api-base-url"]');
        const content = tag?.getAttribute("content");
        return typeof content === "string" && content.trim() !== "" ? content.trim() : null;
    } catch {
        return null;
    }
}

/**
 * Resolves the SIE base URL to use right now, following the resolution
 * order documented above. Never throws.
 * @returns {string}
 */
export function getSieBaseUrl() {
    return (
        readWindowOverride() ||
        readMetaTagOverride() ||
        SIE_ENVIRONMENT_BASE_URLS[detectEnvironmentFromHostname()] ||
        SIE_ENVIRONMENT_BASE_URLS[DEFAULT_ENVIRONMENT]
    );
}

/** @returns {'development'|'staging'|'production'} */
export function getSieEnvironment() {
    return detectEnvironmentFromHostname();
}

/** Debug-only logging gate — never verbose in production. */
export function isSieDebugMode() {
    return isLocalhost() || getSieEnvironment() === "development";
}

export const SIE_ENVIRONMENT_BASE_URLS_FOR_REFERENCE = SIE_ENVIRONMENT_BASE_URLS;
