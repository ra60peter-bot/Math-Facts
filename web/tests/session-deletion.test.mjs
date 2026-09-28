import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..");
function compile(file, context) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, require:()=>({getAccessToken:()=>""}), ...context });
  return exports;
}
function route({ role = "user", owner = "owner", authenticated = true, fail = false } = {}) {
  let deleted = false;
  const service = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: owner ? { id: "session", user_id: owner } : null }) }) }),
    delete: () => ({ eq: async () => { deleted = true; return { error: fail ? new Error("failed") : null }; } }),
  }) };
  const handler = compile("app/api/sessions/[id]/route.ts", { require: name => name === "next/server"
    ? { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } }
    : { requireAccount: async () => authenticated ? { ok: true, service, role, user: { id: "owner" } } : { ok: false, status: 401, error: "Sign in" } },
  });
  return { run: () => handler.DELETE({}, { params: Promise.resolve({ id: "session" }) }), deleted: () => deleted };
}
test("session deletion requires authentication and ownership or administrator role", async () => {
  for (const [options, status, deleted] of [
    [{ authenticated: false }, 401, false], [{ owner: "someone-else" }, 403, false],
    [{}, 200, true], [{ owner: "someone-else", role: "admin" }, 200, true],
    [{ owner: null }, 200, false], [{ fail: true }, 500, true],
  ]) {
    const api = route(options); assert.equal((await api.run()).status, status); assert.equal(api.deleted(), deleted);
  }
});
test("deleted or previously uploaded sessions are not recreated by stale synchronization", async () => {
  const storage = new Map();
  const cloud = compile("lib/cloud-progress.ts", { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } });
  const calls = [];
  const client = { from: table => ({ upsert: async rows => { calls.push({ table, rows }); return { error: null }; } }) };
  cloud.rememberUploadedSessions("student", ["deleted"]);
  assert.equal(JSON.stringify(cloud.mergePendingSessions("student",[{id:"deleted"},{id:"new"}],[])),JSON.stringify([{id:"new"}]));
  await cloud.syncCloudProgress(client, "student", "owner", { states: {}, sessions: [
    { id: "deleted", attempts: [], operation: "add" },
    { id: "new", attempts: [], operation: "add" },
  ] });
  assert.equal(calls.length, 1); assert.equal(calls[0].rows.length, 1); assert.equal(calls[0].rows[0].id, "new");
  await cloud.syncCloudProgress(client, "student", "owner", { states: {}, sessions: [{ id: "new", attempts: [] }] });
  assert.equal(calls.length, 1);
});
test("deletion waits for an in-flight upload before subsequent writes", async () => {
  const cloud = compile("lib/cloud-progress.ts", {});
  const steps = []; let release;
  const held = new Promise(resolve => { release = resolve; });
  const upload = cloud.queueProgressWrite("student", async () => { steps.push("upload"); await held; });
  const deletion = cloud.queueProgressWrite("student", async () => { steps.push("delete"); });
  release(); await Promise.all([upload, deletion]);
  assert.deepEqual(steps, ["upload", "delete"]);
});

test("cloud progress round-trips scheduler snapshot and original attempt audit", async () => {
  const storage=new Map(),rows={students:[],card_states:[],practice_sessions:[],attempts:[]};
  let automaticity=null;
  const client={from:table=>({
    upsert:async data=>{rows[table]=data;return {error:null};},
    update:data=>({eq:async()=>{automaticity=JSON.parse(JSON.stringify(data.automaticity));return {error:null};}}),
    select:()=>({eq:()=>({
      then:resolve=>resolve({data:rows[table],error:null}),
      order:async()=>({data:rows[table],error:null}),
      single:async()=>({data:{automaticity},error:null}),
    })}),
  })};
  const cloud=compile("lib/cloud-progress.ts",{localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)}});
  const audit={id:"attempt",result:"SLOW_CORRECT",responseMs:2400,qualifiedCold:true,firstAnswerCorrect:true};
  const auto={version:1,learnerId:"student",session:{id:"active",counts:{"mul-7-8":3}},events:[audit],exposures:[{factId:"mul-7-8",at:100}]};
  await cloud.syncCloudProgress(client,"student","owner",{states:{},automaticity:auto,sessions:[{id:"done",operation:"mul",attempts:[{id:"attempt",fact:"7 × 8",operation:"mul",answerCorrect:false,heard:"fifty four",responseMs:2400,audit}]}]});
  const loaded=await cloud.loadCloudProgress(client,"student");
  assert.equal(JSON.stringify(loaded.automaticity),JSON.stringify(auto));
  assert.equal(JSON.stringify(loaded.sessions[0].attempts[0].audit),JSON.stringify(audit));
  assert.equal(loaded.sessions[0].attempts[0].answerCorrect,false);
  assert.equal(loaded.sessions[0].attempts[0].heard,"fifty four");
});
