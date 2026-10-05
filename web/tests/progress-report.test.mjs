import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const cache = new Map();
function load(relative) {
  let file = path.resolve(import.meta.dirname, '..', relative);
  if (!fs.existsSync(file) && file.endsWith(".ts")) file += "x";
  if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {fileName:file, compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(source, {exports, Date, Intl, require: name => name === 'react' ? React : name === 'react/jsx-runtime' ? jsx : load(path.relative(path.resolve(import.meta.dirname,'..'),path.resolve(path.dirname(file),name+'.ts')))});
  return exports;
}
const jsx = await import('react/jsx-runtime');
const {buildProgressReport:build,progressNarrative,reportLabels} = load('lib/progress-report.ts');
const A = load('lib/automaticity.ts'), {makeCards} = load('lib/cards.ts');
const attempt = (id, fact='2 × 3', responseMs=1000, answerCorrect=true, extra={}) => ({id, fact, operation:'mul',responseMs,answerCorrect,at:`2026-09-${id.padStart(2,'0')}T12:00:00Z`,...extra});
const session = (id, attempts, operation='mul') => ({id,operation,endedAt:`2026-09-${id.padStart(2,'0')}T13:00:00Z`,attempts});

test('report includes the whole operation, preserves ordered facts, and keeps operations separate',()=>{
  const sessions=[session('1',[attempt('1')]),session('2',[attempt('2','3 × 2',2000)]),session('3',[attempt('3','2 + 3',800,true,{operation:'add'})],'add')];
  const report=build('mul',sessions);
  assert.equal(report.total,121);assert.equal(report.practiced,2);assert.equal(report.count,2);
  assert.equal(report.facts.find(f=>f.card.id==='mul-2-3').status,'fast');
  assert.equal(report.facts.find(f=>f.card.id==='mul-3-2').status,'slow');
  assert.equal(build('add',sessions).total,81);assert.equal(build('add',sessions).count,1);
  assert.equal(build('sub',sessions).total,45);assert.equal(build('sub',sessions).count,0);
});

test('only scheduler verification earns mastery; wrong and assisted answers need practice',()=>{
  const progress=A.createAutomaticProgress('student',makeCards('mul'));
  progress.facts['mul-2-3'].stage='MAINTENANCE';
  const report=build('mul',[session('1',[attempt('1'),attempt('2','4 × 2',1500),attempt('3','5 × 2',1501),attempt('4','6 × 2',500,false),attempt('5','7 × 2',800,true,{audit:{factId:'mul-7-2',firstAnswerCorrect:false,assisted:true,result:'WRONG_OR_ASSISTED'}})])],progress);
  assert.equal(report.counts.mastered,1);assert.equal(report.counts.fast,1);assert.equal(report.counts.slow,1);assert.equal(report.counts.practice,2);
  assert.equal(report.accuracy,60);
});

test('averages keep hundredth precision and exclude invalid and abandoned events',()=>{
  const report=build('mul',[session('1',[attempt('1','2 × 3',755),attempt('2','2 × 3',765),attempt('3','2 × 3',4000,false),attempt('4','2 × 3',0,false,{audit:{result:'INVALID'}}),attempt('5','2 × 3',0,false,{audit:{result:'ABANDONED'}})])]);
  assert.equal(report.count,3);assert.equal(report.averageMs,760);assert.equal(report.counts.practice,1);
  assert.equal((report.facts.find(f=>f.card.id==='mul-2-3').averageMs/1000).toFixed(2),'0.76');
});

test('latest saved learning state survives deleted history without recreating attempt counts',()=>{
  const progress=A.createAutomaticProgress('student',makeCards('mul'));
  progress.facts['mul-2-3'].stage='MAINTENANCE';
  progress.facts['mul-2-3'].latest={correct:true,firstAnswerCorrect:true,assisted:false,result:'FAST_CORRECT',responseMs:1200,completedAt:Date.parse('2026-09-20')};
  const report=build('mul',[],progress);
  assert.equal(report.counts.mastered,1);assert.equal(report.count,0);assert.equal(report.accuracy,null);
  assert.equal(report.facts.find(f=>f.card.id==='mul-2-3').latestMs,1200);
});

test('comparison sorts sessions chronologically and reports declines honestly',()=>{
  const sessions=[session('2',[attempt('2','2 × 3',4000,false)]),session('1',[attempt('1')])];
  const report=build('mul',sessions),text=progressNarrative(report,'Alex').join(' ');
  assert.equal(report.windowSize,1);assert.equal(report.recent.accuracy,0);assert.equal(report.previous.accuracy,100);
  assert.match(text,/decreased, from 100% to 0%/);assert.doesNotMatch(text,/time averaged/);
});

test('narratives stay 100–200 words for empty, early, improving and declining histories',()=>{
  for(const sessions of [[],[session('1',[attempt('1')])],[session('1',[attempt('1','2 × 3',2500)]),session('2',[attempt('2')])],[session('1',[attempt('1')]),session('2',[attempt('2','2 × 3',4000,false)])]]) {
    const report=build('mul',sessions),text=progressNarrative(report,'Alex').join(' '),count=text.split(/\s+/).length;
    assert.ok(count>=100&&count<=200,`${count} words: ${text}`);
    if(sessions.length<2) assert.match(text,/cannot describe a performance trend|After you have two sessions/);
  }
});

test('report markup exposes accessible tabs, filters and all fact statuses without edit controls',()=>{
  const {HistoryProgress}=load('components/history-progress.tsx');
  const markup=renderToStaticMarkup(React.createElement(HistoryProgress,{name:'Alex',sessions:[]},React.createElement('p',null,'Session history')));
  assert.match(markup,/role="tablist"/);assert.match(markup,/Progress report/);assert.match(markup,/How you’re doing/);
  assert.match(markup,/All 81 addition facts/);assert.match(markup,/Show facts/);
  for(const label of Object.values(reportLabels)) assert.ok(markup.includes(label));
  assert.doesNotMatch(markup,/Delete|Edit/);
});
