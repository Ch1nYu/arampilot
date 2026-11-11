import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { choiceDialog } from "./dialogs";
import { addLog } from "./logs";
import { state } from "./state";
import { friendlyUpdateError, isBusyPhase, progressLabel, releaseNotes } from "./updater";

/* ---------- App Update (版本與更新) ---------- */
let appVersion = "";
let appVersionText: HTMLElement | null;
let updateStatusText: HTMLElement | null;
let btnCheckUpdate: HTMLButtonElement | null;

function setUpdateStatus(text: string) {
  if (updateStatusText) updateStatusText.textContent = text;
}

/** Release notes, prefixed with a warning when a relaunch would interrupt a game. */
function updateDialogBody(body: string | undefined): string {
  const notes = releaseNotes(body);
  if (!isBusyPhase(state.lastKnownPhase)) return notes;
  return `更新會關閉並重開 App，遊戲本身不受影響。\n${notes}`;
}

/**
 * Ask the updater once. `silent` is the startup probe: it only reports through the
 * status line and the log page, and still opens the dialog when a release exists.
 */
async function checkForUpdate(silent: boolean) {
  if (btnCheckUpdate) btnCheckUpdate.disabled = true;
  if (!silent) setUpdateStatus("檢查中…");
  try {
    const update = await check();
    if (!update) {
      setUpdateStatus("已是最新版本");
      if (silent) addLog("sys", "已是最新版本", appVersion ? `目前版本 v${appVersion}` : "已是最新版本");
      return;
    }
    setUpdateStatus(`有新版本 v${update.version}`);
    const choice = await choiceDialog(`有新版本 v${update.version}`, updateDialogBody(update.body), [
      { label: "立即更新", value: "install", primary: true },
      { label: "稍後", value: "later" },
    ]);
    if (choice === "install") await installUpdate(update);
    // User deferred: release the backend resource so the downloaded bytes are not held.
    else update.close().catch(() => {});
  } catch (err) {
    const message = friendlyUpdateError(String(err));
    setUpdateStatus(message);
    if (silent) addLog("sys", message, String(err));
  } finally {
    if (btnCheckUpdate) btnCheckUpdate.disabled = false;
  }
}

/** Download + install, then relaunch. Any failure leaves the app running and the button usable. */
async function installUpdate(update: Update) {
  let downloaded = 0;
  let total: number | undefined;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
      } else {
        setUpdateStatus("安裝中…");
        return;
      }
      setUpdateStatus(progressLabel(downloaded, total));
    });
    setUpdateStatus("安裝中…");
    await relaunch();
  } catch (err) {
    setUpdateStatus(friendlyUpdateError(String(err)));
    addLog("err", "更新失敗", String(err));
  }
}

export function initUpdaterUi() {
  appVersionText = document.getElementById("appVersionText");
  updateStatusText = document.getElementById("updateStatusText");
  btnCheckUpdate = document.getElementById("btnCheckUpdate") as HTMLButtonElement | null;
  getVersion()
    .then((version) => {
      appVersion = version;
      if (appVersionText) appVersionText.textContent = `v${version}`;
    })
    .catch((err) => console.warn("Could not read app version:", err));
  btnCheckUpdate?.addEventListener("click", () => {
    checkForUpdate(false).catch(console.error);
  });
  // One background probe shortly after startup; it never interrupts the user
  // with a dialog unless a newer release really exists.
  setTimeout(() => {
    checkForUpdate(true).catch(console.error);
  }, 5000);
}
