import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../../../lib/admin-server";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^\S+@\S+\.\S+$/.test(email)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });

  const { data: existingProfile, error: profileError } = await auth.service
    .from("profiles")
    .select("id,access_status,deleted_at")
    .eq("email", email)
    .maybeSingle();

  if (profileError) return NextResponse.json({ error: "Could not check this account. Please retry." }, { status: 500 });
  if (existingProfile?.deleted_at) {
    const { error } = await auth.service.rpc("change_profile_deletion", {
      p_actor: auth.user.id, p_kind: "user", p_id: existingProfile.id, p_restore: true,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
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
    const {error:emailError}=await auth.service.auth.resetPasswordForEmail(email,{redirectTo:`${request.nextUrl.origin}/auth/callback`});
    if(emailError)return NextResponse.json({error:emailError.message},{status:400});
    return NextResponse.json({ ok: true, restored: Boolean(existingProfile.deleted_at), message: `${existingProfile.deleted_at ? "Account restored. " : ""}A fresh password setup link was sent to ${email}. Use the newest email to create or reset the password.` });
  }

  const { error } = await auth.service.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${request.nextUrl.origin}/auth/callback`,
    data: { account_role: "user" },
  });
  if (error) {
    // Email delivery failure must not revoke invitation eligibility.
    if (error.code === "email_exists" || error.code === "user_already_exists") {
      const { error: resendError } = await auth.service.auth.resetPasswordForEmail(email, {
        redirectTo: `${request.nextUrl.origin}/auth/callback`,
      });
      if (resendError) return NextResponse.json({ error: resendError.message }, { status: 400 });
      return NextResponse.json({ ok: true, message: `A fresh password setup link was sent to ${email}. Use the newest email.` });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, message: `Invitation sent to ${email}. If the email link expires, they can request a fresh one on the website.` });
}
