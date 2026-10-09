import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import ts from 'typescript';
const root=path.resolve(import.meta.dirname,'..');
function compile(file,imports={},extra={}) {
 const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{fileName:file,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:n=>imports[n]??{},process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'public'}},Date,Error,...extra});
 return exports;
}
function database(seed={}) {
 const tables={profiles:[{id:'owner',email:'owner@example.test',role:'user',access_status:'active'},{id:'other',role:'user',access_status:'active'}],students:[{id:'alice',owner_id:'owner',display_name:'Alice'},{id:'bob',owner_id:'owner',display_name:'Bob'},{id:'outside',owner_id:'other',display_name:'Other'}],access_devices:[],access_grants:[],...seed};
 const service={auth:{admin:{getUserById:async id=>({data:{user:{id}}})},getUser:async()=>({data:{user:{id:'owner'}}})},from(table){
 let filters=[],action='read',values;
 const q={select:()=>q,is:(k,v)=>{filters.push(r=>(r[k]??null)===v);return q;},eq:(k,v)=>{filters.push(r=>r[k]===v);return q;},gt:(k,v)=>{filters.push(r=>r[k]>v);return q;},order:()=>q,update:v=>{action='update';values=v;return q;},delete:()=>{action='delete';return q;},insert:v=>{action='insert';values=v;return q;},upsert:v=>{action='upsert';values=v;return q;},single:async()=>execute(true),maybeSingle:async()=>execute(true),then:(resolve,reject)=>Promise.resolve(execute(false)).then(resolve,reject)};
 function execute(single) {
  if(action==='insert')tables[table].push({id:'device',...values});
  if(action==='upsert'){tables[table]=tables[table].filter(r=>r.device_id!==values.device_id);tables[table].push({...values});}
  const found=tables[table].filter(r=>filters.every(f=>f(r)));
  if(action==='update')found.forEach(r=>Object.assign(r,values));
  if(action==='delete')tables[table]=tables[table].filter(r=>!filters.every(f=>f(r)));
  return {data:single?found[0]??null:found,error:null};
 }
 return q;
 }};
 return {tables,service};
}
const expires=new Date(Date.now()+3600000).toISOString();
function setup(){
 const db=database();
 const server=compile('lib/access-server.ts',{'node:crypto':crypto,'@supabase/supabase-js':{createClient:()=>db.service}});
 db.tables.access_devices.push({id:'device',owner_id:'owner',token_hash:server.hashToken('cookie'),expires_at:expires});
 const req=(token='',body={},method='POST',origin='https://app.test')=>({method,nextUrl:new URL('https://app.test/api/access'),headers:new Headers({origin,'x-math-access':token}),cookies:{get:name=>name==='math-facts-device'?{value:'cookie'}:undefined},json:async()=>body});
 const admin=compile('lib/admin-server.ts',{'./access-server':server});
 return {...db,server,req,admin};
}
const NextResponse={json:(body,options={})=>({body,status:options.status??200,headers:options.headers??new Headers(),cookies:{values:new Map(),set(name,value,options){this.values.set(name,{value,...options});},get(name){return this.values.get(name);}}})};

test('a remembered device without a grant has no management or progress access',async()=>{
 const s=setup();
 await assert.rejects(s.server.readAccess(s.req()),/Choose your profile/);
 assert.equal((await s.admin.requireAccount(s.req())).ok,false);
});
test('student grant reads only its own learner and cannot unlock owner or admin APIs',async()=>{
 const s=setup(),token=await s.server.issueGrant('device','student','alice',s.service);
 assert.equal((await s.server.requireStudentAccess(s.req(token),'alice')).student.id,'alice');
 await assert.rejects(s.server.requireStudentAccess(s.req(token),'bob'),/own practice/);
 await assert.rejects(s.server.requireStudentAccess(s.req(token),'outside'),/own practice/);
 for(const method of ['GET','POST','DELETE'])assert.equal((await s.admin.requireAccount(s.req(token,{},method))).status,403);
 assert.equal((await s.admin.requireAdmin(s.req(token))).status,403);
});
test('selecting a student rotates the grant and invalidates the prior owner token',async()=>{
 const s=setup(),owner=await s.server.issueGrant('device','owner',null,s.service);
 assert.equal((await s.admin.requireAccount(s.req(owner))).ok,true);
 const student=await s.server.issueGrant('device','student','alice',s.service);
 await assert.rejects(s.server.readAccess(s.req(owner)),/locked/);
 assert.equal((await s.server.readAccess(s.req(student))).grant.mode,'student');
 assert.equal(s.tables.access_grants.length,1);
 assert.notEqual(s.tables.access_grants[0].token_hash,student);
 await s.server.revokeDeviceGrants('device',s.service);
 await assert.rejects(s.server.readAccess(s.req(student)),/locked/);
});
test('owner accesses their students only; only admin manages adults and other accounts',async()=>{
 const s=setup(),token=await s.server.issueGrant('device','owner',null,s.service);
 assert.equal((await s.server.requireStudentAccess(s.req(token),'bob')).student.id,'bob');
 await assert.rejects(s.server.requireStudentAccess(s.req(token),'outside'),/not permitted/);
 assert.equal((await s.admin.requireAdmin(s.req(token))).status,403);
 s.tables.profiles[0].role='admin';
 assert.equal((await s.admin.requireAdmin(s.req(token))).ok,true);
 assert.equal((await s.server.requireStudentAccess(s.req(token),'outside')).student.id,'outside');
});
test('expired grants, blocked owners, and cross-origin management requests are rejected',async()=>{
 const s=setup(),token=await s.server.issueGrant('device','owner',null,s.service);
 assert.equal((await s.admin.requireAccount(s.req(token,{},'POST','https://evil.test'))).status,403);
 s.tables.profiles[0].access_status='blocked';
 await assert.rejects(s.server.readAccess(s.req(token)),/does not have access/);
 s.tables.profiles[0].access_status='active';s.tables.access_grants[0].expires_at='2000-01-01';
 await assert.rejects(s.server.readAccess(s.req(token)),/locked/);
});
test('picker cannot select another account’s student or establish a device anonymously',async()=>{
 const s=setup();
 const route=compile('app/api/access/route.ts',{'next/server':{NextResponse},'../../../lib/access-server':{...s.server,serviceClient:()=>s.service}});
 assert.equal((await route.POST(s.req('',{action:'student',studentId:'outside'}))).status,403);
 const request=s.req('',{action:'student',studentId:'alice'});request.cookies.get=()=>undefined;
 assert.equal((await route.POST(request)).status,403);
 assert.equal((await route.GET(request)).body.students.length,0);
 assert.equal(s.tables.access_grants.length,0);
});
test('only verified password login creates an ordinary owner grant; Google connection stays locked',async()=>{
 const s=setup();let good=false;
 const route=compile('app/api/access/route.ts',{'next/server':{NextResponse},'../../../lib/access-server':{...s.server,serviceClient:()=>s.service},'@supabase/supabase-js':{createClient:()=>({auth:{signInWithPassword:async()=>good?{data:{user:{id:'owner'},session:{access_token:'must-not-return',refresh_token:'secret'}}}:{data:{user:null},error:{message:'bad'}}}})}});
 assert.equal((await route.POST(s.req('',{action:'login',email:'owner@example.test',password:'wrong'}))).status,403);
 good=true;
 const opened=await route.POST(s.req('',{action:'login',email:'owner@example.test',password:'correct'}));
 assert.equal(opened.status,200);assert.equal(opened.body.mode,'owner');assert.ok(opened.body.token);
 assert.doesNotMatch(JSON.stringify(opened.body),/must-not-return|refresh_token|secret/);
 await s.server.revokeDeviceGrants('device',s.service);
 const connect=s.req('',{action:'connect'});connect.headers.set('authorization','Bearer test');
 assert.equal((await route.POST(connect)).body.token,null);
 assert.equal(s.tables.access_grants.length,0);
});
test('every existing account-management route enforces owner/admin guard',async()=>{
 const s=setup(),token=await s.server.issueGrant('device','student','alice',s.service);
 for(const [file,method] of [['students/route.ts','GET'],['students/route.ts','POST'],['students/[id]/route.ts','DELETE'],['students/[id]/route.ts','PATCH'],['recently-deleted/route.ts','GET'],['sessions/[id]/route.ts','DELETE'],['users/route.ts','GET'],['users/[id]/route.ts','DELETE'],['users/[id]/route.ts','PATCH'],['invites/route.ts','POST']]){
  const deletion=compile('lib/profile-deletion.ts',{'next/server':{NextResponse},'./admin-server':s.admin});
  const route=compile(`app/api/${file}`,{'next/server':{NextResponse},'../../../lib/admin-server':s.admin,'../../../../lib/admin-server':s.admin,'../../../../lib/profile-deletion':deletion});
  const result=await route[method](s.req(token,{},method),{params:Promise.resolve({id:'alice'})});
  assert.equal(result.status,403,file);
 }
});
test('student recording derives owner on the server, uses immutable RPC, and excludes stale deck states',async()=>{
 const saved=[],rpc=[];
 const route=compile('app/api/progress/route.ts',{'next/server':{NextResponse},'../../../lib/access-server':{sameOrigin:()=>true,requireStudentAccess:async()=>({service:{rpc:async(name,args)=>{rpc.push({name,args});return {error:null};}},student:{owner_id:'real-owner'}})},'../../../lib/cards':{makeCards:()=>[{id:'add-1-1'}]},'../../../lib/cloud-progress':{uploadProgress:async(...args)=>saved.push(args)}});
 const result=await route.POST({json:async()=>({studentId:'alice',ownerId:'fake-owner',progress:{states:{'add-1-1':{cardId:'add-1-1'},'mul-15-15':{cardId:'mul-15-15'}},sessions:[{id:'session',operation:'add',attempts:[]}],automaticity:{version:1,learnerId:'alice'}}})});
 assert.equal(result.status,200);assert.equal(rpc[0].args.p_owner_id,'real-owner');
 assert.equal(saved[0][2],'real-owner');assert.equal(saved[0][3].sessions.length,0);
 assert.equal(Object.keys(saved[0][3].states).length,1);assert.equal(route.DELETE,undefined);
});
test('student progress rejects cross-learner snapshots before writing',async()=>{
 let written=false;
 const route=compile('app/api/progress/route.ts',{'next/server':{NextResponse},'../../../lib/access-server':{sameOrigin:()=>true,requireStudentAccess:async()=>({service:{rpc:async()=>{written=true;return {}; }},student:{owner_id:'owner'}})},'../../../lib/cards':{makeCards:()=>[]}});
 const result=await route.POST({json:async()=>({studentId:'alice',progress:{states:{},sessions:[],automaticity:{version:1,learnerId:'bob'}}})});
 assert.equal(result.status,403);assert.equal(written,false);
});

test('invitation setup requires matching passwords before opening student management',async()=>{
 const values=[],effects=[],steps=[];let cursor=0;
 const jsx=(type,props)=>({type,props});
 const client={auth:{getSession:async()=>({data:{session:{}}}),updateUser:async({password})=>{steps.push(['password',password]);return {data:{user:{email:'invited@example.test'}}};},signOut:async()=>{steps.push(['clear Supabase session']);return {};}}};
 const page=compile('app/auth/callback/page.tsx',{
  react:{useState:initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],v=>{values[i]=v;}];},useEffect:fn=>effects.push(fn)},
  'react/jsx-runtime':{jsx,jsxs:jsx},
  'next/navigation':{useRouter:()=>({push:path=>steps.push(['navigate',path])})},
  '../../../lib/supabase-browser':{supabaseBrowser:()=>client},
  '../../../lib/access-client':{accessRequest:async(_path,init)=>{const body=JSON.parse(init.body);steps.push([body.action]);return {token:'owner',mode:'owner',profile:{id:'owner'}};}},
  '../../../components/profile-gate':{handOffOnboarding:value=>steps.push(['onboarding',value.mode])},
 });
 function render(){cursor=0;return page.default();}
 function find(node,type){if(!node||typeof node!=='object')return null;if(node.type===type)return node;for(const child of [node.props?.children].flat(Infinity)){const found=find(child,type);if(found)return found;}return null;}
 render();effects[0]();await new Promise(resolve=>setImmediate(resolve));
 values[0]='new-password';values[1]='different';
 await find(render(),'form').props.onSubmit({preventDefault(){}});
 assert.equal(steps.length,0);assert.equal(values[3],'Passwords do not match.');
 values[1]='new-password';
 await find(render(),'form').props.onSubmit({preventDefault(){}});
 assert.deepEqual(steps.map(s=>s[0]),['password','forget','login','clear Supabase session','onboarding','navigate']);
 assert.equal(steps.at(-1)[1],'/');assert.equal(values[0],'');assert.equal(values[1],'');
});


test('deleted owners and students cannot use stale grants; deleted profiles stay off picker',async()=>{
 const s=setup(), token=await s.server.issueGrant('device','student','alice',s.service);
 s.tables.students[0].deleted_at=new Date().toISOString();
 await assert.rejects(s.server.requireStudentAccess(s.req(token),'alice'),/not permitted/);
 const route=compile('app/api/access/route.ts',{'next/server':{NextResponse},'../../../lib/access-server':{...s.server,serviceClient:()=>s.service}});
 assert.equal((await route.GET(s.req())).body.students.some(s=>s.id==='alice'),false);
 assert.equal((await route.POST(s.req('',{action:'student',studentId:'alice'}))).status,403);
 s.tables.students[0].deleted_at=null;s.tables.profiles[0].deleted_at=new Date().toISOString();
 await assert.rejects(s.server.readAccess(s.req(token)),/does not have access/);
 assert.equal((await route.GET(s.req())).status,403);
});

test('recovery UI restores the selected profile, refreshes active lists, and reports server rejection',async()=>{
 const state=[],effects=[],calls=[];let cursor=0,fail=false,refreshed=0;
 let entries=[{id:'alice',kind:'student',name:'Alice',restoreUntil:'2030-01-01T00:00:00Z'}];
 const jsx=(type,props)=>({type,props});
 const component=compile('components/recently-deleted.tsx',{
  react:{useState:initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=v;}];},useEffect:fn=>effects.push(fn),useCallback:fn=>fn},
  'react/jsx-runtime':{jsx,jsxs:jsx},
  '../lib/access-client':{accessRequest:async(url,init)=>{
   calls.push([url,init?.method??'GET']);
   if(init?.method==='PATCH'){if(fail)throw new Error('The 30-day recovery period has ended');entries=[];return {ok:true};}
   return {entries};
  }},
 });
 const render=()=>{cursor=0;return component.RecentlyDeleted({refreshKey:1,onRestored:async()=>{refreshed++;}});};
 const nodes=(node)=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];
 render();effects[0]();await new Promise(resolve=>setImmediate(resolve));
 fail=true;await nodes(render()).find(n=>n.type==='button').props.onClick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(refreshed,0);assert.match(JSON.stringify(render()),/30-day recovery period/);
 assert.equal(nodes(render()).filter(n=>n.type==='button').length,1);
 fail=false;await nodes(render()).find(n=>n.type==='button').props.onClick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(refreshed,1);assert.match(JSON.stringify(render()),/Alice was restored with their saved history/);
 assert.equal(nodes(render()).filter(n=>n.type==='button').length,0);
 assert.deepEqual(calls.filter(c=>c[1]==='PATCH'),[['/api/students/alice','PATCH'],['/api/students/alice','PATCH']]);
});

function accessRoute(s,good=true) {
 return compile('app/api/access/route.ts',{'next/server':{NextResponse},'../../../lib/access-server':{...s.server,serviceClient:()=>s.service},'@supabase/supabase-js':{createClient:()=>({auth:{signInWithPassword:async()=>good?{data:{user:{id:'owner'}}}:{data:{user:null},error:{message:'bad'}}}})}});
}
function withAdminCookie(s,token,body={action:'resume'}) {
 const req=s.req('',body);req.cookies.get=name=>({value:name==='math-facts-admin'?token:'cookie'});return req;
}
test('admin login survives refresh beyond eight hours and renews only the authenticated grant',async()=>{
 const s=setup();s.tables.profiles[0].role='admin';const route=accessRoute(s);
 const login=await route.POST(s.req('',{action:'login',email:'owner@example.test',password:'correct'}));
 assert.equal(login.status,200);
 assert.ok(Date.parse(s.tables.access_grants[0].expires_at)>Date.now()+24*3600000);
 assert.ok(Date.parse(s.tables.access_devices[0].expires_at)>Date.now()+90*86400000);
 const resumed=await route.POST(withAdminCookie(s,login.body.token));
 assert.equal(resumed.body.session.profile.role,'admin');assert.equal(resumed.body.session.token,login.body.token);
 const cookie=resumed.cookies.get('math-facts-admin');assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'strict');assert.ok(cookie.maxAge>0);
 await route.POST(withAdminCookie(s,login.body.token,{action:'lock'}));
 const afterLogout=await route.POST(withAdminCookie(s,login.body.token));
 assert.equal(afterLogout.body.session,null);assert.equal(afterLogout.cookies.get('math-facts-admin').maxAge,0);
 assert.equal(s.tables.access_grants.length,0);
});
test('admin Google connect persists; student selection invalidates persistent admin access',async()=>{
 const s=setup();s.tables.profiles[0].role='admin';const route=accessRoute(s);
 const connect=s.req('',{action:'connect'});connect.headers.set('authorization','Bearer test');
 const login=await route.POST(connect);assert.equal(login.status,200);
 assert.ok((await route.POST(withAdminCookie(s,login.body.token))).body.session);
 const selected=await route.POST(withAdminCookie(s,login.body.token,{action:'student',studentId:'alice'}));
 assert.equal(selected.body.mode,'student');assert.equal(selected.cookies.get('math-facts-admin').maxAge,0);
 assert.equal((await route.POST(withAdminCookie(s,login.body.token))).body.session,null);
});
test('resume rejects device-only, ordinary owner, student, revoked, blocked, deleted and cross-origin access',async()=>{
 const s=setup(),route=accessRoute(s);
 assert.equal((await route.POST(s.req('',{action:'resume'}))).body.session,null);
 const owner=await s.server.issueGrant('device','owner',null,s.service);
 assert.equal((await route.POST(withAdminCookie(s,owner))).body.session,null);
 s.tables.profiles[0].role='admin';
 const student=await s.server.issueGrant('device','student','alice',s.service);
 assert.equal((await route.POST(withAdminCookie(s,student))).body.session,null);
 const admin=await s.server.issueGrant('device','owner',null,s.service);
 const external=withAdminCookie(s,admin);external.headers.set('origin','https://evil.test');
 assert.equal((await route.POST(external)).status,403);
 s.tables.profiles[0].access_status='blocked';assert.equal((await route.POST(withAdminCookie(s,admin))).body.session,null);
 s.tables.profiles[0].access_status='active';s.tables.profiles[0].deleted_at='2026-01-01';assert.equal((await route.POST(withAdminCookie(s,admin))).body.session,null);
 s.tables.profiles[0].deleted_at=null;await s.server.revokeDeviceGrants('device',s.service);
 assert.equal((await route.POST(withAdminCookie(s,admin))).body.session,null);
});

test('ProfileGate resumes an admin on mount without locking the browser or asking for credentials',async()=>{
 const calls=[],effects=[],values=[];let cursor=0;
 const session={token:'resumed',mode:'owner',profile:{id:'admin',role:'admin'}};
 const gate=compile('components/profile-gate.tsx',{
  react:{createContext:()=>({Provider:'provider'}),useState:initial=>{const i=cursor++;values[i]=initial;return [values[i],v=>{values[i]=v;}];},useRef:()=>({current:null}),useEffect:fn=>effects.push(fn)},
  'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
  '../lib/access-client':{setAccessToken:token=>calls.push(['token',token]),accessRequest:async(path,init)=>{calls.push(['request',JSON.parse(init.body).action]);return {session};}},
  '../lib/supabase-browser':{supabaseBrowser:()=>{throw new Error('Should not request Google authentication');}},
 });
 gate.ProfileGate({children:()=>null});effects[0]();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls.filter(c=>c[0]==='request'),[['request','resume']]);
 assert.deepEqual(calls.at(-1),['token','resumed']);assert.ok(values.includes(session));
});
