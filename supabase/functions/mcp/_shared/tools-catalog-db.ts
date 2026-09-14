import { createClient } from "jsr:@supabase/supabase-js@2";

export interface CatalogTool {
  name: string;
  scope: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

let cache: { data: CatalogTool[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function getToolsCatalog(): Promise<CatalogTool[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.data;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await admin
    .from("mcp_tools_catalog")
    .select("name, scope, description, input_schema")
    .order("sort_order", { ascending: true });

  if (error || !data) {
    console.error("[tools-catalog-db] فشل جلب الكتالوج:", error?.message);
    return cache?.data || [];
  }

  const mapped = data.map((row: any) => ({
    name: row.name,
    scope: row.scope,
    description: row.description,
    inputSchema: row.input_schema || {},
  }));
  cache = { data: mapped, expiresAt: Date.now() + CACHE_TTL_MS };
  return mapped;
}
