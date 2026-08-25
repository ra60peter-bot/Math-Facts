#!/usr/bin/env python3
"""Download and extract a Vosk speech recognition model.

Run this once before using the app with voice recognition.

Two models available:
  small (~40 MB)  — faster download, decent accuracy
  large (~1.8 GB) — slower download, MUCH better accuracy (recommended)
"""

import os
import sys
import zipfile
import urllib.request
import shutil

MODELS = {
    "small": {
        "url": "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip",
        "size": "~40 MB",
        "prefix": "vosk-model-small-en-us",
    },
    "medium": {
        "url": "https://alphacephei.com/vosk/models/vosk-model-en-us-0.22-lgraph.zip",
        "size": "~128 MB",
        "prefix": "vosk-model-en-us-0.22-lgraph",
    },
}

MODEL_DIR = "vosk-model-small"
ZIP_FILE = "vosk-model.zip"


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    target_dir = os.path.join(script_dir, MODEL_DIR)

    if os.path.isdir(target_dir):
        print(f"Model already exists at: {target_dir}")
        print("Skipping download since model already exists.")
        return

    # Choose model size
    print()
    print("Which model do you want to download?")
    print()
    print("  1) Small   (~40 MB)  — fastest download, decent accuracy")
    print("  2) Medium  (~128 MB) — better accuracy, still loads fast")
    print()
    print("The medium model is recommended — it's more accurate than small")
    print("but loads much faster than the full 1.8 GB model.")
    print()

    choice = input("Enter 1 or 2 (default: 1): ").strip()
    if choice == "2":
        model_key = "medium"
    else:
        model_key = "small"

    model = MODELS[model_key]
    zip_path = os.path.join(script_dir, ZIP_FILE)

    print()
    print(f"Downloading {model_key} model ({model['size']}) from:")
    print(f"  {model['url']}")
    print()

    def progress(block_num, block_size, total_size):
        downloaded = block_num * block_size
        if total_size > 0:
            pct = min(100, downloaded * 100 / total_size)
            mb = downloaded / (1024 * 1024)
            total_mb = total_size / (1024 * 1024)
            bar = "█" * int(pct / 2) + "░" * (50 - int(pct / 2))
            print(f"\r  [{bar}] {pct:.0f}%  ({mb:.0f}/{total_mb:.0f} MB)", end="", flush=True)

    urllib.request.urlretrieve(model["url"], zip_path, reporthook=progress)
    print("\n  Download complete.")

    print("Extracting...")
    with zipfile.ZipFile(zip_path, "r") as z:
        z.extractall(script_dir)

    # The zip extracts to a versioned folder name; rename it
    extracted = None
    for entry in os.listdir(script_dir):
        full = os.path.join(script_dir, entry)
        if os.path.isdir(full) and entry.startswith(model["prefix"]):
            extracted = full
            break

    if extracted and os.path.abspath(extracted) != os.path.abspath(target_dir):
        if os.path.exists(target_dir):
            shutil.rmtree(target_dir)
        shutil.move(extracted, target_dir)
        print(f"  Model installed at: {target_dir}")
    elif extracted:
        print(f"  Model installed at: {extracted}")
    else:
        print("  Warning: could not find extracted model directory.")
        print("  Please manually rename the extracted folder to 'vosk-model'.")

    # Clean up zip
    try:
        os.remove(zip_path)
    except OSError:
        pass

    print()
    print("Done! You can now run: python main.py")


if __name__ == "__main__":
    main()
