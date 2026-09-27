import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import {test} from "node:test";
import ts from "typescript";
const root=path.resolve(import.meta.dirname,"..");
const exports={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,"lib/number-parser.ts"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports});
const {parseSpokenNumber:parse,numberToPhrases}=exports;

test("every generated spoken form round-trips for the entire recognition range",()=>{
  for(let value=0;value<=225;value++) {
    assert.equal(parse(String(value)),value);
    assert.ok(numberToPhrases(value).length > 0);
    for(const phrase of numberToPhrases(value)) {
      assert.equal(parse(phrase),value,phrase);
      assert.equal(parse(`The answer is ${phrase}.`),value,phrase);
    }
  }
});
test("hundreds accept shorthand, full names, and, digits, and mixed service transcripts",()=>{
  for(const [value,forms] of [
    [132,["one thirty two","one hundred thirty-two","one hundred and thirty two","a hundred and thirty two","one three two","one 32","1 thirty two","1 32","1 3 2","one hundred and 32","132"]],
    [112,["one twelve","one hundred twelve","one hundred and twelve","one one two","one 12","1 12","112"]],
    [121,["one twenty one","one hundred twenty one","one hundred and twenty-one","one two one","one 21","1 21","121"]],
    [144,["one forty four","one hundred and forty four","one four four","1 44","144"]],
  ]) for(const form of forms) assert.equal(parse(form),value,form);
});
test("variants cover all current fact answers without accepting arbitrary conflicting lists",()=>{
  for(let a=2;a<=12;a++)for(let b=2;b<=12;b++)for(const phrase of numberToPhrases(a*b))assert.equal(parse(phrase),a*b);
  for(const text of ["two four six eight ten","twenty eight thirty two","one thirty two or one twelve","12 times 11 is 132"])assert.equal(parse(text),null,text);
  assert.equal(parse("one twelve"),112); // never guessed as 132 because that was expected
  assert.equal(parse("ten ten"),10);
});
