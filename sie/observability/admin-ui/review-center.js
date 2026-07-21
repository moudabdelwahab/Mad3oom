import { checkAdminAuth, updateAdminUI } from '/assets/js/admin/auth.js';
import { initSidebar } from '/assets/js/admin/sidebar.js';
import { supabase } from '/api-config.js';
import { isCurrentUserSieAdmin, getSieAccessStatus, adminSetAccess, adminResetUsage } from '/sie-integration/sie-entitlement.js';

initSidebar();

const appRoot = document.getElementById('app-root');
const user = await checkAdminAuth();

if (user) {
    updateAdminUI(user);

    if (user.profile?.role === 'admin') {
        appRoot.innerHTML = '';
        appRoot.appendChild(document.getElementById('page-template').content.cloneNode(true));
        initTabGroup(document.getElementById('sectionTabs'));
        initTabGroup(document.getElementById('vlTabs'));
        initReviewCenter(user);
        initValidationLab();
        initCustomerAccess(user);
        initAiFallbackCenter(user);
    } else {
        appRoot.innerHTML = '';
        appRoot.appendChild(document.getElementById('not-authorized-template').content.cloneNode(true));
    }
}

// تبديل تبويبات عام (مُستخدَم لكل من تبويب "قائمة التعلّم / معمل التحقق"
// الرئيسي، وتبويبات معمل التحقق الفرعية "محاكاة / تشغيل الظل / بوابة
// النشر") — بيدوّر بس على الأزرار والألواح اللي عليها نفس data-group.
function initTabGroup(tabsEl) {
    if (!tabsEl) return;
    const group = tabsEl.dataset.group;
    const buttons = tabsEl.querySelectorAll(':scope > .tab-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll(`.tab-panel[data-group="${group}"]`).forEach(p => {
                p.classList.toggle('active', p.id === btn.dataset.target);
            });
        });
    });
}

// ------------------------------------------------------------------
// متصل ببيانات حقيقية فعلاً — والشكل هنا اتأكّد منه مباشرة على القاعدة
// الحية عبر Supabase (مش من ملف migration 0001 المرفق في الريبو، اللي
// بقى قديم — حد غيّر السكيمـا فعليًا على القاعدة بعد كتابته):
//
//   - chat_engine_learning_queue (VIEW): trace_event_id, session_id,
//     turn, action, scenario_id, confidence, explanation, created_at.
//     مفيش عمود trace (jsonb) واحد ولا reason ولا review_id/review_status
//     زي ما كان متوقّع قديمًا — "السبب" بيتحسب هنا في الواجهة (نفس شرط
//     WHERE بتاع الـ view نفسه)، والمراجعة بتتجاب باستعلام منفصل على
//     chat_engine_conversation_reviews بالـ session_id.
//
//   - chat_engine_trace_events (الجدول نفسه، مش الـ view): أعمدة منفصلة
//     بدل عمود trace واحد: normalized_tokens, hypotheses, ranking,
//     decision, knowledge_data, rendered, action_result,
//     response_language, processing_time_ms. بنجيبها بالـ id لما صف
//     يتفتح. العرض هنا دفاعي عن قصد: بيدوّر على المفاتيح المتوقعة ولو
//     مالقاش بيعرض الـ JSON خام بدل ما يفترض شكل ثابت.
//
//     ملحوظة مهمة: لحد وقت قريب كان الجدول ده بيفضل 0 صف حتى مع استخدام
//     حقيقي من عملاء مؤهّلين لـ SIE، لأن sie/action/supabase-port.supabase.js
//     كانت لسه بتكتب على عمود trace القديم اللي مبقاش موجود — كل INSERT
//     كان بيفشل بصمت. اتصلح دلوقتي (insertTraceEvent بقى بيكتب على
//     الأعمدة الحقيقية)، فالقائمة المفروض تتغذّى فعليًا من محرك SIE
//     الحي من هنا وطالع. "نبض المحرك" تحت بيوريك العدد الحقيقي بدل ما
//     تفترض إن "الاتصال شغّال" يعني "فيه بيانات حقيقية".
//
//   - chat_engine_conversation_reviews: مراجعة واحدة لكل *جلسة* مش لكل
//     دور (session_id عليه UNIQUE constraint، ومفيش عمود
//     triggered_by_turn أصلًا). الأعمدة الحقيقية: id, session_id,
//     status, corrected_scenario_id, reviewed_by, reviewed_at, notes,
//     created_at. status مقيّد بـ CHECK على 3 قيم بس:
//     unresolved | reviewed | corrected (مش open/in_review/resolved/
//     dismissed زي ما كان في التصميم الأصلي).
// ------------------------------------------------------------------
async function initReviewCenter(currentUser) {
    const PAGE_SIZE = 200;
    const FALLBACK_SCENARIO_OPTIONS = [
        'login_token_expired', 'api_integration_issue', 'webhook_delivery_failure',
        'subscription_payment_not_reflected', 'pricing_inquiry', 'platform_info_inquiry',
        'ticket_status_inquiry', 'subscription_status_inquiry', 'unknown'
    ];
    const STATUS_OPTIONS = [
        { value: 'unresolved', label: 'غير محلولة' },
        { value: 'reviewed', label: 'تمت المراجعة' },
        { value: 'corrected', label: 'تم التصحيح' }
    ];

    let QUEUE = [];
    let SCENARIO_OPTIONS = FALLBACK_SCENARIO_OPTIONS;
    let selected = null;
    let pendingStatus = {};
    let hasMore = false;
    let totalTraceEventsEver = null; // null = لسه معرفناش، 0 = عرفنا إنها فاضية فعلاً
    const filters = { reason: 'all', status: 'all', session: '' };

    const dataModeFlag = document.getElementById('dataModeFlag');
    const lastSyncLabel = document.getElementById('lastSyncLabel');

    function setFlag(mode, text) {
        // حالة النجاح (live) مالهاش لازمة تتعلن كـ "شارة نجاح" دايمة —
        // ده بالظبط النص اللي طلب صاحب المنصة نشيله لأنه بيوهم إن وصول
        // الاستعلام يعني وجود بيانات حقيقية ذات معنى. بدل كده، بنكتفي
        // بتحديث "آخر تحديث" بصمت، ونسيب الشارة الظاهرة بس لحالة التحميل
        // أو الخطأ الفعلي.
        if (mode === 'live') {
            dataModeFlag.style.display = 'none';
            dataModeFlag.textContent = '';
            lastSyncLabel.textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
            return;
        }
        dataModeFlag.style.display = 'inline-flex';
        dataModeFlag.className = 'demo-flag' + (mode ? ' ' + mode : '');
        dataModeFlag.textContent = text;
    }

    function reasonLabel(r) { return { fallback: 'رد احتياطي', escalated_unknown: 'تصعيد (غير معروف)', low_confidence: 'ثقة منخفضة' }[r] || r || '—'; }
    function statusLabel(s) { return (STATUS_OPTIONS.find(o => o.value === s) || {}).label || s; }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function safeStringify(v) {
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v, null, 2); } catch { return String(v); }
    }

    function pickText(obj, keys) {
        if (typeof obj === 'string') return obj;
        if (!obj || typeof obj !== 'object') return null;
        for (const k of keys) {
            if (typeof obj[k] === 'string' && obj[k].trim() !== '') return obj[k];
        }
        return null;
    }

    // بيحسب سبب ظهور الصف في القائمة بنفس منطق شرط WHERE في
    // chat_engine_learning_queue (الأولوية: fallback > escalated_unknown > low_confidence)
    function computeReason(row) {
        if (row.action === 'FALLBACK') return 'fallback';
        if (row.action === 'ESCALATE_TO_HUMAN' && (!row.scenario_id || row.scenario_id === 'unknown')) return 'escalated_unknown';
        return 'low_confidence';
    }

    // يحوّل صف الـ view + صف المراجعة (لو موجود) لشكل مناسب للعرض
    function projectRow(row, review) {
        const confidenceNum = row.confidence === null || row.confidence === undefined ? null : Number(row.confidence);
        return {
            traceEventId: row.trace_event_id,
            sessionId: row.session_id,
            turn: row.turn,
            reason: computeReason(row),
            confidence: Number.isFinite(confidenceNum) ? confidenceNum : null,
            action: row.action,
            scenarioId: row.scenario_id,
            explanation: row.explanation,
            reviewId: review?.id || null,
            status: review?.status || 'unresolved',
            correctedScenarioId: review?.corrected_scenario_id || null,
            notes: review?.notes || null,
            createdAt: row.created_at
        };
    }

    async function loadScenarioOptions() {
        try {
            const { data, error } = await supabase
                .from('chat_engine_scenarios')
                .select('scenario_key');
            if (error || !data || data.length === 0) return;
            const uniqueKeys = [...new Set(data.map(r => r.scenario_key))].sort();
            if (uniqueKeys.length > 0) SCENARIO_OPTIONS = uniqueKeys;
        } catch (err) {
            console.warn('[review-center] تعذّر تحميل قائمة السيناريوهات، هنستخدم القائمة الافتراضية:', err);
        }
    }

    let offset = 0;
    let reviewsBySession = {};

    function formatRelative(iso) {
        if (!iso) return '—';
        const diffMs = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1) return 'الآن';
        if (mins < 60) return `منذ ${mins} د`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `منذ ${hours} س`;
        const days = Math.floor(hours / 24);
        return `منذ ${days} يوم`;
    }

    // بيجيب أرقام حقيقية عن حالة محرك SIE (مش مجرد "الاستعلام نجح") — عدد
    // التتبّعات المُسجَّلة فعليًا من كل الوقت، عدد الجلسات المختلفة، آخر
    // وقت اتسجّل فيه تتبّع، وعدد العملاء المفعّل لهم SIE. لو العدد صفر،
    // بنوريه صراحة بدل ما نسيب القائمة الفاضية تفسَّر غلط على إنها "كل حاجة تمام".
    async function loadEnginePulse() {
        const noteEl = document.getElementById('pulse-note');
        noteEl.classList.remove('show');
        noteEl.textContent = '';
        try {
            const { count, error: countError } = await supabase
                .from('chat_engine_trace_events')
                .select('id', { count: 'exact', head: true });
            if (countError) throw countError;

            totalTraceEventsEver = count ?? 0;
            const totalEl = document.getElementById('pulse-total-traces');
            totalEl.textContent = totalTraceEventsEver;
            totalEl.classList.toggle('zero', totalTraceEventsEver === 0);

            const sessionsEl = document.getElementById('pulse-sessions');
            const lastTraceEl = document.getElementById('pulse-last-trace');

            if (totalTraceEventsEver === 0) {
                sessionsEl.textContent = '0'; sessionsEl.classList.add('zero');
                lastTraceEl.textContent = 'لسه ولا مرة'; lastTraceEl.classList.add('zero');
                noteEl.textContent = 'محرك SIE لسه ما سجّلش أي تتبّع حقيقي — القائمة تحت فاضية لأن مفيش بيانات بتتولّد أصلًا، مش لأن كل حاجة تمام.';
                noteEl.classList.add('show');
            } else {
                sessionsEl.classList.remove('zero'); lastTraceEl.classList.remove('zero');
                const [sessionsResult, lastResult] = await Promise.all([
                    supabase.from('chat_engine_trace_events').select('session_id').limit(5000),
                    supabase.from('chat_engine_trace_events').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle()
                ]);
                if (sessionsResult.error) throw sessionsResult.error;
                if (lastResult.error) throw lastResult.error;
                const distinctSessions = new Set((sessionsResult.data || []).map(r => r.session_id)).size;
                const approx = (sessionsResult.data || []).length >= 5000 ? '+' : '';
                sessionsEl.textContent = distinctSessions + approx;
                lastTraceEl.textContent = formatRelative(lastResult.data?.created_at);
            }
        } catch (err) {
            console.warn('[review-center] تعذّر تحميل نبض المحرك:', err);
            document.getElementById('pulse-total-traces').textContent = '—';
            document.getElementById('pulse-sessions').textContent = '—';
            document.getElementById('pulse-last-trace').textContent = '—';
        }

        // عدد العملاء المفعّل لهم SIE — best effort: لو الحساب الحالي مش
        // is_sie_admin() (بريد محدد، مش أي أدمن) هيرجع صفر بسبب RLS، مش
        // لازم يبقى معناه فعليًا صفر عميل مفعّل.
        try {
            const { count: sieUsersCount, error: sieUsersError } = await supabase
                .from('customer_sie_access')
                .select('id', { count: 'exact', head: true })
                .eq('is_enabled', true);
            document.getElementById('pulse-sie-users').textContent = sieUsersError ? '—' : (sieUsersCount ?? 0);
        } catch {
            document.getElementById('pulse-sie-users').textContent = '—';
        }
    }

    function applyFilters(rows) {
        return rows.filter(item => {
            if (filters.reason !== 'all' && item.reason !== filters.reason) return false;
            if (filters.status !== 'all' && item.status !== filters.status) return false;
            if (filters.session && !String(item.sessionId || '').toLowerCase().includes(filters.session)) return false;
            return true;
        });
    }

    async function loadQueue({ reset = true } = {}) {
        setFlag(null, '● جارِ الاتصال بقاعدة البيانات…');
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        if (reset) offset = 0;
        else { loadMoreBtn.disabled = true; loadMoreBtn.textContent = 'جارِ التحميل…'; }

        try {
            const { data, error } = await supabase
                .from('chat_engine_learning_queue')
                .select('trace_event_id, session_id, turn, action, scenario_id, confidence, explanation, created_at')
                .order('created_at', { ascending: false })
                .range(offset, offset + PAGE_SIZE - 1);

            if (error) throw error;

            const rows = data || [];
            const newSessionIds = [...new Set(rows.map(r => r.session_id))].filter(id => !(id in reviewsBySession));

            if (newSessionIds.length > 0) {
                const { data: reviews, error: reviewsError } = await supabase
                    .from('chat_engine_conversation_reviews')
                    .select('id, session_id, status, corrected_scenario_id, notes')
                    .in('session_id', newSessionIds);
                if (reviewsError) throw reviewsError;
                for (const sid of newSessionIds) reviewsBySession[sid] = null;
                for (const r of (reviews || [])) reviewsBySession[r.session_id] = r;
            }

            const projected = rows.map(row => projectRow(row, reviewsBySession[row.session_id]));
            QUEUE = reset ? projected : QUEUE.concat(projected);
            offset += rows.length;
            hasMore = rows.length === PAGE_SIZE;
            document.getElementById('loadMoreRow').style.display = hasMore ? 'flex' : 'none';

            setFlag('live');
            renderQueue();
        } catch (err) {
            console.error('[review-center] فشل تحميل قائمة التعلّم:', err);
            setFlag('error', '● تعذّر الاتصال بالبيانات — تحقق من صلاحيات Supabase/RLS');
            document.getElementById('empty').style.display = 'block';
            document.getElementById('empty').textContent =
                'تعذّر تحميل قائمة التعلّم. تحقق من رسالة الخطأ في الـ console — غالبًا صلاحيات الحساب ' +
                '(is_chat_engine_staff) أو مشكلة في شكل الاستعلام مقابل الـ view الحالي.';
            document.getElementById('queue-body').innerHTML = '';
        } finally {
            loadMoreBtn.disabled = false;
            loadMoreBtn.textContent = 'تحميل 200 صف إضافي';
        }
    }

    function renderStats() {
        document.getElementById('stat-total').textContent = QUEUE.length;
        document.getElementById('stat-fallback').textContent = QUEUE.filter(q => q.reason === 'fallback').length;
        document.getElementById('stat-escalated').textContent = QUEUE.filter(q => q.reason === 'escalated_unknown').length;
        document.getElementById('stat-corrected').textContent = QUEUE.filter(q => q.status === 'corrected').length;
    }

    function renderQueue() {
        renderStats();
        const body = document.getElementById('queue-body');
        const emptyEl = document.getElementById('empty');
        const visibleRows = applyFilters(QUEUE);

        if (QUEUE.length === 0) {
            emptyEl.style.display = 'block';
            if (totalTraceEventsEver === 0) {
                emptyEl.textContent = 'القائمة فاضية لأن محرك SIE لسه ما سجّلش أي محادثة حقيقية خالص — راجع "نبض المحرك" فوق. الفراغ هنا معناه "مفيش بيانات"، مش "كل حاجة تمام".';
            } else if (typeof totalTraceEventsEver === 'number' && totalTraceEventsEver > 0) {
                emptyEl.textContent = `المحرك سجّل ${totalTraceEventsEver} تتبّع فعلي حتى الآن، ومفيش ولا واحد محتاج مراجعة دلوقتي — يبان إن ثقة المحرك كويسة.`;
            } else {
                emptyEl.textContent = 'مفيش حاجة في قائمة التعلّم دلوقتي.';
            }
            body.innerHTML = '';
            return;
        }

        if (visibleRows.length === 0) {
            emptyEl.style.display = 'block';
            emptyEl.textContent = 'مفيش صفوف مطابقة للفلاتر الحالية — جرّب "مسح الفلاتر".';
            body.innerHTML = '';
            return;
        }

        emptyEl.style.display = 'none';
        body.innerHTML = visibleRows.map(item => `
            <tr class="${selected === item.traceEventId ? 'selected' : ''}" data-id="${escapeHtml(item.traceEventId)}">
                <td class="qid">${escapeHtml((item.sessionId || '').toString().slice(0, 8))}</td>
                <td>${escapeHtml(item.explanation || item.scenarioId || item.action || '—')}<span class="qmsg-sub">${escapeHtml(item.scenarioId || 'unknown')} · الدور ${item.turn}</span></td>
                <td><span class="badge ${item.reason}">${reasonLabel(item.reason)}</span></td>
                <td class="conf">${item.confidence === null ? '—' : item.confidence.toFixed(2)}</td>
                <td><span class="status-badge status-${item.status}">${statusLabel(item.status)}</span></td>
                <td class="conf">#${item.turn}</td>
            </tr>
        `).join('');
        body.querySelectorAll('tr').forEach(row => {
            row.addEventListener('click', () => openDetail(row.dataset.id));
        });
    }

    // بيبني عمود التتبّع من أعمدة chat_engine_trace_events الفعلية.
    // دفاعي عن قصد: بيحاول المفاتيح المتوقعة ولو مالقاش بيعرض الـ JSON
    // الخام للعمود كامل بدل ما يفترض شكل ثابت.
    function buildSpine(row) {
        const tokens = row.normalized_tokens;
        const tokenList = Array.isArray(tokens) ? tokens : (Array.isArray(tokens?.canonicals) ? tokens.canonicals : null);
        const rawText = pickText(tokens, ['rawText', 'raw_text', 'text']);

        const hyps = Array.isArray(row.hypotheses) ? row.hypotheses : (Array.isArray(row.hypotheses?.items) ? row.hypotheses.items : []);
        const ranking = row.ranking || {};
        const decision = row.decision || {};
        const rendered = row.rendered || {};
        const responseText = pickText(rendered, ['responseText', 'text', 'message']);

        const steps = [
            {
                name: 'اللغة',
                summary: rawText ? rawText.slice(0, 40) : (tokenList ? `${tokenList.length} tokens` : '—'),
                body: (rawText ? `rawText: ${JSON.stringify(rawText)}\n\n` : '') +
                    `normalized_tokens:\n${safeStringify(tokens)}` +
                    (row.response_language ? `\n\nresponse_language: ${row.response_language}` : '')
            },
            {
                name: 'التشخيص',
                summary: `${hyps.length} hypotheses`,
                body: hyps.length
                    ? 'hypotheses:\n' + hyps.map(h => `  - scenarioId: ${h.scenarioId ?? h.scenario_id ?? '—'}  confidence: ${h.confidence ?? '—'}  status: ${h.status ?? '—'}`).join('\n')
                    : `hypotheses:\n${safeStringify(row.hypotheses)}`
            },
            {
                name: 'الترتيب',
                summary: `top: ${ranking.topScenarioId ?? ranking.top_scenario_id ?? 'none'} (${ranking.topConfidence ?? ranking.top_confidence ?? '—'})`,
                body: safeStringify(ranking)
            },
            {
                name: 'القرار',
                summary: `${decision.action ?? row.action ?? '—'}`,
                body: safeStringify(decision) +
                    (typeof row.processing_time_ms === 'number' ? `\n\nprocessing_time_ms: ${row.processing_time_ms}` : '')
            }
        ];

        if (row.knowledge_data !== null && row.knowledge_data !== undefined) {
            steps.push({ name: 'المعرفة', summary: 'knowledge_data', body: safeStringify(row.knowledge_data) });
        }

        steps.push({
            name: 'الحوار',
            summary: responseText ? responseText.slice(0, 40) : '(مفيش نص رد مُستخرَج)',
            body: (responseText ? `responseText: ${JSON.stringify(responseText)}\n\n` : '') + `rendered:\n${safeStringify(rendered)}`
        });

        if (row.action_result !== null && row.action_result !== undefined) {
            steps.push({ name: 'تنفيذ الإجراء', summary: 'action_result', body: safeStringify(row.action_result) });
        }

        return steps;
    }

    function renderSpine(spine) {
        document.getElementById('spine').innerHTML = spine.map((step, si) => `
            <div class="spine-step" id="spine-step-${si}">
                <div class="spine-dot"></div>
                <button class="spine-toggle" data-si="${si}">
                    <span class="spine-summary">${escapeHtml(step.summary)}</span>
                    <span><span class="spine-name">${step.name}</span><span class="spine-num">0${si + 1}</span></span>
                </button>
                <div class="spine-body" id="spine-body-${si}">${escapeHtml(step.body).replace(/\n/g, '<br>')}</div>
            </div>
        `).join('');
        document.querySelectorAll('.spine-toggle').forEach(btn => {
            btn.addEventListener('click', () => toggleSpine(Number(btn.dataset.si)));
        });
    }

    async function openDetail(traceEventId) {
        const item = QUEUE.find(q => q.traceEventId === traceEventId);
        if (!item) return;
        selected = traceEventId;
        renderQueue();
        const detail = document.getElementById('detail');
        detail.classList.add('open');
        document.getElementById('detail-title').textContent = `الجلسة ${item.sessionId} — الدور ${item.turn}`;
        document.getElementById('detail-meta').textContent =
            `السبب: ${reasonLabel(item.reason)} · الثقة: ${item.confidence === null ? 'غير متاحة' : item.confidence.toFixed(3)}` +
            (item.explanation ? ` · ${item.explanation}` : '');
        document.getElementById('response-text').textContent = '—';
        document.getElementById('spine').innerHTML = '<div class="empty-state" style="padding:2rem 0;">جارِ تحميل تفاصيل التتبّع…</div>';

        const scenarioSelect = document.getElementById('correction-scenario');
        scenarioSelect.innerHTML = SCENARIO_OPTIONS.map(s => `<option value="${s}" ${s === item.correctedScenarioId ? 'selected' : ''}>${s}</option>`).join('');

        const noteField = document.getElementById('correction-note');
        noteField.value = item.notes || '';

        pendingStatus[traceEventId] = pendingStatus[traceEventId] || item.status;
        renderStatusOptions(traceEventId);
        document.getElementById('saved-flag').classList.remove('show');

        const convWrap = document.getElementById('conversation-transcript');
        convWrap.style.display = 'none';
        convWrap.innerHTML = '';
        const loadConvBtn = document.getElementById('loadConversationBtn');
        loadConvBtn.textContent = 'عرض';
        loadConvBtn.onclick = () => loadConversation(item.sessionId, traceEventId);

        detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        // تفاصيل التتبّع الكاملة بتيجي من الجدول نفسه (chat_engine_trace_events)
        // مش من الـ view — الـ view بيدّي الحقول الأساسية بس اللي بتحدد
        // الفلترة والعرض في الجدول.
        try {
            const { data, error } = await supabase
                .from('chat_engine_trace_events')
                .select('normalized_tokens, hypotheses, ranking, decision, knowledge_data, rendered, action_result, response_language, processing_time_ms')
                .eq('id', item.traceEventId)
                .maybeSingle();
            if (error) throw error;
            if (selected !== traceEventId) return; // المستخدم فتح صف تاني قبل ما يخلص التحميل

            if (!data) {
                document.getElementById('spine').innerHTML = '<div class="empty-state" style="padding:2rem 0;">تعذّر إيجاد سجل التتبّع الكامل لهذا الصف.</div>';
                return;
            }

            renderSpine(buildSpine(data));
            const responseText = pickText(data.rendered, ['responseText', 'text', 'message']);
            document.getElementById('response-text').textContent = responseText || '—';
        } catch (err) {
            console.error('[review-center] تعذّر تحميل تفاصيل التتبّع:', err);
            if (selected === traceEventId) {
                document.getElementById('spine').innerHTML = '<div class="empty-state" style="padding:2rem 0;">تعذّر تحميل تفاصيل التتبّع.</div>';
            }
        }
    }

    // المحادثة الكاملة للجلسة — مش الدور المُبلَّغ عنه بس — عشان السياق.
    // best effort: لو الحساب الحالي مش is_main_admin() فعليًا (بريد محدد،
    // مش أي دور admin) هيرجع فاضي بسبب RLS على chat_messages.
    async function loadConversation(sessionId, forTraceEventId) {
        const wrap = document.getElementById('conversation-transcript');
        const btn = document.getElementById('loadConversationBtn');
        if (wrap.style.display === 'flex') {
            wrap.style.display = 'none';
            btn.textContent = 'عرض';
            return;
        }
        btn.disabled = true;
        btn.textContent = 'جارِ التحميل…';
        try {
            const { data, error } = await supabase
                .from('chat_messages')
                .select('id, message_text, is_bot_reply, is_admin_reply, created_at, image_url')
                .eq('session_id', sessionId)
                .order('created_at', { ascending: true })
                .limit(300);
            if (error) throw error;
            if (selected !== forTraceEventId) return;

            const rows = data || [];
            if (rows.length === 0) {
                wrap.innerHTML = '<div class="empty-state" style="padding:1rem 0;">مفيش رسائل متاحة لهذه الجلسة (أو الحساب الحالي مالوش صلاحية قراءتها).</div>';
            } else {
                wrap.innerHTML = rows.map(m => {
                    const cls = m.is_admin_reply ? 'admin' : (m.is_bot_reply ? 'bot' : 'customer');
                    const who = m.is_admin_reply ? 'الفريق' : (m.is_bot_reply ? 'البوت' : 'العميل');
                    const time = new Date(m.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
                    const body = m.message_text || (m.image_url ? '(صورة)' : '—');
                    return `<div class="t-msg ${cls}">${escapeHtml(body)}<div class="t-meta">${who} · ${time}</div></div>`;
                }).join('');
            }
            wrap.style.display = 'flex';
            btn.textContent = 'إخفاء';
        } catch (err) {
            console.error('[review-center] تعذّر تحميل المحادثة الكاملة:', err);
            wrap.innerHTML = '<div class="empty-state" style="padding:1rem 0;">تعذّر تحميل المحادثة — تحقق من صلاحيات الحساب.</div>';
            wrap.style.display = 'flex';
            btn.textContent = 'عرض';
        } finally {
            btn.disabled = false;
        }
    }

    function toggleSpine(si) {
        document.getElementById(`spine-body-${si}`).classList.toggle('open');
        document.getElementById(`spine-step-${si}`).classList.toggle('inactive');
    }

    function renderStatusOptions(traceEventId) {
        const wrap = document.getElementById('status-options');
        wrap.innerHTML = STATUS_OPTIONS.map(s => `
            <button class="status-opt ${pendingStatus[traceEventId] === s.value ? 'active' : ''}" data-value="${s.value}">${s.label}</button>
        `).join('');
        wrap.querySelectorAll('.status-opt').forEach(btn => {
            btn.addEventListener('click', () => setStatus(traceEventId, btn.dataset.value));
        });
    }

    function setStatus(traceEventId, s) {
        pendingStatus[traceEventId] = s;
        renderStatusOptions(traceEventId);
    }

    async function saveReview() {
        if (selected === null) return;
        const item = QUEUE.find(q => q.traceEventId === selected);
        if (!item) return;
        const saveBtn = document.getElementById('saveReviewBtn');
        const notes = document.getElementById('correction-note').value.trim() || null;
        const correctedScenarioId = document.getElementById('correction-scenario').value || null;
        const status = pendingStatus[selected];

        saveBtn.disabled = true;
        saveBtn.textContent = 'جارِ الحفظ…';

        try {
            if (item.reviewId) {
                const { error } = await supabase
                    .from('chat_engine_conversation_reviews')
                    .update({
                        status,
                        corrected_scenario_id: correctedScenarioId,
                        notes,
                        reviewed_by: currentUser.id,
                        reviewed_at: new Date().toISOString()
                    })
                    .eq('id', item.reviewId);
                if (error) throw error;
            } else {
                const { data, error } = await supabase
                    .from('chat_engine_conversation_reviews')
                    .insert({
                        session_id: item.sessionId,
                        status,
                        corrected_scenario_id: correctedScenarioId,
                        notes,
                        reviewed_by: currentUser.id,
                        reviewed_at: new Date().toISOString()
                    })
                    .select('id')
                    .single();
                if (error) throw error;
                item.reviewId = data.id;
                reviewsBySession[item.sessionId] = { id: data.id, session_id: item.sessionId, status, corrected_scenario_id: correctedScenarioId, notes };
            }

            item.status = status;
            item.correctedScenarioId = correctedScenarioId;
            item.notes = notes;
            renderQueue();

            const flag = document.getElementById('saved-flag');
            flag.style.color = '';
            flag.textContent = 'تم الحفظ في chat_engine_conversation_reviews';
            flag.classList.add('show');
            setTimeout(() => flag.classList.remove('show'), 2500);
        } catch (err) {
            console.error('[review-center] فشل حفظ المراجعة:', err);
            const flag = document.getElementById('saved-flag');
            flag.textContent = 'فشل الحفظ — تحقق من صلاحيات الأدمن (RLS)';
            flag.style.color = 'var(--color-danger)';
            flag.classList.add('show');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'حفظ المراجعة';
        }
    }

    document.getElementById('closeDetailBtn').addEventListener('click', () => {
        selected = null;
        document.getElementById('detail').classList.remove('open');
        renderQueue();
    });
    document.getElementById('saveReviewBtn').addEventListener('click', saveReview);

    document.getElementById('filter-reason').addEventListener('change', e => { filters.reason = e.target.value; renderQueue(); });
    document.getElementById('filter-status').addEventListener('change', e => { filters.status = e.target.value; renderQueue(); });
    document.getElementById('filter-session').addEventListener('input', e => { filters.session = e.target.value.trim().toLowerCase(); renderQueue(); });
    document.getElementById('clearFiltersBtn').addEventListener('click', () => {
        filters.reason = 'all'; filters.status = 'all'; filters.session = '';
        document.getElementById('filter-reason').value = 'all';
        document.getElementById('filter-status').value = 'all';
        document.getElementById('filter-session').value = '';
        renderQueue();
    });
    document.getElementById('refreshBtn').addEventListener('click', () => {
        loadQueue({ reset: true });
        loadEnginePulse();
    });
    document.getElementById('loadMoreBtn').addEventListener('click', () => loadQueue({ reset: false }));

    await Promise.all([loadScenarioOptions(), loadQueue(), loadEnginePulse()]);
}

// ------------------------------------------------------------------
// قسم "العملاء" — متابعة تفعيل محرك الدعم الذكي (SIE) لكل عميل على حدة:
// مفعّل أو لأ دلوقتي، وتقدر تغيّر حالته أو تحدّد له سقف استخدام (عدد
// رسائل) أو تاريخ انتهاء. القسم ده مالوش أي منطق باك إند جديد — بيستخدم
// بالظبط نفس RPCs وجدول customer_sie_access المُعرَّفين فعلًا في
// sie-integration/sie-entitlement.js (isCurrentUserSieAdmin/
// getSieAccessStatus/adminSetAccess/adminResetUsage)، واللي already
// مُستخدَمين في نافذة "خيارات" الخاصة بكل مستخدم في صفحة المستخدمين
// (assets/js/admin/users.js). هنا بس واجهة مخصّصة وأوضح لإدارة SIE
// تحديدًا — جدول واحد بكل العملاء وحالتهم، بدل ما تكون الإعدادات مدفونة
// جوه نافذة عامة لكل مستخدم على حدة.
//
// ملحوظة صلاحيات مهمة (نفس القيد الموجود في users.js): تنفيذ
// sie_admin_set_access() / sie_admin_reset_usage()، وكمان قراءة صفوف
// عملاء تانيين من customer_sie_access أصلًا، مقصورة على is_sie_admin() —
// بريد محدد، مش أي حساب role='admin' عادي. لو الحساب الحالي مش هو،
// القائمة تحت هترجع فاضية (أو الحفظ هيفشل) بسبب RLS — مش لأن مفيش عملاء
// مفعّلين فعليًا. بنوضّح ده صراحة في القسم بدل ما نسيبه يفسَّر غلط.
// ------------------------------------------------------------------
async function initCustomerAccess(currentUser) {
    let isSieAdmin = false;
    let CUSTOMERS = []; // { id, fullName, email, role, access: customer_sie_access row|null }
    let selectedUserId = null;
    const filters = { status: 'all', search: '' };

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function accessModeLabel(mode) {
        return { unlimited: 'بدون حد', quota: 'حد رسائل', expiration: 'تاريخ انتهاء' }[mode] || '—';
    }
    function accessModeBadgeClass(mode) {
        return { unlimited: 'same', quota: 'low_confidence', expiration: 'fallback' }[mode] || 'same';
    }

    // نفس منطق evaluateSieAccessRow() في assets/js/chatbot-mode-service.js —
    // مكرَّر هنا عمدًا (بدل استيراده من مسار العميل) عشان القسم ده يفضل
    // مستقل تمامًا عن مسار الشات، لكن بنفس القاعدة بالظبط، عشان الحالة
    // المعروضة هنا للأدمن تطابق اللي العميل شايفه فعليًا (مفعّل + مش
    // منتهي + عنده كوتة).
    function evaluateStatus(row) {
        if (!row || !row.is_enabled) return { enabled: false, label: 'غير مفعّل' };
        if (row.access_mode === 'expiration' && row.expires_at) {
            if (new Date(row.expires_at).getTime() <= Date.now()) return { enabled: false, label: 'انتهت الصلاحية' };
        }
        if (row.access_mode === 'quota') {
            const used = row.messages_used ?? 0;
            const quota = row.message_quota ?? 0;
            if (quota > 0 && used >= quota) return { enabled: false, label: 'انتهت الكوتة' };
        }
        return { enabled: true, label: 'مفعّل' };
    }

    function usageLabel(row) {
        if (!row) return 'لسه معملوش تفعيل لهذا العميل';
        if (row.access_mode === 'quota') return `${row.messages_used ?? 0} / ${row.message_quota ?? '—'}`;
        if (row.access_mode === 'expiration') return `${row.messages_used ?? 0} رسالة — ينتهي ${row.expires_at ? new Date(row.expires_at).toLocaleString('ar-EG') : '—'}`;
        return `${row.messages_used ?? 0} رسالة مُرسَلة`;
    }

    async function loadCustomers() {
        document.getElementById('custLastSync').textContent = '● جارِ الاتصال بقاعدة البيانات…';
        try {
            const [{ data: profiles, error: profilesError }, accessResult] = await Promise.all([
                supabase.from('profiles').select('id, full_name, email, role, created_at').order('created_at', { ascending: false }),
                supabase.from('customer_sie_access').select('*')
            ]);
            if (profilesError) throw profilesError;

            // قراءة customer_sie_access ممكن ترجع فاضية أو بخطأ لو الحساب
            // الحالي مش is_sie_admin() فعليًا — مش هنعتبره فشل قاتل للقسم
            // كله (قائمة العملاء من profiles لسه مفيدة)، وكل عميل هيظهر
            // "غير مفعّل" افتراضيًا (نفس سلوك getSieAccessStatus لما مفيش
            // صف)، مع تنبيه واضح تحت لو ده هو السبب.
            const accessByUser = new Map();
            if (!accessResult.error) {
                for (const row of (accessResult.data || [])) accessByUser.set(row.user_id, row);
            } else {
                console.warn('[review-center] تعذّر قراءة customer_sie_access (على الأغلب صلاحية is_sie_admin):', accessResult.error.message);
            }

            document.getElementById('cust-not-sie-admin-note').style.display = (!isSieAdmin || accessResult.error) ? 'block' : 'none';

            CUSTOMERS = (profiles || []).map(p => ({
                id: p.id,
                fullName: p.full_name || 'بدون اسم',
                email: p.email || '—',
                role: p.role,
                access: accessByUser.get(p.id) || null
            }));

            document.getElementById('custLastSync').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
            document.getElementById('custDataModeFlag').style.display = 'none';
            renderCustomers();
        } catch (err) {
            console.error('[review-center] فشل تحميل قائمة العملاء:', err);
            document.getElementById('custLastSync').textContent = '';
            const flag = document.getElementById('custDataModeFlag');
            flag.style.display = 'inline-flex';
            flag.className = 'demo-flag error';
            flag.textContent = '● تعذّر تحميل قائمة العملاء';
            document.getElementById('cust-empty').style.display = 'block';
            document.getElementById('cust-empty').textContent = 'تعذّر تحميل قائمة العملاء — تحقق من صلاحيات الحساب.';
            document.getElementById('cust-body').innerHTML = '';
        }
    }

    function applyFilters(rows) {
        return rows.filter(c => {
            const status = evaluateStatus(c.access);
            if (filters.status === 'enabled' && !status.enabled) return false;
            if (filters.status === 'disabled' && status.enabled) return false;
            if (filters.search) {
                const hay = `${c.fullName} ${c.email}`.toLowerCase();
                if (!hay.includes(filters.search)) return false;
            }
            return true;
        });
    }

    function renderStats() {
        const enabledCount = CUSTOMERS.filter(c => evaluateStatus(c.access).enabled).length;
        document.getElementById('cust-stat-total').textContent = CUSTOMERS.length;
        document.getElementById('cust-stat-enabled').textContent = enabledCount;
        document.getElementById('cust-stat-disabled').textContent = CUSTOMERS.length - enabledCount;
        document.getElementById('cust-stat-limited').textContent = CUSTOMERS.filter(c => c.access && c.access.access_mode !== 'unlimited').length;
    }

    function renderCustomers() {
        renderStats();
        const body = document.getElementById('cust-body');
        const emptyEl = document.getElementById('cust-empty');
        const visible = applyFilters(CUSTOMERS);

        if (CUSTOMERS.length === 0) {
            emptyEl.style.display = 'block';
            emptyEl.textContent = 'مفيش عملاء في جدول profiles حاليًا.';
            body.innerHTML = '';
            return;
        }
        if (visible.length === 0) {
            emptyEl.style.display = 'block';
            emptyEl.textContent = 'مفيش عملاء مطابقين للفلاتر الحالية.';
            body.innerHTML = '';
            return;
        }

        emptyEl.style.display = 'none';
        body.innerHTML = visible.map(c => {
            const status = evaluateStatus(c.access);
            const mode = c.access?.access_mode || null;
            return `
                <tr data-id="${escapeHtml(c.id)}">
                    <td>${escapeHtml(c.fullName)}<span class="qmsg-sub" style="direction:rtl; text-align:right;">${escapeHtml(c.email)}</span></td>
                    <td><span class="status-badge status-${status.enabled ? 'resolved' : 'dismissed'}">${escapeHtml(status.label)}</span></td>
                    <td>${mode ? `<span class="badge ${accessModeBadgeClass(mode)}">${accessModeLabel(mode)}</span>` : '—'}</td>
                    <td class="conf">${escapeHtml(usageLabel(c.access))}</td>
                    <td><button class="btn btn-ghost btn-sm cust-edit-btn" data-id="${escapeHtml(c.id)}">تعديل</button></td>
                </tr>
            `;
        }).join('');

        body.querySelectorAll('.cust-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                openCustomerDetail(btn.dataset.id);
            });
        });
    }

    function openCustomerDetail(userId) {
        const customer = CUSTOMERS.find(c => c.id === userId);
        if (!customer) return;
        selectedUserId = userId;

        document.getElementById('cust-detail-title').textContent = customer.fullName;
        document.getElementById('cust-detail-meta').textContent = customer.email;

        const row = customer.access;
        const mode = row?.access_mode || 'unlimited';
        document.getElementById('cust-enabled-toggle').checked = row?.is_enabled || false;
        document.getElementById('cust-access-mode').value = mode;
        document.getElementById('cust-message-quota').value = row?.message_quota ?? '';
        document.getElementById('cust-expires-at').value = row?.expires_at
            ? new Date(row.expires_at).toISOString().slice(0, 16)
            : '';
        document.getElementById('cust-notes').value = row?.notes || '';
        document.getElementById('cust-quota-row').style.display = mode === 'quota' ? '' : 'none';
        document.getElementById('cust-expiry-row').style.display = mode === 'expiration' ? '' : 'none';
        document.getElementById('cust-usage-display').textContent = usageLabel(row);
        document.getElementById('cust-saved-flag').classList.remove('show');

        document.getElementById('cust-detail').classList.add('open');
        document.getElementById('cust-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function closeCustomerDetail() {
        selectedUserId = null;
        document.getElementById('cust-detail').classList.remove('open');
    }

    document.getElementById('cust-access-mode').addEventListener('change', (e) => {
        const mode = e.target.value;
        document.getElementById('cust-quota-row').style.display = mode === 'quota' ? '' : 'none';
        document.getElementById('cust-expiry-row').style.display = mode === 'expiration' ? '' : 'none';
    });

    document.getElementById('cust-save-btn').addEventListener('click', async () => {
        if (!selectedUserId) return;
        const saveBtn = document.getElementById('cust-save-btn');
        const isEnabled = document.getElementById('cust-enabled-toggle').checked;
        const accessMode = document.getElementById('cust-access-mode').value;
        const quotaRaw = document.getElementById('cust-message-quota').value;
        const expiryRaw = document.getElementById('cust-expires-at').value;
        const notes = document.getElementById('cust-notes').value.trim() || null;

        const messageQuota = accessMode === 'quota' && quotaRaw ? parseInt(quotaRaw, 10) : null;
        const expiresAt = accessMode === 'expiration' && expiryRaw ? new Date(expiryRaw).toISOString() : null;

        if (accessMode === 'quota' && (!messageQuota || messageQuota < 1)) {
            alert('من فضلك أدخل حد رسائل صحيح (رقم أكبر من صفر)');
            return;
        }
        if (accessMode === 'expiration' && !expiresAt) {
            alert('من فضلك اختر تاريخ انتهاء');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'جارِ الحفظ…';
        const flag = document.getElementById('cust-saved-flag');
        try {
            const { error } = await adminSetAccess(supabase, {
                userId: selectedUserId, isEnabled, accessMode, messageQuota, expiresAt, notes
            });
            if (error) throw error;

            flag.style.color = '';
            flag.textContent = 'تم الحفظ في customer_sie_access';
            flag.classList.add('show');
            await loadCustomers();
            openCustomerDetail(selectedUserId); // إعادة تعبئة اللوحة بالقيم المحفوظة فعليًا من القاعدة
        } catch (err) {
            console.error('[review-center] فشل حفظ إعدادات SIE:', err);
            flag.style.color = 'var(--color-danger)';
            flag.textContent = 'فشل الحفظ: ' + (err.message || 'تحقق من صلاحية is_sie_admin()');
            flag.classList.add('show');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'حفظ إعدادات SIE';
        }
    });

    document.getElementById('cust-reset-usage-btn').addEventListener('click', async () => {
        if (!selectedUserId) return;
        if (!confirm('تصفير عداد الاستخدام لهذا العميل؟')) return;
        const resetBtn = document.getElementById('cust-reset-usage-btn');
        const flag = document.getElementById('cust-saved-flag');
        resetBtn.disabled = true;
        try {
            const { error } = await adminResetUsage(supabase, selectedUserId);
            if (error) throw error;
            flag.style.color = '';
            flag.textContent = 'تم تصفير الاستخدام';
            flag.classList.add('show');
            await loadCustomers();
            openCustomerDetail(selectedUserId);
        } catch (err) {
            console.error('[review-center] فشل تصفير الاستخدام:', err);
            flag.style.color = 'var(--color-danger)';
            flag.textContent = 'فشل التصفير: ' + (err.message || 'تحقق من صلاحية is_sie_admin()');
            flag.classList.add('show');
        } finally {
            resetBtn.disabled = false;
        }
    });

    document.getElementById('custCloseDetailBtn').addEventListener('click', closeCustomerDetail);
    document.getElementById('custRefreshBtn').addEventListener('click', loadCustomers);
    document.getElementById('cust-filter-search').addEventListener('input', e => { filters.search = e.target.value.trim().toLowerCase(); renderCustomers(); });
    document.getElementById('cust-filter-status').addEventListener('change', e => { filters.status = e.target.value; renderCustomers(); });
    document.getElementById('cust-clear-filters-btn').addEventListener('click', () => {
        filters.status = 'all'; filters.search = '';
        document.getElementById('cust-filter-status').value = 'all';
        document.getElementById('cust-filter-search').value = '';
        renderCustomers();
    });

    isSieAdmin = await isCurrentUserSieAdmin(supabase);
    await loadCustomers();
}

// ------------------------------------------------------------------
// معمل التحقق — منقول من صفحة validation-lab.html المستقلة القديمة إلى
// قسم جديد هنا. زي ما كان في الصفحة الأصلية: بيانات تجريبية ثابتة مبنية
// على نفس النتائج اللي جابها فعليًا replay-engine.js + comparison-engine.js
// + validation-policy.js لتعديل محتوى الأسعار ده في
// observability/tests/shadow-run-engine.e2e.test.mjs. مفيش أي استدعاء API
// حقيقي هنا — شوف شارة "بيانات تجريبية" فوق القسم. المنطق نفسه (محاكاة،
// تشغيل الظل، بوابة النشر مع التجاوز) اتنقل زي ما هو، وبس اتلبّس مكونات
// الصفحة الحالية (glass-card، stats-grid/stat-card، queue-table،
// status-badge، panel-block، response-card، saved-flag) بدل تصميم منفصل،
// عشان الشكل والتجربة يبقوا موحّدين مع باقي مركز المراجعة.
// ------------------------------------------------------------------
function initValidationLab() {
    let shadowVerdict = null; // بيتحدد بعد "تشغيل" مجموعة اختبارات الانحدار — وده اللي بيتحكم في النشر

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function runSimulation() {
        const results = document.getElementById('vl-sim-results');
        results.innerHTML = `
            <div class="glass-card compare-card">
                <div class="compare-head">
                    <span>الدور 1 · conv-pricing</span>
                    <span class="badge same">القرار زي ما هو: ANSWER</span>
                </div>
                <div class="compare-body">
                    <div class="compare-col">
                        <div class="col-label">قبل — pricing v2 (منشور)</div>
                        <div class="fact-row"><span class="k">السيناريو</span><span class="v">pricing_inquiry</span></div>
                        <div class="fact-row"><span class="k">الثقة</span><span class="v">0.800</span></div>
                        <div class="response-card">
                            <div class="label">الرد المُرسل</div>
                            <div>عندنا 3 باقات: باقة الدعم الفني بس، باقة واتساب بس، والباقة الشاملة اللي بتضم الاتنين بسعر أقل من لو اشتركت فيهم منفصلين…</div>
                        </div>
                    </div>
                    <div class="compare-col">
                        <div class="col-label">بعد — pricing v3 (مسودة)</div>
                        <div class="fact-row"><span class="k">السيناريو</span><span class="v">pricing_inquiry</span></div>
                        <div class="fact-row"><span class="k">الثقة</span><span class="v">0.800 <span class="badge same">±0.000</span></span></div>
                        <div class="response-card">
                            <div class="label">الرد المُرسل</div>
                            <div>نص جديد للأسعار بعد مراجعة فريق المبيعات لعروض الربع الحالي…</div>
                        </div>
                    </div>
                </div>
            </div>
            <p class="hint">النص المُرسل بس اللي اتغيّر (محتوى المعرفة من موديول 7) — القرار، السيناريو، والثقة زي ما هما. ده بالظبط النوع من التعديلات اللي المفروض بوابة النشر تسمح بيه بسهولة.</p>
        `;
    }

    function runShadowRun() {
        document.getElementById('vl-shadow-summary').style.display = 'grid';
        document.getElementById('vl-shadow-table').style.display = 'block';

        const rows = [
            { id: 'conv-pricing', desc: 'اسعار خطط باقات بكام عروض ايه', verdict: 'pass', turns: 1, reason: '—' },
            { id: 'conv-platform', desc: 'عايز اعرف عن منصه ازاي بتشتغل', verdict: 'pass', turns: 1, reason: '—' },
            { id: 'conv-ticket-journey', desc: 'الـ API مش شغال ← (صمت)', verdict: 'pass', turns: 2, reason: '—' },
            { id: 'conv-pricing-edge', desc: 'الاسعار بكام لو اشتركت سنوي', verdict: 'fail', turns: 1, reason: 'الدور 1: الثقة نزلت من 0.800 إلى 0.480' }
        ];

        const passCount = rows.filter(r => r.verdict === 'pass').length;
        const failCount = rows.length - passCount;
        document.getElementById('vl-stat-total').textContent = rows.length;
        document.getElementById('vl-stat-pass').textContent = passCount;
        document.getElementById('vl-stat-fail').textContent = failCount;
        document.getElementById('vl-stat-verdict').textContent = failCount === 0 ? 'ناجح' : 'فاشل';
        document.getElementById('vl-stat-verdict-icon').className = 'stat-icon ' + (failCount === 0 ? 'ok' : 'danger');

        document.getElementById('vl-shadow-rows').innerHTML = rows.map(r => `
            <tr>
                <td class="qid">${escapeHtml(r.id)}</td>
                <td>${escapeHtml(r.desc)}</td>
                <td><span class="status-badge status-${r.verdict === 'pass' ? 'resolved' : 'dismissed'}">${r.verdict === 'pass' ? 'ناجحة' : 'فاشلة'}</span></td>
                <td class="conf">${r.turns}</td>
                <td style="color:var(--color-text-secondary); font-size:.8rem;">${escapeHtml(r.reason)}</td>
            </tr>
        `).join('');

        shadowVerdict = { passed: failCount === 0, reasons: rows.filter(r => r.verdict === 'fail').map(r => r.reason) };
        updateGate();
    }

    function updateGate() {
        const dot = document.getElementById('vl-gate-dot');
        const title = document.getElementById('vl-gate-title');
        const reason = document.getElementById('vl-gate-reason');
        const publishBtn = document.getElementById('vl-publish-btn');

        if (!shadowVerdict) {
            dot.className = 'gate-dot';
            title.textContent = 'لا يوجد تشغيل تحقق مسجّل';
            reason.innerHTML = 'شغّل تبويب «تشغيل الظل» الأول عشان يتسجل حكم لـ <code>knowledge:pricing v3</code>. النشر ممنوع لحد ما يبقى فيه حكم.';
            publishBtn.disabled = true;
            return;
        }

        if (shadowVerdict.passed) {
            dot.className = 'gate-dot pass';
            title.textContent = 'نجحت مجموعة اختبارات الانحدار';
            reason.textContent = 'كل المحادثات في التشغيل حافظت على نفس القرار والثقة، أو تحسّنت. النشر متاح دلوقتي — من غير ما تحتاج تجاوز.';
            publishBtn.disabled = false;
        } else {
            dot.className = 'gate-dot';
            title.textContent = 'فشلت مجموعة اختبارات الانحدار';
            reason.innerHTML = 'ممنوع: <code>' + shadowVerdict.reasons.map(escapeHtml).join('</code>، <code>') + '</code>. النشر محتاج سبب تجاوز صريح تحت.';
            publishBtn.disabled = true;
        }
    }

    function publish(withOverride) {
        const overrideReason = document.getElementById('vl-override-reason').value.trim();
        if (withOverride && overrideReason.length === 0) {
            alert('سبب التجاوز مطلوب عشان تنشر رغم فشل أو غياب الحكم.');
            return;
        }
        if (!withOverride && (!shadowVerdict || !shadowVerdict.passed)) return;

        const flag = document.getElementById('vl-published-flag');
        flag.classList.add('show');
        flag.textContent = withOverride
            ? `تم النشر بتجاوز (عرض تجريبي): "${overrideReason}" — ده هيتسجل في chat_engine_publish_overrides.`
            : 'تم النشر (محليًا فقط — عرض تجريبي). في الإنتاج بينادي على publishKnowledgeVersion() عبر Action Layer.';
    }

    document.getElementById('vl-run-sim-btn').addEventListener('click', runSimulation);
    document.getElementById('vl-run-shadow-btn').addEventListener('click', runShadowRun);
    document.getElementById('vl-publish-btn').addEventListener('click', () => publish(false));
    document.getElementById('vl-override-btn').addEventListener('click', () => publish(true));

    updateGate();
}

// ------------------------------------------------------------------
// قسم "حالات المراجعة" — يعرض المحادثات اللي محرك SIE مقدرش يحسمها
// بثقة كافية أو رجّع فيها رد احتياطي من الذكاء الاصطناعي، بتفاصيل أوسع
// من قائمة التعلّم فوق: رسالة العميل كاملة، اللغة، الـ Intent المتوقع،
// اقتراح AI (لو موجود)، رد المشرف، Keywords، Scenario/Intent، تواريخ
// الإنشاء والتعديل، وسجل تعديلات/موافقات كامل لكل حالة.
//
// القسم ده بالكامل Mock — مفيش أي استدعاء Supabase أو API حقيقي هنا.
// البيانات مصفوفة ثابتة في الذاكرة (CASES)، وأي حفظ أو تغيير حالة
// بيعدّل المصفوفة دي محليًا بس، وبيترجع لأصله لو الصفحة اتعمللها refresh.
// TODO: لما يتوفر جدول حقيقي (مثلاً chat_engine_ai_fallback_cases) في
// الـ backend، استبدل تحميل/حفظ CASES هنا باستدعاءات Supabase حقيقية،
// بنفس نمط initReviewCenter() فوق.
// ------------------------------------------------------------------
function initAiFallbackCenter(currentUser) {
    const STATUS_OPTIONS = [
        { value: 'pending', label: 'قيد الانتظار' },
        { value: 'under_review', label: 'قيد المراجعة' },
        { value: 'approved', label: 'مُعتمدة' },
        { value: 'rejected', label: 'مرفوضة' },
        { value: 'archived', label: 'مؤرشفة' }
    ];

    const REASON_LABELS = {
        low_confidence: 'ثقة منخفضة',
        no_matching_scenario: 'مفيش سيناريو مطابق',
        ambiguous_intent: 'Intent غامض',
        unsupported_language: 'لغة غير مدعومة',
        timeout: 'مهلة/صمت من غير رد'
    };

    const LANGUAGE_LABELS = {
        ar: 'العربية', 'ar-eg': 'عامية مصرية', en: 'الإنجليزية', mixed: 'عربي/إنجليزي مختلط'
    };

    function hoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }
    function daysAgo(d) { return hoursAgo(d * 24); }

    // بيانات تجريبية بالكامل (Mock) — TODO: استبدالها بجلب حقيقي من الـ backend.
    let CASES = [
        {
            id: 'aif-1001',
            customerMessage: 'عايز الغي الاشتراك بتاعي دلوقتي، مش لاقي زرار الالغاء في صفحة الحساب خالص',
            language: 'ar-eg',
            expectedIntent: 'subscription_cancellation',
            confidence: 0.38,
            failureReason: 'low_confidence',
            aiSuggestion: 'يبدو أن العميل يطلب إلغاء الاشتراك. نقترح توجيهه إلى: الإعدادات ← الاشتراك ← إلغاء، أو تصعيد الحالة لفريق الفوترة لو الزر غير ظاهر له فعليًا.',
            adminReply: null,
            keywords: ['إلغاء', 'اشتراك', 'حساب'],
            scenarioIntent: 'subscription_cancellation',
            createdAt: hoursAgo(3),
            updatedAt: hoursAgo(3),
            status: 'pending',
            history: [
                { at: hoursAgo(3), actor: 'محرك SIE', action: 'تم إنشاء الحالة تلقائيًا — الثقة (0.38) أقل من الحد الأدنى المطلوب.' }
            ]
        },
        {
            id: 'aif-1002',
            customerMessage: 'Hi, does this platform support Shopify webhooks? I keep getting 404 errors on the callback URL.',
            language: 'en',
            expectedIntent: 'webhook_delivery_failure',
            confidence: 0.51,
            failureReason: 'ambiguous_intent',
            aiSuggestion: 'الرسالة فيها احتمالين: مشكلة في إعداد الـ webhook endpoint، أو استفسار عام عن الدعم لمنصة Shopify. نقترح الرد بخطوات فحص الـ callback URL أولاً.',
            adminReply: 'تم الرد على العميل بخطوات التأكد من الـ endpoint وتفعيل السجل (logs) على لوحة Shopify.',
            keywords: ['webhook', 'Shopify', '404', 'callback'],
            scenarioIntent: 'webhook_delivery_failure',
            createdAt: daysAgo(2),
            updatedAt: hoursAgo(6),
            status: 'approved',
            history: [
                { at: daysAgo(2), actor: 'محرك SIE', action: 'تم إنشاء الحالة تلقائيًا — Intent غامض بين مشكلتين محتملتين.' },
                { at: daysAgo(1), actor: 'سارة أحمد', action: 'تم نقل الحالة إلى «قيد المراجعة».' },
                { at: hoursAgo(6), actor: 'سارة أحمد', action: 'تمت الموافقة على الرد وإرساله للعميل.' }
            ]
        },
        {
            id: 'aif-1003',
            customerMessage: 'plz help fatورة مش راضيه تتحدث من امبارح وانا محتاجها ضروري النهارده',
            language: 'mixed',
            expectedIntent: 'subscription_payment_not_reflected',
            confidence: 0.29,
            failureReason: 'unsupported_language',
            aiSuggestion: null,
            adminReply: null,
            keywords: ['فاتورة', 'تحديث', 'دفع'],
            scenarioIntent: 'unknown',
            createdAt: hoursAgo(9),
            updatedAt: hoursAgo(1),
            status: 'under_review',
            history: [
                { at: hoursAgo(9), actor: 'محرك SIE', action: 'تم إنشاء الحالة تلقائيًا — المزج بين العربية والإنجليزية قلّل ثقة التطبيع اللغوي.' },
                { at: hoursAgo(1), actor: 'محمود سعيد', action: 'تم نقل الحالة إلى «قيد المراجعة» لحين التأكد من حالة الفاتورة.' }
            ]
        },
        {
            id: 'aif-1004',
            customerMessage: '(العميل بعت رسالة فاضية ومرفق صورة بس من غير أي نص)',
            language: 'ar',
            expectedIntent: null,
            confidence: null,
            failureReason: 'timeout',
            aiSuggestion: 'لا يوجد نص كافٍ لتوليد اقتراح — يُنصح بمراجعة الصورة المرفقة يدويًا أو الرد بطلب توضيح من العميل.',
            adminReply: 'تم الرد بطلب توضيح إضافي من العميل، ولم يصل رد حتى الآن.',
            keywords: [],
            scenarioIntent: 'unknown',
            createdAt: daysAgo(5),
            updatedAt: daysAgo(4),
            status: 'rejected',
            history: [
                { at: daysAgo(5), actor: 'محرك SIE', action: 'تم إنشاء الحالة تلقائيًا — لا يوجد نص كافٍ لاستخراج Intent.' },
                { at: daysAgo(4), actor: 'محمود سعيد', action: 'تم رفض الحالة — لا يوجد ما يكفي من السياق للتصنيف.' }
            ]
        },
        {
            id: 'aif-1005',
            customerMessage: 'إزاي أقدر أربط الـ API بتاعي بحساب المنصة؟ عندي مفتاح API بس مش عارف أحطه فين بالظبط',
            language: 'ar',
            expectedIntent: 'api_integration_issue',
            confidence: 0.44,
            failureReason: 'no_matching_scenario',
            aiSuggestion: 'لا يوجد سيناريو مطابق تمامًا لخطوات ربط الـ API الحالية — نقترح إنشاء سيناريو جديد "إعداد مفتاح API لأول مرة" منفصل عن "فشل تسليم الـ webhook".',
            adminReply: 'تم الرد يدويًا بخطوات الربط، وتم تسجيل ملاحظة لفريق المحتوى بإضافة سيناريو مخصص.',
            keywords: ['API', 'مفتاح', 'ربط', 'إعداد'],
            scenarioIntent: 'unknown',
            createdAt: daysAgo(9),
            updatedAt: daysAgo(8),
            status: 'archived',
            history: [
                { at: daysAgo(9), actor: 'محرك SIE', action: 'تم إنشاء الحالة تلقائيًا — لا يوجد سيناريو مطابق بثقة كافية.' },
                { at: daysAgo(8), actor: 'سارة أحمد', action: 'تم الرد يدويًا وأرشفة الحالة بعد تسجيل ملاحظة لفريق المحتوى.' }
            ]
        },
        {
            id: 'aif-1006',
            customerMessage: 'هل فيه خصم لو اشتركت في الباقة الشاملة لمدة سنة كاملة بدل شهري؟',
            language: 'ar',
            expectedIntent: 'pricing_inquiry',
            confidence: 0.47,
            failureReason: 'low_confidence',
            aiSuggestion: null,
            adminReply: null,
            keywords: ['خصم', 'باقة', 'سنوي'],
            scenarioIntent: 'pricing_inquiry',
            createdAt: hoursAgo(1),
            updatedAt: hoursAgo(1),
            status: 'pending',
            history: [
                { at: hoursAgo(1), actor: 'محرك SIE', action: 'تم إنشاء الحالة تلقائيًا — الثقة (0.47) أقل من حد النشر التلقائي.' }
            ]
        }
    ];

    let selected = null;
    let pendingStatus = {};
    const filters = { status: 'all', language: 'all', reason: 'all', search: '' };

    // دوال مساعدة مكرّرة هنا عمدًا (escapeHtml/formatRelative) عشان القسم
    // ده يفضل مستقل تمامًا كمكوّن Mock، بنفس مبدأ التكرار المتعمّد في
    // قسم "العملاء" فوق (initCustomerAccess).
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function formatRelative(iso) {
        if (!iso) return '—';
        const diffMs = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1) return 'الآن';
        if (mins < 60) return `منذ ${mins} د`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `منذ ${hours} س`;
        const days = Math.floor(hours / 24);
        return `منذ ${days} يوم`;
    }
    function formatFull(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
    }
    function statusLabel(s) { return (STATUS_OPTIONS.find(o => o.value === s) || {}).label || s; }
    function reasonLabel(r) { return REASON_LABELS[r] || r || '—'; }
    function languageLabel(l) { return LANGUAGE_LABELS[l] || l || '—'; }

    function populateLanguageFilter() {
        const select = document.getElementById('aif-filter-language');
        const langs = [...new Set(CASES.map(c => c.language))];
        select.innerHTML = '<option value="all">الكل</option>' +
            langs.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(languageLabel(l))}</option>`).join('');
    }

    function applyFilters(rows) {
        return rows.filter(c => {
            if (filters.status !== 'all' && c.status !== filters.status) return false;
            if (filters.language !== 'all' && c.language !== filters.language) return false;
            if (filters.reason !== 'all' && c.failureReason !== filters.reason) return false;
            if (filters.search) {
                const hay = `${c.customerMessage} ${(c.keywords || []).join(' ')}`.toLowerCase();
                if (!hay.includes(filters.search)) return false;
            }
            return true;
        });
    }

    function renderStats() {
        document.getElementById('aif-stat-total').textContent = CASES.length;
        document.getElementById('aif-stat-pending').textContent = CASES.filter(c => c.status === 'pending').length;
        document.getElementById('aif-stat-under-review').textContent = CASES.filter(c => c.status === 'under_review').length;
        document.getElementById('aif-stat-approved').textContent = CASES.filter(c => c.status === 'approved').length;
        document.getElementById('aif-stat-rejected').textContent = CASES.filter(c => c.status === 'rejected').length;
    }

    function renderTable() {
        renderStats();
        const body = document.getElementById('aif-body');
        const emptyEl = document.getElementById('aif-empty');
        const rows = applyFilters(CASES);

        if (rows.length === 0) {
            emptyEl.style.display = 'block';
            emptyEl.textContent = CASES.length === 0
                ? 'مفيش حالات مراجعة مسجّلة حاليًا.'
                : 'مفيش حالات مطابقة للفلاتر الحالية — جرّب "مسح الفلاتر".';
            body.innerHTML = '';
            return;
        }

        emptyEl.style.display = 'none';
        body.innerHTML = rows.map(c => `
            <tr class="${selected === c.id ? 'selected' : ''}" data-id="${escapeHtml(c.id)}">
                <td>${escapeHtml((c.customerMessage || '').slice(0, 70))}${(c.customerMessage || '').length > 70 ? '…' : ''}</td>
                <td><span class="badge same">${escapeHtml(languageLabel(c.language))}</span></td>
                <td>${escapeHtml(c.expectedIntent || '—')}</td>
                <td class="conf">${c.confidence === null || c.confidence === undefined ? '—' : c.confidence.toFixed(2)}</td>
                <td><span class="badge ${c.failureReason}">${escapeHtml(reasonLabel(c.failureReason))}</span></td>
                <td><span class="status-badge status-${c.status}">${escapeHtml(statusLabel(c.status))}</span></td>
                <td class="conf">${formatRelative(c.createdAt)}</td>
            </tr>
        `).join('');

        body.querySelectorAll('tr').forEach(row => {
            row.addEventListener('click', () => openDetail(row.dataset.id));
        });
    }

    function renderKeywords(keywords) {
        const wrap = document.getElementById('aif-keywords');
        if (!keywords || keywords.length === 0) {
            wrap.innerHTML = '<span style="color:var(--color-text-3); font-size:.8rem;">لا يوجد Keywords مستخرجة لهذه الحالة</span>';
            return;
        }
        wrap.innerHTML = keywords.map(k => `<span class="keyword-chip">${escapeHtml(k)}</span>`).join('');
    }

    function renderHistory(history) {
        const wrap = document.getElementById('aif-history-list');
        if (!history || history.length === 0) {
            wrap.innerHTML = '<div class="empty-state" style="padding:1rem 0;">لا يوجد سجل تعديلات بعد.</div>';
            return;
        }
        wrap.innerHTML = history.slice().reverse().map(h => `
            <div class="history-item">
                <div class="history-action">${escapeHtml(h.action)}</div>
                <div class="history-meta"><span class="history-actor">${escapeHtml(h.actor)}</span> · <span>${escapeHtml(formatFull(h.at))}</span></div>
            </div>
        `).join('');
    }

    function renderStatusOptions(caseId) {
        const wrap = document.getElementById('aif-status-options');
        wrap.innerHTML = STATUS_OPTIONS.map(s => `
            <button class="status-opt ${pendingStatus[caseId] === s.value ? 'active' : ''}" data-value="${s.value}">${s.label}</button>
        `).join('');
        wrap.querySelectorAll('.status-opt').forEach(btn => {
            btn.addEventListener('click', () => {
                pendingStatus[caseId] = btn.dataset.value;
                renderStatusOptions(caseId);
            });
        });
    }

    function openDetail(caseId) {
        const item = CASES.find(c => c.id === caseId);
        if (!item) return;
        selected = caseId;
        renderTable();

        const detail = document.getElementById('aif-detail');
        detail.classList.add('open');
        document.getElementById('aif-detail-title').textContent = `حالة ${item.id}`;
        document.getElementById('aif-detail-meta').textContent =
            `${languageLabel(item.language)} · ${reasonLabel(item.failureReason)} · أُنشئت ${formatRelative(item.createdAt)}`;

        document.getElementById('aif-customer-message').textContent = item.customerMessage || '—';
        document.getElementById('aif-ai-suggestion').textContent = item.aiSuggestion || 'لا يوجد اقتراح من الذكاء الاصطناعي لهذه الحالة.';
        document.getElementById('aif-admin-reply').value = item.adminReply || '';

        document.getElementById('aif-lang').textContent = languageLabel(item.language);
        document.getElementById('aif-expected-intent').textContent = item.expectedIntent || '—';
        document.getElementById('aif-confidence').textContent = (item.confidence === null || item.confidence === undefined) ? 'غير متاحة' : item.confidence.toFixed(3);
        document.getElementById('aif-failure-reason').textContent = reasonLabel(item.failureReason);
        document.getElementById('aif-scenario').textContent = item.scenarioIntent || 'unknown';
        document.getElementById('aif-created-at').textContent = formatFull(item.createdAt);
        document.getElementById('aif-updated-at').textContent = formatFull(item.updatedAt);

        renderKeywords(item.keywords);
        renderHistory(item.history);

        pendingStatus[caseId] = pendingStatus[caseId] || item.status;
        renderStatusOptions(caseId);
        document.getElementById('aif-saved-flag').classList.remove('show');

        detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function closeDetail() {
        selected = null;
        document.getElementById('aif-detail').classList.remove('open');
        renderTable();
    }

    function saveCase() {
        if (!selected) return;
        const item = CASES.find(c => c.id === selected);
        if (!item) return;

        const saveBtn = document.getElementById('aifSaveBtn');
        const newReply = document.getElementById('aif-admin-reply').value.trim() || null;
        const newStatus = pendingStatus[selected];
        const statusChanged = newStatus !== item.status;
        const replyChanged = newReply !== item.adminReply;

        saveBtn.disabled = true;
        saveBtn.textContent = 'جارِ الحفظ…';

        // TODO: هنا المفروض يكون فيه استدعاء حقيقي لحفظ الحالة والرد في
        // الـ backend (مثلاً supabase.from('chat_engine_ai_fallback_cases')
        // .update(...)) بدل التعديل المباشر على المصفوفة المحلية. الحفظ
        // هنا Mock بالكامل وبيتفقد عند تحديث الصفحة.
        setTimeout(() => {
            const now = new Date().toISOString();
            if (replyChanged) item.adminReply = newReply;
            if (statusChanged) item.status = newStatus;
            if (statusChanged || replyChanged) {
                item.updatedAt = now;
                const actor = currentUser?.profile?.full_name || currentUser?.email || 'المشرف الحالي';
                let actionText;
                if (statusChanged && replyChanged) actionText = `تم تحديث رد المشرف وتغيير الحالة إلى «${statusLabel(newStatus)}».`;
                else if (statusChanged) actionText = `تم تغيير الحالة إلى «${statusLabel(newStatus)}».`;
                else actionText = 'تم تحديث رد المشرف.';
                item.history = item.history || [];
                item.history.push({ at: now, actor, action: actionText });
            }

            renderTable();
            openDetail(item.id);

            const flag = document.getElementById('aif-saved-flag');
            flag.style.color = '';
            flag.textContent = (statusChanged || replyChanged) ? 'تم الحفظ محليًا (Mock)' : 'لا يوجد تغييرات لحفظها';
            flag.classList.add('show');
            setTimeout(() => flag.classList.remove('show'), 2500);

            saveBtn.disabled = false;
            saveBtn.textContent = 'حفظ (محليًا)';
        }, 300);
    }

    function refreshLastSync() {
        document.getElementById('aifLastSync').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
    }

    document.getElementById('aifCloseDetailBtn').addEventListener('click', closeDetail);
    document.getElementById('aifSaveBtn').addEventListener('click', saveCase);
    document.getElementById('aif-filter-status').addEventListener('change', e => { filters.status = e.target.value; renderTable(); });
    document.getElementById('aif-filter-language').addEventListener('change', e => { filters.language = e.target.value; renderTable(); });
    document.getElementById('aif-filter-reason').addEventListener('change', e => { filters.reason = e.target.value; renderTable(); });
    document.getElementById('aif-filter-search').addEventListener('input', e => { filters.search = e.target.value.trim().toLowerCase(); renderTable(); });
    document.getElementById('aifClearFiltersBtn').addEventListener('click', () => {
        filters.status = 'all'; filters.language = 'all'; filters.reason = 'all'; filters.search = '';
        document.getElementById('aif-filter-status').value = 'all';
        document.getElementById('aif-filter-language').value = 'all';
        document.getElementById('aif-filter-reason').value = 'all';
        document.getElementById('aif-filter-search').value = '';
        renderTable();
    });
    document.getElementById('aifRefreshBtn').addEventListener('click', () => {
        refreshLastSync();
        renderTable();
    });

    populateLanguageFilter();
    refreshLastSync();
    renderTable();
}
