# 🧮 Math Flashcards

A desktop app for practicing single-digit addition facts with **spoken answers**, spaced repetition, and progress tracking.

Built for **Miles** and **Violet** — each user's history is saved across sessions.

## Features

- **Voice recognition** (Vosk, offline) — say the answer out loud, or type it
- **Timed responses** — tracks how quickly you answer each fact
- **Within-session retry** — incorrect or slow answers reappear later in the session
- **Across-session spaced repetition** (FSRS, the modern Anki scheduler) — due and difficult facts come back sooner in future sessions
- **Session results** — accuracy %, average time, slowest facts
- **History & trends** — track improvement over time for each user

## Quick Start

### 1. Install Python dependencies

```bash
pip install -r requirements.txt
```

Requires **Python 3.10+**. Dependencies include PySide6, vosk, sounddevice, numpy, and `fsrs`.

### 2. Download the speech model

```bash
python download_model.py
```

This downloads the small English Vosk model (~40 MB). You only need to do this once. If you skip this step, the app runs in **keyboard-only mode**.

### 3. Run the app

```bash
python main.py
```

## Build a Standalone macOS App

Build the `.app` bundle on macOS:

```bash
chmod +x build_macos_app.command
./build_macos_app.command
```

The finished app will be created at:

```text
dist/Math Flashcards.app
```

The bundle includes the Vosk speech model when `vosk-model-small` is present.
User progress is stored outside the app bundle in:

```text
~/Library/Application Support/Math Flashcards/
```

On first launch, macOS will ask for microphone permission so spoken answers can
work. The app still supports typed answers if microphone access is denied.

## How It Works

### Setup Screen
- Select user (Miles or Violet)
- Choose number of questions (10–100; defaults to 50)
- Mic status indicator shows whether voice recognition is ready
- Click **Start Practice**

### Practice Screen
- A math fact appears (e.g., `7 + 5`)
- Say the answer out loud, or type it and press Enter
- The app shows whether you were correct, what it heard, and your response time
- Incorrect or slow answers are automatically re-queued later in the session
- Click **Stop** to end early

### Results Screen
- See your accuracy % and average response time
- View the 5 slowest facts from the session
- Click into full attempt-by-attempt details

### History Screen
- Browse all past sessions per user
- See improvement trends (accuracy and speed changes over time)
- Click into any session to review individual attempts

## Spaced Repetition

The app uses two layers:

1. **Within-session** — If you get a fact wrong or answer slowly (top 20% slowest), it reappears ~7 cards later (up to 3 retries per card).

2. **Across-session** (FSRS at 90% desired retention) — Each answer updates a serialized FSRS card. Due reviews are shown first, then new facts, then future reviews. Response speed still determines Again/Hard/Good/Easy and breaks ties between facts in the same FSRS group.

## Data Storage

All data is stored in a local SQLite file (`flashcards.db`) in the app's user data folder. On macOS, this is `~/Library/Application Support/Math Flashcards/`. This persists across sessions and app restarts.

## Keyboard Fallback

If Vosk or your microphone isn't available, you can always type answers using the text input field and press Enter.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Vosk not available" | Run `pip install vosk sounddevice` and `python download_model.py` |
| Mic not detected | Check your system audio settings; ensure a microphone is connected |
| Wrong answers recognized | The app shows what it "heard" — try speaking more clearly, or use keyboard |
| App won't start | Ensure Python 3.9+ and `pip install PySide6` |
