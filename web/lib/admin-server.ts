import "server-only";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

export type AccountRole = "admin" | "user";

type AccountAuth =
  | { ok: true; service: SupabaseClient; user: User; role: AccountRole }
  | { ok: false; error: string; status: number };

export async function requireAccount(request: NextRequest): Promise<AccountAuth> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!url || !serviceKey) return { ok: false, error: "Server authentication is not configured.", status: 500 };
  if (!token) return { ok: false, error: "Sign in again to continue.", status: 401 };

  const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: identity, error: identityError } = await service.auth.getUser(token);
  if (identityError || !identity.user) return { ok: false, error: "Sign in again to continue.", status: 401 };
  const { data: profile, error: profileError } = await service
    .from("profiles")
    .select("role,access_status,is_admin")
    .eq("id", identity.user.id)
    .single();
  if (profileError || !profile) return { ok: false, error: "This account has not been provisioned.", status: 403 };
  if (profile.access_status !== "active") return { ok: false, error: "This account has not been invited.", status: 403 };
  const role: AccountRole = profile.role === "admin" || profile.is_admin ? "admin" : "user";
  return { ok: true, service, user: identity.user, role };
}

export async function requireAdmin(request: NextRequest): Promise<AccountAuth> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth;
  if (auth.role !== "admin") return { ok: false, error: "Administrator access is required.", status: 403 };
  return auth;
}
