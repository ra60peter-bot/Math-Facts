"use client";
import { useState, type FormEvent } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";

export function PasswordLinkRequest() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function send(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const client = supabaseBrowser();
      if (!client) throw new Error("Account setup is unavailable. Please try again later.");
      const { error } = await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${window.location.origin}/auth/callback`,
      });
      if (error) throw error;
      setMessage("If this email has an account, a fresh password setup link is on its way. Check spam too, and use the newest email. You do not need a new invitation.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not send the email. Please retry.");
    } finally { setBusy(false); }
  }
  return <form className="identity-form" onSubmit={send}>
    <label>Account email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
    <button className="button primary" disabled={busy}>{busy ? "Sending…" : "Send fresh password setup link"}</button>
    {message && <p className="notice" role="status">{message}</p>}
  </form>;
}
