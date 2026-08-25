"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../../lib/supabase-browser";

export default function InviteCallback() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("Preparing your account...");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const client = supabaseBrowser();
    if (!client) { setMessage("Supabase has not been configured."); return; }
    client.auth.getSession().then(({ data }) => {
      if (data.session) { setReady(true); setMessage("Choose a password to finish joining."); }
      else setMessage("This invitation link is invalid or has expired.");
    });
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const client = supabaseBrowser();
    if (!client) return;
    const { error } = await client.auth.updateUser({ password });
    if (error) { setMessage(error.message); return; }
    router.push("/");
    router.refresh();
  }
  return <main className="main"><div className="setup"><h1>Join Math Facts</h1><p className="muted">{message}</p>{ready && <form className="form-row" onSubmit={submit}><label>Password<input type="password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="button primary">Finish setup</button></form>}</div></main>;
}
