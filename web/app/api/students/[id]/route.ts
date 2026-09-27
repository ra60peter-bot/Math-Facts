import { NextRequest, NextResponse } from "next/server";
import { requireAccount } from "../../../../lib/admin-server";
import { verifyAccountPassword } from "../../../../lib/verify-account-password";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAccount(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const { data: student, error: studentError } = await auth.service
    .from("students")
    .select("id,owner_id,display_name")
    .eq("id", id)
    .single();
  if (studentError || !student) return NextResponse.json({ error: "Student not found." }, { status: 404 });
  if (auth.role !== "admin" && student.owner_id !== auth.user.id) {
    return NextResponse.json({ error: "You can only delete students belonging to your account." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const password = body?.password;
  if (typeof password !== "string" || !password.trim() || password.length > 1024) {
    return NextResponse.json({ error: "Enter your Math Facts password to delete this student." }, { status: 400 });
  }
  const verification = await verifyAccountPassword(auth.user, password);
  if (!verification.ok) return NextResponse.json({ error: verification.error }, { status: verification.status });

  const { error } = await auth.service.from("students").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
