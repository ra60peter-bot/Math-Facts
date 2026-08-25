"""Speech recognition for math fact practice — Vosk only.

Key features:
  - Prefers small Vosk model for fast loading
  - Grammar locked to valid math answers (phrase-level matching)
  - Common child pronunciation variants in grammar
  - Energy-based voice onset detection for accurate timing
"""

import json
import os
import threading
import queue
import time
import struct

from app_paths import resource_path, seed_user_file

# ═══════════════════════════════════════════════════════════════════════
#  Valid answer set
# ═══════════════════════════════════════════════════════════════════════

def _compute_valid_answers():
    answers = set()
    for a in range(0, 10):
        for b in range(0, 10):
            answers.add(a + b)
    for a in range(2, 13):
        for b in range(2, 13):
            answers.add(a * b)
    return sorted(answers)

VALID_ANSWERS = frozenset(_compute_valid_answers())

# ═══════════════════════════════════════════════════════════════════════
#  Number ↔ word conversion
# ═══════════════════════════════════════════════════════════════════════

_ONES = {
    0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
    6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
    11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen",
    15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen",
    19: "nineteen",
}
_TENS = {
    2: "twenty", 3: "thirty", 4: "forty", 5: "fifty",
    6: "sixty", 7: "seventy", 8: "eighty", 9: "ninety",
}

def number_to_phrases(n):
    if n < 0 or n > 200:
        return []
    phrases = []
    if n <= 19:
        phrases.append(_ONES[n])
        if n == 0:
            phrases.append("oh")
    elif n < 100:
        tens, ones = divmod(n, 10)
        if ones == 0:
            phrases.append(_TENS[tens])
        else:
            phrases.append(f"{_TENS[tens]} {_ONES[ones]}")
    elif n == 100:
        phrases.append("one hundred")
        phrases.append("hundred")
    else:
        remainder = n - 100
        if remainder <= 19:
            rem_word = _ONES[remainder]
        else:
            tens, ones = divmod(remainder, 10)
            rem_word = _TENS[tens] if ones == 0 else f"{_TENS[tens]} {_ONES[ones]}"
        phrases.append(f"one hundred {rem_word}")
        phrases.append(f"hundred {rem_word}")
        if remainder < 10:
            phrases.append(f"one oh {rem_word}")
            phrases.append(f"one o {rem_word}")  # "one o eight" variant
        else:
            phrases.append(f"one {rem_word}")
    return phrases

def number_to_word(n):
    """Single canonical spoken form for display (e.g. voice training prompt)."""
    phrases = number_to_phrases(n)
    return phrases[0] if phrases else str(n)

# Standard phrase → number mapping
PHRASE_TO_NUM = {}
for _n in VALID_ANSWERS:
    for _p in number_to_phrases(_n):
        PHRASE_TO_NUM[_p] = _n

# Common child pronunciation variants that Vosk may output
CHILD_VARIANTS = {
    "twelfth": 12, "twelth": 12,
    "free": 3, "tree": 3,
    "fife": 5,
    "for": 4, "fore": 4, "fourth": 4,
    "ate": 8, "age": 8,
    "nein": 9, "mine": 9,
    "tin": 10,
}
for _v, _num in CHILD_VARIANTS.items():
    if _v not in PHRASE_TO_NUM:
        PHRASE_TO_NUM[_v] = _num

# Single-word lookup for fallback parser
WORD_TO_NUM = {}
WORD_TO_NUM.update({v: k for k, v in _ONES.items()})
WORD_TO_NUM["oh"] = 0
WORD_TO_NUM["o"] = 0  # "one o eight" variant
WORD_TO_NUM.update({v: k * 10 for k, v in _TENS.items()})
WORD_TO_NUM["hundred"] = 100

# ═══════════════════════════════════════════════════════════════════════
#  Grammar builder
# ═══════════════════════════════════════════════════════════════════════

def build_grammar(extra_phrases=None):
    phrases = set()
    for n in VALID_ANSWERS:
        for p in number_to_phrases(n):
            phrases.add(p)
    for v in CHILD_VARIANTS:
        phrases.add(v)
    if extra_phrases:
        for p in extra_phrases:
            phrases.add(p.lower().strip())
    phrases.add("[unk]")
    return json.dumps(sorted(phrases))

GRAMMAR_JSON = build_grammar()

# ═══════════════════════════════════════════════════════════════════════
#  Number parsing
# ═══════════════════════════════════════════════════════════════════════

def parse_number(text, custom_map=None):
    if not text:
        return None
    text = text.strip().lower()

    try:
        val = int(text)
        return val if val in VALID_ANSWERS else None
    except ValueError:
        pass

    if custom_map and text in custom_map:
        return custom_map[text]
    if text in PHRASE_TO_NUM:
        return PHRASE_TO_NUM[text]

    cleaned = " ".join(w for w in text.split()
                       if w not in ("[unk]", "uh", "um", "the")).strip()
    if cleaned and cleaned != text:
        if custom_map and cleaned in custom_map:
            return custom_map[cleaned]
        if cleaned in PHRASE_TO_NUM:
            return PHRASE_TO_NUM[cleaned]

    tokens = [w for w in cleaned.split() if w in WORD_TO_NUM]
    if not tokens:
        return None

    result = 0
    current = 0
    for token in tokens:
        val = WORD_TO_NUM[token]
        if val == 100:
            current = max(current, 1) * 100
            result += current
            current = 0
        elif val >= 20:
            current += val
        else:
            current += val
    result += current
    return result if result in VALID_ANSWERS else None

# ═══════════════════════════════════════════════════════════════════════
#  Audio
# ═══════════════════════════════════════════════════════════════════════

AUDIO_GAIN = 1.5

def amplify_audio(data, gain):
    if gain <= 1.0:
        return data
    n = len(data) // 2
    samples = struct.unpack(f"<{n}h", data)
    amp = [max(-32768, min(32767, int(s * gain))) for s in samples]
    return struct.pack(f"<{n}h", *amp)

# ═══════════════════════════════════════════════════════════════════════
#  Speech Engine
# ═══════════════════════════════════════════════════════════════════════

class SpeechEngine:
    """Vosk speech recognition. Prefers the medium-size model."""

    def __init__(self):
        self._available = False
        self._model = None
        self._vosk = None
        self._sd = None
        self._listening = False
        self._result_queue = queue.Queue()
        self._sample_rate = 16000
        self._grammar_json = GRAMMAR_JSON
        self._model_name = ""
        self._custom_map = {}
        self._init()

    def _init(self):
        try:
            import sounddevice as sd
            self._sd = sd
        except ImportError:
            print("[Speech] Install sounddevice: pip install sounddevice")
            return
        try:
            import vosk
            self._vosk = vosk
            vosk.SetLogLevel(-1)
        except ImportError:
            print("[Speech] Install vosk: pip install vosk")
            return

        # Find ONLY small model for faster loading
        script_dir = resource_path()
        candidates = []
        try:
            for entry in os.listdir(script_dir):
                full = os.path.join(script_dir, entry)
                if os.path.isdir(full) and entry.startswith("vosk-model") and "small" in entry.lower():
                    candidates.append((entry, full))
        except OSError:
            pass

        if not candidates:
            print("[Speech] No small Vosk model found. Please download a small model.")
            print("Visit: https://alphacephei.com/vosk/models and download a 'small' model.")
            print("Extract it as 'vosk-model-small' in the project directory.")
            return

        # Use the first small model found
        model_name, model_path = candidates[0]

        # Check if model is already loaded to avoid reloading
        if self._model is not None:
            print(f"[Speech] Model already loaded: {self._model_name}")
            self._available = True
            return

        try:
            self._model = vosk.Model(model_path)
            self._model_name = model_name
            self._available = True
            print(f"[Speech] Model: {model_name}")
        except Exception as e:
            print(f"[Speech] Failed to load model: {e}")

    @property
    def available(self):
        return self._available

    @property
    def model_name(self):
        return self._model_name

    def load_voice_profile(self, mappings):
        """Load custom mappings from voice training: [(heard_text, number), ...]"""
        self._custom_map = {}
        extra = []
        for heard, num in mappings:
            key = heard.strip().lower()
            self._custom_map[key] = num
            extra.append(key)
        self._grammar_json = build_grammar(extra)
        if self._custom_map:
            print(f"[Speech] Loaded {len(self._custom_map)} custom voice mappings")

    def set_user_grammar(self, user_name):
        """Load user-specific voice profile and rebuild grammar."""
        try:
            profiles = load_voice_profiles()
            user_map = profiles.get(user_name, {})
            if user_map:
                self.load_voice_profile(list(user_map.items()))
        except Exception as e:
            print(f"[Speech] Failed to load user grammar for {user_name}: {e}")

    def test_microphone(self):
        if not self._available:
            return False
        try:
            self._sd.rec(int(0.1 * self._sample_rate),
                         samplerate=self._sample_rate,
                         channels=1, dtype="int16", blocking=True)
            return True
        except Exception:
            return False

    def start_listening(self, timeout_sec=6.0):
        if not self._available:
            return
        self._listening = True
        self._result_queue = queue.Queue()
        threading.Thread(target=self._listen_thread,
                         args=(timeout_sec,), daemon=True).start()

    def stop_listening(self):
        self._listening = False

    def get_result(self, timeout=8.0):
        try:
            return self._result_queue.get(timeout=timeout)
        except queue.Empty:
            return None, None

    def _listen_thread(self, timeout_sec):
        """Standard listening with grammar restriction."""
        try:
            if not self._available or not self._model:
                self._result_queue.put((None, None))
                return

            rec = self._vosk.KaldiRecognizer(
                self._model, self._sample_rate, self._grammar_json
            )
            rec.SetWords(True)

            audio_q = queue.Queue()
            detection_time = None
            result_text = None

            def cb(indata, frames, ti, status):
                audio_q.put(bytes(indata))

            try:
                stream = self._sd.RawInputStream(
                    samplerate=self._sample_rate, blocksize=2000,
                    dtype="int16", channels=1, callback=cb)
                stream.start()
            except Exception as e:
                print(f"[Speech] Stream error: {e}")
                self._result_queue.put((None, None))
                return

            start = time.time()
            speech_detected = False
            last_speech_time = None
            noise_samples = []
            noise_calibrated = False
            threshold = 500

            try:
                while self._listening and (time.time() - start) < timeout_sec:
                    try:
                        data = audio_q.get(timeout=0.1)
                    except queue.Empty:
                        continue
                    data = amplify_audio(data, AUDIO_GAIN)

                    n_s = len(data) // 2
                    if n_s > 0 and detection_time is None:
                        samps = struct.unpack(f"<{n_s}h", data)
                        rms = (sum(s * s for s in samps) / n_s) ** 0.5
                        if not noise_calibrated and (time.time() - start) < 0.25:
                            noise_samples.append(rms)
                        else:
                            if not noise_calibrated:
                                noise_calibrated = True
                                if noise_samples:
                                    threshold = max(300, sum(noise_samples)/len(noise_samples) * 2.5)
                            if rms > threshold:
                                detection_time = time.time()

                    if rec.AcceptWaveform(data):
                        res = json.loads(rec.Result())
                        text = res.get("text", "").strip()
                        if text:
                            num = parse_number(text)
                            if num is not None:
                                result_text = text
                                break
                    else:
                        partial = json.loads(rec.PartialResult())
                        ptext = partial.get("partial", "").strip()
                        if ptext and parse_number(ptext) is not None:
                            if not speech_detected:
                                speech_detected = True
                                if detection_time is None:
                                    detection_time = time.time()
                            last_speech_time = time.time()

                    if speech_detected and last_speech_time:
                        if time.time() - last_speech_time > 0.7:
                            res = json.loads(rec.FinalResult())
                            text = res.get("text", "").strip()
                            if text:
                                result_text = text
                            break

                if result_text is None:
                    res = json.loads(rec.FinalResult())
                    text = res.get("text", "").strip()
                    if text:
                        result_text = text

            except Exception as e:
                print(f"[Speech] Recognition error: {e}")
            finally:
                try:
                    stream.stop()
                    stream.close()
                except Exception:
                    pass

            self._listening = False
            self._result_queue.put((result_text, detection_time))

        except Exception as e:
            print(f"[Speech] Critical error in listen thread: {e}")
            self._result_queue.put((None, None))


# ═══════════════════════════════════════════════════════════════════════
#  Voice profiles
# ═══════════════════════════════════════════════════════════════════════

_PROFILE_FILE = "voice_profiles.json"


def load_voice_profiles():
    """Load all users' voice profiles. Returns {user_name: {heard: number}}."""
    try:
        with open(seed_user_file(_PROFILE_FILE), "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_voice_profiles(profiles):
    """Save all users' voice profiles."""
    with open(seed_user_file(_PROFILE_FILE), "w") as f:
        json.dump(profiles, f, indent=2)
