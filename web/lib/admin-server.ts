import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

type AdminAuth =
  | { ok: true; service: SupabaseClient; user: User }
  | { ok: false; error: string; status: number };

export async function requireAdmin(request: NextRequest): Promise<AdminAuth> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!url || !serviceKey) return { ok: false, error: "Server authentication is not configured.", status: 500 };
  if (!token) return { ok: false, error: "Sign in again to continue.", status: 401 };

  const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: identity, error: identityError } = await service.auth.getUser(token);
  if (identityError || !identity.user) return { ok: false, error: "Sign in again to continue.", status: 401 };
  const { data: profile } = await service.from("profiles").select("is_admin").eq("id", identity.user.id).single();
  if (!profile?.is_admin) return { ok: false, error: "Administrator access is required.", status: 403 };
  return { ok: true, service, user: identity.user };
}
