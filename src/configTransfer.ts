import { backupBeforeBulkEdit } from "./backup";
import { validateImportedConfig } from "./importValidation";
import { addLog } from "./logs";
import { FLAGS, TIER_NAMES } from "./tiers";
import type { AppConfig } from "./types";

/** Hooks that stay in main.ts and are handed over once by `initConfigTransfer`. */
export interface ConfigTransferDeps {
  collectConfig: () => AppConfig;
  applyConfigToUI: (cfg: AppConfig) => void;
  saveConfigImmediate: () => Promise<boolean>;
}
let deps: ConfigTransferDeps;

/* ---------- General Settings: JSON Export / Import ---------- */

/** Register the export / import listeners; called where the section used to run. */
export function initConfigTransfer(d: ConfigTransferDeps) {
  deps = d;
  document.getElementById("btnExportJson")?.addEventListener("click", async () => {
    const text = JSON.stringify(deps.collectConfig(), null, 2);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const suggested = `aram-assistant-config-${stamp}.json`;
    const picker = (window as any).showSaveFilePicker as undefined | ((o: unknown) => Promise<any>);
    try {
      if (picker) {
        // Native save dialog (WebView2 File System Access API): user picks folder and name.
        const handle = await picker({
          suggestedName: suggested,
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        addLog("act", "已匯出設定檔", handle.name);
        return;
      }
      // Fallback: plain download into the default Downloads folder.
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = suggested;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      addLog("act", "已匯出設定檔", `${suggested}（存到下載資料夾）`);
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return; // user cancelled the dialog
      addLog("err", "匯出設定檔失敗", String(e));
    }
  });

  document.getElementById("btnImportJson")?.addEventListener("click", () => {
    (document.getElementById("importFile") as HTMLInputElement | null)?.click();
  });

  document.getElementById("importFile")?.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse((await file.text()).replace(/^﻿/, ""));
      const problem = validateImportedConfig(parsed, TIER_NAMES, FLAGS);
      if (problem) {
        addLog("err", "匯入設定檔失敗", `${file.name}：${problem}；目前設定未變動`);
        return;
      }
      if (!(await backupBeforeBulkEdit("import", "匯入"))) return;
      deps.applyConfigToUI(parsed as AppConfig);
      if (await deps.saveConfigImmediate()) addLog("act", "已匯入設定檔", `${file.name}（匯入前設定已備份到 backups/）`);
    } catch (err) {
      addLog("err", "匯入設定檔失敗", String(err));
    } finally {
      input.value = "";
    }
  });
}
