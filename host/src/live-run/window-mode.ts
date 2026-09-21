/**
 * Single-authority window-shape contract for Stardew launches. This module is
 * the only place the 5-state window mode is defined; both the live-run harness
 * (tools/) and the production runtime consume it. It must stay pure TypeScript
 * with zero imports (no node:*, no games/*, no external dependencies).
 */
export type LiveRunWindowMode = "visible" | "foreground" | "minimized" | "hidden" | "background";

/** Stardew-facing alias of the generic live-run window mode vocabulary. */
export type StardewWindowMode = LiveRunWindowMode;

/** True when the value is exactly one of the 5 live-run window modes. */
export function isLiveRunWindowMode(value: unknown): value is LiveRunWindowMode {
  return value === "visible" || value === "foreground" || value === "minimized" || value === "hidden" || value === "background";
}

/**
 * Normalizes a raw CLI/env string into a live-run window mode, failing closed
 * on invalid or missing input so PowerShell fixtures (T4) and gate configs (T5)
 * cannot inject an unknown window shape.
 */
export function normalizeLiveRunWindowMode(value: string | undefined): LiveRunWindowMode {
  if (value !== undefined && isLiveRunWindowMode(value)) return value;
  throw new TypeError(`invalid_live_run_window_mode:${value === undefined ? "undefined" : JSON.stringify(value)}`);
}

/** Maps a window mode to the native process window style ("Normal" | "Minimized" | "Hidden"). */
export function windowModeToStyle(mode: StardewWindowMode): "Normal" | "Minimized" | "Hidden" {
  switch (mode) {
    case "hidden":
    case "background":
      return "Hidden";
    case "minimized":
      return "Minimized";
    case "visible":
    case "foreground":
      return "Normal";
  }
}

/** Visibility of the Stardew window: visible/foreground/minimized modes capture window evidence. */
export function shouldCaptureWindowEvidence(mode: StardewWindowMode): boolean {
  switch (mode) {
    case "visible":
    case "foreground":
    case "minimized":
      return true;
    case "hidden":
    case "background":
      return false;
  }
}

/** Environment variables that carry the window mode into the launched process. */
export function windowModeEnvironment(mode: StardewWindowMode): Readonly<{ GAMEBUDDY_WINDOW_MODE: StardewWindowMode }> {
  return Object.freeze({ GAMEBUDDY_WINDOW_MODE: mode });
}