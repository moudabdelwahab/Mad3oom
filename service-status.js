/**
 * Service Status Management
 * Handles fetching and managing service status data from Supabase
 */
import { supabase } from './api-config.js';

export const serviceStatusManager = {
    /**
     * Fetch all services with their current status
     */
    async fetchServices() {
        try {
            const { data, error } = await supabase
                .from('services')
                .select('*')
                .order('created_at', { ascending: true });

            if (error) throw error;
            return data || [];
        } catch (err) {
            console.error('Failed to fetch services:', err);
            return [];
        }
    },

    /**
     * Fetch service status history for uptime calculation
     */
    async fetchServiceHistory(serviceId, days = 30) {
        try {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            const { data, error } = await supabase
                .from('service_status_history')
                .select('*')
                .eq('service_id', serviceId)
                .gte('created_at', startDate.toISOString())
                .order('created_at', { ascending: true });

            if (error) throw error;
            return data || [];
        } catch (err) {
            console.error('Failed to fetch service history:', err);
            return [];
        }
    },

    /**
     * Fetch all incidents
     */
    async fetchIncidents(limit = 50) {
        try {
            const { data, error } = await supabase
                .from('incidents')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) throw error;
            return data || [];
        } catch (err) {
            console.error('Failed to fetch incidents:', err);
            return [];
        }
    },

    /**
     * Create a new incident
     */
    async createIncident(title, description, affectedServices, status = 'investigating') {
        try {
            const { data, error } = await supabase
                .from('incidents')
                .insert([{
                    title,
                    description,
                    affected_services: affectedServices,
                    status,
                    created_at: new Date().toISOString()
                }])
                .select();

            if (error) throw error;
            return data[0];
        } catch (err) {
            console.error('Failed to create incident:', err);
            throw err;
        }
    },

    /**
     * Update incident status
     */
    async updateIncidentStatus(incidentId, status) {
        try {
            const { data, error } = await supabase
                .from('incidents')
                .update({ status, updated_at: new Date().toISOString() })
                .eq('id', incidentId)
                .select();

            if (error) throw error;
            return data[0];
        } catch (err) {
            console.error('Failed to update incident:', err);
            throw err;
        }
    },

    /**
     * Update service status
     */
    async updateServiceStatus(serviceId, status, responseTime = null) {
        try {
            // Update current service status
            const { data: updateData, error: updateError } = await supabase
                .from('services')
                .update({ 
                    status,
                    last_checked: new Date().toISOString(),
                    response_time: responseTime
                })
                .eq('id', serviceId)
                .select();

            if (updateError) throw updateError;

            // Record status history
            const { error: historyError } = await supabase
                .from('service_status_history')
                .insert([{
                    service_id: serviceId,
                    status,
                    response_time: responseTime,
                    created_at: new Date().toISOString()
                }]);

            if (historyError) throw historyError;

            return updateData[0];
        } catch (err) {
            console.error('Failed to update service status:', err);
            throw err;
        }
    },

    /**
     * Subscribe to real-time service status updates
     */
    subscribeToServiceUpdates(callback) {
        return supabase
            .channel('service_updates')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'services'
            }, payload => {
                callback(payload);
            })
            .subscribe();
    },

    /**
     * Subscribe to real-time incident updates
     */
    subscribeToIncidents(callback) {
        return supabase
            .channel('incident_updates')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'incidents'
            }, payload => {
                callback(payload);
            })
            .subscribe();
    },

    /**
     * Calculate uptime percentage for a service
     */
    calculateUptime(history) {
        if (!history || history.length === 0) return 100;

        const operationalTime = history.filter(h => h.status === 'operational').length;
        return ((operationalTime / history.length) * 100).toFixed(2);
    },

    /**
     * Get service summary statistics
     */
    getSummary(services) {
        return {
            operational: services.filter(s => s.status === 'operational').length,
            degraded: services.filter(s => s.status === 'degraded').length,
            down: services.filter(s => s.status === 'down').length,
            total: services.length
        };
    }
};
