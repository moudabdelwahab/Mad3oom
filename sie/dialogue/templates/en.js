/**
 * templates/en.js
 * ------------------------------------------------------------
 * English phrasing for every possible Decision action. Structurally
 * identical to ar.js — same actions, same options shape — just the
 * other language. Used when a session's response language (Module 1)
 * is 'en'.
 */

import { formatKnowledgeData } from './knowledge-formatters.js';

function scenarioName(decision) {
    return decision.scenarioLabel?.en || 'this issue';
}

export const en = {
    WAIT_FOR_USER: () => ({
        text: "Sure, go ahead and tell me what's going on and I'll help right away.",
        options: []
    }),

    ANSWER: (decision) => {
        const isInformational = Boolean(decision.resolution?.knowledgeSource);
        const formatted = decision.knowledgeData
            ? formatKnowledgeData(decision.knowledgeData.source, decision.knowledgeData.data, 'en')
            : null;
        const bodyText = formatted || decision.resolution.text.en;

        if (isInformational) {
            return { text: `${bodyText}\n\nAnything else you'd like to know?`, options: [] };
        }

        return {
            text: `${bodyText}\n\nDid that solve it?`,
            options: [
                { label: 'Yes, thanks', value: 'resolved' },
                { label: "I'm still having the same issue", value: 'still having the issue' }
            ]
        };
    },

    ASK_CLARIFYING_QUESTION: (decision) => {
        if (decision.targetQuestion) {
            const options = (decision.targetQuestion.options || []).map((opt) => ({
                label: opt.label.en,
                value: opt.value
            }));
            return { text: decision.targetQuestion.prompt.en, options };
        }
        return { text: 'Could you tell me a bit more about the issue you ran into?', options: [] };
    },

    ASK_FOR_SCREENSHOT: () => ({
        text: "Would you mind attaching a screenshot of the issue? It'll help us understand it faster.",
        options: [
            { label: 'Attach a screenshot', value: '__attach_image__' },
            { label: 'Skip', value: 'skip' }
        ]
    }),

    ASK_FOR_ATTACHMENT: () => ({
        text: 'Could you attach any file or receipt that shows the issue? (optional)',
        options: [
            { label: 'Attach a file', value: '__attach_image__' },
            { label: 'Skip', value: 'skip' }
        ]
    }),

    ASK_FOR_LOGS: () => ({
        text: "If you have any error logs or the full error message, send them over and we'll be able to help faster.",
        options: [
            { label: 'Attach a file', value: '__attach_image__' },
            { label: 'Skip', value: 'skip' }
        ]
    }),

    REQUEST_ACCOUNT_DETAILS: () => ({
        text: 'To look up your account, could you send the email or phone number it’s registered with?',
        options: []
    }),

    VERIFY_INFORMATION: (decision) => ({
        text: `Just to confirm: the issue you're experiencing is "${scenarioName(decision)}", is that right?`,
        options: [
            { label: 'Yes, that’s right', value: 'confirmed' },
            { label: "No, that's not it", value: 'not confirmed' }
        ]
    }),

    CREATE_TICKET: () => ({
        text: "Got it — I've opened a support ticket for you and our team will follow up soon.",
        options: []
    }),

    ESCALATE_TO_HUMAN: () => ({
        text: "I'll connect you with a member of our support team so they can help you directly.",
        options: []
    }),

    COMPLETE: () => ({
        text: "Glad that's resolved! Let me know if you need anything else.",
        options: []
    }),

    FALLBACK: () => ({
        text: "I'm not sure I understood that — pick one of these and I'll help:",
        options: [
            { label: 'I have a question', value: 'i have a question' },
            { label: 'I have a problem', value: 'i have a problem' }
        ]
    })
};
