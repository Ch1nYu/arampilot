// Champion tiers, flags and score math. Pure data, no DOM and no tauri.

import { BUILTIN_CHAMPIONS } from "./champions";
import type { TierChampion } from "./types";

/* ---------- Champions & Tiers Data ---------- */

export const UNRANKED_BASELINE_SCORE = 40;

export function createDefaultRoster(): TierChampion[] {
  return BUILTIN_CHAMPIONS.map((c) => ({ id: c.id, n: c.n, t: "未分類", f: "" }));
}

export function ensureAllBuiltinChampions(target: TierChampion[]) {
  const byId = new Map(target.map((c) => [c.id, c]));
  for (const item of BUILTIN_CHAMPIONS) {
    if (!byId.has(item.id)) {
      const fresh: TierChampion = { id: item.id, n: item.n, t: "未分類", f: "" };
      target.push(fresh);
      byId.set(item.id, fresh);
    }
  }
}

export const TIERS: [string, number | null, number | null][] = [
  ["本命", 100, 90],
  ["愛角", 89, 75],
  ["順手", 74, 60],
  ["勉強", 59, 40],
  ["封印", 39, 10],
  ["未分類", null, null],
];
export const TIER_NAMES = TIERS.map(([t]) => t);
export const FLAGS = ["", "lock", "give", "nograb"];
export const FLAG_ICON: Record<string, string> = { lock: "🔒", give: "🎁", nograb: "⛔" };
export const FLAG_NAME: Record<string, string> = { lock: "不換出", give: "隨時可換", nograb: "不搶" };

export function calculateScores(list: TierChampion[]): Record<number, number | null> {
  const out: Record<number, number | null> = {};
  TIERS.forEach(([t, hi, lo]) => {
    const members = list.filter((c) => c.t === t);
    members.forEach((c, i) => {
      out[c.id] =
        hi == null || lo == null ? null : Math.round(hi - (hi - lo) * (members.length > 1 ? i / (members.length - 1) : 0));
    });
  });
  return out;
}

export const TIER_ORDER = ["本命", "愛角", "順手", "勉強", "封印", "未分類"];
