"use client";
import {createContext,FormEvent,ReactNode,useEffect,useRef,useState} from "react";
import {accessRequest,setAccessToken} from "../lib/access-client";
import {flushProgressWrites} from "../lib/cloud-progress";
import {supabaseBrowser} from "../lib/supabase-browser";

export type AccessProfile={id:string;email:string;displayName:string|null;role:"admin"|"user";status:"active"|"blocked"};
export type AccessStudent={id:string;ownerId:string;name:string;createdAt:string};
export type ProfileSession={token:string;mode:"owner"|"student";profile:AccessProfile;student?:AccessStudent;onboarding?:boolean};
export const ProfileContext=createContext<{student:boolean;switchPerson:(()=>void)|null}>({student:false,switchPerson:null});

export function ProfileGate({children}:{children:(session:ProfileSession)=>ReactNode}) {
  const [profile,setProfile]=useState<AccessProfile|null>(null),[students,setStudents]=useState<AccessStudent[]>([]);
  const [session,setSession]=useState<ProfileSession|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [ownerSelected,setOwnerSelected]=useState(false),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[message,setMessage]=useState("");
  const enter=(value:ProfileSession)=>{setAccessToken(value.token);setSession(value);setPassword("");setMessage("");};
  const loadPicker=async()=>{const data=await accessRequest("/api/access");setProfile(data.profile);setStudents(data.students);setEmail(data.profile?.email??"");};
  const initialization=useRef<Promise<{session?:ProfileSession;profile?:AccessProfile|null;students?:AccessStudent[]} >|null>(null);
  useEffect(()=>{
    let cancelled=false;
    initialization.current ??= (async()=>{
      const handoff=takeOnboardingSession();
      if(handoff)return {session:handoff};
      setAccessToken("");
      await accessRequest("/api/access",{method:"POST",body:JSON.stringify({action:"lock"})});
      const client=supabaseBrowser(),auth=await client?.auth.getSession();
      if(auth?.data.session){
        let connected;
        try {connected=await accessRequest("/api/access",{method:"POST",headers:{Authorization:`Bearer ${auth.data.session.access_token}`},body:JSON.stringify({action:"connect"})});}
        finally {const result=await client?.auth.signOut({scope:"local"});if(result?.error)throw new Error("Could not clear the account sign-in. Reload before choosing a student.");}
        if(connected.token)return {session:connected as ProfileSession};
      }
      return accessRequest("/api/access");
    })();
    void initialization.current.then(data=>{
      if(cancelled)return;
      if(data.session){setAccessToken(data.session.token);setSession(data.session);}
      else {setProfile(data.profile??null);setStudents(data.students??[]);setEmail(data.profile?.email??"");}
    }).catch(error=>{if(!cancelled)setMessage(error instanceof Error?error.message:"Could not load profiles.");})
      .finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[]);
  async function switchPerson(){
    setBusy(true);setMessage("");
    try{
      // A failed upload must never prevent locking owner controls. Progress is
      // also saved locally and will retry when this student is opened again.
      const pending = await flushProgressWrites().then(()=>false,()=>true);
      await accessRequest("/api/access",{method:"POST",body:JSON.stringify({action:"lock"})});
      setAccessToken("");setSession(null);setPassword("");setOwnerSelected(false);await loadPicker();
      if(pending)setMessage("Some practice is saved on this device and still needs to sync. Open that student again when connected.");
    }catch(error){setMessage(error instanceof Error?error.message:"Could not switch profiles.");}
    finally{setBusy(false);}
  }
  async function signIn(event:FormEvent){
    event.preventDefault();setBusy(true);setMessage("");
    try{enter(await accessRequest("/api/access",{method:"POST",body:JSON.stringify({action:"login",email:profile?.email??email,password})}));}
    catch(error){setMessage(error instanceof Error?error.message:"Could not sign in.");}
    finally{setPassword("");setBusy(false);}
  }
  async function selectStudent(studentId:string){
    setBusy(true);setMessage("");
    try{enter(await accessRequest("/api/access",{method:"POST",body:JSON.stringify({action:"student",studentId})}));}
    catch(error){setMessage(error instanceof Error?error.message:"Could not open student.");}
    finally{setBusy(false);}
  }
  async function forget(){
    setBusy(true);
    try{await accessRequest("/api/access",{method:"POST",body:JSON.stringify({action:"forget"})});setProfile(null);setStudents([]);setEmail("");setOwnerSelected(false);}
    catch(error){setMessage(error instanceof Error?error.message:"Could not forget device.");}finally{setBusy(false);}
  }
  async function google(){
    const {error}=await supabaseBrowser()!.auth.signInWithOAuth({provider:"google",options:{redirectTo:window.location.origin}});
    if(error)setMessage(error.message);
  }
  async function resetPassword(){
    const address=profile?.email??email;if(!address){setMessage("Enter your account email first.");return;}
    const {error}=await supabaseBrowser()!.auth.resetPasswordForEmail(address,{redirectTo:`${window.location.origin}/auth/callback`});
    setMessage(error?error.message:"Check your email for the password setup/reset link.");
  }
  if(loading)return <main className="main"><p>Loading profiles…</p></main>;
  if(session)return <ProfileContext.Provider value={{student:session.mode==="student",switchPerson:()=>{if(!busy)void switchPerson();}}}>
    {message&&<p className="notice" role="alert">{message}</p>}{children(session)}
  </ProfileContext.Provider>;
  return <main className="identity-page"><div className="identity-panel">
    <p className="eyebrow">Math Facts</p><h1>Who’s practicing?</h1>
    <p className="muted">{profile?"Choose your name to get started.":"An account owner must sign in once to connect this device. Students can then choose their names without a password."}</p>
    {profile&&!ownerSelected?<>
      <button className="identity-card owner-card" disabled={busy} onClick={()=>{setOwnerSelected(true);setPassword("");setMessage("");}}><span className="identity-icon">🔒</span><span><strong>{profile.displayName||profile.email}</strong><small>Account owner · Password required</small></span></button>
      <h2>Students</h2><div className="student-picker">{students.map(student=><button key={student.id} className="identity-card" disabled={busy} onClick={()=>void selectStudent(student.id)}><span className="identity-icon" aria-hidden="true">{student.name.slice(0,1).toUpperCase()}</span><span><strong>{student.name}</strong><small>Practice &amp; my history</small></span></button>)}</div>
      {!students.length&&<p className="empty">No students yet. Choose the account owner to add your first student.</p>}
      <button className="button secondary" disabled={busy} onClick={()=>void forget()}>Use a different account / forget this device</button>
    </>:<>
      <h2>{profile?"Unlock account owner":"Account owner sign-in"}</h2>
      <form className="identity-form" onSubmit={signIn}>
        <label>Email<input type="email" autoComplete="username" required readOnly={Boolean(profile)} value={profile?.email??email} onChange={e=>setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)} /></label>
        <button className="button primary" disabled={busy}>{busy?"Signing in…":"Open owner controls"}</button>
      </form>
      <div className="form-row"><button className="button secondary" disabled={busy} onClick={()=>void resetPassword()}>Set or reset password</button>{profile&&<button className="button secondary" disabled={busy} onClick={()=>{setOwnerSelected(false);setPassword("");setMessage("");}}>Back to people</button>}</div>
      {(!profile||profile.role==="admin")&&<button className="button google" disabled={busy} onClick={()=>void google()}>Administrator Google sign-in</button>}
    </>}
    {message&&<p className="notice" role="alert">{message}</p>}
  </div></main>;
}

// Next client navigation preserves this module; never persist an owner grant in
// localStorage/sessionStorage or in the trusted-device cookie.
let onboardingSession:ProfileSession|null=null;
export function handOffOnboarding(session:ProfileSession){onboardingSession={...session,onboarding:true};}
function takeOnboardingSession(){const value=onboardingSession;onboardingSession=null;return value;}
