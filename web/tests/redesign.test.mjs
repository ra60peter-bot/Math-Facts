import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

function modules(storage = new Map()) {
  const cache = new Map();
  function load(name) {
    const file = path.resolve(import.meta.dirname, '..', name);
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { exports, Date, Intl, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, require: name => load(path.relative(path.resolve(import.meta.dirname, '..'), path.resolve(path.dirname(file), name + '.ts'))) });
    return exports;
  }
  return load;
}

test('one successful microphone check survives reloads and students, but stays in its browser storage', () => {
  const storage = new Map(), first = modules(storage)('lib/practice-preferences.ts');
  assert.equal(first.microphoneConfirmed(), false);
  assert.equal(first.confirmMicrophone(), true);
  const nextVisit = modules(storage)('lib/practice-preferences.ts');
  assert.equal(nextVisit.microphoneConfirmed(), true);
  assert.equal(modules()('lib/practice-preferences.ts').microphoneConfirmed(), false);
  storage.clear(); assert.equal(nextVisit.microphoneConfirmed(), false);
});

test('uncertain timing, retries and disputes record usage without changing prior mastery or speed evidence', () => {
  const load = modules(), A = load('lib/automaticity.ts'), { makeCards } = load('lib/cards.ts');
  const card = makeCards('mul')[0];
  for (const flags of [{ timingReliable:false }, { retry:true }, { disputed:true }]) {
    let progress = A.createAutomaticProgress('learner', [card]);
    progress.facts[card.id].stage = 'MAINTENANCE';
    progress.facts[card.id].coldStreak = 4;
    progress = A.startAutomaticSession(progress, { id:'round', operation:'mul', cards:[card], targetCount:10 });
    progress = A.presentQuestion(progress, {kind:'question',fact:card,attemptKind:'extra'});
    progress = A.applyAttemptResult(progress, {presentationId:progress.session.current.id, correct:!flags.disputed, responseMs:80, heard:'four', ...flags});
    assert.equal(progress.session.gradedCount, 1);
    assert.equal(progress.events.length, 1);
    assert.equal(progress.events[0].qualifiedCold, false);
    assert.equal(progress.facts[card.id].coldStreak, 4);
    assert.equal(progress.facts[card.id].stage, 'MAINTENANCE');
    assert.equal(progress.facts[card.id].latest, null);
  }
});

test('session averages and accuracy separate disputed answers, retries and unknown timing', () => {
  const {practiceMetrics} = modules()('lib/practice-metrics.ts');
  const m = practiceMetrics([
    {answerCorrect:true,responseMs:760}, {answerCorrect:false,responseMs:1240},
    {answerCorrect:true,responseMs:0,audit:{timingReliable:false}},
    {answerCorrect:true,responseMs:100,audit:{retry:true}},
    {answerCorrect:false,responseMs:900,audit:{disputed:true}},
  ]);
  assert.equal(m.scored.length, 4); assert.equal(m.correct, 3);
  assert.equal(m.timed.length, 2); assert.equal(m.averageMs, 1000);
});

test('report never presents a retry or missing boundary as a new fast fact', () => {
  const {buildProgressReport} = modules()('lib/progress-report.ts');
  const attempts = [{id:'a',fact:'2 × 2',operation:'mul',at:'2026-10-05T12:00:00Z',answerCorrect:true,responseMs:0,audit:{factId:'mul-2-2',timingReliable:false,firstAnswerCorrect:true}}];
  const report = buildProgressReport('mul', [{id:'s',operation:'mul',endedAt:'2026-10-05T12:00:00Z',attempts}]);
  assert.equal(report.averageMs, null); assert.equal(report.counts.fast, 0);
  assert.equal(report.accuracy, 100);
});

test('multiplication avoids adjacent skip-counting prompts whenever its eligible pool has an alternative', () => {
  const load = modules(), A = load('lib/automaticity.ts'), {makeCards} = load('lib/cards.ts');
  const cards = makeCards('mul').filter(c => c.a === 3);
  let now = Date.parse('2026-10-05T12:00:00Z'), progress = A.createAutomaticProgress('learner', cards, {}, 'UTC', () => now);
  progress = A.startAutomaticSession(progress, {id:'randomized',operation:'mul',cards,targetCount:10}, () => now, () => .999);
  const order = [];
  for (let i=0; i<8; i++) {
    const next = A.selectNextQuestion(progress,cards,()=>now,()=>.5);
    assert.equal(next.kind,'question'); order.push(next.fact.b);
    progress = A.presentQuestion(progress,next,()=>now);
    now += 1000;
    progress = A.applyAttemptResult(progress,{presentationId:progress.session.current.id,correct:true,responseMs:900},()=>now);
    now += 1500;
  }
  for(let i=1;i<order.length;i++) assert.notEqual(Math.abs(order[i]-order[i-1]),1,order.join(','));
  assert.equal(new Set(order).size,order.length);
});
