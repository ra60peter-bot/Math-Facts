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
const onset = {exports:{}};
vm.runInNewContext(compile("lib/speech-onset.ts"), {exports:onset.exports});

async function harness({ pendingPermission = false, autoReveal = true, userAgent = "test browser" } = {}) {
  const events = [], buffers = [], outputs = [], timers = new Map();
  let decoder, capture, resolveStream, stops = 0, removals = 0, closed = 0, now = 1000;
  const contexts = [], listeners = new Map(), tracks = [];
  let requests = 0, modules = 0;
  const newStream = () => {
    const handlers = new Map();
    const track = {readyState:"live",muted:false,stop() {stops++;this.readyState="ended";},
      addEventListener(name,fn) {handlers.set(name,fn);}, removeEventListener(name) {handlers.delete(name);},
      emit(name) {handlers.get(name)?.();}};
    tracks.push(track);
    return {getTracks:()=>[track]};
  };
  class Model {
    ready = true;
    on(event, cb) {if(event === "load") queueMicrotask(() => cb({event:"load",result:true}));}
    terminate() {}
    KaldiRecognizer = class {
      handlers = {};
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- expose the mock decoder to the test
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
    exports, require: name => name === "vosk-browser" ? {Model} : name === "./speech-onset" ? onset.exports : parser.exports,
    performance: {now: () => now},
    window: {setTimeout: fn => {const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)},
    navigator: {userAgent,mediaDevices:{getUserMedia: () => {requests++;return pendingPermission ? new Promise(resolve=>{resolveStream=resolve;}) : Promise.resolve(newStream());}}},
    AudioContext: class {
      constructor(options) {this.sampleRate=options?.sampleRate??48000;contexts.push(this);}
      currentTime = 0.5; destination = {}; state = "suspended"; handlers = new Map(); resumes = 0;
      audioWorklet = {addModule: async () => {modules++;}};
      resume() {this.resumes++;this.state="running";return Promise.resolve();}
      close() {this.state="closed";closed++;return Promise.resolve();}
      addEventListener(name,fn) {this.handlers.set(name,fn);}
      removeEventListener(name) {this.handlers.delete(name);}
      emit(name) {this.handlers.get(name)?.();}
      createMediaStreamSource() {return {connect() {},disconnect() {}};}
    },
    AudioWorkletNode: class {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- expose the mock capture node to the test
      constructor() {capture = this;}
      port = {onmessage: null, postMessage: data => events.push(data), close() {}};
      connect() {} disconnect() {}
    }, DOMException,
  };
  context.window.addEventListener=(name,fn)=>listeners.set(name,fn);
  context.window.removeEventListener=name=>listeners.delete(name);
  const safari = {exports:{}};
  vm.runInNewContext(compile("lib/safari-number-audio.ts"),{...context,exports:safari.exports});
  const originalRequire=context.require;
  context.require=name=>name==="./safari-number-audio"?safari.exports:originalRequire(name);
  vm.runInNewContext(compile("lib/number-speech.ts"),context);
  await exports.prepareNumberSpeech();
  const recognition = new exports.NumberSpeechRecognition();
  recognition.onresult = event => outputs.push(event.results[0]);
  recognition.start();
  await new Promise(resolve => setImmediate(resolve));
  if (autoReveal && capture) {
    recognition.onaudiostart=()=>recognition.beginAnswerWindow(now);
    capture.port.onmessage({data:{samples:new Float32Array(1024),startFrame:8000}});
  }
  return {recognition,events,buffers,outputs,exports,safari:safari.exports,contexts,tracks,
    clock(value) {now=value;},
    get decoder() {return decoder;}, get capture() {return capture;},
    get stops() {return stops;}, get removals() {return removals;}, get closed() {return closed;},
    get requests() {return requests;}, get modules() {return modules;},
    pagehide() {listeners.get("pagehide")?.();},
    async next() {const next=new exports.NumberSpeechRecognition();next.start();await new Promise(resolve=>setImmediate(resolve));return next;},
    async allowPermission() {resolveStream(newStream());await new Promise(resolve=>setImmediate(resolve));},
  };
}

test("number decoder receives quiet audio without a volume gate and includes wrong numbers", async () => {
  const h=await harness();
  h.capture.port.onmessage({data:{samples:new Float32Array([0.0001,0.0002]),startFrame:9024}});
  assert.equal(h.buffers.length,1);
  const grammar=JSON.parse(h.decoder.grammar);
  for(const number of ["two","six","eight","ten","forty","fifty one","two hundred twenty five","[unk]"]) assert.ok(grammar.includes(number),number);
  h.recognition.abort();
});

test("stopping capture flushes the last audio chunk before requesting a final result", async () => {
  const h=await harness();h.recognition.stop();
  assert.equal(h.stops,1);assert.equal(h.events.at(-1),"stop");
  assert.ok(!h.events.includes("final-request"));
  h.capture.port.onmessage({data:{samples:new Float32Array([0.1]),startFrame:9024}});
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
  // Decoder sample zero is the first sample after question reveal (1000ms).
  h.capture.port.onmessage({data:{samples:new Float32Array([0.1,0.2]),startFrame:9024}});
  assert.equal(speechEvents,0);
  h.decoder.handlers.partialresult({event:"partialresult",result:{partial:"twenty"}});
  assert.equal(resultEvents[0].speechStartedAt,undefined);
  h.decoder.handlers.result({event:"result",result:{text:"twenty seven",result:[
    {word:"[unk]",start:0.1,end:0.2}, {word:"twenty",start:1.7,end:2}, {word:"seven",start:2,end:2.4}
  ]}});
  assert.equal(resultEvents[1].speechStartedAt,2700);
  h.recognition.abort();
});

test("actual capture starts readiness and pre-reveal samples never enter the decoder", async () => {
  const h=await harness({autoReveal:false}); let ready=0; const resultEvents=[];
  h.recognition.onaudiostart=()=>ready++;
  h.recognition.onresult=event=>resultEvents.push(event);
  assert.equal(ready,0);
  // Audio clock has advanced several seconds before the first mic buffer.
  h.clock(3000);
  h.capture.port.onmessage({data:{samples:new Float32Array(1024).fill(0.1),startFrame:160000}});
  assert.equal(ready,1);assert.equal(h.buffers.length,0);
  h.recognition.beginAnswerWindow(3020);
  h.clock(3064);
  h.capture.port.onmessage({data:{samples:new Float32Array(1024).fill(0.1),startFrame:161024}});
  assert.equal(h.buffers[0].length,704); // first 20ms precede reveal
  h.decoder.handlers.result({event:"result",result:{text:"one thirty two",result:[{word:"one",start:1.3,end:1.5}]}});
  assert.equal(resultEvents[0].speechStartedAt,4320);
  h.recognition.abort();
});

test("a zero-aligned one in one oh eight uses the audio onset instead of zero seconds",async()=>{
  const h=await harness();const results=[];h.recognition.onresult=event=>results.push(event);
  // Background noise, a 10ms startup click, 1.2s thought time, then speech.
  const samples=new Float32Array(32000).fill(0.001);
  samples.fill(0.2,1600,1760);
  samples.fill(0.05,19200,25600);
  h.capture.port.onmessage({data:{samples,startFrame:9024}});
  h.decoder.handlers.result({event:"result",result:{text:"one oh eight",result:[
    {word:"one",start:0,end:1.6},{word:"oh",start:1.6,end:1.8},{word:"eight",start:1.8,end:2}
  ]}});
  assert.equal(results[0].speechStartedAt,2200);
  assert.equal(results[0].results[0][0].transcript,"one oh eight");
  h.recognition.abort();
});

test("ambiguous zero-aligned background noise has no fabricated acoustic timestamp",async()=>{
  const h=await harness();let result;h.recognition.onresult=event=>{result=event;};
  h.capture.port.onmessage({data:{samples:new Float32Array(32000).fill(0.01),startFrame:9024}});
  h.decoder.handlers.result({event:"result",result:{text:"one oh eight",result:[{word:"one",start:0,end:1.5}]}});
  assert.equal(result.speechStartedAt,undefined);
  h.recognition.abort();
});

test("input gaps preserve silence and word timing rather than shortening the audio timeline", () => {
  let Processor; const messages=[];
  const scope={Float32Array,currentFrame:0,AudioWorkletProcessor:class {
    port={postMessage:message=>messages.push(message)};
  },registerProcessor:(_,ctor)=>{Processor=ctor;}};
  vm.runInNewContext(fs.readFileSync(path.join(root,"public/number-capture.worklet.js"),"utf8"),scope);
  const capture=new Processor();
  capture.process([[]]);assert.equal(capture.offset,0);
  capture.process([[new Float32Array(128).fill(0.01)]]);
  scope.currentFrame=128;capture.process([[]]);
  scope.currentFrame=256;capture.process([[new Float32Array(128).fill(0.02)]]);
  capture.port.onmessage({data:"stop"});
  assert.equal(messages[0].samples.length,384);
  assert.ok(messages[0].samples.slice(128,256).every(value=>value===0));
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

const safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

test("Safari reuses one microphone/context for 50 questions with fresh decoders and capture clocks", async () => {
  const h=await harness({userAgent:safariUA,autoReveal:false});
  let recognition=h.recognition;
  for(let question=0;question<50;question++) {
    const results=[];recognition.onresult=event=>results.push(event);
    const shownAt=1000+question*7000;
    const firstFrame=question*500000;
    h.clock(shownAt);
    recognition.onaudiostart=()=>recognition.beginAnswerWindow(shownAt);
    h.capture.port.onmessage({data:{samples:new Float32Array(1024),startFrame:firstFrame}});
    h.capture.port.onmessage({data:{samples:new Float32Array(96000).fill(0.001),startFrame:firstFrame+1024}});
    const oldDecoder=h.decoder;
    recognition.stop();
    assert.equal(h.stops,0,"Safari must retain mic between questions");
    h.capture.port.onmessage({data:{stopped:true}});
    oldDecoder.handlers.result({event:"result",result:{text:"two",result:[{word:"two",start:1.25,end:1.5}]}});
    assert.equal(results[0].speechStartedAt,shownAt+1250,"timing restarts at this question's reveal");
    assert.equal(h.closed,0);
    recognition.abort();
    if(question<49) {
      recognition=await h.next();
      assert.notEqual(h.decoder,oldDecoder);
      oldDecoder.handlers.error({event:"error"}); // late worker event cannot close the next mic
    }
  }
  assert.equal(h.requests,1);assert.equal(h.contexts.length,1);assert.equal(h.modules,1);
  assert.equal(h.contexts[0].sampleRate,48000);
  assert.equal(h.removals,50);
  h.safari.releaseSafariNumberAudio();
  assert.equal(h.stops,1);assert.equal(h.closed,1);
});

test("Chrome and Edge on Windows/Mac retain separate 16kHz capture for every answer",async()=>{
  for(const ua of [
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
    "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/153.0.0.0 Mobile/15E148 Safari/604.1",
  ]) {
    const h=await harness({userAgent:ua});assert.equal(h.safari.isSafariBrowser(),false,ua);
    h.safari.prepareSafariNumberAudio();
    h.recognition.abort();
    const next=await h.next();next.abort();h.safari.releaseSafariNumberAudio();
    assert.equal(h.requests,2);assert.equal(h.closed,2);assert.equal(h.stops,2);
    assert.ok(h.contexts.every(context=>context.sampleRate===16000));
  }
});

test("Safari resumes a suspended session and replaces an ended microphone",async()=>{
  const h=await harness({userAgent:safariUA});h.recognition.abort();
  h.contexts[0].state="suspended";
  const next=await h.next();
  assert.equal(h.contexts[0].state,"running");assert.equal(h.requests,1);
  h.capture.port.onmessage({data:{samples:new Float32Array(1024),startFrame:0}});
  next.abort();h.tracks[0].readyState="ended";
  const fresh=await h.next();assert.equal(h.requests,2);assert.equal(h.closed,1);
  fresh.abort();h.safari.releaseSafariNumberAudio();assert.equal(h.closed,2);
});

test("Safari interruption reports a retry without scoring silence or retaining broken audio",async()=>{
  for(const interruption of ["statechange","ended","mute"]) {
    const h=await harness({userAgent:safariUA});const errors=[];
    h.recognition.onerror=event=>errors.push(event.error);
    if(interruption==="statechange") {h.contexts[0].state="interrupted";h.contexts[0].emit(interruption);}
    else {h.tracks[0][interruption==="ended"?"readyState":"muted"]=interruption==="ended"?"ended":true;h.tracks[0].emit(interruption);}
    assert.deepEqual(errors,["audio-interrupted"]);assert.equal(h.outputs.length,0);
    assert.equal(h.closed,1);assert.equal(h.stops,1);
    const next=await h.next();assert.equal(h.requests,2);
    next.abort();h.safari.releaseSafariNumberAudio();
  }
});

test("Safari cancelled permission and stalled startup are released, including late streams",async()=>{
  const pending=await harness({userAgent:safariUA,pendingPermission:true});
  pending.recognition.abort();await pending.allowPermission();
  assert.equal(pending.stops,1);assert.equal(pending.closed,1);assert.equal(pending.decoder,undefined);
  const stalled=await harness({userAgent:safariUA,autoReveal:false});
  stalled.recognition.abort();assert.equal(stalled.stops,1);assert.equal(stalled.closed,1);
  const next=await stalled.next();assert.equal(stalled.requests,2);next.abort();
});

test("Safari page exit releases capture even between questions and permits a fresh session",async()=>{
  const h=await harness({userAgent:safariUA});h.recognition.abort();
  assert.equal(h.stops,0);h.pagehide();assert.equal(h.stops,1);assert.equal(h.closed,1);
  h.pagehide();assert.equal(h.closed,1);
  const next=await h.next();assert.equal(h.requests,2);next.abort();h.safari.releaseSafariNumberAudio();
});
