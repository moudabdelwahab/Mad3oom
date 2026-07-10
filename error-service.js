/**
 * Error Management Service
 * Handles fetching, resolving, and archiving site errors.
 */
import { supabase } from './api-config.js';

export const errorService = {
    /**
     * Fetch errors with filters
     */
    async fetchErrors({ type, status, pageUrl, userId, search, limit = 50, offset = 0 }) {
        let query = supabase
            .from('site_errors')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (type && type !== 'all') query = query.eq('type', type);
        if (status && status !== 'all') query = query.eq('status', status);
        if (pageUrl) query = query.ilike('page_url', `%${pageUrl}%`);
        if (userId) query = query.eq('user_id', userId);
        
        if (search) {
            query = query.or(`message.ilike.%${search}%,stack_trace.ilike.%${search}%`);
        }

        const { data, error, count } = await query;
        if (error) throw error;
        return { data, count };
    },

    /**
     * Update error status (Resolve/Archive)
     */
    async updateStatus(errorId, status) {
        const { data, error } = await supabase
            .from('site_errors')
            .update({ status })
            .eq('id', errorId)
            .select();
        
        if (error) throw error;
        return data[0];
    },

    /**
     * Get accurate error counts by status (not limited to the
     * currently loaded page of results), used to power the
     * stats dashboard cards.
     */
    async getStats() {
        const countQuery = (filters = {}) => {
            let q = supabase.from('site_errors').select('*', { count: 'exact', head: true });
            Object.entries(filters).forEach(([key, val]) => { q = q.eq(key, val); });
            return q;
        };

        const [totalRes, newRes, resolvedRes, archivedRes] = await Promise.all([
            countQuery(),
            countQuery({ status: 'new' }),
            countQuery({ status: 'resolved' }),
            countQuery({ status: 'archived' })
        ]);

        const firstError = [totalRes, newRes, resolvedRes, archivedRes].find(r => r.error);
        if (firstError) throw firstError.error;

        return {
            total: totalRes.count || 0,
            new: newRes.count || 0,
            resolved: resolvedRes.count || 0,
            archived: archivedRes.count || 0
        };
    },

    /**
     * Subscribe to real-time error updates.
     * onInsert: fired when a new error is reported.
     * onUpdate: fired instantly when an error's status changes
     *           (e.g. resolved/archived), so the UI can drop it
     *           from the "current errors" view immediately.
     */
    subscribeToErrors(onInsert, onUpdate) {
        return supabase
            .channel('site_errors_realtime')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'site_errors'
            }, payload => {
                if (onInsert) onInsert(payload.new);
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'site_errors'
            }, payload => {
                if (onUpdate) onUpdate(payload.new, payload.old);
            })
            .subscribe();
    }
};
