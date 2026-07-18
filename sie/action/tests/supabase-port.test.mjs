import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabasePort, PORT_METHODS } from '../supabase-port.js';

const ALL_METHODS = [
    'persistBotTurn',
    'createTicketWithMessageAndSessionUpdate',
    'insertTraceEvent',
    'createConversationReview',
    'updateConversationReview',
    'createScenarioDraft',
    'createKnowledgeDraft',
    'insertValidationRun',
    'publishScenario',
    'publishKnowledge'
];

function fullImplementation(overrides = {}) {
    const impl = {};
    for (const name of ALL_METHODS) impl[name] = async () => ({ success: true, error: null });
    return { ...impl, ...overrides };
}

test('PORT_METHODS: lists all ten methods the Action Layer depends on (2 from Module 8, 8 added during Module 9)', () => {
    assert.deepEqual([...PORT_METHODS], ALL_METHODS);
});

test('createSupabasePort: accepts and returns a complete implementation unchanged', () => {
    const impl = fullImplementation();
    const port = createSupabasePort(impl);
    assert.equal(port, impl);
});

test('createSupabasePort: throws immediately when a Module 8 method is missing', () => {
    const impl = fullImplementation();
    delete impl.persistBotTurn;
    assert.throws(() => createSupabasePort(impl), /persistBotTurn/);
});

test('createSupabasePort: throws immediately when a Module 9 method is missing', () => {
    const impl = fullImplementation();
    delete impl.publishScenario;
    assert.throws(() => createSupabasePort(impl), /publishScenario/);
});

test('createSupabasePort: reports every missing method by name, not just the first', () => {
    assert.throws(() => createSupabasePort({}), (err) => {
        for (const name of ALL_METHODS) assert.ok(err.message.includes(name), `expected error to mention ${name}`);
        return true;
    });
});

test('createSupabasePort: throws when a "method" is present but not a function', () => {
    const impl = fullImplementation({ insertTraceEvent: 'not a function' });
    assert.throws(() => createSupabasePort(impl), /insertTraceEvent/);
});

test('createSupabasePort: throws on null/undefined input rather than crashing with a confusing TypeError', () => {
    assert.throws(() => createSupabasePort(null), /missing required method/);
    assert.throws(() => createSupabasePort(undefined), /missing required method/);
});
