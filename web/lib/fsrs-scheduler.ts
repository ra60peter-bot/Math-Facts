import { createEmptyCard, fsrs, Rating, type Card } from "ts-fsrs";
import { type CardState, type FsrsCardState, type Grade, updateCardState } from "./learning";

const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: true });

function deserialize(stored: FsrsCardState | null, now: Date): Card {
  if (!stored) return createEmptyCard(now);
  return {
    due: new Date(stored.due),
    stability: stored.stability,
    difficulty: stored.difficulty,
    elapsed_days: stored.elapsedDays,
    scheduled_days: stored.scheduledDays,
    learning_steps: stored.learningSteps,
    reps: stored.reps,
    lapses: stored.lapses,
    state: stored.state,
    last_review: stored.lastReview ? new Date(stored.lastReview) : undefined,
  } as Card;
}

function serialize(card: Card): FsrsCardState {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review?.toISOString() ?? null,
  };
}

function ratingFor(grade: Grade) {
  if (grade === "again") return Rating.Again;
  if (grade === "hard") return Rating.Hard;
  if (grade === "easy") return Rating.Easy;
  return Rating.Good;
}

export function reviewCardState(previous: CardState, grade: Grade, responseMs: number, now = new Date()): CardState {
  const metrics = updateCardState(previous, grade, responseMs);
  const reviewed = scheduler.next(deserialize(previous.fsrs, now), now, ratingFor(grade)).card;
  return {
    ...metrics,
    dueAt: reviewed.due.toISOString(),
    intervalDays: reviewed.scheduled_days,
    fsrs: serialize(reviewed),
  };
}

export function fsrsPriority(state: CardState, now = new Date()) {
  if (!state.fsrs) return 1_000_000;
  const card = deserialize(state.fsrs, now);
  const dueDeltaDays = (now.getTime() - card.due.getTime()) / 86_400_000;
  const retrievability = scheduler.get_retrievability(card, now, false);
  if (dueDeltaDays >= 0) return 500_000 + ((1 - retrievability) * 100_000) + Math.min(dueDeltaDays, 365);
  return ((1 - retrievability) * 100_000) + dueDeltaDays;
}
