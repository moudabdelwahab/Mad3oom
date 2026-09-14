import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Actor } from "./actor.ts";
import { getVisibleUserIds } from "./authz.ts";

export class ForbiddenError extends Error { constructor(m?: string) { super(m); this.name = "ForbiddenError"; } }
export class NotFoundError extends Error { constructor(m?: string) { super(m); this.name = "NotFoundError"; } }

function db() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export async function listNotifications(actor: Actor, filters: { status?: "all" | "read" | "unread"; type?: string; limit?: number; offset?: number } = {}) {
  const supabase = db();
  let q = supabase.from("notifications").select("*").eq("user_id", actor.id).order("created_at", { ascending: false });
  if (filters.status === "read") q = q.eq("is_read", true);
  if (filters.status === "unread") q = q.eq("is_read", false);
  if (filters.type) q = q.eq("type", filters.type);
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  q = q.range(offset, offset + limit - 1);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function sendNotification(actor: Actor, args: { user_id?: string; title?: string; message?: string; type?: string; link?: string }) {
  if (!args?.user_id) throw new Error("الحقل user_id مطلوب");
  if (!args?.title?.trim()) throw new Error("الحقل title مطلوب");
  if (!args?.message?.trim()) throw new Error("الحقل message مطلوب");

  const elevated = actor.isMainAdmin || actor.isAdmin;
  if (!elevated) {
    const visibility = await getVisibleUserIds(actor);
    if (!visibility.all && !visibility.ids.includes(args.user_id)) {
      throw new ForbiddenError("لا يمكنك إرسال إشعار لمستخدم خارج نطاقك");
    }
  }

  const supabase = db();
  const { data, error } = await supabase.from("notifications").insert({ user_id: args.user_id, title: args.title.trim(), message: args.message.trim(), type: args.type || "info", link: args.link || null }).select().single();
  if (error) throw error;
  return data;
}

export async function manageNotification(actor: Actor, args: { notification_id?: string; action?: "mark_read" | "mark_unread" | "delete" }) {
  if (!args?.notification_id) throw new Error("الحقل notification_id مطلوب");
  if (!args?.action || !["mark_read", "mark_unread", "delete"].includes(args.action)) {
    throw new Error("الحقل action يجب أن يكون أحد: mark_read, mark_unread, delete");
  }

  const supabase = db();
  const { data: notification, error: fetchError } = await supabase.from("notifications").select("*").eq("id", args.notification_id).maybeSingle();
  if (fetchError) throw fetchError;
  if (!notification) throw new NotFoundError("الإشعار غير موجود");

  const elevated = actor.isMainAdmin || actor.isAdmin;
  if ((notification as any).user_id !== actor.id && !elevated) {
    throw new ForbiddenError("لا تملك صلاحية إدارة هذا الإشعار");
  }

  if (args.action === "delete") {
    const { error } = await supabase.from("notifications").delete().eq("id", args.notification_id);
    if (error) throw error;
    return { deleted: true, id: args.notification_id };
  }

  const { data: updated, error } = await supabase.from("notifications").update({ is_read: args.action === "mark_read" }).eq("id", args.notification_id).select().single();
  if (error) throw error;
  return updated;
}
