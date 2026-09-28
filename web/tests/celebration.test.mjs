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
test('five distinct arrangements unlock from user gesture, fill eight seconds, and stop on cleanup', () => {
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
  const signatures = new Set();
  for (const theme of music.MUSIC_THEMES) {
    voices.length = 0;
    const stop = music.playCelebrationMusic(theme);
    assert.ok(voices.length > 20, theme);
    assert.ok(voices.every(v => v.startTime >= 10 && v.stopTime < 18), theme);
    assert.ok(Math.max(...voices.map(v => v.stopTime)) > 17.8, theme);
    signatures.add(JSON.stringify(voices.map(v => [v.type, v.startTime, v.stopTime])));
    stop();
    assert.ok(voices.every(v => v.cancelled), theme);
  }
  assert.equal(signatures.size, 5);
  assert.ok(disconnected > 0);
});
test('missing or blocked browser audio does not prevent the visual celebration', () => {
  for (const window of [{}, { AudioContext: class { constructor() { throw Error('blocked'); } } }]) {
    const music = loadMusic(window);
    assert.doesNotThrow(() => { music.prepareCelebrationAudio(); music.playCelebrationMusic()(); });
  }
});
test('celebration dismisses at eight seconds and cancels timer/music when leaving results', () => {
  const effects = [], timers = []; let musicStopped = false, finished = false;
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(new URL('../components/session-celebration.tsx', import.meta.url), 'utf8')), {
    exports, require: name => name === 'react' ? { useEffect: effect => effects.push(effect), useState: v => [v, () => {}] }
      : name === 'react/jsx-runtime' ? { jsx: () => null, jsxs: () => null }
      : { CELEBRATION_MS: loadMusic().CELEBRATION_MS, playCelebrationMusic: theme => { assert.equal(theme, 'waltz'); return () => { musicStopped = true; }; } },
    window: { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return 1; }, clearTimeout: id => { assert.equal(id, 1); } },
  });
  exports.SessionCelebration({ choice: { music: 'waltz', visual: 'rockets' }, onFinished: () => { finished = true; } });
  const cleanups = effects.map(effect => effect());
  assert.equal(timers[0].delay, 8000);
  assert.equal(finished, false);
  timers[0].callback(); assert.equal(finished, true);
  cleanups.forEach(cleanup => cleanup()); assert.equal(musicStopped, true);
});
test('music and visuals shuffle independently, cover each group, and avoid consecutive repeats', () => {
  const { createCelebrationPicker, MUSIC_THEMES, VISUAL_THEMES } = loadMusic();
  let seed = 123456;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = createCelebrationPicker(random), combinations = new Set();
  let previous;
  for (let round = 0; round < 100; round++) {
    const choices = Array.from({ length: 5 }, () => pick());
    assert.equal(new Set(choices.map(c => c.music)).size, 5);
    assert.equal(new Set(choices.map(c => c.visual)).size, 5);
    for (const choice of choices) {
      assert.ok(MUSIC_THEMES.includes(choice.music)); assert.ok(VISUAL_THEMES.includes(choice.visual));
      if (previous) { assert.notEqual(choice.music, previous.music); assert.notEqual(choice.visual, previous.visual); }
      combinations.add(`${choice.music}:${choice.visual}`); previous = choice;
    }
  }
  assert.equal(combinations.size, 25, 'No tune is tied to one visual');
  const streamA = [0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4];
  const streamB = [0.1, 0.2, 0.3, 0.4, 0.9, 0.8, 0.7, 0.6];
  const firstA = createCelebrationPicker(() => streamA.shift())();
  const firstB = createCelebrationPicker(() => streamB.shift())();
  assert.equal(firstA.music, firstB.music);
  assert.notEqual(firstA.visual, firstB.visual, 'Visuals draw their own randomness');
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
