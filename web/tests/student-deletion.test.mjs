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

function route({ authenticated = true, role = "user", owner = "owner", verified = true, verificationStatus = 403 } = {}) {
  let deleted = false;
  const verifiedInputs = [];
  const service = { from: () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: owner ? { id: "student", owner_id: owner } : null }) }) }),
    delete: () => ({ eq: async () => { deleted = true; return { error: null }; } }),
  }) };
  const handler = compile("app/api/students/[id]/route.ts", { require: name => name === "next/server"
    ? { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } }
    : name.includes("verify-account-password") ? { verifyAccountPassword: async (user, password) => {
      verifiedInputs.push({ user, password });
      return verified ? { ok: true } : { ok: false, status: verificationStatus, error: "Not verified" };
    } } : { requireAccount: async () => authenticated ? { ok: true, service, role, user: { id: "owner", email: "owner@example.test" } } : { ok: false, status: 401, error: "Sign in" } },
  });
  return { run: (body = {}) => handler.DELETE({ json: async () => {
    if (body === "invalid json") throw new SyntaxError();
    return body;
  } }, { params: Promise.resolve({ id: "student" }) }), deleted: () => deleted, verifiedInputs };
}

test("student deletion rejects missing, empty, malformed, and oversized passwords without deleting", async () => {
  for (const body of [{}, null, "invalid json", { password: "" }, { password: "  " }, { password: 123 }, { password: "x".repeat(1025) }]) {
    const api = route();
    assert.equal((await api.run(body)).status, 400);
    assert.equal(api.deleted(), false);
    assert.equal(api.verifiedInputs.length, 0);
  }
});

test("owners and administrators both need a verified password for each deletion", async () => {
  for (const role of ["user", "admin"]) {
    const denied = route({ role, verified: false });
    assert.equal((await denied.run({ password: "wrong" })).status, 403);
    assert.equal(denied.deleted(), false);
    const allowed = route({ role, owner: role === "admin" ? "another-owner" : "owner" });
    assert.equal((await allowed.run({ password: " correct ", email: "attacker@example.test" })).status, 200);
    assert.equal(allowed.deleted(), true);
    assert.equal(allowed.verifiedInputs[0].user.email, "owner@example.test");
    assert.equal(allowed.verifiedInputs[0].password, " correct ");
    assert.equal((await allowed.run({})).status, 400);
  }
});

test("authentication, ownership, rate limiting and verification outages fail closed", async () => {
  for (const [options, status] of [
    [{ authenticated: false }, 401], [{ owner: "someone-else" }, 403], [{ owner: null }, 404],
    [{ verified: false, verificationStatus: 429 }, 429], [{ verified: false, verificationStatus: 503 }, 503],
  ]) {
    const api = route(options);
    assert.equal((await api.run({ password: "valid" })).status, status);
    assert.equal(api.deleted(), false);
  }
});

test("password verifier matches the acting account and uses an isolated temporary session", async () => {
  for (const scenario of ["valid", "wrong", "other-user", "rate-limit", "network"]) {
    let signOutScope;
    const verifier = compile("lib/verify-account-password.ts", {
      process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://test.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-key" } },
      require: name => name === "server-only" ? {} : { createClient: (url, key, options) => {
        assert.equal(key, "public-key");
        assert.equal(options.auth.persistSession, false);
        assert.equal(options.auth.autoRefreshToken, false);
        return { auth: {
          signInWithPassword: async credentials => {
            assert.equal(credentials.email, "actor@example.test");
            assert.equal(credentials.password, " supplied ");
            if (scenario === "network") throw new Error("offline");
            return { data: { user: { id: scenario === "other-user" ? "other" : "actor" } },
              error: scenario === "wrong" ? { status: 400 } : scenario === "rate-limit" ? { status: 429 } : null };
          },
          signOut: async options => { signOutScope = options.scope; },
        } };
      } },
    });
    const result = await verifier.verifyAccountPassword({ id: "actor", email: "actor@example.test" }, " supplied ");
    assert.equal(result.ok, scenario === "valid");
    assert.equal(signOutScope, "local");
    if (scenario === "rate-limit") assert.equal(result.status, 429);
    if (scenario === "network") assert.equal(result.status, 503);
  }
});
