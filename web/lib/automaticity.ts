import { AUTOMATICITY_CONFIG as C } from "./automaticity-config";
import type { FactCard } from "./cards";
import type { CardState, Operation } from "./learning";

const DAY = 86400000;
export type LearningStage = "UNASSESSED" | "TRAINING" | "VERIFYING" | "MAINTENANCE";
export type ResultClass = "WRONG_OR_ASSISTED" | "FAST_CORRECT" | "SLOW_CORRECT" | "VERY_SLOW_CORRECT";
export type AttemptKind = "assessment" | "training" | "check" | "extra";
type Retry = { anchorAt: number; afterCompletion: number; minimumElapsedMs: number; minimumUnrelatedQuestions: number };
export type AutomaticFact = {
  id: string; familyId: string; stage: LearningStage; dueAt: number | null; intervalLevel: number;
  coldStreak: number; coldDates: string[]; firstColdAt: number | null; lastColdAt: number | null; lastColdDate: string | null;
  everVerifiedAutomatic: boolean; latest: AttemptEvent | null; pendingRetry: Retry | null; trainingSince: number | null;
  legacy?: { attempts: number; state: string; lastResponseMs: number | null };
};
export type Exposure = { factId: string; familyId: string; answer: number; at: number; date: string; kind: "prompt" | "answer" | "legacy"; presentationId?: string };
export type Presentation = { id: string; fact: FactCard; kind: AttemptKind; presentedAt: number; coldEligible: boolean };
export type AttemptEvent = {
  id: string; learnerId: string; sessionId: string; factId: string; familyId: string; answer: number;
  presentedAt: number; completedAt: number; responseMs: number; correct: boolean; assisted: boolean;
  firstAnswerCorrect: boolean; kind: AttemptKind; coldEligible: boolean; qualifiedCold: boolean;
  result: ResultClass | "INVALID" | "ABANDONED"; heard: string;
  timingReliable?: boolean; retry?: boolean; disputed?: boolean;
};
export type AutomaticSession = {
  id: string; startedAt: number; endedAt: number | null; operation: Operation; factIds: string[]; targetCount: number;
  counts: Record<string, number>; fastStreaks: Record<string, number>; active: string[]; finished: string[];
  allocationPosition: number; coverageOrder: string[]; presentedCount: number; gradedCount: number;
  current: Presentation | null; status: "active" | "paused" | "ended";
};
export type AutomaticProgress = {
  version: 1; learnerId: string; timeZone: string; revision: number; updatedAt: number;
  facts: Record<string, AutomaticFact>; exposures: Exposure[]; events: AttemptEvent[];
  completions: { factId: string; familyId: string; answer: number; at: number }[];
  session: AutomaticSession | null; answerExposure: { fact: FactCard; startedAt: number } | null;
};
export type Selection = { kind: "question"; fact: FactCard; attemptKind: AttemptKind } | { kind: "none"; reason: string; nextUsefulAt: number | null };
export type Clock = () => number;
export const stageLabels: Record<LearningStage, string> = { UNASSESSED: "Not assessed", TRAINING: "Building speed", VERIFYING: "Fast in practice; verifying", MAINTENANCE: "Verified automatic" };

export function answer(card: FactCard) { return card.operation === "add" ? card.a + card.b : card.operation === "sub" ? card.a - card.b : card.a * card.b; }
export function familyId(card: FactCard) {
  // Retained as audit metadata for existing snapshots; scheduling uses ordered IDs.
  const operands = card.operation === "sub" ? [card.a, card.b] : [Math.min(card.a, card.b), Math.max(card.a, card.b)];
  return `${card.operation}:${operands.join(":")}`;
}
function isReverse(card: FactCard, id: string) {
  return card.operation !== "sub" && card.a !== card.b && id === `${card.operation}-${card.b}-${card.a}`;
}
export function practiceDate(at: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
function emptyFact(card: FactCard): AutomaticFact {
  return { id: card.id, familyId: familyId(card), stage: "UNASSESSED", dueAt: null, intervalLevel: 0, coldStreak: 0, coldDates: [], firstColdAt: null, lastColdAt: null, lastColdDate: null, everVerifiedAutomatic: false, latest: null, pendingRetry: null, trainingSince: null };
}
function copy(progress: AutomaticProgress, now: number) {
  const next: AutomaticProgress = JSON.parse(JSON.stringify(progress));
  next.updatedAt = now; next.revision += 1;
  return next;
}
export function createAutomaticProgress(learnerId: string, cards: FactCard[], legacy: Record<string, CardState> = {}, timeZone = "UTC", clock: Clock = Date.now): AutomaticProgress {
  const now = clock();
  const progress: AutomaticProgress = { version: 1, learnerId, timeZone, revision: 0, updatedAt: now, facts: {}, exposures: [], events: [], completions: [], session: null, answerExposure: null };
  for (const card of cards) {
    const fact = emptyFact(card); progress.facts[card.id] = fact;
    const old = legacy[card.id];
    // Legacy records do not identify first-answer assistance or cold eligibility.
    // Keep them as history, never manufacture a verification streak from them.
    if (old?.totalAttempts) {
      fact.legacy = { attempts: old.totalAttempts, state: old.state, lastResponseMs: Number.isFinite(old.lastResponseMs) ? old.lastResponseMs : null };
      const at = Date.parse(old.lastSeenAt ?? "");
      if (Number.isFinite(at)) progress.exposures.push({ factId: card.id, familyId: fact.familyId, answer: answer(card), at, date: practiceDate(at, timeZone), kind: "legacy" });
    }
  }
  return progress;
}
export function classifyResult(input: { correct: boolean; responseMs: number; assisted?: boolean; firstAnswerCorrect?: boolean; timeout?: boolean }): ResultClass {
  if (!input.correct || input.firstAnswerCorrect === false || input.assisted || input.timeout) return "WRONG_OR_ASSISTED";
  if (input.responseMs <= C.automaticityTargetMs) return "FAST_CORRECT";
  return input.responseMs <= C.verySlowThresholdMs ? "SLOW_CORRECT" : "VERY_SLOW_CORRECT";
}
export function startAutomaticSession(progress: AutomaticProgress, options: { id: string; cards: FactCard[]; operation: Operation; targetCount: number }, clock: Clock = Date.now, random = Math.random) {
  // Resume unfinished work without resetting its count or warm streaks.
  if (progress.session && progress.session.status !== "ended") return resumeAutomaticSession(progress, clock);
  const next = copy(progress, clock());
  const ids = options.cards.map(card => card.id);
  for (const card of options.cards) next.facts[card.id] ??= emptyFact(card);
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  next.session = { id: options.id, startedAt: clock(), endedAt: null, operation: options.operation, factIds: ids, targetCount: options.targetCount, counts: {}, fastStreaks: {}, active: [], finished: [], allocationPosition: 0, coverageOrder: order, presentedCount: 0, gradedCount: 0, current: null, status: "active" };
  return next;
}
export function coldEligible(progress: AutomaticProgress, card: FactCard, now: number) {
  const fact = progress.facts[card.id];
  if (!fact || fact.dueAt === null || fact.dueAt > now) return false;
  const date = practiceDate(now, progress.timeZone);
  if (progress.answerExposure?.fact.id === card.id) return false;
  if (progress.exposures.some(e => e.factId === card.id && (now - e.at < C.minimumColdGapMs || e.date === date))) return false;
  // Carry recent priming across reloads/session boundaries, but yesterday's
  // last answer must not force a warm-up before today's first cold check.
  // Reversed prompts are independent, including when they share an answer.
  return !progress.completions.slice(-C.recentAnswerPrimingWindow).some(e => now - e.at < C.minimumColdGapMs && e.answer === answer(card) && !isReverse(card, e.factId));
}
export function retryEligible(progress: AutomaticProgress, card: FactCard, now: number) {
  const retry = progress.facts[card.id]?.pendingRetry;
  if (!retry) return true;
  if (now - retry.anchorAt < retry.minimumElapsedMs) return false;
  const unrelated = progress.completions.slice(retry.afterCompletion).filter(e => e.at >= retry.anchorAt && e.factId !== card.id && (e.answer !== answer(card) || isReverse(card, e.factId)));
  return unrelated.length >= retry.minimumUnrelatedQuestions;
}
export function selectNextQuestion(progress: AutomaticProgress, enabled: FactCard[], clock: Clock = Date.now, random = Math.random): Selection {
  const now = clock(), session = progress.session;
  if (!session || session.status === "ended") return { kind: "none", reason: "Start a new session to practice.", nextUsefulAt: null };
  if (session.current) return { kind: "none", reason: "Finish or skip the current question first.", nextUsefulAt: null };
  if (session.gradedCount >= session.targetCount) return { kind: "none", reason: "Your selected practice size is complete.", nextUsefulAt: null };
  const cards = enabled.filter(card => session.factIds.includes(card.id));
  // Spacing guides the preferred queue; it never prevents optional practice.
  const available = cards.filter(card => !session.finished.includes(card.id));
  const last = progress.exposures.filter(e => e.kind === "prompt").at(-1);
  // A fresh later visit is not adjacent to yesterday's last question.
  const adjacent = last && now - last.at < C.minimumColdGapMs ? last : null;
  const guards = (card: FactCard) => !adjacent || card.id !== adjacent.factId;
  const due = available.filter(card => coldEligible(progress, card, now) && guards(card));
  const reservedFacts = new Set(due.map(card => card.id));
  const waiting = available.filter(card => progress.facts[card.id]?.stage === "TRAINING" && !reservedFacts.has(card.id));
  const active = session.active.filter(id => waiting.some(card => card.id === id));
  const tie = new Map(cards.map(card => [card.id, random()]));
  const trainingAge = (card: FactCard) => progress.facts[card.id].latest?.completedAt ?? progress.facts[card.id].trainingSince ?? 0;
  const sortedWaiting = waiting.filter(card => !active.includes(card.id)).sort((a, b) => trainingAge(a) - trainingAge(b) || (tie.get(a.id)! - tie.get(b.id)!));
  for (const card of sortedWaiting) {
    if (active.length >= C.activeTrainingPromptLimit) break;
    active.push(card.id);
  }
  let training = waiting.filter(card => active.includes(card.id) && guards(card) && retryEligible(progress, card, now));
  let assessments = available.filter(card => progress.facts[card.id]?.stage === "UNASSESSED" && guards(card));
  let checks = due;
  const differentAnswer = (card: FactCard) => !adjacent || answer(card) !== adjacent.answer || isReverse(card, adjacent.factId);
  if ([...training, ...assessments, ...checks].some(differentAnswer)) {
    training = training.filter(differentAnswer); assessments = assessments.filter(differentAnswer); checks = checks.filter(differentAnswer);
  } else {
    // Only ordinary training may relax same-answer adjacency, never its retry gaps.
    assessments = assessments.filter(differentAnswer); checks = checks.filter(differentAnswer);
  }
  training.sort((a, b) => (progress.facts[a.id].pendingRetry?.anchorAt ?? trainingAge(a)) - (progress.facts[b.id].pendingRetry?.anchorAt ?? trainingAge(b)) || (tie.get(a.id)! - tie.get(b.id)!));
  checks.sort((a, b) => progress.facts[a.id].dueAt! - progress.facts[b.id].dueAt! || (tie.get(a.id)! - tie.get(b.id)!));
  assessments.sort((a, b) => session.coverageOrder.indexOf(a.id) - session.coverageOrder.indexOf(b.id));
  // Avoid ordered runs such as 3×3, 3×4, 3×5, while preserving the
  // scheduler's training/check allocation and every eligibility guard.
  const lastCards = progress.completions.slice(-2).map(e => ({ id: e.factId, answer: e.answer, parts: e.factId.split("-") }));
  const predictable = (card: FactCard) => {
    const previous = lastCards.at(-1);
    if (!previous) return false;
    const a = Number(previous.parts[1]), b = Number(previous.parts[2]);
    const neighbor = card.operation === "mul" && ((card.a === a && Math.abs(card.b - b) === 1) || (card.b === b && Math.abs(card.a - a) === 1));
    const reverse = card.operation !== "sub" && card.a === b && card.b === a;
    const run = lastCards.length === 2 && answer(card) - previous.answer === previous.answer - lastCards[0].answer;
    return neighbor || reverse || run;
  };
  const mix = (pool: FactCard[]) => [...pool.filter(c => !predictable(c)), ...pool.filter(predictable)];
  training = mix(training); checks = mix(checks); assessments = mix(assessments);
  const check = checks[0] ?? assessments[0];
  const preferred = C.allocation[session.allocationPosition % C.allocation.length];
  const chosen = preferred === "TRAINING" ? training[0] ?? check : check ?? training[0];
  if (chosen) return { kind: "question", fact: chosen, attemptKind: checks.includes(chosen) ? "check" : assessments.includes(chosen) ? "assessment" : "training" };
  // Keep every selected fact available, even immediately after a correct answer,
  // before a retry is due, or after mastery. Rotate when possible, but a one-fact
  // selection can repeat for the entire set. Extra attempts never earn cold credit.
  const alternatives = cards.filter(guards);
  const practice = alternatives.length ? alternatives : cards;
  practice.sort((a, b) => (session.counts[a.id] ?? 0) - (session.counts[b.id] ?? 0)
    || Number(predictable(a)) - Number(predictable(b)) || (tie.get(a.id)! - tie.get(b.id)!));
  if (practice[0]) return { kind: "question", fact: practice[0], attemptKind: "extra" };
  return { kind: "none", reason: "Choose at least one fact to practice.", nextUsefulAt: null };
}
export function presentQuestion(progress: AutomaticProgress, selection: Extract<Selection, { kind: "question" }>, clock: Clock = Date.now) {
  const session = progress.session;
  if (!session || session.status === "ended" || session.current || session.gradedCount >= session.targetCount || !session.factIds.includes(selection.fact.id)) return progress;
  const now = clock(), next = copy(progress, now), s = next.session!;
  // Preserve UUID compatibility with the existing attempts table. Derive a
  // stable per-presentation UUID from the random session UUID and its counter.
  const id = /^[\da-f-]{36}$/i.test(s.id)
    ? s.id.slice(0, 24) + (BigInt(`0x${s.id.slice(24)}`) ^ BigInt(s.presentedCount + 1)).toString(16).padStart(12, "0")
    : `${s.id}:${s.presentedCount + 1}`;
  // Eligibility is captured BEFORE the current question becomes an exposure.
  s.current = { id, fact: selection.fact, kind: selection.attemptKind, presentedAt: now, coldEligible: selection.attemptKind === "check" && coldEligible(progress, selection.fact, now) };
  s.presentedCount++; s.allocationPosition++; s.status = "active";
  const fact = next.facts[selection.fact.id];
  s.active = s.active.filter(key => next.facts[key].stage === "TRAINING" && !s.finished.includes(key));
  if (selection.attemptKind === "training" && !s.active.includes(fact.id) && s.active.length < C.activeTrainingPromptLimit) s.active.push(fact.id);
  next.exposures.push({ factId: fact.id, familyId: fact.familyId, answer: answer(selection.fact), at: now, date: practiceDate(now, next.timeZone), kind: "prompt", presentationId: id });
  return next;
}
export type AttemptInput = { presentationId: string; correct: boolean; responseMs: number; assisted?: boolean; firstAnswerCorrect?: boolean; timeout?: boolean; invalid?: boolean; abandoned?: boolean; heard?: string; timingReliable?: boolean; retry?: boolean; disputed?: boolean };
export function applyAttemptResult(progress: AutomaticProgress, input: AttemptInput, clock: Clock = Date.now): AutomaticProgress {
  const session = progress.session, presentation = session?.current;
  if (!session || session.status === "ended" || !presentation || presentation.id !== input.presentationId || progress.events.some(e => e.id === input.presentationId)) return progress;
  const now = clock(), next = copy(progress, now), s = next.session!, fact = next.facts[presentation.fact.id];
  const invalid = input.invalid || !Number.isFinite(input.responseMs) || input.responseMs < 0;
  const result = invalid ? "INVALID" : input.abandoned ? "ABANDONED" : classifyResult(input);
  const event: AttemptEvent = { id: presentation.id, learnerId: next.learnerId, sessionId: s.id, factId: fact.id, familyId: fact.familyId, answer: answer(presentation.fact), presentedAt: presentation.presentedAt, completedAt: now, responseMs: Number.isFinite(input.responseMs) ? Math.max(0, input.responseMs) : 0, correct: input.correct, firstAnswerCorrect: input.firstAnswerCorrect ?? input.correct, assisted: Boolean(input.assisted), kind: presentation.kind, coldEligible: presentation.coldEligible, qualifiedCold: presentation.coldEligible && !input.assisted && !invalid && !input.abandoned, result, heard: input.heard ?? "" };
  next.events.push(event); s.current = null;
  if (input.timingReliable === false) event.timingReliable = false;
  if (input.retry) event.retry = true;
  if (input.disputed) event.disputed = true;
  if (event.timingReliable === false || event.retry || event.disputed) event.qualifiedCold = false;
  if (result === "INVALID" || result === "ABANDONED") return next;
  s.counts[fact.id] = (s.counts[fact.id] ?? 0) + 1; s.gradedCount++;
  next.completions.push({ factId: fact.id, familyId: fact.familyId, answer: event.answer, at: now });
  // Keep these attempts in history without awarding or removing mastery from
  // a retry, uncertain measurement, or a reported recognition mistake.
  if (event.retry || event.disputed || event.timingReliable === false) return next;
  fact.latest = event;
  if (result !== "FAST_CORRECT") {
    s.finished = s.finished.filter(id => id !== fact.id);
    fact.stage = "TRAINING"; fact.trainingSince ??= now;
    fact.coldStreak = 0; fact.coldDates = []; fact.firstColdAt = null; fact.intervalLevel = 0;
    fact.dueAt = now + C.crossDayIntervalsDays[0] * DAY; s.fastStreaks[fact.id] = 0;
    const retry = result === "WRONG_OR_ASSISTED" ? C.wrongRetry : result === "VERY_SLOW_CORRECT" ? C.verySlowCorrectRetry : C.slowCorrectRetry;
    fact.pendingRetry = { ...retry, anchorAt: now, afterCompletion: next.completions.length };
  } else if (event.qualifiedCold) {
    const date = practiceDate(now, next.timeZone);
    if (fact.lastColdDate !== date) {
      fact.coldStreak++; fact.coldDates.push(date); fact.firstColdAt ??= now; fact.lastColdAt = now; fact.lastColdDate = date;
      fact.intervalLevel = Math.min(fact.intervalLevel + 1, C.crossDayIntervalsDays.length - 1);
      fact.dueAt = now + C.crossDayIntervalsDays[fact.intervalLevel] * DAY;
      const verified = fact.coldStreak >= C.coldSuccessesRequiredForVerification && new Set(fact.coldDates).size >= C.coldSuccessesRequiredForVerification && now - fact.firstColdAt >= C.minimumVerificationSpanMs;
      fact.stage = verified ? "MAINTENANCE" : "VERIFYING"; fact.everVerifiedAutomatic ||= verified;
      fact.pendingRetry = null; fact.trainingSince = null; s.finished.push(fact.id);
    }
  } else if (fact.stage === "UNASSESSED") {
    fact.stage = "VERIFYING"; fact.intervalLevel = 0; fact.dueAt = now + C.crossDayIntervalsDays[0] * DAY; s.finished.push(fact.id);
  } else if (fact.stage === "TRAINING") {
    s.fastStreaks[fact.id] = (s.fastStreaks[fact.id] ?? 0) + 1;
    fact.dueAt = now + C.crossDayIntervalsDays[0] * DAY;
    if (s.fastStreaks[fact.id] >= C.fastTrainingSuccessesToFinishToday) {
      fact.stage = "VERIFYING"; fact.intervalLevel = 0; fact.pendingRetry = null; fact.trainingSince = null; s.finished.push(fact.id);
    } else fact.pendingRetry = { ...C.firstFastTrainingSuccessRetry, anchorAt: now, afterCompletion: next.completions.length };
  }
  if (s.finished.includes(fact.id)) s.active = s.active.filter(id => id !== fact.id);
  return next;
}
export function beginAnswerExposure(progress: AutomaticProgress, card: FactCard, clock: Clock = Date.now) {
  const now = clock(), next = copy(progress, now);
  next.answerExposure = { fact: card, startedAt: now };
  next.exposures.push({ factId: card.id, familyId: familyId(card), answer: answer(card), at: now, date: practiceDate(now, next.timeZone), kind: "answer" });
  return next;
}
export function endAnswerExposure(progress: AutomaticProgress, clock: Clock = Date.now) {
  if (!progress.answerExposure) return progress;
  const now = clock(), next = copy(progress, now), card = next.answerExposure!.fact;
  next.exposures.push({ factId: card.id, familyId: familyId(card), answer: answer(card), at: now, date: practiceDate(now, next.timeZone), kind: "answer" });
  const fact = next.facts[card.id];
  if (fact.pendingRetry) { fact.pendingRetry.anchorAt = now; fact.pendingRetry.afterCompletion = next.completions.length; }
  next.answerExposure = null;
  return next;
}
export function resumeAutomaticSession(progress: AutomaticProgress, clock: Clock = Date.now) {
  let next = endAnswerExposure(progress, clock);
  if (next.session?.current) next = applyAttemptResult(next, { presentationId: next.session.current.id, correct: false, responseMs: 0, abandoned: true }, clock);
  next = copy(next, clock());
  if (next.session && next.session.status !== "ended") next.session.status = "active";
  return next;
}
export function endAutomaticSession(progress: AutomaticProgress, clock: Clock = Date.now) {
  const next = resumeAutomaticSession(progress, clock);
  if (next.session) { next.session.status = "ended"; next.session.endedAt = clock(); }
  return next;
}
export function pauseAutomaticSession(progress: AutomaticProgress, clock: Clock = Date.now) {
  const next = resumeAutomaticSession(progress, clock);
  if (next.session && next.session.status !== "ended") next.session.status = "paused";
  return next;
}
export function getProgressSummary(progress: AutomaticProgress, cards: FactCard[], clock: Clock = Date.now) {
  const now = clock(), ids = new Set(cards.map(card => card.id));
  const facts = cards.map(card => progress.facts[card.id] ?? emptyFact(card));
  const count = (stage: LearningStage) => facts.filter(f => f.stage === stage).length;
  const cold = progress.events.filter(e => ids.has(e.factId) && e.qualifiedCold);
  const verified = count("MAINTENANCE");
  // Display progress independently from later cold-check verification. A correct
  // first answer earns half credit, with the other half proportional to speed.
  // Use each fact once so repeating one easy fact cannot inflate whole-deck progress.
  const credits = facts.map(fact => {
    const attempt = fact.latest;
    if (!attempt || !attempt.correct || !attempt.firstAnswerCorrect || attempt.assisted ||
      !["FAST_CORRECT", "SLOW_CORRECT", "VERY_SLOW_CORRECT"].includes(attempt.result)) return 0;
    return 500 + 500 * Math.min(1, C.automaticityTargetMs / Math.max(C.automaticityTargetMs, attempt.responseMs));
  });
  const fullCredit = credits.length > 0 && credits.every(credit => credit === 1000);
  const score = credits.length ? Math.min(fullCredit ? 1000 : 999, Math.round(credits.reduce((sum, credit) => sum + credit, 0) / credits.length)) : 0;
  return { total: cards.length, unassessed: count("UNASSESSED"), assessed: cards.length - count("UNASSESSED"), training: count("TRAINING"), verifying: count("VERIFYING"), verified, due: facts.filter(f => f.dueAt !== null && f.dueAt <= now).length, everVerified: facts.filter(f => f.everVerifiedAutomatic).length, coldChecks: cold.length, coldCorrectPercent: cold.length ? Math.round(cold.filter(e => e.correct && e.firstAnswerCorrect).length / cold.length * 100) : null, coldAutomaticPercent: cold.length ? Math.round(cold.filter(e => e.result === "FAST_CORRECT").length / cold.length * 100) : null, score };
}
