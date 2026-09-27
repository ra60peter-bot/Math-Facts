import "server-only";
import { createClient, type User } from "@supabase/supabase-js";

// Keep password verification separate from the privileged database client and
// from the browser session. Never accept an email supplied by the caller.
export async function verifyAccountPassword(user: User, password: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { ok: false, status: 503, error: "Password verification is unavailable. Nothing was deleted." };
  if (!user.email) return { ok: false, status: 403, error: "An account email and password are required to delete a student." };
  const verifier = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  try {
    const { data, error } = await verifier.auth.signInWithPassword({ email: user.email, password });
    if (error?.status === 429) return { ok: false, status: 429, error: "Too many password attempts. Please wait before trying again." };
    if (error || !data.user || data.user.id !== user.id) {
      return { ok: false, status: 403, error: "Password not verified. Enter your Math Facts password, or use the password setup/reset link. Nothing was deleted." };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 503, error: "Password verification is unavailable. Nothing was deleted." };
  } finally {
    // Revoke only this temporary verification session, never the user's sign-in.
    await verifier.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
}
