import { parseSpokenNumber } from "./number-parser";

export type SpeechResult = {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string; confidence?: number };
};
export type SpeechResults = { length: number; [index: number]: SpeechResult };

// The result list is cumulative: "the answer is" and "two" may be two
// separate segments, each with its own alternatives. Do not inspect just [0].
export function readNumberResult(results: SpeechResults, mappings: Record<string, number> = {}) {
  const parts = Array.from({ length: results.length }, (_, index) => results[index][0]?.transcript ?? "");
  const primary = parts.join(" ").trim();
  const parsed = parseSpokenNumber(primary, mappings);
  if (parsed !== null) return { transcript: primary, value: parsed };
  for (let segment = 0; segment < results.length; segment += 1) {
    for (let alternative = 1; alternative < results[segment].length; alternative += 1) {
      const candidate = [...parts];
      candidate[segment] = results[segment][alternative]?.transcript ?? "";
      const transcript = candidate.join(" ").trim();
      const value = parseSpokenNumber(transcript, mappings);
      if (value !== null) return { transcript, value };
    }
  }
  return { transcript: primary, value: null };
}

export type SpeechPhrase = { phrase: string; boost: number };
type PhraseConstructor = new (phrase: string, boost: number) => SpeechPhrase;

// Hint the vocabulary, never the expected answer. Browser service engines
// may reject hints, so apply these only to the native on-device recognizer.
export function addNumberHints(recognition: { processLocally?: boolean; phrases?: SpeechPhrase[] }, Phrase?: PhraseConstructor) {
  if (!recognition.processLocally || !("phrases" in recognition) || !Phrase) return false;
  try {
    const words = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred".split(" ");
    recognition.phrases = words.map((word) => new Phrase(word, 3));
    return true;
  } catch {
    return false;
  }
}
