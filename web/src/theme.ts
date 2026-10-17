export type ThemeName = "forest" | "ink" | "plum";

/** Swatch colors mirror each theme's light palette in themes.css. */
export const themes: { name: ThemeName; label: string; sidebar: string; highlight: string; paper: string; accent: string; ink: string }[] = [
  { name: "forest", label: "Forest", sidebar: "#202e2b", highlight: "#ccad7e", paper: "#f8f6f0", accent: "#92532e", ink: "#272e2b" },
  { name: "ink", label: "Ink", sidebar: "#1b2233", highlight: "#a3bde2", paper: "#f6f7f8", accent: "#2f5d8c", ink: "#1f2733" },
  { name: "plum", label: "Plum", sidebar: "#2b1f2a", highlight: "#e0a99b", paper: "#f9f5f3", accent: "#8e3b55", ink: "#2e2529" }
];

const storageKey = "owg-theme";

export function storedTheme(): ThemeName {
  try {
    const value = localStorage.getItem(storageKey);
    return themes.some(theme => theme.name === value) ? value as ThemeName : "forest";
  } catch { return "forest"; }
}

/** Applies a theme to the document and remembers it for this browser. */
export function applyTheme(name: ThemeName, persist = false): void {
  const theme = themes.find(candidate => candidate.name === name) ?? themes[0];
  if (theme.name === "forest") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.name;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.sidebar);
  if (persist) {
    try { localStorage.setItem(storageKey, theme.name); } catch { /* Storage may be unavailable. */ }
  }
}
