import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../../../lib/admin-server";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [
    { data: profiles, error: profileError },
    { data: students, error: studentError },
    { data: sessions, error: sessionError },
    { data: attempts, error: attemptError },
  ] = await Promise.all([
    auth.service.from("profiles").select("id,email,display_name,role,access_status,is_admin,created_at").order("created_at"),
    auth.service.from("students").select("id,owner_id,display_name,created_at,automaticity").order("display_name"),
    auth.service.from("practice_sessions").select("id,student_id,operation,started_at,ended_at").order("ended_at", { ascending: false }),
    auth.service.from("attempts").select("id,session_id,fact,operation,answer_correct,is_correct,response_ms,heard,created_at,automaticity_audit").order("created_at"),
  ]);
  if (profileError || studentError || sessionError || attemptError) {
    return NextResponse.json({ error: profileError?.message ?? studentError?.message ?? sessionError?.message ?? attemptError?.message }, { status: 500 });
  }

  const attemptsBySession = new Map<string, NonNullable<typeof attempts>>();
  for (const attempt of attempts ?? []) {
    const current = attemptsBySession.get(attempt.session_id) ?? [];
    current.push(attempt);
    attemptsBySession.set(attempt.session_id, current);
  }

  const sessionsByStudent = new Map<string, Array<Record<string, unknown>>>();
  for (const session of sessions ?? []) {
    const sessionAttempts = attemptsBySession.get(session.id) ?? [];
    const correct = sessionAttempts.filter((attempt) => attempt.answer_correct).length;
    const averageMs = sessionAttempts.length
      ? Math.round(sessionAttempts.reduce((sum, attempt) => sum + attempt.response_ms, 0) / sessionAttempts.length)
      : 0;
    const current = sessionsByStudent.get(session.student_id) ?? [];
    current.push({
      id: session.id,
      operation: session.operation,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      questions: sessionAttempts.length,
      correct,
      averageMs,
      attempts: sessionAttempts.map(attempt => ({
        id: attempt.id, fact: attempt.fact, operation: attempt.operation,
        answerCorrect: attempt.answer_correct ?? attempt.is_correct,
        correct: attempt.answer_correct ?? attempt.is_correct,
        responseMs: attempt.response_ms, heard: attempt.heard ?? "", at: attempt.created_at,
        audit: attempt.automaticity_audit ?? undefined,
      })),
    });
    sessionsByStudent.set(session.student_id, current);
  }

  const studentsByOwner = new Map<string, Array<Record<string, unknown>>>();
  for (const student of students ?? []) {
    const current = studentsByOwner.get(student.owner_id) ?? [];
    current.push({
      id: student.id,
      name: student.display_name,
      createdAt: student.created_at,
      reportProgress: student.automaticity?.facts ? { facts: student.automaticity.facts } : null,
      sessions: sessionsByStudent.get(student.id) ?? [],
    });
    studentsByOwner.set(student.owner_id, current);
  }

  return NextResponse.json({
    users: (profiles ?? []).map((profile) => ({
      id: profile.id,
      email: profile.email,
      displayName: profile.display_name,
      role: profile.role === "admin" || profile.is_admin ? "admin" : "user",
      status: profile.access_status,
      createdAt: profile.created_at,
      students: studentsByOwner.get(profile.id) ?? [],
    })),
  });
}
