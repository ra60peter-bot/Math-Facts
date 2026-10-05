export const MICROPHONE_CONFIRMED_KEY = "math-facts-microphone-confirmed-v1";
export const PREFERENCES_KEY = "math-facts-comfort-v1";
export const defaultPreferences = { showTimes: true, successSound: false, celebrationSound: true, motion: true };
export type PracticePreferences = typeof defaultPreferences;

export function microphoneConfirmed() {
  try { return localStorage.getItem(MICROPHONE_CONFIRMED_KEY) === "true"; } catch { return false; }
}
export function confirmMicrophone() {
  try { localStorage.setItem(MICROPHONE_CONFIRMED_KEY, "true"); return true; } catch { return false; }
}
export function readPreferences(): PracticePreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "{}");
    return Object.fromEntries(Object.entries(defaultPreferences).map(([key, value]) => [key, typeof saved[key] === "boolean" ? saved[key] : value])) as PracticePreferences;
  } catch { return defaultPreferences; }
}
