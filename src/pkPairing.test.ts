import { describe, expect, it } from "vitest";
import { createPairMemory, pairKey, pickPair } from "./pkPairing";

type Champ = { id: number };

function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Simulate `rounds` votes on a pool, updating comparison counts like the real vote handler. */
function simulate(size: number, rounds: number, seed: number) {
  const pool: Champ[] = Array.from({ length: size }, (_, i) => ({ id: i + 1 }));
  // Uneven starting counts reproduce the old "catch-up" repetition.
  const comp = new Map(pool.map((c) => [c.id, c.id % 7]));
  const elo = new Map(pool.map((c) => [c.id, 1500 + c.id * 10]));
  const memory = createPairMemory();
  const random = seeded(seed);
  const pairs: [number, number][] = [];
  for (let r = 0; r < rounds; r++) {
    const pair = pickPair(pool, memory, (c) => elo.get(c.id)!, (c) => comp.get(c.id)!, random)!;
    pairs.push([pair[0].id, pair[1].id]);
    pair.forEach((c) => comp.set(c.id, comp.get(c.id)! + 1));
  }
  return pairs;
}

describe("pickPair", () => {
  it("never repeats a pair until every pairing is used (19-champion tier)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const pairs = simulate(19, 60, seed);
      const keys = pairs.map(([a, b]) => pairKey(a, b));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("rests a champion for several rounds after it appears", () => {
    for (const seed of [1, 2, 3]) {
      const pairs = simulate(19, 60, seed);
      const last = new Map<number, number>();
      let minGap = Infinity;
      pairs.forEach((p, r) =>
        p.forEach((id) => {
          if (last.has(id)) minGap = Math.min(minGap, r - last.get(id)!);
          last.set(id, r);
        })
      );
      // Old algorithm let a champion come back after 3 rounds.
      expect(minGap).toBeGreaterThanOrEqual(5);
    }
  });

  it("spreads appearances evenly", () => {
    const counts = new Map<number, number>();
    simulate(19, 60, 7).flat().forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
    const values = [...counts.values()];
    expect(counts.size).toBe(19);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(3);
  });

  it("still returns pairs for tiny pools and null below two", () => {
    expect(pickPair([{ id: 1 }], createPairMemory(), () => 1500, () => 0)).toBeNull();
    const pairs = simulate(2, 5, 1);
    pairs.forEach((p) => expect(new Set(p).size).toBe(2));
  });
});
