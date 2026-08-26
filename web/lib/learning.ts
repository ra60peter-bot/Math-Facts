export type Operation = "add" | "sub" | "mul";
export type Grade = "again" | "hard" | "good" | "easy";
export type FsrsCardState = {
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: string | null;
};
export type CardState = {
  cardId: string;
  state: "learning" | "reviewing" | "mastered";
  totalAttempts: number;
  totalCorrect: number;
  consecutiveCorrect: number;
  consecutiveFast: number;
  consecutiveFailures: number;
  rollingAvgMs: number;
  lastResponseMs: number;
  difficulty: number;
  intervalDays: number;
  dueAt: string | null;
  lastSeenAt: string | null;
  fsrs: FsrsCardState | null;
};

export const FAST_MS = 950;
export const TARGET_MS = 1500;
export const TIMEOUT_MS = 6000;

export function defaultState(cardId: string): CardState {
  return { cardId, state: "learning", totalAttempts: 0, totalCorrect: 0, consecutiveCorrect: 0, consecutiveFast: 0, consecutiveFailures: 0, rollingAvgMs: 0, lastResponseMs: 0, difficulty: 0.3, intervalDays: 0, dueAt: null, lastSeenAt: null, fsrs: null };
}

export function gradeResponse(isCorrect: boolean, responseMs: number): Grade {
  if (!isCorrect || responseMs >= TIMEOUT_MS) return "again";
  if (responseMs > TARGET_MS) return "hard";
  return responseMs <= FAST_MS ? "easy" : "good";
}

function plusDays(days: number, now: Date) {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

export function updateCardState(previous: CardState, grade: Grade, responseMs: number, now = new Date()): CardState {
  const state = { ...previous, totalAttempts: previous.totalAttempts + 1, lastResponseMs: responseMs, lastSeenAt: now.toISOString() };
  state.rollingAvgMs = previous.rollingAvgMs === 0 ? responseMs : (0.3 * responseMs) + (0.7 * previous.rollingAvgMs);

  if (grade === "again") {
    state.consecutiveCorrect = 0;
    state.consecutiveFast = 0;
    state.consecutiveFailures += 1;
    state.difficulty = Math.min(1, state.difficulty + 0.2);
    state.state = "learning";
    state.intervalDays = 0;
    state.dueAt = now.toISOString();
    return state;
  }

  state.totalCorrect += 1;
  state.consecutiveCorrect += 1;
  state.consecutiveFailures = 0;
  state.difficulty = Math.max(0, state.difficulty - (grade === "easy" ? 0.2 : 0.1));
  if (grade === "easy") state.consecutiveFast += 1;
  else if (grade === "hard") state.consecutiveFast = 0;

  if (state.state === "learning") {
    if (state.consecutiveCorrect >= 3) {
      state.state = "reviewing";
      state.intervalDays = 2;
      state.dueAt = plusDays(2, now);
    } else {
      state.intervalDays = 0;
      state.dueAt = now.toISOString();
    }
    return state;
  }

  if (state.state === "reviewing") {
    if (state.consecutiveFast >= 5) {
      state.state = "mastered";
      state.intervalDays = 45;
    } else if (grade === "hard") {
      state.intervalDays = Math.max(2, (state.intervalDays || 2) * 0.7);
    } else {
      const steps = [2, 5, 12, 25, 50];
      let next = steps.find((step) => step > state.intervalDays) ?? 50;
      if (grade === "easy") next = steps.find((step) => step > next) ?? 50;
      state.intervalDays = next;
    }
    state.dueAt = plusDays(state.intervalDays, now);
    return state;
  }

  state.intervalDays = grade === "hard" ? Math.max(7, 45 * 0.5) : 45;
  state.dueAt = plusDays(state.intervalDays, now);
  return state;
}

export function priorityFor(state: CardState, now = new Date()) {
  const base = state.state === "learning" ? 100 : state.state === "reviewing" ? 50 : 5;
  let overdue = 1;
  if (state.dueAt) {
    const dueTime = Date.parse(state.dueAt);
    if (Number.isFinite(dueTime)) {
      const overdueDays = (now.getTime() - dueTime) / 86_400_000;
      overdue = overdueDays <= 0 ? 0.1 : overdueDays <= 2 ? 1 : 1 + Math.min((overdueDays - 2) / Math.max(state.intervalDays, 2), 3);
    }
  }
  const speed = state.rollingAvgMs > TARGET_MS ? 1.5 : state.rollingAvgMs > FAST_MS ? 1.2 : 1;
  return base * overdue * (1 + state.difficulty) * speed * (1 + Math.min(state.consecutiveFailures * 0.5, 2));
}

export function masteryScore(states: CardState[]) {
  if (!states.length) return { score: 0, mastered: 0, attempted: 0 };
  let points = 0;
  let mastered = 0;
  let attempted = 0;
  for (const state of states) {
    if (!state.totalAttempts) continue;
    attempted += 1;
    const accuracy = state.totalCorrect / state.totalAttempts;
    const speed = state.rollingAvgMs <= 1500 ? 1 : state.rollingAvgMs >= 5000 ? 0 : 1 - ((state.rollingAvgMs - 1500) / 3500);
    const consistency = Math.min(state.consecutiveCorrect / 5, 1);
    const isMastered = state.state === "mastered" || (accuracy >= .9 && state.rollingAvgMs <= 2000 && state.consecutiveCorrect >= 3);
    if (isMastered) mastered += 1;
    points += isMastered && state.rollingAvgMs <= 1500 ? 1 : (.6 * accuracy) + (.25 * speed) + (.15 * consistency);
  }
  return { score: roundHalfToEven((points / states.length) * 1000), mastered, attempted };
}

function roundHalfToEven(value: number) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (Math.abs(fraction - 0.5) < Number.EPSILON * Math.max(1, Math.abs(value))) {
    return lower % 2 === 0 ? lower : lower + 1;
  }
  return Math.round(value);
}
