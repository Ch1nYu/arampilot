/**
 * Pure helpers for the in-app update card (版本與更新). No DOM, no Tauri imports:
 * `main.ts` owns the plugin calls and the rendering, this module owns the strings.
 */

/** Gameflow phases where a relaunch would interrupt the player. */
const BUSY_PHASES = ["ChampSelect", "GameStart", "InProgress", "Reconnect"];

/** Release notes shown in the update dialog; long notes are cut so the dialog stays readable. */
const NOTES_MAX = 600;

/**
 * Turn a raw updater error into one short Traditional Chinese line.
 * Order matters: the release-JSON and signature texts are the most specific ones.
 */
export function friendlyUpdateError(raw: string): string {
  const text = raw ?? "";
  if (text.includes("Could not fetch a valid release JSON")) return "目前沒有可用的發布版本";
  if (text.toLowerCase().includes("signature")) return "更新檔簽章驗證失敗，已取消安裝";
  const lower = text.toLowerCase();
  const networkish = ["error sending request", "dns", "timed out", "connect"];
  if (networkish.some((needle) => lower.includes(needle))) return "無法連線到更新伺服器";
  return "檢查更新失敗";
}

/** True while the player is in champ select or in a game, where the update dialog needs a warning. */
export function isBusyPhase(phase: string): boolean {
  return BUSY_PHASES.includes(phase);
}

/** `下載中 45%` when the total size is known, `下載中 1.2 MB` otherwise. */
export function progressLabel(downloaded: number, total: number | undefined): string {
  if (total !== undefined && total > 0) {
    const pct = Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
    return `下載中 ${pct}%`;
  }
  return `下載中 ${(downloaded / (1024 * 1024)).toFixed(1)} MB`;
}

/** Trimmed release notes, cut to 600 chars with `…`, falling back to 沒有更新說明. */
export function releaseNotes(body: string | undefined | null): string {
  const text = (body ?? "").trim();
  if (!text) return "沒有更新說明";
  if (text.length > NOTES_MAX) return `${text.slice(0, NOTES_MAX)}…`;
  return text;
}
