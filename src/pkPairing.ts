// Pair selection for the 二選一 (pairwise PK) stage, kept free of DOM so it can be tested.

export const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Session memory: when each champion was last shown, and every pair already shown. */
export interface PairMemory {
  lastShown: Map<number, number>;
  seenPairs: Set<string>;
  seq: number;
}

export const createPairMemory = (): PairMemory => ({ lastShown: new Map(), seenPairs: new Set(), seq: 0 });

/**
 * Pick the next pair and record it in `memory`. Rotates through the pool: the champion unseen for
 * longest goes first, every champion sits out a pool-scaled number of rounds after appearing, and a
 * pair is not repeated this session until every alternative for that champion is exhausted.
 */
export function pickPair<T extends { id: number }>(
  pool: T[],
  memory: PairMemory,
  eloOf: (c: T) => number,
  compOf: (c: T) => number,
  random: () => number = Math.random
): [T, T] | null {
  if (pool.length < 2) return null;
  const seq = memory.seq;
  const shownAt = (c: T) => memory.lastShown.get(c.id) ?? -Infinity;
  const restRounds = Math.max(1, Math.floor((pool.length - 2) / 4));
  const rested = (c: T) => shownAt(c) < seq - restRounds;
  const randomOf = <U,>(arr: U[]) => arr[Math.floor(random() * arr.length)];

  // 1. A = longest-unseen rested champion; ties go to the least compared.
  let candidatesA = pool.filter(rested);
  if (candidatesA.length === 0) candidatesA = [...pool];
  const oldestA = Math.min(...candidatesA.map(shownAt));
  const tiedA = candidatesA.filter((c) => shownAt(c) === oldestA);
  const minCompA = Math.min(...tiedA.map(compOf));
  const a = randomOf(tiedA.filter((c) => compOf(c) === minCompA));

  // 2. B = a fresh pairing with A, preferring rested and long-unseen champions, then close Elo.
  const filters = [
    (c: T) => c.id !== a.id && rested(c) && !memory.seenPairs.has(pairKey(a.id, c.id)),
    (c: T) => c.id !== a.id && !memory.seenPairs.has(pairKey(a.id, c.id)),
    (c: T) => c.id !== a.id,
  ];
  let candidatesB: T[] = [];
  for (const f of filters) {
    candidatesB = pool.filter(f);
    if (candidatesB.length > 0) break;
  }
  candidatesB.sort((x, y) => shownAt(x) - shownAt(y));
  const longUnseen = candidatesB.slice(0, Math.max(3, Math.ceil(candidatesB.length / 3)));
  longUnseen.sort((x, y) => Math.abs(eloOf(x) - eloOf(a)) - Math.abs(eloOf(y) - eloOf(a)));
  const b = randomOf(longUnseen.slice(0, 2));

  memory.lastShown.set(a.id, seq);
  memory.lastShown.set(b.id, seq);
  memory.seenPairs.add(pairKey(a.id, b.id));
  memory.seq += 1;
  return random() < 0.5 ? [b, a] : [a, b];
}
