import { makeCards, answerFor } from '../web/lib/cards';
import { createAutomaticProgress, startAutomaticSession, presentQuestion, applyAttemptResult, endAutomaticSession } from '../web/lib/automaticity';

const marker = 'design-review-baseline-v1';
export const fixtureUsers = [
  { id: 'review-alex', name: 'Alex (sample)', createdAt: '2026-09-15T12:00:00.000Z' },
  { id: 'review-riley', name: 'Riley (sample)', createdAt: '2026-09-15T12:00:00.000Z' },
];
export function seedFixture(force = false) {
  if (!force && localStorage.getItem(marker)) return;
  const deck = [...makeCards('add'), ...makeCards('sub'), ...makeCards('mul')];
  for (const user of fixtureUsers) {
    let now = Date.now() - 12 * 86400000;
    let progress = createAutomaticProgress(user.id, deck, {}, 'America/Los_Angeles', () => now);
    const sessions = [];
    for (let round = 0; round < 4; round++) {
      now += 2 * 86400000;
      const operation = round === 0 ? 'add' : 'mul';
      const cards = makeCards(operation);
      progress = startAutomaticSession(progress, { id: crypto.randomUUID(), operation, cards, targetCount: 10 }, () => now);
      for (let index = 0; index < 10; index++) {
        const card = cards[(round * 9 + index) % cards.length];
        progress = presentQuestion(progress, { kind: 'question', fact: card, attemptKind: 'assessment' }, () => now);
        const responseMs = index % 5 === 0 ? 2300 : 620 + index * 74;
        now += 6000;
        progress = applyAttemptResult(progress, { presentationId: progress.session!.current!.id, correct: index % 7 !== 0, responseMs, heard: String(answerFor(card) + (index % 7 === 0 ? 1 : 0)) }, () => now);
      }
      progress = endAutomaticSession(progress, () => now);
      const session = progress.session!;
      sessions.unshift({ id: session.id, operation, startedAt: new Date(session.startedAt).toISOString(), endedAt: new Date(now).toISOString(), attempts: progress.events.filter(event => event.sessionId === session.id).map(event => {
        const card = deck.find(item => item.id === event.factId)!;
        return { id: event.id, fact: `${card.a} ${operation === 'add' ? '+' : '×'} ${card.b}`, operation, correct: event.correct, answerCorrect: event.correct, responseMs: event.responseMs, heard: event.heard, at: new Date(event.completedAt).toISOString(), audit: event };
      }) });
    }
    // Explicit fictional records let the actual report render all its status categories.
    for (const fact of Object.values(progress.facts).filter(fact => fact.id.startsWith('mul-') && fact.latest?.correct).slice(0, 5)) {
      fact.stage = 'MAINTENANCE'; fact.everVerifiedAutomatic = true; fact.coldStreak = 4;
    }
    progress.updatedAt = now;
    localStorage.setItem(`math-facts-web-local-progress:${user.id}`, JSON.stringify({ states: {}, sessions, automaticity: progress }));
  }
  localStorage.setItem('math-facts-web-local-users', JSON.stringify(fixtureUsers));
  localStorage.setItem('math-facts-web-active-user', fixtureUsers[0].id);
  localStorage.setItem(marker, 'seeded');
}
