/**
 * Centralized Error Logging System - Frontend Tracker
 * Project: mad3oom.online
 * Author: Senior Full-Stack Engineer (Manus)
 */

(function() {
    // Verified Project Config from Supabase MCP
    const PROJECT_REF = 'srnelrdpqkcntbgudyto';
    const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
    const SUPABASE_ANON_KEY = "sb_publishable_0pvB8_xD0txjdJBkYqXMyg__jKMw71W";

    const CONFIG = {
        PROJECT_ID: PROJECT_REF,
        API_URL: `${SUPABASE_URL}/rest/v1/site_errors`,
        API_KEY: SUPABASE_ANON_KEY,
        DEBOUNCE_MS: 500,
        MAX_ERRORS_PER_SESSION: 100,
        IGNORE_PATTERNS: [
            /extensions\//i,
            /chrome-extension:/i,
            /moz-extension:/i,
            /safari-extension:/i,
            /top\.GLOBALS/i,
            /originalPrompt/i,
            /site_errors/i,
            /supabase\.co/i // Prevent logging errors from Supabase calls themselves
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
                // Try to get user ID from Supabase auth in localStorage
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key.includes('auth-token')) {
                        const authData = JSON.parse(localStorage.getItem(key));
                        userId = authData.user?.id;
                        break;
                    }
                }
            } catch (e) {}

            const payload = {
                type: errorData.type || 'js',
                message: errorData.message || 'Unknown Error',
                file_name: errorData.file_name || window.location.pathname,
                line_number: errorData.line_number || null,
                column_number: errorData.column_number || null,
                stack_trace: errorData.stack_trace || null,
                user_id: userId,
                user_agent: navigator.userAgent,
                page_url: window.location.href,
                created_at: new Date().toISOString(),
                status: 'new'
            };

            const response = await fetch(CONFIG.API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': CONFIG.API_KEY,
                    'Authorization': `Bearer ${CONFIG.API_KEY}`,
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify(payload),
                keepalive: true
            });

            if (!response.ok && window.location.hostname === 'localhost') {
                console.warn('[Error Tracker] Failed to report:', response.status, response.statusText);
            }
        } catch (err) {
            // Silent fail to avoid infinite loops
        }
    }

    // 1. Global JS Errors
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
                reportError({
                    type: 'network',
                    message: `Failed to load resource: ${target.tagName} (${target.src || target.href})`,
                    file_name: target.src || target.href
                });
            }
        }
    }, true);

    // 2. Unhandled Promises
    window.addEventListener('unhandledrejection', function(event) {
        const reason = event.reason;
        reportError({
            type: 'promise',
            message: reason instanceof Error ? reason.message : String(reason),
            stack_trace: reason instanceof Error ? reason.stack : new Error().stack
        });
    });

    // 3. Console Errors
    const originalConsoleError = console.error;
    console.error = function(...args) {
        originalConsoleError.apply(console, args);
        
        const message = args.map(arg => {
            if (arg instanceof Error) return arg.message;
            if (typeof arg === 'object') {
                try { return JSON.stringify(arg); } catch(e) { return String(arg); }
            }
            return String(arg);
        }).join(' ');

        // Don't log if it's related to the tracker itself or Supabase
        if (message.includes('site_errors') || message.includes('supabase.co')) return;

        const stack = args.find(arg => arg instanceof Error)?.stack || new Error().stack;

        reportError({
            type: 'js',
            message: `[Console] ${message}`,
            stack_trace: stack
        });
    };

    // 4. Fetch/XHR Errors
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        try {
            const response = await originalFetch.apply(this, args);
            const url = typeof args[0] === 'string' ? args[0] : args[0].url;
            
            if (!response.ok && !url.includes('site_errors') && !url.includes('supabase.co')) {
                reportError({
                    type: 'network',
                    message: `HTTP ${response.status}: ${response.statusText}`,
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
        console.log('🚀 Error Tracker v2.1 Active');
    }
})();
