import {NextRequest,NextResponse} from "next/server";
import {requireStudentAccess,sameOrigin} from "../../../lib/access-server";
import {loadCloudProgress,loadVoiceMappings,uploadProgress,type CloudProgress} from "../../../lib/cloud-progress";
import {makeCards} from "../../../lib/cards";

export async function GET(request:NextRequest) {
  try {
    const id=request.nextUrl.searchParams.get("studentId")??"";
    const {service}=await requireStudentAccess(request,id);
    const result=request.nextUrl.searchParams.has("mappings")?{mappings:await loadVoiceMappings(service,id)}:await loadCloudProgress(service,id);
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Could not load practice."},{status:403});}
}
export async function POST(request:NextRequest) {
  if(!sameOrigin(request))return NextResponse.json({error:"Invalid request origin."},{status:403});
  try {
    const {studentId,progress}=await request.json() as {studentId:string;progress:CloudProgress};
    const {service,student}=await requireStudentAccess(request,studentId);
    const ids=new Set([...makeCards("add"),...makeCards("sub"),...makeCards("mul")].map(c=>c.id));
    if(!progress || !progress.states || !Array.isArray(progress.sessions)||progress.sessions.length>200)throw new Error("Invalid practice record.");
    for(const [id,state] of Object.entries(progress.states))if(!state||state.cardId!==id)throw new Error("Invalid fact record.");
    // Old caches can include facts removed from the current deck. Leave those
    // database rows alone rather than blocking all new practice from syncing.
    const states=Object.fromEntries(Object.entries(progress.states).filter(([id])=>ids.has(id)));
    if(progress.automaticity && (progress.automaticity.learnerId!==studentId || progress.automaticity.version!==1))throw new Error("Progress belongs to a different student.");
    for(const session of progress.sessions) {
      if(!Array.isArray(session.attempts)||session.attempts.length>100||!["add","sub","mul"].includes(session.operation))throw new Error("Invalid session.");
      // A single transaction inserts a new history entry and its attempts.
      // Existing history is immutable here: no edits, deletes or ID reassignment.
      const {error}=await service.rpc("record_practice_session",{p_student_id:studentId,p_owner_id:student.owner_id,p_session:session});
      if(error)throw new Error("Could not record the practice session.");
    }
    await uploadProgress(service,studentId,student.owner_id,{...progress,states,sessions:[]});
    return NextResponse.json({ok:true});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Could not save practice."},{status:403});}
}
