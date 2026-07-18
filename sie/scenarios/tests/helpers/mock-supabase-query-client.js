/**
 * mock-supabase-query-client.js — test-only helper.
 * ------------------------------------------------------------
 * A minimal fake implementing just enough of Supabase's chainable
 * query builder (.from().select().eq().order()) for the two new
 * Supabase-backed providers (scenario-catalog.supabase.js,
 * static-knowledge.supabase.js). Configured with a fixed table of rows
 * per table name; `.eq()`/`.order()` filter/sort that in-memory data.
 * No network, no real Supabase client, ever.
 */
export function createMockSupabaseQueryClient(tables) {
    return {
        from(tableName) {
            let rows = [...(tables[tableName] || [])];
            let filters = [];
            let orderCol = null;
            let orderAscending = true;

            const builder = {
                select() {
                    return builder;
                },
                eq(col, value) {
                    filters.push([col, value]);
                    return builder;
                },
                order(col, { ascending = true } = {}) {
                    orderCol = col;
                    orderAscending = ascending;
                    return builder;
                },
                then(resolve, reject) {
                    // Makes the builder awaitable, like the real client.
                    try {
                        let result = rows.filter((row) => filters.every(([col, value]) => row[col] === value));
                        if (orderCol) {
                            result = [...result].sort((a, b) => {
                                if (a[orderCol] === b[orderCol]) return 0;
                                const cmp = a[orderCol] > b[orderCol] ? 1 : -1;
                                return orderAscending ? cmp : -cmp;
                            });
                        }
                        resolve({ data: result, error: null });
                    } catch (err) {
                        reject(err);
                    }
                }
            };
            return builder;
        }
    };
}

/** A client that always returns a Supabase-style error, for failure-path tests. */
export function createFailingMockSupabaseQueryClient(errorMessage) {
    return {
        from() {
            const builder = {
                select() {
                    return builder;
                },
                eq() {
                    return builder;
                },
                order() {
                    return builder;
                },
                then(resolve) {
                    resolve({ data: null, error: { message: errorMessage } });
                }
            };
            return builder;
        }
    };
}
