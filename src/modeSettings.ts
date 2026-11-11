// Shared ARAM/Mayhem mode settings: defaults, config normalization and the
// mirrored-profile pick. Pure data, no DOM and no tauri.

import { DEFAULT_SECONDARY_SPELL_ID, isSupportedSecondarySpell } from "./spells";
import type { ModeSettings, ProfileItemConfig } from "./types";

export function defaultModeSettings(): ModeSettings {
  return {
    auto_card_select: true,
    card_select_delay_sec: 1.5,
    card_select_strategy: "highest_score",
    auto_card_execute: false,
    auto_bench_swap: true,
    auto_bench_execute: false,
    bench_diff_threshold: 10,
    lock_stop_bench: true,
    stop_bench_remaining_sec: 5,
    auto_trade: true,
    trade_accept_diff: 10,
    trade_reject_tiers: ["本命"],
    friend_trade_policy: "manual",
    default_secondary_spell: DEFAULT_SECONDARY_SPELL_ID,
  };
}

export const ACCEPT_MODE_OPTIONS = ["ARAM", "Mayhem", "其他"];

export const REJECT_TIER_VALUES: Record<string, string[]> = {
  "本命": ["本命"],
  "本命愛角": ["本命", "愛角"],
  "": [],
};

export function rejectTiersToValue(tiers: string[]): string {
  const top = tiers.includes("本命");
  const love = tiers.includes("愛角");
  if (top && love) return "本命愛角";
  return top ? "本命" : "";
}

export function normalizeAcceptModes(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string" && ACCEPT_MODE_OPTIONS.includes(x))
    : [];
  return list.length > 0 ? list : ["ARAM", "Mayhem"];
}

export function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function pickNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function normalizeModeSettings(src: ModeSettings | undefined): ModeSettings {
  const d = defaultModeSettings();
  const s = (src && typeof src === "object" ? src : {}) as Partial<ModeSettings>;
  return {
    auto_card_select: pickBool(s.auto_card_select, d.auto_card_select),
    card_select_delay_sec: pickNumber(s.card_select_delay_sec, d.card_select_delay_sec),
    card_select_strategy: pickString(s.card_select_strategy, d.card_select_strategy),
    auto_card_execute: pickBool(s.auto_card_execute, d.auto_card_execute),
    auto_bench_swap: pickBool(s.auto_bench_swap, d.auto_bench_swap),
    auto_bench_execute: pickBool(s.auto_bench_execute, d.auto_bench_execute),
    bench_diff_threshold: pickNumber(s.bench_diff_threshold, d.bench_diff_threshold),
    lock_stop_bench: pickBool(s.lock_stop_bench, d.lock_stop_bench),
    stop_bench_remaining_sec: pickNumber(s.stop_bench_remaining_sec, d.stop_bench_remaining_sec),
    auto_trade: pickBool(s.auto_trade, d.auto_trade),
    trade_accept_diff: pickNumber(s.trade_accept_diff, d.trade_accept_diff),
    trade_reject_tiers: Array.isArray(s.trade_reject_tiers)
      ? s.trade_reject_tiers.filter((x): x is string => typeof x === "string")
      : [...d.trade_reject_tiers],
    friend_trade_policy: pickString(s.friend_trade_policy, d.friend_trade_policy),
    default_secondary_spell: isSupportedSecondarySpell(s.default_secondary_spell)
      ? s.default_secondary_spell
      : d.default_secondary_spell,
  };
}

/** Pick the richer of the two mirrored profiles (classified count first, then 本命 count). */
export function richerProfile(aram: ProfileItemConfig[], mayhem: ProfileItemConfig[]): ProfileItemConfig[] {
  const classified = (list: ProfileItemConfig[]) => list.filter((p) => p.tier !== "未分類").length;
  const mainPicks = (list: ProfileItemConfig[]) => list.filter((p) => p.tier === "本命").length;
  const mayhemClassified = classified(mayhem);
  const aramClassified = classified(aram);
  if (mayhemClassified !== aramClassified) return mayhemClassified > aramClassified ? mayhem : aram;
  if (mayhem.length === 0) return aram;
  return mainPicks(mayhem) > mainPicks(aram) ? mayhem : aram;
}
