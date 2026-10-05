const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('../web/node_modules/typescript');

function harness({ calibration = false, autoMark = true } = {}) {
  let now = 1000, timerId = 0, marked, ready = 0, processing = 0, primed = 0, released = 0;
  const timers = new Map(), instances = [], answers = [], failures = [], transcripts = [], modules = new Map();
  class Recognition {
    start() { this.started = true; }
    beginAnswerWindow(at) { this.window = at; }
    stop() { this.stops = (this.stops ?? 0) + 1; }
    abort() { this.aborts = (this.aborts ?? 0) + 1; }
    constructor() { instances.push(this); }
  }
  const context = {
    performance: { now: () => now },
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  };
  function load(file) {
    file = path.resolve(file);
    if (modules.has(file)) return modules.get(file);
    const exports = {}; modules.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { ...context, exports, require(name) {
      if (name.endsWith('/number-speech')) return { NumberSpeechRecognition: Recognition, prepareNumberSpeech: () => Promise.resolve() };
      if (name.endsWith('/safari-number-audio')) return { prepareSafariNumberAudio() { primed++; }, releaseSafariNumberAudio() { released++; } };
      return load(path.resolve(path.dirname(file), name + '.ts'));
    } });
    return exports;
  }
  const api = load(path.join(__dirname, 'live-voice.ts'));
  const opts = { calibration, onReady(mark) { ready++; marked = mark; if (autoMark) mark(now); }, onProcessing() { processing++; }, onTranscript(text) { transcripts.push(text); }, onAnswer(...values) { answers.push(values); }, onFailure(text) { failures.push(text); } };
  const handle = api.startVoiceAttempt(opts);
  return {
    api, opts, handle, instances, answers, failures, transcripts, timers,
    get rec() { return instances.at(-1); }, get now() { return now; }, get ready() { return ready; }, get processing() { return processing; }, get primed() { return primed; }, get released() { return released; },
    mark() { marked(now); },
    capture() { this.rec.onaudiostart(); },
    result(text, isFinal, onset) { this.rec.onresult?.({ results: [{ 0: { transcript: text }, length: 1, isFinal }], speechStartedAt: onset }); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].callback();
      }
      now = until;
    },
  };
}

test('capture startup and render wait consume no question time; the deadline begins at visible reveal', () => {
  const h = harness({ autoMark: false });
  h.advance(6000); h.capture(); h.advance(500);
  assert.equal(h.ready, 1); assert.equal(h.rec.window, undefined);
  h.mark(); const shown = h.now;
  assert.equal(h.rec.window, shown);
  h.advance(3999); assert.equal(h.rec.stops, undefined);
  h.advance(1); assert.equal(h.rec.stops, 1); assert.equal(h.processing, 1);
  assert.equal(h.failures.length, 0); // Buffered decoding still has its grace window.
});

for (const [phrase, value] of [['six', 6], ['eight', 8], ['ten', 10], ['forty', 40], ['one oh eight', 108], ['one thirty two', 132], ['the answer is four', 4]]) {
  test(`completed '${phrase}' is accepted with acoustic onset, not later transcript arrival`, () => {
    const h = harness(); h.capture(); const shown = h.now;
    h.advance(2300); h.result(phrase, true, shown + 780);
    assert.deepEqual(h.answers[0], [value, phrase, 780]);
    assert.equal(h.rec.aborts, 1); assert.equal(h.timers.size, 0); assert.equal(h.failures.length, 0);
  });
}

test('partial numeric prefixes never commit or flash a wrong answer', () => {
  const h = harness(); h.capture(); const shown = h.now;
  h.result('one', false); h.result('one thirty', false);
  assert.equal(h.answers.length, 0); assert.deepEqual(h.transcripts, ['one', 'one thirty']);
  h.result('one thirty two', true, shown + 900);
  assert.deepEqual(h.answers[0], [132, 'one thirty two', 900]);
});

test('a finalized introduction remains open for its number', () => {
  const h = harness(); h.capture(); const shown = h.now;
  h.result('the answer is', true); assert.equal(h.answers.length, 0); assert.equal(h.rec.aborts, undefined);
  h.result('four', true, shown + 750); assert.equal(h.answers[0][0], 4);
});

test('the capture deadline drains a buffered short answer without abandoning it', () => {
  const h = harness(); h.capture(); const shown = h.now;
  h.result('ten', false); h.advance(4000);
  assert.equal(h.rec.stops, 1); assert.equal(h.rec.aborts, undefined);
  h.advance(500); h.result('ten', true, shown + 800);
  assert.deepEqual(h.answers[0], [10, 'ten', 800]);
});

test('silence and an unfinished partial are technical recovery, never a wrong answer', () => {
  for (const partial of ['', 'one']) {
    const h = harness(); h.capture(); if (partial) h.result(partial, false);
    h.advance(7000);
    assert.equal(h.answers.length, 0); assert.equal(h.failures.length, 1); assert.match(h.failures[0], /Nothing was scored/);
  }
});

test('missing, zero, early, and out-of-window onset do not manufacture a fast response', () => {
  for (const offset of [undefined, 0, 20, -50, 4500]) {
    const h = harness(); h.capture(); h.advance(2000);
    h.result('eight', true, offset === undefined ? undefined : 1000 + offset);
    assert.deepEqual(h.answers[0], [8, 'eight', null]);
  }
});

test('calibration allows ten seconds and never supplies practice timing', () => {
  const h = harness({ calibration: true }); h.capture();
  h.advance(6000); assert.equal(h.rec.stops, undefined);
  h.result('forty', true, 1500); assert.deepEqual(h.answers[0], [40, 'forty', null]);
});

test('cancel, replacement, and exit abort capture and suppress stale callbacks', () => {
  const h = harness(); h.capture();
  const old = h.rec, lateResult = old.onresult;
  h.api.startVoiceAttempt(h.opts);
  assert.equal(old.aborts, 1);
  lateResult({ results: [{ 0: { transcript: 'four' }, length: 1, isFinal: true }], speechStartedAt: 1900 });
  assert.equal(h.answers.length, 0);
  h.api.unlockVoice(); assert.equal(h.primed, 1);
  h.api.releaseVoiceAudio(); assert.equal(h.rec.aborts, 1); assert.equal(h.released, 1); assert.equal(h.timers.size, 0);
});

test('permission failures settle once with a useful unscored recovery message', () => {
  const h = harness(), onend = h.rec.onend;
  h.rec.onerror({ error: 'not-allowed' }); onend(); h.advance(20000);
  assert.equal(h.failures.length, 1); assert.match(h.failures[0], /Allow the microphone/); assert.equal(h.answers.length, 0);
});
