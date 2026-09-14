import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Actor } from "./actor.ts";
import { canAccessTicket, getVisibleUserIds } from "./authz.ts";

export class ForbiddenError extends Error { constructor(m?: string) { super(m); this.name = "ForbiddenError"; } }
export class NotFoundError extends Error { constructor(m?: string) { super(m); this.name = "NotFoundError"; } }

function db() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export async function listTickets(actor: Actor, filters: { status?: string; limit?: number; offset?: number } = {}) {
  const supabase = db();
  const visibility = await getVisibleUserIds(actor);
  let q = supabase.from("tickets").select("*").order("created_at", { ascending: false });
  if (!visibility.all) q = q.in("user_id", visibility.ids);
  if (filters.status) q = q.eq("status", filters.status);
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  q = q.range(offset, offset + limit - 1);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function fetchTicketWithOwner(ticketId: string) {
  const supabase = db();
  const { data: ticket, error } = await supabase.from("tickets").select("*").eq("id", ticketId).maybeSingle();
  if (error) throw error;
  if (!ticket) return null;
  const { data: owner } = await supabase.from("profiles").select("super_user_id").eq("id", (ticket as any).user_id).maybeSingle();
  return { ticket, ownerSuperUserId: owner?.super_user_id ?? null };
}

export async function getTicket(actor: Actor, ticketId: string) {
  const found = await fetchTicketWithOwner(ticketId);
  if (!found) throw new NotFoundError("Ticket not found");
  if (!canAccessTicket(actor, (found.ticket as any).user_id, found.ownerSuperUserId)) throw new ForbiddenError("Access denied");
  return found.ticket;
}

export async function createTicket(actor: Actor, payload: {
  title: string; description: string; priority?: string; category?: string; ticket_type?: string; contact_info?: string;
}) {
  if (!payload?.title?.trim()) throw new Error("العنوان مطلوب");
  if (!payload?.description?.trim()) throw new Error("الوصف مطلوب");

  const supabase = db();
  const { data, error } = await supabase.from("tickets").insert({
    user_id: actor.id,
    title: payload.title.trim(),
    description: payload.description.trim(),
    priority: payload.priority || "medium",
    category: payload.category || null,
    ticket_type: payload.ticket_type || "problem",
    contact_info: payload.contact_info || null,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function updateTicket(actor: Actor, ticketId: string, payload: Record<string, unknown>) {
  const found = await fetchTicketWithOwner(ticketId);
  if (!found) throw new NotFoundError("Ticket not found");

  const supabase = db();
  const elevated = actor.isMainAdmin || actor.isAdmin;

  if (elevated) {
    const { data, error } = await supabase.rpc("mcp_admin_update_ticket", {
      p_ticket_id: ticketId, p_actor_id: actor.id, p_updates: payload,
    });
    if (error) {
      if ((error as any).code === "P0002") throw new NotFoundError("Ticket not found");
      if ((error as any).code === "42501") throw new ForbiddenError((error as any).message);
      throw error;
    }
    return data;
  }

  if ((found.ticket as any).user_id !== actor.id) throw new ForbiddenError("Access denied");
  const allowedKeys = new Set(["archived_by_customer"]);
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(payload || {})) if (allowedKeys.has(k)) filtered[k] = (payload as any)[k];
  if (!Object.keys(filtered).length) throw new ForbiddenError("غير مسموح لك بتعديل هذه الحقول - العملاء العاديون يقدروا بس يؤرشفوا تذكرتهم");

  const { data, error } = await supabase.from("tickets").update(filtered).eq("id", ticketId).eq("user_id", actor.id).select().single();
  if (error) throw error;
  return data;
}

export async function closeTicket(actor: Actor, ticketId: string) {
  if (!(actor.isMainAdmin || actor.isAdmin)) throw new ForbiddenError("إغلاق التذاكر متاح للأدمن فقط حاليًا");
  const supabase = db();
  const { data, error } = await supabase.rpc("mcp_admin_update_ticket", {
    p_ticket_id: ticketId, p_actor_id: actor.id, p_updates: { status: "closed" },
  });
  if (error) {
    if ((error as any).code === "P0002") throw new NotFoundError("Ticket not found");
    if ((error as any).code === "42501") throw new ForbiddenError((error as any).message);
    throw error;
  }
  return data;
}

export async function getDashboardStats(actor: Actor) {
  const supabase = db();
  const visibility = await getVisibleUserIds(actor);
  let q = supabase.from("tickets").select("status");
  if (!visibility.all) q = q.in("user_id", visibility.ids);
  const { data, error } = await q;
  if (error) throw error;
  const stats: Record<string, number> = { total: data?.length || 0 };
  for (const row of data || []) {
    const s = (row as any).status || "unknown";
    stats[s] = (stats[s] || 0) + 1;
  }
  return stats;
}
