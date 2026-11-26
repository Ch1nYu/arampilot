import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BUILTIN_CHAMPIONS } from "./champions";
import { ICON, augmentIconUrl, escapeHtml, itemIconUrl } from "./html";
import { queueModeLabel } from "./queues";
import { state } from "./state";

/** One execution-log line of one game, as the backend stored it. */
export interface MatchLogLine {
  date: string;
  time: string;
  kind: "act" | "skip" | "sys" | "err";
  title: string;
  reason: string;
}

/** Rarity of a hex/augment pick; empty when the backend could not resolve it. */
export type AugmentRarity = "silver" | "gold" | "prismatic" | "";

/** One augment the player picked, with the name the backend looked up at write time. */
export interface AugmentPick {
  id: number;
  name: string;
  rarity: AugmentRarity;
}

/** One participant of a finished game, from LCU `/lol-match-history/v1/games/{gameId}`. */
export interface PlayerStats {
  teamId: number;
  win: boolean;
  isMe: boolean;
  /** `gameName#tagLine`; empty when the client did not report it. */
  name: string;
  championId: number;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  damageToChampions: number;
  damageTaken: number;
  healing: number;
  gold: number;
  items: number[];
  augments: AugmentPick[];
  spells: number[];
}

/** Everything the client still knows about one game; old records have no `detail`. */
export interface GameDetail {
  durationSec: number;
  players: PlayerStats[];
}

/** One collected game; `get_match_history` returns these oldest first. */
export interface MatchRecord {
  gameId: number | null;
  date: string; // YYYY-MM-DD, champ select start
  time: string; // HH:MM:SS, champ select start
  queueId: number | null;
  championId: number | null;
  result: "win" | "loss" | "notPlayed" | "unknown";
  actions: string[];
  log: MatchLogLine[];
  /** Full stats of the game; absent for records the client can no longer supply. */
  detail?: GameDetail;
}

/** `2026-11-25` + `20:31:07` -> `11/25 20:31`; malformed input keeps `time` as given. */
export function formatMatchTime(date: string, time: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !t) return time;
  return `${d[2]}/${d[3]} ${t[1]}:${t[2]}`;
}

export function resultLabel(result: MatchRecord["result"]): { text: string; cls: "win" | "loss" | "other" } {
  switch (result) {
    case "win":
      return { text: "勝", cls: "win" };
    case "loss":
      return { text: "敗", cls: "loss" };
    case "notPlayed":
      return { text: "沒開打", cls: "other" };
    default:
      return { text: "未知", cls: "other" };
  }
}

export function actionsText(actions: string[]): string {
  return actions.length ? actions.join(" · ") : "沒有動作";
}

/** `70805` -> `70.8k`; values under 1000 stay whole numbers (`999` -> `999`). */
export function formatK(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`;
}

/** `1127` -> `18:47` (m:ss; games never pass an hour). */
export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const kindLabel = (kind: string) =>
  ({ act: "執行", skip: "略過", sys: "系統", err: "錯誤" } as Record<string, string>)[kind] ?? "系統";

/** Same markup as `renderLogs` in `logs.ts`, because these lines are the same log. */
function logLinesHtml(lines: MatchLogLine[]): string {
  if (!lines.length) return `<div class="card-desc">這場沒有紀錄。</div>`;
  return lines
    .map(
      (r) => `
    <div class="e">
      <span class="t">${escapeHtml(r.time)}</span>
      <span class="tag ${escapeHtml(r.kind)}">${kindLabel(r.kind)}</span>
      <div>${escapeHtml(r.title)}<span class="reason">${escapeHtml(r.reason)}</span></div>
    </div>`,
    )
    .join("");
}

/* ---------- expanded game detail ---------- */

/** 16px on the summary line, 18px in the tables (`.match > summary .augs` / `.match .pl .augs`). */
function augmentIconsHtml(augments: AugmentPick[]): string {
  return augments
    .slice(0, 6)
    .map((a) => {
      const rarity = a.rarity ? ` aug-${a.rarity}` : "";
      return `<img class="aug${rarity}" src="${escapeHtml(augmentIconUrl(a.id))}" alt="" loading="lazy" title="${escapeHtml(a.name.trim() || `#${a.id}`)}">`;
    })
    .join("");
}

/** The ten column labels; the same grid as `.pl` so the numbers line up. */
const tableHeadHtml = `<div class="hd"><span>英雄</span><span>玩家</span><span>等級</span><span>KDA</span><span>傷害</span><span>承受</span><span>金錢</span><span>海克斯</span><span>裝備</span></div>`;

function playerRowHtml(p: PlayerStats, maxDamage: number, nameOf: (id: number) => string): string {
  const bar = maxDamage > 0 ? Math.round((p.damageToChampions / maxDamage) * 100) : 0;
  const name = p.name || nameOf(p.championId);
  const items = p.items
    .slice(0, 7)
    .map((id) => `<img src="${escapeHtml(itemIconUrl(id))}" alt="" loading="lazy">`)
    .join("");
  const cls = p.isMe ? "pl me" : "pl";
  return `<div class="${cls}"><img class="champ-ic" src="${escapeHtml(ICON(p.championId))}" alt="" loading="lazy"><span class="nm">${escapeHtml(name)}</span><span class="lv">Lv${p.level}</span><span class="kda">${p.kills}/${p.deaths}/${p.assists}</span><span class="dmg"><span class="n">${formatK(p.damageToChampions)}</span><span class="bar"><i style="width:${bar}%"></i></span></span><span class="taken">${formatK(p.damageTaken)}</span><span class="gold">${formatK(p.gold)}</span><span class="augs">${augmentIconsHtml(p.augments)}</span><span class="items">${items}</span></div>`;
}

/** One team table; the title carries the result and the team totals. */
function teamBlockHtml(
  title: string,
  players: PlayerStats[],
  maxDamage: number,
  nameOf: (id: number) => string,
): string {
  const kills = players.reduce((sum, p) => sum + p.kills, 0);
  const gold = players.reduce((sum, p) => sum + p.gold, 0);
  const win = players.some((p) => p.win);
  const rows = players.map((p) => playerRowHtml(p, maxDamage, nameOf)).join("");
  return `<div class="team"><div class="team-hd"><b>${escapeHtml(title)}</b> · <span class="res ${win ? "win" : "loss"}">${win ? "勝" : "敗"}</span> · 擊殺 ${kills} · 金錢 ${formatK(gold)}</div>${tableHeadHtml}${rows}</div>`;
}

/** isMe's team first (我方/敵方); without isMe the lower team id first (藍方/紅方). */
function teamBlocks(players: PlayerStats[]): { title: string; players: PlayerStats[] }[] {
  const ids = [...new Set(players.map((p) => p.teamId))].sort((a, b) => a - b);
  const ofTeam = (id: number) => players.filter((p) => p.teamId === id);
  const me = players.find((p) => p.isMe);
  if (!me) return ids.map((id) => ({ title: id === 100 ? "藍方" : "紅方", players: ofTeam(id) }));
  return [
    { title: "我方", players: ofTeam(me.teamId) },
    ...ids.filter((id) => id !== me.teamId).map((id) => ({ title: "敵方", players: ofTeam(id) })),
  ];
}

/** Body of one `<details class="match">`: the log alone, or the two tables plus the folded log. */
function matchBodyHtml(r: MatchRecord, nameOf: (id: number) => string): string {
  const log = `<div class="log">${logLinesHtml(r.log)}</div>`;
  const players = r.detail?.players ?? [];
  if (!r.detail || !players.length) {
    const note = r.result === "notPlayed" ? "" : `<div class="card-desc">用戶端已沒有這場的詳細資料。</div>`;
    return `${note}${log}`;
  }
  const maxDamage = Math.max(...players.map((p) => p.damageToChampions));
  const teams = teamBlocks(players)
    .map((t) => teamBlockHtml(t.title, t.players, maxDamage, nameOf))
    .join("");
  return `<div class="match-dur">遊戲時間 <b>${formatDuration(r.detail.durationSec)}</b></div>${teams}<details class="match-log"><summary>App 做了什麼（${r.log.length} 行）</summary>${log}</details>`;
}

/** One line per game, newest first; the record's own log lines expand below it. */
export function matchListHtml(records: MatchRecord[], nameOf: (id: number) => string): string {
  if (!records.length) {
    return `<div class="card-desc">還沒有對戰紀錄。打完一場 ARAM 或 Mayhem 後會出現在這裡。</div>`;
  }
  return [...records]
    .reverse()
    .map((r) => {
      const res = resultLabel(r.result);
      const champ = r.championId == null ? "—" : nameOf(r.championId);
      const me = r.detail?.players.find((p) => p.isMe);
      const kda = me ? `${me.kills}/${me.deaths}/${me.assists}` : "—";
      const dmg = me ? formatK(me.damageToChampions) : "—";
      const gold = me ? formatK(me.gold) : "—";
      const augs = me ? augmentIconsHtml(me.augments) : "";
      return `<details class="match"><summary><span class="t">${escapeHtml(formatMatchTime(r.date, r.time))}</span><span>${escapeHtml(queueModeLabel(r.queueId))}</span><span class="champ">${escapeHtml(champ)}</span><span class="kda">${kda}</span><span class="dmg">${dmg}</span><span class="gold">${gold}</span><span class="augs">${augs}</span><span class="res ${res.cls}">${escapeHtml(res.text)}</span><span class="acts">${escapeHtml(actionsText(r.actions))}</span></summary>${matchBodyHtml(r, nameOf)}</details>`;
    })
    .join("");
}

/* ---------- 紀錄 page wiring ---------- */

/** Profile name first, then the builtin list, then the raw id. */
function championName(id: number): string {
  const profile = state.profileList.find((p) => p.id === id);
  if (profile?.n) return profile.n;
  const builtin = BUILTIN_CHAMPIONS.find((c) => c.id === id);
  if (builtin) return builtin.n;
  return `ID:${id}`;
}

async function loadMatches() {
  const box = document.getElementById("matchList");
  if (!box) return;
  try {
    const records = await invoke<MatchRecord[]>("get_match_history");
    box.innerHTML = matchListHtml(records, championName);
  } catch (err) {
    box.innerHTML = `<div class="card-desc">讀不到對戰紀錄：${escapeHtml(String(err))}</div>`;
  }
}

/** The log filter only applies to the 執行紀錄 view, so it is hidden with 對戰. */
function showView(view: "matches" | "exec") {
  const matches = view === "matches";
  const show = (id: string, visible: boolean) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? "" : "none";
  };
  show("matchView", matches);
  show("execView", !matches);
  show("logFilter", !matches);
}

/** Registers the 對戰 / 執行紀錄 switch and the first load; called from main.ts. */
export function initMatchHistory() {
  showView("matches"); // the page opens on 對戰, so the log filter starts hidden
  const seg = document.getElementById("logView");
  seg?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || !seg.contains(btn)) return;
    const view = btn.dataset.v === "exec" ? "exec" : "matches";
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    showView(view);
    if (view === "matches") void loadMatches();
  });

  // The nav item and the overview's 查看完整紀錄 link both open this page.
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest('[data-go="log"]')) return;
    void loadMatches();
  });

  listen("match-history-updated", () => {
    void loadMatches();
  }).catch(() => {});
  void loadMatches();
}
