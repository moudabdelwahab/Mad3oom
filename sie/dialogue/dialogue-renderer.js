/**
 * dialogue-renderer.js
 * ------------------------------------------------------------
 * The Dialogue Engine, in full: renders one Decision (Module 5) into
 * customer-facing { text, options }, using the template set for the
 * given language (Module 1's response-language policy). This file
 * contains zero decision-making — it only selects which pre-written
 * template function to call and calls it. If a Decision's action or
 * language is somehow unrecognized, it degrades to a safe generic
 * message rather than throwing, since this sits directly in the
 * customer-facing path.
 */
import { ar } from './templates/ar.js';
import { en } from './templates/en.js';
import { ACTIONS } from '../decision/decision-types.js';

const TEMPLATE_SETS = { ar, en };

const SAFE_FALLBACK = {
    ar: { text: 'حصل خطأ بسيط، جرب تاني كمان شوية [[icon:note]]', options: [] },
    en: { text: 'Something went slightly wrong — please try again in a moment.', options: [] }
};

/**
 * @param {import('../decision/decision-types.js').Decision} decision
 * @param {'ar'|'en'} [language='ar']
 * @returns {{ text: string, options: Array<{label: string, value: string}> }}
 */
export function renderDecision(decision, language = 'ar') {
    const lang = language === 'en' ? 'en' : 'ar';
    const templates = TEMPLATE_SETS[lang];

    if (!decision || !ACTIONS[decision.action] || typeof templates[decision.action] !== 'function') {
        return SAFE_FALLBACK[lang];
    }

    try {
        const rendered = templates[decision.action](decision);
        if (!rendered || typeof rendered.text !== 'string') return SAFE_FALLBACK[lang];
        return { text: rendered.text, options: Array.isArray(rendered.options) ? rendered.options : [] };
    } catch (err) {
        // A template referencing a field the Decision didn't actually
        // carry (e.g. a malformed upstream Decision) should degrade
        // gracefully here, not break the customer-facing turn.
        // eslint-disable-next-line no-console
        console.warn('[dialogue-renderer] failed to render decision, falling back:', err?.message);
        return SAFE_FALLBACK[lang];
    }
}
