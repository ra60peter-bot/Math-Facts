export type Operation = "add" | "mul";
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

function plusDays(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function updateCardState(previous: CardState, grade: Grade, responseMs: number): CardState {
  const state = { ...previous, totalAttempts: previous.totalAttempts + 1, lastResponseMs: responseMs, lastSeenAt: new Date().toISOString() };
  state.rollingAvgMs = previous.rollingAvgMs === 0 ? responseMs : (0.3 * responseMs) + (0.7 * previous.rollingAvgMs);

  if (grade === "again" || grade === "hard") {
    state.consecutiveCorrect = 0;
    state.consecutiveFast = 0;
    state.consecutiveFailures += 1;
    // A slow correct answer fails fluency; a wrong answer gets twice the penalty.
    state.difficulty = Math.min(1, state.difficulty + (grade === "again" ? 0.2 : 0.1));
    state.state = "learning";
    state.intervalDays = 0;
    state.dueAt = new Date().toISOString();
    return state;
  }

  state.totalCorrect += 1;
  state.consecutiveCorrect += 1;
  state.consecutiveFailures = 0;
  state.difficulty = Math.max(0, state.difficulty - (grade === "easy" ? 0.2 : 0.1));
  if (grade === "easy") state.consecutiveFast += 1;

  if (state.state === "learning") {
    if (state.consecutiveCorrect >= 3) {
      state.state = "reviewing";
      state.intervalDays = 2;
      state.dueAt = plusDays(2);
    } else {
      state.dueAt = new Date().toISOString();
    }
    return state;
  }

  if (state.state === "reviewing") {
    if (state.consecutiveFast >= 5) {
      state.state = "mastered";
      state.intervalDays = 45;
    } else {
      const steps = [2, 5, 12, 25, 50];
      let next = steps.find((step) => step > state.intervalDays) ?? 50;
      if (grade === "easy") next = steps.find((step) => step > next) ?? 50;
      state.intervalDays = next;
    }
    state.dueAt = plusDays(state.intervalDays);
    return state;
  }

  state.intervalDays = 45;
  state.dueAt = plusDays(state.intervalDays);
  return state;
}

export function priorityFor(state: CardState) {
  const base = state.state === "learning" ? 100 : state.state === "reviewing" ? 50 : 5;
  const overdueDays = state.dueAt ? (Date.now() - Date.parse(state.dueAt)) / 86_400_000 : 0;
  const overdue = overdueDays <= 0 ? 0.1 : overdueDays <= 2 ? 1 : 1 + Math.min((overdueDays - 2) / Math.max(state.intervalDays, 2), 3);
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
  return { score: Math.round((points / states.length) * 1000), mastered, attempted };
}
