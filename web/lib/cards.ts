import { fsrsPriority } from "./fsrs-scheduler";
import { CardState, Operation, defaultState } from "./learning";

export type FactCard = { id: string; a: number; b: number; operation: Operation };

export function makeCards(operation: Operation): FactCard[] {
  const cards: FactCard[] = [];
  const minimum = operation === "add" ? 0 : 2;
  const maximum = operation === "add" ? 9 : 12;
  for (let a = minimum; a <= maximum; a += 1) {
    for (let b = minimum; b <= maximum; b += 1) {
      cards.push({ id: `${operation}-${a}-${b}`, a, b, operation });
    }
  }
  return cards;
}

export function buildQueue(cards: FactCard[], states: Record<string, CardState>, count: number) {
  const scored = cards.map((card) => ({ card, priority: fsrsPriority(states[card.id] ?? defaultState(card.id)), tieBreak: Math.random() }));
  const ordered = scored.sort((left, right) => (right.priority - left.priority) || (right.tieBreak - left.tieBreak)).map(({ card }) => card);
  const queue: FactCard[] = [];
  while (queue.length < count) {
    const batch = queue.length === 0 ? [...ordered] : [...ordered].sort(() => Math.random() - .5);
    queue.push(...batch);
  }
  return queue.slice(0, count);
}

export function answerFor(card: FactCard) {
  return card.operation === "add" ? card.a + card.b : card.a * card.b;
}
