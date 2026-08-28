import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../../../lib/admin-server";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^\S+@\S+\.\S+$/.test(email)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });

  const { data: existingProfile } = await auth.service
    .from("profiles")
    .select("id,access_status")
    .eq("email", email)
    .maybeSingle();
  if (existingProfile?.access_status === "active") {
    return NextResponse.json({ error: "This email already has access." }, { status: 400 });
  }

  const { error: invitationError } = await auth.service.from("account_invitations").upsert({
    email,
    invited_by: auth.user.id,
    invited_at: new Date().toISOString(),
  }, { onConflict: "email" });
  if (invitationError) return NextResponse.json({ error: invitationError.message }, { status: 400 });

  if (existingProfile) {
    const { error: activationError } = await auth.service
      .from("profiles")
      .update({ access_status: "active", invited_by: auth.user.id })
      .eq("id", existingProfile.id);
    if (activationError) return NextResponse.json({ error: activationError.message }, { status: 400 });
    return NextResponse.json({ ok: true, activatedExistingGoogleAccount: true });
  }

  const { error } = await auth.service.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${request.nextUrl.origin}/auth/callback`,
    data: { account_role: "user" },
  });
  if (error) {
    await auth.service.from("account_invitations").delete().eq("email", email);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, activatedExistingGoogleAccount: false });
}
