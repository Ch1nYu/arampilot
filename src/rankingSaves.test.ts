import { describe, expect, it } from "vitest";
import {
  captureLive,
  isDirty,
  MAX_RANKING_SAVES,
  newSaveId,
  nextSaveName,
  normalizeSaves,
  restoreSave,
  type LiveChampion,
  type RankingSave,
  type RankingSaveItem,
} from "./rankingSaves";

const champ = (id: number, n: string, t = "未分類", f = "", secSpell?: number): LiveChampion => ({
  id,
  n,
  t,
  f,
  secSpell,
});

describe("normalizeSaves", () => {
  it("creates 存檔 1 when the config has no saves at all", () => {
    const { saves, activeId } = normalizeSaves(undefined, undefined);
    expect(saves).toHaveLength(1);
    expect(saves[0].name).toBe("存檔 1");
    expect(saves[0].items).toEqual([]);
    expect(activeId).toBe(saves[0].id);
  });

  it("creates 存檔 1 from an empty list", () => {
    const { saves, activeId } = normalizeSaves([], "");
    expect(saves.map((s) => s.name)).toEqual(["存檔 1"]);
    expect(activeId).toBe(saves[0].id);
  });

  it("drops saves without an id and duplicate ids", () => {
    const { saves } = normalizeSaves(
      [
        { id: "", name: "空 id", items: [] },
        { id: "rs-a", name: "A", items: [] },
        { id: "rs-a", name: "重複", items: [] },
        { name: "沒有 id", items: [] },
        "nonsense",
      ],
      "rs-a"
    );
    expect(saves.map((s) => s.id)).toEqual(["rs-a"]);
  });

  it("falls back to the first save when the active id is unknown", () => {
    const { saves, activeId } = normalizeSaves(
      [
        { id: "rs-a", name: "A", items: [] },
        { id: "rs-b", name: "B", items: [] },
      ],
      "rs-gone"
    );
    expect(saves).toHaveLength(2);
    expect(activeId).toBe("rs-a");
  });

  it("keeps a known active id and cleans items and names", () => {
    const { saves, activeId } = normalizeSaves(
      [
        {
          id: "rs-b",
          name: "  長".repeat(1) + "名".repeat(60),
          items: [
            { id: 1, name: "阿璃", tier: "本命", flag: "lock", elo: 1700, matches: 3 },
            { id: 1, name: "重複", tier: "封印", flag: "" },
            { id: 0, name: "壞 id", tier: "未分類", flag: "" },
            { id: 2, name: 7, tier: 9, flag: null, elo: "x", matches: Number.NaN },
          ],
        },
      ],
      "rs-b"
    );
    expect(activeId).toBe("rs-b");
    const save = saves[0];
    expect(Array.from(save.name)).toHaveLength(40);
    expect(save.items).toHaveLength(2);
    expect(save.items[0]).toEqual({ id: 1, name: "阿璃", tier: "本命", flag: "lock", elo: 1700, matches: 3 });
    expect(save.items[1]).toEqual({ id: 2, name: "", tier: "未分類", flag: "" });
  });

  it("keeps at most 20 saves", () => {
    const raw = Array.from({ length: 25 }, (_, i) => ({ id: `rs-${i}`, name: `存檔 ${i + 1}`, items: [] }));
    const { saves } = normalizeSaves(raw, "rs-0");
    expect(saves).toHaveLength(MAX_RANKING_SAVES);
  });

  it("names blank saves with the next free 存檔 N", () => {
    const { saves } = normalizeSaves(
      [
        { id: "rs-a", name: "存檔 1", items: [] },
        { id: "rs-b", name: "   ", items: [] },
      ],
      "rs-a"
    );
    expect(saves[1].name).toBe("存檔 2");
  });
});

describe("captureLive / restoreSave", () => {
  it("round-trips order, tier, flag and weights", () => {
    const list = [champ(1, "阿璃", "本命", "lock", 32), champ(2, "蓋倫", "順手", ""), champ(3, "拉克絲")];
    const elo = { 1: 1712, 2: 1500 };
    const matches = { 1: 4 };
    const items = captureLive(list, elo, matches);

    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(items[0]).toEqual({ id: 1, name: "阿璃", tier: "本命", flag: "lock", elo: 1712, matches: 4 });
    expect(items[2]).toEqual({ id: 3, name: "拉克絲", tier: "未分類", flag: "" });
    expect("elo" in items[2]).toBe(false);

    const restored = restoreSave(items, list);
    expect(restored.list.map((c) => [c.id, c.t, c.f])).toEqual([
      [1, "本命", "lock"],
      [2, "順手", ""],
      [3, "未分類", ""],
    ]);
    expect(restored.elo).toEqual({ 1: 1712, 2: 1500 });
    expect(restored.matches).toEqual({ 1: 4 });
  });

  it("keeps the live name and secondary spell of a champion", () => {
    const items: RankingSaveItem[] = [{ id: 1, name: "舊名字", tier: "愛角", flag: "give" }];
    const current = [champ(1, "阿璃", "未分類", "", 32)];
    const restored = restoreSave(items, current);
    expect(restored.list[0]).toMatchObject({ id: 1, n: "阿璃", t: "愛角", f: "give", secSpell: 32 });
  });

  it("falls back to the saved name for a champion the live list lost", () => {
    const items: RankingSaveItem[] = [{ id: 9, name: "舊英雄", tier: "勉強", flag: "", elo: 1400 }];
    const restored = restoreSave(items, [champ(1, "阿璃")]);
    expect(restored.list.map((c) => [c.id, c.n, c.t])).toEqual([
      [9, "舊英雄", "勉強"],
      [1, "阿璃", "未分類"],
    ]);
    expect(restored.elo).toEqual({ 9: 1400 });
  });

  it("appends champions missing from the save as 未分類 without weights", () => {
    const items = captureLive([champ(2, "蓋倫", "本命", "lock")], { 2: 1700 }, { 2: 5 });
    const current = [champ(1, "阿璃", "封印", "nograb", 32), champ(2, "蓋倫", "本命", "lock")];
    const restored = restoreSave(items, current);
    expect(restored.list.map((c) => [c.id, c.t, c.f])).toEqual([
      [2, "本命", "lock"],
      [1, "未分類", ""],
    ]);
    expect(restored.list[1].secSpell).toBe(32);
    expect(restored.elo).toEqual({ 2: 1700 });
    expect(restored.matches).toEqual({ 2: 5 });
  });

  it("turns an empty save into a fully 未分類 ranking with no weights", () => {
    const current = [champ(1, "阿璃", "本命", "lock", 6), champ(2, "蓋倫", "順手", "")];
    const restored = restoreSave([], current);
    expect(restored.list.map((c) => [c.id, c.n, c.t, c.f])).toEqual([
      [1, "阿璃", "未分類", ""],
      [2, "蓋倫", "未分類", ""],
    ]);
    expect(restored.list[0].secSpell).toBe(6);
    expect(restored.elo).toEqual({});
    expect(restored.matches).toEqual({});
  });
});

describe("isDirty", () => {
  const list = [champ(1, "阿璃", "本命", "lock"), champ(2, "蓋倫", "順手", ""), champ(3, "拉克絲")];
  const elo = { 1: 1712, 2: 1500 };
  const matches = { 1: 4 };
  const items = captureLive(list, elo, matches);

  it("is clean right after a capture", () => {
    expect(isDirty(items, list, elo, matches)).toBe(false);
  });

  it("sees a tier change", () => {
    const edited = list.map((c) => (c.id === 2 ? { ...c, t: "本命" } : c));
    expect(isDirty(items, edited, elo, matches)).toBe(true);
  });

  it("sees a flag change", () => {
    const edited = list.map((c) => (c.id === 1 ? { ...c, f: "give" } : c));
    expect(isDirty(items, edited, elo, matches)).toBe(true);
  });

  it("sees an elo change", () => {
    expect(isDirty(items, list, { 1: 1712, 2: 1512 }, matches)).toBe(true);
  });

  it("sees a matches change", () => {
    expect(isDirty(items, list, elo, { 1: 5 })).toBe(true);
  });

  it("sees a weight that appeared or disappeared", () => {
    expect(isDirty(items, list, { 1: 1712 }, matches)).toBe(true);
    expect(isDirty(items, list, elo, { 1: 4, 3: 1 })).toBe(true);
  });

  it("sees two entries swapped", () => {
    const swapped = [list[1], list[0], list[2]];
    expect(isDirty(items, swapped, elo, matches)).toBe(true);
  });

  it("ignores a champion appended at the end as 未分類 without weights", () => {
    const grown = [...list, champ(4, "姍娜")];
    expect(isDirty(items, grown, elo, matches)).toBe(false);
  });
});

describe("nextSaveName / newSaveId", () => {
  const save = (name: string): RankingSave => ({ id: name, name, items: [] });

  it("starts at 存檔 1", () => {
    expect(nextSaveName([])).toBe("存檔 1");
  });

  it("skips names that are already taken", () => {
    expect(nextSaveName([save("存檔 1"), save("存檔 3")])).toBe("存檔 2");
    expect(nextSaveName([save("存檔 2"), save("存檔 1")])).toBe("存檔 3");
  });

  it("builds a stable id from the clock and the random source", () => {
    const id = newSaveId(1234567890, () => 0.5);
    expect(id).toBe(`rs-${(1234567890).toString(36)}-iiii`);
    expect(id).toMatch(/^rs-[0-9a-z]+-[0-9a-z]{4}$/);
  });
});
