import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/admin-server";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  if (id === auth.user.id) return NextResponse.json({ error: "You cannot delete your own administrator account." }, { status: 400 });

  const { data: target, error: targetError } = await auth.service.from("profiles").select("id,email,is_admin").eq("id", id).single();
  if (targetError || !target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (target.is_admin) return NextResponse.json({ error: "Administrator accounts cannot be deleted here." }, { status: 400 });

  const { error } = await auth.service.auth.admin.deleteUser(id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
