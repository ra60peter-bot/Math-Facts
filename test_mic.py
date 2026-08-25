#!/usr/bin/env python3
"""Microphone & recognition test for Math Flashcards.

Walks you through saying each number 2-18 out loud and reports
what Vosk heard, whether it parsed correctly, the confidence,
and the raw audio energy level. Helps diagnose recognition problems.

Prefers the medium model (vosk-model-en-us-0.22-lgraph) if present.
Falls back to whatever model is available.

Usage:
    python test_mic.py
"""

import sys
import os
import json
import time
import struct
import queue

# Add the app directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from speech_engine import (
    parse_number, amplify_audio, AUDIO_GAIN,
    GRAMMAR_JSON, extract_best_number,
)

SAMPLE_RATE = 16000


def find_model_path():
    """Find the best Vosk model, preferring medium over small."""
    script_dir = os.path.dirname(os.path.abspath(__file__))

    # Priority order: medium model first, then any vosk-model-*, then 'vosk-model'
    medium_names = [
        "vosk-model-en-us-0.22-lgraph",
    ]
    small_names = [
        "vosk-model-small-en-us-0.15",
    ]
    generic_names = [
        "vosk-model",
        "model",
    ]

    # Scan directory for all vosk model folders
    found_models = []
    try:
        for entry in os.listdir(script_dir):
            full = os.path.join(script_dir, entry)
            if os.path.isdir(full) and entry.startswith("vosk-model"):
                found_models.append((entry, full))
    except OSError:
        pass

    # Try medium first
    for name in medium_names:
        path = os.path.join(script_dir, name)
        if os.path.isdir(path):
            return path, "medium"

    # Try any found model that isn't "small"
    for name, path in found_models:
        if "small" not in name:
            return path, "other"

    # Try small
    for name in small_names:
        path = os.path.join(script_dir, name)
        if os.path.isdir(path):
            return path, "small"

    # Try generic
    for name in generic_names:
        path = os.path.join(script_dir, name)
        if os.path.isdir(path):
            # Figure out which size it is by directory size
            return path, "unknown"

    # Check any remaining found models
    if found_models:
        return found_models[0][1], "unknown"

    return None, None


def rms_energy(data: bytes) -> float:
    """Compute RMS energy of 16-bit PCM audio."""
    n = len(data) // 2
    if n == 0:
        return 0.0
    samples = struct.unpack(f"<{n}h", data)
    return (sum(s * s for s in samples) / n) ** 0.5


def listen_once(model, vosk, sd, timeout=5.0):
    """Listen for one spoken number. Returns dict with details."""
    rec = vosk.KaldiRecognizer(model, SAMPLE_RATE, GRAMMAR_JSON)
    rec.SetWords(True)

    audio_queue = queue.Queue()
    result = {
        "raw_text": None,
        "parsed_number": None,
        "confidence": None,
        "peak_energy": 0,
        "avg_energy": 0,
        "detection_time_ms": None,
        "word_details": [],
    }

    def callback(indata, frames, time_info, status):
        audio_queue.put(bytes(indata))

    try:
        stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE, blocksize=2000,
            dtype="int16", channels=1, callback=callback,
        )
        stream.start()
    except Exception as e:
        print(f"  ERROR: Could not open mic: {e}")
        return result

    start = time.time()
    energies = []
    speech_detected = False
    last_speech_time = None
    detection_time = None

    try:
        while (time.time() - start) < timeout:
            try:
                data = audio_queue.get(timeout=0.1)
            except queue.Empty:
                continue

            data = amplify_audio(data, AUDIO_GAIN)

            # Track energy
            e = rms_energy(data)
            energies.append(e)
            if e > result["peak_energy"]:
                result["peak_energy"] = e

            # Stamp detection on first loud chunk
            if detection_time is None and len(energies) > 3:
                baseline = sum(energies[:3]) / 3
                threshold = max(500, baseline * 3)
                if e > threshold:
                    detection_time = time.time()
                    result["detection_time_ms"] = int((detection_time - start) * 1000)

            if rec.AcceptWaveform(data):
                res = json.loads(rec.Result())
                text = res.get("text", "").strip()
                words = res.get("result", [])
                if text:
                    result["raw_text"] = text
                    result["word_details"] = words
                    num, _ = extract_best_number(res)
                    result["parsed_number"] = num
                    if words:
                        confs = [w.get("conf", 0) for w in words]
                        result["confidence"] = max(confs)
                    break
            else:
                partial = json.loads(rec.PartialResult())
                ptext = partial.get("partial", "").strip()
                if ptext and parse_number(ptext) is not None:
                    if not speech_detected:
                        speech_detected = True
                    last_speech_time = time.time()

            if speech_detected and last_speech_time:
                if time.time() - last_speech_time > 0.5:
                    res = json.loads(rec.FinalResult())
                    text = res.get("text", "").strip()
                    words = res.get("result", [])
                    if text:
                        result["raw_text"] = text
                        result["word_details"] = words
                        num, _ = extract_best_number(res)
                        result["parsed_number"] = num
                        if words:
                            confs = [w.get("conf", 0) for w in words]
                            result["confidence"] = max(confs)
                    break

        # Timeout fallback
        if result["raw_text"] is None:
            res = json.loads(rec.FinalResult())
            text = res.get("text", "").strip()
            words = res.get("result", [])
            if text:
                result["raw_text"] = text
                result["word_details"] = words
                num, _ = extract_best_number(res)
                result["parsed_number"] = num
                if words:
                    confs = [w.get("conf", 0) for w in words]
                    result["confidence"] = max(confs)

    finally:
        stream.stop()
        stream.close()

    if energies:
        result["avg_energy"] = int(sum(energies) / len(energies))
    result["peak_energy"] = int(result["peak_energy"])

    return result


def main():
    print("=" * 64)
    print("  MATH FLASHCARDS — MICROPHONE & RECOGNITION TEST")
    print("=" * 64)
    print()

    # Import vosk and sounddevice
    try:
        import vosk
        import sounddevice as sd
    except ImportError as e:
        print(f"ERROR: {e}")
        print("Install with: python -m pip install vosk sounddevice")
        sys.exit(1)

    # Find model — prefer medium
    model_path, model_type = find_model_path()
    if model_path is None:
        print("ERROR: No Vosk model found.")
        print("Run: python download_model.py  (pick option 2 for medium)")
        sys.exit(1)

    model_name = os.path.basename(model_path)
    print(f"Loading model: {model_name} ({model_type})")
    if model_type == "small":
        print("  NOTE: You're using the small model. For better accuracy,")
        print("  run: python download_model.py  and pick option 2 (medium, ~128 MB)")
        print()

    vosk.SetLogLevel(-1)
    print("  Loading... ", end="", flush=True)
    t0 = time.time()
    model = vosk.Model(model_path)
    load_time = time.time() - t0
    print(f"done in {load_time:.1f}s")
    print()

    # Mic test
    print("Testing microphone...")
    try:
        sd.rec(int(0.1 * SAMPLE_RATE), samplerate=SAMPLE_RATE,
               channels=1, dtype="int16", blocking=True)
        print("  ✓ Microphone is working")
    except Exception as e:
        print(f"  ✗ Microphone not detected: {e}")
        sys.exit(1)

    print()
    print(f"Audio gain: {AUDIO_GAIN}x")
    print()

    # Test numbers 2-18
    test_numbers = list(range(2, 19))
    number_words = {
        2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
        7: "seven", 8: "eight", 9: "nine", 10: "ten",
        11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen",
        15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen",
    }

    results = []
    print("I'll ask you to say each number. Speak clearly after the prompt.")
    print("You have 5 seconds per number.")
    print()

    input("Press Enter when you're ready to begin...")
    print()

    for num in test_numbers:
        word = number_words[num]
        print(f"── Say: {num} (\"{word}\") ──")
        sys.stdout.flush()

        time.sleep(0.8)

        print("  🎤 Listening...", end="", flush=True)
        r = listen_once(model, vosk, sd, timeout=5.0)
        print("\r  ", end="")

        correct = r["parsed_number"] == num
        status = "✓ PASS" if correct else "✗ FAIL"

        conf_str = f"{r['confidence']:.0%}" if r["confidence"] is not None else "n/a"

        print(f"  {status}  |  "
              f"Expected: {num}  |  "
              f"Heard: \"{r['raw_text']}\"  →  {r['parsed_number']}  |  "
              f"Confidence: {conf_str}  |  "
              f"Energy: avg={r['avg_energy']}, peak={r['peak_energy']}  |  "
              f"Detected at: {r['detection_time_ms']}ms")

        if r["word_details"]:
            for w in r["word_details"]:
                print(f"       word=\"{w.get('word','')}\" conf={w.get('conf',0):.2f}")

        results.append({
            "expected": num,
            "word": word,
            "correct": correct,
            "result": r,
        })
        print()

    # Summary
    print()
    print("=" * 64)
    print("  SUMMARY")
    print("=" * 64)

    passed = sum(1 for r in results if r["correct"])
    total = len(results)
    print(f"\n  Model: {model_name} ({model_type})")
    print(f"  Load time: {load_time:.1f}s")
    print(f"  Passed: {passed}/{total} ({passed/total*100:.0f}%)\n")

    failures = [r for r in results if not r["correct"]]
    if failures:
        print("  Failed numbers:")
        for r in failures:
            heard = r["result"]["raw_text"] or "(nothing)"
            parsed = r["result"]["parsed_number"]
            conf = r["result"]["confidence"]
            conf_str = f"{conf:.0%}" if conf is not None else "n/a"
            print(f"    {r['expected']} (\"{r['word']}\")  →  "
                  f"heard \"{heard}\" → parsed as {parsed}  (conf: {conf_str})")
        print()
        if model_type == "small":
            print("  ➤  You're using the small model. Try the medium model for")
            print("     better accuracy: python download_model.py (pick option 2)")
            print()
        print("  Other troubleshooting tips:")
        print("    - Speak louder or closer to the microphone")
        print("    - Make sure the room is quiet")
        print("    - Check mic volume in Windows Settings → System → Sound → Input")
    else:
        print("  All numbers recognized correctly! ✓")

    print()


if __name__ == "__main__":
    main()
