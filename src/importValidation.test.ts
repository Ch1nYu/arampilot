import { describe, expect, it } from "vitest";
import { validateImportedConfig } from "./importValidation";

const TIERS = ["本命", "愛角", "順手", "勉強", "封印", "未分類"];
const FLAGS = ["", "lock", "give", "nograb"];
const check = (raw: unknown) => validateImportedConfig(raw, TIERS, FLAGS);

describe("validateImportedConfig", () => {
  it("accepts an exported config with weights", () => {
    const cfg = {
      aram_profile: [{ id: 81, name: "伊澤瑞爾", tier: "本命", flag: "", elo: 1672, matches: 5, secondary_spell: 6 }],
      chat_messages: ["謝啦"],
    };
    expect(check(cfg)).toBeNull();
  });

  it("rejects the lab autosave format instead of resetting every setting", () => {
    expect(check({ currentScope: "本命", profile: [], sessions: {}, updatedAt: 1 })).toMatch(/缺少/);
  });

  it("rejects an empty ranking that would wipe the priority list", () => {
    expect(check({ aram_profile: [] })).toMatch(/空/);
    expect(check({ aram_profile: [], mayhem_profile: [] })).toMatch(/空/);
  });

  it("accepts older exports with a full ARAM list and an empty Mayhem list", () => {
    expect(check({ aram_profile: [{ id: 81, tier: "本命" }], mayhem_profile: [] })).toBeNull();
    expect(check({ aram_profile: [], mayhem_profile: [{ id: 81 }] })).toBeNull();
    expect(check({ aram_profile: [{ id: 81 }], mayhem_profile: "x" })).toMatch(/格式/);
  });

  it("rejects entries that would make later saves fail", () => {
    expect(check({ aram_profile: [{ id: 1, name: 5 }] })).toMatch(/名稱/);
    expect(check({ aram_profile: [{ id: 1, tier: "神" }] })).toMatch(/階層/);
    expect(check({ aram_profile: [{ id: 1, flag: "x" }] })).toMatch(/標記/);
    expect(check({ aram_profile: [{ id: 0 }] })).toMatch(/id/);
    expect(check({ aram_profile: [{ id: 1, elo: "1500" }] })).toMatch(/elo/);
    expect(check({ aram_profile: [{ id: 1 }], chat_messages: [1] })).toMatch(/訊息/);
  });

  it("rejects non-object roots", () => {
    expect(check(null)).not.toBeNull();
    expect(check([1, 2])).not.toBeNull();
    expect(check("x")).not.toBeNull();
  });
});
