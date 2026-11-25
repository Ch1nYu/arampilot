import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BUILTIN_CHAMPIONS } from "./champions";
import { escapeHtml } from "./html";
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
      return `<details class="match"><summary><span class="t">${escapeHtml(formatMatchTime(r.date, r.time))}</span><span>${escapeHtml(queueModeLabel(r.queueId))}</span><span class="champ">${escapeHtml(champ)}</span><span class="res ${res.cls}">${escapeHtml(res.text)}</span><span class="acts">${escapeHtml(actionsText(r.actions))}</span></summary><div class="log">${logLinesHtml(r.log)}</div></details>`;
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
