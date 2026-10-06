import { NextRequest, NextResponse } from "next/server";
import { requireAccount, requireAdmin } from "./admin-server";

export async function changeProfileDeletion(request: NextRequest, id: string, kind: "student" | "user", restore: boolean) {
  const auth = await (kind === "user" ? requireAdmin(request) : requireAccount(request));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { error } = await auth.service.rpc("change_profile_deletion", {
    p_actor: auth.user.id, p_kind: kind, p_id: id, p_restore: restore,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
