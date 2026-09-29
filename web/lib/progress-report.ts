import { makeCards, type FactCard } from "./cards";
import { AUTOMATICITY_CONFIG } from "./automaticity-config";
import type { AutomaticProgress, AttemptEvent } from "./automaticity";
import type { Operation } from "./learning";

export type ReportAttempt = { id: string; fact: string; operation: Operation; answerCorrect: boolean; responseMs: number; at: string; audit?: AttemptEvent };
export type ReportSession = { id: string; operation: Operation; endedAt: string; attempts: ReportAttempt[] };
export type ReportProgress = Pick<AutomaticProgress, "facts">;
export const reportLabels = {
  practice: "Needs practice", slow: "Correct · building speed", fast: "Fast · verifying",
  mastered: "Mastered", unseen: "Not practiced",
} as const;
export type ReportStatus = keyof typeof reportLabels;
export const reportOperations: Record<Operation, string> = { add: "Addition", sub: "Subtraction", mul: "Multiplication" };
export function factLabel(card: FactCard) { return `${card.a} ${card.operation === "add" ? "+" : card.operation === "sub" ? "−" : "×"} ${card.b}`; }
const valid = (a: ReportAttempt) => Number.isFinite(a.responseMs) && a.responseMs >= 0 && a.audit?.result !== "INVALID" && a.audit?.result !== "ABANDONED";
const independentCorrect = (a: ReportAttempt) => a.answerCorrect && (!a.audit || (a.audit.firstAnswerCorrect && !a.audit.assisted));
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function metrics(attempts: ReportAttempt[]) {
  const correct = attempts.filter(independentCorrect);
  return { count: attempts.length, accuracy: attempts.length ? correct.length / attempts.length * 100 : null, averageMs: average(correct.map(a => a.responseMs)) };
}
function attemptFactId(a: ReportAttempt) {
  if (a.audit) return a.audit.factId;
  const match = a.fact.trim().match(/^(\d+)\s*[+×x*−-]\s*(\d+)$/i);
  return match ? `${a.operation}-${Number(match[1])}-${Number(match[2])}` : null;
}

export function buildProgressReport(operation: Operation, sessions: ReportSession[], progress?: ReportProgress | null) {
  const cards = makeCards(operation);
  const ids = new Set(cards.map(c => c.id));
  const seen = new Set<string>();
  const history = sessions.filter(s => s.operation === operation)
    .map(s => ({ ...s, attempts: s.attempts.filter(a => {
      if (a.operation !== operation || !valid(a) || !ids.has(attemptFactId(a) ?? "") || seen.has(a.id)) return false;
      seen.add(a.id); return true;
    }) })).filter(s => s.attempts.length).sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const attempts = history.flatMap(s => s.attempts);
  const grouped = new Map<string, ReportAttempt[]>();
  for (const a of attempts) {
    const id = attemptFactId(a)!;
    grouped.set(id, [...(grouped.get(id) ?? []), a]);
  }
  const facts = cards.map(card => {
    const recorded = (grouped.get(card.id) ?? []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const state = progress?.facts[card.id];
    const latest = state?.latest;
    const last = recorded.at(-1);
    const hasCurrent = latest && latest.result !== "INVALID" && latest.result !== "ABANDONED";
    const ms = hasCurrent ? latest.responseMs : last?.responseMs ?? null;
    const correct = hasCurrent ? latest.correct && latest.firstAnswerCorrect && !latest.assisted : last ? independentCorrect(last) : false;
    let status: ReportStatus = "unseen";
    if (state?.stage === "MAINTENANCE") status = "mastered";
    else if (ms !== null) status = !correct ? "practice" : ms > AUTOMATICITY_CONFIG.automaticityTargetMs ? "slow" : "fast";
    else if (state && (state.stage !== "UNASSESSED" || state.legacy?.attempts)) status = "practice";
    return { card, status, ...metrics(recorded), latestMs: ms,
      latestCorrect: ms === null ? null : correct,
      lastAt: hasCurrent ? new Date(latest.completedAt).toISOString() : last?.at ?? null };
  });
  const counts = Object.fromEntries(Object.keys(reportLabels).map(status => [status, facts.filter(f => f.status === status).length])) as Record<ReportStatus, number>;
  // Compare adjacent, equally sized groups of up to three nonempty sessions.
  const windowSize = Math.min(3, Math.floor(history.length / 2));
  const recent = windowSize ? metrics(history.slice(-windowSize).flatMap(s => s.attempts)) : null;
  const previous = windowSize ? metrics(history.slice(-2 * windowSize, -windowSize).flatMap(s => s.attempts)) : null;
  return { operation, facts, counts, total: cards.length, practiced: cards.length - counts.unseen,
    sessionCount: history.length, ...metrics(attempts), recent, previous, windowSize };
}

export function progressNarrative(report: ReturnType<typeof buildProgressReport>, name: string): string[] {
  const { counts, total, practiced, sessionCount, recent, previous, windowSize } = report;
  const subject = reportOperations[report.operation].toLowerCase();
  const opening = `${name}, this is your ${subject} progress snapshot. ${sessionCount
    ? `Your saved history includes ${report.count} answers across ${sessionCount} practice ${sessionCount === 1 ? "session" : "sessions"}.`
    : "There are no scored answers in your saved history for this operation yet, so we cannot describe a performance trend."} Your fact record covers ${practiced} of the ${total} possible facts, with ${counts.mastered} mastered and ${counts.fast} currently fast but still awaiting verification. Each fact is its own small learning goal; you do not need to tackle everything at once.`;
  let trend = "After you have two sessions with scored answers, this report can compare your recent accuracy and response times. For now, use the individual facts below to find a comfortable starting point.";
  if (recent && previous) {
    const delta = recent.accuracy! - previous.accuracy!;
    const direction = Math.abs(delta) < 0.5 ? "stayed about the same" : delta > 0 ? "increased" : "decreased";
    trend = `Comparing your latest ${windowSize === 1 ? "session" : `${windowSize} sessions`} with the previous ${windowSize === 1 ? "one" : windowSize}, accuracy ${direction}, from ${previous.accuracy!.toFixed(0)}% to ${recent.accuracy!.toFixed(0)}%.`;
    if (recent.averageMs !== null && previous.averageMs !== null) trend += ` Correct-answer time averaged ${(recent.averageMs / 1000).toFixed(2)} seconds, compared with ${(previous.averageMs / 1000).toFixed(2)} seconds before.`;
    trend += " These sets may contain different facts, so this comparison is a helpful snapshot, not a fixed judgment of your ability.";
  }
  const next = counts.practice + counts.slow > 0
    ? `Next, give a little attention to the ${counts.practice} facts needing practice and ${counts.slow} correct-but-slower facts.`
    : counts.unseen > 0 ? `Next, explore a few of the ${counts.unseen} unpracticed facts while continuing your scheduled reviews.`
      : "Next, keep returning for spaced reviews to help these answers stay familiar.";
  return [opening, trend, `${next} Aim for a correct answer first, then a comfortable response within ${(AUTOMATICITY_CONFIG.automaticityTargetMs / 1000).toFixed(1)} seconds. Mastery is confirmed through successful checks on later days, rather than one quick answer. Mistakes help identify what to work on next. Short, regular practice gives you another chance to build confidence.`];
}
