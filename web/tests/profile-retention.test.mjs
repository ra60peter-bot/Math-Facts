import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const admin=id(1), owner=id(2), other=id(3), student=id(4), sibling=id(5), session=id(6);
const sql = file => readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8');
const change = (actor,kind,target,restore=false) => db.query('select public.change_profile_deletion($1,$2,$3,$4)',[actor,kind,target,restore]);
const row = async (table, key) => (await db.query(`select * from ${table} where id=$1`,[key])).rows[0];

before(async()=>{
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  for(const file of ['001_initial_schema.sql','007_account_student_hierarchy.sql','008_automaticity_scheduler.sql','009_profile_access.sql']) await db.exec(sql(file));
  // Real PostgreSQL executes the migration; only the hosted Cron extension is omitted.
  await db.exec(sql('010_recoverable_deletion.sql').split('-- Supabase Cron')[0] + 'commit;');
});
after(()=>db.close());
beforeEach(async()=>{
  await db.exec('begin');
  await db.query(`insert into auth.users(id,email) values ($1,'admin@test.invalid'),($2,'owner@test.invalid'),($3,'other@test.invalid')`,[admin,owner,other]);
  await db.query(`update profiles set access_status='active',role=case when id=$1 then 'admin' else 'user' end,is_admin=(id=$1)`,[admin]);
  await db.query(`insert into students(id,owner_id,display_name,automaticity) values ($1,$2,'Student','{"facts":{"mul-2-3":{"stage":"MAINTENANCE"}}}'),($3,$2,'Sibling','{}')`,[student,owner,sibling]);
  await db.query(`insert into practice_sessions(id,student_id,user_id,operation,started_at,ended_at) values ($1,$2,$3,'mul',now(),now())`,[session,student,owner]);
  await db.query(`insert into attempts(id,session_id,student_id,user_id,fact,operation,is_correct,answer_correct,response_ms,heard,created_at) values ($1,$2,$3,$4,'mul-2-3','mul',true,true,1100,'six',now())`,[id(7),session,student,owner]);
  await db.query(`insert into access_devices(id,owner_id,token_hash,expires_at) values ($1,$2,'device',now()+interval '1 day');`,[id(8),owner]);
  await db.query(`insert into access_grants(token_hash,device_id,mode,student_id,expires_at) values ('grant',$1,'student',$2,now()+interval '1 hour')`,[id(8),student]);
});
afterEach(()=>db.exec('rollback'));

test('student delete and restore retain exact history, identity and scheduler; revoke stale grants',async()=>{
  const original=await row('students',student), history=await row('attempts',id(7));
  await change(owner,'student',student);
  const deleted=await row('students',student);assert.ok(deleted.deleted_at);
  assert.equal((await db.query('select * from access_grants')).rows.length,0);
  await change(owner,'student',student);assert.deepEqual((await row('students',student)).deleted_at,deleted.deleted_at);
  await change(owner,'student',student,true);
  assert.deepEqual(await row('students',student),original);
  assert.deepEqual(await row('attempts',id(7)),history);
});
test('user restoration restores family access without resurrecting independently deleted students',async()=>{
  await change(owner,'student',sibling);
  const separate=(await row('students',sibling)).deleted_at;
  await change(admin,'user',owner);
  assert.ok(await row('auth.users',owner));assert.ok(await row('practice_sessions',session));
  assert.equal((await db.query('select * from access_devices')).rows.length,0);
  await change(admin,'user',owner,true);
  assert.equal((await row('profiles',owner)).deleted_at,null);
  assert.equal((await row('students',student)).deleted_at,null);
  assert.deepEqual((await row('students',sibling)).deleted_at,separate);
});
test('retention cleanup preserves day 29, then removes expired student with cascading history only',async()=>{
  await db.query(`update students set deleted_at=now()-interval '29 days' where id=$1`,[student]);
  await db.exec('select public.purge_expired_profiles()');assert.ok(await row('attempts',id(7)));
  await db.query(`update students set deleted_at=now()-interval '30 days' where id=$1`,[student]);
  await db.exec('select public.purge_expired_profiles()');
  assert.equal(await row('students',student),undefined);assert.equal(await row('practice_sessions',session),undefined);assert.equal(await row('attempts',id(7)),undefined);
  assert.ok(await row('students',sibling));assert.ok(await row('auth.users',owner));
});
test('expired owner cleanup removes auth, invitation, students and history; active family is unaffected',async()=>{
  await db.query(`insert into account_invitations(email,invited_by,accepted_by) values ('owner@test.invalid',$1,$2)`,[admin,owner]);
  await db.query(`update profiles set deleted_at=now()-interval '30 days' where id=$1`,[owner]);
  await db.exec('select public.purge_expired_profiles()');
  for(const [table,key] of [['auth.users',owner],['profiles',owner],['students',student],['students',sibling],['attempts',id(7)]]) assert.equal(await row(table,key),undefined);
  assert.equal((await db.query('select * from account_invitations')).rows.length,0);assert.ok(await row('auth.users',other));
});
test('an account in trash retains its entire family during its 30-day window',async()=>{
  await db.query(`update students set deleted_at=now()-interval '31 days' where id=$1`,[student]);
  await change(admin,'user',owner);await db.exec('select public.purge_expired_profiles()');
  assert.ok(await row('attempts',id(7)));
});

// Savepoints allow the remainder of each transaction to keep testing after a SQL rejection.
async function rejected(work,pattern){
  await db.exec('savepoint rejected');await assert.rejects(work,pattern);await db.exec('rollback to savepoint rejected');
}
test('restore expires exactly at 30 days; duplicate deletes do not renew that deadline',async()=>{
  await db.query(`update students set deleted_at=now()-interval '30 days' where id=$1`,[student]);
  await change(owner,'student',student);
  await rejected(()=>change(owner,'student',student,true),/30-day recovery period/);
  await db.query(`update profiles set deleted_at=now()-interval '30 days' where id=$1`,[owner]);
  await rejected(()=>change(admin,'user',owner,true),/30-day recovery period/);
});
test('authorization blocks other owners, ordinary adult deletion, administrators, deleted owners and orphan restores',async()=>{
  await rejected(()=>change(other,'student',student),/only manage/);
  await rejected(()=>change(owner,'user',other),/Administrator access/);
  await rejected(()=>change(admin,'user',admin),/Administrator accounts/);
  await change(admin,'user',owner);
  await rejected(()=>change(owner,'student',student),/Account access/);
  await rejected(()=>change(admin,'student',student,true),/Restore the account owner first/);
});
test('stale authenticated Supabase clients cannot mutate history, purge, or change deletion flags',async()=>{
  await db.query(`select set_config('request.jwt.claim.sub',$1,true)`,[owner]);
  await change(owner,'student',student);
  await db.exec('set local role authenticated');
  assert.equal((await db.query('select * from practice_sessions')).rows.length,0);
  assert.equal((await db.query('select * from students')).rows.length,1);
  await rejected(()=>db.exec('delete from students'),/permission denied/);
  await rejected(()=>db.exec('update students set deleted_at=null'),/permission denied/);
  await rejected(()=>db.exec('delete from practice_sessions'),/permission denied/);
  await rejected(()=>db.exec('select public.purge_expired_profiles()'),/permission denied/);
  await rejected(()=>change(owner,'student',student,true),/permission denied/);
  await db.exec('reset role');
});

test('requests already in flight cannot alter archived history even using the service path',async()=>{
 await change(owner,'student',student);
 await rejected(()=>db.query('delete from practice_sessions where id=$1',[session]),/Restore the deleted profile/);
 await rejected(()=>db.query("update attempts set heard='changed' where id=$1",[id(7)]),/Restore the deleted profile/);
 await rejected(()=>db.query("update students set automaticity='{}' where id=$1",[student]),/Restore the deleted profile/);
 assert.equal((await row('attempts',id(7))).heard,'six');
 await change(owner,'student',student,true);
 await db.query('delete from practice_sessions where id=$1',[session]);
 assert.equal(await row('attempts',id(7)),undefined);
});
