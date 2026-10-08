// ============================================================================
// conversation-turn / core.ts — منطق الـ Orchestrator (المرحلة 3)
//
// المرجع: docs/CONVERSATION_CORE_GATE_AR.md §6 (العقد مع SIE) و §8 (الانتقال).
//
//   رسالة العميل ⇒ conv_ingest_message ⇒ [owner=agent؟] ⇒ SIE.decide (قراءة بس)
//     ⇒ conv_commit_turn(expected_version, turn_key) ⇒ استهلاك SIE + أثر التشخيص
//
// الملف ده من غير أي import عن قصد: كل اللي بيلمس الشبكة أو القاعدة بييجي
// من deps (index.ts بيوصّلهم بـ supabase-js والـ HTTP). كده الاختبارات بتشغّل
// المنطق نفسه تحت Node من غير Deno ومن غير قاعدة (tests/conversation-turn.test.mjs).
//
// القواعد اللي هنا مش اختيارية:
//   • العلم مقفول ⇒ 409 قبل أي كتابة. المتصل يكمّل في المسار القديم.
//   • SIE مش متاح للحساب ⇒ 403 قبل أي كتابة (نفس سبب sie_my_entitlement).
//   • decide مابيكتبش حاجة. الكتابة كلها في conv_commit_turn، مرة واحدة.
//   • الـ Decision بيتفحص بالكامل قبل الاستعمال. أي شكل غلط أو مهلة أو فشل
//     ⇒ رد ثابت من الخادم (agent_id = 'system')، من غير تذكرة ولا حالة.
//   • version_conflict ⇒ decide تاني على الحالة الأحدث، بحد أقصى مرتين.
//   • استهلاك رصيد SIE بعد committed=true بس، ولرد SIE بس (مش الرد الثابت).
//   • trace / intent / confidence في chat_engine_trace_events بس، مش في
//     metadata الرسالة (العميل بيقراها عبر RLS/Realtime).
// ============================================================================

export const CONTRACT_VERSION = '1';
export const CHANNEL = 'website';
export const DECIDE_TIMEOUT_MS = 8000;
export const MAX_DECIDE_RETRIES = 2;
export const HISTORY_LIMIT = 20;
export const MAX_TEXT = 4000;

export const SYSTEM_FALLBACK_TEXT =
  'رسالتك وصلت، بس محرك الدعم الذكي مش متاح دلوقتي. جرّب تاني بعد شوية، أو اكتب «موظف» لو محتاج حد من فريق الدعم.';
export const HANDOFF_DEFAULT_TEXT = 'حوّلنا المحادثة لفريق الدعم، وهيردوا عليك هنا في أقرب وقت.';

const OUTCOMES = ['reply', 'clarify', 'handoff', 'noop'] as const;
type Outcome = typeof OUTCOMES[number];

export interface DecisionOption { label: string; value: string }
export interface DecisionTicket {
  category?: string; description: string; title?: string;
  type?: 'problem' | 'inquiry'; priority?: 'low' | 'medium' | 'high'; confirmation?: string;
}
export interface Decision {
  contractVersion: string;
  decisionId: string;
  outcome: Outcome;
  reply: { text: string; parts: unknown[]; options: DecisionOption[] } | null;
  intent: Record<string, unknown> | null;
  state: Record<string, unknown> | null;
  ticket: DecisionTicket | null;
  handoff: { reason: string } | null;
  confidence: number | null;
  trace: { engineVersion: string; [k: string]: unknown } | null;
}

// ── فحص الـ Decision (العقد v1) ─────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, required = true): string | null | undefined => {
  if (v === undefined || v === null) return required ? undefined : null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (required && t === '') return undefined;
  if (t.length > max) return undefined;
  return t;
};

export function parseDecision(raw: unknown):
  { ok: true; decision: Decision } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['decision is not an object'] };

  if (raw.contractVersion !== CONTRACT_VERSION) errors.push(`contractVersion must be "${CONTRACT_VERSION}"`);
  const decisionId = str(raw.decisionId, 200);
  if (decisionId === undefined) errors.push('decisionId is required');
  const outcome = raw.outcome as Outcome;
  if (!OUTCOMES.includes(outcome)) errors.push(`outcome must be one of ${OUTCOMES.join('|')}`);

  let reply: Decision['reply'] = null;
  if (raw.reply !== undefined && raw.reply !== null) {
    if (!isObj(raw.reply)) errors.push('reply must be an object');
    else {
      const text = str(raw.reply.text, MAX_TEXT);
      if (text === undefined) errors.push(`reply.text must be a non-empty string ≤ ${MAX_TEXT}`);
      const parts = raw.reply.parts ?? [];
      if (!Array.isArray(parts) || parts.length > 20 || !parts.every(isObj)) {
        errors.push('reply.parts must be an array of ≤ 20 objects');
      }
      const options = raw.reply.options ?? [];
      const okOptions = Array.isArray(options) && options.length <= 12 && options.every((o) =>
        isObj(o) && str(o.label, 200) !== undefined && str(o.value, 200) !== undefined);
      if (!okOptions) errors.push('reply.options must be ≤ 12 {label, value} non-empty strings');
      if (text !== undefined && Array.isArray(parts) && okOptions) {
        reply = {
          text: text as string,
          parts: parts as unknown[],
          options: (options as Record<string, string>[]).map((o) => ({ label: o.label.trim(), value: o.value.trim() })),
        };
      }
    }
  }
  if ((outcome === 'reply' || outcome === 'clarify') && raw.reply == null) errors.push(`outcome ${outcome} needs reply`);
  if (outcome === 'clarify' && reply && reply.options.length < 2) errors.push('clarify needs ≥ 2 options');

  let state: Decision['state'] = null;
  if (raw.state !== undefined && raw.state !== null) {
    if (!isObj(raw.state)) errors.push('state must be an object or null');
    else state = raw.state;
  }

  let ticket: DecisionTicket | null = null;
  if (raw.ticket !== undefined && raw.ticket !== null) {
    const t = raw.ticket;
    if (!isObj(t)) errors.push('ticket must be an object or null');
    else {
      const description = str(t.description, MAX_TEXT);
      const category = str(t.category, 100, false);
      const title = str(t.title, 200, false);
      const confirmation = str(t.confirmation, 500, false);
      const type = t.type ?? null;
      const priority = t.priority ?? null;
      if (description === undefined) errors.push('ticket.description is required');
      if (category === undefined || title === undefined || confirmation === undefined) {
        errors.push('ticket.category/title/confirmation must be strings within limits');
      }
      if (type !== null && type !== 'problem' && type !== 'inquiry') errors.push('ticket.type must be problem|inquiry');
      if (priority !== null && !['low', 'medium', 'high'].includes(priority as string)) {
        errors.push('ticket.priority must be low|medium|high');
      }
      ticket = {
        description: description as string,
        ...(category ? { category } : {}), ...(title ? { title } : {}),
        ...(confirmation ? { confirmation } : {}),
        ...(type ? { type: type as DecisionTicket['type'] } : {}),
        ...(priority ? { priority: priority as DecisionTicket['priority'] } : {}),
      };
    }
  }

  let handoff: Decision['handoff'] = null;
  if (raw.handoff !== undefined && raw.handoff !== null) {
    const reason = isObj(raw.handoff) ? str(raw.handoff.reason, 200) : undefined;
    if (reason === undefined) errors.push('handoff.reason must be a non-empty string ≤ 200');
    else handoff = { reason: reason as string };
  }
  if (outcome === 'handoff' && !handoff) errors.push('outcome handoff needs handoff.reason');

  let confidence: number | null = null;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) {
      errors.push('confidence must be a number in [0, 1]');
    } else confidence = raw.confidence;
  }

  let trace: Decision['trace'] = null;
  if (raw.trace !== undefined && raw.trace !== null) {
    const ev = isObj(raw.trace) ? str(raw.trace.engineVersion, 100) : undefined;
    if (ev === undefined) errors.push('trace.engineVersion must be a non-empty string');
    else trace = { ...(raw.trace as Record<string, unknown>), engineVersion: ev as string };
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    decision: {
      contractVersion: CONTRACT_VERSION, decisionId: decisionId as string, outcome, reply,
      intent: isObj(raw.intent) ? raw.intent : null, state, ticket, handoff, confidence, trace,
    },
  };
}

// ── DecideRequest ───────────────────────────────────────────────────────────
export interface MessageRow {
  id: string; seq: number | null; sender_id: string | null; message_text: string | null;
  is_bot_reply: boolean | null; is_admin_reply: boolean | null;
  attachment: Record<string, unknown> | null; created_at: string;
}

/** الأدوار من الصف نفسه. ترتيب الرسائل القديمة (seq NULL) قبل أي رسالة ليها seq. */
export function toDecideMessages(rows: MessageRow[], userId: string) {
  const sorted = [...rows].sort((a, b) => {
    if (a.seq === null && b.seq !== null) return -1;
    if (a.seq !== null && b.seq === null) return 1;
    if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq - b.seq;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
  return sorted.slice(-HISTORY_LIMIT).map((m) => {
    const role = m.is_admin_reply ? 'human' : m.is_bot_reply ? 'agent'
      : m.sender_id === userId ? 'customer' : 'system';
    const a = isObj(m.attachment) ? m.attachment : null;
    return {
      id: m.id, seq: m.seq, role, text: m.message_text ?? '',
      // المسار في التخزين مابيطلعش لـ SIE: النوع والاسم كفاية للفهم.
      attachment: a ? { kind: a.kind ?? null, mime: a.mime ?? null, name: a.name ?? null } : null,
      at: m.created_at,
    };
  });
}

export function buildDecideRequest(p: {
  conversation: { id: string; stateVersion: number };
  userId: string; locale?: string;
  rows: MessageRow[]; state: Record<string, unknown> | null;
  ticketQuota: unknown; entitlement: Record<string, unknown> | null; turnKey: string;
}) {
  const q = isObj(p.ticketQuota) ? p.ticketQuota : {};
  return {
    contractVersion: CONTRACT_VERSION,
    conversation: { id: p.conversation.id, channel: CHANNEL, stateVersion: p.conversation.stateVersion, owner: 'agent' },
    customer: { userId: p.userId, locale: p.locale ?? 'ar-EG' },
    messages: toDecideMessages(p.rows, p.userId),
    state: p.state ?? {},
    facts: {
      ticketQuota: {
        remaining: typeof q.remaining === 'number' ? q.remaining : null,
        unlimited: q.unlimited === true,
      },
      entitlement: {
        hasAccess: p.entitlement?.has_access === true,
        edition: (p.entitlement?.edition as string) ?? null,
      },
    },
    turnKey: p.turnKey,
  };
}

// ── Decision ⇒ conv_commit_turn ─────────────────────────────────────────────
export function agentIdOf(d: Decision): string {
  const ev = d.trace?.engineVersion ?? 'unknown';
  return ev.startsWith('sie@') ? ev : `sie@${ev}`;
}

export function decisionToCommit(d: Decision, ctx: { conversationId: string; stateVersion: number; turnKey: string }) {
  const options = d.reply?.options ?? [];
  const parts = [...(d.reply?.parts ?? [])];
  if (options.length) parts.push({ type: 'options', options });
  const handoffReason = d.outcome === 'handoff' ? d.handoff!.reason : null;
  return {
    p_conversation_id: ctx.conversationId,
    p_expected_version: ctx.stateVersion,
    p_turn_key: ctx.turnKey,
    p_reply_text: d.reply?.text ?? HANDOFF_DEFAULT_TEXT,
    p_reply_parts: parts,
    p_state: d.state,
    p_agent_id: agentIdOf(d),
    p_delivery_required: false, // الموقع: Realtime من الصف نفسه
    p_ticket: d.ticket,
    p_handoff_reason: handoffReason,
  };
}

export function fallbackCommit(ctx: { conversationId: string; stateVersion: number; turnKey: string }) {
  return {
    p_conversation_id: ctx.conversationId, p_expected_version: ctx.stateVersion, p_turn_key: ctx.turnKey,
    p_reply_text: SYSTEM_FALLBACK_TEXT, p_reply_parts: [], p_state: null, p_agent_id: 'system',
    p_delivery_required: false, p_ticket: null, p_handoff_reason: null,
  };
}

// ── الـ Orchestrator ────────────────────────────────────────────────────────
export interface DbError extends Error { code?: string; hint?: string }

export interface Deps {
  channelEnabled(userId: string): Promise<boolean>;
  /** sie_my_entitlement() بتوكن العميل نفسه. */
  sieEntitlement(): Promise<Record<string, unknown> | null>;
  ingest(args: Record<string, unknown>): Promise<Record<string, any>>;
  loadConversation(id: string): Promise<{ id: string; stateVersion: number; owner: 'agent' | 'human';
    status: string; state: Record<string, unknown> | null } | null>;
  loadMessages(conversationId: string, limit: number): Promise<MessageRow[]>;
  findReply(conversationId: string, turnKey: string): Promise<{ id: string; text: string;
    metadata: Record<string, unknown> | null } | null>;
  ticketQuota(userId: string): Promise<unknown>;
  decide(request: unknown, timeoutMs: number): Promise<unknown>;
  commit(args: Record<string, unknown>): Promise<Record<string, any>>;
  consume(userId: string): Promise<unknown>;
  trace(row: Record<string, unknown>): Promise<void>;
  log(event: string, data?: Record<string, unknown>): void;
  now(): number;
}

export interface TurnInput {
  userId: string;
  message: unknown;
  clientMessageId: unknown;
  attachment?: unknown;
}

export interface TurnResult { status: number; body: Record<string, unknown> }

const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;

function replyBody(conversationId: string, r: { id: string; text: string; metadata: Record<string, unknown> | null },
  extra: Record<string, unknown>) {
  const md = r.metadata ?? {};
  const parts = Array.isArray(md.parts) ? md.parts : [];
  const opt = parts.find((p: any) => isObj(p) && p.type === 'options') as any;
  const ticketNumber = typeof md.ticketNumber === 'number' ? md.ticketNumber : null;
  return {
    reply: r.text,
    options: Array.isArray(opt?.options) ? opt.options : [],
    ticketCreated: ticketNumber !== null,
    ticketNumber,
    ticketError: typeof md.ticketError === 'string' ? md.ticketError : null,
    skipped: false,
    conversationId,
    messageId: r.id,
    ...extra,
  };
}

export async function runTurn(deps: Deps, input: TurnInput): Promise<TurnResult> {
  const text = typeof input.message === 'string' ? input.message.trim() : '';
  const clientId = typeof input.clientMessageId === 'string' ? input.clientMessageId.trim() : '';
  if (!CLIENT_ID.test(clientId)) return { status: 400, body: { error: 'clientMessageId مطلوب (8–128 حرف/رقم)' } };
  if (text.length > MAX_TEXT) return { status: 400, body: { error: `الرسالة أطول من ${MAX_TEXT} حرف` } };
  if (text === '' && input.attachment == null) return { status: 400, body: { error: 'الرسالة فاضية' } };
  if (input.attachment != null && !isObj(input.attachment)) return { status: 400, body: { error: 'المرفق لازم يكون كائن' } };

  // 1) العلم ثم استحقاق SIE — الاتنين قبل أي كتابة.
  if (!(await deps.channelEnabled(input.userId))) {
    return { status: 409, body: { error: 'core_disabled' } };
  }
  const entitlement = await deps.sieEntitlement();
  if (entitlement?.has_access !== true) {
    return { status: 403, body: { error: 'sie_unavailable', reason: (entitlement?.reason as string) ?? 'unknown' } };
  }

  // 2) الرسالة الواردة.
  let ingested: Record<string, any>;
  try {
    ingested = await deps.ingest({
      p_channel: CHANNEL, p_user_id: input.userId, p_external_thread_id: '',
      p_external_id: `web:${clientId}`, p_text: text, p_parts: [], p_metadata: { source: 'web' },
      p_channel_identity_id: null, p_idle_after: null, p_attachment: input.attachment ?? null,
    });
  } catch (e) {
    const err = e as DbError;
    if (err.code === '42501') return { status: 403, body: { error: 'account_inactive' } };
    if (err.code === '22023') return { status: 400, body: { error: err.message } };
    throw e;
  }
  const conversationId: string = ingested.conversation.id;
  const turnKey: string = ingested.message.id;

  // نفس الرسالة اتبعتت قبل كده وليها رد ⇒ نفس الرد، من غير decide.
  if (ingested.duplicate) {
    const prev = await deps.findReply(conversationId, turnKey);
    if (prev) return { status: 200, body: replyBody(conversationId, prev, { duplicate: true }) };
  }
  if (ingested.owner === 'human') {
    return { status: 200, body: { skipped: true, reason: 'human_owner', conversationId } };
  }

  const ticketQuota = await deps.ticketQuota(input.userId).catch((e) => {
    deps.log('ticket_quota_failed', { error: String(e) });
    return null;
  });

  // 3) decide ⇒ commit، ومع version_conflict نعيد على الحالة الأحدث.
  for (let attempt = 0; attempt <= MAX_DECIDE_RETRIES; attempt++) {
    const conv = await deps.loadConversation(conversationId);
    if (!conv) throw new Error('conversation vanished after ingest');
    if (conv.status === 'closed') return { status: 200, body: { skipped: true, reason: 'closed', conversationId } };
    if (conv.owner === 'human') return { status: 200, body: { skipped: true, reason: 'human_owner', conversationId } };

    const rows = await deps.loadMessages(conversationId, HISTORY_LIMIT);
    const request = buildDecideRequest({
      conversation: { id: conv.id, stateVersion: conv.stateVersion }, userId: input.userId,
      rows, state: conv.state, ticketQuota, entitlement, turnKey,
    });

    const started = deps.now();
    let decision: Decision | null = null;
    let failure: string | null = null;
    try {
      const parsed = parseDecision(await deps.decide(request, DECIDE_TIMEOUT_MS));
      if (parsed.ok) decision = parsed.decision;
      else failure = `invalid_decision: ${parsed.errors.join('; ')}`;
    } catch (e) {
      failure = `decide_failed: ${(e as Error)?.message ?? String(e)}`;
    }
    const latencyMs = deps.now() - started;
    if (failure) deps.log('decide_fallback', { conversationId, turnKey, failure });

    if (decision?.outcome === 'noop') {
      await deps.trace({ session_id: conversationId, turn: 0, processing_time_ms: latencyMs,
        decision: traceOf(decision, null) }).catch((e) => deps.log('trace_failed', { error: String(e) }));
      return { status: 200, body: { skipped: true, reason: 'noop', conversationId } };
    }

    const ctx = { conversationId, stateVersion: conv.stateVersion, turnKey };
    const committed = await deps.commit(decision ? decisionToCommit(decision, ctx) : fallbackCommit(ctx));

    if (!committed.committed) {
      if (committed.reason === 'version_conflict' && attempt < MAX_DECIDE_RETRIES) continue;
      return { status: 200, body: { skipped: true, reason: committed.reason, conversationId } };
    }

    if (!committed.duplicate) {
      if (decision) {
        // الرصيد بعد الكتابة بس. فشل الاستهلاك مايلغيش رد اتكتب. الرفض هنا
        // معناه إن الرصيد خلص بين الفحص والكتابة (رسالتين في نفس اللحظة).
        const used = await deps.consume(input.userId)
          .catch((e) => { deps.log('consume_failed', { error: String(e) }); return null; });
        const row = Array.isArray(used) ? used[0] : null;
        if (isObj(row) && row.allowed === false) deps.log('consume_denied', { conversationId, reason: row.reason as string });
      }
      await deps.trace({
        session_id: conversationId, turn: committed.seq ?? 0, processing_time_ms: latencyMs,
        decision: traceOf(decision, failure),
      }).catch((e) => deps.log('trace_failed', { error: String(e) }));
    }

    const stored = await deps.findReply(conversationId, turnKey);
    if (!stored) throw new Error('committed reply not found');
    return {
      status: 200,
      body: replyBody(conversationId, stored, {
        duplicate: committed.duplicate === true,
        handoff: committed.handoff === true,
        stateVersion: committed.stateVersion ?? null,
        agent: decision ? 'sie' : 'system',
      }),
    };
  }
  return { status: 200, body: { skipped: true, reason: 'version_conflict', conversationId } };
}

function traceOf(d: Decision | null, failure: string | null) {
  if (!d) return { contractVersion: CONTRACT_VERSION, outcome: 'fallback', failure };
  return {
    contractVersion: d.contractVersion, decisionId: d.decisionId, outcome: d.outcome,
    intent: d.intent, confidence: d.confidence, trace: d.trace,
  };
}
