import "server-only";
import {createHash, randomBytes} from "node:crypto";
import {createClient} from "@supabase/supabase-js";
import {NextRequest, NextResponse} from "next/server";

export const DEVICE_COOKIE = "math-facts-device";
const DEVICE_AGE = 90 * 86400;
export function serviceClient() {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL, key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url || !key) throw new Error("Server authentication is not configured.");
  return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
}
export const hashToken = (token:string) => createHash("sha256").update(token).digest("hex");
export function sameOrigin(request:NextRequest) {
  return request.headers.get("origin") === request.nextUrl.origin;
}
export async function readDevice(request:NextRequest, service=serviceClient()) {
  const token=request.cookies.get(DEVICE_COOKIE)?.value;
  if(!token)return null;
  const {data,error}=await service.from("access_devices").select("id,owner_id,expires_at").eq("token_hash",hashToken(token)).gt("expires_at",new Date().toISOString()).maybeSingle();
  if(error)throw new Error("Device access could not be loaded.");
  return data;
}
export async function accountProfile(id:string,service=serviceClient()) {
  const {data,error}=await service.from("profiles").select("id,email,display_name,role,is_admin,access_status,deleted_at").eq("id",id).single();
  if(error || !data || data.access_status!=="active" || data.deleted_at)throw new Error("This account does not have access. Ask the administrator for an invitation.");
  return {id:data.id,email:data.email,displayName:data.display_name,role:data.role==="admin"||data.is_admin?"admin" as const:"user" as const,status:"active" as const};
}
export async function registerDevice(request:NextRequest,response:NextResponse,ownerId:string,service=serviceClient()) {
  const old=await readDevice(request,service);
  if(old?.owner_id===ownerId)return old;
  const token=randomBytes(32).toString("hex");
  const {data,error}=await service.from("access_devices").insert({owner_id:ownerId,token_hash:hashToken(token),expires_at:new Date(Date.now()+DEVICE_AGE*1000).toISOString()}).select("id,owner_id,expires_at").single();
  if(error || !data)throw new Error("Could not remember this device.");
  response.cookies.set(DEVICE_COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:DEVICE_AGE});
  return data;
}
export async function revokeDeviceGrants(deviceId:string,service=serviceClient()) {
  const {error}=await service.from("access_grants").delete().eq("device_id",deviceId);
  if(error)throw new Error("Could not lock this device. Please retry.");
}
export async function issueGrant(deviceId:string,mode:"owner"|"student",studentId:string|null,service=serviceClient()) {
  const token=randomBytes(32).toString("hex");
  const {error}=await service.from("access_grants").upsert({device_id:deviceId,token_hash:hashToken(token),mode,student_id:studentId,expires_at:new Date(Date.now()+8*3600000).toISOString()},{onConflict:"device_id"});
  if(error)throw new Error("Could not open this profile.");
  return token;
}
export async function readAccess(request:NextRequest) {
  const service=serviceClient(),device=await readDevice(request,service);
  const token=request.headers.get("x-math-access");
  if(!device || !token)throw new Error("Choose your profile to continue.");
  const {data:grant,error}=await service.from("access_grants").select("mode,student_id").eq("device_id",device.id).eq("token_hash",hashToken(token)).gt("expires_at",new Date().toISOString()).maybeSingle();
  if(error || !grant)throw new Error("This profile is locked. Choose your profile again.");
  const profile=await accountProfile(device.owner_id,service);
  return {service,device,grant,profile};
}
export async function requireStudentAccess(request:NextRequest,studentId:string) {
  const access=await readAccess(request);
  if(access.grant.mode==="student" && access.grant.student_id!==studentId)throw new Error("This student can only access their own practice and history.");
  const {data:student,error}=await access.service.from("students").select("id,owner_id,display_name").eq("id",studentId).is("deleted_at",null).single();
  if(error||!student|| (student.owner_id!==access.device.owner_id && !(access.grant.mode==="owner"&&access.profile.role==="admin")))throw new Error("Student access is not permitted.");
  await accountProfile(student.owner_id, access.service);
  return {...access,student};
}
