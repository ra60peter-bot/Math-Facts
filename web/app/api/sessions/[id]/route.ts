import { NextRequest, NextResponse } from "next/server";
import { requireAccount } from "../../../../lib/admin-server";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAccount(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const { data: session, error } = await auth.service.from("practice_sessions")
    .select("id,user_id").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not load this session." }, { status: 500 });
  // Missing records are already deleted, including sessions saved only on this device.
  if (!session) return NextResponse.json({ ok: true });
  if (auth.role !== "admin" && session.user_id !== auth.user.id) {
    return NextResponse.json({ error: "You can only delete sessions belonging to your account." }, { status: 403 });
  }
  const { error: deleteError } = await auth.service.from("practice_sessions").delete().eq("id", id);
  if (deleteError) return NextResponse.json({ error: "Could not delete this session. Please try again." }, { status: 500 });
  // The database cascades deletion to the session's question attempts.
  return NextResponse.json({ ok: true });
}
