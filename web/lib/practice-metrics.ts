import type { AttemptEvent } from "./automaticity";
type Attempt = { answerCorrect: boolean; responseMs: number; audit?: AttemptEvent };
export function isScoredAttempt(attempt: Attempt) {
  return !attempt.audit?.disputed && attempt.audit?.result !== "INVALID" && attempt.audit?.result !== "ABANDONED";
}
export function hasComparableTime(attempt: Attempt) {
  return isScoredAttempt(attempt) && !attempt.audit?.retry && attempt.audit?.timingReliable !== false && Number.isFinite(attempt.responseMs) && attempt.responseMs >= 0;
}
export function practiceMetrics(attempts: Attempt[]) {
  const scored = attempts.filter(isScoredAttempt), timed = scored.filter(hasComparableTime);
  return { scored, timed, correct: scored.filter(a => a.answerCorrect).length,
    averageMs: timed.length ? timed.reduce((sum, a) => sum + a.responseMs, 0) / timed.length : null };
}
