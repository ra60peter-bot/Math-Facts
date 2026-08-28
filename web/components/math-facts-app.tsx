"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { FactCard, answerFor, buildQueue, insertRetry, makeCards } from "../lib/cards";
import { loadCloudProgress, loadVoiceMappings, saveVoiceMapping, syncCloudProgress } from "../lib/cloud-progress";
import { reviewCardState } from "../lib/fsrs-scheduler";
import { CardState, Grade, Operation, TIMEOUT_MS, defaultState, gradeResponse, masteryScore } from "../lib/learning";
import { normalizeSpokenPhrase, parseSpokenNumber } from "../lib/number-parser";
import { hasSupabaseConfig, supabaseBrowser } from "../lib/supabase-browser";

type View = "practice" | "history" | "students" | "users";
type Phase = "setup" | "practice" | "results";
type Attempt = { id: string; fact: string; operation: Operation; correct: boolean; answerCorrect: boolean; responseMs: number; heard: string; at: string };
type SavedSession = { id: string; operation: Operation; startedAt: string; endedAt: string; attempts: Attempt[] };
type Persisted = { states: Record<string, CardState>; sessions: SavedSession[] };
type PendingWrong = { card: FactCard; transcript: string };
type AccountRole = "admin" | "user";
type AccountProfile = { id: string; email: string; displayName: string | null; role: AccountRole; status: "active" | "blocked" };
type StudentProfile = { id: string; ownerId: string; name: string; createdAt: string; ownerEmail?: string };
type AdminSessionSummary = { id: string; operation: Operation; startedAt: string; endedAt: string; questions: number; correct: number; averageMs: number };
type ManagedStudent = { id: string; name: string; createdAt: string; sessions: AdminSessionSummary[] };
type ManagedUser = { id: string; email: string; displayName: string | null; role: AccountRole; status: "active" | "blocked"; createdAt: string; students: ManagedStudent[] };
type LocalUser = { id: string; name: string; createdAt: string };
type BrowserSpeechResult = { isFinal: boolean; 0: { transcript: string } };
type BrowserSpeechResultList = { length: number; [index: number]: BrowserSpeechResult };
type BrowserSpeechRecognitionEvent = { results: BrowserSpeechResultList };
type BrowserSpeechRecognitionErrorEvent = { error: string };
type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

const STORAGE_KEY = "math-facts-web-local-progress";
const VOICE_MAPPINGS_KEY = "math-facts-web-voice-mappings";
const LOCAL_USERS_KEY = "math-facts-web-local-users";
const LOCAL_ACTIVE_USER_KEY = "math-facts-web-active-user";
const ACTIVE_STUDENT_KEY = "math-facts-web-active-student";
const DEFAULT_LOCAL_USER: LocalUser = { id: "local-default", name: "Local learner", createdAt: "" };
const QUESTION_COUNT_OPTIONS = [10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100];

function operationLabel(operation: Operation) {
  if (operation === "add") return "Addition";
  if (operation === "sub") return "Subtraction";
  return "Multiplication";
}

function operationSymbol(operation: Operation) {
  if (operation === "add") return "+";
  if (operation === "sub") return "−";
  return "×";
}

function operationWord(operation: Operation) {
  if (operation === "add") return "plus";
  if (operation === "sub") return "minus";
  return "times";
}

function progressStorageKey(ownerId: string) {
  return `${STORAGE_KEY}:${ownerId}`;
}

function readProgress(ownerId: string): Persisted {
  try {
    const stored = localStorage.getItem(progressStorageKey(ownerId))
      ?? (ownerId === DEFAULT_LOCAL_USER.id ? localStorage.getItem(STORAGE_KEY) : null);
    const saved = JSON.parse(stored ?? "") as Persisted;
    return {
      states: saved.states ?? {},
      sessions: (saved.sessions ?? []).map((session) => ({
        ...session,
        attempts: session.attempts.map((attempt) => {
          const answerCorrect = attempt.answerCorrect ?? attempt.correct;
          return { ...attempt, correct: answerCorrect, answerCorrect };
        }),
      })),
    };
  }
  catch { return { states: {}, sessions: [] }; }
}

function voiceMappingsStorageKey(ownerId: string) {
  return `${VOICE_MAPPINGS_KEY}:${ownerId}`;
}

function readVoiceMappings(ownerId: string) {
  try {
    const stored = localStorage.getItem(voiceMappingsStorageKey(ownerId))
      ?? (ownerId === DEFAULT_LOCAL_USER.id ? localStorage.getItem(`${VOICE_MAPPINGS_KEY}:local`) : null);
    return JSON.parse(stored ?? "{}") as Record<string, number>;
  }
  catch { return {}; }
}

function readLocalUsers() {
  try {
    const users = JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) ?? "[]") as LocalUser[];
    return users.length ? users : [DEFAULT_LOCAL_USER];
  } catch {
    return [DEFAULT_LOCAL_USER];
  }
}

export function MathFactsApp() {
  return <AuthGate />;
}

function AuthGate() {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const configured = hasSupabaseConfig();

  useEffect(() => {
    const client = supabaseBrowser();
    if (!client) return;
    client.auth.getUser().then(({ data }) => { setUser(data.user); setAuthReady(true); });
    const { data: subscription } = client.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAccount(null);
      setAuthReady(true);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const client = supabaseBrowser();
    if (!client || !user) { setAccount(null); return; }
    client.from("profiles").select("id,email,display_name,role,access_status,is_admin").eq("id", user.id).single().then(({ data, error }) => {
      if (error || !data) { setMessage("Your account profile could not be loaded. Confirm that migration 007 has been applied."); return; }
      setAccount({
        id: data.id,
        email: data.email,
        displayName: data.display_name,
        role: data.role === "admin" || data.is_admin ? "admin" : "user",
        status: data.access_status === "active" ? "active" : "blocked",
      });
    });
  }, [user]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    const client = supabaseBrowser();
    if (!client) return;
    const { error } = await client.auth.signInWithPassword({ email, password });
    setMessage(error ? error.message : "");
  }

  async function signInWithGoogle() {
    const client = supabaseBrowser();
    if (!client) return;
    const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
    if (error) setMessage(error.message);
  }

  async function signOut() {
    await supabaseBrowser()?.auth.signOut();
    setUser(null);
    setAccount(null);
  }

  if (!configured) return <LocalMode />;
  if (!authReady) return <main className="main"><div className="setup"><p className="muted">Loading account…</p></div></main>;
  if (user && !account) return <main className="main"><div className="setup"><p className="muted">Loading account profile…</p>{message && <p className="notice">{message}</p>}</div></main>;
  if (user && account?.status !== "active") return <main className="main"><div className="setup"><h1>Invitation required</h1><p className="notice">This email has not been invited to Math Facts. Ask the administrator to invite {user.email}.</p><button className="button secondary" onClick={() => void signOut()}>Sign out</button></div></main>;
  if (user && account) return <PracticeApp cloudUser={user} account={account} />;
  return <main className="main"><div className="setup"><h1>Sign in</h1><p className="muted">Math Facts is invite-only. Use the email address from your invitation and the password you selected.</p><form className="form-row" onSubmit={signIn}><label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="button primary">Sign in</button></form><div className="auth-divider"><span>or</span></div><button className="button google" onClick={() => void signInWithGoogle()}>Continue with Google</button>{message && <p className="notice">{message}</p>}</div></main>;
}

function LocalMode() {
  const [users, setUsers] = useState<LocalUser[]>([DEFAULT_LOCAL_USER]);
  const [activeUserId, setActiveUserId] = useState(DEFAULT_LOCAL_USER.id);

  useEffect(() => {
    const savedUsers = readLocalUsers();
    const savedActiveUserId = localStorage.getItem(LOCAL_ACTIVE_USER_KEY);
    setUsers(savedUsers);
    setActiveUserId(savedUsers.some((user) => user.id === savedActiveUserId) ? savedActiveUserId! : savedUsers[0].id);
  }, []);

  const persistUsers = (nextUsers: LocalUser[]) => {
    setUsers(nextUsers);
    localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(nextUsers));
  };

  const addUser = (name: string) => {
    const newUser = { id: crypto.randomUUID(), name: name.trim(), createdAt: new Date().toISOString() };
    persistUsers([...users, newUser]);
  };

  const deleteUser = (userId: string) => {
    if (users.length <= 1) return;
    const nextUsers = users.filter((user) => user.id !== userId);
    persistUsers(nextUsers);
    localStorage.removeItem(progressStorageKey(userId));
    localStorage.removeItem(voiceMappingsStorageKey(userId));
    if (activeUserId === userId) {
      setActiveUserId(nextUsers[0].id);
      localStorage.setItem(LOCAL_ACTIVE_USER_KEY, nextUsers[0].id);
    }
  };

  const selectUser = (userId: string) => {
    setActiveUserId(userId);
    localStorage.setItem(LOCAL_ACTIVE_USER_KEY, userId);
  };

  const activeUser = users.find((user) => user.id === activeUserId) ?? users[0];
  return <PracticeApp
    key={activeUser.id}
    cloudUser={null}
    isAdmin
    localUsers={users}
    localUserId={activeUser.id}
    localUserName={activeUser.name}
    onAddLocalUser={addUser}
    onDeleteLocalUser={deleteUser}
    onSelectLocalUser={selectUser}
  />;
}

type PracticeAppProps = {
  cloudUser: User | null;
  account?: AccountProfile | null;
  isAdmin?: boolean;
  localUsers?: LocalUser[];
  localUserId?: string;
  localUserName?: string;
  onAddLocalUser?: (name: string) => void;
  onDeleteLocalUser?: (userId: string) => void;
  onSelectLocalUser?: (userId: string) => void;
};

function PracticeApp({ cloudUser, account = null, isAdmin: localAdmin = false, localUsers = [], localUserId, localUserName, onAddLocalUser, onDeleteLocalUser, onSelectLocalUser }: PracticeAppProps) {
  const isAdmin = account?.role === "admin" || localAdmin;
  const [cloudStudents, setCloudStudents] = useState<StudentProfile[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(Boolean(cloudUser));
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const activeStudent = cloudStudents.find((student) => student.id === selectedStudentId) ?? null;
  const progressOwnerId = cloudUser ? selectedStudentId : (localUserId ?? DEFAULT_LOCAL_USER.id);
  const progressAccountId = cloudUser ? (activeStudent?.ownerId ?? cloudUser.id) : "";
  const [view, setView] = useState<View>("practice");
  const [phase, setPhase] = useState<Phase>("setup");
  const [operation, setOperation] = useState<Operation>("add");
  const [questionCount, setQuestionCount] = useState(50);
  const [selectedFacts, setSelectedFacts] = useState<Record<Operation, Set<string>>>(() => ({
    add: new Set(makeCards("add").map((card) => card.id)),
    sub: new Set(makeCards("sub").map((card) => card.id)),
    mul: new Set(makeCards("mul").map((card) => card.id)),
  }));
  const [states, setStates] = useState<Record<string, CardState>>({});
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [current, setCurrent] = useState<FactCard | null>(null);
  const [progress, setProgress] = useState(0);
  const [heard, setHeard] = useState("");
  const [listenState, setListenState] = useState("");
  const [result, setResult] = useState<{ text: string; tone: "good" | "slow" | "wrong"; correctAnswer?: number } | null>(null);
  const [pendingWrong, setPendingWrong] = useState<PendingWrong | null>(null);
  const [speechSupported, setSpeechSupported] = useState(true);

  const loadStudents = useCallback(async () => {
    if (!cloudUser) return;
    setStudentsLoading(true);
    try {
      const payload = await accountRequest("/api/students");
      const loaded = payload.students as StudentProfile[];
      setCloudStudents(loaded);
      setSelectedStudentId((current) => {
        const stored = localStorage.getItem(`${ACTIVE_STUDENT_KEY}:${cloudUser.id}`);
        const next = loaded.some((student) => student.id === current)
          ? current
          : loaded.some((student) => student.id === stored) ? stored! : (loaded[0]?.id ?? "");
        if (next) localStorage.setItem(`${ACTIVE_STUDENT_KEY}:${cloudUser.id}`, next);
        return next;
      });
    } finally {
      setStudentsLoading(false);
    }
  }, [cloudUser]);

  useEffect(() => { void loadStudents(); }, [loadStudents]);

  const selectStudent = (studentId: string) => {
    setSelectedStudentId(studentId);
    if (cloudUser) localStorage.setItem(`${ACTIVE_STUDENT_KEY}:${cloudUser.id}`, studentId);
    setPhase("setup");
  };

  const statesRef = useRef<Record<string, CardState>>({});
  const voiceMappingsRef = useRef<Record<string, number>>({});
  const queueRef = useRef<FactCard[]>([]);
  const indexRef = useRef(0);
  const sessionStartedAtRef = useRef("");
  const attemptsRef = useRef<Attempt[]>([]);
  const questionStartRef = useRef(0);
  const soundResponseMsRef = useRef<number | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const startListeningRef = useRef<(card: FactCard) => void>(() => undefined);
  const answerHandledRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const nextRef = useRef<number | null>(null);
  const retryCountRef = useRef<Record<string, number>>({});

  const stopListening = useCallback(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!progressOwnerId) return;
    const saved = readProgress(progressOwnerId);
    const savedMappings = readVoiceMappings(progressOwnerId);
    statesRef.current = saved.states;
    voiceMappingsRef.current = savedMappings;
    setStates(saved.states);
    setSessions(saved.sessions);
    const client = supabaseBrowser();
    if (client && cloudUser) {
      loadCloudProgress(client, progressOwnerId).then((cloud) => {
        if (!cloud || (!Object.keys(cloud.states).length && !cloud.sessions.length)) return;
        statesRef.current = cloud.states;
        setStates(cloud.states);
        setSessions(cloud.sessions);
        localStorage.setItem(progressStorageKey(progressOwnerId), JSON.stringify(cloud));
      }).catch(() => undefined);
      loadVoiceMappings(client, progressOwnerId).then((cloudMappings) => {
        const merged = { ...cloudMappings, ...savedMappings };
        voiceMappingsRef.current = merged;
        localStorage.setItem(voiceMappingsStorageKey(progressOwnerId), JSON.stringify(merged));
      }).catch(() => undefined);
    }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSpeechSupported(Boolean(Recognition));
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    return () => stopListening();
  }, [cloudUser, progressOwnerId, stopListening]);

  const saveProgress = useCallback((nextStates: Record<string, CardState>, nextSessions: SavedSession[]) => {
    if (!progressOwnerId) return;
    statesRef.current = nextStates;
    setStates(nextStates);
    setSessions(nextSessions);
    localStorage.setItem(progressStorageKey(progressOwnerId), JSON.stringify({ states: nextStates, sessions: nextSessions }));
    const client = supabaseBrowser();
    if (client && cloudUser && navigator.onLine) {
      void syncCloudProgress(client, progressOwnerId, progressAccountId, { states: nextStates, sessions: nextSessions }).catch(() => undefined);
    }
  }, [cloudUser, progressAccountId, progressOwnerId]);

  useEffect(() => {
    const client = supabaseBrowser();
    if (!client || !cloudUser || !progressOwnerId) return;
    const syncWhenOnline = () => {
      const saved = readProgress(progressOwnerId);
      void syncCloudProgress(client, progressOwnerId, progressAccountId, saved).catch(() => undefined);
      const mappings = readVoiceMappings(progressOwnerId);
      void Promise.all(Object.entries(mappings).map(([phrase, answer]) => saveVoiceMapping(client, progressOwnerId, progressAccountId, phrase, answer))).catch(() => undefined);
    };
    window.addEventListener("online", syncWhenOnline);
    return () => window.removeEventListener("online", syncWhenOnline);
  }, [cloudUser, progressAccountId, progressOwnerId]);

  const advance = useCallback(() => {
    if (indexRef.current >= queueRef.current.length) {
      stopListening();
      const completed: SavedSession = {
        id: crypto.randomUUID(),
        operation,
        startedAt: sessionStartedAtRef.current,
        endedAt: new Date().toISOString(),
        attempts: attemptsRef.current,
      };
      saveProgress(statesRef.current, [completed, ...sessions]);
      setPhase("results");
      setCurrent(null);
      return;
    }
    const next = queueRef.current[indexRef.current];
    indexRef.current += 1;
    answerHandledRef.current = false;
    soundResponseMsRef.current = null;
    questionStartRef.current = performance.now();
    setCurrent(next);
    setHeard("");
    setResult(null);
    setPendingWrong(null);
    window.setTimeout(() => startListeningRef.current(next), 100);
  }, [operation, saveProgress, sessions, stopListening]);

  const scheduleRetry = useCallback((card: FactCard, grade: Grade) => {
    if ((grade !== "again" && grade !== "hard") || (retryCountRef.current[card.id] ?? 0) >= 6) return;
    const retries = (retryCountRef.current[card.id] ?? 0) + 1;
    retryCountRef.current[card.id] = retries;
    const gap = Math.min((grade === "again" ? 3 : 6) + retries - 1, 12);
    insertRetry(queueRef.current, indexRef.current, card, gap);
  }, []);

  const handleResponse = useCallback((card: FactCard, transcript: string, parsed: number | null, responseMs: number) => {
    if (answerHandledRef.current) return;
    answerHandledRef.current = true;
    stopListening();
    const answerCorrect = parsed === answerFor(card);
    const passed = answerCorrect && responseMs <= 1500;
    const grade: Grade = gradeResponse(answerCorrect, responseMs);
    const previousState = statesRef.current[card.id] ?? defaultState(card.id);
    const nextState = reviewCardState(previousState, grade, responseMs);
    const nextStates = { ...statesRef.current, [card.id]: nextState };
    statesRef.current = nextStates;
    setStates(nextStates);
    setHeard(transcript || "No answer heard");
    setListenState("");
    const elapsed = `${(responseMs / 1000).toFixed(1)} seconds`;
    setResult(passed
      ? { text: `Good - ${elapsed}`, tone: "good" }
      : answerCorrect
        ? { text: `Good effort - ${elapsed}`, tone: "slow" }
        : { text: `Wrong answer - ${elapsed}`, tone: "wrong", correctAnswer: answerFor(card) });
    const attemptId = crypto.randomUUID();
    attemptsRef.current = [...attemptsRef.current, { id: attemptId, fact: `${card.a} ${operationSymbol(card.operation)} ${card.b}`, operation: card.operation, correct: answerCorrect, answerCorrect, responseMs, heard: transcript, at: new Date().toISOString() }];
    setProgress(attemptsRef.current.length);

    if (answerCorrect) {
      scheduleRetry(card, grade);
      nextRef.current = window.setTimeout(advance, passed ? 950 : 1450);
    } else {
      setPendingWrong({ card, transcript });
    }
  }, [advance, scheduleRetry, stopListening]);

  const startListening = useCallback((card: FactCard) => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) { setSpeechSupported(false); setListenState("Speech recognition is unavailable in this browser."); return; }
    const recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.onstart = () => setListenState("Listening");
    recognition.onsoundstart = () => {
      if (soundResponseMsRef.current === null) {
        soundResponseMsRef.current = Math.min(Math.round(performance.now() - questionStartRef.current), TIMEOUT_MS);
      }
    };
    recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
      const transcripts: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) transcripts.push(event.results[index][0]?.transcript ?? "");
      const transcript = transcripts.join(" ").trim();
      setHeard(transcript);
      if (event.results[event.results.length - 1]?.isFinal) {
        const responseMs = soundResponseMsRef.current ?? Math.min(Math.round(performance.now() - questionStartRef.current), TIMEOUT_MS);
        handleResponse(card, transcript, parseSpokenNumber(transcript, voiceMappingsRef.current), responseMs);
      }
    };
    recognition.onerror = (event: BrowserSpeechRecognitionErrorEvent) => {
      if (event.error === "no-speech") return;
      setListenState(event.error === "not-allowed" ? "Microphone permission is required." : "Speech recognition could not start. Try the microphone button.");
    };
    recognition.onend = () => {
      if (!answerHandledRef.current && timeoutRef.current === null) {
        handleResponse(card, "", null, TIMEOUT_MS);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      timeoutRef.current = window.setTimeout(() => handleResponse(card, "", null, TIMEOUT_MS), TIMEOUT_MS);
    } catch {
      setListenState("Speech recognition is already starting. Try again in a moment.");
    }
  }, [handleResponse]);

  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);

  const startPractice = () => {
    if (!speechSupported) return;
    const cards = makeCards(operation).filter((card) => selectedFacts[operation].has(card.id));
    if (!cards.length) return;
    queueRef.current = buildQueue(cards, statesRef.current, questionCount);
    indexRef.current = 0;
    retryCountRef.current = {};
    attemptsRef.current = [];
    sessionStartedAtRef.current = new Date().toISOString();
    setPhase("practice");
    setView("practice");
    setPendingWrong(null);
    const first = queueRef.current[0];
    indexRef.current = 1;
    setProgress(0);
    soundResponseMsRef.current = null;
    questionStartRef.current = performance.now();
    setCurrent(first);
    startListening(first);
  };

  const restartRecognition = () => {
    if (current && !answerHandledRef.current) startListening(current);
  };

  const continueAfterWrong = () => {
    if (!pendingWrong) return;
    scheduleRetry(pendingWrong.card, "again");
    setPendingWrong(null);
    advance();
  };

  const allowPendingAnswer = () => {
    if (!pendingWrong) return;
    const phrase = normalizeSpokenPhrase(pendingWrong.transcript);
    if (!phrase) return;
    const acceptedAnswer = answerFor(pendingWrong.card);

    const nextMappings = { ...voiceMappingsRef.current, [phrase]: acceptedAnswer };
    voiceMappingsRef.current = nextMappings;
    localStorage.setItem(voiceMappingsStorageKey(progressOwnerId), JSON.stringify(nextMappings));
    const client = supabaseBrowser();
    if (client && cloudUser && navigator.onLine) {
      void saveVoiceMapping(client, progressOwnerId, progressAccountId, phrase, acceptedAnswer).catch(() => undefined);
    }

    setResult({ text: "Pronunciation saved for future answers", tone: "good" });
    scheduleRetry(pendingWrong.card, "again");
    setPendingWrong(null);
    nextRef.current = window.setTimeout(advance, 800);
  };

  const allCards = makeCards(operation);
  const selectedCount = selectedFacts[operation].size;
  const stateList = allCards.map((card) => states[card.id] ?? defaultState(card.id));
  const summary = masteryScore(stateList);
  const currentSession = phase === "results" ? sessions[0] : null;
  const accountName = account?.email ?? localUserName;

  if (view === "users" && isAdmin && cloudUser) {
    return <AppFrame view={view} onNavigate={setView} onExit={() => setPhase("setup")} isAdmin accountName={accountName}>
      <UserManagement currentUserId={cloudUser.id} />
    </AppFrame>;
  }

  if (view === "students") {
    return <AppFrame view={view} onNavigate={setView} onExit={() => setPhase("setup")} isAdmin={isAdmin} accountName={accountName}>
      {cloudUser
        ? <StudentManagement students={cloudStudents} activeStudentId={selectedStudentId} accountId={cloudUser.id} onSelectStudent={selectStudent} onChanged={loadStudents} />
        : <LocalUserManagement
            users={localUsers}
            activeUserId={progressOwnerId}
            onAddUser={onAddLocalUser ?? (() => undefined)}
            onDeleteUser={onDeleteLocalUser ?? (() => undefined)}
            onSelectUser={onSelectLocalUser ?? (() => undefined)}
          />}
    </AppFrame>;
  }

  if (view === "history") {
    return <AppFrame view={view} onNavigate={setView} onExit={() => setView("practice")} isAdmin={isAdmin} accountName={accountName}>
      <div className="topbar"><div><h1>History</h1><p className="muted">{cloudUser ? `Showing completed sessions for ${activeStudent?.name ?? "the selected student"}.` : `Showing completed sessions for ${localUserName ?? "this learner"} on this device.`}</p></div></div>
      {sessions.length === 0 ? <p className="empty">No sessions yet.</p> : <table className="history-table"><thead><tr><th>When</th><th>Operation</th><th>Questions</th><th>Accuracy</th><th>Average time</th></tr></thead><tbody>{sessions.map((session) => {
        const correct = session.attempts.filter((attempt) => attempt.answerCorrect).length;
        const avg = session.attempts.length ? Math.round(session.attempts.reduce((sum, attempt) => sum + attempt.responseMs, 0) / session.attempts.length) : 0;
        return <tr key={session.id}><td>{new Date(session.endedAt).toLocaleDateString()}</td><td>{operationLabel(session.operation)}</td><td>{session.attempts.length}</td><td>{session.attempts.length ? Math.round((correct / session.attempts.length) * 100) : 0}%</td><td>{avg ? `${(avg / 1000).toFixed(1)}s` : "-"}</td></tr>;
      })}</tbody></table>}
    </AppFrame>;
  }

  if (phase === "practice" && current) {
    return <main className="practice"><div className="progress">{progress} of {questionCount} completed</div><div className="fact">{current.a} {operationSymbol(current.operation)} {current.b}</div><div className="listen-state">{listenState}</div><div className="heard">{heard ? `Heard: ${heard}` : ""}</div><div className={`result ${result?.tone ?? ""}`}>{result?.text ?? ""}</div>{result?.tone === "wrong" && <><div className="answer-reveal">Correct answer: {result.correctAnswer}</div><div className="answer-actions">{pendingWrong?.transcript && <button className="button secondary" onClick={allowPendingAnswer}>Allow this answer</button>}<button className="button primary" onClick={continueAfterWrong}>Next question</button></div></>}<button className={`mic ${listenState === "Listening" ? "listening" : ""}`} aria-label="Start listening" title="Start listening" onClick={restartRecognition} disabled={Boolean(result)}>Mic</button></main>;
  }

  if (cloudUser && studentsLoading) {
    return <AppFrame view={view} onNavigate={setView} onExit={() => setPhase("setup")} isAdmin={isAdmin} accountName={accountName}><div className="setup"><p className="muted">Loading students…</p></div></AppFrame>;
  }

  if (cloudUser && !activeStudent) {
    return <AppFrame view={view} onNavigate={setView} onExit={() => setPhase("setup")} isAdmin={isAdmin} accountName={accountName}><div className="setup"><h1>Add a student</h1><p className="muted">Create at least one student profile before starting practice.</p><button className="button primary" onClick={() => setView("students")}>Manage students</button></div></AppFrame>;
  }

  return <AppFrame view={view} onNavigate={setView} onExit={() => setPhase("setup")} isAdmin={isAdmin} accountName={accountName}>
    {phase === "results" && currentSession ? (
      <div className="setup">
        <h1>Session complete</h1>
        <p className="muted">A short, clean record of this practice round.</p>
        <div className="stats">
          <Stat label="Accuracy" value={`${Math.round((currentSession.attempts.filter((attempt) => attempt.answerCorrect).length / Math.max(currentSession.attempts.length, 1)) * 100)}%`} />
          <Stat label="Questions" value={String(currentSession.attempts.length)} />
          <Stat label="Mastery" value={`${summary.score}/1000`} />
        </div>
        <div className="form-row">
          <button className="button primary" onClick={() => setPhase("setup")}>New session</button>
          <button className="button secondary" onClick={() => setView("history")}>View history</button>
        </div>
      </div>
    ) : (
      <div className="setup">
        <h1>Practice</h1>
        <p className="muted">Speak each answer aloud. The session scores accuracy, speed, and consistency.</p>
        {!speechSupported && <p className="notice">This app requires speech recognition. Use the latest Chrome or Edge on a laptop or desktop, then allow microphone access.</p>}
        <div className="form-row">
          {cloudUser && <label>Student<select value={selectedStudentId} onChange={(event) => selectStudent(event.target.value)}>{cloudStudents.map((student) => <option key={student.id} value={student.id}>{student.name}{isAdmin && student.ownerEmail ? ` — ${student.ownerEmail}` : ""}</option>)}</select></label>}
          <div className="operation-field"><span>Operation</span><div className="operation-toggle"><button aria-pressed={operation === "add"} onClick={() => setOperation("add")}>Addition</button><button aria-pressed={operation === "sub"} onClick={() => setOperation("sub")}>Subtraction</button><button aria-pressed={operation === "mul"} onClick={() => setOperation("mul")}>Multiplication</button></div></div>
          <label>Questions<select value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))}>{QUESTION_COUNT_OPTIONS.map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
          <button className="button primary" onClick={startPractice} disabled={!speechSupported || selectedCount === 0}>Start practice</button>
        </div>
        <FactGrid operation={operation} selected={selectedFacts[operation]} onChange={(next) => setSelectedFacts((current) => ({ ...current, [operation]: next }))} />
        <div className="stats">
          <Stat label="Facts selected" value={`${selectedCount}/${allCards.length}`} />
          <Stat label="Facts mastered" value={`${summary.mastered}/${allCards.length}`} />
          <Stat label="Facts attempted" value={`${summary.attempted}/${allCards.length}`} />
        </div>
      </div>
    )}
  </AppFrame>;
}

function AppFrame({ children, view, onNavigate, onExit, isAdmin = false, accountName }: { children: React.ReactNode; view: View; onNavigate: (view: View) => void; onExit: () => void; isAdmin?: boolean; accountName?: string }) {
  async function signOut() {
    const supabase = supabaseBrowser();
    if (!supabase) return;
    await supabase.auth.signOut();
    window.location.reload();
  }

  return <div className="app-shell"><aside className="sidebar"><div className="brand">Math <span>Facts</span></div><nav className="nav"><button aria-current={view === "practice" ? "page" : undefined} onClick={() => { onExit(); onNavigate("practice"); }}>Practice</button><button aria-current={view === "history" ? "page" : undefined} onClick={() => onNavigate("history")}>History</button><button aria-current={view === "students" ? "page" : undefined} onClick={() => onNavigate("students")}>Students</button>{isAdmin && <button aria-current={view === "users" ? "page" : undefined} onClick={() => onNavigate("users")}>Admin</button>}</nav><div className="account">{accountName && <><strong>{accountName}</strong><br /></>}Voice-first practice<br />Addition, subtraction, and multiplication{hasSupabaseConfig() && <><br /><button className="button secondary" onClick={() => void signOut()}>Sign out</button></>}</div></aside><main className="main">{children}</main></div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="stat"><strong>{value}</strong><span className="muted">{label}</span></div>; }

function FactGrid({ operation, selected, onChange }: { operation: Operation; selected: Set<string>; onChange: (selected: Set<string>) => void }) {
  const cards = makeCards(operation);
  const rows = [...new Set(cards.map((card) => card.a))];
  const columns = [...new Set(cards.map((card) => card.b))];
  const keyFor = (row: number, column: number) => `${operation}-${row}-${column}`;
  const validKeys = new Set(cards.map((card) => card.id));
  const toggleKeys = (keys: string[]) => {
    const next = new Set(selected);
    const allSelected = keys.every((key) => next.has(key));
    keys.forEach((key) => allSelected ? next.delete(key) : next.add(key));
    onChange(next);
  };
  const allKeys = cards.map((card) => card.id);
  const description = operation === "add"
    ? "Single-digit addition: 1 through 9"
    : operation === "sub"
      ? "Subtraction: positive answers using 1 through 10"
      : "Multiplication: 2 through 15";

  return <section className="fact-selector" aria-labelledby="fact-selector-title"><div className="fact-selector-heading"><div><h2 id="fact-selector-title">Choose facts</h2><p className="muted">{description}</p></div><div className="selection-actions"><button className="button secondary" onClick={() => onChange(new Set(allKeys))}>Select all</button><button className="button secondary" onClick={() => onChange(new Set())}>Clear all</button></div></div><div className="fact-grid-scroll"><div className="fact-grid" style={{ gridTemplateColumns: `74px repeat(${columns.length}, 42px)` }}><AxisToggle label="All" keys={allKeys} selected={selected} onToggle={toggleKeys} />{columns.map((column) => <AxisToggle key={`column-${column}`} label={String(column)} keys={rows.map((row) => keyFor(row, column)).filter((key) => validKeys.has(key))} selected={selected} onToggle={toggleKeys} />)}{rows.map((row) => <div className="fact-grid-row" key={`row-${row}`} style={{ gridColumn: `1 / span ${columns.length + 1}`, gridTemplateColumns: `74px repeat(${columns.length}, 42px)` }}><AxisToggle label={String(row)} keys={columns.map((column) => keyFor(row, column)).filter((key) => validKeys.has(key))} selected={selected} onToggle={toggleKeys} />{columns.map((column) => { const key = keyFor(row, column); return validKeys.has(key) ? <label className="fact-cell" key={key} title={`${row} ${operationWord(operation)} ${column}`}><input type="checkbox" checked={selected.has(key)} onChange={() => toggleKeys([key])} /><span className="sr-only">{row} {operationWord(operation)} {column}</span></label> : <span className="fact-cell unavailable" aria-hidden="true" key={key} />; })}</div>)}</div></div></section>;
}

function AxisToggle({ label, keys, selected, onToggle }: { label: string; keys: string[]; selected: Set<string>; onToggle: (keys: string[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedCount = keys.filter((key) => selected.has(key)).length;
  const allSelected = selectedCount === keys.length;
  useEffect(() => { if (inputRef.current) inputRef.current.indeterminate = selectedCount > 0 && !allSelected; }, [allSelected, selectedCount]);
  return <label className="axis-toggle" title={`${allSelected ? "Clear" : "Select"} ${label === "All" ? "all facts" : `all facts for ${label}`}`}><span>{label}</span><input ref={inputRef} type="checkbox" checked={allSelected} onChange={() => onToggle(keys)} /></label>;
}

function StudentManagement({ students, activeStudentId, accountId, onSelectStudent, onChanged }: { students: StudentProfile[]; activeStudentId: string; accountId: string; onSelectStudent: (studentId: string) => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState("");

  async function addStudent(event: FormEvent) {
    event.preventDefault();
    try {
      const payload = await accountRequest("/api/students", { method: "POST", body: JSON.stringify({ name, ownerId: accountId }) });
      setName("");
      setMessage(`${payload.student.name} was added.`);
      await onChanged();
      onSelectStudent(payload.student.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The student could not be added.");
    }
  }

  async function deleteStudent(student: StudentProfile) {
    try {
      await accountRequest(`/api/students/${student.id}`, { method: "DELETE" });
      setPendingDeleteId("");
      setMessage(`${student.name} and all associated progress were deleted.`);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The student could not be deleted.");
    }
  }

  return <div className="users-view"><div className="topbar"><div><h1>Students</h1><p className="muted">Account owners create and remove student profiles. Students select their name before practicing.</p></div></div><section className="user-toolbar"><h2>Add student</h2><form className="form-row" onSubmit={addStudent}><label>Name<input type="text" required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="button primary">Add student</button></form>{message && <p className="notice">{message}</p>}</section><section><h2>Student profiles</h2>{students.length === 0 ? <p className="empty">No students yet.</p> : <div className="table-scroll"><table className="history-table"><thead><tr><th>Student</th><th>Account</th><th>Added</th><th>Actions</th></tr></thead><tbody>{students.map((student) => <tr key={student.id}><td><strong>{student.name}</strong>{student.id === activeStudentId && <span className="role-label">Selected</span>}</td><td>{student.ownerEmail ?? "This account"}</td><td>{new Date(student.createdAt).toLocaleDateString()}</td><td><div className="table-actions">{student.id !== activeStudentId && <button className="button primary" onClick={() => onSelectStudent(student.id)}>Select</button>}{pendingDeleteId === student.id ? <><button className="button secondary" onClick={() => setPendingDeleteId("")}>Cancel</button><button className="button danger" onClick={() => void deleteStudent(student)}>Confirm delete</button></> : <button className="button danger" onClick={() => setPendingDeleteId(student.id)}>Delete</button>}</div></td></tr>)}</tbody></table></div>}</section></div>;
}

function LocalUserManagement({ users, activeUserId, onAddUser, onDeleteUser, onSelectUser }: { users: LocalUser[]; activeUserId: string; onAddUser: (name: string) => void; onDeleteUser: (userId: string) => void; onSelectUser: (userId: string) => void }) {
  const [selectedUserId, setSelectedUserId] = useState(activeUserId);
  const [pendingDeleteUserId, setPendingDeleteUserId] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const userRecords = users.map((user) => ({ user, progress: readProgress(user.id) }));
  const selectedRecord = userRecords.find((record) => record.user.id === selectedUserId) ?? userRecords[0] ?? null;

  function addUser(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (users.some((user) => user.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase())) {
      setMessage("A user with that name already exists.");
      return;
    }
    onAddUser(trimmedName);
    setName("");
    setMessage(`${trimmedName} was added.`);
  }

  function deleteUser(user: LocalUser) {
    if (users.length <= 1) {
      setMessage("At least one local user must remain.");
      return;
    }
    onDeleteUser(user.id);
    if (selectedUserId === user.id) setSelectedUserId(users.find((candidate) => candidate.id !== user.id)?.id ?? "");
    setPendingDeleteUserId("");
    setMessage(`${user.name} was deleted.`);
  }

  return <div className="users-view"><div className="topbar"><div><h1>Admin</h1><p className="muted">Add learners, switch the active learner, review performance, and remove local accounts.</p></div></div><section className="user-toolbar"><h2>Add user</h2><form className="form-row" onSubmit={addUser}><label>Name<input type="text" required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="button primary">Add user</button></form>{message && <p className="notice">{message}</p>}</section><section><h2>Users</h2><div className="table-scroll"><table className="history-table"><thead><tr><th>User</th><th>Added</th><th>Sessions</th><th>Last practice</th><th>Actions</th></tr></thead><tbody>{userRecords.map(({ user, progress }) => <tr key={user.id}><td><strong>{user.name}</strong>{user.id === activeUserId && <span className="role-label">Active</span>}</td><td>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "Local profile"}</td><td>{progress.sessions.length}</td><td>{progress.sessions[0] ? new Date(progress.sessions[0].endedAt).toLocaleDateString() : "Never"}</td><td><div className="table-actions">{user.id !== activeUserId && <button className="button primary" onClick={() => onSelectUser(user.id)}>Use user</button>}<button className="button secondary" onClick={() => setSelectedUserId(user.id)}>View history</button>{pendingDeleteUserId === user.id ? <><button className="button secondary" onClick={() => setPendingDeleteUserId("")}>Cancel</button><button className="button danger" onClick={() => deleteUser(user)}>Confirm delete</button></> : <button className="button danger" disabled={users.length <= 1} onClick={() => setPendingDeleteUserId(user.id)}>Delete</button>}</div></td></tr>)}</tbody></table></div></section>{selectedRecord && <section className="user-history"><h2>{selectedRecord.user.name} history</h2><SessionHistory sessions={selectedRecord.progress.sessions} detailedDates /></section>}</div>;
}

function SessionHistory({ sessions, detailedDates = false }: { sessions: SavedSession[]; detailedDates?: boolean }) {
  if (sessions.length === 0) return <p className="empty">No completed sessions.</p>;
  return <div className="table-scroll"><table className="history-table"><thead><tr><th>When</th><th>Operation</th><th>Questions</th><th>Accuracy</th><th>Average time</th></tr></thead><tbody>{sessions.map((session) => {
    const correct = session.attempts.filter((attempt) => attempt.answerCorrect).length;
    const averageMs = session.attempts.length ? Math.round(session.attempts.reduce((sum, attempt) => sum + attempt.responseMs, 0) / session.attempts.length) : 0;
    return <tr key={session.id}><td>{detailedDates ? new Date(session.endedAt).toLocaleString() : new Date(session.endedAt).toLocaleDateString()}</td><td>{operationLabel(session.operation)}</td><td>{session.attempts.length}</td><td>{session.attempts.length ? `${Math.round((correct / session.attempts.length) * 100)}%` : "-"}</td><td>{averageMs ? `${(averageMs / 1000).toFixed(1)}s` : "-"}</td></tr>;
  })}</tbody></table></div>;
}

async function accountRequest(path: string, init: RequestInit = {}) {
  const client = supabaseBrowser();
  if (!client) throw new Error("Supabase is not configured.");
  const { data } = await client.auth.getSession();
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}`, ...init.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? "The request could not be completed.");
  return payload;
}

function UserManagement({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [email, setEmail] = useState("");
  const [studentName, setStudentName] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await accountRequest("/api/users");
      const loaded = payload.users as ManagedUser[];
      setUsers(loaded);
      setSelectedUserId((current) => current && loaded.some((user) => user.id === current) ? current : (loaded.find((user) => user.role !== "admin")?.id ?? loaded[0]?.id ?? ""));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Users could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    try {
      await accountRequest("/api/invites", { method: "POST", body: JSON.stringify({ email }) });
      setMessage(`Invitation sent to ${email}.`);
      setEmail("");
      await loadUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The invitation could not be sent.");
    }
  }

  async function deleteUser(user: ManagedUser) {
    const confirmed = window.confirm(`Permanently delete ${user.email} and all of this user's practice history? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await accountRequest(`/api/users/${user.id}`, { method: "DELETE" });
      setMessage(`${user.email} was deleted.`);
      await loadUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The user could not be deleted.");
    }
  }

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const selectedStudent = selectedUser?.students.find((student) => student.id === selectedStudentId) ?? selectedUser?.students[0] ?? null;

  async function addStudent(event: FormEvent) {
    event.preventDefault();
    if (!selectedUser) return;
    try {
      await accountRequest("/api/students", { method: "POST", body: JSON.stringify({ name: studentName, ownerId: selectedUser.id }) });
      setMessage(`${studentName} was added to ${selectedUser.email}.`);
      setStudentName("");
      await loadUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The student could not be added.");
    }
  }

  async function deleteStudent(student: ManagedStudent) {
    if (!window.confirm(`Permanently delete ${student.name} and all associated practice history?`)) return;
    try {
      await accountRequest(`/api/students/${student.id}`, { method: "DELETE" });
      setMessage(`${student.name} was deleted.`);
      setSelectedStudentId("");
      await loadUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The student could not be deleted.");
    }
  }

  return <div className="users-view"><div className="topbar"><div><h1>Admin</h1><p className="muted">Invite account owners, manage every student, and review all performance.</p></div></div><section className="user-toolbar"><h2>Invite user</h2><form className="form-row" onSubmit={invite}><label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><button className="button primary">Send invitation</button></form>{message && <p className="notice">{message}</p>}</section><section><h2>Accounts</h2>{loading ? <p className="empty">Loading users...</p> : users.length === 0 ? <p className="empty">No users found.</p> : <div className="table-scroll"><table className="history-table"><thead><tr><th>User</th><th>Status</th><th>Students</th><th>Sessions</th><th>Actions</th></tr></thead><tbody>{users.map((user) => {
    const allSessions = user.students.flatMap((student) => student.sessions);
    return <tr key={user.id}><td><strong>{user.displayName || user.email}</strong>{user.role === "admin" && <span className="role-label">Admin</span>}<br /><span className="muted">{user.email}</span></td><td>{user.status}</td><td>{user.students.length}</td><td>{allSessions.length}</td><td><div className="table-actions"><button className="button secondary" onClick={() => { setSelectedUserId(user.id); setSelectedStudentId(""); }}>Manage</button>{user.role !== "admin" && user.id !== currentUserId && <button className="button danger" onClick={() => void deleteUser(user)}>Delete user</button>}</div></td></tr>;
  })}</tbody></table></div>}</section>{selectedUser && <section className="user-history"><h2>{selectedUser.displayName || selectedUser.email} students</h2><form className="form-row" onSubmit={addStudent}><label>Student name<input type="text" required maxLength={60} value={studentName} onChange={(event) => setStudentName(event.target.value)} /></label><button className="button primary">Add student</button></form>{selectedUser.students.length === 0 ? <p className="empty">No students yet.</p> : <div className="table-scroll"><table className="history-table"><thead><tr><th>Student</th><th>Added</th><th>Sessions</th><th>Actions</th></tr></thead><tbody>{selectedUser.students.map((student) => <tr key={student.id}><td><strong>{student.name}</strong></td><td>{new Date(student.createdAt).toLocaleDateString()}</td><td>{student.sessions.length}</td><td><div className="table-actions"><button className="button secondary" onClick={() => setSelectedStudentId(student.id)}>View history</button><button className="button danger" onClick={() => void deleteStudent(student)}>Delete student</button></div></td></tr>)}</tbody></table></div>}{selectedStudent && <div className="user-history"><h2>{selectedStudent.name} history</h2><AdminSessionHistory sessions={selectedStudent.sessions} /></div>}</section>}</div>;
}

function AdminSessionHistory({ sessions }: { sessions: AdminSessionSummary[] }) {
  if (sessions.length === 0) return <p className="empty">No completed sessions.</p>;
  return <div className="table-scroll"><table className="history-table"><thead><tr><th>Date</th><th>Operation</th><th>Questions</th><th>Accuracy</th><th>Average time</th></tr></thead><tbody>{sessions.map((session) => <tr key={session.id}><td>{new Date(session.endedAt).toLocaleString()}</td><td>{operationLabel(session.operation)}</td><td>{session.questions}</td><td>{session.questions ? `${Math.round((session.correct / session.questions) * 100)}%` : "-"}</td><td>{session.averageMs ? `${(session.averageMs / 1000).toFixed(1)}s` : "-"}</td></tr>)}</tbody></table></div>;
}
