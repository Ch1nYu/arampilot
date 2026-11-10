// Named ranking saves: pure data logic, no DOM and no Tauri calls.
//
// Manual-save model. The working ranking (`profileList` + `eloMap` +
// `pkComparisonsMap`) keeps auto-saving to the config file so the automation and
// a restart never lose it, but it is NOT the active save: every save, the active
// one included, holds its own last manual save in `items`. The working ranking is
// "dirty" while it differs from the active save's `items`; 儲存 copies it in,
// 還原 loads `items` back out.

export interface RankingSaveItem {
  id: number;
  name: string;
  tier: string;
  flag: string;
  elo?: number;
  matches?: number;
}

export interface RankingSave {
  id: string;
  name: string;
  items: RankingSaveItem[];
}

/** The live ranking entry (`TierChampion` in main.ts). */
export interface LiveChampion {
  id: number;
  n: string;
  t: string;
  f: string;
  secSpell?: number;
}

/** Keep in step with `MAX_RANKING_SAVES` / `MAX_RANKING_SAVE_NAME` in config.rs. */
export const MAX_RANKING_SAVES = 20;
export const MAX_RANKING_SAVE_NAME = 40;

const UNRANKED_TIER = "未分類";

/** `rs-<now base36>-<4 random base36 chars>`; unique enough for a local config file. */
export function newSaveId(now = Date.now(), rand = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += Math.floor(rand() * 36).toString(36);
  return `rs-${now.toString(36)}-${suffix}`;
}

/** `存檔 N` with the smallest N that is not already taken. */
export function nextSaveName(saves: RankingSave[]): string {
  const used = new Set(saves.map((s) => s.name));
  let n = 1;
  while (used.has(`存檔 ${n}`)) n++;
  return `存檔 ${n}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Trim, cut to `MAX_RANKING_SAVE_NAME`, and fall back to the next free `存檔 N`. */
function normalizeSaveName(raw: unknown, savesSoFar: RankingSave[]): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const name = trimmed || nextSaveName(savesSoFar);
  return Array.from(name).slice(0, MAX_RANKING_SAVE_NAME).join("");
}

/** Champion entries of one save: valid ids only, deduped, order preserved. */
function normalizeItems(raw: unknown): RankingSaveItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const items: RankingSaveItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const src = entry as Record<string, unknown>;
    const id = src.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id >= 10000) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const item: RankingSaveItem = {
      id,
      name: typeof src.name === "string" ? src.name : "",
      tier: typeof src.tier === "string" ? src.tier : UNRANKED_TIER,
      flag: typeof src.flag === "string" ? src.flag : "",
    };
    const elo = finiteNumber(src.elo);
    if (elo !== undefined) item.elo = elo;
    const matches = finiteNumber(src.matches);
    if (matches !== undefined) item.matches = matches;
    items.push(item);
  }
  return items;
}

/**
 * Whatever the config file holds, turned into a usable save list plus the id of
 * the active save. Never returns an empty list.
 */
export function normalizeSaves(
  saves: unknown,
  activeId: unknown
): { saves: RankingSave[]; activeId: string } {
  const out: RankingSave[] = [];
  const seen = new Set<string>();
  if (Array.isArray(saves)) {
    for (const entry of saves) {
      if (out.length >= MAX_RANKING_SAVES) break;
      if (!entry || typeof entry !== "object") continue;
      const src = entry as Record<string, unknown>;
      const id = typeof src.id === "string" ? src.id : "";
      if (!id.trim() || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: normalizeSaveName(src.name, out), items: normalizeItems(src.items) });
    }
  }
  if (out.length === 0) out.push({ id: newSaveId(), name: "存檔 1", items: [] });
  const wanted = typeof activeId === "string" ? activeId : "";
  const active = out.some((s) => s.id === wanted) ? wanted : out[0].id;
  return { saves: out, activeId: active };
}

/** Snapshot the live ranking into save items, in list order. */
export function captureLive(
  list: LiveChampion[],
  elo: Record<number, number>,
  matches: Record<number, number>
): RankingSaveItem[] {
  return list.map((c) => {
    const item: RankingSaveItem = { id: c.id, name: c.n, tier: c.t, flag: c.f };
    const eloValue = finiteNumber(elo[c.id]);
    if (eloValue !== undefined) item.elo = eloValue;
    const matchesValue = finiteNumber(matches[c.id]);
    if (matchesValue !== undefined) item.matches = matchesValue;
    return item;
  });
}

/**
 * True while the working ranking differs from the save: order, tier, flag and
 * the elo / matches weights per champion (name and secondary spell are ignored).
 * `restoreSave` puts champions the save never saw at the end as 未分類 without
 * weights, so an appended-but-unclassified roster entry is not a difference.
 */
export function isDirty(
  saveItems: RankingSaveItem[],
  list: LiveChampion[],
  elo: Record<number, number>,
  matches: Record<number, number>
): boolean {
  const saved = restoreSave(saveItems, list);
  if (saved.list.length !== list.length) return true;
  for (let i = 0; i < list.length; i++) {
    const a = saved.list[i];
    const b = list[i];
    if (a.id !== b.id || a.t !== b.t || a.f !== b.f) return true;
  }
  const weightsDiffer = (a: Record<number, number>, b: Record<number, number>) => {
    for (const c of list) {
      // Missing and present-but-zero are different: an absent weight means the
      // champion never entered a PK / never carried an elo.
      if (finiteNumber(a[c.id]) !== finiteNumber(b[c.id])) return true;
    }
    return false;
  };
  return weightsDiffer(saved.elo, elo) || weightsDiffer(saved.matches, matches);
}

/**
 * Order, tier, flag and weights come from the save; the name and the remembered
 * secondary spell stay with the champion. Champions the save never saw are kept
 * at the end as 未分類 without weights, so no roster entry is ever lost.
 */
export function restoreSave(
  items: RankingSaveItem[],
  current: LiveChampion[]
): { list: LiveChampion[]; elo: Record<number, number>; matches: Record<number, number> } {
  const byId = new Map(current.map((c) => [c.id, c]));
  const elo: Record<number, number> = {};
  const matches: Record<number, number> = {};
  const list: LiveChampion[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const cur = byId.get(item.id);
    const entry: LiveChampion = { id: item.id, n: cur?.n || item.name, t: item.tier, f: item.flag };
    if (cur?.secSpell !== undefined) entry.secSpell = cur.secSpell;
    list.push(entry);
    if (item.elo !== undefined && Number.isFinite(item.elo)) elo[item.id] = item.elo;
    if (item.matches !== undefined && Number.isFinite(item.matches)) matches[item.id] = item.matches;
  }
  for (const c of current) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const entry: LiveChampion = { id: c.id, n: c.n, t: UNRANKED_TIER, f: "" };
    if (c.secSpell !== undefined) entry.secSpell = c.secSpell;
    list.push(entry);
  }
  return { list, elo, matches };
}
