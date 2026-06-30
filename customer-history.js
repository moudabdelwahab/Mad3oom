import * as dataClient from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';

// طبقة الوصول للبيانات - تُستورد من إعدادات المنصة الداخلية فقط
const db = dataClient.supabase;

/*
 * منطق صفحة "سجل العميل" — يجمع كل بيانات العميل (التذاكر، الاشتراك،
 * المحادثات، النشاط، الملاحظات) في عرض واحد. طبقة البيانات هنا داخلية
 * بالكامل ولا يظهر منها أي شيء في الواجهة.
 */

let activeCustomer = null;
let customerData = {
    tickets: [],
    ticketReplies: {},
    chatSessions: [],
    chatMessages: {},
    waMessages: [],
    subscriptions: [],
    activityLogs: [],
    notes: []
};

async function init() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    updateAdminUI(user);

    setupSearch();
    setupTabs();
    setupNotes();

    document.getElementById('refreshCustomerBtn').addEventListener('click', (e) => {
        if (!activeCustomer) return;
        const btn = e.currentTarget;
        btn.classList.add('spinning');
        loadCustomer(activeCustomer.id).finally(() => {
            setTimeout(() => btn.classList.remove('spinning'), 400);
        });
    });

    // مدخل ثانٍ: فتح السجل مباشرة عبر رابط يحمل معرّف العميل
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get('customer_id') || params.get('user_id');
    if (idFromUrl) loadCustomer(idFromUrl);
}

/* ==================== البحث (مدخل أول) ==================== */

function setupSearch() {
    const input = document.getElementById('customerSearchInput');
    const resultsBox = document.getElementById('searchResults');
    let debounceTimer = null;

    const runSearch = async () => {
        const q = input.value.trim();
        if (q.length < 2) {
            resultsBox.classList.remove('active');
            resultsBox.innerHTML = '';
            return;
        }

        try {
            const { data, error } = await db
                .from('profiles')
                .select('id, full_name, email, phone')
                .or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
                .limit(10);

            if (error) throw error;
            renderSearchResults(data || []);
        } catch (err) {
            resultsBox.innerHTML = '<div class="ch-result-error">حدث خطأ أثناء البحث</div>';
            resultsBox.classList.add('active');
        }
    };

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runSearch, 320);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { clearTimeout(debounceTimer); runSearch(); }
        if (e.key === 'Escape') { resultsBox.classList.remove('active'); }
    });

    document.addEventListener('click', (e) => {
        if (!resultsBox.contains(e.target) && e.target !== input) {
            resultsBox.classList.remove('active');
        }
    });
}

function renderSearchResults(customers) {
    const box = document.getElementById('searchResults');

    if (customers.length === 0) {
        box.innerHTML = '<div class="ch-result-empty">لا توجد نتائج مطابقة</div>';
        box.classList.add('active');
        return;
    }

    box.innerHTML = customers.map(c => {
        const name = c.full_name || c.email || 'بدون اسم';
        const initial = name.charAt(0).toUpperCase();
        return `
            <div class="ch-result-row" data-id="${c.id}">
                <div class="ch-result-avatar">${escapeHtml(initial)}</div>
                <div>
                    <div class="ch-result-name">${escapeHtml(name)}</div>
                    <div class="ch-result-meta">${escapeHtml(c.email || '')}${c.phone ? ' · ' + escapeHtml(c.phone) : ''}</div>
                </div>
            </div>
        `;
    }).join('');

    box.classList.add('active');

    box.querySelectorAll('.ch-result-row').forEach(el => {
        el.addEventListener('click', () => {
            const id = el.dataset.id;
            box.classList.remove('active');
            document.getElementById('customerSearchInput').value = '';
            const url = new URL(window.location);
            url.searchParams.set('customer_id', id);
            window.history.pushState({}, '', url);
            loadCustomer(id);
        });
    });
}

/* ==================== تحميل سجل العميل الكامل ==================== */

async function loadCustomer(customerId) {
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('customerProfile').classList.remove('active');
    document.getElementById('loadingState').style.display = 'block';

    try {
        const { data: profile, error: profileErr } = await db
            .from('profiles')
            .select('*')
            .eq('id', customerId)
            .maybeSingle();

        if (profileErr) throw profileErr;

        if (!profile) {
            showState('emptyState', 'لم يتم العثور على هذا العميل', 'تأكد من صحة الرابط أو جرّب البحث يدويًا.');
            return;
        }

        activeCustomer = profile;

        const [ticketsRes, chatSessionsRes, subsRes, activityRes, notesRes, waRes] = await Promise.all([
            db.from('tickets').select('*').eq('user_id', customerId).order('created_at', { ascending: false }),
            db.from('chat_sessions').select('*').eq('user_id', customerId).order('created_at', { ascending: false }),
            db.from('whatsapp_subscriptions').select('*').eq('user_id', customerId).order('created_at', { ascending: false }),
            db.from('activity_logs').select('*').eq('user_id', customerId).order('created_at', { ascending: false }).limit(50),
            db.from('customer_notes').select('*, profiles:admin_id(full_name, email)').eq('customer_id', customerId).order('created_at', { ascending: false }),
            // ربط مرن: حاليًا عبر رقم الهاتف، وقابل للتحويل لاحقًا لمعرّف عميل مباشر
            profile.phone
                ? db.from('messages').select('*').or(`from_number.eq.${profile.phone},to_number.eq.${profile.phone}`).order('timestamp', { ascending: false }).limit(100)
                : Promise.resolve({ data: [], error: null })
        ]);

        customerData.tickets = ticketsRes.data || [];
        customerData.chatSessions = chatSessionsRes.data || [];
        customerData.subscriptions = subsRes.data || [];
        customerData.activityLogs = activityRes.data || [];
        customerData.notes = notesRes.data || [];
        customerData.waMessages = waRes.data || [];

        if (customerData.tickets.length > 0) {
            const ticketIds = customerData.tickets.map(t => t.id);
            const { data: replies } = await db.from('ticket_replies').select('*').in('ticket_id', ticketIds).order('created_at', { ascending: true });
            customerData.ticketReplies = {};
            (replies || []).forEach(r => {
                (customerData.ticketReplies[r.ticket_id] ||= []).push(r);
            });
        } else {
            customerData.ticketReplies = {};
        }

        if (customerData.chatSessions.length > 0) {
            const sessionIds = customerData.chatSessions.map(s => s.id);
            const { data: msgs } = await db.from('chat_messages').select('*').in('session_id', sessionIds).order('created_at', { ascending: false });
            customerData.chatMessages = {};
            (msgs || []).forEach(m => {
                (customerData.chatMessages[m.session_id] ||= []).push(m);
            });
        } else {
            customerData.chatMessages = {};
        }

        renderCustomer(profile);
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('customerProfile').classList.add('active');

    } catch (err) {
        showState('emptyState', 'حدث خطأ أثناء تحميل بيانات العميل', 'حاول التحديث أو جرّب لاحقًا.');
    }
}

function showState(id, title, desc) {
    document.getElementById('loadingState').style.display = 'none';
    const el = document.getElementById(id);
    el.style.display = 'block';
    el.innerHTML = `
        <div class="ch-state-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        </div>
        <div class="ch-state-title">${escapeHtml(title)}</div>
        <div class="ch-state-desc">${escapeHtml(desc)}</div>
    `;
}

/* ==================== رسم رأس الصفحة ==================== */

function renderCustomer(profile) {
    const name = profile.full_name || `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || profile.email || 'بدون اسم';
    const initial = name.charAt(0).toUpperCase();

    document.getElementById('custAvatar').textContent = initial;
    document.getElementById('custName').textContent = name;
    document.getElementById('custEmail').textContent = profile.email || '—';
    document.getElementById('custPhone').textContent = profile.phone || 'لا يوجد رقم هاتف';
    document.getElementById('custJoinDate').textContent = profile.created_at ? 'عضو منذ ' + formatDate(profile.created_at) : '—';

    const banBadge = document.getElementById('custBanBadge');
    banBadge.innerHTML = (profile.ban_status && profile.ban_status !== 'none')
        ? pillHtml('ch-pill-banned', 'محظور')
        : pillHtml('ch-pill-active', 'نشط');

    const subBadge = document.getElementById('custSubBadge');
    const latestSub = customerData.subscriptions[0];
    if (latestSub) {
        const isExpired = latestSub.end_date && new Date(latestSub.end_date) < new Date();
        if (latestSub.status === 'active' && !isExpired) {
            subBadge.innerHTML = pillHtml('ch-pill-sub-on', 'مشترك');
        } else {
            subBadge.innerHTML = pillHtml('ch-pill-sub-off', isExpired ? 'اشتراك منتهٍ' : subStatusLabel(latestSub.status));
        }
    } else {
        subBadge.innerHTML = pillHtml('ch-pill-sub-none', 'بدون اشتراك');
    }

    document.getElementById('statTicketsCount').textContent = customerData.tickets.length;
    document.getElementById('statChatsCount').textContent = customerData.chatSessions.length;
    document.getElementById('statWaCount').textContent = customerData.waMessages.length;
    document.getElementById('statPoints').textContent = profile.points || 0;
    document.getElementById('statOpenTickets').textContent = customerData.tickets.filter(t => t.status === 'open').length;

    document.getElementById('tabCountTickets').textContent = customerData.tickets.length;
    document.getElementById('tabCountChats').textContent = customerData.chatSessions.length;
    document.getElementById('tabCountWa').textContent = customerData.waMessages.length;
    document.getElementById('tabCountNotes').textContent = customerData.notes.length;

    renderTicketsTab();
    renderSubscriptionTab();
    renderChatsTab();
    renderWhatsappTab(profile);
    renderActivityTab();
    renderNotesTab();
    renderSummary(profile);
}

function pillHtml(cls, label) {
    return `<span class="ch-pill ${cls}"><span class="ch-pill-dot"></span>${escapeHtml(label)}</span>`;
}

/* ==================== تبويب التذاكر ==================== */

function renderTicketsTab() {
    const panel = document.getElementById('panel-tickets');
    const tickets = customerData.tickets;

    if (tickets.length === 0) {
        panel.innerHTML = emptyTab('لا توجد تذاكر لهذا العميل', iconTicket());
        return;
    }

    panel.innerHTML = tickets.map(t => {
        const repliesCount = (customerData.ticketReplies[t.id] || []).length;
        return `
            <div class="ch-record">
                <div class="ch-record-top">
                    <div class="ch-record-title">#${t.ticket_number || ''} ${escapeHtml(t.title || 'بدون عنوان')}</div>
                    <div class="ch-record-date">${formatDate(t.created_at)}</div>
                </div>
                <div class="ch-record-desc">${escapeHtml(t.description || '')}</div>
                <div class="ch-record-footer">
                    <span class="ch-chip ch-chip-${t.status}">${ticketStatusLabel(t.status)}</span>
                    <span class="ch-chip ch-chip-neutral">${priorityLabel(t.priority)}</span>
                    <span style="font-size:0.74rem;color:var(--color-text-secondary);">${repliesCount} رد</span>
                    <a href="/admin/tickets.html?ticket_id=${t.id}" class="ch-record-link">
                        فتح التذكرة
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                    </a>
                </div>
            </div>
        `;
    }).join('');
}

function ticketStatusLabel(s) {
    return { open: 'مفتوحة', in_progress: 'قيد المعالجة', resolved: 'تم الحل', confirmed: 'مؤكدة', rejected: 'مرفوضة' }[s] || s;
}

function priorityLabel(p) {
    return { low: 'أولوية منخفضة', medium: 'أولوية متوسطة', high: 'أولوية عالية' }[p] || p;
}

/* ==================== تبويب الاشتراك ==================== */

function renderSubscriptionTab() {
    const panel = document.getElementById('panel-subscription');
    const subs = customerData.subscriptions;

    if (subs.length === 0) {
        panel.innerHTML = emptyTab('لا يوجد اشتراك مسجل لهذا العميل', iconSub());
        return;
    }

    panel.innerHTML = subs.map(s => {
        const isExpired = s.end_date && new Date(s.end_date) < new Date();
        const statusKey = isExpired ? 'expired' : s.status;
        return `
            <div class="ch-sub-card">
                <div class="ch-sub-grid">
                    <div>
                        <div class="ch-sub-label">الحالة</div>
                        <div class="ch-sub-value"><span class="ch-chip ch-chip-${statusKey}">${subStatusLabel(statusKey)}</span></div>
                    </div>
                    <div>
                        <div class="ch-sub-label">الباقة</div>
                        <div class="ch-sub-value">${planLabel(s.plan_type)}</div>
                    </div>
                    <div>
                        <div class="ch-sub-label">تاريخ البداية</div>
                        <div class="ch-sub-value">${formatDate(s.start_date)}</div>
                    </div>
                    <div>
                        <div class="ch-sub-label">تاريخ الانتهاء</div>
                        <div class="ch-sub-value">${s.end_date ? formatDate(s.end_date) : '—'}</div>
                    </div>
                    ${s.ticket_id ? `
                    <div>
                        <div class="ch-sub-label">التذكرة المرتبطة</div>
                        <div class="ch-sub-value"><a href="/admin/tickets.html?ticket_id=${s.ticket_id}" style="color:var(--color-accent);text-decoration:none;">عرض ←</a></div>
                    </div>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function subStatusLabel(s) { return { active: 'نشط', expired: 'منتهٍ', pending: 'قيد الانتظار' }[s] || s; }
function planLabel(p) { return { monthly: 'شهري', yearly: 'سنوي' }[p] || (p || '—'); }

/* ==================== تبويب محادثات الموقع ==================== */

function renderChatsTab() {
    const panel = document.getElementById('panel-chats');
    const sessions = customerData.chatSessions;

    if (sessions.length === 0) {
        panel.innerHTML = emptyTab('لا توجد محادثات مباشرة لهذا العميل', iconChat());
        return;
    }

    panel.innerHTML = sessions.map(s => {
        const msgs = customerData.chatMessages[s.id] || [];
        const lastMsg = msgs[0];
        const preview = lastMsg ? truncate(lastMsg.message_text || '', 120) : 'لا توجد رسائل بعد';
        return `
            <div class="ch-record">
                <div class="ch-record-top">
                    <div class="ch-record-title">محادثة ${formatDate(s.created_at)}</div>
                    <div class="ch-record-date">${msgs.length} رسالة</div>
                </div>
                <div class="ch-bubble-preview">${escapeHtml(preview)}</div>
                <div class="ch-record-footer">
                    <span class="ch-chip ch-chip-${s.status}">${s.status === 'active' ? 'جارية' : 'مغلقة'}</span>
                    <a href="/chat-admin.html?session_id=${s.id}" class="ch-record-link">
                        فتح المحادثة
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                    </a>
                </div>
            </div>
        `;
    }).join('');
}

/* ==================== تبويب واتساب (ربط مرن عبر الهاتف) ==================== */

function renderWhatsappTab(profile) {
    const panel = document.getElementById('panel-whatsapp');

    if (!profile.phone) {
        panel.innerHTML = emptyTab('لا توجد محادثات واتساب مرتبطة بهذا العميل', iconWhatsapp());
        return;
    }

    const msgs = customerData.waMessages;
    if (msgs.length === 0) {
        panel.innerHTML = emptyTab('لا توجد محادثات واتساب مرتبطة بهذا العميل', iconWhatsapp());
        return;
    }

    panel.innerHTML = `
        <div style="margin-bottom:0.85rem;">
            <a href="/modules/whatsapp/index.html?phone=${encodeURIComponent(profile.phone)}" class="btn btn-sm btn-primary">فتح محادثة واتساب الكاملة</a>
        </div>
    ` + msgs.slice(0, 30).map(m => {
        const isOutbound = m.direction === 'outbound';
        return `
            <div class="ch-record" style="border-right:3px solid ${isOutbound ? 'var(--color-accent)' : 'var(--color-success)'};">
                <div class="ch-record-top">
                    <div class="ch-record-title">${isOutbound ? 'فريق الدعم ←' : '→ العميل'}</div>
                    <div class="ch-record-date">${formatDate(m.timestamp || m.created_at)}</div>
                </div>
                <div class="ch-record-desc">${escapeHtml(m.message_text || (m.attachment_type ? '[مرفق: ' + m.attachment_type + ']' : ''))}</div>
            </div>
        `;
    }).join('');
}

/* ==================== تبويب سجل النشاط ==================== */

function renderActivityTab() {
    const panel = document.getElementById('panel-activity');
    const logs = customerData.activityLogs;

    if (logs.length === 0) {
        panel.innerHTML = emptyTab('لا يوجد سجل نشاط لهذا العميل', iconActivity());
        return;
    }

    panel.innerHTML = `<div class="ch-timeline">` + logs.map(l => `
        <div class="ch-timeline-row">
            <div class="ch-timeline-time">${formatDateTime(l.created_at)}</div>
            <div class="ch-timeline-action">${escapeHtml(activityActionLabel(l.action))}</div>
        </div>
    `).join('') + `</div>`;
}

function activityActionLabel(action) {
    return {
        login: 'تسجيل دخول', logout: 'تسجيل خروج', signup: 'إنشاء حساب',
        password_change: 'تغيير كلمة المرور', ticket_created: 'فتح تذكرة جديدة',
        profile_update: 'تحديث الملف الشخصي'
    }[action] || action;
}

/* ==================== تبويب الملاحظات الداخلية ==================== */

function renderNotesTab() {
    const container = document.getElementById('notesListContainer');
    const notes = customerData.notes;

    if (notes.length === 0) {
        container.innerHTML = `<div class="ch-notes-empty">لا توجد ملاحظات داخلية بعد</div>`;
        return;
    }

    container.innerHTML = notes.map(n => {
        const adminName = n.profiles?.full_name || n.profiles?.email || 'فريق الدعم';
        return `
            <div class="ch-note" data-note-id="${n.id}">
                <div class="ch-note-meta">
                    <span><span class="ch-note-author">${escapeHtml(adminName)}</span> · ${formatDateTime(n.created_at)}</span>
                    <button class="ch-note-del" data-delete-id="${n.id}">حذف</button>
                </div>
                <div class="ch-note-text">${escapeHtml(n.note)}</div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.ch-note-del').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('هل تريد حذف هذه الملاحظة؟')) return;
            const id = btn.dataset.deleteId;
            const { error } = await db.from('customer_notes').delete().eq('id', id);
            if (!error) {
                customerData.notes = customerData.notes.filter(n => n.id !== id);
                document.getElementById('tabCountNotes').textContent = customerData.notes.length;
                renderNotesTab();
            }
        });
    });
}

function setupNotes() {
    document.getElementById('addNoteBtn').addEventListener('click', async () => {
        const textarea = document.getElementById('newNoteText');
        const note = textarea.value.trim();
        if (!note || !activeCustomer) return;

        try {
            const { data: { user } } = await db.auth.getUser();
            const { data, error } = await db
                .from('customer_notes')
                .insert({ customer_id: activeCustomer.id, admin_id: user?.id || null, note })
                .select('*, profiles:admin_id(full_name, email)')
                .single();

            if (error) throw error;

            customerData.notes.unshift(data);
            document.getElementById('tabCountNotes').textContent = customerData.notes.length;
            textarea.value = '';
            renderNotesTab();
        } catch (err) {
            alert('حدث خطأ أثناء إضافة الملاحظة');
        }
    });
}

/* ==================== ملخص ذكي (محسوب من البيانات المعروضة فقط) ==================== */

function renderSummary(profile) {
    const el = document.getElementById('aiSummaryText');
    const tickets = customerData.tickets;
    const openTickets = tickets.filter(t => t.status === 'open').length;
    const resolvedTickets = tickets.filter(t => t.status === 'resolved').length;
    const totalChats = customerData.chatSessions.length;
    const totalWa = customerData.waMessages.length;
    const sub = customerData.subscriptions[0];
    const isBanned = profile.ban_status && profile.ban_status !== 'none';

    const points = [];
    const totalInteractions = tickets.length + totalChats + totalWa;

    if (totalInteractions === 0) {
        points.push('عميل جديد لم يتفاعل بعد مع الدعم الفني أو المحادثات.');
    } else if (totalInteractions > 20) {
        points.push('عميل نشط جدًا، بتفاعل عالٍ مع المنصة عبر التذاكر والمحادثات.');
    } else {
        points.push(`تفاعل العميل حتى الآن: ${tickets.length} تذكرة، ${totalChats} محادثة موقع، ${totalWa} رسالة واتساب.`);
    }

    if (openTickets > 0) {
        points.push(`لديه حاليًا <strong>${openTickets}</strong> تذكرة مفتوحة تحتاج متابعة.`);
    } else if (tickets.length > 0) {
        points.push('لا توجد تذاكر مفتوحة حاليًا، جميع التذاكر تم التعامل معها.');
    }

    if (tickets.length > 0 && resolvedTickets / tickets.length > 0.7) {
        points.push('معدل حل التذاكر الخاص به مرتفع، تجربة دعم جيدة بشكل عام.');
    }

    if (sub) {
        const isExpired = sub.end_date && new Date(sub.end_date) < new Date();
        if (isExpired) {
            points.push('اشتراكه في خدمة الواتساب منتهٍ، فرصة جيدة للتواصل بخصوص التجديد.');
        } else if (sub.status === 'active') {
            points.push(`مشترك حاليًا في باقة ${planLabel(sub.plan_type)}.`);
        }
    } else {
        points.push('لا يوجد لديه اشتراك نشط في خدمة الواتساب.');
    }

    if (isBanned) {
        points.push(`<strong style="color:var(--color-danger)">تنبيه: هذا الحساب محظور حاليًا${profile.ban_reason ? ' بسبب: ' + escapeHtml(profile.ban_reason) : ''}.</strong>`);
    }

    if (profile.points && profile.points > 0) {
        points.push(`يمتلك ${profile.points} نقطة في برنامج المكافآت.`);
    }

    el.innerHTML = `<ul>${points.map(p => `<li>${p}</li>`).join('')}</ul>`;
}

/* ==================== التبويبات ==================== */

function setupTabs() {
    document.querySelectorAll('.ch-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ch-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.ch-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
        });
    });
}

/* ==================== أيقونات الحالة الفارغة ==================== */

function iconTicket() { return '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"></path><rect x="9" y="3" width="6" height="4" rx="2"></rect>'; }
function iconSub() { return '<path d="M17 9V7a5 5 0 0 0-10 0v2"></path><rect x="5" y="9" width="14" height="11" rx="2"></rect>'; }
function iconChat() { return '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'; }
function iconWhatsapp() { return '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'; }
function iconActivity() { return '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>'; }

function emptyTab(message, iconPath) {
    return `
        <div class="ch-tab-empty">
            <svg xmlns="http://www.w3.org/2000/svg" width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>
            <div class="ch-tab-empty-text">${escapeHtml(message)}</div>
        </div>
    `;
}

/* ==================== دوال مساعدة ==================== */

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    try { return new Date(dateStr).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return dateStr; }
}

function formatDateTime(dateStr) {
    if (!dateStr) return '—';
    try { return new Date(dateStr).toLocaleString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return dateStr; }
}

init();
