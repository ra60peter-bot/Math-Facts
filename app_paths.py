"""Path helpers for source and packaged app layouts."""

import os
import shutil
import sys
from pathlib import Path


APP_NAME = "Math Flashcards"


def resource_path(*parts):
    """Return a bundled read-only resource path."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base.joinpath(*parts)


def user_data_dir():
    """Return the writable per-user data directory."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))

    path = base / APP_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def user_data_path(filename):
    """Return a writable file path for persistent app data."""
    return user_data_dir() / filename


def seed_user_file(filename):
    """Copy an existing bundled/source data file into user data on first run."""
    target = user_data_path(filename)
    if not target.exists():
        source = resource_path(filename)
        if source.exists():
            shutil.copy2(source, target)
    return target
