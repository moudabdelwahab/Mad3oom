import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';

let user = null;
let charts = {};

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    
    // Initialize Charts
    initCharts();
    
    // Initial fetch
    fetchAllStats();
    
    // Setup Realtime Subscriptions
    setupRealtimeSubscriptions();
}

function initCharts() {
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { position: 'bottom', labels: { font: { family: 'Cairo' } } }
        }
    };

    // 1. Users Chart (Doughnut)
    charts.users = new Chart(document.getElementById('usersChart'), {
        type: 'doughnut',
        data: {
            labels: ['نشطين', 'محظورين', 'مفعلين 2FA'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: ['#4F46E5', '#E11D48', '#16A34A']
            }]
        },
        options: chartOptions
    });

    // 2. Tickets Chart (Bar)
    charts.tickets = new Chart(document.getElementById('ticketsChart'), {
        type: 'bar',
        data: {
            labels: ['مفتوحة', 'محلولة', 'إجمالي الردود'],
            datasets: [{
                label: 'العدد',
                data: [0, 0, 0],
                backgroundColor: ['#EA580C', '#16A34A', '#9333EA']
            }]
        },
        options: {
            ...chartOptions,
            scales: { y: { beginAtZero: true } }
        }
    });

    // 3. Chats Chart (Pie)
    charts.chats = new Chart(document.getElementById('chatsChart'), {
        type: 'pie',
        data: {
            labels: ['رسائل المستخدمين', 'ردود البوت'],
            datasets: [{
                data: [0, 0],
                backgroundColor: ['#059669', '#D97706']
            }]
        },
        options: chartOptions
    });

    // 4. Activity Chart (Line)
    charts.activity = new Chart(document.getElementById('activityChart'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'النشاطات اليومية',
                data: [],
                borderColor: '#2563EB',
                tension: 0.4,
                fill: true,
                backgroundColor: 'rgba(37, 99, 235, 0.1)'
            }]
        },
        options: {
            ...chartOptions,
            scales: { y: { beginAtZero: true } }
        }
    });
}

async function fetchAllStats() {
    fetchUserStats();
    fetchTicketStats();
    fetchChatStats();
    fetchRewardStats();
    fetchActivityChartData();
}

async function fetchUserStats() {
    try {
        const { count: total } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
        const { count: banned } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).not('ban_status', 'in', '(none,active)');
        const { count: tfa } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('two_factor_enabled', true);
        const { count: devices } = await supabase.from('trusted_devices').select('*', { count: 'exact', head: true });

        updateValue('totalUsers', total);
        updateValue('bannedUsers', banned);
        updateValue('users2FA', tfa);
        updateValue('trustedDevices', devices);

        charts.users.data.datasets[0].data = [total - banned, banned, tfa];
        charts.users.update();
    } catch (e) { console.error(e); }
}

async function fetchTicketStats() {
    try {
        const { count: total } = await supabase.from('tickets').select('*', { count: 'exact', head: true });
        const { count: open } = await supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('status', 'open');
        const { count: resolved } = await supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('status', 'resolved');
        const { count: replies } = await supabase.from('ticket_replies').select('*', { count: 'exact', head: true });

        updateValue('totalTickets', total);
        updateValue('openTickets', open);
        updateValue('resolvedTickets', resolved);
        updateValue('totalReplies', replies);

        charts.tickets.data.datasets[0].data = [open, resolved, replies];
        charts.tickets.update();
    } catch (e) { console.error(e); }
}

async function fetchChatStats() {
    try {
        const { count: sessions } = await supabase.from('chat_sessions').select('*', { count: 'exact', head: true });
        const { count: messages } = await supabase.from('chat_messages').select('*', { count: 'exact', head: true });
        const { count: bot } = await supabase.from('chat_messages').select('*', { count: 'exact', head: true }).eq('is_bot_reply', true);
        const { count: api } = await supabase.from('bot_api_keys').select('*', { count: 'exact', head: true }).eq('status', 'active');

        updateValue('chatSessions', sessions);
        updateValue('chatMessages', messages);
        updateValue('botReplies', bot);
        updateValue('activeApiKeys', api);

        charts.chats.data.datasets[0].data = [messages - bot, bot];
        charts.chats.update();
    } catch (e) { console.error(e); }
}

async function fetchRewardStats() {
    try {
        const { data: wallets } = await supabase.from('user_wallets').select('total_points');
        const totalPoints = wallets?.reduce((sum, w) => sum + (w.total_points || 0), 0) || 0;
        updateValue('totalPoints', totalPoints.toLocaleString('ar-EG'));

        const { count: approved } = await supabase.from('user_reports').select('*', { count: 'exact', head: true }).eq('status', 'approved');
        updateValue('approvedReports', approved);

        const { count: pro } = await supabase.from('user_wallets').select('*', { count: 'exact', head: true }).eq('is_pro', true);
        updateValue('proMembers', pro);

        const { count: logs } = await supabase.from('activity_logs').select('*', { count: 'exact', head: true });
        updateValue('activityLogs', logs);
    } catch (e) { console.error(e); }
}

async function fetchActivityChartData() {
    try {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        const { data: logs } = await supabase
            .from('activity_logs')
            .select('created_at')
            .gte('created_at', sevenDaysAgo.toISOString());

        const countsByDay = {};
        const labels = [];
        const data = [];

        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const label = d.toLocaleDateString('ar-EG', { weekday: 'short' });
            const dateStr = d.toISOString().split('T')[0];
            countsByDay[dateStr] = 0;
            labels.push(label);
        }

        logs?.forEach(log => {
            const dateStr = log.created_at.split('T')[0];
            if (countsByDay[dateStr] !== undefined) countsByDay[dateStr]++;
        });

        Object.keys(countsByDay).sort().forEach(key => data.push(countsByDay[key]));

        charts.activity.data.labels = labels;
        charts.activity.data.datasets[0].data = data;
        charts.activity.update();
    } catch (e) { console.error(e); }
}

function updateValue(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = value;
        el.style.color = '#10b981';
        setTimeout(() => el.style.color = '', 1000);
    }
}

function setupRealtimeSubscriptions() {
    const tables = ['profiles', 'tickets', 'ticket_replies', 'chat_sessions', 'chat_messages', 'user_wallets', 'user_reports', 'activity_logs'];
    tables.forEach(table => {
        supabase.channel(`stats-${table}`).on('postgres_changes', { event: '*', schema: 'public', table }, () => {
            if (table === 'profiles') fetchUserStats();
            if (table === 'tickets' || table === 'ticket_replies') fetchTicketStats();
            if (table === 'chat_sessions' || table === 'chat_messages') fetchChatStats();
            if (table === 'user_wallets' || table === 'user_reports') fetchRewardStats();
            if (table === 'activity_logs') { fetchRewardStats(); fetchActivityChartData(); }
        }).subscribe();
    });
}

init();
