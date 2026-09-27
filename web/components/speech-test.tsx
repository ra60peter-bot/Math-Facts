"use client";

import { useEffect, useRef, useState } from "react";
import type { BrowserSpeechRecognition } from "../lib/browser-speech";
import { addNumberHints, readNumberResult } from "../lib/speech-results";
import { parseSpokenNumber } from "../lib/number-parser";

export function SpeechTest({ local }: { local: boolean }) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Test a few short answers before practicing.");
  const [report, setReport] = useState<string[]>([]);
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => () => stopRef.current(), []);

  const start = () => {
    stopRef.current();
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
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
    let drain: number | undefined;
    const began = performance.now();
    setReport([`Speech test v2 · ${local ? "on-device" : "browser"} · number hints: ${hints}`, navigator.userAgent]);
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
      setStatus("Test finished. See the browser's exact words below.");
    };
    // Component unmount (including starting practice) releases the mic without
    // writing any progress or leaving a second recognizer running.
    stopRef.current = cleanup;
    recognition.onstart = () => log("Recognition started");
    recognition.onaudiostart = () => {
      log("Audio capture started");
      setStatus("Listening for 15 seconds. Say: two … four … six … eight … ten … forty.");
    };
    recognition.onsoundstart = () => log("Sound detected");
    recognition.onspeechstart = () => log("Speech detected");
    recognition.onspeechend = () => log("Speech boundary (still listening)");
    recognition.onresult = (event) => {
      if (!active) return;
      const selected = readNumberResult(event.results);
      log(`Combined: ${JSON.stringify(selected.transcript)} → ${selected.value ?? "no number"}`);
      for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        for (let j = 0; j < result.length; j += 1) {
          const alternative = result[j];
          log(`Segment ${i + 1} ${result.isFinal ? "final" : "interim"}, choice ${j + 1}: ${JSON.stringify(alternative.transcript)} → ${parseSpokenNumber(alternative.transcript) ?? "no number"}`);
        }
      }
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
    const timer = window.setTimeout(() => {
      log("Stopping capture to collect final words");
      drain = window.setTimeout(finish, 3000);
      try { recognition.stop(); } catch { finish(); }
    }, 15000);
    try { recognition.start(); } catch { log("Could not start recognition"); finish(); }
  };

  return <details className="speech-test" onToggle={(event) => {
    if (!event.currentTarget.open) { stopRef.current(); setRunning(false); }
  }}>
    <summary>Test speech recognition</summary>
    <p>This test shows the browser’s exact words and the number the app understands. It does not save scores or audio.</p>
    <p role="status">{status}</p>
    <div className="form-row">
      <button type="button" className="button secondary" disabled={running} onClick={start}>Start speech test</button>
      {running && <button type="button" className="button secondary" onClick={() => { stopRef.current(); setRunning(false); setStatus("Test stopped."); }}>Stop test</button>}
    </div>
    {report.length > 0 && <label>Recognition details — copy these if a number is missing
      <textarea readOnly rows={10} value={report.join("\n")} aria-label="Speech recognition report" />
    </label>}
  </details>;
}
