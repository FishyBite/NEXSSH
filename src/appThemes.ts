import palettes from "./appThemes.json";

export type AppThemeMode = "light" | "dark";
export const appThemes = { ...palettes, system: { label: "System" } };
export type AppTheme = keyof typeof appThemes;
export const appThemeOptions = [
  "dark", "light", "system", "midnight", "graphite", "forest", "dusk", "paper", "mist",
] as const satisfies readonly AppTheme[];

export function validAppTheme(value: unknown): value is AppTheme {
  return typeof value === "string" && Object.hasOwn(appThemes, value);
}

export function resolveAppTheme(theme: AppTheme, systemMode: AppThemeMode): AppThemeMode {
  if (theme === "system") return systemMode;
  return palettes[theme].scheme === "light" ? "light" : "dark";
}
