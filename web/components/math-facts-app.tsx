"use client";

import { FormEvent, Fragment, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { User } from "@supabase/supabase-js";
import { FactCard, answerFor, makeCards } from "../lib/cards";
import { loadCloudProgress, loadVoiceMappings, saveVoiceMapping, syncCloudProgress, queueProgressWrite, rememberUploadedSessions, mergePendingSessions } from "../lib/cloud-progress";
import { AUTOMATICITY_CONFIG } from "../lib/automaticity-config";
import { createAutomaticProgress, startAutomaticSession, resumeAutomaticSession, endAutomaticSession, selectNextQuestion, presentQuestion, applyAttemptResult, beginAnswerExposure, endAnswerExposure, getProgressSummary, pauseAutomaticSession, type AutomaticProgress, type AttemptEvent, type Selection } from "../lib/automaticity";
import { LocalSpeechStatus, prepareLocalSpeech } from "../lib/local-speech";
import type { BrowserSpeechRecognition, BrowserSpeechRecognitionEvent, BrowserSpeechRecognitionErrorEvent } from "../lib/browser-speech";
import { SPEECH_RESULT_GRACE_MS } from "../lib/browser-speech";
import { addNumberHints, readNumberResult } from "../lib/speech-results";
import { ProfileGate, ProfileContext, type AccessStudent } from "./profile-gate";
import { accessRequest } from "../lib/access-client";
import { SpeechTest } from "./speech-test";
import { MasteryProgress } from "./mastery-progress";
import { MicrophoneCheck } from "./microphone-check";
import { StudentAvatar } from "./student-avatar";
import { PracticeDialog } from "./practice-dialog";
import { defaultPreferences, readPreferences, PREFERENCES_KEY, microphoneConfirmed } from "../lib/practice-preferences";
import { hasComparableTime, practiceMetrics } from "../lib/practice-metrics";
import { CurrentUser } from "./current-user";
import { HistoryProgress } from "./history-progress";
import { SessionCelebration } from "./session-celebration";
import { chooseCelebration, prepareCelebrationAudio, shouldCelebrate, type CelebrationChoice } from "../lib/celebration";
import { NumberSpeechRecognition, prepareNumberSpeech } from "../lib/number-speech";
import { isSafariBrowser, prepareSafariNumberAudio, releaseSafariNumberAudio } from "../lib/safari-number-audio";
import { HistorySort, historyResult, sortHistoryAttempts } from "../lib/history-sort";
import { CardState, Operation, TIMEOUT_MS, defaultState, updateCardState } from "../lib/learning";
import { parseSpokenNumber } from "../lib/number-parser";
import { hasSupabaseConfig, supabaseBrowser } from "../lib/supabase-browser";

type View = "practice" | "history" | "progress" | "students" | "users" | "microphone";
type Phase = "setup" | "practice" | "results" | "mic-check";
type Attempt = { id: string; fact: string; operation: Operation; correct: boolean; answerCorrect: boolean; responseMs: number; heard: string; at: string; audit?: AttemptEvent };
type SavedSession = { id: string; operation: Operation; startedAt: string; endedAt: string; attempts: Attempt[] };
type Persisted = { states: Record<string, CardState>; sessions: SavedSession[]; automaticity?: AutomaticProgress | null };
type PendingWrong = { card: FactCard; transcript: string; responseMs: number; attemptId: string; previousState: CardState };
type AccountRole = "admin" | "user";
type AccountProfile = { id: string; email: string; displayName: string | null; role: AccountRole; status: "active" | "blocked" };
type StudentProfile = { id: string; ownerId: string; name: string; createdAt: string; ownerEmail?: string };
type AdminSessionSummary = SavedSession & { questions: number; correct: number; averageMs: number };
type ManagedStudent = { id: string; name: string; createdAt: string; sessions: AdminSessionSummary[]; reportProgress?: Pick<AutomaticProgress, "facts"> | null };
type ManagedUser = { id: string; email: string; displayName: string | null; role: AccountRole; status: "active" | "blocked"; createdAt: string; students: ManagedStudent[] };
type LocalUser = { id: string; name: string; createdAt: string };
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
      automaticity: saved.automaticity ?? null,
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
  if (!hasSupabaseConfig()) return <LocalMode />;
  return <ProfileGate>{session => <PracticeApp
    key={`${session.profile.id}:${session.student?.id ?? "owner"}`}
    cloudUser={{id:session.profile.id,email:session.profile.email} as User}
    account={session.profile} student={session.student}
    initialView={session.mode === "owner" ? "students" : "practice"}
  />}</ProfileGate>;
}

function LocalMode() {
  const [users, setUsers] = useState<LocalUser[]>([DEFAULT_LOCAL_USER]);
  const [choosing, setChoosing] = useState(true);
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
    setActiveUserId(userId); setChoosing(false);
    localStorage.setItem(LOCAL_ACTIVE_USER_KEY, userId);
  };

  const activeUser = users.find((user) => user.id === activeUserId) ?? users[0];
  if (choosing) return <main className="identity-page"><div className="identity-panel"><p className="eyebrow">Auto Math Facts</p><h1>Who’s practicing?</h1><p className="muted">Choose your name. A little practice goes a long way.</p><div className="student-picker">{users.map(user => <button className="identity-card" key={user.id} onClick={() => selectUser(user.id)}><StudentAvatar studentId={user.id} name={user.name}/><strong>{user.name}</strong><small>Let’s practice →</small></button>)}</div><p className="fine-print">Local profiles · saved on this computer</p></div></main>;
  return <ProfileContext.Provider value={{student:false,switchPerson:()=>setChoosing(true)}}><PracticeApp
    key={activeUser.id}
    cloudUser={null}
    isAdmin
    localUsers={users}
    localUserId={activeUser.id}
    localUserName={activeUser.name}
    onAddLocalUser={addUser}
    onDeleteLocalUser={deleteUser}
    onSelectLocalUser={selectUser}
  /></ProfileContext.Provider>;
}

type PracticeAppProps = {
  student?: AccessStudent;
  initialView?: View;
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

function PracticeApp({ student, initialView = "practice", cloudUser, account = null, isAdmin: localAdmin = false, localUsers = [], localUserId, localUserName, onAddLocalUser, onDeleteLocalUser, onSelectLocalUser }: PracticeAppProps) {
  const isAdmin = !student && (account?.role === "admin" || localAdmin);
  const [cloudStudents, setCloudStudents] = useState<StudentProfile[]>(student ? [student] : []);
  const [studentsLoading, setStudentsLoading] = useState(Boolean(cloudUser) && !student);
  const [selectedStudentId, setSelectedStudentId] = useState(student?.id ?? "");
  const activeStudent = cloudStudents.find((student) => student.id === selectedStudentId) ?? null;
  const progressOwnerId = cloudUser ? selectedStudentId : (localUserId ?? DEFAULT_LOCAL_USER.id);
  const progressAccountId = cloudUser ? (activeStudent?.ownerId ?? cloudUser.id) : "";
  const [view, setView] = useState<View>(initialView);
  const [historyLocalUserId, setHistoryLocalUserId] = useState(localUserId ?? "local-default");
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [comfortOpen, setComfortOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const retryRef = useRef(false);
  const beforeAnswerRef = useRef<AutomaticProgress | null>(null);
  const pausedFeedbackRef = useRef(false);
  const microphonePassedRef = useRef(false);
  useEffect(() => { setPreferences(readPreferences()); microphonePassedRef.current = microphoneConfirmed(); }, []);
  const [phase, setPhase] = useState<Phase>("setup");
  const [celebrating, setCelebrating] = useState<CelebrationChoice | null>(null);
  const dismissCelebration = useCallback(() => setCelebrating(null), []);
  const [operation, setOperation] = useState<Operation>("add");
  const [questionCount, setQuestionCount] = useState(50);
  const [selectedFacts, setSelectedFacts] = useState<Record<Operation, Set<string>>>(() => ({
    add: new Set(makeCards("add").map((card) => card.id)),
    sub: new Set(makeCards("sub").map((card) => card.id)),
    mul: new Set(makeCards("mul").map((card) => card.id)),
  }));
  const [automaticity, setAutomaticity] = useState<AutomaticProgress | null>(null);
  const automaticityRef = useRef<AutomaticProgress | null>(null);
  const [progressReady, setProgressReady] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const selectionRef = useRef<Extract<Selection, { kind: "question" }> | null>(null);
  const recordPresentationRef = useRef<() => void>(() => undefined);
  const recordInvalidRef = useRef<(reason: string) => void>(() => undefined);
  const [, setStates] = useState<Record<string, CardState>>({});
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [current, setCurrent] = useState<FactCard | null>(null);
  const [progress, setProgress] = useState(0);
  const [heard, setHeard] = useState("");
  const [speechReport, setSpeechReport] = useState("");
  const [listenState, setListenState] = useState("");
  const [result, setResult] = useState<{ text: string; tone: "good" | "slow" | "wrong"; correctAnswer?: number } | null>(null);
  const [pendingWrong, setPendingWrong] = useState<PendingWrong | null>(null);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [localSpeechStatus, setLocalSpeechStatus] = useState<LocalSpeechStatus | "browser">("browser");
  const [localSpeechError, setLocalSpeechError] = useState("");
  const [numberSpeechStatus, setNumberSpeechStatus] = useState<"idle" | "loading" | "ready" | "failed">("loading");
  const [numberSpeechActive, setNumberSpeechActive] = useState(false);
  const [numberSpeechError, setNumberSpeechError] = useState("");
  const numberSpeechActiveRef = useRef(false);
  const localSpeechReadyRef = useRef(false);
  const numberPreparationVersion = useRef(0);
  const enableNumberSpeech = useCallback(async () => {
    const version = ++numberPreparationVersion.current;
    setNumberSpeechStatus("loading");
    setNumberSpeechError("");
    try {
      await prepareNumberSpeech();
      if (version !== numberPreparationVersion.current) return;
      numberSpeechActiveRef.current = true;
      localSpeechReadyRef.current = false;
      setNumberSpeechActive(true);
      setSpeechSupported(true);
      setNumberSpeechStatus("ready");
      setLocalSpeechStatus("browser");
    } catch (error) {
      if (version !== numberPreparationVersion.current) return;
      setNumberSpeechStatus("failed");
      setNumberSpeechError(error instanceof Error ? error.message : "Could not prepare number recognition.");
      setSpeechSupported(Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition));
    }
  }, []);
  useEffect(() => {
    void enableNumberSpeech();
    const preparation = numberPreparationVersion;
    return () => { preparation.current++; };
  }, [enableNumberSpeech]);
  const localSpeechPreparationRef = useRef<Promise<boolean> | null>(null);
  const prepareSpeech = useCallback(() => {
    if (localSpeechPreparationRef.current) return localSpeechPreparationRef.current;
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const pending = prepareLocalSpeech(Recognition, setLocalSpeechStatus, setLocalSpeechError).then((ready) => {
      localSpeechReadyRef.current = ready;
      if (ready) { numberSpeechActiveRef.current = false; setNumberSpeechActive(false); }
      return ready;
    }).finally(() => { localSpeechPreparationRef.current = null; });
    localSpeechPreparationRef.current = pending;
    return pending;
  }, []);
  const [recognitionFailed, setRecognitionFailed] = useState(false);
  const [questionReady, setQuestionReady] = useState(false);

  const loadStudents = useCallback(async () => {
    if (student) { setCloudStudents([student]); setSelectedStudentId(student.id); setStudentsLoading(false); return; }
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
  }, [cloudUser, student]);

  useEffect(() => { void loadStudents(); }, [loadStudents]);

  const selectStudent = (studentId: string) => {
    setSelectedStudentId(studentId);
    if (cloudUser) localStorage.setItem(`${ACTIVE_STUDENT_KEY}:${cloudUser.id}`, studentId);
    setPhase("setup");
  };

  const statesRef = useRef<Record<string, CardState>>({});
  const voiceMappingsRef = useRef<Record<string, number>>({});
  const attemptsRef = useRef<Attempt[]>([]);
  const questionStartRef = useRef(0);
  const soundResponseMsRef = useRef<number | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const startListeningRef = useRef<(card: FactCard) => void>(() => undefined);
  const answerHandledRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const nextRef = useRef<number | null>(null);

  const stopListening = useCallback(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    if (recognitionRef.current) {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onaudiostart = null;
      recognition.onsoundstart = null;
      recognition.onspeechstart = null;
      recognition.onspeechend = null;
      recognition.abort();
    }
  }, []);

  useEffect(() => {
    if (!progressOwnerId) return;
    let cancelled = false;
    setProgressReady(false);
    setSyncMessage("");
    selectionRef.current = null;
    const saved = readProgress(progressOwnerId);
    const restore = (loaded: Persisted) => {
      const deck = [...makeCards("add"), ...makeCards("sub"), ...makeCards("mul")];
      const auto = loaded.automaticity?.version === 1 && loaded.automaticity.learnerId === progressOwnerId
        ? loaded.automaticity : createAutomaticProgress(progressOwnerId, deck, loaded.states, Intl.DateTimeFormat().resolvedOptions().timeZone);
      automaticityRef.current = auto; setAutomaticity(auto);
      statesRef.current = loaded.states; setStates(loaded.states); setSessions(loaded.sessions);
      if (auto.session) {
        setOperation(auto.session.operation); setQuestionCount(auto.session.targetCount);
        setSelectedFacts(current => ({ ...current, [auto.session!.operation]: new Set(auto.session!.factIds) }));
      }
      localStorage.setItem(progressStorageKey(progressOwnerId), JSON.stringify({ ...loaded, automaticity: auto }));
      setProgressReady(true);
    };
    voiceMappingsRef.current = readVoiceMappings(progressOwnerId);
    const savedMappings = voiceMappingsRef.current;
    const client = supabaseBrowser();
    if (client && cloudUser && navigator.onLine) {
      loadCloudProgress(client, progressOwnerId).then((cloud) => {
        if (cancelled) return;
        if (!cloud) throw new Error("Progress could not be loaded.");
        // Local, not-yet-uploaded work survives reload/offline reconnection.
        const useLocal = saved.automaticity && (!cloud.automaticity || saved.automaticity.updatedAt > cloud.automaticity.updatedAt);
        restore(useLocal ? { ...saved, sessions: mergePendingSessions(progressOwnerId, saved.sessions, cloud.sessions) } : cloud);
      }).catch((error) => { if (!cancelled) { setSyncMessage(error instanceof Error ? error.message : "Progress could not be loaded."); } });
      loadVoiceMappings(client, progressOwnerId).then((cloudMappings) => {
        if (cancelled) return;
        const merged = { ...cloudMappings, ...savedMappings };
        voiceMappingsRef.current = merged;
        localStorage.setItem(voiceMappingsStorageKey(progressOwnerId), JSON.stringify(merged));
      }).catch(() => undefined);
    } else if (!cloudUser || saved.automaticity) restore(saved);
    else setSyncMessage("Connect to load this student's progress before practicing.");
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSpeechSupported(Boolean(Recognition) || Boolean(window.AudioContext && navigator.mediaDevices?.getUserMedia));
    if ("serviceWorker" in navigator) {
      if (process.env.NODE_ENV === "production") {
        navigator.serviceWorker.register("/sw.js").catch(() => undefined);
      } else {
        // An old offline shell can refer to styles removed by a later dev build.
        navigator.serviceWorker.getRegistrations().then(async (registrations) => {
          for (const registration of registrations) {
            const worker = registration.active ?? registration.waiting ?? registration.installing;
            if (worker && new URL(worker.scriptURL).pathname === "/sw.js") {
              await registration.unregister();
            }
          }
          const keys = await caches.keys();
          await Promise.all(keys.filter((key) => key.startsWith("math-facts-")).map((key) => caches.delete(key)));
        }).catch(() => undefined);
      }
    }
    return () => { cancelled = true; stopListening(); releaseSafariNumberAudio(); if (nextRef.current !== null) window.clearTimeout(nextRef.current); };
  }, [cloudUser, progressOwnerId, stopListening]);

  const saveProgress = useCallback((nextStates: Record<string, CardState>, nextSessions: SavedSession[]) => {
    if (!progressOwnerId) return;
    statesRef.current = nextStates;
    setStates(nextStates);
    setSessions(nextSessions);
    localStorage.setItem(progressStorageKey(progressOwnerId), JSON.stringify({ states: nextStates, sessions: nextSessions, automaticity: automaticityRef.current }));
    const client = supabaseBrowser();
    if (client && cloudUser && navigator.onLine) {
      void syncCloudProgress(client, progressOwnerId, progressAccountId, { states: nextStates, sessions: nextSessions, automaticity: automaticityRef.current }).then(() => setSyncMessage("")).catch(() => setSyncMessage("Saved on this device. Cloud sync is pending; reconnect here before switching devices."));
    } else if (cloudUser) setSyncMessage("Saved on this device. Cloud sync is pending; reconnect here before switching devices.");
  }, [cloudUser, progressAccountId, progressOwnerId]);

  useEffect(() => {
    const client = supabaseBrowser();
    if (!client || !cloudUser || !progressOwnerId) return;
    const syncWhenOnline = () => {
      const saved = readProgress(progressOwnerId);
      void syncCloudProgress(client, progressOwnerId, progressAccountId, saved).then(() => setSyncMessage("")).catch(() => setSyncMessage("Saved on this device. Cloud sync is pending; reconnect here before switching devices."));
      const mappings = readVoiceMappings(progressOwnerId);
      void Promise.all(Object.entries(mappings).map(([phrase, answer]) => saveVoiceMapping(client, progressOwnerId, progressAccountId, phrase, answer))).catch(() => undefined);
    };
    window.addEventListener("online", syncWhenOnline);
    return () => window.removeEventListener("online", syncWhenOnline);
  }, [cloudUser, progressAccountId, progressOwnerId]);

  const persistAutomaticity = useCallback((next: AutomaticProgress) => {
    automaticityRef.current = next;
    setAutomaticity(next);
    saveProgress(statesRef.current, sessions);
  }, [saveProgress, sessions]);

  const sessionRecord = (auto: AutomaticProgress): SavedSession | null => {
    const session = auto.session;
    if (!session) return null;
    return { id: session.id, operation: session.operation, startedAt: new Date(session.startedAt).toISOString(), endedAt: new Date(session.endedAt ?? Date.now()).toISOString(), attempts: auto.events.filter(e => e.sessionId === session.id && e.result !== "INVALID" && e.result !== "ABANDONED").map(e => {
      const parts = e.factId.split("-"); const op = parts[0] as Operation;
      return { id: e.id, fact: `${parts[1]} ${operationSymbol(op)} ${parts[2]}`, operation: op, correct: e.correct, answerCorrect: e.correct, responseMs: e.responseMs, heard: e.heard, at: new Date(e.completedAt).toISOString(), audit: e };
    }) };
  };

  const finishSession = useCallback((notice = "") => {
    stopListening();
    releaseSafariNumberAudio();
    const auto = automaticityRef.current;
    if (!auto?.session || auto.session.status === "ended") return;
    if (nextRef.current !== null) window.clearTimeout(nextRef.current);
    setPaused(false);
    const next = endAutomaticSession(auto);
    automaticityRef.current = next; setAutomaticity(next);
    const completed = sessionRecord(next)!;
    setCelebrating(completed.attempts.length >= auto.session.targetCount && shouldCelebrate(practiceMetrics(completed.attempts).scored, practiceMetrics(completed.attempts).scored.length) ? chooseCelebration() : null);
    saveProgress(statesRef.current, [completed, ...sessions.filter(s => s.id !== completed.id)]);
    setSessionNotice(notice); setPhase("results"); setCurrent(null); selectionRef.current = null;
  }, [saveProgress, sessions, stopListening]);

  const advance = useCallback(() => {
    const auto = automaticityRef.current;
    if (!auto?.session) return;
    const prepared = endAnswerExposure(auto);
    automaticityRef.current = prepared;
    const enabled = makeCards(prepared.session!.operation).filter(card => prepared.session!.factIds.includes(card.id));
    const choice = selectNextQuestion(prepared, enabled);
    if (choice.kind === "none") {
      finishSession(prepared.session!.gradedCount >= prepared.session!.targetCount ? "" : choice.reason + (choice.nextUsefulAt ? ` Next useful review: ${new Date(choice.nextUsefulAt).toLocaleString()}.` : ""));
      return;
    }
    selectionRef.current = choice; retryRef.current = false;
    setListenState("Opening microphone…");
    setCurrent(choice.fact); setPendingWrong(null); setQuestionReady(false); setHeard(""); setResult(null);
    setProgress(prepared.session!.gradedCount);
    nextRef.current = window.setTimeout(() => startListeningRef.current(choice.fact), 100);
  }, [finishSession]);

  useEffect(() => {
    recordPresentationRef.current = () => {
      const auto = automaticityRef.current, selection = selectionRef.current;
      if (!auto || !selection || auto.session?.current) return;
      persistAutomaticity(presentQuestion(auto, selection));
    };
    recordInvalidRef.current = (reason) => {
      const auto = automaticityRef.current, presentation = auto?.session?.current;
      if (!auto || !presentation) return;
      persistAutomaticity(applyAttemptResult(auto, { presentationId: presentation.id, correct: false, responseMs: 0, invalid: true, heard: reason }));
      // A technical retry is a new exposure, never a second cold check.
      retryRef.current = true;
      if (selectionRef.current?.attemptKind === "check") selectionRef.current = { ...selectionRef.current, attemptKind: "extra" };
    };
  }, [persistAutomaticity]);

  const handleResponse = useCallback((card: FactCard, transcript: string, parsed: number | null, responseMs: number, timingReliable = true) => {
    const auto = automaticityRef.current, presentation = auto?.session?.current;
    if (answerHandledRef.current || !auto || !presentation || presentation.fact.id !== card.id) return;
    answerHandledRef.current = true;
    stopListening();
    const answerCorrect = parsed === answerFor(card);
    const comparable = timingReliable && !retryRef.current;
    const passed = answerCorrect && comparable && responseMs <= AUTOMATICITY_CONFIG.automaticityTargetMs;
    beforeAnswerRef.current = auto;
    let next = applyAttemptResult(auto, { presentationId: presentation.id, correct: answerCorrect, firstAnswerCorrect: answerCorrect, responseMs, timeout: parsed === null, heard: transcript, timingReliable, retry: retryRef.current });
    if (next === auto) return;
    const audit = next.events.at(-1)!;
    // Legacy metrics remain available for historical views. They no longer select
    // questions or award mastery; both fast speeds receive the same grade.
    const previousState = statesRef.current[card.id] ?? defaultState(card.id);
    const nextState = updateCardState(previousState, !answerCorrect ? "again" : passed ? "good" : "hard", responseMs);
    if (comparable) { statesRef.current = { ...statesRef.current, [card.id]: nextState }; setStates(statesRef.current); }
    setHeard(transcript || "No answer heard"); setListenState("");
    const elapsed = comparable && preferences.showTimes ? ` · ${(responseMs / 1000).toFixed(2)} seconds` : "";
    setResult(passed ? { text: `Correct!${elapsed}`, tone: "good" }
      : answerCorrect ? { text: comparable ? `Slow!${elapsed}` : "Correct!", tone: comparable ? "slow" : "good" }
      : { text: `Wrong!${elapsed}`, tone: "wrong", correctAnswer: answerFor(card) });
    if (!comparable) setListenState(retryRef.current ? "Retry practice · no speed or mastery result" : "Answer recorded · timing unavailable");
    if (answerCorrect && preferences.successSound) {
      try { const context = new AudioContext(), tone = context.createOscillator(), gain = context.createGain(); tone.frequency.value = 660; gain.gain.setValueAtTime(.035, context.currentTime); gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .17); tone.connect(gain).connect(context.destination); tone.start(); tone.stop(context.currentTime + .18); tone.onended = () => void context.close(); } catch { /* Feedback never blocks practice. */ }
    }
    const attempt: Attempt = { id: audit.id, fact: `${card.a} ${operationSymbol(card.operation)} ${card.b}`, operation: card.operation, correct: answerCorrect, answerCorrect, responseMs, heard: transcript, at: new Date(audit.completedAt).toISOString(), audit };
    attemptsRef.current = [...attemptsRef.current, attempt];
    setProgress(next.session!.gradedCount);
    if (!answerCorrect) {
      next = beginAnswerExposure(next, card);
      setPendingWrong({ card, transcript, responseMs, attemptId: audit.id, previousState });
    }
    nextRef.current = window.setTimeout(advance, !answerCorrect ? 4000 : passed ? 1200 : 1800);
    persistAutomaticity(next);
  }, [advance, persistAutomaticity, stopListening, preferences]);

  const startListening = useCallback((card: FactCard) => {
    const Recognition = numberSpeechActiveRef.current ? NumberSpeechRecognition : window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) { setSpeechSupported(false); setListenState("Speech recognition is unavailable in this browser."); return; }
    stopListening();
    answerHandledRef.current = false;
    soundResponseMsRef.current = null;
    setQuestionReady(false);
    setHeard("");
    setResult(null);
    setListenState("Starting microphone…"); setRecognitionFailed(false);
    setSpeechReport("");
    const recognitionStartedAt = performance.now();
    const trace = [`Practice speech v4 · ${numberSpeechActiveRef.current ? "number engine (Vosk)" : localSpeechReadyRef.current ? "on-device" : "browser"}`, navigator.userAgent];
    const log = (message: string) => {
      if (trace.length >= 100) trace.splice(2, 1);
      trace.push(`${((performance.now() - recognitionStartedAt) / 1000).toFixed(3)}s ${message}`);
    };
    const recognition: BrowserSpeechRecognition = new Recognition();
    if (localSpeechReadyRef.current) recognition.processLocally = true;
    recognition.lang = "en-US";
    // Keep the recognizer open across short speech/silence boundaries. We own
    // the question deadline and stop it after an answer is committed.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    let numberHints = addNumberHints(recognition, window.SpeechRecognitionPhrase);
    let retryWithoutHints = false;
    let latestTranscript = "";
    let latestNumberFinal = false;
    let latestResponseMs = TIMEOUT_MS;
    let firstNumberAt: number | null = null;
    let timingEstimated = false;
    let ready = false;
    let revealScheduled = false;
    let emptyRestarts = 0;
    let drainingResult = false;
    let soundDetected = false;
    const isActive = () => recognitionRef.current === recognition && !answerHandledRef.current;
    const fail = (message: string) => {
      if (!isActive()) return;
      setRecognitionFailed(true);
      log(`Not scored: ${message}`);
      recordInvalidRef.current(message);
      setSpeechReport(trace.join("\n"));
      stopListening();
      setResult(null);
      setListenState(message);
    };
    const finish = () => {
      if (!isActive()) return;
      if (!latestTranscript) {
        if (ready && drainingResult && !soundDetected && soundResponseMsRef.current === null) {
          // Successful capture followed by the full silent answer window is a
          // timeout. Detected speech with a missing transcript remains invalid.
          handleResponse(card, "No answer before the deadline", null, TIMEOUT_MS);
          return;
        }
        const mode = numberSpeechActiveRef.current ? "Number" : recognition.processLocally ? "On-device" : "Browser";
        const detail = soundResponseMsRef.current !== null
          ? "Speech was detected, but no words were returned."
          : soundDetected ? "Sound was detected, but no speech was recognized."
            : "The browser reported no microphone sound. Check the selected microphone and input level.";
        fail(`${mode} recognition: ${detail} Tap Mic to retry. No answer was scored.`);
        return;
      }
      const parsed = parseSpokenNumber(latestTranscript, voiceMappingsRef.current);
      if (parsed === null) {
        fail("Words were heard, but no number was recognized. Tap Mic to retry. No answer was scored.");
        return;
      }
      if (recognition.usesWordTiming && !latestNumberFinal) { fail("The number was not finished. Tap Mic to retry. No answer was scored."); return; }
      if (soundResponseMsRef.current === null) {
        // Keep the understood answer. An unavailable acoustic boundary must
        // not invent a zero time; transcript arrival is an explicit estimate.
        latestResponseMs = Math.min(Math.max(0, Math.round((firstNumberAt ?? performance.now()) - questionStartRef.current)), TIMEOUT_MS);
        timingEstimated = true;
        log("Speech onset unavailable; response time estimated from first numeric transcript");
      }
      handleResponse(card, latestTranscript, parsed, latestTranscript ? latestResponseMs : TIMEOUT_MS, !timingEstimated);
      if (timingEstimated) setListenState("Answer recorded · timing unavailable");
    };
    const answerDeadline = () => {
      if (!isActive()) return;
      if (!recognition.usesWordTiming && parseSpokenNumber(latestTranscript, voiceMappingsRef.current) !== null) { finish(); return; }
      // Stop capturing at four seconds, but let either engine return its
      // buffered result. abort() would discard that result entirely.
      drainingResult = true;
      log("Four-second deadline: stop audio capture; wait for buffered transcript");
      setListenState("Finishing recognition…");
      timeoutRef.current = window.setTimeout(finish, SPEECH_RESULT_GRACE_MS);
      try { recognition.stop(); } catch { fail("Microphone stopped unexpectedly. Tap Mic to retry. No answer was scored."); }
    };
    recognition.onstart = () => {
      if (isActive()) log("Recognition started");
      if (isActive() && !ready) setListenState("Opening microphone — wait for the question…");
    };
    // Service start is not proof that microphone capture has started. Reveal
    // the question only on audiostart so a quick single syllable is not lost
    // in the gap between those two events.
    recognition.onaudiostart = () => {
      if (!isActive() || ready || revealScheduled) return;
      revealScheduled = true;
      log("Audio capture started; waiting for question display frame");
      window.requestAnimationFrame(() => {
        if (!isActive() || ready) return;
        // Commit the visible question in this display frame, rather than
        // timing from a queued React state update or microphone startup.
        flushSync(() => setQuestionReady(true));
        questionStartRef.current = performance.now();
        recognition.beginAnswerWindow?.(questionStartRef.current);
        recordPresentationRef.current();
        ready = true;
        log("Question revealed; four-second timer started");
        if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
        setListenState("Listening — say your answer");
        timeoutRef.current = window.setTimeout(answerDeadline, TIMEOUT_MS);
      });
    };
    recognition.onsoundstart = () => {
      if (isActive() && ready && !drainingResult) { soundDetected = true; log("Sound detected"); }
    };
    recognition.onspeechstart = () => {
      if (isActive() && ready && !drainingResult && soundResponseMsRef.current === null) {
        soundResponseMsRef.current = Math.min(Math.round(performance.now() - questionStartRef.current), TIMEOUT_MS);
        log("Speech detected");
      }
    };
    recognition.onspeechend = () => {
      // A silence boundary is not a final answer. Leave the recognizer open
      // for the decoder to finish, or for the learner to repeat a short word.
      if (isActive() && ready && !drainingResult) { log("Speech boundary (still listening)"); setListenState("Listening — recognizing your answer…"); }
    };
    recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
      if (!isActive() || !ready || !event.results.length) return;
      const { transcript, value: parsedNumber } = readNumberResult(event.results, voiceMappingsRef.current);
      log(`Combined: ${JSON.stringify(transcript)} → ${parsedNumber ?? "no single number"}`);
      for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) {
        const segment = event.results[i];
        for (let j = 0; j < segment.length; j += 1) log(`Segment ${i + 1} ${segment.isFinal ? "final" : "interim"}, choice ${j + 1}: ${JSON.stringify(segment[j].transcript)}`);
      }
      // An empty browser result is not an answer. Keep listening within the
      // original deadline, and don't erase a number already heard.
      if (!transcript) return;
      if (parsedNumber !== null && firstNumberAt === null) firstNumberAt = performance.now();
      if (recognition.usesWordTiming && Number.isFinite(event.speechStartedAt)) {
        const onset = event.speechStartedAt!;
        // Word boundaries are estimates. Do not reject an understood answer
        // because of a clock/boundary mismatch, or turn it into a zero score.
        const measured = onset - questionStartRef.current;
        soundResponseMsRef.current = measured >= 50 && measured <= TIMEOUT_MS
          ? Math.min(Math.round(measured), TIMEOUT_MS)
          : null;
        if (measured < 50) log("Zero/early word boundary rejected as a reliable response time");
        if (soundResponseMsRef.current !== null) latestResponseMs = soundResponseMsRef.current;
      }
      const sameNumber = parsedNumber !== null && parsedNumber === parseSpokenNumber(latestTranscript, voiceMappingsRef.current);
      // Keep the time already displayed when the final event merely confirms
      // the same number. A revised number gets its own arrival time.
      if (!sameNumber) latestResponseMs = soundResponseMsRef.current ?? Math.min(Math.round(performance.now() - questionStartRef.current), TIMEOUT_MS);
      latestTranscript = transcript;
      latestNumberFinal = Boolean(event.results[event.results.length - 1]?.isFinal && parsedNumber !== null);
      setHeard(transcript);
      // "Final" can mark only a segment such as "the answer is". Keep
      // listening until a number arrives; a finalized prefix is not wrong.
      if (event.results[event.results.length - 1]?.isFinal && parsedNumber !== null) {
        finish();
      } else {
        // Show feedback alongside the live transcript. Do not stop recognition or
        // save an attempt yet: a partial "twenty" can still become "twenty eight".
        const parsed = parseSpokenNumber(transcript, voiceMappingsRef.current);
        const correct = parsed === answerFor(card);
        const elapsed = preferences.showTimes && !retryRef.current ? ` · ${(latestResponseMs / 1000).toFixed(2)} seconds` : "";
        const awaitingTiming = retryRef.current || soundResponseMsRef.current === null;
        // A partial "one" can still become "one oh eight". Only a completed
        // answer may show Wrong; matching interim answers stay responsive.
        setResult(!correct ? null : awaitingTiming
          ? { text: "Correct!", tone: "good" }
          : { text: `${latestResponseMs <= AUTOMATICITY_CONFIG.automaticityTargetMs ? "Correct!" : "Slow!"}${elapsed}`, tone: latestResponseMs <= AUTOMATICITY_CONFIG.automaticityTargetMs ? "good" : "slow" });
        if (!correct) setListenState("Listening — finishing your answer…");
      }
    };
    recognition.onerror = (event: BrowserSpeechRecognitionErrorEvent) => {
      if (!isActive()) return;
      log(`Recognition error: ${event.error}`);
      if (event.error === "phrases-not-supported" && numberHints) {
        recognition.phrases = [];
        numberHints = false;
        retryWithoutHints = true;
        return;
      }
      if (event.error === "no-speech") return;
      if (recognition.processLocally && (event.error === "language-not-supported" || event.error === "service-not-allowed")) {
        localSpeechReadyRef.current = false;
        setLocalSpeechStatus("failed");
        fail("On-device speech is unavailable. Tap Mic to retry with browser speech.");
        return;
      }
      const messages: Record<string, string> = {
        "not-allowed": "Allow microphone access, then tap Mic to retry.",
        "service-not-allowed": "Speech recognition is blocked by this browser. Check its permissions.",
        "audio-capture": "No microphone found. Connect one, then tap Mic to retry.",
        "audio-interrupted": "Safari interrupted the microphone. Tap Mic to reconnect. No answer was scored.",
        "network": "Speech service connection failed. Check your connection, then tap Mic.",
        "number-decoder": "Number recognition stopped. Tap Mic to retry, or switch recognition mode in practice setup.",
      };
      fail(messages[event.error] ?? "Speech recognition stopped. Tap Mic to retry.");
    };
    recognition.onend = () => {
      if (!isActive()) return;
      log("Recognition ended");
      if (retryWithoutHints && !drainingResult) {
        retryWithoutHints = false;
        try { recognition.start(); } catch { fail("Microphone stopped. Tap Mic to retry."); }
        return;
      }
      if (!ready) fail("Microphone did not start. Tap Mic to retry.");
      else if (drainingResult) finish();
      else if (parseSpokenNumber(latestTranscript, voiceMappingsRef.current) !== null) finish();
      else if (emptyRestarts < 2 && performance.now() - questionStartRef.current < TIMEOUT_MS) {
        emptyRestarts += 1;
        setListenState("Listening — please repeat your answer");
        // Reuse the original question start and deadline: recovery must not
        // give extra answer time or record a second attempt.
        try { recognition.start(); }
        catch { fail("Microphone stopped. Tap Mic to retry."); }
      } else { setRecognitionFailed(true); setListenState("No speech detected — tap Mic to retry"); }
    };
    recognitionRef.current = recognition;
    // Startup failures do not count as a student's answer or consume answer time.
    timeoutRef.current = window.setTimeout(() => fail("Microphone did not start. Tap Mic to retry."), TIMEOUT_MS);
    try { recognition.start(); }
    catch { fail("Microphone could not start. Tap Mic to retry."); }
  }, [handleResponse, stopListening, preferences.showTimes]);
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);

  const startPractice = (checked = false) => {
    if (!speechSupported || numberSpeechStatus === "loading" || !progressReady || !automaticityRef.current) return;
    const cards = makeCards(operation).filter(card => selectedFacts[operation].has(card.id));
    if (!cards.length) return;
    if (!checked && !microphonePassedRef.current && !microphoneConfirmed()) { setPhase("mic-check"); return; }
    if (preferences.celebrationSound) prepareCelebrationAudio();
    if (numberSpeechActiveRef.current) prepareSafariNumberAudio();
    setCelebrating(null);
    const previous = automaticityRef.current;
    const next = previous.session && previous.session.status !== "ended"
      ? resumeAutomaticSession(previous)
      : startAutomaticSession(previous, { id: crypto.randomUUID(), operation, cards, targetCount: questionCount });
    setOperation(next.session!.operation); setQuestionCount(next.session!.targetCount);
    setSelectedFacts(current => ({ ...current, [next.session!.operation]: new Set(next.session!.factIds) }));
    persistAutomaticity(next);
    attemptsRef.current = sessionRecord(next)?.attempts ?? [];
    setPaused(false); retryRef.current = false; setPhase("practice"); setView("practice"); setSessionNotice(""); setPendingWrong(null);
    advance();
  };

  const restartRecognition = () => {
    if (current && !answerHandledRef.current) {
      recordInvalidRef.current("Manual recognition restart; no answer scored.");
      if (numberSpeechActiveRef.current && isSafariBrowser()) {
        stopListening();
        prepareSafariNumberAudio();
      }
      startListening(current);
    }
  };

  const allowPendingAnswer = () => {
    const before = beforeAnswerRef.current;
    if (!pendingWrong || !before?.session?.current) return;
    if (nextRef.current !== null) window.clearTimeout(nextRef.current);
    const next = applyAttemptResult(before, { presentationId: before.session.current.id, correct: false, responseMs: pendingWrong.responseMs, heard: pendingWrong.transcript, disputed: true });
    statesRef.current = { ...statesRef.current, [pendingWrong.card.id]: pendingWrong.previousState };
    const audit = next.events.at(-1)!;
    attemptsRef.current = attemptsRef.current.map(a => a.id === audit.id ? { ...a, audit } : a);
    persistAutomaticity(beginAnswerExposure(next, pendingWrong.card));
    setResult({ text: "Recognition disputed · not a math mistake", tone: "slow" });
    setPendingWrong(null); setListenState("No speed or mastery result");
    nextRef.current = window.setTimeout(advance, 1400);
  };
  const pausePractice = () => {
    if (nextRef.current !== null) window.clearTimeout(nextRef.current);
    pausedFeedbackRef.current = answerHandledRef.current;
    if (!answerHandledRef.current) { recordInvalidRef.current("Round paused; no answer scored."); retryRef.current = true; }
    stopListening(); releaseSafariNumberAudio();
    if (automaticityRef.current) persistAutomaticity(pauseAutomaticSession(automaticityRef.current));
    setPaused(true);
  };
  const resumePractice = () => {
    if (numberSpeechActiveRef.current) prepareSafariNumberAudio();
    if (automaticityRef.current) persistAutomaticity(resumeAutomaticSession(automaticityRef.current));
    setPaused(false);
    if (pausedFeedbackRef.current) advance();
    else if (current) startListening(current);
  };

  const exitPractice = () => {
    answerHandledRef.current = true;
    if (nextRef.current !== null) window.clearTimeout(nextRef.current);
    nextRef.current = null;
    finishSession("Session ended early. Completed attempts and exposures were saved.");
  };

  const allCards = makeCards(operation);
  const selectedCount = allCards.filter((card) => selectedFacts[operation].has(card.id)).length;

  const subjectSummary = automaticity ? getProgressSummary(automaticity, allCards) : null;
  const currentSession = phase === "results" ? sessions[0] : null;
  const accountName = student?.name || account?.displayName || account?.email || localUserName;

  const microphoneSettings = (
        <section className="voice-settings" aria-labelledby="voice-settings-title">
          <div className="voice-settings-copy">
            <div className="voice-settings-heading"><h2 id="voice-settings-title">Voice recognition</h2><span className="voice-mode">{numberSpeechStatus === "loading" ? "Preparing number recognition…" : numberSpeechActive ? "Number recognition active" : localSpeechStatus === "ready" ? "On-device active" : speechSupported ? "Browser active" : "Recognition unavailable"}</span></div>
            <div role="status">
              <p>{numberSpeechActive ? "Using a local engine with a number-focused vocabulary. Your voice stays on this device." :
                numberSpeechStatus === "loading" ? "Preparing number recognition (about 40 MB on the first download)…" :
                localSpeechStatus === "browser" ? "Number recognition is the default. It runs on this device after a one-time download of about 40 MB. Browser recognition is available as a fallback." :
                localSpeechStatus === "ready" ? "The English speech pack is ready. Answers are recognized on this device." :
                localSpeechStatus === "checking" ? "Checking whether this browser supports on-device recognition…" :
                localSpeechStatus === "downloading" ? "Downloading the English speech pack. You can practice while it downloads." :
                localSpeechStatus === "unsupported" ? "This browser does not support the on-device English speech pack. Browser recognition is still available." :
                "The speech pack could not be prepared. You can still practice with browser recognition."}</p>
              {localSpeechStatus === "failed" && localSpeechError && <p className="voice-error">{localSpeechError}</p>}
              {numberSpeechError && <p className="voice-error">{numberSpeechError}</p>}
            </div>
          </div>
          <div className="voice-settings-action">
            {!numberSpeechActive && <button className="button primary" disabled={numberSpeechStatus === "loading"} onClick={() => void enableNumberSpeech()}>{numberSpeechStatus === "loading" ? "Preparing number recognition…" : numberSpeechStatus === "ready" ? "Use number recognition" : "Enable number recognition"}</button>}
            {numberSpeechActive && <button className="button secondary" onClick={() => { numberSpeechActiveRef.current = false; setNumberSpeechActive(false); }}>Use browser recognition</button>}
            {localSpeechStatus === "failed" && <button className="button primary" onClick={() => void prepareSpeech()}>Retry speech download</button>}
            {localSpeechStatus === "browser" && !numberSpeechActive && numberSpeechStatus !== "loading" && <button className="button secondary" onClick={() => void prepareSpeech()}>Try browser’s on-device pack</button>}
            {localSpeechStatus === "ready" && <button className="button secondary" onClick={() => { localSpeechReadyRef.current = false; setLocalSpeechStatus("browser"); }}>Use browser recognition</button>}
          </div>
          {!student && numberSpeechStatus !== "loading" && <SpeechTest key={numberSpeechActive ? "numbers" : localSpeechStatus === "ready" ? "local" : "browser"} local={localSpeechStatus === "ready"} numbers={numberSpeechActive} />}
        </section>
  );
  const frameProps = { view, onNavigate: setView, onExit: () => setPhase("setup" as Phase), isAdmin, accountName, avatarStudentId: student?.id ?? (!cloudUser ? progressOwnerId : undefined), onPreferences: () => setComfortOpen(true) };
  const comfortDialog = comfortOpen && <PracticeDialog title="Make practice comfortable" onClose={() => setComfortOpen(false)}>
    <p>Questions move on automatically. Pause whenever you need a break.</p>
    {([["showTimes", "Show response times during practice"], ["successSound", "Short success sound"], ["motion", "Animated gumdrop celebrations"], ["celebrationSound", "Celebration music"]] as const).map(([key, label]) => <label className="check-row" key={key}><input type="checkbox" checked={preferences[key]} onChange={event => {
      const next = { ...preferences, [key]: event.target.checked }; setPreferences(next); try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); } catch { /* Current visit still works. */ }
    }}/>{label}</label>)}
    <p className="muted">Times remain available in History. Celebrations last eight seconds, with five tunes and five scenes mixed independently.</p>
    <button className="button primary" onClick={() => setComfortOpen(false)}>Done</button>
  </PracticeDialog>;
  if (view === "microphone" && !student) return <AppFrame {...frameProps}>{comfortDialog}<MicrophoneCheck troubleshooting onBack={() => setView(isAdmin ? "users" : "students")}/>{microphoneSettings}{speechReport && <details className="speech-test"><summary>Last practice recognition report</summary><textarea readOnly rows={8} value={speechReport} aria-label="Last recognition report"/></details>}</AppFrame>;
  if (phase === "mic-check") return <AppFrame {...frameProps}>{comfortDialog}<MicrophoneCheck onBack={() => setPhase("setup")} onContinue={() => { microphonePassedRef.current = true; startPractice(true); }}/></AppFrame>;

  if (view === "users" && isAdmin && cloudUser) {
    return <AppFrame {...frameProps}>{comfortDialog}
      <div className="admin-mic-card"><h2>Microphone troubleshooting</h2><p>Run a sound check or inspect recognition settings on this browser.</p><button className="button secondary" onClick={() => setView("microphone")}>Check microphone</button></div><UserManagement currentUserId={cloudUser.id} />
    </AppFrame>;
  }

  if (view === "students" && !student) {
    return <AppFrame {...frameProps}>{comfortDialog}
      <div className="admin-mic-card"><h2>Microphone troubleshooting</h2><p>A successful sound check is remembered for everyone on this browser.</p><button className="button secondary" onClick={() => setView("microphone")}>Check microphone</button></div>
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

  if (view === "history" || view === "progress") {
    const historyStudent = localUsers.find((student) => student.id === historyLocalUserId);
    const localHistory = cloudUser ? null : readProgress(historyLocalUserId);
    const historySessions = cloudUser ? sessions : localHistory!.sessions;
    const historyReady = !cloudUser || (progressReady && automaticity?.learnerId === selectedStudentId);
    return <AppFrame {...frameProps}>{comfortDialog}
      <div className="topbar"><div><h1>{view === "progress" ? "See your progress" : "Your practice history"}</h1><p className="muted">{cloudUser ? `Showing sessions, including early exits, for ${activeStudent?.name ?? "the selected student"}.` : `Showing sessions, including early exits, for ${historyStudent?.name ?? "this learner"} on this device.`}</p></div></div>
      {!student && <div className="form-row">
        <label>Student
          {cloudUser
            ? <select value={selectedStudentId} onChange={(event) => selectStudent(event.target.value)} disabled={studentsLoading || cloudStudents.length === 0}>
                {cloudStudents.length === 0 && <option value="">No students yet</option>}
                {cloudStudents.map((student) => <option key={student.id} value={student.id}>{student.name}{isAdmin && student.ownerEmail ? ` — ${student.ownerEmail}` : ""}</option>)}
              </select>
            : <select value={historyLocalUserId} onChange={(event) => setHistoryLocalUserId(event.target.value)}>
                {localUsers.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
              </select>}
        </label>
      </div>}
      {!historyReady ? <p className="notice" role="status">{syncMessage || (selectedStudentId ? "Loading this student’s history and progress…" : "Add a student to see their history and progress.")}</p> : <HistoryProgress initialTab={view === "progress" ? "report" : "sessions"} onPractice={!cloudUser && historyLocalUserId !== progressOwnerId ? undefined : card => { setOperation(card.operation); setSelectedFacts(current => ({ ...current, [card.operation]: new Set([card.id]) })); setPhase("setup"); setView("practice"); }} key={`${view}:${cloudUser ? selectedStudentId : historyLocalUserId}`} name={cloudUser ? activeStudent?.name ?? "Student" : historyStudent?.name ?? "Learner"} sessions={historySessions} progress={cloudUser ? automaticity : localHistory?.automaticity}>
      <SessionHistory sessions={historySessions} detailedDates onDelete={student ? undefined : async (sessionId) => {
        const ownerId = cloudUser ? selectedStudentId : historyLocalUserId;
        if (cloudUser) {
          if (!navigator.onLine) throw new Error("Connect to the internet to delete a saved session.");
          await queueProgressWrite(ownerId, async () => {
            await accountRequest(`/api/sessions/${sessionId}`, { method: "DELETE" });
            rememberUploadedSessions(ownerId, [sessionId]);
          });
        }
        const saved = readProgress(ownerId);
        saved.sessions = saved.sessions.filter((session) => session.id !== sessionId);
        localStorage.setItem(progressStorageKey(ownerId), JSON.stringify(saved));
        setSessions((current) => current.filter((session) => session.id !== sessionId));
      }} />
      </HistoryProgress>}
    </AppFrame>;
  }

  if (phase === "practice" && current) {
    return <main className="practice redesign-practice">
      <header className="practice-toolbar">
        <div className="round-identity"><StudentAvatar studentId={progressOwnerId} name={activeStudent?.name ?? localUserName ?? "Student"}/><div><strong>{activeStudent?.name ?? localUserName ?? "Student"}</strong><small>{operationLabel(operation)}</small></div></div>
        <div className="progress">{progress} of {questionCount} answered</div>
        <div className="round-actions"><button className="button secondary" onClick={pausePractice}>Ⅱ Pause</button><button className="button danger end-round" onClick={exitPractice}>End round early</button></div>
      </header>
      <div className="round-track" role="progressbar" aria-label="Questions answered" aria-valuemin={0} aria-valuemax={questionCount} aria-valuenow={progress}><span style={{ width: `${Math.min(100, progress / questionCount * 100)}%` }}/></div>
      <section className="practice-focus" aria-label="Current question">
        <p className="eyebrow">{questionReady ? "Say just the answer" : "Wait for the microphone"}</p>
        <div className={`fact ${questionReady ? "" : "fact-preparing"}`}>{questionReady ? <>{current.a} {operationSymbol(current.operation)} {current.b}</> : "Get ready…"}</div>
        <div className="practice-feedback" aria-live="polite" aria-atomic="true">
          <div className={`result ${result?.tone ?? ""}`}>{result?.text ?? (questionReady ? "Say your answer aloud" : "Opening the microphone…")}</div>
          {result?.correctAnswer !== undefined && <div className="answer-reveal">{current.a} {operationSymbol(operation)} {current.b} = {result.correctAnswer}</div>}
          {pendingWrong && <><p>Heard: <strong>{pendingWrong.transcript || "No answer"}</strong></p><button className="text-button" onClick={allowPendingAnswer}>That’s not what I said</button><small>Next question automatically in a moment.</small></>}
          {!result && recognitionFailed && <div className="recovery-actions"><p className="muted">{listenState}</p><button className="button primary" onClick={restartRecognition}>Try microphone again</button><p className="fine-print">No answer was scored. An adult can troubleshoot in Family controls.</p></div>}
        </div>
      </section>
      <footer className="practice-controls"><div className="speech-controls"><span className={`mic ${listenState.startsWith("Listening") ? "listening" : ""}`} aria-hidden="true">◉</span><div className="speech-status"><div className="listen-state">{result ? listenState || "Answer recorded" : listenState}</div><small>Voice practice · questions advance automatically</small></div></div><div className="heard">{heard ? `Heard: ${heard}` : "Say your answer when Listening appears."}</div></footer>
      {paused && <PracticeDialog title="Your round is paused." onClose={resumePractice}><p>{progress} answers recorded. Nothing is timed while you take a break.</p><p className="muted">An unanswered question becomes retry practice, with no speed or mastery credit.</p><div className="form-row"><button className="button primary" onClick={resumePractice}>Resume practice</button><button className="button danger" onClick={exitPractice}>End &amp; save round</button></div></PracticeDialog>}
    </main>;
  }

  if (cloudUser && studentsLoading) {
    return <AppFrame {...frameProps}>{comfortDialog}<div className="setup"><p className="muted">Loading students…</p></div></AppFrame>;
  }

  if (cloudUser && !activeStudent) {
    return <AppFrame {...frameProps}>{comfortDialog}<div className="setup"><h1>Add a student</h1><p className="muted">Create at least one student profile before starting practice.</p><button className="button primary" onClick={() => setView("students")}>Manage students</button></div></AppFrame>;
  }

  return <AppFrame {...frameProps}>{comfortDialog}
    {phase === "results" && currentSession ? (
      <div className="setup">
        {celebrating && <SessionCelebration choice={celebrating} onFinished={dismissCelebration} sound={preferences.celebrationSound} motion={preferences.motion} />}
        <p className="eyebrow">Practice counts</p><h1>Nice work showing up.</h1>
        {sessionNotice && <p className="notice">{sessionNotice}</p>}
        <p className="muted">Your round is saved. Every practice is a step forward.</p>
        <div className="stats">
          <Stat label="Correct answers" value={`${practiceMetrics(currentSession.attempts).correct} / ${practiceMetrics(currentSession.attempts).scored.length}`} />
          <Stat label="Questions" value={String(currentSession.attempts.length)} />
          <Stat label="Spoken response average" value={practiceMetrics(currentSession.attempts).averageMs === null ? "—" : `${(practiceMetrics(currentSession.attempts).averageMs! / 1000).toFixed(2)}s`} />
        </div>
        <div className="form-row">
          <button className="button primary" onClick={() => startPractice()} disabled={!speechSupported || numberSpeechStatus === "loading" || selectedCount === 0 || !progressReady} title="Practice again with the same student, operation, selected facts, and question count">Repeat this round →</button>
          <button className="button secondary" onClick={() => setPhase("setup")}>Choose other facts</button>
          <button className="button secondary" onClick={() => setView("history")}>View history</button>
        </div><p className="fine-print">Retries, disputed recognition, and uncertain timing do not earn speed or mastery credit.</p><details className="result-detail-panel"><summary>See every answer</summary><SessionHistory sessions={[currentSession]} initiallyExpanded/></details>
      </div>
    ) : (
      <div className="setup">
        <header className="practice-heading">
          <p className="eyebrow">A little practice, every day</p>
          <h1>Ready for a quick round{activeStudent?.name || localUserName ? `, ${activeStudent?.name ?? localUserName}` : ""}?</h1>
          <p className="muted">Choose your facts, then speak each answer aloud.</p>
        </header>
        {!speechSupported && <p className="notice">This app requires speech recognition. Use the latest Chrome or Edge on a laptop or desktop, then allow microphone access.</p>}

        {syncMessage && <p className="notice" role="status">{syncMessage}{!progressReady && <button className="button secondary" onClick={() => window.location.reload()}>Retry loading progress</button>}</p>}
        {cloudUser && !student && <label className="owner-student-select">Student<select value={selectedStudentId} onChange={event => selectStudent(event.target.value)}>{cloudStudents.map(value => <option key={value.id} value={value.id}>{value.name}{isAdmin && value.ownerEmail ? ` — ${value.ownerEmail}` : ""}</option>)}</select></label>}
        <div className="operation-tabs" aria-label="Operation">{(["add", "sub", "mul"] as Operation[]).map(op => <button key={op} aria-pressed={operation === op} onClick={() => setOperation(op)}><span>{operationSymbol(op)}</span>{operationLabel(op)}</button>)}</div>
        {automaticity?.session && automaticity.session.status !== "ended" && <p className="notice">An unfinished round has {automaticity.session.gradedCount} completed answers. Resume keeps its original facts and question count. <button className="button secondary" onClick={() => finishSession("Unfinished round saved.")}>End saved round</button></p>}
        <section className="practice-builder">
          <div className="round-plan"><p className="eyebrow">Your next round</p><h2>{operationLabel(operation)}</h2><p className="muted">Build quick recall.<br/>Choose any facts, any time.</p>
            <label>Round length<select value={questionCount} onChange={event => setQuestionCount(Number(event.target.value))}>{QUESTION_COUNT_OPTIONS.map(count => <option key={count} value={count}>{count} questions</option>)}</select></label>
            <div className="voice-plan"><strong>◉ Speak your answers</strong><p>Questions move on automatically.<br/>Goal: start your answer within 1.50s.</p></div>
            <button className="button primary start-round" onClick={() => startPractice()} disabled={!speechSupported || numberSpeechStatus === "loading" || selectedCount === 0 || !progressReady}>{numberSpeechStatus === "loading" ? "Preparing voice…" : automaticity?.session && automaticity.session.status !== "ended" ? "Resume round" : "Start practice →"}</button>
            <p className="fine-print">{selectedCount ? `${selectedCount} facts selected · practice as much as you like` : "Choose at least one fact to begin."}</p>
            {numberSpeechStatus === "failed" && <p className="notice">Number recognition could not load. <button className="text-button" onClick={() => void enableNumberSpeech()}>Try again</button></p>}
          </div>
          <FactGrid operation={operation} selected={selectedFacts[operation]} onChange={next => setSelectedFacts(current => ({ ...current, [operation]: next }))}/>
        </section>
        <div className="subject-progress"><MasteryProgress score={subjectSummary?.score ?? 0} subject={operationLabel(operation)} studentName={activeStudent?.name ?? localUserName ?? "Student"} factCount={allCards.length} assessedCount={subjectSummary?.assessed ?? 0}/><button className="text-button" onClick={() => setView("progress")}>See my progress →</button></div>
        <p className="fine-print">{subjectSummary?.verified ?? 0} of {allCards.length} facts mastered through later spaced checks. Progress covers every fact in {operationLabel(operation).toLowerCase()}.</p>
      </div>
    )}
  </AppFrame>;
}

function AppFrame({ children, view, onNavigate, onExit, isAdmin = false, accountName, avatarStudentId, onPreferences }: { children: React.ReactNode; view: View; onNavigate: (view: View) => void; onExit: () => void; isAdmin?: boolean; accountName?: string; avatarStudentId?: string; onPreferences?: () => void }) {
  const profileAccess = useContext(ProfileContext);
  async function signOut() {
    if (profileAccess.switchPerson) { profileAccess.switchPerson(); return; }
    const supabase = supabaseBrowser(); if (!supabase) return;
    await supabase.auth.signOut(); window.location.reload();
  }
  return <div className="app-shell redesign-shell">
    <a className="skip-link" href="#workspace">Skip to main content</a>
    <aside className="sidebar"><div className="sidebar-header"><div className="brand"><span className="brand-mark">÷</span><div>Auto<br/>Math Facts</div></div>
      <div className="sidebar-person">{avatarStudentId && <StudentAvatar studentId={avatarStudentId} name={accountName ?? "Student"} editable/>}{accountName && <CurrentUser name={accountName} role={profileAccess.student ? "My workspace" : isAdmin ? "Admin" : "Account owner"}/>}</div></div>
      <div className="sidebar-navigation"><nav className="nav" aria-label="Main navigation">
        <button aria-current={view === "practice" ? "page" : undefined} onClick={() => { onExit(); onNavigate("practice"); }}>✦ Practice</button>
        <button aria-current={view === "progress" ? "page" : undefined} onClick={() => onNavigate("progress")}>▥ My progress</button>
        <button aria-current={view === "history" ? "page" : undefined} onClick={() => onNavigate("history")}>◷ History</button>
        {!profileAccess.student && <button aria-current={view === "students" ? "page" : undefined} onClick={() => onNavigate("students")}>Family controls</button>}
        {isAdmin && hasSupabaseConfig() && <button aria-current={view === "users" ? "page" : undefined} onClick={() => onNavigate("users")}>Admin</button>}
      </nav>{profileAccess.switchPerson && <button className="text-button switch-user" onClick={() => void signOut()}>⇄ Switch User</button>}</div>
      <div className="account"><button className="text-button" onClick={onPreferences}>⚙ Make it comfortable</button><p>Small steps.<br/>Stronger recall.</p></div>
    </aside><main id="workspace" className="main">{children}</main>
  </div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="stat"><strong>{value}</strong><span className="muted">{label}</span></div>; }

function FactGrid({ operation, selected, onChange }: { operation: Operation; selected: Set<string>; onChange: (selected: Set<string>) => void }) {
  const cards = makeCards(operation);
  const rows = [...new Set(cards.map((card) => card.b))];
  const columns = [...new Set(cards.map((card) => card.a))];
  const keyFor = (row: number, column: number) => `${operation}-${column}-${row}`;
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
      : "Multiplication: 2 through 12";

  return <section className="fact-selector" aria-labelledby="fact-selector-title"><div className="fact-selector-heading"><div><h2 id="fact-selector-title">Choose facts</h2><p className="muted">{description}</p></div><div className="selection-actions"><button className="button secondary" onClick={() => onChange(new Set(allKeys))}>Select all</button><button className="button secondary" onClick={() => onChange(new Set())}>Clear all</button></div></div><div className="fact-grid-scroll"><div className="fact-grid" style={{ gridTemplateColumns: `38px repeat(${columns.length}, minmax(24px, 1fr))` }}><AxisToggle label="All" keys={allKeys} selected={selected} onToggle={toggleKeys} />{columns.map((column) => <AxisToggle key={`column-${column}`} label={String(column)} keys={rows.map((row) => keyFor(row, column)).filter((key) => validKeys.has(key))} selected={selected} onToggle={toggleKeys} />)}{rows.map((row) => <div className="fact-grid-row" key={`row-${row}`} style={{ gridColumn: `1 / span ${columns.length + 1}`, gridTemplateColumns: `38px repeat(${columns.length}, minmax(24px, 1fr))` }}><AxisToggle label={String(row)} keys={columns.map((column) => keyFor(row, column)).filter((key) => validKeys.has(key))} selected={selected} onToggle={toggleKeys} />{columns.map((column) => { const key = keyFor(row, column); return validKeys.has(key) ? <label className="fact-cell" key={key} title={`${column} ${operationWord(operation)} ${row}`}><input type="checkbox" checked={selected.has(key)} onChange={() => toggleKeys([key])} /><span className="sr-only">{column} {operationWord(operation)} {row}</span></label> : <span className="fact-cell unavailable" aria-hidden="true" key={key} />; })}</div>)}</div></div><p className="grid-help">Top numbers = first number. Left numbers = second number. Select a row or column to choose a group.</p></section>;
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

  return <div className="users-view"><div className="topbar"><div><h1>Admin</h1><p className="muted">Add learners, switch the active learner, review performance, and remove local accounts.</p></div></div><section className="user-toolbar"><h2>Add user</h2><form className="form-row" onSubmit={addUser}><label>Name<input type="text" required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="button primary">Add user</button></form>{message && <p className="notice">{message}</p>}</section><section><h2>Users</h2><div className="table-scroll"><table className="history-table"><thead><tr><th>User</th><th>Added</th><th>Sessions</th><th>Last practice</th><th>Actions</th></tr></thead><tbody>{userRecords.map(({ user, progress }) => <tr key={user.id}><td><strong>{user.name}</strong>{user.id === activeUserId && <span className="role-label">Active</span>}</td><td>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "Local profile"}</td><td>{progress.sessions.length}</td><td>{progress.sessions[0] ? new Date(progress.sessions[0].endedAt).toLocaleDateString() : "Never"}</td><td><div className="table-actions">{user.id !== activeUserId && <button className="button primary" onClick={() => onSelectUser(user.id)}>Use user</button>}<button className="button secondary" onClick={() => setSelectedUserId(user.id)}>View history</button>{pendingDeleteUserId === user.id ? <><button className="button secondary" onClick={() => setPendingDeleteUserId("")}>Cancel</button><button className="button danger" onClick={() => deleteUser(user)}>Confirm delete</button></> : <button className="button danger" disabled={users.length <= 1} onClick={() => setPendingDeleteUserId(user.id)}>Delete</button>}</div></td></tr>)}</tbody></table></div></section>{selectedRecord && <section className="user-history"><h2>{selectedRecord.user.name} history</h2><HistoryProgress key={selectedRecord.user.id} name={selectedRecord.user.name} sessions={selectedRecord.progress.sessions} progress={selectedRecord.progress.automaticity}><SessionHistory sessions={selectedRecord.progress.sessions} detailedDates /></HistoryProgress></section>}</div>;
}

function SessionHistory({ sessions, detailedDates = false, onDelete, initiallyExpanded = false }: { sessions: SavedSession[]; detailedDates?: boolean; onDelete?: (id: string) => Promise<void>; initiallyExpanded?: boolean }) {
  const [sessionSorts, setSessionSorts] = useState<Record<string, HistorySort>>({});
  const [expandedId, setExpandedId] = useState<string | null>(initiallyExpanded ? sessions[0]?.id ?? null : null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  async function deleteSession(id: string) {
    if (!onDelete || deletingId) return;
    setDeletingId(id);
    setDeleteError("");
    try { await onDelete(id); setConfirmId(null); }
    catch (error) { setDeleteError(error instanceof Error ? error.message : "Could not delete session."); }
    finally { setDeletingId(null); }
  }
  const historyId = useId();
  if (sessions.length === 0) return <p className="empty">No sessions yet.</p>;
  return <>
    <p className="muted">Select a session to see each question and response time.</p>
    {deleteError && <p className="notice" role="alert">{deleteError}</p>}
    <div className="table-scroll"><table className="history-table"><thead><tr><th>When</th><th>Operation</th><th>Questions</th><th>Accuracy</th><th>Average time</th><th>Details</th></tr></thead><tbody>{sessions.map((session) => {
      const metrics = practiceMetrics(session.attempts);
      const correct = metrics.correct, averageMs = metrics.averageMs;
      const expanded = expandedId === session.id;
      const detailsId = `${historyId}-${session.id}`;
      const sort = sessionSorts[session.id] ?? "question";
      const setSort = (value: HistorySort) => setSessionSorts((current) => ({ ...current, [session.id]: value }));
      const toggle = () => setExpandedId(expanded ? null : session.id);
      const date = detailedDates ? new Date(session.endedAt).toLocaleString() : new Date(session.endedAt).toLocaleDateString();
      return <Fragment key={session.id}>
        <tr className={`session-row ${expanded ? "expanded" : ""}`} onClick={toggle}>
          <td>{date}</td><td>{operationLabel(session.operation)}</td><td>{session.attempts.length}</td>
          <td>{metrics.scored.length ? `${Math.round((correct / metrics.scored.length) * 100)}%` : "-"}</td>
          <td>{averageMs !== null ? `${(averageMs / 1000).toFixed(2)}s` : "-"}</td>
          <td><div className="table-actions"><button className="button secondary" aria-expanded={expanded} aria-controls={detailsId} aria-label={`${expanded ? "Hide" : "View"} questions for ${operationLabel(session.operation)} on ${date}`} onClick={(event) => { event.stopPropagation(); toggle(); }}>{expanded ? "Hide questions" : "View questions"}</button>
            {onDelete && <button className="button danger" disabled={Boolean(deletingId)} aria-label={`Delete session from ${date}`} onClick={(event) => { event.stopPropagation(); setConfirmId(session.id); setDeleteError(""); }}>Delete</button>}
          </div></td>
        </tr>
        {confirmId === session.id && <tr><td colSpan={6}>
          <p>Delete this session and all its question results? This cannot be undone. Student mastery and review scheduling will stay unchanged.</p>
          <div className="table-actions">
            <button className="button secondary" disabled={Boolean(deletingId)} onClick={() => setConfirmId(null)}>Cancel</button>
            <button className="button danger" disabled={Boolean(deletingId)} onClick={() => void deleteSession(session.id)}>{deletingId === session.id ? "Deleting…" : "Confirm delete"}</button>
          </div>
        </td></tr>}
        {expanded && <tr><td colSpan={6} className="session-details"><section id={detailsId} aria-label={`Questions from ${date}`}>
          <h2>Question results</h2>
          {session.attempts.length > 0 && <p className="muted" aria-live="polite">{sort === "result" ? "Wrong answers first, then slow correct answers, then correct answers at or under 1.5 seconds. Each group is ordered slowest to fastest." : "In question order. Select Result to show wrong answers first, then slow answers, then correct answers."}</p>}
          {session.attempts.length === 0 ? <p className="muted">No question results were recorded.</p> : <table className="history-table attempt-table">
            <thead><tr><th scope="col" aria-sort={sort === "question" ? "ascending" : "none"}><button className="history-sort" onClick={() => setSort("question")} aria-label="Sort by question order"># {sort === "question" ? "↑" : "↕"}</button></th><th scope="col">Question</th><th scope="col">Answer heard</th><th scope="col">Response time</th><th scope="col" aria-sort={sort === "result" ? "other" : "none"}><button className="history-sort" onClick={() => setSort("result")}>Result {sort === "result" ? "↓" : "↕"}</button></th></tr></thead>
            <tbody>{sortHistoryAttempts(session.attempts, sort).map(({ attempt, questionNumber }) => <tr key={attempt.id}>
              <td>{questionNumber}</td><td>{attempt.fact}</td><td className="answer-heard">{attempt.heard?.trim() || "No answer recorded"}</td><td>{hasComparableTime(attempt) ? `${(attempt.responseMs / 1000).toFixed(2)}s` : attempt.audit?.retry ? "Retry · untimed" : "—"}</td>
              <td><span className={`attempt-result ${historyResult(attempt)}`}>{attempt.audit?.disputed ? "Recognition disputed" : !hasComparableTime(attempt) ? attempt.answerCorrect ? "Correct · unverified speed" : "Wrong" : historyResult(attempt) === "slow" ? "Slow (correct)" : attempt.answerCorrect ? "Correct" : "Wrong"}</span></td>
            </tr>)}</tbody>
          </table>}
        </section></td></tr>}
      </Fragment>;
    })}</tbody></table></div>
  </>;
}
async function accountRequest(path: string, init: RequestInit = {}) {
  return accessRequest(path, init);
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
  })}</tbody></table></div>}</section>{selectedUser && <section className="user-history"><h2>{selectedUser.displayName || selectedUser.email} students</h2><form className="form-row" onSubmit={addStudent}><label>Student name<input type="text" required maxLength={60} value={studentName} onChange={(event) => setStudentName(event.target.value)} /></label><button className="button primary">Add student</button></form>{selectedUser.students.length === 0 ? <p className="empty">No students yet.</p> : <div className="table-scroll"><table className="history-table"><thead><tr><th>Student</th><th>Added</th><th>Sessions</th><th>Actions</th></tr></thead><tbody>{selectedUser.students.map((student) => <tr key={student.id}><td><strong>{student.name}</strong></td><td>{new Date(student.createdAt).toLocaleDateString()}</td><td>{student.sessions.length}</td><td><div className="table-actions"><button className="button secondary" onClick={() => setSelectedStudentId(student.id)}>View history</button><button className="button danger" onClick={() => void deleteStudent(student)}>Delete student</button></div></td></tr>)}</tbody></table></div>}{selectedStudent && <div className="user-history"><h2>{selectedStudent.name} history</h2><HistoryProgress key={selectedStudent.id} name={selectedStudent.name} sessions={selectedStudent.sessions} progress={selectedStudent.reportProgress}><AdminSessionHistory sessions={selectedStudent.sessions} /></HistoryProgress></div>}</section>}</div>;
}

function AdminSessionHistory({ sessions }: { sessions: AdminSessionSummary[] }) {
  return <SessionHistory sessions={sessions} detailedDates />;
}
