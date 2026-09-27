import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..");
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const parser = { exports: {} };
vm.runInNewContext(compile("lib/number-parser.ts"), {exports: parser.exports});

async function harness({ pendingPermission = false } = {}) {
  const events = [], buffers = [], outputs = [], timers = new Map();
  let decoder, capture, resolveStream, stops = 0, removals = 0, closed = 0;
  const stream = {getTracks: () => [{stop: () => {stops++;}}]};
  class Model {
    ready = true;
    on(event, cb) {if(event === "load") queueMicrotask(() => cb({event:"load",result:true}));}
    terminate() {}
    KaldiRecognizer = class {
      handlers = {};
      constructor(rate, grammar) {decoder = this; this.grammar = grammar;}
      on(event, cb) {this.handlers[event] = cb;}
      setWords(enabled) {this.words = enabled;}
      acceptWaveformFloat(samples) {buffers.push(samples); events.push("buffer");}
      retrieveFinalResult() {events.push("final-request");}
      remove() {removals++;}
    };
  }
  const exports = {};
  const context = {
    exports, require: name => name === "vosk-browser" ? {Model} : parser.exports,
    performance: {now: () => 1000},
    window: {setTimeout: fn => {const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)},
    navigator: {mediaDevices:{getUserMedia: () => pendingPermission ? new Promise(resolve=>{resolveStream=resolve;}) : Promise.resolve(stream)}},
    AudioContext: class {
      sampleRate = 16000; currentTime = 0.5; destination = {};
      audioWorklet = {addModule: async () => {}};
      resume() {return Promise.resolve();}
      close() {closed++;return Promise.resolve();}
      createMediaStreamSource() {return {connect() {},disconnect() {}};}
    },
    AudioWorkletNode: class {
      constructor() {capture = this;}
      port = {onmessage: null, postMessage: data => events.push(data), close() {}};
      connect() {} disconnect() {}
    }, DOMException,
  };
  vm.runInNewContext(compile("lib/number-speech.ts"),context);
  await exports.prepareNumberSpeech();
  const recognition = new exports.NumberSpeechRecognition();
  recognition.onresult = event => outputs.push(event.results[0]);
  recognition.start();
  await new Promise(resolve => setImmediate(resolve));
  return {recognition,events,buffers,outputs,exports,
    get decoder() {return decoder;}, get capture() {return capture;},
    get stops() {return stops;}, get removals() {return removals;}, get closed() {return closed;},
    async allowPermission() {resolveStream(stream);await new Promise(resolve=>setImmediate(resolve));},
  };
}

test("number decoder receives quiet audio without a volume gate and includes wrong numbers", async () => {
  const h=await harness();
  h.capture.port.onmessage({data:{samples:new Float32Array([0.0001,0.0002])}});
  assert.equal(h.buffers.length,1);
  const grammar=JSON.parse(h.decoder.grammar);
  for(const number of ["two","six","eight","ten","forty","fifty one","two hundred twenty five","[unk]"]) assert.ok(grammar.includes(number),number);
  h.recognition.abort();
});

test("stopping capture flushes the last audio chunk before requesting a final result", async () => {
  const h=await harness();h.recognition.stop();
  assert.equal(h.stops,1);assert.equal(h.events.at(-1),"stop");
  assert.ok(!h.events.includes("final-request"));
  h.capture.port.onmessage({data:{samples:new Float32Array([0.1])}});
  h.capture.port.onmessage({data:{stopped:true}});
  assert.deepEqual(h.events.slice(-2),["buffer","final-request"]);
  h.decoder.handlers.result({event:"result",result:{text:"two"}});
  assert.equal(h.outputs[0][0].transcript,"two");assert.equal(h.outputs[0].isFinal,true);
  assert.equal(h.removals,1);assert.equal(h.closed,1);
});

test("interim feedback is immediate, final answers can be wrong, and abort ignores late decoding", async () => {
  const h=await harness();
  h.decoder.handlers.partialresult({event:"partialresult",result:{partial:"six"}});
  assert.equal(h.outputs[0][0].transcript,"six");assert.equal(h.outputs[0].isFinal,false);
  h.decoder.handlers.result({event:"result",result:{text:"fifty one"}});
  assert.equal(h.outputs[1][0].transcript,"fifty one");
  h.recognition.abort();h.decoder.handlers.result({event:"result",result:{text:"ten"}});
  assert.equal(h.outputs.length,2);assert.equal(h.stops,1);
});

test("cancelling while microphone permission is pending stops the stream when it arrives", async () => {
  const h=await harness({pendingPermission:true});h.recognition.abort();await h.allowPermission();
  assert.equal(h.stops,1);assert.equal(h.closed,1);assert.equal(h.decoder,undefined);
});

test("startup noise never fires speech onset; word times use captured frames rather than delivery time", async () => {
  const h=await harness(); let speechEvents=0; const resultEvents=[];
  h.recognition.onspeechstart=()=>speechEvents++;
  h.recognition.onresult=event=>resultEvents.push(event);
  assert.equal(h.decoder.words,true);
  // First captured sample is at context 0.6s => performance 1100ms.
  h.capture.port.onmessage({data:{samples:new Float32Array([0.1,0.2]),startFrame:9600}});
  assert.equal(speechEvents,0);
  h.decoder.handlers.partialresult({event:"partialresult",result:{partial:"twenty"}});
  assert.equal(resultEvents[0].speechStartedAt,undefined);
  h.decoder.handlers.result({event:"result",result:{text:"twenty seven",result:[
    {word:"[unk]",start:0.1,end:0.2}, {word:"twenty",start:1.7,end:2}, {word:"seven",start:2,end:2.4}
  ]}});
  assert.equal(resultEvents[1].speechStartedAt,2800);
  h.recognition.abort();
});

test("worklet retains sample positions when flushing a partial final buffer", () => {
  let Processor; const messages=[];
  const scope={Float32Array,currentFrame:32000,AudioWorkletProcessor:class {
    port={postMessage:message=>messages.push(message)};
  },registerProcessor:(_,ctor)=>{Processor=ctor;}};
  vm.runInNewContext(fs.readFileSync(path.join(root,"public/number-capture.worklet.js"),"utf8"),scope);
  const capture=new Processor();
  capture.process([[new Float32Array(128).fill(0.01)]]);
  scope.currentFrame=32128;capture.process([[new Float32Array(128).fill(0.02)]]);
  capture.port.onmessage({data:"stop"});
  assert.equal(messages[0].startFrame,32000);
  assert.equal(messages[0].samples.length,256);
  assert.equal(messages[1].stopped,true);
});
