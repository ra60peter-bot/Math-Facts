import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function loadMusic(window = {}) {
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(new URL('../lib/celebration.ts', import.meta.url), 'utf8')), { exports, window });
  return exports;
}
const answers = (correct, total) => Array.from({ length: total }, (_, i) => ({ answerCorrect: i < correct }));
test('celebration requires a completed nonempty set and strictly more than 80% correct', () => {
  const { shouldCelebrate } = loadMusic();
  assert.equal(shouldCelebrate(answers(0, 0), 0), false);
  assert.equal(shouldCelebrate(answers(4, 4), 10), false);
  assert.equal(shouldCelebrate(answers(8, 10), 10), false);
  assert.equal(shouldCelebrate(answers(9, 10), 10), true);
  assert.equal(shouldCelebrate(answers(40, 50), 50), false);
  assert.equal(shouldCelebrate(answers(41, 50), 50), true);
  assert.equal(shouldCelebrate(answers(10, 10), 10), true);
});
test('music unlocks from user gesture, stays below five seconds, and stops on cleanup', () => {
  const voices = []; let resumes = 0, disconnected = 0;
  const param = () => ({ setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class AudioContext {
    state = 'running'; currentTime = 10; sampleRate = 48000; destination = {};
    resume() { resumes++; return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { return { connect() {}, start() {} }; }
    createGain() { return { gain: param(), connect() {}, disconnect() { disconnected++; } }; }
    createOscillator() {
      const voice = { frequency: param(), connect() {}, disconnect() {}, start(t) { this.startTime = t; }, stop(t) { this.stopTime = t; if (t === undefined) this.cancelled = true; } };
      voices.push(voice); return voice;
    }
  }
  const music = loadMusic({ AudioContext });
  music.playCelebrationMusic()();
  assert.equal(voices.length, 0);
  music.prepareCelebrationAudio();
  assert.equal(resumes, 1);
  const stop = music.playCelebrationMusic();
  assert.ok(voices.length > 20);
  assert.ok(voices.every(v => v.startTime >= 10 && v.stopTime < 15));
  stop();
  assert.ok(voices.every(v => v.cancelled));
  assert.ok(disconnected > 0);
});
test('missing or blocked browser audio does not prevent the visual celebration', () => {
  for (const window of [{}, { AudioContext: class { constructor() { throw Error('blocked'); } } }]) {
    const music = loadMusic(window);
    assert.doesNotThrow(() => { music.prepareCelebrationAudio(); music.playCelebrationMusic()(); });
  }
});
test('celebration dismisses at five seconds and cancels timer/music when leaving results', () => {
  const effects = [], timers = []; let musicStopped = false, finished = false;
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(new URL('../components/session-celebration.tsx', import.meta.url), 'utf8')), {
    exports, require: name => name === 'react' ? { useEffect: effect => effects.push(effect), useState: v => [v, () => {}] }
      : name === 'react/jsx-runtime' ? { jsx: () => null, jsxs: () => null }
      : { CELEBRATION_MS: 5000, playCelebrationMusic: () => () => { musicStopped = true; } },
    window: { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return 1; }, clearTimeout: id => { assert.equal(id, 1); } },
  });
  exports.SessionCelebration({ onFinished: () => { finished = true; } });
  const cleanups = effects.map(effect => effect());
  assert.equal(timers[0].delay, 5000);
  assert.equal(finished, false);
  timers[0].callback(); assert.equal(finished, true);
  cleanups.forEach(cleanup => cleanup()); assert.equal(musicStopped, true);
});
test('first visit and unavailable storage default dark while saved light stays light', () => {
  const layout = fs.readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  const script = layout.match(/__html: `([^`]+)`/)[1];
  for (const [saved, expected] of [[null, 'dark'], ['dark', 'dark'], ['light', 'light'], ['invalid', 'dark']]) {
    const document = { documentElement: { dataset: { theme: 'dark' } } };
    vm.runInNewContext(script, { document, localStorage: { getItem: () => saved } });
    assert.equal(document.documentElement.dataset.theme, expected);
  }
  const document = { documentElement: { dataset: { theme: 'dark' } } };
  vm.runInNewContext(script, { document, localStorage: { getItem: () => { throw Error('blocked'); } } });
  assert.equal(document.documentElement.dataset.theme, 'dark');
});
