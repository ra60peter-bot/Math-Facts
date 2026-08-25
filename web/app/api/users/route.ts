import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../../../lib/admin-server";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [{ data: profiles, error: profileError }, { data: sessions, error: sessionError }, { data: attempts, error: attemptError }] = await Promise.all([
    auth.service.from("profiles").select("id,email,display_name,is_admin,created_at").order("created_at"),
    auth.service.from("practice_sessions").select("id,user_id,operation,started_at,ended_at").order("ended_at", { ascending: false }),
    auth.service.from("attempts").select("session_id,is_correct,response_ms"),
  ]);
  if (profileError || sessionError || attemptError) {
    return NextResponse.json({ error: profileError?.message ?? sessionError?.message ?? attemptError?.message }, { status: 500 });
  }

  const attemptsBySession = new Map<string, Array<{ is_correct: boolean; response_ms: number }>>();
  for (const attempt of attempts ?? []) {
    const current = attemptsBySession.get(attempt.session_id) ?? [];
    current.push(attempt);
    attemptsBySession.set(attempt.session_id, current);
  }
  const sessionsByUser = new Map<string, Array<Record<string, unknown>>>();
  for (const session of sessions ?? []) {
    const sessionAttempts = attemptsBySession.get(session.id) ?? [];
    const correct = sessionAttempts.filter((attempt) => attempt.is_correct).length;
    const averageMs = sessionAttempts.length
      ? Math.round(sessionAttempts.reduce((sum, attempt) => sum + attempt.response_ms, 0) / sessionAttempts.length)
      : 0;
    const current = sessionsByUser.get(session.user_id) ?? [];
    current.push({
      id: session.id,
      operation: session.operation,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      questions: sessionAttempts.length,
      correct,
      averageMs,
    });
    sessionsByUser.set(session.user_id, current);
  }

  return NextResponse.json({
    users: (profiles ?? []).map((profile) => ({
      id: profile.id,
      email: profile.email,
      displayName: profile.display_name,
      isAdmin: profile.is_admin,
      createdAt: profile.created_at,
      sessions: sessionsByUser.get(profile.id) ?? [],
    })),
  });
}
