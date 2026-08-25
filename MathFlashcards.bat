@echo off
title Math Flashcards
cd /d "%~dp0"

:: Check if Python is available
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Python not found. Please install Python 3.11+ from python.org
    echo Make sure "Add Python to PATH" is checked during install.
    pause
    exit /b 1
)

:: Install dependencies if PySide6 isn't found
python -c "import PySide6" >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing dependencies...
    python -m pip install -r requirements.txt
    echo.
)

:: Download Vosk model if not present
if not exist "vosk-model-small" (
    echo Speech model not found. Downloading...
    python download_model.py
    echo.
)

:: Launch the app
python main.py
