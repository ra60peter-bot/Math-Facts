import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../lib/local-speech.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports });
const { prepareLocalSpeech } = exports;

test("unsupported browsers keep normal speech and do not download", async () => {
  const statuses = [];
  assert.equal(await prepareLocalSpeech({}, value => statuses.push(value)), false);
  assert.deepEqual(statuses, ["unsupported"]);
});
test("installed language packs are reused", async () => {
  let installs = 0;
  assert.equal(await prepareLocalSpeech({ available: async () => "available", install: async () => { installs++; return true; } }, () => {}), true);
  assert.equal(installs, 0);
});
test("download is verified before local recognition is enabled", async () => {
  const statuses = []; let checks = 0;
  assert.equal(await prepareLocalSpeech({ available: async () => ++checks === 1 ? "downloadable" : "available", install: async options => {
    assert.equal(options.processLocally, true);
    assert.equal(options.langs.join(","), "en-US");
    return true;
  } }, value => statuses.push(value)), true);
  assert.deepEqual(statuses, ["checking", "downloading", "ready"]);
});

test("browser error details are provided when preparing local speech fails", async () => {
  const messages = [];
  assert.equal(await prepareLocalSpeech({ available: async () => { throw new Error("Download blocked"); }, install: async () => true }, () => {}, message => messages.push(message)), false);
  assert.equal(messages.at(-1), "Browser reported: Download blocked");
});
test("failed or blocked downloads leave browser speech available", async () => {
  for (const install of [async () => false, async () => { throw new Error("blocked"); }]) {
    const statuses = [];
    assert.equal(await prepareLocalSpeech({ available: async () => "downloadable", install }, value => statuses.push(value)), false);
    assert.equal(statuses.at(-1), "failed");
  }
});
