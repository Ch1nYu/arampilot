/* ---------- Queue mode mapping ---------- */
export const MAYHEM_QUEUE_IDS = new Set([2400, 2410, 3270]);
export const ARAM_QUEUE_IDS = new Set([450, 720, 721, 860, 3200, 3210, 3220, 3230]);
export const PHASE_LABELS: Record<string, string> = {
  None: "待機",
  Lobby: "大廳",
  Matchmaking: "配對中",
  ReadyCheck: "接受對戰",
  ChampSelect: "選角",
  InProgress: "遊戲中",
  EndOfGame: "結算",
};

export function queueModeLabel(queueId: number | null | undefined): string {
  if (queueId == null) return "其他";
  if (MAYHEM_QUEUE_IDS.has(queueId)) return "Mayhem";
  if (ARAM_QUEUE_IDS.has(queueId)) return "ARAM";
  return "其他";
}

export function signedDiff(diff: number | null): string {
  if (diff == null) return "—";
  return `${diff >= 0 ? "+" : ""}${diff}`;
}
