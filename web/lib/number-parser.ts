const ones: Record<number, string> = {
  0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
  10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen", 16: "sixteen",
  17: "seventeen", 18: "eighteen", 19: "nineteen",
};
const tensWords: Record<number, string> = { 2: "twenty", 3: "thirty", 4: "forty", 5: "fifty", 6: "sixty", 7: "seventy", 8: "eighty", 9: "ninety" };

export const VALID_ANSWERS = new Set<number>();
for (let a = 0; a <= 9; a += 1) for (let b = 0; b <= 9; b += 1) VALID_ANSWERS.add(a + b);
for (let a = 2; a <= 15; a += 1) for (let b = 2; b <= 15; b += 1) VALID_ANSWERS.add(a * b);

function underHundredToWords(value: number) {
  if (value <= 19) return ones[value];
  const tens = Math.floor(value / 10);
  const units = value % 10;
  return units === 0 ? tensWords[tens] : `${tensWords[tens]} ${ones[units]}`;
}

export function numberToPhrases(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 225) return [];
  if (value < 100) {
    return value === 0 ? [underHundredToWords(value), "oh"] : [underHundredToWords(value)];
  }

  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  const prefix = `${ones[hundreds]} hundred`;
  const prefixes = hundreds === 1 ? [prefix, "hundred", "a hundred"] : [prefix];
  const phrases = remainder === 0 ? [...prefixes] : prefixes.flatMap((hundred) => [
    `${hundred} ${underHundredToWords(remainder)}`, `${hundred} and ${underHundredToWords(remainder)}`,
  ]);
  if (remainder > 0) {
    if (remainder < 10) phrases.push(`${ones[hundreds]} oh ${ones[remainder]}`, `${ones[hundreds]} o ${ones[remainder]}`);
    else phrases.push(`${ones[hundreds]} ${underHundredToWords(remainder)}`);
  }
  // Three-digit readings: one three two, one one two, one two one, etc.
  phrases.push(String(value).split("").map((digit) => ones[Number(digit)]).join(" "));
  return phrases.filter((phrase, index) => phrases.indexOf(phrase) === index);
}

const phraseToNumber: Record<string, number> = {};
// Wrong answers are still answers: accept all numbers in the supported range,
// not just products that appear in the fact grid.
for (let answer = 0; answer <= 225; answer += 1) for (const phrase of numberToPhrases(answer)) phraseToNumber[phrase] = answer;
Object.assign(phraseToNumber, {
  won: 1, to: 2, too: 2,
  twelfth: 12, twelth: 12, free: 3, tree: 3, fife: 5, for: 4, fore: 4, fourth: 4,
  ate: 8, age: 8, nein: 9, mine: 9, tin: 10, fourty: 40,
});

export function normalizeSpokenPhrase(transcript: string) {
  return transcript.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

export function parseSpokenNumber(transcript: string, mappings: Record<string, number> = {}): number | null {
  const spoken = normalizeSpokenPhrase(transcript);
  if (!spoken) return null;

  if (/^\d+$/.test(spoken)) {
    const value = Number(spoken);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (spoken in mappings) return mappings[spoken];
  if (spoken in phraseToNumber) return phraseToNumber[spoken];

  const cleaned = spoken.split(/\s+/).filter((word) => !["unk", "uh", "um", "the"].includes(word)).join(" ");
  // Browsers can return digits with a filler ("um 40"), not just words.
  if (/^\d+$/.test(cleaned)) {
    const value = Number(cleaned);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (cleaned in mappings) return mappings[cleaned];
  if (cleaned in phraseToNumber) return phraseToNumber[cleaned];

  // Speech services mix digits and words ("one 32", "1 thirty two",
  // "one hundred and 32"). Expand numeric tokens before the same strict
  // phrase lookup; never extract the expected answer from arbitrary speech.
  const expanded = cleaned.replace(/\b\d+\b/g, (digits) => numberToPhrases(Number(digits))[0] ?? digits);
  if (expanded !== cleaned) return parseSpokenNumber(expanded, mappings);

  // Strip a complete answer introduction before parsing its number. This
  // also applies existing aliases ("for", "ate") to phrase endings.
  const answerPhrase = cleaned.match(/^(?:(?:my |your |the )?answer(?: is)?|it is|it s|that is|that s)\s+(.+)$/);
  if (answerPhrase) {
    return parseSpokenNumber(answerPhrase[1], mappings);
  }

  const withoutAnd = cleaned.replace(/\band\b\s*/g, "").trim();
  if (withoutAnd in phraseToNumber) return phraseToNumber[withoutAnd];

  // Repeating a short answer ("two two", "ten, ten") must not add it
  // together. Only accept an exact repetition; conflicting numbers are ambiguous.
  const words = cleaned.split(" ");
  for (let size = 1; size <= words.length / 2; size += 1) {
    if (words.length % size !== 0) continue;
    const phrase = words.slice(0, size).join(" ");
    if (!words.every((word, index) => word === words[index % size])) continue;
    const value = parseSpokenNumber(phrase, mappings);
    if (value !== null) return value;
  }
  return null;
}
