"use client";

import { useEffect, useRef, useState } from "react";
import type { BrowserSpeechRecognition } from "../lib/browser-speech";
import { SPEECH_RESULT_GRACE_MS } from "../lib/browser-speech";
import { TIMEOUT_MS } from "../lib/learning";
import { addNumberHints, readNumberResult } from "../lib/speech-results";
import { parseSpokenNumber } from "../lib/number-parser";
import { NumberSpeechRecognition } from "../lib/number-speech";

export function SpeechTest({ local, numbers = false }: { local: boolean; numbers?: boolean }) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Choose one number, then start the test.");
  const [word, setWord] = useState("two");
  const [heard, setHeard] = useState("");
  const [report, setReport] = useState<string[]>([]);
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => () => stopRef.current(), []);

  const start = () => {
    stopRef.current();
    const Recognition = numbers ? NumberSpeechRecognition : window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) { setStatus("Speech recognition is unavailable in this browser."); return; }
    const recognition: BrowserSpeechRecognition = new Recognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    if (local) recognition.processLocally = true;
    let hints = addNumberHints(recognition, window.SpeechRecognitionPhrase);
    let retry = false;
    let active = true;
    let ready = false;
    let timer: number | undefined;
    let drain: number | undefined;
    const began = performance.now();
    setHeard("");
    setReport([`Speech test v4 · one answer · ${numbers ? "number engine (Vosk)" : local ? "on-device" : "browser"} · number hints: ${numbers ? "number vocabulary" : hints}`, navigator.userAgent]);
    const log = (message: string) => {
      if (active) setReport((lines) => [...lines.slice(-119), `${((performance.now() - began) / 1000).toFixed(3)}s ${message}`]);
    };
    const cleanup = () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(drain);
      recognition.onend = recognition.onstart = recognition.onaudiostart = recognition.onsoundstart = null;
      recognition.onspeechstart = recognition.onspeechend = null;
      recognition.onresult = recognition.onerror = null;
      recognition.abort();
    };
    const finish = () => {
      if (!active) return;
      log("Test ended");
      cleanup();
      setRunning(false);
      setStatus("Test finished. You can test another number.");
    };
    const stopCapture = () => {
      log("Four-second deadline: stop audio capture; wait for buffered transcript");
      setStatus("Finishing recognition…");
      drain = window.setTimeout(finish, SPEECH_RESULT_GRACE_MS);
      try { recognition.stop(); } catch { finish(); }
    };
    // Component unmount (including starting practice) releases the mic without
    // writing any progress or leaving a second recognizer running.
    stopRef.current = cleanup;
    recognition.onstart = () => log("Recognition started");
    recognition.onaudiostart = () => {
      if (ready) return;
      ready = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(stopCapture, TIMEOUT_MS);
      log("Audio capture started; four-second answer window started");
      setStatus(`Say “${word}” now. Say only this one number.`);
    };
    recognition.onsoundstart = () => log("Sound detected");
    recognition.onspeechstart = () => log("Speech detected");
    recognition.onspeechend = () => log("Speech boundary (still listening)");
    recognition.onresult = (event) => {
      if (!active) return;
      const selected = readNumberResult(event.results);
      setHeard(`Heard: “${selected.transcript}” → ${selected.value ?? "not a single number"}`);
      log(`Combined: ${JSON.stringify(selected.transcript)} → ${selected.value ?? "not a single number"}`);
      if (event.speechStartedAt !== undefined) log(`Spoken-word onset: ${((event.speechStartedAt - began) / 1000).toFixed(3)}s after test start (not transcript delivery time)`);
      for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        for (let j = 0; j < result.length; j += 1) {
          const alternative = result[j];
          log(`Segment ${i + 1} ${result.isFinal ? "final" : "interim"}, choice ${j + 1}: ${JSON.stringify(alternative.transcript)} → ${parseSpokenNumber(alternative.transcript) ?? "no number"}`);
        }
      }
      if (selected.value !== null && event.results[event.results.length - 1]?.isFinal) finish();
    };
    recognition.onerror = (event) => {
      log(`Recognition error: ${event.error}`);
      if (event.error === "phrases-not-supported" && hints) {
        recognition.phrases = [];
        hints = false;
        retry = true;
        log("Retrying without unsupported number hints");
      } else if (event.error !== "no-speech") finish();
    };
    recognition.onend = () => {
      log("Recognition ended");
      if (retry && active) {
        retry = false;
        try { recognition.start(); } catch { finish(); }
      } else finish();
    };
    setRunning(true);
    setStatus("Opening microphone…");
    timer = window.setTimeout(() => { log("Audio capture did not start"); finish(); }, TIMEOUT_MS);
    try { recognition.start(); } catch { log("Could not start recognition"); finish(); }
  };

  return <details className="speech-test" onToggle={(event) => {
    if (!event.currentTarget.open) { stopRef.current(); setRunning(false); }
  }}>
    <summary>Test speech recognition</summary>
    <p>Test one answer at a time, with the same four-second answering window as practice. Wait for “Say” before speaking. This does not save scores or audio.</p>
    <p role="status">{status}</p>
    {heard && <p>{heard}</p>}
    <div className="form-row">
      <label>Number to test<select value={word} disabled={running} onChange={(event) => setWord(event.target.value)}>
        {["two", "four", "six", "eight", "ten", "forty"].map((number) => <option key={number}>{number}</option>)}
      </select></label>
      <button type="button" className="button secondary" disabled={running} onClick={start}>Start speech test</button>
      {running && <button type="button" className="button secondary" onClick={() => { stopRef.current(); setRunning(false); setStatus("Test stopped."); }}>Stop test</button>}
    </div>
    {report.length > 0 && <label>Recognition details — copy these if a number is missing
      <textarea readOnly rows={10} value={report.join("\n")} aria-label="Speech recognition report" />
    </label>}
  </details>;
}
