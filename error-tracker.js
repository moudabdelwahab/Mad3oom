/**
 * Centralized Error Logging System - Frontend Tracker
 * Project: mad3oom.online
 * Author: Senior Full-Stack Engineer (Manus)
 */

(function() {
    // Updated to match supabase-config.js
    const EXPECTED_PROJECT_REF = 'srnelrdpqkcntbgudyto';
    const SUPABASE_URL = "https://srnelrdpqkcntbgudyto.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_0pvB8_xD0txjdJBkYqXMyg__jKMw71W";

    const CONFIG = {
        PROJECT_ID: EXPECTED_PROJECT_REF,
        API_URL: `${SUPABASE_URL}/rest/v1/site_errors`,
        API_KEY: SUPABASE_ANON_KEY,
        DEBOUNCE_MS: 300,
        MAX_ERRORS_PER_SESSION: 200,
        IGNORE_PATTERNS: [
            /extensions\//i,
            /chrome-extension:/i,
            /moz-extension:/i,
            /safari-extension:/i,
            /top\.GLOBALS/i,
            /originalPrompt/i,
            /site_errors/i // Prevent logging errors from the error tracker itself
        ]
    };

    let errorCount = 0;
    let lastErrorTime = 0;

    /**
     * Send error to Supabase
     */
    async function reportError(errorData) {
        const now = Date.now();
        if (now - lastErrorTime < CONFIG.DEBOUNCE_MS) return;
        if (errorCount >= CONFIG.MAX_ERRORS_PER_SESSION) return;

        const searchString = `${errorData.message} ${errorData.file_name || ''} ${errorData.stack_trace || ''}`;
        if (CONFIG.IGNORE_PATTERNS.some(pattern => pattern.test(searchString))) return;

        errorCount++;
        lastErrorTime = now;

        try {
            let userId = null;
            try {
                const supabaseAuth = localStorage.getItem(`sb-${CONFIG.PROJECT_ID}-auth-token`);
                if (supabaseAuth) {
                    const authData = JSON.parse(supabaseAuth);
                    userId = authData.user?.id;
                }
            } catch (e) {}

            const payload = {
                ...errorData,
                user_id: userId,
                user_agent: navigator.userAgent,
                page_url: window.location.href,
                created_at: new Date().toISOString(),
                status: 'new'
            };

            await fetch(CONFIG.API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: CONFIG.API_KEY,
                    Authorization: `Bearer ${CONFIG.API_KEY}`,
                    Prefer: 'return=minimal'
                },
                body: JSON.stringify(payload),
                keepalive: true
            });
        } catch (err) {
            // Silent fail in production to avoid infinite loops
            if (window.location.hostname === 'localhost') {
                console.warn('[Error Tracker] Failed to report:', err);
            }
        }
    }

    // 1. Capture Global JS Errors
    window.addEventListener('error', function(event) {
        if (event.error) {
            reportError({
                type: 'js',
                message: event.message,
                file_name: event.filename,
                line_number: event.lineno,
                column_number: event.colno,
                stack_trace: event.error.stack
            });
        } else {
            const target = event.target || event.srcElement;
            if (target instanceof HTMLElement && (target.src || target.href)) {
                const url = target.src || target.href;
                reportError({
                    type: 'network',
                    message: `Failed to load resource: ${target.tagName} (${url})`,
                    file_name: url,
                    stack_trace: `Element: ${target.outerHTML.substring(0, 200)}`
                });
            }
        }
    }, true);

    // 2. Capture Unhandled Promise Rejections
    window.addEventListener('unhandledrejection', function(event) {
        const reason = event.reason;
        reportError({
            type: 'promise',
            message: reason instanceof Error ? reason.message : String(reason),
            stack_trace: reason instanceof Error ? reason.stack : new Error().stack,
            file_name: window.location.pathname
        });
    });

    // 3. Capture Console Errors
    const originalConsoleError = console.error;
    console.error = function(...args) {
        originalConsoleError.apply(console, args);
        
        const message = args.map(arg => {
            if (arg instanceof Error) return arg.message;
            if (typeof arg === 'object') return JSON.stringify(arg);
            return String(arg);
        }).join(' ');

        const stack = args.find(arg => arg instanceof Error)?.stack || new Error().stack;

        reportError({
            type: 'js',
            message: `[Console Error] ${message}`,
            stack_trace: stack,
            file_name: window.location.pathname
        });
    };

    // 4. Capture Fetch Errors
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        try {
            const response = await originalFetch.apply(this, args);
            const url = typeof args[0] === 'string' ? args[0] : args[0].url;
            
            // Log non-ok responses except for the error tracker itself
            if (!response.ok && !url.includes('site_errors')) {
                reportError({
                    type: 'network',
                    message: `HTTP Error ${response.status}: ${response.statusText}`,
                    file_name: url,
                    stack_trace: `Method: ${args[1]?.method || 'GET'}`
                });
            }
            return response;
        } catch (err) {
            const url = typeof args[0] === 'string' ? args[0] : args[0].url;
            if (!url.includes('site_errors')) {
                reportError({
                    type: 'network',
                    message: `Fetch failed: ${err.message}`,
                    file_name: url,
                    stack_trace: err.stack
                });
            }
            throw err;
        }
    };

    if (window.location.hostname === 'localhost') {
        console.log('🚀 Error Tracker v2 initialized');
    }
})();
