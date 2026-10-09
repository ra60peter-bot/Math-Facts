import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const source=fs.readFileSync(new URL('../app/api/invites/route.ts',import.meta.url),'utf8');
function setup({profile=null,lookupError=null,restoreError=null,emailError=null,inviteError=null,admin=true}={}) {
  const events=[];
  const service={
    from(table){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:profile,error:lookupError}),
      upsert:async values=>{events.push(['eligible',values.email]);return {};},
      update:()=>({eq:async()=>{events.push(['activate']);return {};}}),
      delete:()=>{throw Error('Must not revoke invitation eligibility');}};return q;},
    rpc:async(name,args)=>{events.push(['restore',args.p_id]);return {error:restoreError};},
    auth:{resetPasswordForEmail:async(email,options)=>{events.push(['resend',email,options.redirectTo]);return {error:emailError};},
      admin:{inviteUserByEmail:async(email)=>{events.push(['invite',email]);return {error:inviteError??emailError};}}},
  };
  const exports={};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
    exports,Date,require:name=>name==='next/server'?{NextResponse:{json:(body,{status=200}={})=>({body,status})}}:
      {requireAdmin:async()=>admin?{ok:true,user:{id:'admin'},service}:{ok:false,error:'Forbidden',status:403}},
  });
  return {events,send:()=>exports.POST({json:async()=>({email:' Person@Example.test '}),nextUrl:new URL('https://app.test/api/invites')})};
}
test('resend works for an existing active account without recreating or deleting it',async()=>{
  const h=setup({profile:{id:'owner',access_status:'active'}}),r=await h.send();
  assert.equal(r.status,200);assert.ok(h.events.some(e=>e[0]==='resend'&&e[1]==='person@example.test'));
  assert.ok(!h.events.some(e=>e[0]==='invite'));assert.match(r.body.message,/fresh password setup link/);
});
test('admin reinviting a deleted owner restores before sending the setup email',async()=>{
  const h=setup({profile:{id:'owner',deleted_at:'2026-10-07T00:00:00Z'}}),r=await h.send();
  assert.equal(r.status,200);assert.equal(h.events[0][0],'restore');assert.equal(r.body.restored,true);
  assert.ok(h.events.some(e=>e[0]==='resend'));
});
test('failed restore does not send email or activate an expired deleted account',async()=>{
  const h=setup({profile:{id:'owner',deleted_at:'2026-01-01'},restoreError:{message:'Recovery period ended'}});
  assert.equal((await h.send()).status,400);assert.deepEqual(h.events,[['restore','owner']]);
});
test('database lookup failures fail closed and cannot create duplicate invitations',async()=>{
  const h=setup({lookupError:{message:'offline'}});assert.equal((await h.send()).status,500);assert.equal(h.events.length,0);
});
test('SMTP failure keeps invitation eligibility so the admin can retry',async()=>{
  const h=setup({emailError:{message:'SMTP unavailable'}});assert.equal((await h.send()).status,400);
  assert.deepEqual(h.events.map(e=>e[0]),['eligible','invite']);
});
test('non-admin cannot restore, invite or resend setup emails',async()=>{
  const h=setup({admin:false});assert.equal((await h.send()).status,403);assert.equal(h.events.length,0);
});
test('Auth already-exists response falls back to resending rather than a dead end',async()=>{
  const h=setup({inviteError:{code:'email_exists',message:'Already registered'}});
  assert.equal((await h.send()).status,200);
  assert.deepEqual(h.events.map(e=>e[0]),['eligible','invite','resend']);
});
