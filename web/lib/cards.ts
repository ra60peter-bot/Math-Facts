import { CardState, Operation, defaultState, priorityFor } from "./learning";
import { fsrsRank } from "./fsrs-scheduler";

export type FactCard = { id: string; a: number; b: number; operation: Operation };

export function makeCards(operation: Operation): FactCard[] {
  const cards: FactCard[] = [];
  if (operation === "sub") {
    for (let a = 1; a <= 10; a += 1) {
      for (let b = 1; b < a; b += 1) cards.push({ id: `${operation}-${a}-${b}`, a, b, operation });
    }
    return cards;
  }

  const minimum = operation === "add" ? 1 : 2;
  const maximum = operation === "add" ? 9 : 15;
  for (let a = minimum; a <= maximum; a += 1) {
    for (let b = minimum; b <= maximum; b += 1) {
      cards.push({ id: `${operation}-${a}-${b}`, a, b, operation });
    }
  }
  return cards;
}

function shuffled<T>(values: T[], random: () => number) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function removeAdjacentDuplicates(queue: FactCard[]) {
  if (new Set(queue.map((card) => card.id)).size <= 1) return queue;
  for (let index = 1; index < queue.length; index += 1) {
    if (queue[index].id !== queue[index - 1].id) continue;
    const swapIndex = queue.findIndex((card, candidate) => candidate > index && card.id !== queue[index - 1].id);
    if (swapIndex >= 0) [queue[index], queue[swapIndex]] = [queue[swapIndex], queue[index]];
  }
  return queue;
}

export function buildQueue(cards: FactCard[], states: Record<string, CardState>, count: number, random: () => number = Math.random) {
  if (count <= 0 || cards.length === 0) return [];
  const scored = cards.map((card) => {
    const state = states[card.id] ?? defaultState(card.id);
    return { card, rank: fsrsRank(state), tieBreaker: priorityFor(state) * (0.85 + random() * 0.3) };
  });
  const ordered = scored.sort((left, right) => {
    if (left.rank.bucket !== right.rank.bucket) return left.rank.bucket - right.rank.bucket;
    if (left.rank.value !== right.rank.value) return left.rank.value - right.rank.value;
    return right.tieBreaker - left.tieBreaker;
  }).map(({ card }) => card);
  const queue: FactCard[] = [];
  while (queue.length < count) {
    const batch = queue.length === 0 ? [...ordered] : shuffled(ordered, random);
    queue.push(...batch);
  }
  return removeAdjacentDuplicates(queue.slice(0, count));
}

export function insertRetry(queue: FactCard[], nextIndex: number, card: FactCard, gap: number) {
  if (nextIndex >= queue.length) return;
  const preferred = Math.min(nextIndex + gap, queue.length - 1);
  const positions = [
    ...Array.from({ length: queue.length - preferred }, (_, offset) => preferred + offset),
    ...Array.from({ length: Math.max(0, preferred - nextIndex) }, (_, offset) => nextIndex + offset),
  ];
  const naturalRetry = positions.find((position) => queue[position].id === card.id && queue[position - 1]?.id !== card.id);
  if (naturalRetry !== undefined) return;

  const replacement = positions.find((position) => queue[position - 1]?.id !== card.id && queue[position + 1]?.id !== card.id);
  if (replacement !== undefined) queue[replacement] = card;
}

export function answerFor(card: FactCard) {
  if (card.operation === "add") return card.a + card.b;
  if (card.operation === "sub") return card.a - card.b;
  return card.a * card.b;
}
