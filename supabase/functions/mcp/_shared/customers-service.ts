import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Actor } from "./actor.ts";
import { canAccessCustomer, getVisibleUserIds } from "./authz.ts";

export class ForbiddenError extends Error { constructor(m?: string) { super(m); this.name = "ForbiddenError"; } }
export class NotFoundError extends Error { constructor(m?: string) { super(m); this.name = "NotFoundError"; } }

function db() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

const SAFE_COLUMNS = "id, email, full_name, phone, role, user_type, city, country, created_at, is_verified, super_user_id";

export async function listCustomers(actor: Actor, filters: { limit?: number; offset?: number } = {}) {
  const supabase = db();
  const visibility = await getVisibleUserIds(actor);
  let q = supabase.from("profiles").select(SAFE_COLUMNS).order("created_at", { ascending: false });
  if (!visibility.all) q = q.in("id", visibility.ids);
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  q = q.range(offset, offset + limit - 1);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getCustomer(actor: Actor, customerId: string) {
  const supabase = db();
  const { data: customer, error } = await supabase.from("profiles").select(SAFE_COLUMNS).eq("id", customerId).maybeSingle();
  if (error) throw error;
  if (!customer) throw new NotFoundError("Customer not found");
  if (!canAccessCustomer(actor, (customer as any).id, (customer as any).super_user_id ?? null)) throw new ForbiddenError("Access denied");
  return customer;
}
