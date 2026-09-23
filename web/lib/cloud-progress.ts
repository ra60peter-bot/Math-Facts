import type { SupabaseClient } from "@supabase/supabase-js";
import type { CardState, Operation } from "./learning";

export type CloudAttempt = { id: string; fact: string; operation: Operation; correct: boolean; answerCorrect: boolean; responseMs: number; heard: string; at: string };
export type CloudSession = { id: string; operation: Operation; startedAt: string; endedAt: string; attempts: CloudAttempt[] };
export type CloudProgress = { states: Record<string, CardState>; sessions: CloudSession[] };

const writes = new Map<string, Promise<unknown>>();
export function queueProgressWrite<T>(studentId: string, action: () => Promise<T>): Promise<T> {
  const next = (writes.get(studentId) ?? Promise.resolve()).catch(() => undefined).then(action);
  writes.set(studentId, next);
  return next;
}

function uploadedSessions(studentId: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(`math-facts-uploaded:${studentId}`) ?? "[]")); }
  catch { return new Set(); }
}

export function rememberUploadedSessions(studentId: string, ids: string[]) {
  const uploaded = uploadedSessions(studentId);
  ids.forEach((id) => uploaded.add(id));
  localStorage.setItem(`math-facts-uploaded:${studentId}`, JSON.stringify([...uploaded]));
}

export async function loadVoiceMappings(client: SupabaseClient, studentId: string) {
  const { data, error } = await client.from("voice_mappings").select("heard_text,answer").eq("student_id", studentId);
  if (error) return {};
  return Object.fromEntries((data ?? []).map((row) => [row.heard_text, row.answer])) as Record<string, number>;
}

export async function saveVoiceMapping(client: SupabaseClient, studentId: string, accountId: string, heardText: string, answer: number) {
  const { error } = await client.from("voice_mappings").upsert(
    { student_id: studentId, user_id: accountId, heard_text: heardText, answer, updated_at: new Date().toISOString() },
    { onConflict: "student_id,heard_text" },
  );
  if (error) throw error;
}

export async function loadCloudProgress(client: SupabaseClient, studentId: string): Promise<CloudProgress | null> {
  const [{ data: stateRows, error: stateError }, { data: sessionRows, error: sessionError }, { data: attemptRows, error: attemptError }] = await Promise.all([
    client.from("card_states").select("*").eq("student_id", studentId),
    client.from("practice_sessions").select("*").eq("student_id", studentId).order("ended_at", { ascending: false }),
    client.from("attempts").select("*").eq("student_id", studentId),
  ]);
  if (stateError || sessionError || attemptError) return null;
  rememberUploadedSessions(studentId, (sessionRows ?? []).map((row) => row.id));
  const states: Record<string, CardState> = {};
  for (const row of stateRows ?? []) {
    states[row.card_key] = {
      cardId: row.card_key, state: row.state, totalAttempts: row.total_attempts, totalCorrect: row.total_correct,
      consecutiveCorrect: row.consecutive_correct, consecutiveFast: row.consecutive_fast, consecutiveFailures: row.consecutive_failures,
      rollingAvgMs: Number(row.rolling_avg_ms), lastResponseMs: row.last_response_ms, difficulty: Number(row.difficulty),
      intervalDays: Number(row.interval_days), dueAt: row.due_at, lastSeenAt: row.last_seen_at,
      fsrs: row.fsrs_due ? {
        due: row.fsrs_due,
        stability: Number(row.fsrs_stability),
        difficulty: Number(row.fsrs_difficulty),
        elapsedDays: row.fsrs_elapsed_days,
        scheduledDays: row.fsrs_scheduled_days,
        learningSteps: row.fsrs_learning_steps,
        reps: row.fsrs_reps,
        lapses: row.fsrs_lapses,
        state: row.fsrs_state,
        lastReview: row.fsrs_last_review,
      } : null,
    };
  }
  const attemptsBySession = new Map<string, CloudAttempt[]>();
  for (const row of attemptRows ?? []) {
    const attempts = attemptsBySession.get(row.session_id) ?? [];
    const answerCorrect = row.answer_correct ?? row.is_correct;
    attempts.push({ id: row.id, fact: row.fact, operation: row.operation, correct: answerCorrect, answerCorrect, responseMs: row.response_ms, heard: row.heard ?? "", at: row.created_at });
    attemptsBySession.set(row.session_id, attempts);
  }
  return { states, sessions: (sessionRows ?? []).map((row) => ({ id: row.id, operation: row.operation, startedAt: row.started_at, endedAt: row.ended_at, attempts: attemptsBySession.get(row.id) ?? [] })) };
}

export function syncCloudProgress(client: SupabaseClient, studentId: string, accountId: string, progress: CloudProgress) {
  return queueProgressWrite(studentId, () => uploadProgress(client, studentId, accountId, progress));
}

async function uploadProgress(client: SupabaseClient, studentId: string, accountId: string, progress: CloudProgress) {
  // Completed sessions are immutable. Do not recreate deleted history from old caches.
  const uploaded = uploadedSessions(studentId);
  const pendingSessions = progress.sessions.filter((session) => !uploaded.has(session.id));
  const stateRows = Object.values(progress.states).map((state) => ({
    student_id: studentId, user_id: accountId, card_key: state.cardId, state: state.state, total_attempts: state.totalAttempts, total_correct: state.totalCorrect,
    consecutive_correct: state.consecutiveCorrect, consecutive_fast: state.consecutiveFast, consecutive_failures: state.consecutiveFailures,
    rolling_avg_ms: state.rollingAvgMs, last_response_ms: state.lastResponseMs, difficulty: state.difficulty,
    interval_days: state.intervalDays, due_at: state.dueAt, last_seen_at: state.lastSeenAt,
    fsrs_due: state.fsrs?.due ?? null, fsrs_stability: state.fsrs?.stability ?? null, fsrs_difficulty: state.fsrs?.difficulty ?? null,
    fsrs_elapsed_days: state.fsrs?.elapsedDays ?? null, fsrs_scheduled_days: state.fsrs?.scheduledDays ?? null,
    fsrs_learning_steps: state.fsrs?.learningSteps ?? null, fsrs_reps: state.fsrs?.reps ?? null,
    fsrs_lapses: state.fsrs?.lapses ?? null, fsrs_state: state.fsrs?.state ?? null, fsrs_last_review: state.fsrs?.lastReview ?? null,
  }));
  const sessions = pendingSessions.map((session) => ({ id: session.id, student_id: studentId, user_id: accountId, operation: session.operation, started_at: session.startedAt, ended_at: session.endedAt }));
  const attempts = pendingSessions.flatMap((session) => session.attempts.map((attempt) => ({
    id: attempt.id, session_id: session.id, student_id: studentId, user_id: accountId, fact: attempt.fact, operation: attempt.operation,
    is_correct: attempt.answerCorrect, answer_correct: attempt.answerCorrect, response_ms: attempt.responseMs, heard: attempt.heard || null, created_at: attempt.at,
  })));
  if (stateRows.length) { const { error } = await client.from("card_states").upsert(stateRows, { onConflict: "student_id,card_key" }); if (error) throw error; }
  if (sessions.length) { const { error } = await client.from("practice_sessions").upsert(sessions, { onConflict: "id" }); if (error) throw error; }
  if (attempts.length) { const { error } = await client.from("attempts").upsert(attempts, { onConflict: "id" }); if (error) throw error; }
  rememberUploadedSessions(studentId, pendingSessions.map((session) => session.id));
}
