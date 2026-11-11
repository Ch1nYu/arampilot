export const ICON = (id: number) =>
  `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${id}.png`;

export const img = (id: number, n: string) => `<img src="${ICON(id)}" data-n="${escapeHtml(n)}" alt="">`;

/** Escape every dynamic string before it is concatenated into innerHTML. */
export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
