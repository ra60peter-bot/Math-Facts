const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('../web/node_modules/typescript');
const modules = new Map();
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => load(path.resolve(path.dirname(file), name + '.ts')) });
  return exports;
}
const { buildRoundQueue } = load(path.join(__dirname, 'round-order.ts'));
const { makeCards, answerFor } = load(path.join(__dirname, '../web/lib/cards.ts'));
function seeded(seed) { return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; }; }
const ids = cards => Array.from(cards, card => card.id);
function neighboringMultiplication(a, b) {
  return [[a.a, a.b], [a.b, a.a]].some(([fixed, other]) =>
    (fixed === b.a && Math.abs(other - b.b) === 1) || (fixed === b.b && Math.abs(other - b.a) === 1));
}

test('every selected orientation appears once before another coverage cycle, including reversed facts', () => {
  const cards = makeCards('mul');
  const queue = buildRoundQueue(cards, 300, seeded(41));
  assert.equal(queue.length, 300);
  for (let start = 0; start < queue.length; start += cards.length) {
    const cycle = queue.slice(start, start + cards.length);
    assert.equal(new Set(ids(cycle)).size, cycle.length);
    if (cycle.length === cards.length) assert.deepEqual(ids(cycle).sort(), ids(cards).sort());
  }
  assert.ok(queue.some(card => card.id === 'mul-7-9'));
  assert.ok(queue.some(card => card.id === 'mul-9-7'));
});

test('full multiplication selection avoids consecutive duplicates, reversals, neighbors, and arithmetic runs across cycles', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const queue = buildRoundQueue(makeCards('mul'), 300, seeded(seed));
    for (let i = 1; i < queue.length; i++) {
      const previous = queue[i - 1], current = queue[i];
      assert.notEqual(current.id, previous.id, `duplicate, seed ${seed}`);
      assert.ok(!(current.a === previous.b && current.b === previous.a), `reverse, seed ${seed}`);
      assert.ok(!neighboringMultiplication(previous, current), `neighbor, seed ${seed}`);
      if (i > 1) assert.notEqual(answerFor(current) - answerFor(previous), answerFor(previous) - answerFor(queue[i - 2]), `arithmetic run, seed ${seed}`);
    }
  }
});

test('a single times table is mixed rather than skip-count order, including the next coverage cycle', () => {
  const cards = makeCards('mul').filter(card => card.a === 3);
  for (let seed = 1; seed <= 40; seed++) {
    const queue = buildRoundQueue(cards, 50, seeded(seed));
    for (let i = 1; i < queue.length; i++) {
      assert.notEqual(queue[i].id, queue[i - 1].id);
      assert.ok(!neighboringMultiplication(queue[i - 1], queue[i]), `adjacent multipliers, seed ${seed}`);
      if (i > 1) assert.notEqual(queue[i].b - queue[i - 1].b, queue[i - 1].b - queue[i - 2].b, `skip-count run, seed ${seed}`);
    }
  }
});

test('one or two selected facts never prevent a requested-length round', () => {
  const single = makeCards('mul').filter(card => card.id === 'mul-3-3');
  assert.deepEqual(ids(buildRoundQueue(single, 50, seeded(1))), Array(50).fill('mul-3-3'));
  const neighbors = makeCards('mul').filter(card => card.a === 3 && [3, 4].includes(card.b));
  const queue = buildRoundQueue(neighbors, 50, seeded(2));
  assert.equal(queue.length, 50);
  for (let i = 1; i < queue.length; i++) assert.notEqual(queue[i].id, queue[i - 1].id);
  const reversed = makeCards('mul').filter(card => (card.a === 3 && card.b === 4) || (card.a === 4 && card.b === 3));
  assert.equal(buildRoundQueue(reversed, 50, seeded(3)).length, 50);
});

test('new rounds and repeat cycles shuffle afresh without changing source cards or excluding addition/subtraction', () => {
  for (const operation of ['add', 'sub', 'mul']) {
    const cards = makeCards(operation);
    const before = JSON.stringify(cards);
    Object.freeze(cards); cards.forEach(Object.freeze);
    const random = seeded(99);
    const first = buildRoundQueue(cards, cards.length * 2, random);
    const next = buildRoundQueue(cards, cards.length, random);
    assert.notDeepEqual(ids(first.slice(0, cards.length)), ids(first.slice(cards.length)));
    assert.notDeepEqual(ids(first.slice(0, cards.length)), ids(next));
    assert.deepEqual(ids(next).sort(), ids(cards).sort());
    assert.equal(JSON.stringify(cards), before);
  }
});

test('empty and invalid lengths terminate cleanly; duplicate input ids do not repeat before coverage', () => {
  const card = makeCards('mul')[0];
  for (const count of [0, -1, NaN, Infinity]) assert.equal(buildRoundQueue([card], count).length, 0);
  assert.equal(buildRoundQueue([], 50).length, 0);
  assert.equal(buildRoundQueue([card], 2.9).length, 2);
  const cards = makeCards('mul').slice(0, 10);
  assert.equal(new Set(ids(buildRoundQueue([...cards, cards[0]], 10, seeded(20)))).size, 10);
});
