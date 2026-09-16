export async function checkRateLimit(
  admin: any,
  endpoint: string,
  identifier: string,
  maxPerWindow: number,
  windowSeconds: number,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count } = await admin
    .from("oauth_rate_limit_hits")
    .select("id", { count: "exact", head: true })
    .eq("endpoint", endpoint)
    .eq("identifier", identifier)
    .gte("created_at", windowStart);

  if ((count ?? 0) >= maxPerWindow) return { ok: false, retryAfter: windowSeconds };

  admin.from("oauth_rate_limit_hits").insert({ endpoint, identifier }).then(() => {}, () => {});
  return { ok: true };
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
