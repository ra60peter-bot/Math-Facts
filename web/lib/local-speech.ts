export type LocalSpeechSupport = {
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
};

export type LocalSpeechStatus = "checking" | "downloading" | "ready" | "unsupported" | "failed";

// The browser owns and caches the language pack. Never assume a previous
// visit's installation is still present: check on every app load.
export async function prepareLocalSpeech(
  recognition: LocalSpeechSupport | undefined,
  report: (status: LocalSpeechStatus) => void,
  reportError: (message: string) => void = () => {},
): Promise<boolean> {
  reportError("");
  if (!recognition?.available || !recognition.install) {
    report("unsupported");
    return false;
  }
  try {
    report("checking");
    const options = { langs: ["en-US"], processLocally: true };
    const status = await recognition.available(options);
    if (status === "available") { report("ready"); return true; }
    if (status !== "downloadable" && status !== "downloading") {
      report("unsupported"); return false;
    }
    report("downloading");
    const installed = await recognition.install(options);
    const ready = installed && await recognition.available(options) === "available";
    if (!ready) reportError("The browser did not finish installing the English speech pack. Try again while connected to the internet.");
    report(ready ? "ready" : "failed");
    return ready;
  } catch (error) {
    const detail = error && typeof error === "object" && "message" in error ? String(error.message) : "No error details were provided.";
    reportError(`Browser reported: ${detail}`);
    report("failed");
    return false;
  }
}
