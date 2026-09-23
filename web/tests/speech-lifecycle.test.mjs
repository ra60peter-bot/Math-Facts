// Run with: node --test tests/speech-lifecycle.test.mjs
// Exercise the actual recognition callback with a fake browser and deterministic clock.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..");
const parser = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, "lib/number-parser.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: parser.exports });
const source = fs.readFileSync(path.join(root, "components/math-facts-app.tsx"), "utf8");
const start = source.indexOf("  const startListening = useCallback(");
const end = source.indexOf("  useEffect(() => { startListeningRef", start);
assert.ok(start > 0 && end > start);
const compiled = ts.transpileModule(source.slice(start, end) + "\nglobalThis.listen = startListening;", {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

function harness() {
  let now = 0, id = 0, recognizer;
  const timers = new Map(), answers = [], statuses = [], feedback = [];
  const context = {
    useCallback: fn => fn, TIMEOUT_MS: 4000,
    window: {
      SpeechRecognition: class { constructor() { recognizer = { start() {} }; return recognizer; } },
      setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
      clearTimeout: key => timers.delete(key),
    },
    performance: { now: () => now },
    questionStartRef: { current: 0 }, soundResponseMsRef: { current: null },
    answerHandledRef: { current: true }, timeoutRef: { current: null },
    recognitionRef: { current: null }, voiceMappingsRef: { current: {} },
    localSpeechReadyRef: { current: false }, setLocalSpeechStatus() {},
    setSpeechSupported() {}, setQuestionReady() {}, setHeard() {}, setResult(value) { feedback.push(value); },
    answerFor: () => 28,
    setListenState: value => statuses.push(value),
    parseSpokenNumber: parser.exports.parseSpokenNumber,
    stopListening() {
      timers.delete(context.timeoutRef.current);
      context.timeoutRef.current = null;
      context.recognitionRef.current = null;
    },
    handleResponse(...args) {
      context.answerHandledRef.current = true;
      context.stopListening();
      answers.push(args);
    },
  };
  vm.runInNewContext(compiled, context);
  context.listen({ id: "test" });
  return {
    answers, statuses, context, feedback,
    get recognition() { return recognizer; },
    clock(value) { now = value; },
    expire() { const timer = [...timers.values()].sort((a, b) => a.at - b.at)[0]; assert.ok(timer); now = timer.at; timer.fn(); },
    result(text, final = false, alternatives = []) {
      const values = [text, ...alternatives].map(transcript => ({ transcript }));
      values.isFinal = final;
      recognizer.onresult({ results: [values] });
    },
  };
}

test("startup delay does not consume the four-second answer window", () => {
  const h = harness(); h.clock(1800); h.recognition.onstart();
  assert.equal(h.context.questionStartRef.current, 1800);
  h.expire(); assert.equal(h.answers[0][3], 4000);
});

test("live numeric feedback appears immediately without prematurely saving a partial answer", () => {
  const h = harness(); h.recognition.onstart(); h.clock(700);
  h.result("twenty");
  assert.equal(h.feedback.at(-1).tone, "wrong");
  assert.equal(h.answers.length, 0);
  h.clock(800); h.result("twenty eight");
  assert.equal(h.feedback.at(-1).text, "Correct! 0.8 seconds");
  assert.equal(h.answers.length, 0);
  h.clock(1800); h.result("twenty eight", true);
  assert.equal(h.answers.length, 1);
  assert.equal(h.answers[0][2], 28);
  assert.equal(h.answers[0][3], 800);
});

test("revised nonnumeric transcript and recognition failures clear live feedback", () => {
  const h = harness(); h.recognition.onstart(); h.result("28");
  h.result("unrecognized"); assert.equal(h.feedback.at(-1), null);
  h.result("28"); h.recognition.onerror({ error: "network" });
  assert.equal(h.feedback.at(-1), null); assert.equal(h.answers.length, 0);
});

test("browser recognition remains the default until local speech is explicitly enabled", () => {
  const h = harness();
  assert.equal(h.recognition.processLocally, undefined);
  assert.ok(!source.includes("useEffect(() => { void prepareSpeech(); }"));
  h.context.localSpeechReadyRef.current = true;
  h.context.listen({ id: "local" });
  assert.equal(h.recognition.processLocally, true);
  h.context.localSpeechReadyRef.current = false;
  h.context.listen({ id: "browser" });
  assert.equal(h.recognition.processLocally, undefined);
});
test("partial eight is retained and timed from speech onset", () => {
  const h = harness(); h.recognition.onstart(); h.clock(600); h.recognition.onspeechstart();
  h.clock(900); h.result("eight"); h.expire();
  assert.equal(h.answers[0][2], 8); assert.equal(h.answers[0][3], 600);
});
test("recognition end finalizes partial numbers without waiting for the deadline", () => {
  const h = harness(); h.recognition.onstart(); h.clock(700); h.result("ate"); h.recognition.onend();
  assert.equal(h.answers[0][2], 8); assert.equal(h.answers.length, 1);
});

test("speech end requests finalization once and waits for the completed number", () => {
  const h = harness(); let stops = 0;
  h.recognition.stop = () => { stops++; };
  h.recognition.onstart(); h.clock(600); h.recognition.onspeechstart();
  h.result("twenty"); h.recognition.onspeechend(); h.recognition.onspeechend();
  assert.equal(stops, 1); assert.equal(h.answers.length, 0);
  h.clock(1200); h.result("twenty one", true);
  assert.equal(h.answers[0][2], 21); assert.equal(h.answers[0][3], 600);
});

test("speech-end stop failure preserves the answer deadline", () => {
  const h = harness(); h.recognition.stop = () => { throw new Error("already stopped"); };
  h.recognition.onstart(); h.recognition.onspeechend(); h.expire();
  assert.equal(h.answers.length, 1); assert.equal(h.answers[0][3], 4000);
});
test("alternatives only replace an unrecognized transcript", () => {
  const h = harness(); h.recognition.onstart(); h.result("unrecognized", true, ["eight"]);
  assert.equal(h.answers[0][2], 8);
  const wrong = harness(); wrong.recognition.onstart(); wrong.result("seven", true, ["eight"]);
  assert.equal(wrong.answers[0][2], 7);
});
test("unrecognized speech reaches wrong-answer review instead of getting stuck", () => {
  const h = harness(); h.recognition.onstart(); h.result("unrecognized", true);
  assert.equal(h.answers.length, 1); assert.equal(h.answers[0][2], null);
  assert.equal(h.answers[0][1], "unrecognized");
});
test("51 and fifty-one are recognized even though they are not multiplication products", () => {
  for (const transcript of ["51", "fifty-one"]) {
    const h = harness(); h.recognition.onstart(); h.clock(900); h.result(transcript, true);
    assert.equal(h.answers[0][2], 51); assert.equal(h.answers[0][3], 900);
  }
});

test("accepting a heard answer corrects the original attempt and regrades from its previous state", () => {
  const begin = source.indexOf("  const allowPendingAnswer = () => {");
  const end = source.indexOf("  const exitPractice =", begin);
  const code = ts.transpileModule(source.slice(begin, end) + "\nglobalThis.accept = allowPendingAnswer;", {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const before = { totalAttempts: 2 };
  let reviewed, retryGrade, feedback, next;
  const context = {
    pendingWrong: { card: { id: "mul-5-10" }, transcript: "51", responseMs: 900, attemptId: "wrong", previousState: before },
    normalizeSpokenPhrase: parser.exports.normalizeSpokenPhrase,
    gradeResponse: () => "easy",
    reviewCardState: (state, grade, ms) => { reviewed = { state, grade, ms }; return { totalAttempts: 3 }; },
    statesRef: { current: { "mul-5-10": { totalAttempts: 3 } } },
    attemptsRef: { current: [{ id: "other", answerCorrect: false }, { id: "wrong", answerCorrect: false, correct: false, responseMs: 900, heard: "51" }] },
    setStates() {}, setPendingWrong() {}, setResult: result => { feedback = result; },
    scheduleRetry: (_card, grade) => { retryGrade = grade; }, nextRef: { current: null },
    advance() {}, window: { setTimeout: fn => { next = fn; } },
  };
  vm.runInNewContext(code, context); context.accept();
  assert.equal(reviewed.state, before); assert.equal(reviewed.ms, 900);
  assert.equal(context.attemptsRef.current.length, 2);
  assert.equal(context.attemptsRef.current[0].answerCorrect, false);
  assert.equal(context.attemptsRef.current[1].answerCorrect, true);
  assert.equal(context.attemptsRef.current[1].heard, "51");
  assert.equal(retryGrade, "easy"); assert.equal(feedback.tone, "good");
  assert.equal(next, context.advance);
});
test("network and permission failures do not record an answer", () => {
  for (const error of ["network", "not-allowed", "audio-capture"]) {
    const h = harness(); h.recognition.onstart(); h.recognition.onerror({ error });
    assert.equal(h.answers.length, 0); assert.equal(h.context.timeoutRef.current, null);
  }
});
test("startup watchdog and late callbacks do not record an answer", () => {
  const h = harness(); h.expire(); h.recognition.onstart(); h.result("eight", true);
  assert.equal(h.answers.length, 0); assert.match(h.statuses.at(-1), /did not start/);
});
test("manual restart invalidates old results and resets the answer guard", () => {
  const h = harness(); h.recognition.onstart(); const old = h.recognition;
  h.context.listen({ id: "new" }); old.onresult({results: [{0:{transcript:"eight"},length:1,isFinal:true}]});
  assert.equal(h.answers.length, 0);
  h.recognition.onstart(); h.result("nine", true); assert.equal(h.answers[0][2], 9);
});

test("practice feedback uses the inclusive 1.5-second cutoff and correct colors", () => {
  const begin = source.indexOf("  const handleResponse = useCallback(");
  const finish = source.indexOf("  const startListening = useCallback(", begin);
  const code = ts.transpileModule(source.slice(begin, finish) + "\nglobalThis.respond = handleResponse;", {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  for (const [parsed, elapsed, label, tone] of [
    [8, 1499, "Correct!", "good"], [8, 1500, "Correct!", "good"],
    [8, 1501, "Slow!", "slow"], [7, 700, "Wrong!", "wrong"],
    [null, 4000, "Wrong!", "wrong"],
  ]) {
    let feedback;
    const context = {
      useCallback: fn => fn, answerHandledRef: { current: false },
      statesRef: { current: {} }, attemptsRef: { current: [] }, nextRef: { current: null },
      stopListening() {}, answerFor: () => 8, gradeResponse: () => "good",
      defaultState: () => ({}), reviewCardState: () => ({}),
      setStates() {}, setHeard() {}, setListenState() {}, setProgress() {}, setPendingWrong() {},
      setResult: value => { feedback = value; }, scheduleRetry() {}, advance() {},
      window: { setTimeout() {} }, crypto: { randomUUID: () => "test" },
      operationSymbol: () => "+",
    };
    vm.runInNewContext(code, context);
    context.respond({ id: "test", a: 3, b: 5, operation: "add" }, parsed === null ? "" : String(parsed), parsed, elapsed);
    assert.ok(feedback.text.startsWith(label));
    assert.equal(feedback.tone, tone);
    assert.ok(feedback.text.includes("seconds"));
    if (tone === "wrong") assert.equal(feedback.correctAnswer, 8);
  }
});
