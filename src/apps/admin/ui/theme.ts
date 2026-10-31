import { useEffect, useState } from "preact/hooks";

export type Theme = "system" | "light" | "dark";
const KEY = "zephium-admin-theme";

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the choice lasts this visit.
  }
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return [
    theme,
    (next) => {
      saveTheme(next);
      setTheme(next);
    },
  ];
}
