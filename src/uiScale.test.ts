import { describe, expect, it } from "vitest";
import {
  clampUiScalePercent,
  stepUiScalePercent,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from "./uiScale";

describe("clampUiScalePercent", () => {
  it("keeps a value that is already on the grid", () => {
    expect(clampUiScalePercent(100)).toBe(100);
    expect(clampUiScalePercent(130)).toBe(130);
  });

  it("snaps off-grid values to the nearest step", () => {
    expect(clampUiScalePercent(104)).toBe(100);
    expect(clampUiScalePercent(106)).toBe(110);
  });

  it("clamps at both ends", () => {
    expect(clampUiScalePercent(0)).toBe(UI_SCALE_MIN);
    expect(clampUiScalePercent(80)).toBe(UI_SCALE_MIN);
    expect(clampUiScalePercent(500)).toBe(UI_SCALE_MAX);
    expect(clampUiScalePercent(200)).toBe(UI_SCALE_MAX);
  });

  it("falls back to 100% for non-finite input", () => {
    expect(clampUiScalePercent(Number.NaN)).toBe(UI_SCALE_DEFAULT);
    expect(clampUiScalePercent(Number.POSITIVE_INFINITY)).toBe(UI_SCALE_DEFAULT);
  });
});

describe("stepUiScalePercent", () => {
  it("steps up and down by 10%", () => {
    expect(stepUiScalePercent(100, 1)).toBe(110);
    expect(stepUiScalePercent(100, -1)).toBe(90);
  });

  it("stops at the range ends", () => {
    expect(stepUiScalePercent(UI_SCALE_MAX, 1)).toBe(UI_SCALE_MAX);
    expect(stepUiScalePercent(UI_SCALE_MIN, -1)).toBe(UI_SCALE_MIN);
    expect(stepUiScalePercent(195, 1)).toBe(UI_SCALE_MAX);
  });

  it("resets to 100%", () => {
    expect(clampUiScalePercent(UI_SCALE_DEFAULT)).toBe(100);
    expect(stepUiScalePercent(80, 2)).toBe(100);
  });
});
