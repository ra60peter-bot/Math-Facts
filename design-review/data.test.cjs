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
  vm.runInNewContext(code, { exports, Date, Intl, BigInt, require: name => load(path.resolve(path.dirname(file), name + '.ts')) });
  return exports;
}
const D = load(path.join(__dirname, 'data.ts'));
const card = D.makeCards('mul').find(card => card.id === 'mul-12-12');
const result = extra => ({ card, outcome: 'fast', heard: '144', ms: 1080, mode: 'speech', retry: false, ...extra });
const round = (results, extra = {}) => ({ id: 'round-1', student: 'New learner', operation: 'mul', results, total: results.length, at: '2026-10-05T12:00:00Z', problems: 0, ...extra });

test('new profiles begin unassessed; only named demonstration learners have seeded progress', () => {
  assert.equal(D.summary('New learner', 'mul', []).score, 0);
  assert.equal(D.summary('New learner', 'mul', []).verified, 0);
  assert.ok(D.summary('Maya', 'mul', []).verified > 0);
});
for (const [name, extra] of Object.entries({ typed: { mode: 'keyboard' }, retry: { retry: true }, disputed: { outcome: 'disputed' }, untimed: { outcome: 'untimed', ms: null }, estimated: { timing: 'estimated' }, unavailable: { timing: 'unavailable' }, zero: { ms: 0 }, nonfinite: { ms: NaN } })) {
  test(`${name} responses cannot update spoken speed, score, or mastery`, () => {
    const item = result(extra), rounds = [round([item])];
    const progress = D.withRounds('New learner', rounds);
    assert.equal(progress.facts[card.id].latest, null);
    assert.equal(D.summary('New learner', 'mul', rounds).score, 0);
    assert.equal(D.summary('New learner', 'mul', rounds).verified, 0);
    assert.equal(D.roundMetrics(rounds[0]).timed.length, 0);
  });
}
test('accuracy retains typed and untimed answers but excludes disputes', () => {
  const metrics = D.roundMetrics(round([result({ mode: 'keyboard', outcome: 'untimed', ms: null }), result({ outcome: 'untimed', ms: null }), result({ outcome: 'wrong' }), result({ outcome: 'disputed' })]));
  assert.equal(metrics.scored.length, 3);
  assert.equal(metrics.correct, 2);
  assert.equal(metrics.timed.length, 1);
});
test('arbitrarily repeated fast practice improves only one fact, never awards cold mastery or another operation', () => {
  const rounds = Array.from({ length: 100 }, (_, i) => round([result()], { id: `round-${i}` }));
  const summary = D.summary('New learner', 'mul', rounds);
  assert.equal(summary.assessed, 1);
  assert.equal(summary.verified, 0);
  assert.equal(summary.coldChecks, 0);
  assert.equal(summary.score, Math.round(1000 / 121));
  assert.equal(D.summary('New learner', 'add', rounds).score, 0);
});
test('latest valid dated evidence wins regardless of list order, with reversed facts independent', () => {
  const reverse = D.makeCards('mul').find(card => card.id === 'mul-8-7');
  const ordered = D.makeCards('mul').find(card => card.id === 'mul-7-8');
  const later = round([result({ card: ordered, outcome: 'wrong', heard: '57' })], { at: '2026-10-06T12:00:00Z' });
  const earlier = round([result({ card: ordered }), result({ card: reverse })]);
  const progress = D.withRounds('New learner', [later, earlier]);
  assert.equal(D.factStatus(progress, ordered), 'practice');
  assert.equal(D.factStatus(progress, reverse), 'fast');
});
