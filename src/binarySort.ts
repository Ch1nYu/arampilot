// Binary-divide ordering of one tier, kept free of DOM so the sorting screen can drive it later.
// Ported from the algo lab mockup (createTierSession / currentPivotIndex / insertCurrentAt / binaryChoose /
// getTierOrderedList). Every state change returns a new session, so callers can keep an undo stack.

import type { TierChampion } from "./types";

/** One tier mid-sort: locked champions first (best at index 0), then the challenger, then the queue. */
export interface BinarySession {
  tier: string;
  /** Locked ids, best first. */
  sorted: number[];
  /** Challenger being placed; null once the tier is sorted. */
  current: number | null;
  /** Waiting ids, in their original order. */
  queue: number[];
  /** Open range inside `sorted`, inclusive. */
  low: number;
  high: number;
  clicks: number;
}

export type BinaryAction = "challenger" | "pivot" | "tie" | "top" | "bottom";

/**
 * Start sorting `tier`. `ids` is the tier's current order; the first `sortedCount` ids count as already
 * locked (clamped to 1..ids.length, default 1), the next id becomes the challenger, the rest wait in the
 * queue. The input array is never touched.
 */
export function createBinarySession(tier: string, ids: number[], sortedCount = 1): BinarySession {
  const locked = Math.min(Math.max(1, Math.trunc(sortedCount) || 1), ids.length);
  return {
    tier,
    sorted: ids.slice(0, locked),
    current: locked < ids.length ? ids[locked] : null,
    queue: ids.slice(locked + 1),
    low: 0,
    high: locked - 1,
    clicks: 0,
  };
}

/** True once every champion of the tier is locked. */
export function isDone(s: BinarySession): boolean {
  return s.current === null;
}

/** Middle of the still-open range, or -1 once the tier is sorted. */
export function pivotIndex(s: BinarySession): number {
  return isDone(s) ? -1 : Math.floor((s.low + s.high) / 2);
}

/** Place the challenger at `index`, then promote the next queued champion into the open range. */
function lockCurrent(s: BinarySession, index: number, current: number): void {
  s.sorted.splice(index, 0, current);
  s.current = s.queue.length > 0 ? s.queue[0] : null;
  s.queue = s.queue.slice(1);
  s.low = 0;
  s.high = s.sorted.length - 1;
}

/**
 * Answer the current comparison. `challenger` / `pivot` close that half of the range and lock the
 * challenger as soon as the range is empty; `tie` / `top` / `bottom` lock it immediately. Each call
 * costs one click, and a sorted session is returned unchanged.
 */
export function chooseBinary(s: BinarySession, action: BinaryAction): BinarySession {
  const current = s.current;
  if (current === null) return s;

  const mid = Math.floor((s.low + s.high) / 2);
  const next: BinarySession = {
    ...s,
    sorted: s.sorted.slice(),
    queue: s.queue.slice(),
    clicks: s.clicks + 1,
  };

  if (action === "challenger") {
    next.high = mid - 1;
    if (next.low > next.high) lockCurrent(next, next.low, current);
  } else if (action === "pivot") {
    next.low = mid + 1;
    if (next.low > next.high) lockCurrent(next, next.low, current);
  } else if (action === "tie") {
    lockCurrent(next, mid + 1, current);
  } else if (action === "top") {
    lockCurrent(next, 0, current);
  } else {
    lockCurrent(next, next.sorted.length, current);
  }
  return next;
}

/** Locked + challenger + queue: the tier's ids in the order the list should show them. */
export function orderedIds(s: BinarySession): number[] {
  return [...s.sorted, ...(s.current === null ? [] : [s.current]), ...s.queue];
}

/** Worst-case clicks left to lock the challenger; 0 once the tier is sorted. */
export function stepsLeft(s: BinarySession): number {
  return isDone(s) ? 0 : Math.ceil(Math.log2(s.high - s.low + 2));
}

/**
 * Reorder, in place, the members of `tier` inside `list` so they follow `ids`. Only the slots that tier
 * already occupies move; other tiers keep their positions and every champion keeps its object (fields such
 * as `secSpell` travel with it). Tier members missing from `ids` keep their relative order at the end, and
 * ids that are not in the tier are ignored.
 */
export function applyTierOrder(list: TierChampion[], tier: string, ids: number[]): void {
  const slots: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].t === tier) slots.push(i);
  }
  if (slots.length === 0) return;

  const members = slots.map((i) => list[i]);
  const taken = members.map(() => false);
  const ordered: TierChampion[] = [];
  for (const id of ids) {
    const at = members.findIndex((c, i) => !taken[i] && c.id === id);
    if (at < 0) continue;
    taken[at] = true;
    ordered.push(members[at]);
  }
  members.forEach((c, i) => {
    if (!taken[i]) ordered.push(c);
  });
  slots.forEach((slot, i) => {
    list[slot] = ordered[i];
  });
}

/**
 * Resume support: `saved` is the { ids, sortedCount } stored earlier. Returns its `sortedCount` when the
 * saved ids match `currentIds` exactly (same ids, same order), else 1 — a reordered or garbage entry means
 * the old progress no longer describes the tier.
 */
export function resumeSortedCount(saved: unknown, currentIds: number[]): number {
  if (saved === null || typeof saved !== "object") return 1;
  const { ids, sortedCount } = saved as { ids?: unknown; sortedCount?: unknown };
  if (!Array.isArray(ids) || ids.length !== currentIds.length) return 1;
  if (!ids.every((id, i) => id === currentIds[i])) return 1;
  if (typeof sortedCount !== "number" || !Number.isInteger(sortedCount) || sortedCount < 1) return 1;
  return sortedCount;
}
