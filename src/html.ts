/** Icons are served from the app's own disk cache through the `icon` protocol (src-tauri/src/icon_cache.rs). */
export const ICON_ORIGIN = "http://icon.localhost";

/** Bumped when the backend re-downloads the icons, so new URLs bypass what the page already loaded. */
let iconRev = 0;
const revQuery = () => (iconRev > 0 ? `?r=${iconRev}` : "");

export const ICON = (id: number) => `${ICON_ORIGIN}/champion/${id}.png${revQuery()}`;
export const spellIconUrl = (file: string) => `${ICON_ORIGIN}/spell/${file}${revQuery()}`;

/** Same icon URL with its revision replaced. */
export function iconUrlWithRev(url: string, rev: number): string {
  return `${url.split("?")[0]}?r=${rev}`;
}

/** Call after the backend refreshed the cache: later renders and the images already on the page reload. */
export function reloadIcons(root: ParentNode): void {
  iconRev += 1;
  root.querySelectorAll<HTMLImageElement>(`img[src^="${ICON_ORIGIN}/"]`).forEach((el) => {
    el.src = iconUrlWithRev(el.src, iconRev);
  });
}

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
