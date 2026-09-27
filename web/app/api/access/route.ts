import {createClient} from "@supabase/supabase-js";
import {NextRequest,NextResponse} from "next/server";
import {accountProfile,DEVICE_COOKIE,issueGrant,readDevice,registerDevice,revokeDeviceGrants,sameOrigin,serviceClient} from "../../../lib/access-server";

export async function GET(request:NextRequest) {
  try {
    const service=serviceClient(),device=await readDevice(request,service);
    if(!device)return NextResponse.json({profile:null,students:[]},{headers:{"Cache-Control":"no-store"}});
    const profile=await accountProfile(device.owner_id,service);
    const {data,error}=await service.from("students").select("id,owner_id,display_name,created_at").eq("owner_id",device.owner_id).order("display_name");
    if(error)throw new Error("Could not load students.");
    return NextResponse.json({profile,students:(data??[]).map(s=>({id:s.id,ownerId:s.owner_id,name:s.display_name,createdAt:s.created_at}))},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Could not load profiles."},{status:403});}
}

export async function POST(request:NextRequest) {
  if(!sameOrigin(request))return NextResponse.json({error:"This request must come from Math Facts."},{status:403});
  try {
    const body=await request.json(),service=serviceClient(),device=await readDevice(request,service);
    if(body.action==="lock" || body.action==="forget") {
      if(device)await revokeDeviceGrants(device.id,service);
      const response=NextResponse.json({ok:true});
      if(body.action==="forget") {
        if(device){const {error}=await service.from("access_devices").delete().eq("id",device.id);if(error)throw new Error("Could not forget this device.");}
        response.cookies.set(DEVICE_COOKIE,"",{httpOnly:true,path:"/",maxAge:0});
      }
      return response;
    }
    if(body.action==="student") {
      if(!device)throw new Error("An account owner must sign in on this device first.");
      const profile=await accountProfile(device.owner_id,service);
      const {data:student,error}=await service.from("students").select("id,owner_id,display_name,created_at").eq("id",String(body.studentId)).eq("owner_id",device.owner_id).single();
      if(error || !student)throw new Error("Student not found on this account.");
      const token=await issueGrant(device.id,"student",student.id,service);
      return NextResponse.json({token,mode:"student",profile,student:{id:student.id,ownerId:student.owner_id,name:student.display_name,createdAt:student.created_at}});
    }
    if(body.action==="login") {
      const email=String(body.email??"").trim().toLowerCase(),password=String(body.password??"");
      if(!email||!password||password.length>1024)throw new Error("Enter your email and password.");
      if(device){const profile=await accountProfile(device.owner_id,service);if(profile.email.toLowerCase()!==email)throw new Error("Choose a different account before signing in.");}
      const authClient=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
      const {data,error}=await authClient.auth.signInWithPassword({email,password});
      if(error||!data.user)throw new Error("Email or password is incorrect. Please try again.");
      const profile=await accountProfile(data.user.id,service),envelope=NextResponse.json({});
      const registered=await registerDevice(request,envelope,profile.id,service);
      const token=await issueGrant(registered.id,"owner",null,service);
      // No Supabase access/refresh token is sent back to this shared browser.
      return NextResponse.json({token,mode:"owner",profile},{headers:envelope.headers});
    }
    if(body.action==="connect") {
      const bearer=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
      if(!bearer)throw new Error("Sign in to connect this device.");
      const {data,error}=await service.auth.getUser(bearer);
      if(error||!data.user)throw new Error("Sign in to connect this device.");
      const profile=await accountProfile(data.user.id,service),envelope=NextResponse.json({});
      const registered=await registerDevice(request,envelope,profile.id,service);
      // The administrator retains Google sign-in. Regular owners always unlock
      // management with a password, even when connecting an old Google session.
      const token=profile.role==="admin"?await issueGrant(registered.id,"owner",null,service):null;
      return NextResponse.json({profile,token,mode:token?"owner":"picker"},{headers:envelope.headers});
    }
    return NextResponse.json({error:"Unknown access action."},{status:400});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Access could not be opened."},{status:403});}
}
