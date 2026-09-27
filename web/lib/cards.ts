import type { Operation } from "./learning";

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
  const maximum = operation === "add" ? 9 : 12;
  for (let a = minimum; a <= maximum; a += 1) {
    for (let b = minimum; b <= maximum; b += 1) {
      cards.push({ id: `${operation}-${a}-${b}`, a, b, operation });
    }
  }
  return cards;
}

export function answerFor(card: FactCard) {
  if (card.operation === "add") return card.a + card.b;
  if (card.operation === "sub") return card.a - card.b;
  return card.a * card.b;
}
