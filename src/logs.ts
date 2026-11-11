import { invoke } from "@tauri-apps/api/core";
import { escapeHtml } from "./html";

export interface LogRow {
  time: string;
  kind: "act" | "skip" | "sys" | "err";
  title: string;
  reason: string;
}
const logHistory: LogRow[] = [];
let logFilter: "all" | LogRow["kind"] = "all";

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function addLog(kind: "act" | "skip" | "sys" | "err", title: string, reason: string) {
  const now = new Date();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  logHistory.unshift({ time, kind, title, reason });
  if (logHistory.length > 80) logHistory.pop();
  renderLogs();
  invoke("append_exec_log", { time, kind, title, reason }).catch(() => {});
}
export function renderLogs() {
  const toHtml = (r: LogRow) => `
    <div class="e">
      <span class="t">${r.time}</span>
      <span class="tag ${r.kind}">${{ act: "執行", skip: "略過", sys: "系統", err: "錯誤" }[r.kind]}</span>
      <div>${escapeHtml(r.title)}<span class="reason">${escapeHtml(r.reason)}</span></div>
    </div>`;
  // Overview one-line summary: separate time/text/reason slots in index.html.
  const last = logHistory[0];
  const setText = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setText("logShortTime", last ? last.time : "");
  setText("logShortText", last ? last.title : "尚無紀錄");
  setText("logShortReason", last ? last.reason : "");
  const elFull = document.getElementById("logFull");
  if (elFull) {
    const rows = logFilter === "all" ? logHistory : logHistory.filter((r) => r.kind === logFilter);
    elFull.innerHTML = rows.length
      ? rows.map(toHtml).join("")
      : `<div class="card-desc">目前沒有符合此篩選條件的紀錄。</div>`;
  }
}

/** Registers the log filter buttons; called from main.ts at the original startup point. */
export function initLogFilter() {
  document.getElementById("logFilter")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    logFilter = (b.dataset.v || "all") as typeof logFilter;
    renderLogs();
  });
}
