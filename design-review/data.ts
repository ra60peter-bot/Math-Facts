import { makeCards, answerFor, type FactCard } from '../web/lib/cards';
import { createAutomaticProgress, getProgressSummary, type AutomaticProgress, type AttemptEvent } from '../web/lib/automaticity';
import type { Operation } from '../web/lib/learning';

export { makeCards, answerFor };
export type { FactCard, Operation };
export const operations: Operation[] = ['mul','add','sub'];
export const names = { mul:'Multiplication', add:'Addition', sub:'Subtraction' };
export const symbols = { mul:'×', add:'+', sub:'−' };
export const label = (c:FactCard) => `${c.a} ${symbols[c.operation]} ${c.b}`;
export type Outcome = 'fast'|'slow'|'wrong'|'disputed'|'untimed';
export type Result = { card:FactCard; outcome:Outcome; heard:string; ms:number|null; mode:'speech'|'keyboard'; retry:boolean; timing?:'onset'|'estimated'|'unavailable' };
export type Round = { id:string; student:string; operation:Operation; results:Result[]; total:number; at:string; problems:number };

export function seedProgress(student='Maya'):AutomaticProgress {
  const all=operations.flatMap(makeCards), p=createAutomaticProgress(`preview-${student}`,all,{},'UTC',()=>Date.parse('2026-10-05T12:00:00Z'));
  // Only the two explicitly fictional example learners start with sample history.
  // A newly added profile must not appear to have already mastered facts.
  if(!['Maya','Alex'].includes(student))return p;
  for(const operation of operations){
    makeCards(operation).forEach((card,i,cards)=>{
      const portion=(i+(student==='Alex'?19:0))%cards.length / cards.length;
      if(portion>.69)return;
      const mastered=portion<.13, fast=portion<.44, slow=portion<.62;
      const correct=fast||slow;
      const ms=fast?980+(i%4)*110:slow?2100+(i%3)*170:1900;
      const f=p.facts[card.id];
      f.stage=mastered?'MAINTENANCE':fast?'VERIFYING':'TRAINING';
      f.coldStreak=mastered?4:0;f.everVerifiedAutomatic=mastered;
      f.latest={id:`sample-${card.id}`,learnerId:p.learnerId,sessionId:'sample',factId:card.id,familyId:f.familyId,answer:answerFor(card),presentedAt:0,completedAt:1,responseMs:ms,correct,assisted:false,firstAnswerCorrect:correct,kind:'assessment',coldEligible:false,qualifiedCold:false,result:fast?'FAST_CORRECT':slow?'SLOW_CORRECT':'WRONG_OR_ASSISTED',heard:String(answerFor(card)+(correct?0:1))};
    });
  }
  return p;
}
export function withRounds(student:string,rounds:Round[]){
  const p=seedProgress(student);
  for(const round of rounds.filter(r=>r.student===student).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)))for(const r of round.results){
    // The prototype demonstrates evidence separation: typed, disputed, retried,
    // and uncertain-timing answers do not manufacture spoken automaticity credit.
    if(!comparableSpokenResult(r))continue;
    const f=p.facts[r.card.id], correct=r.outcome!=='wrong';
    if(!f)continue;
    f.latest={...f.latest,id:`${round.id}-${r.card.id}`,learnerId:p.learnerId,sessionId:round.id,factId:r.card.id,familyId:f.familyId,answer:answerFor(r.card),presentedAt:0,completedAt:Date.parse(round.at),responseMs:r.ms,correct,firstAnswerCorrect:correct,assisted:false,kind:'extra',coldEligible:false,qualifiedCold:false,result:r.outcome==='fast'?'FAST_CORRECT':r.outcome==='slow'?'SLOW_CORRECT':'WRONG_OR_ASSISTED',heard:r.heard} as AttemptEvent;
    if(!correct||r.outcome==='slow'){
      f.stage='TRAINING';f.coldStreak=0;f.coldDates=[];f.firstColdAt=null;f.lastColdAt=null;f.lastColdDate=null;
    }else if(f.stage!=='MAINTENANCE')f.stage='VERIFYING';
  }
  return p;
}
export function summary(student:string,operation:Operation,rounds:Round[]){return getProgressSummary(withRounds(student,rounds),makeCards(operation));}
export function factStatus(p:AutomaticProgress,c:FactCard){const f=p.facts[c.id];return !f.latest?'unseen':f.stage==='MAINTENANCE'?'mastered':f.latest.result==='WRONG_OR_ASSISTED'?'practice':f.latest.result==='FAST_CORRECT'?'fast':'slow';}
export const statusLabels={mastered:'Mastered',fast:'Fast · checking over time',slow:'Correct · building speed',practice:'Needs practice',unseen:'Not tried yet'};
export function comparableSpokenResult(r:Result):r is Result & {ms:number}{
  return r.mode==='speech'&&!r.retry&&r.outcome!=='disputed'&&r.outcome!=='untimed'&&
    r.timing!=='estimated'&&r.timing!=='unavailable'&&r.ms!==null&&Number.isFinite(r.ms)&&r.ms>0;
}
export function roundMetrics(round:Round){
  const scored=round.results.filter(r=>r.outcome!=='disputed');
  const correct=scored.filter(r=>r.outcome!=='wrong').length;
  const timed=scored.filter(comparableSpokenResult);
  return {scored,correct,timed,average:timed.length?timed.reduce((s,r)=>s+r.ms!,0)/timed.length:null};
}
