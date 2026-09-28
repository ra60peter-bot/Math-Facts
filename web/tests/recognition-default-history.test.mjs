import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import ts from 'typescript';
import {createElement,Fragment} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const source=fs.readFileSync(new URL('../components/math-facts-app.tsx',import.meta.url),'utf8');
const compile=code=>ts.transpileModule(code,{fileName:'test.tsx',compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
function startup(){
 const states=[],effects=[];let resolve,reject,supported;
 const prepared=new Promise((yes,no)=>{resolve=yes;reject=no;});
 let prepares=0;
 const ctx={window:{SpeechRecognition:class{}},useState:initial=>{const i=states.length;states.push(initial);return [initial,v=>{states[i]=v;}];},useRef:current=>({current}),useCallback:f=>f,useEffect:f=>effects.push(f),prepareNumberSpeech:()=>{prepares++;return prepared;},setSpeechSupported:v=>{supported=v;},setLocalSpeechStatus:()=>{}};
 vm.createContext(ctx);
 const section=source.slice(source.indexOf('  const [numberSpeechStatus'),source.indexOf('  const localSpeechPreparationRef'));
 vm.runInContext(compile(section+'\n globalThis.control={enableNumberSpeech,numberSpeechActiveRef};'),ctx);
 return {states,effects,resolve,reject,ctx,prepares:()=>prepares,supported:()=>supported};
}
test('number recognition prepares automatically on mount and activates only after it is ready',async()=>{
 const h=startup();assert.equal(h.states[0],'loading');assert.equal(h.ctx.control.numberSpeechActiveRef.current,false);
 h.effects[0]();assert.equal(h.prepares(),1);h.resolve();await new Promise(r=>setImmediate(r));
 assert.equal(h.states[0],'ready');assert.equal(h.states[1],true);assert.equal(h.ctx.control.numberSpeechActiveRef.current,true);assert.equal(h.supported(),true);
});
test('unmounted preparation cannot activate recognition and Strict Mode remount can finish',async()=>{
 const h=startup();const cancel=h.effects[0]();cancel();h.resolve();await new Promise(r=>setImmediate(r));
 assert.equal(h.ctx.control.numberSpeechActiveRef.current,false);
 h.effects[0]();await new Promise(r=>setImmediate(r));assert.equal(h.ctx.control.numberSpeechActiveRef.current,true);
});
test('failed number model keeps browser fallback available and displays an error',async()=>{
 const h=startup();h.effects[0]();h.reject(new Error('Download failed'));await new Promise(r=>setImmediate(r));
 assert.equal(h.states[0],'failed');assert.equal(h.ctx.control.numberSpeechActiveRef.current,false);assert.equal(h.supported(),true);assert.ok(h.states[2]);
});
test('expanded history shows the original wrong answer, correct answers, and missing transcript distinctly',()=>{
 let state=0;
 const exports={};
 const history=source.slice(source.indexOf('function SessionHistory('),source.indexOf('async function accountRequest('));
 vm.runInNewContext(compile(history+'\n exports.SessionHistory=SessionHistory;'),{exports,React:{createElement,Fragment},Fragment,
  useState:initial=>[++state===2?'session':initial,()=>{}],useId:()=> 'history',operationLabel:()=> 'Multiplication',
  sortHistoryAttempts:attempts=>attempts.map((attempt,index)=>({attempt,questionNumber:index+1})),historyResult:a=>a.answerCorrect?'correct':'wrong',
 });
 const markup=renderToStaticMarkup(exports.SessionHistory({sessions:[{id:'session',operation:'mul',endedAt:'2026-09-27T00:00:00Z',attempts:[
  {id:'a',fact:'4 × 7',heard:'twenty six',answerCorrect:false,responseMs:1200},
  {id:'b',fact:'4 × 7',heard:'twenty eight',answerCorrect:true,responseMs:1000},
  {id:'c',fact:'4 × 7',heard:'',answerCorrect:false,responseMs:4000},
 ]}]}));
 assert.match(markup,/Answer heard/);assert.match(markup,/twenty six/);assert.match(markup,/twenty eight/);assert.match(markup,/No answer recorded/);
 assert.equal((markup.match(/>Wrong<\/span>/g)||[]).length,2);
});

