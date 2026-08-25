#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

if [[ ! -d "vosk-model-small" ]]; then
  python download_model.py
fi

python -m PyInstaller --clean --noconfirm MathFlashcards-mac.spec

echo
echo "Built: dist/Math Flashcards.app"
