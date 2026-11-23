import { describe, expect, it } from "vitest";
import type { TierChampion } from "./types";
import {
  applyTierOrder,
  chooseBinary,
  createBinarySession,
  isDone,
  orderedIds,
  pivotIndex,
  resumeSortedCount,
  stepsLeft,
  type BinarySession,
} from "./binarySort";

/** What one challenger cost: `locked` champions were already locked, `budget` clicks were advertised. */
interface Placement {
  id: number;
  locked: number;
  clicks: number;
  budget: number;
}

/** Answer every comparison the way a perfect judge would: the smaller id is better. */
function playOut(s: BinarySession): { session: BinarySession; placements: Placement[] } {
  const placements: Placement[] = [];
  let session = s;
  let id = session.current;
  let clicks = s.clicks;
  let locked = s.sorted.length;
  let budget = stepsLeft(session);

  while (session.current !== null && id !== null) {
    const pivot = session.sorted[pivotIndex(session)];
    session = chooseBinary(session, session.current < pivot ? "challenger" : "pivot");
    if (session.current !== id) {
      placements.push({ id, locked, clicks: session.clicks - clicks, budget });
      id = session.current;
      clicks = session.clicks;
      locked = session.sorted.length;
      budget = stepsLeft(session);
    }
  }
  return { session, placements };
}

describe("createBinarySession", () => {
  it("locks the first id and keeps the rest in order", () => {
    const ids = [7, 2, 9, 4];
    const s = createBinarySession("本命", ids);
    expect(s.tier).toBe("本命");
    expect(s.sorted).toEqual([7]);
    expect(s.current).toBe(2);
    expect(s.queue).toEqual([9, 4]);
    expect(s.low).toBe(0);
    expect(s.high).toBe(0);
    expect(s.clicks).toBe(0);
    expect(orderedIds(s)).toEqual(ids);
    expect(isDone(s)).toBe(false);
  });

  it("is done with 0 and 1 ids", () => {
    const empty = createBinarySession("未分類", []);
    expect(isDone(empty)).toBe(true);
    expect(empty.sorted).toEqual([]);
    expect(empty.queue).toEqual([]);
    expect(orderedIds(empty)).toEqual([]);
    expect(pivotIndex(empty)).toBe(-1);
    expect(stepsLeft(empty)).toBe(0);
    expect(chooseBinary(empty, "top")).toBe(empty);

    const single = createBinarySession("未分類", [42]);
    expect(isDone(single)).toBe(true);
    expect(single.sorted).toEqual([42]);
    expect(single.current).toBeNull();
    expect(orderedIds(single)).toEqual([42]);
    expect(stepsLeft(single)).toBe(0);
  });

  it("locks sortedCount ids and clamps it to 1..ids.length", () => {
    expect(createBinarySession("順手", [1, 2, 3, 4], 3)).toMatchObject({
      sorted: [1, 2, 3],
      current: 4,
      queue: [],
      low: 0,
      high: 2,
    });
    expect(createBinarySession("順手", [1, 2, 3], 99).sorted).toEqual([1, 2, 3]);
    expect(isDone(createBinarySession("順手", [1, 2, 3], 99))).toBe(true);
    expect(createBinarySession("順手", [1, 2, 3], 0).sorted).toEqual([1]);
    expect(createBinarySession("順手", [1, 2, 3], -5).sorted).toEqual([1]);
  });

  it("does not reorder the list before the first click", () => {
    const ids = [5, 3, 8, 1, 7, 2, 6, 4];
    expect(orderedIds(createBinarySession("本命", ids))).toEqual(ids);
  });

  it("never mutates the ids it is given", () => {
    const ids = Object.freeze([4, 1, 3, 2]);
    createBinarySession("勉強", ids as unknown as number[]);
    expect(ids).toEqual([4, 1, 3, 2]);
  });
});

describe("chooseBinary", () => {
  it("sorts 8 ids ascending when the smaller id always wins", () => {
    const ids = [5, 3, 8, 1, 7, 2, 6, 4];
    const { session, placements } = playOut(createBinarySession("本命", ids));

    expect(session.sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(isDone(session)).toBe(true);
    expect(session.queue).toEqual([]);
    expect(orderedIds(session)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(placements).toHaveLength(7);
    expect(placements.map((p) => p.id)).toEqual([3, 8, 1, 7, 2, 6, 4]);

    // Binary divide: a challenger that starts against `n` locked champions needs ceil(log2(n + 1)) clicks at most.
    for (const p of placements) {
      expect(p.clicks).toBeLessThanOrEqual(Math.ceil(Math.log2(p.locked + 1)));
      expect(p.clicks).toBeLessThanOrEqual(p.budget);
      expect(p.clicks).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns a new session and leaves the old one untouched", () => {
    const before = createBinarySession("愛角", [1, 2, 3]);
    const after = chooseBinary(before, "top");
    expect(after).not.toBe(before);
    expect(before.sorted).toEqual([1]);
    expect(before.current).toBe(2);
    expect(before.clicks).toBe(0);
    expect(after.sorted).toEqual([2, 1]);
    expect(after.current).toBe(3);
    expect(after.clicks).toBe(1);
  });

  it("takes the closer half and resets the range for the next challenger", () => {
    const s = createBinarySession("本命", [1, 2, 3, 4], 3); // sorted 1,2,3; current 4
    const after = chooseBinary(s, "top");
    expect(after.sorted).toEqual([4, 1, 2, 3]);
    expect(after.current).toBeNull();
    expect(after.queue).toEqual([]);
    expect(isDone(after)).toBe(true);
  });

  it("promotes the next queued id after a lock", () => {
    const s = createBinarySession("本命", [1, 2, 3, 4, 5, 6], 3); // sorted 1,2,3; current 4; queue 5,6
    const after = chooseBinary(s, "top");
    expect(after.sorted).toEqual([4, 1, 2, 3]);
    expect(after.current).toBe(5);
    expect(after.queue).toEqual([6]);
    expect(after.low).toBe(0);
    expect(after.high).toBe(3);
    expect(isDone(after)).toBe(false);
  });

  it("anchors a tie right after the pivot", () => {
    const s = createBinarySession("愛角", [1, 2, 3, 4, 5], 4); // sorted 1,2,3,4; pivot index 1
    expect(pivotIndex(s)).toBe(1);
    const after = chooseBinary(s, "tie");
    expect(after.sorted).toEqual([1, 2, 5, 3, 4]);
    expect(after.clicks).toBe(1);
    expect(isDone(after)).toBe(true);
  });

  it("anchors top and bottom at the ends", () => {
    const s = createBinarySession("愛角", [1, 2, 3, 4, 5], 4);
    expect(chooseBinary(s, "top").sorted).toEqual([5, 1, 2, 3, 4]);
    expect(chooseBinary(s, "bottom").sorted).toEqual([1, 2, 3, 4, 5]);
  });

  it("closes one half of the range without locking while it is still open", () => {
    const s = createBinarySession("勉強", [1, 2, 3, 4], 3); // sorted 1,2,3; current 4; range [0,2], pivot 2
    const first = chooseBinary(s, "challenger"); // 4 beats 2 -> high 0, range [0,0]
    expect(first.low).toBe(0);
    expect(first.high).toBe(0);
    expect(first.sorted).toEqual([1, 2, 3]);
    expect(first.current).toBe(4);
    expect(first.clicks).toBe(1);
    expect(isDone(first)).toBe(false);
    const second = chooseBinary(first, "pivot"); // 4 loses to 1 -> low 1 > high 0, lock at 1
    expect(second.sorted).toEqual([1, 4, 2, 3]);
    expect(second.clicks).toBe(2);
    expect(isDone(second)).toBe(true);
  });

  it("locks immediately when the answer empties the range", () => {
    const s = createBinarySession("勉強", [1, 2], 1); // sorted 1; current 2; range [0,0]
    const after = chooseBinary(s, "pivot");
    expect(after.sorted).toEqual([1, 2]);
    expect(isDone(after)).toBe(true);
    expect(s.sorted).toEqual([1]);
  });

  it("is a no-op on a sorted session", () => {
    const done = createBinarySession("封印", [7]);
    expect(isDone(done)).toBe(true);
    for (const action of ["challenger", "pivot", "tie", "top", "bottom"] as const) {
      expect(chooseBinary(done, action)).toBe(done);
    }
    const finished = playOut(createBinarySession("封印", [3, 1, 2])).session;
    expect(chooseBinary(finished, "tie")).toBe(finished);
  });
});

describe("stepsLeft", () => {
  it("bounds the clicks still needed", () => {
    expect(stepsLeft(createBinarySession("本命", [1, 2]))).toBe(1);
    expect(stepsLeft(createBinarySession("本命", [1, 2, 3]))).toBe(1);
    expect(stepsLeft(createBinarySession("本命", [1, 2, 3, 4], 3))).toBe(2);
    expect(stepsLeft(createBinarySession("本命", [1, 2, 3, 4, 5], 4))).toBe(3);
    expect(stepsLeft(createBinarySession("本命", [1, 2, 3, 4, 5, 6, 7, 8, 9], 8))).toBe(4);
  });

  it("is 0 once the tier is sorted", () => {
    expect(stepsLeft(playOut(createBinarySession("本命", [4, 2, 1, 3])).session)).toBe(0);
  });
});

describe("applyTierOrder", () => {
  const roster = (): TierChampion[] => [
    { id: 1, n: "A", t: "本命", f: "" },
    { id: 2, n: "B", t: "愛角", f: "lock" },
    { id: 3, n: "C", t: "本命", f: "" },
    { id: 4, n: "D", t: "愛角", f: "" },
    { id: 5, n: "E", t: "本命", f: "give", secSpell: 12 },
  ];

  it("only moves the slots of that tier", () => {
    const list = roster();
    applyTierOrder(list, "本命", [5, 1, 3]);
    expect(list.map((c) => c.id)).toEqual([5, 2, 1, 4, 3]);
    expect(list.map((c) => c.t)).toEqual(["本命", "愛角", "本命", "愛角", "本命"]);
  });

  it("keeps the same champion objects and their fields", () => {
    const list = roster();
    const before = list.slice();
    applyTierOrder(list, "本命", [5, 3, 1]);
    expect(list[0]).toBe(before[4]);
    expect(list[2]).toBe(before[2]);
    expect(list[4]).toBe(before[0]);
    expect(list[0]).toMatchObject({ id: 5, n: "E", f: "give", secSpell: 12 });
    expect(list[1]).toBe(before[1]);
    expect(list[3]).toBe(before[3]);
  });

  it("puts unlisted members after the listed ones, in their own order", () => {
    const list = roster();
    applyTierOrder(list, "本命", [3]);
    expect(list.map((c) => c.id)).toEqual([3, 2, 1, 4, 5]);
  });

  it("ignores ids that are not in the tier", () => {
    const list = roster();
    applyTierOrder(list, "本命", [2, 999, 5]);
    expect(list.map((c) => c.id)).toEqual([5, 2, 1, 4, 3]);
  });

  it("leaves the list alone when the tier has no members", () => {
    const list = roster();
    const before = list.slice();
    applyTierOrder(list, "封印", [1, 2]);
    expect(list).toEqual(before);
    list.forEach((c, i) => expect(c).toBe(before[i]));
  });

  it("round-trips the order produced by a finished session", () => {
    const ids = [5, 3, 8, 1];
    const list: TierChampion[] = [5, 3, 2, 8, 1].map((id) => ({ id, n: `c${id}`, t: id === 2 ? "愛角" : "本命", f: "" }));
    const { session } = playOut(createBinarySession("本命", ids));
    applyTierOrder(list, "本命", orderedIds(session));
    expect(list.map((c) => c.id)).toEqual([1, 3, 2, 5, 8]);
  });
});

describe("resumeSortedCount", () => {
  it("returns the stored count when the ids still match", () => {
    const saved = { ids: [5, 3, 8], sortedCount: 3 };
    expect(resumeSortedCount(saved, [5, 3, 8])).toBe(3);
    expect(resumeSortedCount({ ids: [5, 3, 8], sortedCount: 1 }, [5, 3, 8])).toBe(1);
  });

  it("falls back to 1 when the ids moved, changed or the entry is garbage", () => {
    const saved = { ids: [5, 3, 8], sortedCount: 3 };
    expect(resumeSortedCount(saved, [3, 5, 8])).toBe(1);
    expect(resumeSortedCount(saved, [5, 3])).toBe(1);
    expect(resumeSortedCount(saved, [...[5, 3, 8], 9])).toBe(1);
    expect(resumeSortedCount(null, [5, 3, 8])).toBe(1);
    expect(resumeSortedCount(undefined, [5, 3, 8])).toBe(1);
    expect(resumeSortedCount("garbage", [5, 3, 8])).toBe(1);
    expect(resumeSortedCount(42, [5, 3, 8])).toBe(1);
    expect(resumeSortedCount({}, [5, 3, 8])).toBe(1);
    expect(resumeSortedCount({ ids: "5,3,8", sortedCount: 3 }, [5, 3, 8])).toBe(1);
    expect(resumeSortedCount({ ids: [5, 3, 8], sortedCount: 0 }, [5, 3, 8])).toBe(1);
    expect(resumeSortedCount({ ids: [5, 3, 8], sortedCount: 2.5 }, [5, 3, 8])).toBe(1);
    expect(resumeSortedCount({ ids: [5, 3, 8], sortedCount: "3" }, [5, 3, 8])).toBe(1);
  });

  it("restores progress into a new session", () => {
    const ids = [5, 3, 8, 1];
    const saved = { ids, sortedCount: 3 };
    const s = createBinarySession("本命", ids, resumeSortedCount(saved, ids));
    expect(s.sorted).toEqual([5, 3, 8]);
    expect(s.current).toBe(1);
    expect(s.queue).toEqual([]);
    // Reordering the tier invalidates the stored progress.
    const moved = [3, 5, 8, 1];
    expect(createBinarySession("本命", moved, resumeSortedCount(saved, moved)).sorted).toEqual([3]);
  });
});
