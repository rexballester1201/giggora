"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("giggora-theme", next ? "dark" : "light");
    } catch {
      /* private mode — the toggle still works for this session */
    }
  }

  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="grid h-8 w-8 place-items-center rounded-lg text-sm"
      style={{ border: "1px solid var(--border)", color: "var(--text-dim)" }}
    >
      {dark ? "☀" : "☾"}
    </button>
  );
}
