import { answerFor, type FactCard } from '../web/lib/cards';

function shuffle(cards: FactCard[], random: () => number): FactCard[] {
  const shuffled = [...cards];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// These are ordering preferences, never eligibility rules. A child can select
// one fact or practice indefinitely even when spacing is mathematically impossible.
function transitionCost(history: FactCard[], card: FactCard): number {
  const previous = history.at(-1);
  if (!previous) return 0;
  let cost = previous.id === card.id ? 100_000 : 0;
  if (previous.operation === card.operation && previous.id !== card.id) {
    if (previous.a === card.b && previous.b === card.a) cost += 10_000;
    // Neighbors in either orientation invite skip-counting (3×4, 3×5),
    // including a switched orientation such as 4×3 followed by 3×5.
    if (card.operation === 'mul') {
      for (const [fixed, other] of [[previous.a, previous.b], [previous.b, previous.a]]) {
        if ((fixed === card.a && Math.abs(other - card.b) === 1) ||
            (fixed === card.b && Math.abs(other - card.a) === 1)) {
          cost += 1_000;
          break;
        }
      }
    }
  }
  const before = history.at(-2);
  if (before && before.operation === card.operation && previous.operation === card.operation) {
    const difference = answerFor(previous) - answerFor(before);
    if (answerFor(card) - answerFor(previous) === difference) cost += 100;
  }
  return cost;
}

function orderCycle(cards: FactCard[], preceding: FactCard[], random: () => number): FactCard[] {
  let best: FactCard[] = [];
  let bestCost = Infinity;
  // Bounded randomized retries avoid stranding an obvious neighbor at the end
  // of a table. Small selections may have unavoidable conflicts; always return.
  for (let attempt = 0; attempt < 64; attempt++) {
    const remaining = shuffle(cards, random);
    const history = preceding.slice(-2);
    const candidate: FactCard[] = [];
    let cost = 0;
    while (remaining.length) {
      let selected = 0;
      let lowest = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const nextCost = transitionCost(history, remaining[i]);
        if (nextCost < lowest) {
          lowest = nextCost;
          selected = i;
        }
      }
      const [card] = remaining.splice(selected, 1);
      candidate.push(card);
      history.push(card);
      cost += lowest;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
    if (bestCost === 0) break;
  }
  return best;
}

/** Fresh shuffled coverage cycles; preserves ordered facts and never edits input. */
export function buildRoundQueue(cards: FactCard[], count: number, random = Math.random): FactCard[] {
  if (!Number.isFinite(count) || count <= 0 || cards.length === 0) return [];
  const selected = [...new Map(cards.map(card => [card.id, card])).values()];
  const queue: FactCard[] = [];
  const total = Math.floor(count);
  while (queue.length < total) {
    const cycle = orderCycle(selected, queue, random);
    queue.push(...cycle.slice(0, total - queue.length));
  }
  return queue;
}
