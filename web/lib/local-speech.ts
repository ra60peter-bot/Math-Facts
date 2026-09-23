export type LocalSpeechSupport = {
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[] }) => Promise<boolean>;
};

export type LocalSpeechStatus = "checking" | "downloading" | "ready" | "unsupported" | "failed";

// The browser owns and caches the language pack. Never assume a previous
// visit's installation is still present: check on every app load.
export async function prepareLocalSpeech(
  recognition: LocalSpeechSupport | undefined,
  report: (status: LocalSpeechStatus) => void,
): Promise<boolean> {
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
    const installed = await recognition.install({ langs: options.langs });
    const ready = installed && await recognition.available(options) === "available";
    report(ready ? "ready" : "failed");
    return ready;
  } catch {
    report("failed");
    return false;
  }
}
