// Safari needs a stable microphone/audio session across questions. Keep this
// workaround out of Chromium (including Chrome/Edge on Apple devices).
export function isSafariBrowser(): boolean {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent ?? "";
  return /AppleWebKit/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua)
    && !/Chrome|Chromium|CriOS|Edg|OPR|OPiOS|FxiOS|Android/.test(ua);
}

type SafariAudio = { context: AudioContext; stream: MediaStream };
type Session = { context: AudioContext; stream: MediaStream | null; disposed: boolean; ready: Promise<SafariAudio> };
let session: Session | null = null;

function dispose(current: Session) {
  if (current.disposed) return;
  current.disposed = true;
  current.stream?.getTracks().forEach(track => track.stop());
  if (current.context.state !== "closed") void current.context.close().catch(() => {});
  if (session === current) {
    session = null;
    window.removeEventListener("pagehide", releaseSafariNumberAudio);
  }
}

export function releaseSafariNumberAudio() {
  if (session) dispose(session);
}

export function acquireSafariNumberAudio(): Promise<SafariAudio> {
  if (!isSafariBrowser()) return Promise.reject(new Error("Safari audio is Safari-only"));
  if (session && (session.context.state === "closed" || session.stream?.getTracks().some(track => track.readyState === "ended"))) {
    dispose(session);
  }
  if (session) {
    const current = session;
    return current.ready.then(async audio => {
      if (current.disposed) throw new DOMException("Capture cancelled", "AbortError");
      if (audio.context.state !== "running") await audio.context.resume();
      if (current.disposed) throw new DOMException("Capture cancelled", "AbortError");
      return audio;
    });
  }

  // Use Safari's native hardware sample rate. Vosk resamples the PCM internally.
  // Creating/resuming here lets Start/Repeat/Mic unlock audio in the click event.
  const context = new AudioContext();
  const current: Session = { context, stream: null, disposed: false, ready: Promise.resolve(null as never) };
  session = current;
  window.addEventListener("pagehide", releaseSafariNumberAudio);
  const resume = context.resume().catch(() => {});
  current.ready = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
      if (current.disposed) {
        stream.getTracks().forEach(track => track.stop());
        throw new DOMException("Capture cancelled", "AbortError");
      }
      current.stream = stream;
      await context.audioWorklet.addModule("/number-capture.worklet.js");
      await resume;
      if (current.disposed) throw new DOMException("Capture cancelled", "AbortError");
      if (context.state !== "running") await context.resume();
      if (current.disposed) throw new DOMException("Capture cancelled", "AbortError");
      return { context, stream };
    } catch (error) {
      dispose(current);
      throw error;
    }
  })();
  return current.ready;
}

export function prepareSafariNumberAudio() {
  if (isSafariBrowser()) {
    // The recognition startup watchdog displays failures; priming cannot create
    // an unhandled rejection while a permission prompt is open.
    try { void acquireSafariNumberAudio().catch(() => {}); } catch { /* Reported by recognition startup. */ }
  }
}
