export type Theme = "system" | "light" | "dark";
const KEY = "apicc.theme";

export function resolveTheme(preference: Theme, prefersDark: boolean): "light" | "dark" {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function loadPreference(): Theme {
  return (localStorage.getItem(KEY) as Theme | null) ?? "system";
}

export function savePreference(preference: Theme): void {
  localStorage.setItem(KEY, preference);
}

export function applyTheme(preference: Theme, prefersDark: boolean): "light" | "dark" {
  const resolved = resolveTheme(preference, prefersDark);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}
