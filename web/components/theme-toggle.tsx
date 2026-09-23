"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("math-facts-theme-change", onChange);
  return () => window.removeEventListener("math-facts-theme-change", onChange);
}

export function ThemeToggle() {
  const dark = useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme === "dark",
    () => false,
  );

  function toggleTheme() {
    const theme = dark ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("math-facts-theme", theme);
    } catch {
      // The toggle still works when browser storage is unavailable.
    }
    window.dispatchEvent(new Event("math-facts-theme-change"));
  }

  return (
    <button className="theme-toggle button secondary" type="button" aria-label="Dark mode" aria-pressed={dark} onClick={toggleTheme}>
      <span aria-hidden="true">{dark ? "☀" : "☾"}</span>
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
