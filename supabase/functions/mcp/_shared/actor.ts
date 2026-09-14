import { createClient } from "jsr:@supabase/supabase-js@2";

const MAIN_ADMIN_EMAILS = ["support@mad3oom.online", "info@mad3oom.online"];

export interface Actor {
  id: string;
  role: string | null;
  superUserId: string | null;
  email: string | null;
  isMainAdmin: boolean;
  isAdmin: boolean;
}

export async function getActor(userId: string): Promise<Actor> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const [{ data: profile }, userRes] = await Promise.all([
    admin.from("profiles").select("role, super_user_id, email").eq("id", userId).maybeSingle(),
    admin.auth.admin.getUserById(userId),
  ]);

  const email = userRes?.data?.user?.email || profile?.email || null;
  const role = profile?.role ?? null;

  return {
    id: userId,
    role,
    superUserId: profile?.super_user_id ?? null,
    email,
    isMainAdmin: !!email && MAIN_ADMIN_EMAILS.includes(email),
    isAdmin: role === "admin",
  };
}
