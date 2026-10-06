import { NextRequest, NextResponse } from "next/server";
import { requireAccount } from "../../../lib/admin-server";

export async function GET(request: NextRequest) {
  const auth = await requireAccount(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  let query = auth.service.from("students")
    .select("id,display_name,deleted_at,profiles!students_owner_id_fkey!inner(id,email,deleted_at)")
    .gt("deleted_at", cutoff).is("profiles.deleted_at", null).order("deleted_at", { ascending: false });
  if (auth.role !== "admin") query = query.eq("owner_id", auth.user.id);
  const { data: students, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const entries: { id: string; kind: "student" | "user"; name: string; ownerEmail?: string; deletedAt: string; restoreUntil: string }[] = [];
  const append = (id: string, name: string, deletedAt: string, kind: "student" | "user", ownerEmail?: string) => entries.push({
    id, name, kind, ownerEmail, deletedAt, restoreUntil: new Date(Date.parse(deletedAt) + 30 * 86400000).toISOString(),
  });
  for (const student of students ?? []) {
    const owner = Array.isArray(student.profiles) ? student.profiles[0] : student.profiles;
    append(student.id, student.display_name, student.deleted_at, "student", auth.role === "admin" ? owner?.email : undefined);
  }
  if (auth.role === "admin") {
    const { data: users, error: userError } = await auth.service.from("profiles")
      .select("id,email,deleted_at").gt("deleted_at", cutoff).order("deleted_at", { ascending: false });
    if (userError) return NextResponse.json({ error: userError.message }, { status: 500 });
    for (const user of users ?? []) append(user.id, user.email, user.deleted_at, "user");
  }
  return NextResponse.json({ entries }, { headers: { "Cache-Control": "no-store" } });
}
