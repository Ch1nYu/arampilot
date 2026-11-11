// UI zoom math for the 顯示比例 slider and its Ctrl shortcuts, kept free of DOM/tauri so it can be tested.

/** Percent bounds the slider and the shortcuts share. */
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_STEP = 10;
/** 100% — the default, and what Ctrl+0 resets to. */
export const UI_SCALE_DEFAULT = 100;

/**
 * Snap a percent onto the slider's grid and clamp it into range. NaN / Infinity
 * (an empty or hand-edited value) falls back to 100% instead of the minimum.
 */
export function clampUiScalePercent(percent: number): number {
  if (!Number.isFinite(percent)) return UI_SCALE_DEFAULT;
  const snapped = Math.round(percent / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped));
}

/** Move `steps` grid steps (one Ctrl shortcut) from `percent`, clamped to the range. */
export function stepUiScalePercent(percent: number, steps: number): number {
  const from = clampUiScalePercent(percent);
  return clampUiScalePercent(from + steps * UI_SCALE_STEP);
}
