import { TARGET_MS } from "./learning";

type HistoryAttempt = { answerCorrect: boolean; responseMs: number; at: string };
export type HistorySort = "question" | "result";

export function historyResult(attempt: HistoryAttempt): "wrong" | "slow" | "correct" {
  return !attempt.answerCorrect ? "wrong" : attempt.responseMs > TARGET_MS ? "slow" : "correct";
}

export function sortHistoryAttempts<T extends HistoryAttempt>(attempts: T[], sort: HistorySort) {
  const numbered = [...attempts]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((attempt, index) => ({ attempt, questionNumber: index + 1 }));
  const rank = { wrong: 0, slow: 1, correct: 2 };
  if (sort === "result") numbered.sort((a, b) =>
    rank[historyResult(a.attempt)] - rank[historyResult(b.attempt)] ||
    b.attempt.responseMs - a.attempt.responseMs || a.questionNumber - b.questionNumber);
  return numbered;
}
