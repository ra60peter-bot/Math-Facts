@echo off
title Math Flashcards - Microphone Test
cd /d "%~dp0"

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Python not found. Please install Python 3.11+ from python.org
    pause
    exit /b 1
)

python test_mic.py
pause
