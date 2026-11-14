import { escapeHtml, spellIconUrl } from "./html";

/* ---------- Summoner Spells ---------- */
export interface SummonerSpellMeta {
  id: number;
  name: string;
  icon: string;
}

export const FLASH_SPELL_ID = 4;
export const SUMMONER_SPELLS: Record<number, SummonerSpellMeta> = {
  4: { id: 4, name: "閃現", icon: "summoner_flash.png" },
  6: { id: 6, name: "鬼步", icon: "summoner_haste.png" },
  32: { id: 32, name: "雪球", icon: "summoner_mark.png" },
  13: { id: 13, name: "清晰", icon: "summonermana.png" },
  3: { id: 3, name: "虛弱", icon: "summoner_exhaust.png" },
  14: { id: 14, name: "點燃", icon: "summonerignite.png" },
  21: { id: 21, name: "光盾", icon: "summonerbarrier.png" },
  7: { id: 7, name: "治癒", icon: "summoner_heal.png" },
  1: { id: 1, name: "淨化", icon: "summoner_boost.png" },
};
/** Always visible secondary options: Ghost and Mark (snowball). */
export const MAIN_SECONDARY_SPELL_IDS = [6, 32];
/** Secondary options hidden behind the「其他」tray. */
export const EXTRA_SECONDARY_SPELL_IDS = [13, 3, 14, 21, 7, 1];
export const DEFAULT_SECONDARY_SPELL_ID = 6;

export function isSupportedSecondarySpell(id: unknown): id is number {
  return typeof id === "number" && [...MAIN_SECONDARY_SPELL_IDS, ...EXTRA_SECONDARY_SPELL_IDS].includes(id);
}

export function spellName(id: number): string {
  return SUMMONER_SPELLS[id]?.name || "未知技能";
}

export function spellIconHtml(id: number): string {
  const meta = SUMMONER_SPELLS[id];
  return `<img class="spell-ic" src="${spellIconUrl(meta?.icon || "summoner_flash.png")}" data-n="${escapeHtml(
    meta?.name || "技能"
  )}" alt="">`;
}

/** D is spell1Id and F is spell2Id; Flash takes the primary key. */
export function resolveSpellPair(secondaryId: number, primaryKey: string): [number, number] {
  return primaryKey.toUpperCase() === "F" ? [secondaryId, FLASH_SPELL_ID] : [FLASH_SPELL_ID, secondaryId];
}
