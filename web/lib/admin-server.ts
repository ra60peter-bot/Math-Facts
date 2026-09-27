import "server-only";
import { type SupabaseClient, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import {readAccess,sameOrigin} from "./access-server";

export type AccountRole = "admin" | "user";

type AccountAuth =
  | { ok: true; service: SupabaseClient; user: User; role: AccountRole }
  | { ok: false; error: string; status: number };

export async function requireAccount(request: NextRequest): Promise<AccountAuth> {
  try {
    if(!["GET","HEAD"].includes(request.method)&&!sameOrigin(request))return {ok:false,error:"Invalid request origin.",status:403};
    const {service,grant,profile}=await readAccess(request);
    if(grant.mode!=="owner")return {ok:false,error:"An account owner's password is required for this action.",status:403};
    const {data,error}=await service.auth.admin.getUserById(profile.id);
    if(error||!data.user)return {ok:false,error:"Account not found.",status:403};
    return {ok:true,service,user:data.user,role:profile.role};
  }catch(error){return {ok:false,error:error instanceof Error?error.message:"Sign in again.",status:401};}
}

export async function requireAdmin(request: NextRequest): Promise<AccountAuth> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth;
  if (auth.role !== "admin") return { ok: false, error: "Administrator access is required.", status: 403 };
  return auth;
}
