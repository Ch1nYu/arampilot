import { invoke } from "@tauri-apps/api/core";
import { addLog, pad2 } from "./logs";

/* ---------- Confirm dialog & safety backup ---------- */
/** Local `YYYYMMDD-HHMMSS`, the stamp format the backend accepts for backup names. */
export function backupStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(
    d.getMinutes()
  )}${pad2(d.getSeconds())}`;
}

/** Snapshot the saved config before a bulk edit; false (and logged) when the backup failed. */
export async function backupBeforeBulkEdit(reason: string, what: string): Promise<boolean> {
  try {
    await invoke("backup_config_snapshot", { reason, stamp: backupStamp() });
    return true;
  } catch (err) {
    addLog("err", `備份失敗，${what}已取消`, String(err));
    return false;
  }
}
