// Import-file validation for 設定 → 匯入 JSON, kept free of DOM so it can be tested.

/**
 * Why `raw` cannot be imported as an AppConfig, or null when it can. Accepts
 * this app's export / backup files; rejects lab files and anything that would
 * wipe the ranking or break later saves.
 */
export function validateImportedConfig(raw: unknown, tiers: string[], flags: string[]): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "不是設定檔格式（需要 JSON 物件）";
  const cfg = raw as Record<string, unknown>;
  const profiles = [cfg.aram_profile, cfg.mayhem_profile].filter((p) => p !== undefined);
  if (profiles.length === 0) return "缺少英雄優先序（aram_profile）";
  if (profiles.some((p) => !Array.isArray(p))) return "英雄優先序格式無效";
  // Older exports carry a full aram_profile next to an empty mayhem_profile;
  // the app keeps the richer one, so only reject when every list is empty.
  if ((profiles as unknown[][]).every((p) => p.length === 0)) return "英雄優先序是空的";
  for (const profile of profiles as unknown[][]) {
    for (const item of profile) {
      if (!item || typeof item !== "object") return "英雄優先序內有無效項目";
      const p = item as Record<string, unknown>;
      if (!Number.isInteger(p.id) || (p.id as number) <= 0 || (p.id as number) >= 10000) return "英雄 id 無效";
      if (p.name !== undefined && typeof p.name !== "string") return `英雄 ${p.id} 的名稱無效`;
      if (p.tier !== undefined && !tiers.includes(p.tier as string)) return `英雄 ${p.id} 的階層無效`;
      if (p.flag !== undefined && !flags.includes(p.flag as string)) return `英雄 ${p.id} 的標記無效`;
      for (const key of ["elo", "matches", "secondary_spell"]) {
        if (p[key] !== undefined && p[key] !== null && !Number.isFinite(p[key])) return `英雄 ${p.id} 的 ${key} 無效`;
      }
    }
  }
  if (cfg.chat_messages !== undefined) {
    if (!Array.isArray(cfg.chat_messages) || cfg.chat_messages.some((m) => typeof m !== "string")) {
      return "換角發話訊息格式無效";
    }
  }
  return null;
}
