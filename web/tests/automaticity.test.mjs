import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "../lib");
const modules = new Map();
function load(name) {
  const file = path.resolve(root, name + ".ts");
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Date, Intl, BigInt, require: dep => load(dep.replace(/^\.\//, "")) });
  return exports;
}
const A = load("automaticity"), { makeCards } = load("cards"), { defaultState } = load("learning");
const C = load("automaticity-config").AUTOMATICITY_CONFIG;
const DAY = 86400000, BASE = Date.parse("2026-01-01T12:00:00Z");
const deck = [ ...makeCards("add"), ...makeCards("sub"), ...makeCards("mul") ];
const card = id => deck.find(c => c.id === id);
function harness(cards = deck, timeZone = "UTC") {
  let now = BASE, sequence = 0;
  let progress = A.createAutomaticProgress("learner", deck, {}, timeZone, () => now);
  const h = {
    get p() { return progress; }, set p(value) { progress = value; }, get now() { return now; },
    at(value) { now = value; }, tick(ms) { now += ms; },
    start(targetCount = 1000) { progress = A.startAutomaticSession(progress, { id: `session-${++sequence}`, cards, operation: cards[0].operation, targetCount }, () => now, () => .25); },
    end() { progress = A.endAutomaticSession(progress, () => now); },
    select(enabled = cards, random = () => .25) { return A.selectNextQuestion(progress, enabled, () => now, random); },
    show(c, kind = "training") { progress = A.presentQuestion(progress, { kind: "question", fact: c, attemptKind: kind }, () => now); return progress.session.current?.id; },
    result(correct = true, responseMs = 1300, extra = {}) {
      progress = A.applyAttemptResult(progress, { presentationId: progress.session.current?.id, correct, responseMs, ...extra }, () => now);
      return progress.events.at(-1);
    },
    attempt(c, ms = 1300, correct = true, kind = "training", extra = {}) { h.show(c, kind); now += ms; return h.result(correct, ms, extra); },
    fill(target, count, elapsed = 0) {
      const pool = cards.filter(c => A.familyId(c) !== A.familyId(target) && A.answer(c) !== A.answer(target) && c.id !== target.id && (progress.session.counts[c.id] ?? 0) < 4);
      for (let i = 0; i < count; i++) { now += elapsed / count; h.attempt(pool[i % pool.length], 100, true, "assessment"); }
    },
  };
  h.start(); return h;
}
function assess(h, c, ms = 1300, correct = true) { return h.attempt(c, ms, correct, "assessment"); }
function coldVisit(h, c, ms = 1300) {
  const due = h.p.facts[c.id].dueAt;
  h.end(); h.at(due); h.start();
  assert.equal(A.coldEligible(h.p, c, h.now), true);
  return h.attempt(c, ms, true, "check");
}

test("stable ordered identities, preserved ranges, and operation-specific interference families", () => {
  assert.equal(makeCards("mul").length, 121);
  assert.equal(makeCards("add").length, 81);
  assert.equal(makeCards("sub").length, 45);
  assert.equal(new Set(deck.map(c => c.id)).size, 247);
  assert.equal(A.answer(card("add-8-9")), 17);
  assert.equal(A.familyId(card("mul-7-8")), A.familyId(card("mul-8-7")));
  assert.equal(A.familyId(card("add-3-6")), A.familyId(card("add-6-3")));
  assert.notEqual(A.familyId({id:"sub-3-8", a:3,b:8,operation:"sub"}), A.familyId(card("sub-8-3")));
  assert.notEqual(A.familyId(card("add-7-8")), A.familyId(card("mul-7-8")));
});

test("equivalent initial outcomes schedule identically in all three operations", () => {
  for (const [ms, stage] of [[1500,"VERIFYING"],[1501,"TRAINING"],[3001,"TRAINING"]]) {
    const states = ["add-3-2", "sub-3-2", "mul-3-2"].map(id => {
      const h = harness(); assess(h, card(id), ms); const f = h.p.facts[id];
      assert.equal(f.stage, stage); assert.equal(f.dueAt, h.now + DAY); return [f.intervalLevel, f.coldStreak, f.pendingRetry];
    });
    assert.equal(JSON.stringify(states[0]), JSON.stringify(states[1]));
    assert.equal(JSON.stringify(states[0]), JSON.stringify(states[2]));
  }
});

test("all grading boundaries keep correctness, assistance, and first-answer success separate", () => {
  for (const [input, expected] of [
    [{correct:true,responseMs:1500},"FAST_CORRECT"], [{correct:true,responseMs:1501},"SLOW_CORRECT"],
    [{correct:true,responseMs:3000},"SLOW_CORRECT"], [{correct:true,responseMs:3001},"VERY_SLOW_CORRECT"],
    [{correct:false,responseMs:200},"WRONG_OR_ASSISTED"], [{correct:true,responseMs:200,assisted:true},"WRONG_OR_ASSISTED"],
    [{correct:true,responseMs:200,firstAnswerCorrect:false},"WRONG_OR_ASSISTED"], [{correct:false,responseMs:4000,timeout:true},"WRONG_OR_ASSISTED"],
    [{correct:true,responseMs:4000},"VERY_SLOW_CORRECT"],
  ]) assert.equal(A.classifyResult(input), expected);
});

test("0.7 and 1.3 seconds earn identical scheduling, with no speed bonus", () => {
  const c = card("mul-3-2");
  const h1 = harness(), h2 = harness();
  for (const [h, ms] of [[h1,700],[h2,1300]]) { h.show(c,"assessment"); h.result(true,ms); }
  assert.equal(h1.p.facts[c.id].dueAt,h2.p.facts[c.id].dueAt);
  assert.equal(h1.p.facts[c.id].stage,h2.p.facts[c.id].stage);
});

test("first fast assessment leaves optional practice available without awarding verification", () => {
  const c = card("mul-3-2"), h = harness([c]); assess(h,c);
  const f = h.p.facts[c.id];
  assert.equal(f.stage,"VERIFYING"); assert.equal(f.coldStreak,0); assert.equal(f.pendingRetry,null);
  assert.equal(f.everVerifiedAutomatic,false); assert.equal(h.select().attemptKind,"extra");
  h.end(); h.start(); assert.equal(h.select().attemptKind,"extra");
});

test("coverage visits every unassessed fact across ordinary short sessions", () => {
  const cards = makeCards("mul"), h = harness(cards), seen = new Set();
  for (let session=0; session<13; session++) {
    h.end(); h.start(10);
    for (let q=0; q<10; q++) {
      const next=h.select(); assert.equal(next.kind,"question");
      if (seen.size < cards.length) assert.equal(seen.has(next.fact.id),false);
      seen.add(next.fact.id); h.attempt(next.fact,1000,true,next.attemptKind);
    }
  }
  assert.equal(seen.size,121);
});

test("legacy counts/badges and missing latency remain history, not automaticity evidence", () => {
  const c=card("mul-3-2");
  const old={...defaultState(c.id),state:"mastered",totalAttempts:20,totalCorrect:20,lastResponseMs:undefined,lastSeenAt:new Date(BASE-1000).toISOString()};
  const p=A.createAutomaticProgress("learner",deck,{[c.id]:old},"UTC",()=>BASE);
  assert.equal(p.facts[c.id].stage,"UNASSESSED"); assert.equal(p.facts[c.id].legacy.attempts,20);
  assert.equal(p.facts[c.id].everVerifiedAutomatic,false); assert.equal(p.exposures.length,1);
});

test("wrong and slow initial answers get the distinct retry rules and fallback check", () => {
  for (const [ms,correct,questions,elapsed] of [[100,false,3,15000],[3800,true,4,20000],[2300,true,8,30000]]) {
    const h=harness(), c=card("mul-3-2"); assess(h,c,ms,correct);
    const f=h.p.facts[c.id]; assert.equal(f.stage,"TRAINING"); assert.equal(f.dueAt,h.now+DAY);
    assert.equal(f.pendingRetry.minimumUnrelatedQuestions,questions); assert.equal(f.pendingRetry.minimumElapsedMs,elapsed);
    assert.equal(f.latest.correct,correct);
  }
});

test("retry requires both time AND real unrelated completions", () => {
  const c=card("mul-3-2"), h=harness(); assess(h,c,100,false); const anchor=h.now;
  h.at(anchor+15000); assert.equal(A.retryEligible(h.p,c,h.now),false);
  h.at(anchor); h.fill(c,3); assert.equal(A.retryEligible(h.p,c,h.now),false);
  h.at(anchor+15000); assert.equal(A.retryEligible(h.p,c,h.now),true);
});

test("reversals count independently for retries while other same-answer facts do not", () => {
  const c=card("mul-3-2"), h=harness(); assess(h,c,100,false);
  h.attempt(card("mul-2-3")); h.attempt(card("add-3-3")); h.attempt(card("sub-8-2"));
  h.tick(20000); assert.equal(A.retryEligible(h.p,c,h.now),false);
  h.fill(c,2); assert.equal(A.retryEligible(h.p,c,h.now),true);
});

test("corrective feedback end anchors the retry, not the earlier wrong response", () => {
  const c=card("mul-3-2"), h=harness(); assess(h,c,100,false);
  h.p=A.beginAnswerExposure(h.p,c,()=>h.now); h.tick(60000);
  h.p=A.endAnswerExposure(h.p,()=>h.now); const end=h.now;
  h.fill(c,3); assert.equal(A.retryEligible(h.p,c,h.now),false);
  assert.equal(h.p.facts[c.id].pendingRetry.anchorAt,end);
  h.tick(15000); assert.equal(A.retryEligible(h.p,c,h.now),true);
});

test("two properly spaced fast training attempts finish today with no cold credit", () => {
  const c=card("mul-3-2"),h=harness(); assess(h,c,3800);
  h.fill(c,4,20000); h.attempt(c,1400);
  assert.equal(h.p.session.fastStreaks[c.id],1);
  assert.equal(h.p.facts[c.id].pendingRetry.minimumUnrelatedQuestions,12);
  h.fill(c,12,60000); assert.equal(A.retryEligible(h.p,c,h.now),true); h.attempt(c,1200);
  assert.equal(h.p.facts[c.id].stage,"VERIFYING"); assert.equal(h.p.facts[c.id].coldStreak,0);
  assert.equal(h.p.facts[c.id].dueAt,h.now+DAY); assert.ok(h.p.session.finished.includes(c.id));
});

test("slow or wrong resets the per-fact training streak and new sessions reset warm streaks only", () => {
  for(const [ms,correct] of [[2300,true],[100,false]]) {
    const c=card("mul-3-2"),h=harness(); assess(h,c,3800); h.fill(c,4,20000);h.attempt(c,1300);
    h.fill(c,12,60000);h.attempt(c,ms,correct);assert.equal(h.p.session.fastStreaks[c.id],0);
    const pending=JSON.stringify(h.p.facts[c.id].pendingRetry);h.end();h.start();
    assert.equal(h.p.session.fastStreaks[c.id],undefined);assert.equal(JSON.stringify(h.p.facts[c.id].pendingRetry),pending);
  }
});

test("one chosen fact fills 100 questions with any outcome and can immediately repeat", () => {
  for (const [correct,ms] of [[false,1000],[true,2500],[true,1000]]) {
    const c=card("mul-3-2"),h=harness([c]); h.end();h.start(100);
    for(let i=0;i<100;i++) {
      const next=h.select();assert.equal(next.kind,"question");assert.equal(next.fact.id,c.id);
      h.attempt(next.fact,ms,correct,next.attemptKind);
      assert.equal(h.p.session.gradedCount,i+1);
    }
    assert.equal(h.p.session.counts[c.id],100);assert.equal(h.p.events.length,100);
    assert.equal(h.p.facts[c.id].coldStreak,0);assert.notEqual(h.p.facts[c.id].stage,"MAINTENANCE");
    assert.equal(h.select().kind,"none");assert.equal(h.show(c),undefined);
    h.end();h.start(10);assert.equal(h.select().kind,"question");
  }
});

test("technical invalidity and abandoned prompts preserve exposure without changing achievement", () => {
  for (const extra of [{invalid:true},{abandoned:true}]) {
    const c=card("mul-3-2"),h=harness(); const before=JSON.stringify(h.p.facts[c.id]);
    h.show(c,"assessment");h.result(false,0,extra);
    assert.equal(JSON.stringify(h.p.facts[c.id]),before);assert.equal(h.p.session.gradedCount,0);
    assert.equal(h.p.completions.length,0);assert.equal(h.p.exposures.length,1);
  }
});

test("early optional practice is exposure, cannot advance ladder, and blocks the next cold check", () => {
  const c=card("mul-3-2"),h=harness();assess(h,c);const due=h.p.facts[c.id].dueAt;
  h.end();h.start();h.at(due-1000);h.attempt(c,700,true,"extra");
  assert.equal(h.p.facts[c.id].intervalLevel,0);assert.equal(h.p.facts[c.id].coldStreak,0);
  assert.equal(h.p.facts[c.id].dueAt,due);h.at(due+1000);assert.equal(A.coldEligible(h.p,c,h.now),false);
});

test("new local date and DST transitions never substitute for 24 actual hours", () => {
  const c=card("mul-3-2"),h=harness(deck,"America/Los_Angeles");
  h.at(Date.parse("2026-03-08T07:30:00Z"));assess(h,c); h.end();h.start();
  h.p.facts[c.id].dueAt=0;
  h.tick(3*3600000); assert.equal(A.coldEligible(h.p,c,h.now),false);
  h.tick(20*3600000); assert.equal(A.coldEligible(h.p,c,h.now),false);
  h.tick(3600000); assert.equal(A.coldEligible(h.p,c,h.now),true);
});

test("reverse exposure does not block a due check or transfer achievement", () => {
  const c=card("mul-7-8"),reverse=card("mul-8-7"),h=harness();assess(h,c);
  h.end();h.at(h.p.facts[c.id].dueAt);h.start();h.attempt(reverse,1000,true,"assessment");
  assert.equal(A.coldEligible(h.p,c,h.now),true);assert.equal(h.p.facts[c.id].coldStreak,0);
  assert.equal(h.select([c]).fact.id,c.id);
});

test("preceding three answers prime checks across operations; fewer than three need no warmup", () => {
  const c=card("mul-3-2"),h=harness();assess(h,c);h.end();h.at(h.p.facts[c.id].dueAt);h.start();
  // A full day clears old priming without inventing a three-question warm-up.
  assert.equal(A.coldEligible(h.p,c,h.now),true);
  h.attempt(card("add-3-3"),1000,true,"assessment");assert.equal(A.coldEligible(h.p,c,h.now),false);
  h.fill(c,3); assert.equal(A.coldEligible(h.p,c,h.now),true);
  const fresh=harness();fresh.p.facts[c.id].stage="VERIFYING";fresh.p.facts[c.id].dueAt=BASE;
  assert.equal(A.coldEligible(fresh.p,c,fresh.now),true);
});

test("current presentation cannot invalidate its own precomputed cold eligibility", () => {
  const c=card("mul-3-2"),h=harness();assess(h,c);h.fill(c,3);h.end();h.at(h.p.facts[c.id].dueAt);h.start();
  h.show(c,"check");assert.equal(h.p.session.current.coldEligible,true);
  assert.equal(A.coldEligible(h.p,c,h.now),false);h.result(true,1300);
  assert.equal(h.p.facts[c.id].coldStreak,1);assert.equal(h.p.events.at(-1).qualifiedCold,true);
});

test("resume retains exposure/counts and cannot turn the abandoned question into a cold success", () => {
  const c=card("mul-3-2"),h=harness();assess(h,c,2300);h.fill(c,8,30000);h.show(c);
  const count=h.p.session.counts[c.id], retry=JSON.stringify(h.p.facts[c.id].pendingRetry);
  h.p=A.resumeAutomaticSession(JSON.parse(JSON.stringify(h.p)),()=>h.now);
  assert.equal(h.p.session.counts[c.id],count);assert.equal(JSON.stringify(h.p.facts[c.id].pendingRetry),retry);
  assert.equal(h.p.session.current,null);assert.equal(A.coldEligible(h.p,c,h.now),false);
  assert.equal(h.p.events.at(-1).result,"ABANDONED");
});

test("unfinished training can enter verification by a fast later cold fallback check", () => {
  const c=card("mul-3-2"),h=harness();assess(h,c,2300);h.fill(c,3);
  coldVisit(h,c);assert.equal(h.p.facts[c.id].stage,"VERIFYING");assert.equal(h.p.facts[c.id].coldStreak,1);
  assert.equal(h.p.facts[c.id].intervalLevel,1);assert.ok(h.p.session.finished.includes(c.id));
});

test("readable Day 0 → 1 → 3 → 7 → 14 training, verification, and maintenance lapse", () => {
  const c=card("mul-7-8"),h=harness();
  assess(h,c,3800); h.fill(c,4,20000); h.attempt(c,2300);
  h.fill(c,8,30000); h.attempt(c,1400);
  h.fill(c,12,60000); h.attempt(c,1200);
  const day0=h.now;
  assert.equal(h.p.facts[c.id].stage,"VERIFYING");assert.equal(h.p.facts[c.id].coldStreak,0);
  for (const [day,ms,nextDays,stage] of [[1,1300,2,"VERIFYING"],[3,1200,4,"VERIFYING"],[7,1100,7,"VERIFYING"],[14,1200,14,"MAINTENANCE"]]) {
    h.fill(c,3); h.end(); h.at(h.p.facts[c.id].dueAt); h.start();
    assert.equal(Math.floor((h.now-day0)/DAY),day);
    assert.equal(A.coldEligible(h.p,c,h.now),true);
    h.attempt(c,ms,true,"check");const f=h.p.facts[c.id];
    assert.equal(f.stage,stage);assert.equal(f.dueAt,h.now+nextDays*DAY);
  }
  assert.equal(h.p.facts[c.id].everVerifiedAutomatic,true);
  h.fill(c,3);coldVisit(h,c,1800);const f=h.p.facts[c.id];
  assert.equal(f.stage,"TRAINING");assert.equal(f.latest.correct,true);assert.equal(f.coldStreak,0);
  assert.equal(f.firstColdAt,null);assert.equal(f.intervalLevel,0);assert.equal(f.everVerifiedAutomatic,true);
});

test("ladder caps at 30 days, returning late advances once, and lateness is not failure", () => {
  const c=card("mul-7-8"),h=harness();assess(h,c);h.fill(c,3);
  for(let i=1;i<=7;i++) {
    h.end();const due=h.p.facts[c.id].dueAt;h.at(due+10*DAY);h.start();
    const before=h.p.facts[c.id].stage;A.getProgressSummary(h.p,[c],()=>h.now);assert.equal(h.p.facts[c.id].stage,before);
    h.attempt(c,1200,true,"check");assert.equal(h.p.facts[c.id].intervalLevel,Math.min(i,5));
    assert.equal(h.p.facts[c.id].dueAt,h.now+C.crossDayIntervalsDays[Math.min(i,5)]*DAY);h.fill(c,3);
  }
});

test("four dates AND seven-day streak span are explicitly enforced", () => {
  const c=card("mul-7-8"),h=harness();assess(h,c);h.fill(c,3);
  for(let i=0;i<4;i++) {h.end();h.tick(DAY);h.p.facts[c.id].dueAt=h.now;h.start();h.attempt(c,1000,true,"check");h.fill(c,3);}
  assert.equal(h.p.facts[c.id].coldStreak,4);assert.equal(h.p.facts[c.id].stage,"VERIFYING");
  h.end();h.tick(7*DAY);h.start();h.p.facts[c.id].dueAt=h.now;h.attempt(c,1000,true,"check");
  assert.equal(h.p.facts[c.id].stage,"MAINTENANCE");
});

test("allocation makes seven training and three check presentations when both eligible", () => {
  const h=harness();
  for (const c of makeCards("mul").filter(c => c.a <= c.b).slice(0,20)) {h.p.facts[c.id].stage="TRAINING";h.p.facts[c.id].trainingSince=BASE-1000;}
  const kinds=[];
  for(let i=0;i<10;i++){const choice=h.select();assert.equal(choice.kind,"question");kinds.push(choice.attemptKind === "training" ? "TRAINING" : "CHECK");h.attempt(choice.fact,1000,true,choice.attemptKind);}
  assert.equal(JSON.stringify(kinds),JSON.stringify(C.allocation));
});

test("empty queue falls back and oldest due checks precede assessments", () => {
  const h=harness();const first=card("mul-7-8"),second=card("mul-9-10");
  h.p.facts[first.id].stage="VERIFYING";h.p.facts[first.id].dueAt=BASE-5000;
  h.p.facts[second.id].stage="MAINTENANCE";h.p.facts[second.id].dueAt=BASE-1000;
  const next=h.select();assert.equal(next.fact.id,first.id);assert.equal(next.attemptKind,"check");
  h.attempt(first,1300,true,"check");assert.equal(h.select().fact.id,second.id);
});

test("due check and reverse training can both be selected independently", () => {
  const due=card("mul-7-8"),reverse=card("mul-8-7"),h=harness([due,reverse]);
  h.p.facts[due.id].stage="VERIFYING";h.p.facts[due.id].dueAt=BASE;
  h.p.facts[reverse.id].stage="TRAINING";
  assert.equal(h.select().fact.id,reverse.id);
  h.attempt(reverse,4000,false,"training");
  assert.equal(h.select().fact.id,due.id);
  assert.equal(h.select().attemptKind,"check");
});

test("preferred active pool holds ten facts and waiting training survives later sessions", () => {
  const h=harness();const targets=makeCards("mul").filter(c=>c.a<c.b).slice(0,12);
  for(let i=0;i<targets.length;i++){const f=h.p.facts[targets[i].id];f.stage="TRAINING";f.trainingSince=BASE+i;}
  for(let i=0;i<10;i++) {const next=h.select(targets);assert.equal(next.kind,"question");h.attempt(next.fact,1000,true,next.attemptKind);}
  assert.ok(h.p.session.active.length<=10);
  const untouched=targets.filter(c=>!h.p.session.counts[c.id]);assert.ok(untouched.length);
  h.end();h.start();const next=h.select(targets);assert.ok(untouched.some(c=>c.id===next.fact.id));
});

test("prefer alternatives including reversals but allow immediate single-fact repetition", () => {
  const c=card("mul-3-2"),reverse=card("mul-2-3"),same=card("add-3-3"),other=card("add-2-3");
  const h=harness([c,reverse,same,other]);assess(h,c,2300);
  assert.ok([other.id,reverse.id].includes(h.select().fact.id));
  assert.equal(h.select([c,reverse]).fact.id,reverse.id);
  assert.equal(h.select([c]).fact.id,c.id);assert.equal(h.select([c]).attemptKind,"extra");
});

test("9 × 7 masters on its own even when 7 × 9 is wrong before every check", () => {
  const c=card("mul-9-7"),reverse=card("mul-7-9"),h=harness([c,reverse]);
  assess(h,c);
  for(let i=0;i<4;i++) {
    h.end();h.at(h.p.facts[c.id].dueAt);h.start();
    h.attempt(reverse,2300,false,"training");
    h.p=A.beginAnswerExposure(h.p,reverse,()=>h.now);
    assert.equal(A.coldEligible(h.p,c,h.now),true);
    h.p=A.endAnswerExposure(h.p,()=>h.now);
    // Persist/reload snapshots with the old shared family metadata intact.
    h.p=JSON.parse(JSON.stringify(h.p));
    const next=h.select([c]);assert.equal(next.attemptKind,"check");
    h.attempt(c,1500,true,next.attemptKind);
  }
  assert.equal(h.p.facts[c.id].stage,"MAINTENANCE");
  assert.equal(h.p.facts[reverse.id].stage,"TRAINING");
  assert.equal(h.p.facts[reverse.id].coldStreak,0);
  const earned=JSON.stringify(h.p.facts[c.id]);
  h.end();h.start();h.attempt(reverse,4000,false,"training");
  assert.equal(JSON.stringify(h.p.facts[c.id]),earned);
  assert.equal(A.getProgressSummary(h.p,[c,reverse]).verified,1);
  assert.equal(A.getProgressSummary(h.p,[c,reverse]).score,500);
});

test("addition reversals are independent and existing own exposures still enforce spacing", () => {
  const c=card("add-9-7"),reverse=card("add-7-9"),h=harness([c,reverse]);assess(h,c);
  h.end();h.at(h.p.facts[c.id].dueAt);h.start();h.attempt(reverse,2500,true,"assessment");
  assert.equal(A.coldEligible(h.p,c,h.now),true);
  h.attempt(c,1000,true,"check");
  h.p.facts[c.id].dueAt=0;
  assert.equal(A.coldEligible(h.p,c,h.now),false);
  h.end();h.start();
  h.p.facts[c.id].stage="TRAINING";h.p.facts[reverse.id].stage="TRAINING";
  h.attempt(c,2000,true,"training");h.attempt(reverse,2000,true,"training");
  assert.ok(h.p.session.active.includes(c.id));assert.ok(h.p.session.active.includes(reverse.id));
});

test("tiny decks continue while retry gaps are pending", () => {
  const c=card("mul-3-2"),h=harness([c]);assess(h,c,2300);h.tick(60000);
  const next=h.select();assert.equal(next.kind,"question");assert.equal(next.fact.id,c.id);
  assert.equal(next.attemptKind,"extra");assert.equal(A.retryEligible(h.p,c,h.now),false);
  assert.equal(h.p.facts[c.id].stage,"TRAINING");
});

test("future mastered facts rotate freely, stay selected, and earn no early cold credit", () => {
  const cards=[card("mul-7-8"),card("mul-8-7"),card("mul-9-9")],h=harness(cards);
  for (const c of cards) {
    const fact=h.p.facts[c.id];fact.stage="MAINTENANCE";fact.dueAt=BASE+30*DAY;
    fact.coldStreak=4;fact.everVerifiedAutomatic=true;
  }
  let last=null;
  for (let i=0;i<30;i++) {
    const next=h.select(deck);assert.equal(next.kind,"question");
    assert.ok(cards.some(c=>c.id===next.fact.id));assert.notEqual(next.fact.id,last);
    assert.equal(next.attemptKind,"extra");last=next.fact.id;
    assert.equal(h.attempt(next.fact,1000,true,next.attemptKind).qualifiedCold,false);
  }
  for (const c of cards) {
    assert.equal(h.p.session.counts[c.id],10);assert.equal(h.p.facts[c.id].coldStreak,4);
    assert.equal(h.p.facts[c.id].stage,"MAINTENANCE");assert.equal(h.p.facts[c.id].dueAt,BASE+30*DAY);
  }
});

test("old saved sessions at the former cap resume and record more attempts", () => {
  const c=card("mul-3-2"),h=harness([c]);assess(h,c);
  h.p.session.counts[c.id]=5;h.p.session.gradedCount=5;
  h.p=A.resumeAutomaticSession(JSON.parse(JSON.stringify(h.p)),()=>h.now);
  const next=h.select();assert.equal(next.kind,"question");
  h.attempt(next.fact,1200,true,next.attemptKind);
  assert.equal(h.p.session.counts[c.id],6);assert.equal(h.p.session.gradedCount,6);
});

test("wrong or slow extra practice returns a finished fact to the preferred training queue", () => {
  for (const [correct,ms,questions,elapsed] of [[false,1000,3,15000],[true,2500,8,30000]]) {
    const c=card("mul-3-2"),h=harness();assess(h,c);
    assert.ok(h.p.session.finished.includes(c.id));
    h.attempt(c,ms,correct,"extra");
    assert.equal(h.p.session.finished.includes(c.id),false);
    h.fill(c,questions,elapsed);
    const next=h.select([c]);assert.equal(next.fact.id,c.id);assert.equal(next.attemptKind,"training");
  }
});

test("filtered-out records persist but no unselected/disabled facts are injected", () => {
  const allowed=card("add-8-9"),outside=card("mul-3-2"),h=harness([allowed]);
  h.p.facts[outside.id].stage="MAINTENANCE";h.p.facts[outside.id].dueAt=0;
  assert.equal(h.select(deck).fact.id,allowed.id);assert.equal(h.p.facts[outside.id].stage,"MAINTENANCE");
  assess(h,allowed);assert.equal(h.select(deck).fact.id,allowed.id);
  assert.equal(h.select([]).kind,"none");
});

test("duplicate and stale result IDs never grade again or grade the next presentation", () => {
  const h=harness(),c=card("mul-3-2");const id=h.show(c,"assessment");h.result(true,1300);
  const before=h.p;assert.equal(A.applyAttemptResult(h.p,{presentationId:id,correct:false,responseMs:900},()=>h.now),before);
  h.show(card("add-8-9"),"assessment");const beforeNext=h.p;
  assert.equal(A.applyAttemptResult(h.p,{presentationId:id,correct:false,responseMs:900},()=>h.now),beforeNext);
  assert.equal(h.p.session.gradedCount,1);
});

test("progress credit is separate from qualifying cold-check verification", () => {
  const h=harness(),c=card("mul-7-8");assess(h,c);h.fill(c,3);coldVisit(h,c,2400);
  const summary=A.getProgressSummary(h.p,deck,()=>h.now);
  assert.equal(summary.unassessed+summary.training+summary.verifying+summary.verified,summary.total);
  assert.equal(summary.assessed,summary.total-summary.unassessed);
  assert.equal(summary.coldChecks,1);assert.equal(summary.coldCorrectPercent,100);assert.equal(summary.coldAutomaticPercent,0);
  assert.equal(summary.verified,0);assert.ok(summary.score>0);
});

test("persisted reload retains retry counters, allocation, UUID identities and next selection", () => {
  const h=harness(),c=card("mul-7-8");h.end();
  h.p=A.startAutomaticSession(h.p,{id:"ae4cf9cc-4b02-4e90-b63e-941128ffd302",cards:deck,operation:"mul",targetCount:50},()=>h.now,()=>0.5);
  assess(h,c,2300);h.fill(c,8,30000);
  const before=h.p, restored=JSON.parse(JSON.stringify(before));
  h.p=A.resumeAutomaticSession(restored,()=>h.now);
  assert.equal(A.retryEligible(h.p,c,h.now),true);
  assert.equal(JSON.stringify(h.p.session.counts),JSON.stringify(before.session.counts));
  assert.equal(h.p.session.allocationPosition,before.session.allocationPosition);
  assert.equal(JSON.stringify(h.select()),JSON.stringify(A.selectNextQuestion(before,deck,()=>h.now,()=>0.5)));
  for(const e of h.p.events) assert.match(e.id,/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  assert.equal(new Set(h.p.events.map(e=>e.id)).size,h.p.events.length);
});

test("correction exposure still open at reload conservatively starts spacing at resume", () => {
  const h=harness(),c=card("mul-7-8");assess(h,c,900,false);
  h.p=A.beginAnswerExposure(h.p,c,()=>h.now);h.tick(120000);
  h.p=A.resumeAutomaticSession(JSON.parse(JSON.stringify(h.p)),()=>h.now);
  assert.equal(h.p.answerExposure,null);assert.equal(h.p.facts[c.id].pendingRetry.anchorAt,h.now);
  assert.equal(A.retryEligible(h.p,c,h.now),false);assert.equal(h.p.facts[c.id].latest.correct,false);
});

test("same-answer training follows spacing preferences then offers extra practice", () => {
  const target=card("mul-3-2"),same=card("add-3-3"),h=harness();
  assess(h,target,100,false);h.fill(target,3,15000);assess(h,same);
  assert.equal(h.select([target]).fact.id,target.id);
  h.p.facts[target.id].pendingRetry.minimumUnrelatedQuestions=99;
  assert.equal(h.select([target]).fact.id,target.id);assert.equal(h.select([target]).attemptKind,"extra");
});

test("assistance and corrected first answers reset verification without creating cold success", () => {
  for(const extra of [{assisted:true},{firstAnswerCorrect:false}]) {
    const c=card("mul-7-8"),h=harness();assess(h,c);h.end();h.at(h.p.facts[c.id].dueAt);h.start();
    h.show(c,"check");h.result(true,500,extra);
    assert.equal(h.p.facts[c.id].stage,"TRAINING");assert.equal(h.p.facts[c.id].coldStreak,0);
    assert.equal(h.p.events.at(-1).result,"WRONG_OR_ASSISTED");
  }
});


test("display progress credits correctness and fluency for every operation without changing verification", () => {
  for (const id of ["add-3-4","sub-7-3","mul-7-8"]) {
    const c=card(id),h=harness([c]);
    assert.equal(A.getProgressSummary(h.p,[c]).score,0);
    assess(h,c,1000,false);assert.equal(A.getProgressSummary(h.p,[c]).score,0);
    h.end();h.start();assess(h,c,3000);assert.equal(A.getProgressSummary(h.p,[c]).score,750);
    h.end();h.start();assess(h,c,2000);assert.equal(A.getProgressSummary(h.p,[c]).score,875);
    h.end();h.start();assess(h,c,1501);assert.equal(A.getProgressSummary(h.p,[c]).score,999);
    h.end();h.start();assess(h,c,1500);assert.equal(A.getProgressSummary(h.p,[c]).score,1000);
    assert.equal(A.getProgressSummary(h.p,[c]).verified,0);
    h.end();h.start();assess(h,c,800,false);assert.equal(A.getProgressSummary(h.p,[c]).score,0);
  }
});
test("progress averages distinct selected facts, counts unseen as no evidence, and never inflates from repeated easy facts", () => {
 const a=card("mul-3-2"),b=card("mul-7-8"),h=harness([a,b]);
 assess(h,a,1000);assert.equal(A.getProgressSummary(h.p,[a,b]).score,500);
 h.end();h.start();assess(h,a,1000);assert.equal(A.getProgressSummary(h.p,[a,b]).score,500);
 assess(h,b,3000);assert.equal(A.getProgressSummary(h.p,[a,b]).score,875);
 assert.equal(A.getProgressSummary(h.p,[b]).score,750);
 assert.equal(A.getProgressSummary(h.p,[]).score,0);
});
test("assisted and corrected first answers do not earn progress; technical failures preserve prior evidence", () => {
 const c=card("mul-7-8"),h=harness([c]);
 h.attempt(c,1000,true,"assessment",{assisted:true});assert.equal(A.getProgressSummary(h.p,[c]).score,0);
 h.end();h.start();h.attempt(c,1000,true,"assessment",{firstAnswerCorrect:false});assert.equal(A.getProgressSummary(h.p,[c]).score,0);
 h.end();h.start();assess(h,c,3000);assert.equal(A.getProgressSummary(h.p,[c]).score,750);
 h.end();h.start();h.attempt(c,1000,false,"assessment",{invalid:true});assert.equal(A.getProgressSummary(h.p,[c]).score,750);
});
