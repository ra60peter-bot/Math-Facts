const units: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5,
  six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

export function normalizeSpokenPhrase(transcript: string) {
  return transcript.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

export function parseSpokenNumber(transcript: string, mappings: Record<string, number> = {}) {
  const cleaned = normalizeSpokenPhrase(transcript);
  if (cleaned in mappings) return mappings[cleaned];
  if (/^\d{1,3}$/.test(cleaned)) return Number(cleaned);
  const words = cleaned.replace(/-/g, " ").split(/\s+/).filter(Boolean);
  let total = 0;
  let seen = false;
  for (const word of words) {
    if (word === "and") continue;
    if (word in units) { total += units[word]; seen = true; continue; }
    if (word in tens) { total += tens[word]; seen = true; continue; }
    if (word === "hundred" && seen) { total *= 100; continue; }
    return null;
  }
  return seen ? total : null;
}
