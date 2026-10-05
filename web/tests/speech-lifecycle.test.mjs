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
const speech = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, "lib/speech-results.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: speech.exports, require: () => parser.exports });
const source = fs.readFileSync(path.join(root, "components/math-facts-app.tsx"), "utf8");
const start = source.indexOf("  const startListening = useCallback(");
const end = source.indexOf("  useEffect(() => { startListeningRef", start);
assert.ok(start > 0 && end > start);
const compiled = ts.transpileModule(source.slice(start, end) + "\nglobalThis.listen = startListening;", {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

function harness() {
  let now = 0, id = 0, recognizer;
  const timers = new Map(), answers = [], statuses = [], feedback = [], questionReady = [];
  const context = {
    useCallback: fn => fn, flushSync: fn => fn(), TIMEOUT_MS: 4000, SPEECH_RESULT_GRACE_MS: 3000,
    AUTOMATICITY_CONFIG: {automaticityTargetMs:1500},
    navigator: { userAgent: "test browser" }, setSpeechReport() {},
    window: {
      SpeechRecognition: class { constructor() { recognizer = { start() {}, stop() {} }; return recognizer; } },
      setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
      clearTimeout: key => timers.delete(key),
      requestAnimationFrame: fn => fn(),
    },
    performance: { now: () => now },
    questionStartRef: { current: 0 }, soundResponseMsRef: { current: null },
    answerHandledRef: { current: true }, timeoutRef: { current: null },
    recognitionRef: { current: null }, voiceMappingsRef: { current: {} },
    recordPresentationRef: { current() {} }, recordInvalidRef: { current() {} },
    localSpeechReadyRef: { current: false }, setLocalSpeechStatus() {},
    numberSpeechActiveRef: { current: false },
    preferences: {showTimes:true}, retryRef: {current:false}, setRecognitionFailed() {},
    setSpeechSupported() {}, setQuestionReady(value) { questionReady.push(value); }, setHeard() {}, setResult(value) { feedback.push(value); },
    answerFor: () => 28,
    setListenState: value => statuses.push(value),
    parseSpokenNumber: parser.exports.parseSpokenNumber,
    readNumberResult: speech.exports.readNumberResult,
    addNumberHints: speech.exports.addNumberHints,
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
    answers, statuses, context, feedback, questionReady,
    get recognition() { return recognizer; },
    startAudio() { recognizer.onstart(); recognizer.onaudiostart(); },
    clock(value) { now = value; },
    advance(value) {
      for (;;) {
        const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > value) break;
        const [key, timer] = entry; timers.delete(key); now = timer.at; timer.fn();
      }
      now = value;
    },
    expire() { const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(entry); const [key, timer] = entry; timers.delete(key); now = timer.at; timer.fn(); },
    result(text, final = false, alternatives = []) {
      const values = [text, ...alternatives].map(transcript => ({ transcript }));
      values.isFinal = final;
      recognizer.onresult({ results: [values] });
    },
  };
}

test("startup delay does not consume the four-second answer window", () => {
  const h = harness(); h.clock(1800); h.startAudio();
  assert.equal(h.context.questionStartRef.current, 1800);
  h.clock(2000); h.result("six"); h.expire(); assert.equal(h.answers[0][3], 200);
});

test("question timer begins in the reveal frame, and cancelled frames cannot reveal a stale question", () => {
  const h = harness(); let reveal;
  h.context.window.requestAnimationFrame = fn => { reveal = fn; };
  h.clock(300); h.startAudio();
  assert.equal(h.questionReady.at(-1), false);
  h.clock(550); reveal();
  assert.equal(h.questionReady.at(-1), true);
  assert.equal(h.context.questionStartRef.current, 550);
  h.clock(1750); h.recognition.onspeechstart(); h.result("twenty eight", true);
  assert.equal(h.answers[0][3], 1200);
  h.context.listen({id:"cancelled"}); h.startAudio(); h.context.stopListening();
  h.clock(1900); reveal(); assert.equal(h.questionReady.at(-1), false);
});

test("number engine scores word onset, not startup noise or delayed transcript arrival", () => {
  const h = harness(); h.recognition.usesWordTiming = true;
  h.clock(1000); h.startAudio();
  h.clock(1100); h.recognition.onsoundstart();
  h.clock(3500); h.result("twenty seven");
  assert.equal(h.feedback.at(-1), null);
  assert.equal(h.answers.length, 0);
  h.clock(4200);
  h.recognition.onresult({results:[{0:{transcript:"twenty seven"},length:1,isFinal:true}],speechStartedAt:2700});
  assert.equal(h.answers[0][3],1700);
});

test("number engine flushes timing at deadline even with an interim number", () => {
  const h = harness(); h.recognition.usesWordTiming = true; let stops = 0;
  h.recognition.stop = () => {stops++;}; h.startAudio();
  h.clock(3900); h.result("twenty eight"); h.expire();
  assert.equal(stops,1); assert.equal(h.answers.length,0);
  h.clock(4600);
  h.recognition.onresult({results:[{0:{transcript:"twenty eight"},length:1,isFinal:true}],speechStartedAt:3100});
  assert.equal(h.answers[0][3],3100);
});

test("missing or zero word timing keeps the answer but excludes estimated duration from scoring", () => {
  for (const onset of [undefined,1000,1005]) {
    const h = harness(); h.recognition.usesWordTiming = true;
    h.clock(1000); h.startAudio(); h.clock(2000);
    h.recognition.onresult({results:[{0:{transcript:"two"},length:1,isFinal:true}],speechStartedAt:onset});
    assert.equal(h.answers.length,1);assert.equal(h.answers[0][3],1000);
    assert.match(h.statuses.at(-1), /timing unavailable/);
    assert.equal(h.answers[0][4], false);
  }
});

test("132 is accepted even if a decoder boundary is estimated before reveal", () => {
  const h=harness();h.recognition.usesWordTiming=true;h.context.answerFor=()=>132;
  let windowStart=null;h.recognition.beginAnswerWindow=at=>windowStart=at;
  h.clock(1000);h.startAudio();assert.equal(windowStart,1000);
  h.clock(2600);
  h.recognition.onresult({results:[{0:{transcript:"one thirty two"},length:1,isFinal:true}],speechStartedAt:990});
  assert.equal(h.answers.length,1);assert.equal(h.answers[0][2],132);
  assert.equal(h.answers[0][3],1600);
  assert.ok(!h.statuses.some(status=>status.includes("before the question")));
});

test("both engines wait for audio capture before revealing the question or timing a short answer", () => {
  for (const local of [false, true]) {
    for (const [word, expected] of [["six", 6], ["eight", 8], ["ten", 10]]) {
      const h = harness(); h.context.localSpeechReadyRef.current = local; h.context.listen({ id: "audio-ready" });
      assert.equal(h.recognition.continuous, true);
      h.clock(300); h.recognition.onstart();
      assert.equal(h.questionReady.at(-1), false);
      h.clock(1300); h.recognition.onaudiostart();
      assert.equal(h.questionReady.at(-1), true);
      h.clock(1900); h.recognition.onsoundstart(); h.recognition.onspeechstart();
      h.clock(2000); h.recognition.onspeechend(); h.result(word, true);
      assert.equal(h.answers[0][2], expected); assert.equal(h.answers[0][3], 600);
    }
  }
});

test("service start without audio capture fails safely instead of showing a timed question", () => {
  const h = harness(); h.recognition.onstart(); h.expire();
  assert.equal(h.questionReady.at(-1), false); assert.equal(h.answers.length, 0);
  assert.match(h.statuses.at(-1), /did not start/);
});

test("browser mode also flushes a pending short answer at the deadline", () => {
  const h = harness(); let stops = 0; h.recognition.stop = () => { stops++; };
  h.startAudio(); h.clock(850); h.recognition.onspeechstart(); h.expire();
  assert.equal(stops, 1); assert.equal(h.answers.length, 0);
  h.clock(4150); h.result("six", true);
  assert.equal(h.answers[0][2], 6); assert.equal(h.answers[0][3], 850);
});

test("a single syllable delayed 1.5 seconds is not discarded by the old 800ms processing limit", () => {
  for (const local of [false, true]) {
    const h = harness(); h.context.localSpeechReadyRef.current = local; h.context.listen({id: "late-short-answer"});
    let captureStoppedAt = null;
    h.recognition.stop = () => { captureStoppedAt = h.context.performance.now(); };
    h.startAudio(); h.clock(3700); h.recognition.onspeechstart(); h.expire();
    assert.equal(captureStoppedAt, 4000);
    h.advance(5200); h.result("two");
    assert.equal(h.feedback.at(-1),null); // unfinished wrong numbers stay neutral
    h.clock(5700); h.result("two", true);
    assert.equal(h.answers.length, 1); assert.equal(h.answers[0][2], 2); assert.equal(h.answers[0][3], 3700);
  }
});

test("recognition processing wait is bounded and late callbacks after expiry cannot score", () => {
  const h = harness(); h.startAudio(); h.recognition.onspeechstart(); h.expire(); h.expire();
  assert.equal(h.context.performance.now(), 7000);
  h.clock(7100); h.result("two", true);
  assert.equal(h.answers.length, 0); assert.equal(h.context.recognitionRef.current, null);
});

test("failed practice reports include raw alternatives, capture deadline and end", () => {
  const h = harness(); let report = ""; h.context.setSpeechReport = (value) => { report = value; };
  h.startAudio(); h.clock(1000); h.result("The answer is", true, ["answer is"]);
  h.expire(); h.recognition.onend();
  assert.match(report, /choice 2: "answer is"/);
  assert.match(report, /Four-second deadline: stop audio capture/);
  assert.match(report, /Recognition ended/);
  assert.equal(h.answers.length, 0);
});

test("sound or speech without a transcript is a technical invalidity", () => {
  for (const [event, expected] of [["onsoundstart", /Sound was detected/], ["onspeechstart", /Speech was detected/]]) {
    const h = harness(); h.startAudio(); h.clock(500);
    if (event) h.recognition[event]();
    h.expire(); h.expire();
    assert.equal(h.answers.length, 0); assert.match(h.statuses.at(-1), expected);
  }
});

test("successful capture with a full silent answer window records one timeout", () => {
  const h=harness();h.startAudio();h.expire();h.expire();
  assert.equal(h.answers.length,1);assert.equal(h.answers[0][2],null);assert.equal(h.answers[0][3],4000);
  h.result("eight",true);assert.equal(h.answers.length,1);
});

test("on-device deadline stops capture and allows a buffered forty result to finish", () => {
  const h = harness(); h.context.localSpeechReadyRef.current = true; h.context.listen({ id: "local" });
  let stops = 0; h.recognition.stop = () => { stops++; };
  h.startAudio(); h.clock(900); h.recognition.onspeechstart();
  h.expire(); assert.equal(stops, 1); assert.equal(h.answers.length, 0);
  h.clock(4200); h.result("forty", true);
  assert.equal(h.answers.length, 1); assert.equal(h.answers[0][2], 40); assert.equal(h.answers[0][3], 900);
});

test("on-device empty result offers retry without scoring a wrong answer", () => {
  const h = harness(); h.context.localSpeechReadyRef.current = true; h.context.listen({ id: "local" });
  h.recognition.stop = () => {}; h.startAudio(); h.recognition.onspeechstart(); h.expire(); h.expire();
  assert.equal(h.answers.length, 0);
  assert.match(h.statuses.at(-1), /No answer was scored/);
  assert.equal(h.context.recognitionRef.current, null);
});

test("on-device end during finalization and late results do not score an empty attempt", () => {
  const h = harness(); h.context.localSpeechReadyRef.current = true; h.context.listen({ id: "local" });
  h.recognition.stop = () => {}; h.startAudio(); h.recognition.onspeechstart(); h.expire(); h.recognition.onend();
  h.result("ten", true); assert.equal(h.answers.length, 0);
});

test("live numeric feedback appears immediately without prematurely saving a partial answer", () => {
  const h = harness(); h.startAudio(); h.clock(700);
  h.result("twenty");
  assert.equal(h.feedback.at(-1),null);
  assert.equal(h.answers.length, 0);
  h.clock(800); h.recognition.onspeechstart(); h.result("twenty eight");
  assert.equal(h.feedback.at(-1).text, "Correct! · 0.80 seconds");
  assert.equal(h.answers.length, 0);
  h.clock(1800); h.result("twenty eight", true);
  assert.equal(h.answers.length, 1);
  assert.equal(h.answers[0][2], 28);
  assert.equal(h.answers[0][3], 800);
});

test("one oh eight never flashes Wrong while its partial words are arriving",()=>{
  for(const local of [false,true]) {
    const h=harness();h.recognition.usesWordTiming=local;h.context.answerFor=()=>108;
    h.clock(1000);h.startAudio();h.clock(2400);
    h.result("one");h.result("one oh");h.result("one oh eight");
    assert.ok(!h.feedback.some(value=>value?.tone==="wrong"));
    assert.equal(h.feedback.at(-1).tone,"good");
    h.clock(3100);
    h.recognition.onresult({results:[{0:{transcript:"one oh eight"},length:1,isFinal:true}],speechStartedAt:2200});
    assert.equal(h.answers[0][2],108);assert.equal(h.answers[0][3],local?1200:1400);
  }
});

test("revised nonnumeric transcript and recognition failures clear live feedback", () => {
  const h = harness(); h.startAudio(); h.result("28");
  h.result("unrecognized"); assert.equal(h.feedback.at(-1), null);
  h.result("28"); h.recognition.onerror({ error: "network" });
  assert.equal(h.feedback.at(-1), null); assert.equal(h.answers.length, 0);
});

test("browser fallback uses remote recognition unless its native local pack is explicitly enabled", () => {
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
  const h = harness(); h.startAudio(); h.clock(600); h.recognition.onspeechstart();
  h.clock(900); h.result("eight"); h.expire();
  assert.equal(h.answers[0][2], 8); assert.equal(h.answers[0][3], 600);
});
test("recognition end finalizes partial numbers without waiting for the deadline", () => {
  const h = harness(); h.startAudio(); h.clock(700); h.result("ate"); h.recognition.onend();
  assert.equal(h.answers[0][2], 8); assert.equal(h.answers.length, 1);
});

test("empty recognition restarts within the original deadline and can hear ten or forty", () => {
  for (const [word, expected] of [["ten", 10], ["forty", 40]]) {
    const h = harness(); let restarts = 0; h.recognition.start = () => { restarts++; };
    h.startAudio(); h.clock(500); h.result("", true); h.recognition.onend();
    assert.equal(restarts, 1); assert.equal(h.answers.length, 0);
    h.clock(700); h.startAudio();
    assert.equal(h.context.questionStartRef.current, 0);
    h.clock(1100); h.result(word, true);
    assert.equal(h.answers[0][2], expected); assert.equal(h.answers[0][3], 1100);
  }
});

test("empty recovery is bounded and does not extend the four-second timeout", () => {
  const h = harness(); let restarts = 0; h.recognition.start = () => { restarts++; };
  h.startAudio(); h.clock(500);
  h.recognition.onend(); h.recognition.onend(); h.recognition.onend();
  assert.equal(restarts, 2); h.expire();
  assert.equal(h.answers.length, 0); h.expire();
  assert.equal(h.answers.length,1);assert.equal(h.answers[0][3],4000);
});

test("empty final transcript does not erase an already recognized number", () => {
  const h = harness(); h.startAudio(); h.clock(800); h.result("forty");
  h.result("", true); h.recognition.onend();
  assert.equal(h.answers[0][2], 40); assert.equal(h.answers[0][3], 800);
});

test("speech boundaries do not stop recognition or truncate a completed number", () => {
  const h = harness(); let stops = 0;
  h.recognition.stop = () => { stops++; };
  h.startAudio(); h.clock(600); h.recognition.onspeechstart();
  h.result("twenty"); h.recognition.onspeechend(); h.recognition.onspeechend();
  assert.equal(stops, 0); assert.equal(h.answers.length, 0);
  h.clock(1200); h.result("twenty one", true);
  assert.equal(h.answers[0][2], 21); assert.equal(h.answers[0][3], 600);
});

test("deadline stop failure offers retry instead of hanging", () => {
  const h = harness(); h.recognition.stop = () => { throw new Error("already stopped"); };
  h.startAudio(); h.expire();
  assert.equal(h.answers.length, 0); assert.match(h.statuses.at(-1), /No answer was scored/);
});

test("short ten can arrive after speechend without the app stopping recognition early", () => {
  const h = harness(); let stops = 0; h.recognition.stop = () => { stops++; };
  h.startAudio(); h.clock(700); h.recognition.onspeechstart();
  h.clock(900); h.recognition.onspeechend();
  assert.equal(stops, 0); assert.equal(h.answers.length, 0);
  h.clock(1000); h.result("ten", true);
  assert.equal(h.answers[0][2], 10); assert.equal(h.answers[0][3], 700);
});
test("alternatives only replace an unrecognized transcript", () => {
  const h = harness(); h.startAudio(); h.result("unrecognized", true, ["eight"]);
  assert.equal(h.answers[0][2], 8);
  const wrong = harness(); wrong.startAudio(); wrong.result("seven", true, ["eight"]);
  assert.equal(wrong.answers[0][2], 7);
});

test("ten and forty survive word, digit, punctuation, filler and alternative transcripts", () => {
  for (const [transcript, expected] of [["ten", 10], ["10.", 10], ["um 10", 10], ["tin", 10], ["forty", 40], ["40!", 40], ["uh 40", 40], ["fourty", 40]]) {
    const h = harness(); h.startAudio(); h.clock(900); h.result(transcript, true);
    assert.equal(h.answers[0][2], expected, transcript);
  }
  for (const [word, expected] of [["ten", 10], ["forty", 40]]) {
    const h = harness(); h.startAudio(); h.result("unrecognized", true, [word]);
    assert.equal(h.answers[0][2], expected);
  }
});

test("digit answers inside answer phrases are recognized without guessing from equations", () => {
  for (const transcript of ["Your answer is 10", "the answer is 10", "my answer is 10", "answer 10", "it's 10", "the answer is ten"]) {
    const h = harness(); h.startAudio(); h.clock(900); h.result(transcript, true);
    assert.equal(h.answers[0][2], 10, transcript);
  }
  assert.equal(parser.exports.parseSpokenNumber("the answer is 10 or 40"), null);
  assert.equal(parser.exports.parseSpokenNumber("2 + 8 = 10"), null);
});
test("finalized nonnumeric speech keeps listening and eventually offers an unscored retry", () => {
  const h = harness(); h.startAudio(); h.result("unrecognized", true);
  assert.equal(h.answers.length, 0); h.expire(); h.expire();
  assert.equal(h.answers.length, 0); assert.match(h.statuses.at(-1), /no number was recognized/);
  assert.equal(h.context.recognitionRef.current, null);
});

test("a final answer introduction does not commit before a single-syllable number arrives", () => {
  for (const local of [false, true]) {
    for (const [ending, expected] of [["4", 4], ["four", 4], ["for", 4], ["six", 6], ["ate", 8], ["ten", 10]]) {
      const h = harness(); h.context.localSpeechReadyRef.current = local; h.context.listen({ id: "phrase" });
      h.startAudio(); h.clock(800); h.result("The answer is", true);
      assert.equal(h.answers.length, 0); assert.equal(h.feedback.at(-1), null);
      h.clock(1200);
      h.recognition.onresult({ results: [
        {0: {transcript: "The answer is"}, length: 1, isFinal: true},
        {0: {transcript: ending}, length: 1, isFinal: true},
      ] });
      assert.equal(h.answers.length, 1); assert.equal(h.answers[0][2], expected, ending);
    }
  }
});

test("short number alternatives in later segments survive a finalized introduction", () => {
  for (const [word, expected] of [["to", 2], ["too", 2], ["for", 4], ["six", 6], ["ate", 8], ["ten", 10], ["forty", 40]]) {
    const h = harness(); h.startAudio(); h.clock(800); h.result("The answer is", true);
    h.clock(1000);
    h.recognition.onresult({ results: [
      { 0: { transcript: "The answer is" }, length: 1, isFinal: true },
      { 0: { transcript: "" }, 1: { transcript: word }, length: 2, isFinal: true },
    ] });
    assert.equal(h.answers[0][2], expected, word);
  }
});

test("a numeric primary segment wins over other numeric alternatives", () => {
  const h = harness(); h.startAudio(); h.recognition.onresult({ results: [
    { 0: { transcript: "The answer is" }, length: 1, isFinal: true },
    { 0: { transcript: "six" }, 1: { transcript: "eight" }, length: 2, isFinal: true },
  ] });
  assert.equal(h.answers[0][2], 6);
});

test("short homophones and repeated answers are numbers, not sums", () => {
  for (const [text, expected] of [["won", 1], ["to", 2], ["too", 2], ["the answer is to", 2], ["the answer is too", 2], ["two two", 2], ["six six", 6], ["ten, ten", 10], ["forty forty", 40], ["28 28", 28], ["twenty eight twenty eight", 28], ["one hundred and forty four", 144]]) {
    assert.equal(parser.exports.parseSpokenNumber(text), expected, text);
  }
  for (const text of ["The answer is", "go to school", "this is for you", "two or eight", "six ten", "twenty eight six", "silence"]) {
    assert.equal(parser.exports.parseSpokenNumber(text), null, text);
  }
});

test("number hints cover the vocabulary equally and are local-only", () => {
  class Phrase { constructor(phrase, boost) { this.phrase = phrase; this.boost = boost; } }
  const local = { processLocally: true, phrases: [] };
  assert.equal(speech.exports.addNumberHints(local, Phrase), true);
  for (const word of ["two", "four", "six", "eight", "ten", "forty"]) {
    assert.ok(local.phrases.some(p => p.phrase === word && p.boost === 3));
  }
  const browser = { phrases: [] };
  assert.equal(speech.exports.addNumberHints(browser, Phrase), false);
  assert.equal(browser.phrases.length, 0);
  assert.equal(speech.exports.addNumberHints({ processLocally: true }, Phrase), false);
});

test("unsupported native hints retry without changing engines or answer deadline", () => {
  const h = harness(); h.context.localSpeechReadyRef.current = true;
  h.context.window.SpeechRecognitionPhrase = class { constructor(phrase, boost) { this.phrase = phrase; this.boost = boost; } };
  let recognition;
  h.context.window.SpeechRecognition = class { constructor() { recognition = { phrases: [], start() {}, stop() {} }; return recognition; } };
  h.context.listen({id: "local"});
  assert.ok(recognition.phrases.length > 0);
  let starts = 0; recognition.start = () => { starts++; };
  recognition.onerror({ error: "phrases-not-supported" }); recognition.onend();
  assert.equal(starts, 1); assert.equal(recognition.phrases.length, 0);
  assert.equal(recognition.processLocally, true);
  recognition.onaudiostart(); h.clock(600);
  recognition.onresult({results: [{0:{transcript:"two"},length:1,isFinal:true}]});
  assert.equal(h.answers[0][2], 2);
});

test("recognizer ending after an introduction restarts and accepts the following number", () => {
  const h = harness(); let restarts = 0; h.recognition.start = () => { restarts++; };
  h.startAudio(); h.clock(800); h.result("The answer is", true); h.recognition.onend();
  assert.equal(restarts, 1); assert.equal(h.answers.length, 0);
  h.clock(1200); h.startAudio(); h.result("four", true);
  assert.equal(h.answers[0][2], 4); assert.equal(h.context.questionStartRef.current, 0);
});

test("unfinished introduction at deadline waits for a buffered final number", () => {
  const h = harness(); h.startAudio(); h.clock(800); h.result("The answer is", true);
  h.expire(); assert.equal(h.answers.length, 0);
  h.clock(4200); h.result("The answer is 4", true);
  assert.equal(h.answers[0][2], 4);
});
test("51 and fifty-one are recognized even though they are not multiplication products", () => {
  for (const transcript of ["51", "fifty-one"]) {
    const h = harness(); h.startAudio(); h.clock(900); h.result(transcript, true);
    assert.equal(h.answers[0][2], 51); assert.equal(h.answers[0][3], 900);
  }
});

test("a correction after feedback preserves the first answer and cannot award automaticity", () => {
  const begin = source.indexOf("  const allowPendingAnswer = () => {");
  const end = source.indexOf("  const exitPractice =", begin);
  const code = ts.transpileModule(source.slice(begin, end) + "\nglobalThis.accept = allowPendingAnswer;", {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const before = { totalAttempts: 2 };
  let reviewed, retryGrade, feedback, next;
  const context = {
    beforeAnswerRef:{current:{session:{current:{id:"wrong"}}}},
    applyAttemptResult: (before, input) => ({events:[{id:"wrong",disputed:input.disputed}]}),
    beginAnswerExposure: p=>p, persistAutomaticity() {}, setListenState() {},
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
  assert.equal(reviewed, undefined);
  assert.equal(context.attemptsRef.current.length, 2);
  assert.equal(context.attemptsRef.current[0].answerCorrect, false);
  assert.equal(context.attemptsRef.current[1].answerCorrect, false);
  assert.equal(context.attemptsRef.current[1].heard, "51");
  assert.equal(context.attemptsRef.current[1].audit.disputed, true);
  assert.equal(retryGrade, undefined); assert.equal(feedback.tone, "slow");
  assert.equal(next, context.advance);
});
test("network, permission and Safari audio interruptions do not record an answer", () => {
  for (const error of ["network", "not-allowed", "audio-capture", "audio-interrupted"]) {
    const h = harness(); h.startAudio(); h.recognition.onerror({ error });
    assert.equal(h.answers.length, 0); assert.equal(h.context.timeoutRef.current, null);
  }
});
test("startup watchdog and late callbacks do not record an answer", () => {
  const h = harness(); h.expire(); h.startAudio(); h.result("eight", true);
  assert.equal(h.answers.length, 0); assert.match(h.statuses.at(-1), /did not start/);
});
test("manual restart invalidates old results and resets the answer guard", () => {
  const h = harness(); h.startAudio(); const old = h.recognition;
  h.context.listen({ id: "new" }); old.onresult({results: [{0:{transcript:"eight"},length:1,isFinal:true}]});
  assert.equal(h.answers.length, 0);
  h.startAudio(); h.result("nine", true); assert.equal(h.answers[0][2], 9);
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
      preferences: {showTimes:true,successSound:false}, retryRef:{current:false}, beforeAnswerRef:{current:null},
      AUTOMATICITY_CONFIG: {automaticityTargetMs:1500},
      automaticityRef: {current:{session:{current:{id:"presentation",fact:{id:"test"}}}}},
      applyAttemptResult: () => ({events:[{id:"presentation",completedAt:1000}],session:{gradedCount:1}}),
      beginAnswerExposure: p => p, persistAutomaticity() {},
      statesRef: { current: {} }, attemptsRef: { current: [] }, nextRef: { current: null },
      stopListening() {}, answerFor: () => 8, gradeResponse: () => "good",
      defaultState: () => ({}), updateCardState: () => ({}),
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
