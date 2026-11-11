import { describe, expect, it } from "vitest";
import {
  defaultModeSettings,
  normalizeAcceptModes,
  normalizeModeSettings,
  rejectTiersToValue,
  richerProfile,
} from "./modeSettings";
import type { ModeSettings, ProfileItemConfig } from "./types";

/** Hand-edited config files reach us with any shape, so the tests cast through unknown. */
const rawSettings = (value: Record<string, unknown>) => value as unknown as ModeSettings;
const champ = (id: number, tier: string): ProfileItemConfig => ({ id, name: `#${id}`, tier, flag: "" });

describe("normalizeModeSettings", () => {
  it("returns the defaults when the config has no settings at all", () => {
    expect(normalizeModeSettings(undefined)).toEqual(defaultModeSettings());
  });

  it("keeps valid fields and falls back per field for garbage types", () => {
    const d = defaultModeSettings();
    const s = normalizeModeSettings(
      rawSettings({
        auto_card_select: false,
        card_select_delay_sec: "soon",
        card_select_strategy: "",
        auto_bench_swap: 1,
        bench_diff_threshold: 25,
        trade_reject_tiers: ["本命", 7, "愛角"],
        friend_trade_policy: "auto",
      })
    );
    expect(s.auto_card_select).toBe(false);
    expect(s.card_select_delay_sec).toBe(d.card_select_delay_sec);
    expect(s.card_select_strategy).toBe(d.card_select_strategy);
    expect(s.auto_bench_swap).toBe(d.auto_bench_swap);
    expect(s.bench_diff_threshold).toBe(25);
    expect(s.trade_reject_tiers).toEqual(["本命", "愛角"]);
    expect(s.friend_trade_policy).toBe("auto");
  });

  it("falls back for an unsupported default secondary spell", () => {
    const d = defaultModeSettings();
    expect(normalizeModeSettings(rawSettings({ default_secondary_spell: 999 })).default_secondary_spell).toBe(
      d.default_secondary_spell
    );
  });
});

describe("normalizeAcceptModes", () => {
  it("drops unknown entries and keeps the known ones", () => {
    expect(normalizeAcceptModes(["ARAM", "TFT", "Mayhem", 7])).toEqual(["ARAM", "Mayhem"]);
    expect(normalizeAcceptModes(["其他"])).toEqual(["其他"]);
  });

  it("falls back to ARAM and Mayhem when nothing survives", () => {
    expect(normalizeAcceptModes([])).toEqual(["ARAM", "Mayhem"]);
    expect(normalizeAcceptModes(["TFT"])).toEqual(["ARAM", "Mayhem"]);
    expect(normalizeAcceptModes(undefined)).toEqual(["ARAM", "Mayhem"]);
  });
});

describe("rejectTiersToValue", () => {
  it("maps the tier list onto the segmented value", () => {
    expect(rejectTiersToValue([])).toBe("");
    expect(rejectTiersToValue(["本命"])).toBe("本命");
    expect(rejectTiersToValue(["本命", "愛角"])).toBe("本命愛角");
  });
});

describe("richerProfile", () => {
  it("prefers the profile with more classified entries", () => {
    const aram = [champ(1, "本命")];
    const mayhem = [champ(2, "順手"), champ(3, "封印")];
    expect(richerProfile(aram, mayhem)).toBe(mayhem);
    expect(richerProfile(mayhem, aram)).toBe(mayhem);
  });

  it("breaks a tie on the number of 本命", () => {
    const aram = [champ(1, "本命"), champ(2, "順手"), champ(3, "未分類")];
    const mayhem = [champ(4, "本命"), champ(5, "本命"), champ(6, "未分類")];
    expect(richerProfile(aram, mayhem)).toBe(mayhem);
    expect(richerProfile(mayhem, aram)).toBe(mayhem);
  });

  it("falls back to the ARAM profile when nothing decides", () => {
    const aram = [champ(1, "未分類")];
    const mayhem = [champ(2, "未分類")];
    expect(richerProfile(aram, mayhem)).toBe(aram);
    expect(richerProfile(aram, [])).toBe(aram);
  });
});
