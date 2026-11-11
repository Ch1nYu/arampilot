import { describe, expect, it } from "vitest";
import { BUILTIN_CHAMPIONS } from "./champions";
import { calculateScores, createDefaultRoster, ensureAllBuiltinChampions } from "./tiers";
import type { TierChampion } from "./types";

const champ = (id: number, tier: string): TierChampion => ({ id, n: `#${id}`, t: tier, f: "" });

describe("calculateScores", () => {
  it("spreads 本命 from 100 down to 90 in list order", () => {
    const sc = calculateScores([champ(1, "本命"), champ(2, "本命"), champ(3, "本命")]);
    expect(sc[1]).toBe(100);
    expect(sc[2]).toBe(95);
    expect(sc[3]).toBe(90);
  });

  it("gives a single member the top score of its tier", () => {
    const sc = calculateScores([champ(1, "順手"), champ(2, "愛角")]);
    expect(sc[1]).toBe(74);
    expect(sc[2]).toBe(89);
  });

  it("leaves 未分類 without a score", () => {
    const sc = calculateScores([champ(1, "未分類"), champ(2, "本命")]);
    expect(sc[1]).toBeNull();
    expect(sc[2]).toBe(100);
  });
});

describe("ensureAllBuiltinChampions", () => {
  it("adds the missing champions without duplicating existing ones", () => {
    const [first, second] = BUILTIN_CHAMPIONS;
    const list: TierChampion[] = [{ id: first.id, n: first.n, t: "本命", f: "lock" }];
    ensureAllBuiltinChampions(list);

    expect(list).toHaveLength(BUILTIN_CHAMPIONS.length);
    expect(list.filter((c) => c.id === first.id)).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: first.id, t: "本命", f: "lock" });
    expect(list).toContainEqual({ id: second.id, n: second.n, t: "未分類", f: "" });
  });

  it("leaves a full roster untouched", () => {
    const list = createDefaultRoster();
    ensureAllBuiltinChampions(list);
    expect(list).toHaveLength(BUILTIN_CHAMPIONS.length);
    expect(list.every((c) => c.t === "未分類" && c.f === "")).toBe(true);
  });
});
