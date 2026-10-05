const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('../web/node_modules/typescript');

const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const music = {};
vm.runInNewContext(compile(path.join(__dirname, '../web/lib/celebration.ts')), { exports: music, window: {} });

// Small dependency-aware hook renderer: unlike a static component stub this
// exercises rerenders, effect cleanup, persistent refs, and mute state changes.
function harness() {
  const slots = [], timers = new Map(), voices = [];
  let cursor = 0, now = 0, timerId = 0, pending = [], tree, props;
  const React = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { ref: { current: initial } };
      return slots[index].ref;
    },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const api = {};
  const runtime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  vm.runInNewContext(compile(path.join(__dirname, 'round-celebration.tsx')), {
    exports: api,
    require(name) {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return runtime;
      if (name.endsWith('/session-celebration')) return { VISUAL_SCENES: {
        confetti: { caption: 'The blobs are going bananas!', mascot: 'party-blob', colors: ['a', 'b', 'c', 'd'] },
      } };
      if (name.endsWith('/lib/celebration')) return { ...music, playCelebrationMusic(theme) {
        const voice = { theme, active: true, stops: 0 }; voices.push(voice);
        return () => { voice.active = false; voice.stops++; };
      } };
      throw new Error(`Unexpected import: ${name}`);
    },
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  });
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
    return predicate(node) ? node : find(node.props?.children, predicate);
  }
  return {
    api, timers, voices,
    get tree() { return tree; },
    render(next = props) {
      props = next; cursor = 0; pending = [];
      tree = api.RoundCelebration(props);
      pending.forEach(effect => effect());
      return tree;
    },
    button(label) { return find(tree, node => node.type === 'button' && node.props['aria-label'] === label); },
    status() { return find(tree, node => node.props?.role === 'status'); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].callback();
      }
      now = until;
    },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}
const choice = { music: 'bounce', visual: 'confetti' };
const round = (outcomes, total = 10) => ({ total, results: outcomes.map(outcome => ({ outcome })) });

test('wrapper celebrates only completed rounds with strictly more than 80% correct', () => {
  const { shouldCelebrateRound } = harness().api;
  assert.equal(shouldCelebrateRound(round(Array(8).fill('fast').concat(['wrong', 'wrong']))), false);
  assert.equal(shouldCelebrateRound(round(Array(9).fill('fast').concat('wrong'))), true);
  assert.equal(shouldCelebrateRound(round(Array(9).fill('fast'))), false);
  assert.equal(shouldCelebrateRound(round([], 0)), false);
  assert.equal(shouldCelebrateRound(round(Array(8).fill('fast').concat(['wrong', 'disputed']))), false);
  assert.equal(shouldCelebrateRound(round(Array(9).fill('slow').concat('untimed'))), true);
});

test('parent rerenders and new callback identities do not extend the eight-second duration or restart audio', () => {
  const h = harness(); let oldFinished = 0, latestFinished = 0;
  h.render({ choice, onFinished: () => oldFinished++ });
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].at, 8000);
  h.advance(3000);
  h.render({ choice: { ...choice }, onFinished: () => latestFinished++ });
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].at, 8000);
  assert.equal(h.voices.length, 1);
  h.advance(4999);
  assert.equal(latestFinished, 0);
  h.advance(1);
  assert.equal(oldFinished, 0);
  assert.equal(latestFinished, 1);
  h.unmount();
  assert.equal(h.timers.size, 0);
  assert.equal(h.voices[0].active, false);
  assert.equal(h.voices[0].stops, 1);
});

test('Mute stops audio immediately while preserving the visible celebration and original expiry', () => {
  const h = harness(); let finished = 0;
  h.render({ choice, onFinished: () => finished++ });
  h.advance(1000);
  h.button('Mute celebration music').props.onClick();
  h.render();
  assert.equal(h.button('Mute celebration music').props.disabled, true);
  assert.equal(h.voices[0].active, false);
  assert.equal(h.voices[0].stops, 1);
  assert.ok(h.status());
  assert.equal([...h.timers.values()][0].at, 8000);
  h.advance(7000);
  assert.equal(finished, 1);
  h.unmount();
  assert.equal(h.voices[0].stops, 1);
});

test('dismissal and navigation cleanup cancel the expiry timer and all celebration audio', () => {
  const h = harness(); let dismissed = 0;
  h.render({ choice, onFinished: () => dismissed++ });
  h.advance(500);
  h.button('Dismiss celebration').props.onClick();
  h.unmount();
  assert.equal(dismissed, 1);
  assert.equal(h.timers.size, 0);
  assert.ok(h.voices.every(voice => !voice.active && voice.stops === 1));
  h.advance(10000);
  assert.equal(dismissed, 1);
});

test('sound and motion preferences retain the congratulation and gumdrop mascot without playing audio', () => {
  const h = harness();
  h.render({ choice, onFinished() {}, sound: false, motion: false });
  assert.equal(h.voices.length, 0);
  assert.equal(h.tree.props['data-motion'], 'reduced');
  assert.ok(h.status());
  assert.equal(h.button('Mute celebration music').props.disabled, true);
  assert.equal(h.timers.size, 1);
  h.unmount();
});
