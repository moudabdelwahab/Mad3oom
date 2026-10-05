import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-trigger-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const SYSTEM_FALLBACK_USER_ID = "fa9c0d85-be36-4930-b0da-f40d6741f48f"; // info@mad3oom.online (admin)

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

const SUPPORTED_CATEGORIES = new Set(["trigger", "condition", "action", "control"]);

function getVar(vars: Record<string, any>, key: string): any {
  if (key == null) return undefined;
  if (typeof key === 'string' && key.startsWith('{{') && key.endsWith('}}')) {
    key = key.slice(2, -2).trim();
  }
  if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
  const parts = key.split(".");
  let cur: any = vars;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function interpolate(input: any, vars: Record<string, any>): any {
  if (typeof input === "string") {
    const exactMatch = input.match(/^{{\s*([\w.]+)\s*}}$/);
    if (exactMatch) {
      const v = getVar(vars, exactMatch[1]);
      return v === undefined ? null : v;
    }
    return input.replace(/{{\s*([\w.]+)\s*}}/g, (whole, key) => {
      const v = getVar(vars, key);
      return v === undefined || v === null ? "" : String(v);
    });
  } else if (Array.isArray(input)) {
    return input.map(item => interpolate(item, vars));
  } else if (input !== null && typeof input === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = interpolate(v, vars);
    }
    return out;
  }
  return input;
}

function resolveConfig(config: Record<string, any>, vars: Record<string, any>): Record<string, any> {
  return interpolate(config, vars) || {};
}

const UNRESOLVED_VAR_RE = /{{\s*([\w.]+)\s*}}/;
function findUnresolvedVar(value: any): string | null {
  if (typeof value === "string") {
    const m = value.match(UNRESOLVED_VAR_RE);
    return m ? m[1] : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUnresolvedVar(item);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) {
      const found = findUnresolvedVar(v);
      if (found) return found;
    }
    return null;
  }
  return null;
}

const BRANCH_PORT_RESOLVERS: Record<string, (output: Record<string, any>) => string> = {
  "condition.if_else": (out) => (out["condition.result"] ? "true" : "false"),
  "condition.switch": (out) => String(out["switch.matched_case"] ?? "default"),
};

type Ctx = { vars: Record<string, any>; run: any; db: ReturnType<typeof admin>; userId: string; dryRun: boolean };

function dryRunResult(note: string, output: Record<string, any> = {}) {
  return { output, dry_run_note: note };
}

async function h_create_ticket(cfg: any, _raw: any, ctx: Ctx) {
  const title = (cfg.title ?? "").toString().trim();
  if (!title) throw new Error("create_ticket: title (عنوان التذكرة) مطلوب ولا يمكن أن يكون فارغًا");

  const insertPayload = {
    title,
    description: (cfg.description ?? "").toString(),
    priority: cfg.priority || "medium",
    category: cfg.category || null,
    user_id: cfg.customer_id || cfg.user_id || ctx.userId,
  };

  if (ctx.dryRun) {
    const mock = { id: null, ticket_number: null, ...insertPayload };
    const output: Record<string, any> = { ticket: mock, new_ticket: mock };
    for (const [key, value] of Object.entries(mock)) {
      output[`ticket.${key}`] = value;
      output[`new_ticket.${key}`] = value;
    }
    return dryRunResult(`[معاينة] كان سيتم إنشاء تذكرة بعنوان "${title}"`, output);
  }

  const { data, error } = await ctx.db
    .from("tickets")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) throw new Error(`فشل إنشاء التذكرة: ${error.message}`);

  const output: Record<string, any> = {
    ticket: data,
    new_ticket: data,
  };
  for (const [key, value] of Object.entries(data ?? {})) {
    output[`ticket.${key}`] = value;
    output[`new_ticket.${key}`] = value;
  }

  return { output };
}

async function h_update_ticket_status(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.ticket_id) throw new Error("update_ticket_status: ticket_id غير متوفر بعد الاستبدال");
  if (ctx.dryRun) return dryRunResult(`[معاينة] كان سيتم تحديث حالة التذكرة إلى "${cfg.new_status}"`);
  const { error } = await ctx.db.rpc("wf_update_ticket_status", {
    p_ticket_id: cfg.ticket_id,
    p_new_status: cfg.new_status,
    p_run_id: ctx.run.id,
  });
  if (error) throw new Error(`فشل تحديث حالة التذكرة: ${error.message}`);
  return { output: {} };
}

async function h_assign_ticket(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.ticket_id) throw new Error("assign_ticket: ticket_id غير متوفر بعد الاستبدال");
  if (ctx.dryRun) return dryRunResult("[معاينة] كان سيتم إسناد التذكرة للموظف المحدد");
  const { error } = await ctx.db.rpc("wf_assign_ticket", {
    p_ticket_id: cfg.ticket_id,
    p_assigned_to: cfg.assigned_to,
    p_run_id: ctx.run.id,
  });
  if (error) throw new Error(`فشل إسناد التذكرة: ${error.message}`);
  return { output: {} };
}

async function h_add_ticket_tag(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.ticket_id) throw new Error("add_ticket_tag: ticket_id غير متوفر بعد الاستبدال");
  const tagName = String(cfg.tag_name || "").trim();
  if (!tagName) throw new Error("add_ticket_tag: tag_name فارغ");
  if (ctx.dryRun) return dryRunResult(`[معاينة] كان سيتم إضافة وسم "${tagName}" للتذكرة`);
  let { data: tag } = await ctx.db.from("ticket_tags").select("id").eq("name", tagName).maybeSingle();
  if (!tag) {
    const { data: created, error: e1 } = await ctx.db.from("ticket_tags").insert({ name: tagName }).select("id").single();
    if (e1) throw new Error(`فشل إنشاء الوسم: ${e1.message}`);
    tag = created;
  }
  const { error } = await ctx.db.from("ticket_tag_links").upsert({ ticket_id: cfg.ticket_id, tag_id: tag.id }, { onConflict: "ticket_id,tag_id" });
  if (error) throw new Error(`فشل ربط الوسم بالتذكرة: ${error.message}`);
  return { output: {} };
}

async function h_log_ticket_activity(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.ticket_id) throw new Error("log_ticket_activity: ticket_id غير متوفر بعد الاستبدال");
  if (ctx.dryRun) return dryRunResult(`[معاينة] كان سيتم تسجيل نشاط: ${cfg.action_type || "note"}`);
  const { error } = await ctx.db.from("ticket_activity").insert({
    ticket_id: cfg.ticket_id, action_type: cfg.action_type || "note",
    meta: { note: cfg.note || null, source: "workflow_run", run_id: ctx.run.id },
  });
  if (error) throw new Error(`فشل تسجيل نشاط التذكرة: ${error.message}`);
  return { output: {} };
}

async function sendWhatsAppText(db: ReturnType<typeof admin>, to: string, text: string) {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  if (!token) throw new Error("WHATSAPP_TOKEN غير مُهيأ في متغيرات البيئة");
  const { data: integ, error } = await db.from("integrations").select("metadata").eq("provider", "whatsapp").limit(1).maybeSingle();
  if (error || !integ) throw new Error("لا يوجد رقم واتساب مرتبط بالمنصة");
  const pid = (integ.metadata as any)?.phone_number_id;
  if (!pid) throw new Error("تعذر تحديد phone_number_id لرقم واتساب المنصة");
  const res = await fetch(`https://graph.facebook.com/v25.0/${pid}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text } }),
  });
  const data = await res.json().catch(() => ({}));
  await db.from("messages").insert({
    from_number: pid, to_number: to, message_text: text, message_type: "text",
    direction: "outbound", status: res.ok ? "sent" : "failed", waba_id: pid, timestamp: new Date().toISOString(), raw_data: data,
  });
  if (!res.ok) throw new Error(`فشل إرسال واتساب: ${data?.error?.message || res.status}`);
  return data;
}

async function h_send_whatsapp(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.to) throw new Error("send_whatsapp: to غير متوفر بعد الاستبدال");
  if (ctx.dryRun) return dryRunResult(`[معاينة] كان سيتم إرسال واتساب إلى ${cfg.to}`, { "whatsapp.message_id": null });
  const data = await sendWhatsAppText(ctx.db, cfg.to, cfg.message || "");
  return { output: { "whatsapp.message_id": data?.messages?.[0]?.id || null } };
}

const ALLOWED_SENDERS = ["support@mad3oom.online", "no-reply@mad3oom.online", "info@mad3oom.online"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendEmailCustom(db: ReturnType<typeof admin>, opts: { from?: string; to: string; subject: string; body: string }) {
  if (!EMAIL_RE.test(opts.to || "")) {
    throw new Error(`صيغة البريد الإلكتروني للمستلم غير صحيحة: "${opts.to}"`);
  }
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) throw new Error("RESEND_API_KEY غير مُهيأ في متغيرات البيئة");
  const defaultFrom = Deno.env.get("EMAIL_FROM") || "info@mad3oom.online";
  let from = defaultFrom;
  if (opts.from) {
    if (!ALLOWED_SENDERS.includes(opts.from)) throw new Error("عنوان المرسل غير مسموح به");
    from = opts.from;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: opts.to, subject: opts.subject, html: opts.body }),
  });
  const result = await res.json().catch(() => ({}));
  await db.from("mailbox_emails").insert({
    direction: "outbound", from_email: from, to_email: opts.to, subject: opts.subject, html_body: opts.body,
    status: res.ok ? "sent" : "failed",
    provider_message_id: result?.id || null,
    error_message: res.ok ? null : JSON.stringify(result),
    is_read: res.ok || undefined,
  });
  if (!res.ok) throw new Error(`فشل إرسال البريد: ${JSON.stringify(result)}`);
  return result;
}

async function h_send_email(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.ticket_id) throw new Error("send_email: ticket_id غير متوفر بعد الاستبدال");
  const { data: ticket, error: e1 } = await ctx.db.from("tickets").select("user_id").eq("id", cfg.ticket_id).maybeSingle();
  if (e1 || !ticket) throw new Error("send_email: التذكرة غير موجودة");
  const { data: profile, error: e2 } = await ctx.db.from("profiles").select("email").eq("id", ticket.user_id).maybeSingle();
  if (e2 || !profile) throw new Error("send_email: بيانات صاحب التذكرة غير متاحة");
  if (!profile.email) throw new Error("send_email: لا يوجد بريد إلكتروني مسجَّل لصاحب هذه التذكرة");

  if (ctx.dryRun) return dryRunResult(`[معاينة] كان سيتم إرسال بريد إلى ${profile.email}`, { "email.id": null });

  const result = await sendEmailCustom(ctx.db, { from: cfg.from_email, to: profile.email, subject: cfg.subject || "", body: cfg.body || "" });
  return { output: { "email.id": result?.id || null } };
}

async function h_send_telegram(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.chat_id) throw new Error("send_telegram: chat_id غير متوفر بعد الاستبدال");
  const { data: bot, error } = await ctx.db.from("customer_telegram_bots").select("bot_token").eq("chat_id", String(cfg.chat_id)).maybeSingle();
  if (error || !bot?.bot_token) throw new Error("لا يوجد بوت تيليجرام مرتبط بهذا الـ chat_id");
  if (ctx.dryRun) return dryRunResult(`[معاينة] كان سيتم إرسال رسالة تيليجرام إلى ${cfg.chat_id}`);
  const res = await fetch(`https://api.telegram.org/bot${bot.bot_token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chat_id, text: cfg.message || "" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`فشل إرسال رسالة تيليجرام: ${data?.description || res.status}`);
  return { output: {} };
}

async function h_send_notification(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.user_id) throw new Error("send_notification: user_id غير متوفر بعد الاستبدال");
  if (ctx.dryRun) return dryRunResult("[معاينة] كان سيتم إرسال إشعار داخلي", { "notification.id": null });
  const { data, error } = await ctx.db.from("notifications").insert({
    user_id: cfg.user_id, title: cfg.title || "", message: cfg.message || "", type: "info", link: cfg.link || null,
  }).select("id").single();
  if (error) throw new Error(`فشل إرسال الإشعار: ${error.message}`);
  return { output: { "notification.id": data.id } };
}

async function h_create_lead(cfg: any, _raw: any, ctx: Ctx) {
  if (ctx.dryRun) return dryRunResult(`[معاينة] كان سيتم إنشاء Lead باسم "${cfg.name || ""}"`, { "lead.id": null });
  const { data, error } = await ctx.db.from("wf_leads").insert({
    name: cfg.name || null, phone: cfg.phone || null, source: cfg.source || "workflow",
    tags: Array.isArray(cfg.tags) ? cfg.tags : (cfg.tags ? [cfg.tags] : []),
    workflow_run_id: ctx.run.id,
  }).select("id").single();
  if (error) throw new Error(`فشل إنشاء Lead: ${error.message}`);
  return { output: { "lead.id": data.id } };
}

async function h_add_customer_note(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.customer_id) throw new Error("add_customer_note: customer_id غير متوفر بعد الاستبدال");
  if (ctx.dryRun) return dryRunResult("[معاينة] كان سيتم إضافة ملاحظة على ملف العميل");
  const { error } = await ctx.db.from("customer_notes").insert({ customer_id: cfg.customer_id, admin_id: null, note: cfg.note || "" });
  if (error) throw new Error(`فشل إضافة ملاحظة العميل: ${error.message}`);
  return { output: {} };
}

async function h_lookup_customer(cfg: any, _raw: any, ctx: Ctx) {
  const col = cfg.lookup_by === "phone" ? "phone" : cfg.lookup_by === "email" ? "email" : "id";
  const value = cfg.value;
  if (!value) throw new Error("lookup_customer: value غير متوفر بعد الاستبدال");
  const { data, error } = await ctx.db.from("profiles").select("id, full_name, email, phone").eq(col, value).maybeSingle();
  if (error) throw new Error(`فشل البحث عن العميل: ${error.message}`);
  return {
    output: {
      "customer.id": data?.id ?? null,
      "customer.full_name": data?.full_name ?? null,
      "customer.email": data?.email ?? null,
      "customer.phone": data?.phone ?? null,
    },
  };
}

async function h_send_satisfaction_survey(cfg: any, _raw: any, ctx: Ctx) {
  if (!cfg.ticket_id) throw new Error("send_satisfaction_survey: ticket_id غير متوفر بعد الاستبدال");
  const { data: ticket, error: e1 } = await ctx.db.from("tickets").select("user_id, ticket_number").eq("id", cfg.ticket_id).maybeSingle();
  if (e1 || !ticket) throw new Error("send_satisfaction_survey: التذكرة غير موجودة");
  const { data: profile, error: e2 } = await ctx.db.from("profiles").select("phone, email, full_name").eq("id", ticket.user_id).maybeSingle();
  if (e2 || !profile) throw new Error("send_satisfaction_survey: بيانات العميل غير متاحة");
  const surveyText = `مرحبًا ${profile.full_name || ""}، نرجو تقييم تجربتك مع تذكرتك رقم #${ticket.ticket_number} على منصة مدعوم.`;
  if (ctx.dryRun) {
    const channel = cfg.channel === "email" ? profile.email : profile.phone;
    if (!channel) throw new Error(`send_satisfaction_survey: لا يوجد ${cfg.channel === "email" ? "بريد إلكتروني" : "رقم واتساب"} لهذا العميل`);
    return dryRunResult(`[معاينة] كان سيتم إرسال استطلاع رضا إلى ${channel}`);
  }
  if (cfg.channel === "email") {
    if (!profile.email) throw new Error("send_satisfaction_survey: لا يوجد بريد إلكتروني لهذا العميل");
    await sendEmailCustom(ctx.db, { to: profile.email, subject: "قيّم تجربتك معنا", body: surveyText });
  } else {
    if (!profile.phone) throw new Error("send_satisfaction_survey: لا يوجد رقم واتساب لهذا العميل");
    await sendWhatsAppText(ctx.db, profile.phone, surveyText);
  }
  await ctx.db.from("ticket_activity").insert({
    ticket_id: cfg.ticket_id, action_type: "satisfaction_survey_sent",
    meta: { channel: cfg.channel || "whatsapp", source: "workflow_run", run_id: ctx.run.id },
  });
  return { output: {} };
}

function evalOperator(varValue: any, operator: string, cmpValue: any): boolean {
  const a = varValue; const b = cmpValue;
  switch (operator) {
    case "equals": return String(a ?? "") === String(b ?? "");
    case "not_equals": return String(a ?? "") !== String(b ?? "");
    case "contains": return String(a ?? "").includes(String(b ?? ""));
    case "greater_than": return Number(a) > Number(b);
    case "less_than": return Number(a) < Number(b);
    case "is_empty": return a === undefined || a === null || a === "";
    case "is_not_empty": return !(a === undefined || a === null || a === "");
    default: throw new Error(`عملية غير معروفة في IF/ELSE: ${operator}`);
  }
}

async function h_if_else(cfg: any, raw: any, ctx: Ctx) {
  const varValue = getVar(ctx.vars, raw.variable);
  const result = evalOperator(varValue, raw.operator, cfg.value);
  return { output: { "condition.result": result } };
}

async function h_switch(cfg: any, raw: any, ctx: Ctx) {
  const varValue = getVar(ctx.vars, raw.variable);
  const cases = cfg.cases || {};
  let matched = "default";
  for (const [caseKey, caseVal] of Object.entries(cases)) {
    if (String(varValue ?? "") === String(caseVal ?? caseKey)) { matched = caseKey; break; }
  }
  return { output: { "switch.matched_case": matched } };
}

const NODE_REGISTRY: Record<string, { category: string; run?: (cfg: any, raw: any, ctx: Ctx) => Promise<{ output: Record<string, any> }> }> = {
  "trigger.ticket_created": { category: "trigger" },
  "trigger.ticket_status_changed": { category: "trigger" },
  "trigger.ticket_closed": { category: "trigger" },
  "trigger.whatsapp_message_received": { category: "trigger" },
  "trigger.subscription_expiring": { category: "trigger" },
  "trigger.subscription_expired": { category: "trigger" },
  "trigger.webhook_inbound": { category: "trigger" },
  "trigger.schedule_cron": { category: "trigger" },

  "condition.if_else": { category: "condition", run: h_if_else },
  "condition.switch": { category: "condition", run: h_switch },

  "action.create_ticket": { category: "action", run: h_create_ticket },
  "action.update_ticket_status": { category: "action", run: h_update_ticket_status },
  "action.assign_ticket": { category: "action", run: h_assign_ticket },
  "action.add_ticket_tag": { category: "action", run: h_add_ticket_tag },
  "action.log_ticket_activity": { category: "action", run: h_log_ticket_activity },
  "action.send_satisfaction_survey": { category: "action", run: h_send_satisfaction_survey },
  "action.create_lead": { category: "action", run: h_create_lead },
  "action.add_customer_note": { category: "action", run: h_add_customer_note },
  "action.lookup_customer": { category: "action", run: h_lookup_customer },
  "action.send_whatsapp": { category: "action", run: h_send_whatsapp },
  "action.send_email": { category: "action", run: h_send_email },
  "action.send_telegram": { category: "action", run: h_send_telegram },
  "action.send_notification": { category: "action", run: h_send_notification },

  "control.stop": { category: "control" },

  "action.ai_generate_reply": { category: "ai" },
  "action.ai_classify": { category: "ai" },
  "action.api_request": { category: "api" },
  "action.call_webhook": { category: "api" },
  "action.mcp_tool_call": { category: "api" },
  "data.query_database": { category: "database" },
  "data.set_variable": { category: "database" },
  "delay.wait": { category: "delay" },
  "loop.for_each": { category: "loop" },
};

const MAX_STEPS = 100;

async function authorize(req: Request): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const internalSecret = req.headers.get("X-Internal-Trigger-Secret");
  if (internalSecret) {
    const db = admin();
    const { data: secretRow } = await db
      .from("internal_service_secrets")
      .select("value")
      .eq("key", "wf_executor_internal")
      .maybeSingle();
    if (secretRow?.value && secretRow.value === internalSecret) {
      return { ok: true, userId: SYSTEM_FALLBACK_USER_ID };
    }
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { ok: false, status: 401, error: "Missing Authorization header" };
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error } = await userClient.auth.getUser();
  if (error || !userData?.user) return { ok: false, status: 401, error: "Unauthorized" };
  const db = admin();
  const { data: profile } = await db.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!profile || !["admin", "support"].includes(profile.role)) {
    return { ok: false, status: 403, error: "هذه الميزة مقصورة على فريق الإدارة/الدعم" };
  }
  return { ok: true, userId: userData.user.id };
}

async function maybeSendRepeatedFailureAlert(db: ReturnType<typeof admin>, workflowId: string | null) {
  try {
    const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowId || "");
    if (!isValidUUID) return;
    const { data: recentRuns } = await db.from("wf_runs").select("status").eq("workflow_id", workflowId)
      .order("created_at", { ascending: false }).limit(3);
    if (!recentRuns || recentRuns.length < 3 || !recentRuns.every((r: any) => r.status === "failed")) return;

    const { data: wf } = await db.from("wf_workflows").select("name").eq("id", workflowId).maybeSingle();
    const { data: staff } = await db.from("profiles").select("id").in("role", ["admin", "support"]);
    if (!staff || !staff.length) return;

    const rows = staff.map((p: any) => ({
      user_id: p.id,
      title: "⚠️ فشل متكرر في Workflow",
      message: `الـ Workflow "${wf?.name || workflowId}" فشل 3 مرات متتالية. راجع سجل التشغيل لمعرفة السبب.`,
      type: "error",
      link: null,
    }));
    await db.from("notifications").insert(rows);
  } catch (_e) {
  }
}

async function executeRun(db: ReturnType<typeof admin>, workflowId: string | null, workflowVersionId: string | null, workflowVersionNumber: number | null, definition: any, triggerPayload: Record<string, any>, userId: string, dryRun: boolean) {
  const nodes: any[] = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const edges: any[] = Array.isArray(definition?.edges) ? definition.edges : [];

  const triggerNode = nodes.find((n) => (n.type || "").startsWith("trigger."));
  if (!triggerNode) throw new Error("لا يوجد مشغّل (Trigger) في هذا الـ Workflow — لا يمكن تشغيله");

  const triggerEventKey = triggerNode.type.replace(/^trigger./, "");
  const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowId || "");

  if (!dryRun && !isValidUUID) {
    throw new Error("workflow_id مفقود أو غير صالح — يجب حفظ الـ Workflow أولًا قبل تشغيله حتى يكون له معرّف حقيقي مسجّل في wf_workflows");
  }

  if (!dryRun && isValidUUID) {
    const { data: wf } = await db.from("wf_workflows").select("max_runs_per_hour").eq("id", workflowId).maybeSingle();
    if (wf?.max_runs_per_hour) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await db.from("wf_runs").select("id", { count: "exact", head: true })
        .eq("workflow_id", workflowId).gte("created_at", oneHourAgo);
      if ((count || 0) >= wf.max_runs_per_hour) {
        throw new Error(`تم الوصول للحد الأقصى لعدد التشغيلات المسموح بها خلال ساعة (${wf.max_runs_per_hour}) لهذا الـ Workflow. حاول لاحقًا أو عدّل الحد من إعدادات الـ Workflow.`);
      }
    }
  }

  let run: any;
  if (dryRun) {
    run = { id: `dry-${crypto.randomUUID()}` };
  } else {
    const { data, error: runErr } = await db.from("wf_runs").insert({
      workflow_id: workflowId,
      workflow_version_id: workflowVersionId,
      workflow_version_number: workflowVersionNumber,
      trigger_event_key: triggerEventKey,
      trigger_payload: triggerPayload || {},
      status: "running",
      context: {},
      current_node_id: triggerNode.id,
      correlation_id: crypto.randomUUID(),
    }).select().single();
    if (runErr) throw new Error(`تعذّر إنشاء سجل التشغيل (wf_runs): ${runErr.message}`);
    run = data;
  }

  const ctx: Ctx = { vars: { ...(triggerPayload || {}) }, run, db, userId, dryRun };
  const steps: any[] = [];

  async function fail(message: string, nodeId: string | null) {
    if (!dryRun) {
      await db.from("wf_runs").update({
        status: "failed", error: message, finished_at: new Date().toISOString(),
        current_node_id: nodeId, context: { vars: ctx.vars },
      }).eq("id", run.id);
      await maybeSendRepeatedFailureAlert(db, workflowId);
    }
    return { run_id: run.id, status: "failed", error: message, steps, dry_run: dryRun };
  }

  const visited = new Set<string>();
  let queue: string[] = edges.filter((e) => e.source === triggerNode.id).map((e) => e.target);
  let iterations = 0;

  while (queue.length) {
    iterations++;
    if (iterations > MAX_STEPS) {
      return await fail(`تجاوز التنفيذ الحد الأقصى لعدد الخطوات (${MAX_STEPS}) — على الأرجح يوجد مسار دائري (loop) في المخطط`, null);
    }
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) continue;

    const entry = NODE_REGISTRY[node.type];
    const nodeLabel = node.type;

    if (!entry) {
      return await fail(`نوع عنصر غير معروف في محرك التنفيذ: "${nodeLabel}"`, nodeId);
    }
    if (!SUPPORTED_CATEGORIES.has(entry.category)) {
      const msg = `عقدة "${nodeLabel}" من فئة (${entry.category}) غير مدعومة في هذا الإصدار من محرك التنفيذ (Executor P0). الفئات المدعومة حاليًا: Trigger / Condition / Action / Control (stop) فقط. لن يتم تنفيذها أو محاكاتها.`;
      if (!dryRun) {
        await db.from("wf_run_steps").insert({
          run_id: run.id, node_id: nodeId, node_key: nodeLabel, status: "failed",
          input: node.config || {}, output: {}, error: msg, finished_at: new Date().toISOString(), attempt: 1, max_attempts: 1,
        });
      }
      return await fail(msg, nodeId);
    }
    if (entry.category === "trigger") {
      queue.push(...edges.filter((e) => e.source === nodeId).map((e) => e.target));
      continue;
    }
    if (entry.category === "control") {
      if (!dryRun) {
        await db.from("wf_run_steps").insert({
          run_id: run.id, node_id: nodeId, node_key: nodeLabel, status: "success",
          input: {}, output: {}, started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
          duration_ms: 0, attempt: 1, max_attempts: 1,
        });
      }
      steps.push({ node_id: nodeId, node_key: nodeLabel, status: "success", output: {} });
      continue;
    }

    const rawConfig = node.config || {};
    const resolvedConfig = resolveConfig(rawConfig, ctx.vars);

    const unresolved = findUnresolvedVar(resolvedConfig);
    if (unresolved) {
      const msg = `فشلت خطوة "${nodeLabel}": المتغير {{${unresolved}}} غير معرّف عند تنفيذ هذه الخطوة — تأكد إن في خطوة سابقة في نفس المسار تنتج هذا المتغير قبل استخدامه هنا`;
      if (!dryRun) {
        await db.from("wf_run_steps").insert({
          run_id: run.id, node_id: nodeId, node_key: nodeLabel, status: "failed",
          input: resolvedConfig, output: {}, error: msg, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), attempt: 1, max_attempts: 1,
        });
      }
      return await fail(msg, nodeId);
    }

    const startedAt = new Date().toISOString();
    let stepRow: any = null;
    if (!dryRun) {
      const { data } = await db.from("wf_run_steps").insert({
        run_id: run.id, node_id: nodeId, node_key: nodeLabel, status: "running",
        input: resolvedConfig, started_at: startedAt, attempt: 1, max_attempts: 1,
      }).select().single();
      stepRow = data;
    }

    try {
      const t0 = Date.now();
      const result = await entry.run!(resolvedConfig, rawConfig, ctx);
      const durationMs = Date.now() - t0;

      Object.assign(ctx.vars, result.output || {});

      if (!dryRun && stepRow) {
        await db.from("wf_run_steps").update({
          status: "success", output: result.output || {}, finished_at: new Date().toISOString(), duration_ms: durationMs,
        }).eq("id", stepRow.id);
      }
      steps.push({ node_id: nodeId, node_key: nodeLabel, status: "success", output: result.output || {}, dry_run_note: (result as any).dry_run_note });

      const branchResolver = BRANCH_PORT_RESOLVERS[node.type];
      const outgoingEdges = edges.filter((e) => e.source === nodeId);
      const edgesToFollow = branchResolver
        ? outgoingEdges.filter((e) => (e.source_port || "default") === branchResolver(result.output || {}))
        : outgoingEdges;
      queue.push(...edgesToFollow.map((e) => e.target));
      continue;
    } catch (err) {
      const message = (err as Error).message || String(err);
      if (!dryRun && stepRow) {
        await db.from("wf_run_steps").update({
          status: "failed", error: message, finished_at: new Date().toISOString(),
        }).eq("id", stepRow.id);
      }
      steps.push({ node_id: nodeId, node_key: nodeLabel, status: "failed", error: message });
      return await fail(`فشلت خطوة "${nodeLabel}": ${message}`, nodeId);
    }
  }

  if (!dryRun) {
    await db.from("wf_runs").update({
      status: "completed", finished_at: new Date().toISOString(), current_node_id: null, context: { vars: ctx.vars },
    }).eq("id", run.id);
  }

  return { run_id: run.id, status: "completed", steps, dry_run: dryRun };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Only POST is supported" }, 405);

  const auth = await authorize(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const { workflow_id, workflow_version_id, workflow_version_number, definition, trigger_payload, dry_run } = body || {};
  if (!definition || !Array.isArray(definition.nodes)) return json({ error: "definition.nodes مطلوب" }, 400);

  const db = admin();
  try {
    const result = await executeRun(
      db, workflow_id || null, workflow_version_id || null, workflow_version_number ?? null,
      definition, trigger_payload || {}, auth.userId, !!dry_run
    );
    return json(result, result.status === "completed" ? 200 : 422);
  } catch (err) {
    console.error("wf-executor error:", err);
    return json({ error: (err as Error).message || "حدث خطأ غير متوقع" }, 500);
  }
});
