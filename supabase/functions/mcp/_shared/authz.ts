import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Actor } from "./actor.ts";

function isElevated(actor: Actor): boolean {
  return actor.isMainAdmin || actor.isAdmin;
}

export function canAccessTicket(actor: Actor, ticketOwnerId: string, ticketOwnerSuperUserId: string | null): boolean {
  if (ticketOwnerId === actor.id) return true;
  if (isElevated(actor)) return true;
  return ticketOwnerSuperUserId === actor.id;
}

export function canAccessCustomer(actor: Actor, customerId: string, customerSuperUserId: string | null): boolean {
  if (customerId === actor.id) return true;
  if (isElevated(actor)) return true;
  return customerSuperUserId === actor.id;
}

export function canManageWhatsApp(actor: Actor, botSettingsOwnerId: string): boolean {
  if (botSettingsOwnerId === actor.id) return true;
  return isElevated(actor);
}

export async function getVisibleUserIds(actor: Actor): Promise<{ all: true } | { all: false; ids: string[] }> {
  if (isElevated(actor)) return { all: true };

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: subUsers } = await admin.from("profiles").select("id").eq("super_user_id", actor.id);
  const ids = [actor.id, ...(subUsers || []).map((r: any) => r.id)];
  return { all: false, ids };
}
