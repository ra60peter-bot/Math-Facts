"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../../lib/supabase-browser";
import {accessRequest} from "../../../lib/access-client";
import {handOffOnboarding} from "../../../components/profile-gate";
import {PasswordLinkRequest} from "../../../components/password-link-request";

export default function InviteCallback() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation,setConfirmation]=useState("");
  const [busy,setBusy]=useState(false);
  const [message, setMessage] = useState("Preparing your account...");
  const [ready, setReady] = useState(false);
  const [needsFreshLink, setNeedsFreshLink] = useState(false);
  useEffect(() => {
    const client = supabaseBrowser();
    if (!client) { setMessage("Supabase has not been configured."); return; }
    client.auth.getSession().then(({ data }) => {
      if (data.session) { setReady(true); setMessage("Choose a password to finish joining."); }
      else { setMessage("This setup link has expired or has already been used. Request a fresh link below; you do not need another invitation."); setNeedsFreshLink(true); }
    }).catch(() => { setMessage("This link could not be opened. Request a fresh setup link below."); setNeedsFreshLink(true); });
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if(password!==confirmation){setMessage("Passwords do not match.");return;}
    const client = supabaseBrowser();
    if (!client) return;
    setBusy(true);
    try {
      const {data,error}=await client.auth.updateUser({password});
      if(error||!data.user?.email)throw error??new Error("Account email was not found.");
      await accessRequest("/api/access",{method:"POST",body:JSON.stringify({action:"forget"})});
      const opened=await accessRequest("/api/access",{method:"POST",body:JSON.stringify({action:"login",email:data.user.email,password})});
      const signedOut=await client.auth.signOut({scope:"local"});
      if(signedOut.error)throw new Error("Could not finish securing this device. Please retry.");
      handOffOnboarding(opened);setPassword("");setConfirmation("");router.push("/");
    }catch(error){setMessage(error instanceof Error?error.message:"Could not finish account setup.");}
    finally{setBusy(false);}
  }
  return <main className="identity-page"><div className="identity-panel"><p className="eyebrow">Account owner setup</p><h1>Create your password</h1><p className="muted">{message}</p><p>Next, add your students. They will choose their names without a password. Your password protects student management and history deletion.</p>{needsFreshLink && <PasswordLinkRequest />}{ready && <form className="identity-form" onSubmit={submit}><label>New password<input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>Confirm password<input type="password" autoComplete="new-password" required minLength={8} value={confirmation} onChange={event=>setConfirmation(event.target.value)} /></label><button className="button primary" disabled={busy}>{busy?"Finishing setup…":"Continue to add students"}</button></form>}</div></main>;
}
