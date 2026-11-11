import { backupBeforeBulkEdit } from "./backup";
import { choiceDialog, confirmDialog, promptDialog } from "./dialogs";
import { escapeHtml } from "./html";
import { addLog } from "./logs";
import {
  captureLive,
  isDirty,
  MAX_RANKING_SAVES,
  newSaveId,
  nextSaveName,
  restoreSave,
  type RankingSave,
  type RankingSaveItem,
} from "./rankingSaves";
import { state } from "./state";
import {
  draftVotes,
  eloMap,
  pkComparisonsMap,
  replaceWeights,
  resetDraft,
  resetFlashState,
  syncBattlePool,
  syncFlashPool,
} from "./battle";
import type { ProfileItemConfig } from "./types";

/** Hooks that stay in main.ts and are handed over once by `initRankingSaveBar`. */
export interface RankingSaveBarDeps {
  renderTiers: () => void;
  saveConfigImmediate: () => Promise<boolean>;
}
let deps: RankingSaveBarDeps;

/* ---------- Named Ranking Saves (排序存檔) ---------- */
// The working ranking (`state.profileList` + `eloMap` + `pkComparisonsMap`) keeps
// auto-saving to the config file, but it is not the active save: every save,
// the active one included, stores its own last manual save in `items`. While the
// working ranking differs from the active save it is 未儲存, and 儲存 / 還原 move
// it in and out by hand.

/** Save item → config item; the remembered secondary spell stays per champion. */
export function toProfileItemConfig(item: RankingSaveItem): ProfileItemConfig {
  const out: ProfileItemConfig = { id: item.id, name: item.name, tier: item.tier, flag: item.flag };
  if (item.elo !== undefined) out.elo = item.elo;
  if (item.matches !== undefined) out.matches = item.matches;
  return out;
}

function activeRankingSaveEntry(): RankingSave | undefined {
  return state.rankingSaves.find((s) => s.id === state.activeRankingSave);
}

/** Fill the save bar, the 未儲存 state and the actions that would break a limit. */
export function renderRankingSaveBar() {
  const select = document.getElementById("rankSaveSelect") as HTMLSelectElement | null;
  if (select) {
    select.innerHTML = state.rankingSaves
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join("");
    select.value = state.activeRankingSave;
  }
  const del = document.getElementById("btnRankSaveDelete") as HTMLButtonElement | null;
  if (del) del.disabled = state.rankingSaves.length < 2;
  const add = document.getElementById("btnRankSaveNew") as HTMLButtonElement | null;
  if (add) add.disabled = state.rankingSaves.length >= MAX_RANKING_SAVES;

  const active = activeRankingSaveEntry();
  const dirty = active ? isDirty(active.items, state.profileList, eloMap, pkComparisonsMap) : false;
  const status = document.getElementById("rankSaveStatus");
  if (status) status.hidden = !dirty;
  const save = document.getElementById("btnRankSaveSave") as HTMLButtonElement | null;
  if (save) {
    save.disabled = !dirty;
    save.classList.toggle("primary", dirty);
  }
  const revert = document.getElementById("btnRankSaveRevert") as HTMLButtonElement | null;
  if (revert) revert.hidden = !dirty;
}

/** Copy the working ranking into the active save (儲存 / 儲存並切換). */
function saveWorkingIntoActive() {
  const save = activeRankingSaveEntry();
  if (save) save.items = captureLive(state.profileList, eloMap, pkComparisonsMap);
}

/** Show a save and make it the active one (the working ranking becomes its content). */
function loadSaveIntoLive(save: RankingSave) {
  const restored = restoreSave(save.items, state.profileList);
  state.profileList = restored.list;
  replaceWeights(eloMap, restored.elo);
  replaceWeights(pkComparisonsMap, restored.matches);
  state.activeRankingSave = save.id;
  // Same flash state reset as 重置: the pools belong to the previous ranking.
  resetFlashState();
  deps.renderTiers();
  syncFlashPool();
  syncBattlePool();
}

/** 儲存: the working ranking becomes the active save's content. */
async function saveActiveRankingSave() {
  const save = activeRankingSaveEntry();
  if (!save) return;
  saveWorkingIntoActive();
  renderRankingSaveBar();
  await deps.saveConfigImmediate();
  addLog("act", "已儲存排序存檔", `「${save.name}」`);
}

/** 還原: throw the unsaved working ranking away and reload the active save. */
async function revertActiveRankingSave() {
  const save = activeRankingSaveEntry();
  if (!save) return;
  const draftNote = draftVotes > 0 ? `另有 ${draftVotes} 票二選一草稿尚未套用，會一併捨棄。` : "";
  const body = `畫面上未儲存的修改會捨棄，回到「${save.name}」上次儲存的排序、標記與二選一權重。${draftNote}`;
  if (!(await confirmDialog(`還原「${save.name}」？`, body, "還原"))) return;
  if (draftVotes > 0) resetDraft();
  loadSaveIntoLive(save);
  renderRankingSaveBar();
  await deps.saveConfigImmediate();
  addLog("act", "已還原排序存檔", `「${save.name}」`);
}

async function switchRankingSave(targetId: string) {
  const target = state.rankingSaves.find((s) => s.id === targetId);
  if (!target || target.id === state.activeRankingSave) {
    renderRankingSaveBar();
    return;
  }
  if (draftVotes > 0) {
    const body = `目前有 ${draftVotes} 票二選一草稿尚未套用，切換會捨棄這份草稿。`;
    if (!(await confirmDialog("切換排序存檔？", body, "捨棄並切換"))) {
      renderRankingSaveBar();
      return;
    }
    resetDraft();
  }
  const active = activeRankingSaveEntry();
  if (active && isDirty(active.items, state.profileList, eloMap, pkComparisonsMap)) {
    const choice = await choiceDialog(
      `「${active.name}」有未儲存的修改`,
      `切換前要先把目前的排序儲存到「${active.name}」嗎？`,
      [
        { label: "取消", value: "cancel" },
        { label: "不儲存，直接切換", value: "discard" },
        { label: "儲存並切換", value: "save", primary: true },
      ]
    );
    if (choice !== "save" && choice !== "discard") {
      renderRankingSaveBar();
      return;
    }
    if (choice === "save") saveWorkingIntoActive();
  }
  loadSaveIntoLive(target);
  renderRankingSaveBar();
  await deps.saveConfigImmediate();
  addLog("act", "已切換排序存檔", `「${target.name}」`);
}

async function saveAsNewRankingSave() {
  if (state.rankingSaves.length >= MAX_RANKING_SAVES) return;
  const previous = activeRankingSaveEntry();
  const previousName = previous ? previous.name : "目前的存檔";
  const body = `用畫面上目前的排序開一份新的存檔並切過去；「${previousName}」維持上次儲存的內容。`;
  const name = await promptDialog("複製成新的排序存檔", body, nextSaveName(state.rankingSaves));
  if (name === null) return;
  // The new save starts clean; the old one is left exactly as it was last saved.
  const save: RankingSave = {
    id: newSaveId(),
    name,
    items: captureLive(state.profileList, eloMap, pkComparisonsMap),
  };
  state.rankingSaves.push(save);
  state.activeRankingSave = save.id;
  renderRankingSaveBar();
  await deps.saveConfigImmediate();
  addLog("act", "已複製成新的排序存檔", `「${name}」，之後的儲存都存在這份`);
}

async function renameRankingSave() {
  const save = activeRankingSaveEntry();
  if (!save) return;
  const name = await promptDialog("排序存檔改名", "新的名稱（最多 40 字）。", save.name);
  if (name === null) return;
  save.name = name;
  renderRankingSaveBar();
  await deps.saveConfigImmediate();
  addLog("act", "已重新命名排序存檔", `「${name}」`);
}

async function deleteRankingSave() {
  if (state.rankingSaves.length < 2) return;
  const save = activeRankingSaveEntry();
  if (!save) return;
  const remaining = state.rankingSaves.filter((s) => s.id !== save.id);
  const next = remaining[0];
  const dirtyNote = isDirty(save.items, state.profileList, eloMap, pkComparisonsMap)
    ? "畫面上未儲存的修改也會一併捨棄。"
    : "";
  const draftNote = draftVotes > 0 ? `另有 ${draftVotes} 票二選一草稿尚未套用，會一併捨棄。` : "";
  const body = `這份存檔的排序、標記與二選一權重會刪除，改用「${next.name}」。${dirtyNote}${draftNote}刪除前會先自動備份到 backups/。`;
  if (!(await confirmDialog(`刪除排序存檔「${save.name}」？`, body, "備份並刪除"))) return;
  if (!(await backupBeforeBulkEdit("delete-ranking-save", "刪除存檔"))) return;
  if (draftVotes > 0) resetDraft();
  state.rankingSaves = remaining;
  // Load the next save the way 切換 does, but without capturing the deleted one.
  loadSaveIntoLive(next);
  renderRankingSaveBar();
  await deps.saveConfigImmediate();
  addLog("act", "已刪除排序存檔", `「${save.name}」，改用「${next.name}」`);
}

/** Register the save-bar listeners; called where the section used to run. */
export function initRankingSaveBar(d: RankingSaveBarDeps) {
  deps = d;
  document.getElementById("rankSaveSelect")?.addEventListener("change", (e) => {
    void switchRankingSave((e.target as HTMLSelectElement).value);
  });
  document.getElementById("btnRankSaveNew")?.addEventListener("click", () => void saveAsNewRankingSave());
  document.getElementById("btnRankSaveSave")?.addEventListener("click", () => void saveActiveRankingSave());
  document.getElementById("btnRankSaveRevert")?.addEventListener("click", () => void revertActiveRankingSave());
  document.getElementById("btnRankSaveRename")?.addEventListener("click", () => void renameRankingSave());
  document.getElementById("btnRankSaveDelete")?.addEventListener("click", () => void deleteRankingSave());
}
