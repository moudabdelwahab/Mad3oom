/**
 * =====================================================
 * FlowAnalyticsPage.js
 * صفحة تحليلات التدفقات - Enterprise Dashboard
 * =====================================================
 */

import { SupabaseIntegration } from '../supabase-integration.js';
import { flowAnalytics } from '../services/flow-analytics.js';

export class FlowAnalyticsPage {
    constructor(container) {
        this.container = container;
        this.currentFlowId = 'default';
        this.dateRange = '7d'; // 7 days default
    }

    async load() {
        this.render();
        await this.loadAnalytics();
    }

    render() {
        this.container.innerHTML = `
            <div class="analytics-page">
                <!-- Header -->
                <div class="page-header" style="margin-bottom: 24px;">
                    <div>
                        <h2 style="margin: 0; font-size: 24px; font-weight: 800;">تحليلات التدفقات</h2>
                        <p style="margin: 8px 0 0; color: var(--text-secondary);">مراقبة أداء الرد الآلي في الوقت الفعلي</p>
                    </div>
                    <div style="display: flex; gap: 12px;">
                        <select id="date-range-select" class="form-input" style="width: auto;">
                            <option value="1d">آخر 24 ساعة</option>
                            <option value="7d" selected>آخر 7 أيام</option>
                            <option value="30d">آخر 30 يوم</option>
                            <option value="90d">آخر 3 أشهر</option>
                        </select>
                        <button class="btn btn-secondary" onclick="window.flowAnalyticsPage.refresh()">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <polyline points="1 20 1 14 7 14"></polyline>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                            </svg>
                            تحديث
                        </button>
                    </div>
                </div>

                <!-- Stats Cards -->
                <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 32px;">
                    <div class="stat-card">
                        <div class="stat-icon blue">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                            </svg>
                        </div>
                        <div class="stat-info">
                            <div class="stat-value" id="total-executions">0</div>
                            <div class="stat-label">إجمالي التنفيذات</div>
                        </div>
                    </div>

                    <div class="stat-card">
                        <div class="stat-icon green">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                        </div>
                        <div class="stat-info">
                            <div class="stat-value" id="completion-rate">0%</div>
                            <div class="stat-label">معدل الإكمال</div>
                        </div>
                    </div>

                    <div class="stat-card">
                        <div class="stat-icon orange">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                            </svg>
                        </div>
                        <div class="stat-info">
                            <div class="stat-value" id="avg-duration">0s</div>
                            <div class="stat-label">متوسط المدة</div>
                        </div>
                    </div>

                    <div class="stat-card">
                        <div class="stat-icon red">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="8" x2="12" y2="12"></line>
                                <line x1="12" y1="16" x2="12.01" y2="16"></line>
                            </svg>
                        </div>
                        <div class="stat-info">
                            <div class="stat-value" id="error-rate">0%</div>
                            <div class="stat-label">معدل الأخطاء</div>
                        </div>
                    </div>
                </div>

                <!-- Charts and Details -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px;">
                    <!-- Node Performance -->
                    <div class="section-card">
                        <div class="section-card-header">
                            <div class="section-card-title">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
                                </svg>
                                أداء العقد
                            </div>
                        </div>
                        <div class="section-card-body" id="node-performance-chart">
                            <div style="text-align: center; padding: 40px; color: var(--text-muted);">
                                جاري تحميل البيانات...
                            </div>
                        </div>
                    </div>

                    <!-- Top Exit Points -->
                    <div class="section-card">
                        <div class="section-card-header">
                            <div class="section-card-title">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                                    <polyline points="16 17 21 12 16 7"></polyline>
                                    <line x1="21" y1="12" x2="9" y2="12"></line>
                                </svg>
                                نقاط الخروج الأكثر شيوعاً
                            </div>
                        </div>
                        <div class="section-card-body" id="exit-points">
                            <div style="text-align: center; padding: 40px; color: var(--text-muted);">
                                جاري تحميل البيانات...
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Recent User Journeys -->
                <div class="section-card">
                    <div class="section-card-header">
                        <div class="section-card-title">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                <circle cx="9" cy="7" r="4"></circle>
                                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                            </svg>
                            رحلات المستخدمين الأخيرة
                        </div>
                    </div>
                    <div class="section-card-body" id="user-journeys" style="padding: 0;">
                        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
                            جاري تحميل البيانات...
                        </div>
                    </div>
                </div>

                <!-- Events Timeline -->
                <div class="section-card" style="margin-top: 24px;">
                    <div class="section-card-header">
                        <div class="section-card-title">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                            </svg>
                            سجل الأحداث
                        </div>
                        <button class="btn btn-ghost btn-sm" onclick="window.flowAnalyticsPage.toggleEventsFilter()">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                            </svg>
                            تصفية
                        </button>
                    </div>
                    <div class="section-card-body" id="events-timeline" style="padding: 0; max-height: 500px; overflow-y: auto;">
                        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
                            جاري تحميل البيانات...
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Event listeners
        document.getElementById('date-range-select').addEventListener('change', (e) => {
            this.dateRange = e.target.value;
            this.loadAnalytics();
        });
    }

    async loadAnalytics() {
        const userId = await SupabaseIntegration.getCurrentUserId();
        const { startDate, endDate } = this.getDateRange();

        const stats = await flowAnalytics.getFlowStats(userId, this.currentFlowId, startDate, endDate);
        
        if (stats) {
            this.updateStats(stats);
            this.renderNodePerformance(stats.nodeStats);
        }

        const journeys = await flowAnalytics.getUserJourneys(userId, this.currentFlowId, 10);
        this.renderUserJourneys(journeys);

        await this.loadEventsTimeline(userId, startDate, endDate);
    }

    updateStats(stats) {
        document.getElementById('total-executions').textContent = stats.totalExecutions.toLocaleString();
        
        const completionRate = stats.totalExecutions > 0 
            ? ((stats.totalExecutions - stats.errorCount) / stats.totalExecutions * 100).toFixed(1)
            : 0;
        document.getElementById('completion-rate').textContent = completionRate + '%';
        
        document.getElementById('avg-duration').textContent = (stats.avgDuration / 1000).toFixed(1) + 's';
        document.getElementById('error-rate').textContent = stats.errorRate.toFixed(1) + '%';
    }

    renderNodePerformance(nodeStats) {
        const container = document.getElementById('node-performance-chart');
        
        if (!nodeStats || Object.keys(nodeStats).length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);">لا توجد بيانات</div>';
            return;
        }

        const sorted = Object.entries(nodeStats)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);

        const maxCount = sorted[0]?.[1].count || 1;

        container.innerHTML = `
            <div style="padding: 0;">
                ${sorted.map(([nodeId, data]) => `
                    <div style="margin-bottom: 16px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
                            <span style="font-weight: 600; color: var(--text-primary);">${nodeId}</span>
                            <span style="color: var(--text-secondary);">${data.count} زيارة</span>
                        </div>
                        <div style="background: var(--bg-elevated); height: 8px; border-radius: 4px; overflow: hidden;">
                            <div style="height: 100%; background: linear-gradient(90deg, var(--brand-primary), var(--brand-accent)); width: ${(data.count / maxCount * 100)}%; transition: width 0.3s;"></div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    renderUserJourneys(journeys) {
        const container = document.getElementById('user-journeys');
        
        if (!journeys || journeys.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);">لا توجد رحلات مسجلة</div>';
            return;
        }

        container.innerHTML = `
            <div style="padding: 0;">
                ${journeys.map((journey, idx) => `
                    <div style="padding: 16px; border-bottom: 1px solid var(--border-subtle); ${idx % 2 === 0 ? 'background: var(--bg-surface);' : ''}">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                            <div style="font-weight: 600; color: var(--text-primary);">${journey.phoneNumber}</div>
                            <div style="font-size: 12px; color: var(--text-muted);">${journey.events.length} خطوة</div>
                        </div>
                        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                            ${journey.path.slice(0, 5).map((nodeId, i) => `
                                <div style="padding: 4px 10px; background: var(--bg-elevated); border-radius: 6px; font-size: 11px; color: var(--text-secondary); border: 1px solid var(--border-subtle);">
                                    ${i + 1}. ${nodeId}
                                </div>
                            `).join('')}
                            ${journey.path.length > 5 ? `<span style="color: var(--text-muted); font-size: 11px;">+${journey.path.length - 5} المزيد</span>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    async loadEventsTimeline(userId, startDate, endDate) {
        const container = document.getElementById('events-timeline');
        
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { data, error } = await supabase
                .from('flow_analytics_events')
                .select('*')
                .eq('user_id', userId)
                .gte('timestamp', startDate)
                .lte('timestamp', endDate)
                .order('timestamp', { ascending: false })
                .limit(50);
            
            if (error) throw error;
            
            if (!data || data.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);">لا توجد أحداث</div>';
                return;
            }

            container.innerHTML = `
                <div style="padding: 0;">
                    ${data.map((event, idx) => {
                        const icon = this.getEventIcon(event.event_type);
                        const color = this.getEventColor(event.event_type);
                        return `
                            <div style="padding: 12px 20px; border-bottom: 1px solid var(--border-subtle); display: flex; gap: 12px; align-items: flex-start;">
                                <div style="width: 8px; height: 8px; border-radius: 50%; background: ${color}; margin-top: 6px; flex-shrink: 0;"></div>
                                <div style="flex: 1;">
                                    <div style="font-size: 13px; color: var(--text-primary); margin-bottom: 4px;">
                                        ${icon} <strong>${this.getEventTitle(event.event_type)}</strong>
                                        ${event.node_id ? `• ${event.node_id}` : ''}
                                    </div>
                                    <div style="font-size: 11px; color: var(--text-muted);">
                                        ${event.phone_number} • ${new Date(event.timestamp).toLocaleString('ar')}
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        } catch (error) {
            console.error('[FlowAnalyticsPage] Load events failed:', error);
            container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--status-error);">فشل تحميل الأحداث</div>';
        }
    }

    getEventIcon(type) {
        const icons = {
            'node_entry': '▶️',
            'node_exit': '✓',
            'flow_completed': '🎉',
            'flow_error': '❌',
            'button_click': '🔘',
            'condition_result': '⚖️'
        };
        return icons[type] || '•';
    }

    getEventColor(type) {
        const colors = {
            'node_entry': 'var(--status-info)',
            'node_exit': 'var(--status-success)',
            'flow_completed': 'var(--brand-primary)',
            'flow_error': 'var(--status-error)',
            'button_click': 'var(--status-warning)',
            'condition_result': '#9c27b0'
        };
        return colors[type] || 'var(--text-muted)';
    }

    getEventTitle(type) {
        const titles = {
            'node_entry': 'دخول عقدة',
            'node_exit': 'خروج من عقدة',
            'flow_completed': 'إكمال التدفق',
            'flow_error': 'خطأ في التدفق',
            'button_click': 'نقر على زر',
            'condition_result': 'نتيجة شرط'
        };
        return titles[type] || type;
    }

    getDateRange() {
        const endDate = new Date();
        const startDate = new Date();
        
        switch (this.dateRange) {
            case '1d':
                startDate.setDate(startDate.getDate() - 1);
                break;
            case '7d':
                startDate.setDate(startDate.getDate() - 7);
                break;
            case '30d':
                startDate.setDate(startDate.getDate() - 30);
                break;
            case '90d':
                startDate.setDate(startDate.getDate() - 90);
                break;
        }
        
        return {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString()
        };
    }

    async refresh() {
        await this.loadAnalytics();
    }

    toggleEventsFilter() {
        alert('ميزة التصفية قيد التطوير');
    }
}

// Global export
window.FlowAnalyticsPage = FlowAnalyticsPage;
