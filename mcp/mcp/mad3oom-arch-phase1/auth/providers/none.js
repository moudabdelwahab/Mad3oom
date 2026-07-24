import { registerAuthProvider } from '../registry.js';

/** @type {import('../types.js').AuthProvider} */
const NoneAuthProvider = {
    authType: 'none',
    async connect() { return { connected: true }; },
    async resolve() {
        return { applyToRequest: () => ({ headers: {} }), isExpired: () => false };
    },
};

registerAuthProvider(NoneAuthProvider);
export { NoneAuthProvider };
