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
  const metrics = updateCardState(previous, grade, responseMs, now);
  const reviewed = scheduler.next(deserialize(previous.fsrs, now), now, ratingFor(grade)).card;
  return {
    ...metrics,
    fsrs: serialize(reviewed),
  };
}

export function fsrsRank(state: CardState, now = new Date()) {
  if (!state.fsrs) return { bucket: 1, value: 0 };
  const card = deserialize(state.fsrs, now);
  const dueAt = card.due.getTime();
  if (dueAt <= now.getTime()) {
    const retrievability = Number(scheduler.get_retrievability(card, now, false));
    return { bucket: 0, value: Number.isFinite(retrievability) ? retrievability : 0 };
  }
  return { bucket: 2, value: dueAt };
}
