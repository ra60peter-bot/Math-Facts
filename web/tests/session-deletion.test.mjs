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
  }).outputText, { exports, ...context });
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
