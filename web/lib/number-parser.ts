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

function numberToPhrases(value: number) {
  if (value < 0 || value > 225) return [];
  if (value < 100) {
    return value === 0 ? [underHundredToWords(value), "oh"] : [underHundredToWords(value)];
  }

  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  const prefix = `${ones[hundreds]} hundred`;
  if (remainder === 0) return hundreds === 1 ? [prefix, "hundred"] : [prefix];

  const remainderWords = underHundredToWords(remainder);
  const phrases = [`${prefix} ${remainderWords}`];
  if (hundreds === 1) {
    phrases.push(`hundred ${remainderWords}`);
    if (remainder < 10) phrases.push(`one oh ${remainderWords}`, `one o ${remainderWords}`);
    else phrases.push(`one ${remainderWords}`);
  }
  return phrases;
}

const phraseToNumber: Record<string, number> = {};
for (const answer of VALID_ANSWERS) for (const phrase of numberToPhrases(answer)) phraseToNumber[phrase] = answer;
Object.assign(phraseToNumber, {
  twelfth: 12, twelth: 12, free: 3, tree: 3, fife: 5, for: 4, fore: 4, fourth: 4,
  ate: 8, age: 8, nein: 9, mine: 9, tin: 10,
});

const wordToNumber: Record<string, number> = Object.fromEntries(Object.entries(ones).map(([value, word]) => [word, Number(value)]));
wordToNumber.oh = 0;
wordToNumber.o = 0;
for (const [value, word] of Object.entries(tensWords)) wordToNumber[word] = Number(value) * 10;
wordToNumber.hundred = 100;

export function normalizeSpokenPhrase(transcript: string) {
  return transcript.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

export function parseSpokenNumber(transcript: string, mappings: Record<string, number> = {}) {
  const spoken = normalizeSpokenPhrase(transcript);
  if (!spoken) return null;

  if (/^\d+$/.test(spoken)) {
    const value = Number(spoken);
    return VALID_ANSWERS.has(value) ? value : null;
  }
  if (spoken in mappings) return mappings[spoken];
  if (spoken in phraseToNumber) return phraseToNumber[spoken];

  const cleaned = spoken.split(/\s+/).filter((word) => !["unk", "uh", "um", "the"].includes(word)).join(" ");
  if (cleaned in mappings) return mappings[cleaned];
  if (cleaned in phraseToNumber) return phraseToNumber[cleaned];

  const tokens = cleaned.split(/\s+/).filter((word) => word in wordToNumber);
  if (tokens.length === 0) return null;
  let result = 0;
  let current = 0;
  for (const token of tokens) {
    const value = wordToNumber[token];
    if (value === 100) {
      current = Math.max(current, 1) * 100;
      result += current;
      current = 0;
    } else {
      current += value;
    }
  }
  result += current;
  return VALID_ANSWERS.has(result) ? result : null;
}
