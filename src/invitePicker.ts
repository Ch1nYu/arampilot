// Auto-accept-invite settings card: pure helpers plus the one DOM renderer.
// The data comes from the Tauri command `get_friend_directory`
// (src-tauri/src/invites.rs friend_directory()).

import { escapeHtml } from "./html";

/** Shape returned by `get_friend_directory`; group `id` mirrors the LCU value. */
export interface FriendDirectory {
  groups: { id: unknown; name: string }[];
  friends: { puuid: string; name: string; groupName: string }[];
}

/**
 * Display label for a friend group. LCU's catch-all group is named
 * `**Default`; show it as 未分組. Other names pass through, trimmed.
 */
export function groupLabel(name: string): string {
  const trimmed = name.trim();
  return trimmed === "**Default" ? "未分組" : trimmed;
}

/**
 * Merge the last saved invite selection with what the picker currently
 * shows. Saved entries that are not in `shown` (friends of another account,
 * or the directory not loaded yet) stay selected; the ticked chips are
 * appended in `shown` order. The result is deduped, kept saved entries first.
 */
export function mergeSelection(saved: string[], shown: string[], selectedShown: string[]): string[] {
  const shownSet = new Set(shown);
  const selectedSet = new Set(selectedShown);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const v of saved) if (!shownSet.has(v)) push(v);
  for (const v of shown) if (selectedSet.has(v)) push(v);
  return out;
}

/**
 * Fill both chip containers from the directory; a chip is pre-ticked when its
 * value is in the saved list. Friend names and puuids are user-controlled, so
 * every dynamic string goes through escapeHtml before hitting innerHTML.
 */
export function renderInvitePicker(dir: FriendDirectory, savedGroups: string[], savedPuuids: string[]): void {
  const groupsEl = document.getElementById("cfgInviteGroups");
  const friendsEl = document.getElementById("cfgInviteFriends");
  if (!groupsEl || !friendsEl) return;
  const chip = (value: string, label: string, on: boolean) =>
    `<button${on ? ' class="on"' : ""} data-v="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
  groupsEl.innerHTML = dir.groups
    .map((g) => chip(g.name, groupLabel(g.name), savedGroups.includes(g.name)))
    .join("");
  friendsEl.innerHTML = dir.friends
    .map((f) => chip(f.puuid, f.name, savedPuuids.includes(f.puuid)))
    .join("");
}
