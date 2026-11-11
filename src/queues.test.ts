import { describe, expect, it } from "vitest";
import { queueModeLabel, signedDiff } from "./queues";

describe("queueModeLabel", () => {
  it("maps the ARAM queue", () => {
    expect(queueModeLabel(450)).toBe("ARAM");
  });

  it("maps the Mayhem queues", () => {
    expect(queueModeLabel(2400)).toBe("Mayhem");
  });

  it("falls back to 其他 for other and missing ids", () => {
    expect(queueModeLabel(420)).toBe("其他");
    expect(queueModeLabel(null)).toBe("其他");
    expect(queueModeLabel(undefined)).toBe("其他");
  });
});

describe("signedDiff", () => {
  it("shows an em dash when there is no diff", () => {
    expect(signedDiff(null)).toBe("—");
  });

  it("signs a positive diff, including zero", () => {
    expect(signedDiff(0)).toBe("+0");
    expect(signedDiff(5)).toBe("+5");
  });

  it("keeps the minus sign of a negative diff", () => {
    expect(signedDiff(-3)).toBe("-3");
  });
});
