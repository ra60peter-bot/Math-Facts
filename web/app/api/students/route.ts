import { NextRequest, NextResponse } from "next/server";
import { requireAccount } from "../../../lib/admin-server";

export async function GET(request: NextRequest) {
  const auth = await requireAccount(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let query = auth.service
    .from("students")
    .select("id,owner_id,display_name,created_at")
    .order("display_name");
  if (auth.role !== "admin") query = query.eq("owner_id", auth.user.id);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const ownerEmails = new Map<string, string>();
  if (auth.role === "admin") {
    const { data: owners } = await auth.service.from("profiles").select("id,email");
    for (const owner of owners ?? []) ownerEmails.set(owner.id, owner.email);
  }

  return NextResponse.json({
    students: (data ?? []).map((student) => ({
      id: student.id,
      ownerId: student.owner_id,
      name: student.display_name,
      createdAt: student.created_at,
      ownerEmail: ownerEmails.get(student.owner_id),
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAccount(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const requestedOwnerId = typeof body.ownerId === "string" ? body.ownerId : auth.user.id;
  const ownerId = auth.role === "admin" ? requestedOwnerId : auth.user.id;
  if (!name || name.length > 60) return NextResponse.json({ error: "Enter a student name between 1 and 60 characters." }, { status: 400 });

  const { data: owner } = await auth.service
    .from("profiles")
    .select("id,role,access_status")
    .eq("id", ownerId)
    .single();
  if (!owner || owner.access_status !== "active") return NextResponse.json({ error: "Account owner not found." }, { status: 404 });

  const { data, error } = await auth.service
    .from("students")
    .insert({ owner_id: ownerId, display_name: name })
    .select("id,owner_id,display_name,created_at")
    .single();
  if (error) {
    const message = error.code === "23505" ? "That account already has a student with this name." : error.message;
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({ student: { id: data.id, ownerId: data.owner_id, name: data.display_name, createdAt: data.created_at } }, { status: 201 });
}
