import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BUILTIN_CHAMPIONS } from "./champions";
import { validateImportedConfig } from "./importValidation";
import { classifySaveError, type SaveResult } from "./saveResult";
import { clampUiScalePercent, stepUiScalePercent, UI_SCALE_DEFAULT } from "./uiScale";
import type { AssistPayload } from "./assist";
import { captureLive, normalizeSaves } from "./rankingSaves";
import { initRankingSaveBar, renderRankingSaveBar, toProfileItemConfig } from "./rankingSaveBar";
import { initUpdaterUi } from "./updaterUi";
import {
  applyAssistPayload, effectiveSecondarySpell, handleChampSelectLiveUI, initOverview, lastChampSelectData,
  overviewMyChampId, renderOverviewColumns, resetOverviewMiniCards, setChampUiState,
} from "./overview";
import { state } from "./state";
import { backupBeforeBulkEdit } from "./backup";
import {
  draftVotes,
  eloMap,
  initBattle,
  pkComparisonsMap,
  replaceWeights,
  resetDraft,
  resetFlashState,
  syncBattlePool,
  syncFlashPool,
} from "./battle";
import { escapeHtml, img } from "./html";
import { addLog, initLogFilter } from "./logs";
import { confirmDialog } from "./dialogs";
import {
  activeChkValues,
  activeSegValue,
  checkboxValue,
  initFormControls,
  numberValue,
  setCheckbox,
  setChkValues,
  setRangeValue,
  setSegValue,
  setTextInput,
  textValue,
} from "./formControls";
import {
  normalizeAcceptModes,
  normalizeModeSettings,
  REJECT_TIER_VALUES,
  rejectTiersToValue,
  richerProfile,
} from "./modeSettings";
import {
  calculateScores,
  createDefaultRoster,
  ensureAllBuiltinChampions,
  FLAG_ICON,
  FLAG_NAME,
  FLAGS,
  TIER_NAMES,
  TIERS,
  UNRANKED_BASELINE_SCORE,
} from "./tiers";
import { PHASE_LABELS, queueModeLabel } from "./queues";
import { playBeepAlert, showDesktopNotification } from "./alerts";
import {
  DEFAULT_SECONDARY_SPELL_ID,
  EXTRA_SECONDARY_SPELL_IDS,
  isSupportedSecondarySpell,
  MAIN_SECONDARY_SPELL_IDS,
  resolveSpellPair,
  spellIconHtml,
  spellName,
} from "./spells";
import type {
  ActiveAccount,
  AppConfig,
  ChampionItem,
  ChampionMasteryItem,
  ChampSelectUiState,
  ConnectionStatus,
  LcuEvent,
  ModeSettings,
  ProfileItemConfig,
  TierChampion,
} from "./types";

function primarySpellKeyFromUI(): string {
  return (activeSegValue("cfgPrimarySpellKey") || "D").toUpperCase() === "F" ? "F" : "D";
}

document.addEventListener(
  "error",
  (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "IMG" && t.dataset.n) {
      const s = document.createElement("span");
      s.className = "ph";
      s.textContent = t.dataset.n[0];
      t.replaceWith(s);
    }
  },
  true
);

/* ---------- Window controls ---------- */
const MAXIMIZE_ICON =
  '<svg viewBox="0 0 12 12" stroke="currentColor"><rect x="1.5" y="1.5" width="9" height="9" fill="none"/></svg>';
const RESTORE_ICON =
  '<svg viewBox="0 0 12 12" stroke="currentColor" fill="none"><rect x="1.5" y="4" width="6.5" height="6.5"/><path d="M4 4V1.5h6.5V8H8"/></svg>';

/** Swap the maximize button between the maximize and restore glyphs. */
function renderMaximizeButton(maximized: boolean) {
  const btn = document.getElementById("btnMaximize");
  if (!btn) return;
  btn.title = maximized ? "還原" : "最大化";
  btn.innerHTML = maximized ? RESTORE_ICON : MAXIMIZE_ICON;
}
document.getElementById("btnMinimize")?.addEventListener("click", () => {
  invoke("minimize_window").catch(console.error);
});
document.getElementById("btnMaximize")?.addEventListener("click", () => {
  invoke<boolean>("toggle_maximize_window").then(renderMaximizeButton).catch(console.error);
});
// Snapping / Win+Up / double-click maximize without going through the button.
listen<boolean>("window-maximized", (e) => renderMaximizeButton(e.payload)).catch(console.error);
document.getElementById("btnClose")?.addEventListener("click", () => {
  invoke("close_window").catch(console.error);
});
document.getElementById("btnDevStartTest")?.addEventListener("click", () => {
  invoke("dev_start_custom_test")
    .then(() => addLog("sys", "🧪 已啟動自訂大亂鬥選角測試", "1 人自訂房已進入選角"))
    .catch((err) => addLog("err", "啟動自訂測試失敗", String(err)));
});
document.getElementById("btnDevQuitTest")?.addEventListener("click", () => {
  invoke("dev_quit_champ_select")
    .then(() => addLog("sys", "⏹ 已退出自訂房選角", "已安全退回自訂大廳（不啟動遊戲）"))
    .catch((err) => addLog("err", "退出選角失敗", String(err)));
});

/* ---------- Navigation ---------- */
function go(p: string) {
  document.querySelectorAll(".page").forEach((s) => s.classList.toggle("on", s.id === "p-" + p));
  document.querySelectorAll(".nav").forEach((n) => n.classList.toggle("on", (n as HTMLElement).dataset.go === p));
  const c = document.querySelector(".content");
  if (c) c.scrollTop = 0;
}
document.addEventListener("click", (e) => {
  const g = (e.target as HTMLElement).closest("[data-go]") as HTMLElement | null;
  if (g && g.dataset.go) go(g.dataset.go);
});

/* ---------- Generic Controls ---------- */
initFormControls(debouncedSaveConfig);

/* ---------- Shared Mode Settings (ARAM + Mayhem) ---------- */
let ffTime = "08:00";

/**
 * Settings whose input was removed from the 自動化 page because they only mattered
 * while the app acted on its own. The config fields stay, so the last loaded value
 * is carried through every save instead of being reset to the default.
 */
let stopBenchRemainingSec = 5;
let benchRetryIntervalMs = 80;
let chatDelaySec = 1;

/**
 * Internal safety guard owned by the backend: false only when the config file
 * could not be loaded and the app runs on defaults. It has no switch any more;
 * we carry the last value the backend gave us back on every save so a fallback
 * run stays guarded.
 */
let masterEnabled = true;

let acceptModes: string[] = ["ARAM", "Mayhem"];

function readModeSettingsFromUI(): ModeSettings {
  const reject = activeSegValue("rejTier");
  return {
    auto_card_select: checkboxValue("cfgAutoCard", true),
    card_select_delay_sec: numberValue("cfgCardDelay", 1.5),
    card_select_strategy: activeSegValue("cardStrategy") || "highest_score",
    auto_card_execute: checkboxValue("cfgAutoCardExecute", false),
    auto_bench_swap: checkboxValue("cfgAutoBench", true),
    auto_bench_execute: checkboxValue("cfgAutoBenchExecute", false),
    bench_diff_threshold: numberValue("cfgBenchDiff", 10),
    lock_stop_bench: checkboxValue("cfgLockStopBench", true),
    stop_bench_remaining_sec: stopBenchRemainingSec,
    auto_trade: checkboxValue("cfgAutoTrade", true),
    trade_accept_diff: numberValue("thAccept", 10),
    trade_reject_tiers: REJECT_TIER_VALUES[reject] ?? ["本命"],
    friend_trade_policy: activeSegValue("friendTradePolicy") || "manual",
    default_secondary_spell: isSupportedSecondarySpell(state.currentSettings.default_secondary_spell)
      ? state.currentSettings.default_secondary_spell
      : DEFAULT_SECONDARY_SPELL_ID,
  };
}

function writeModeSettingsToUI(s: ModeSettings) {
  setCheckbox("cfgAutoCard", s.auto_card_select);
  setRangeValue("cfgCardDelay", s.card_select_delay_sec);
  setSegValue("cardStrategy", s.card_select_strategy);
  setCheckbox("cfgAutoCardExecute", s.auto_card_execute);
  setCheckbox("cfgAutoBench", s.auto_bench_swap);
  setCheckbox("cfgAutoBenchExecute", s.auto_bench_execute);
  setRangeValue("cfgBenchDiff", s.bench_diff_threshold);
  setCheckbox("cfgLockStopBench", s.lock_stop_bench);
  stopBenchRemainingSec = s.stop_bench_remaining_sec;
  setCheckbox("cfgAutoTrade", s.auto_trade);
  setRangeValue("thAccept", s.trade_accept_diff);
  setSegValue("rejTier", rejectTiersToValue(s.trade_reject_tiers));
  setSegValue("friendTradePolicy", s.friend_trade_policy || "manual");
  renderDefaultSpellPicker();
  fillTradeOptions();
  renderTradeSim();
}

/* ---------- Summoner Spell Pickers ---------- */
let defaultSpellTrayOpen = false;

function currentDefaultSecondarySpell(): number {
  const id = state.currentSettings.default_secondary_spell;
  return isSupportedSecondarySpell(id) ? id : DEFAULT_SECONDARY_SPELL_ID;
}

function spellButtonHtml(id: number, selected: boolean, extraAttrs = ""): string {
  return `<button class="spell-btn${selected ? " on" : ""}" ${extraAttrs} title="${escapeHtml(
    spellName(id)
  )}">${spellIconHtml(id)}<span>${escapeHtml(spellName(id))}</span></button>`;
}

/** Settings card picker: Ghost + Snowball always visible, the rest in「其他」. */
function renderDefaultSpellPicker() {
  const el = document.getElementById("cfgDefaultSpellPicker");
  if (!el) return;
  const current = currentDefaultSecondarySpell();
  const extraSelected = EXTRA_SECONDARY_SPELL_IDS.includes(current) ? current : null;
  const thirdButton =
    extraSelected != null
      ? spellButtonHtml(extraSelected, true, `data-toggle-default-spell-tray="1"`)
      : `<button class="spell-btn" data-toggle-default-spell-tray="1" title="其他召喚師技能">⋯ 其他</button>`;
  const tray = EXTRA_SECONDARY_SPELL_IDS.map((id) =>
    spellButtonHtml(id, current === id, `data-pick-default-spell="${id}"`)
  ).join("");

  el.innerHTML =
    MAIN_SECONDARY_SPELL_IDS.map((id) =>
      spellButtonHtml(id, current === id, `data-pick-default-spell="${id}"`)
    ).join("") +
    thirdButton +
    `<div class="spell-tray${defaultSpellTrayOpen ? " open" : ""}">${tray}</div>`;
}

let spellMemListOpen = false;

/** Count line, expandable list of remembered champions, and the clear-all button state. */
function renderSpellOverrideCount() {
  const el = document.getElementById("spellOverrideCountText");
  if (!el) return;
  const remembered = state.profileList
    .filter((c) => isSupportedSecondarySpell(c.secSpell))
    .sort((a, b) => a.n.localeCompare(b.n, "zh-Hant"));
  el.textContent =
    remembered.length > 0 ? `已記住 ${remembered.length} 位英雄` : "還沒有記住任何英雄（在總覽選角時點副技能就會記住）";
  const toggle = document.getElementById("btnToggleSpellMemList");
  const reset = document.getElementById("btnResetSpellOverrides") as HTMLButtonElement | null;
  const listEl = document.getElementById("spellMemList");
  if (remembered.length === 0) spellMemListOpen = false;
  toggle?.classList.toggle("empty", remembered.length === 0);
  toggle?.setAttribute("aria-expanded", String(spellMemListOpen));
  if (reset) reset.disabled = remembered.length === 0;
  if (!listEl) return;
  listEl.hidden = !spellMemListOpen;
  listEl.innerHTML = remembered
    .map(
      (c) => `<div class="spell-mem-row">${img(c.id, c.n)}<span class="nm">${escapeHtml(c.n)}</span>${spellIconHtml(
        c.secSpell!
      )}<span class="sp">${escapeHtml(spellName(c.secSpell!))}</span><button class="btn mini" data-forget-spell="${
        c.id
      }" title="刪除這筆，改回預設副技能">刪除</button></div>`
    )
    .join("");
}

document.getElementById("btnToggleSpellMemList")?.addEventListener("click", () => {
  if (!state.profileList.some((c) => isSupportedSecondarySpell(c.secSpell))) return;
  spellMemListOpen = !spellMemListOpen;
  renderSpellOverrideCount();
});

document.getElementById("spellMemList")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-forget-spell]") as HTMLElement | null;
  if (!btn) return;
  const champ = state.profileList.find((c) => c.id === Number(btn.dataset.forgetSpell));
  if (!champ || champ.secSpell == null) return;
  const was = spellName(champ.secSpell);
  champ.secSpell = undefined;
  renderSpellOverrideCount();
  renderOverviewColumns();
  debouncedSaveConfig();
  addLog("act", "已刪除英雄副技能記憶", `【${champ.n}】原本記住 ${was}，改回預設副技能`);
});

document.getElementById("cfgDefaultSpellPicker")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-toggle-default-spell-tray]")) {
    defaultSpellTrayOpen = !defaultSpellTrayOpen;
    renderDefaultSpellPicker();
    return;
  }
  const pick = target.closest("[data-pick-default-spell]") as HTMLElement | null;
  if (!pick) return;
  const id = Number(pick.dataset.pickDefaultSpell);
  if (!isSupportedSecondarySpell(id)) return;
  state.currentSettings.default_secondary_spell = id;
  defaultSpellTrayOpen = false;
  renderDefaultSpellPicker();
  renderOverviewColumns();
  void (async () => {
    await saveConfigImmediate();
    if (state.isLcuConnected && state.lastKnownPhase === "ChampSelect") {
      const [spell1Id, spell2Id] = resolveSpellPair(id, primarySpellKeyFromUI());
      const label = `D ${spellName(spell1Id)} ＋ F ${spellName(spell2Id)}（模式預設更新）`;
      await invoke("apply_summoner_spells", { spell1Id, spell2Id, label }).catch((err) =>
        addLog("err", "切換召喚師技能失敗", String(err))
      );
    }
  })();
});

document.getElementById("cfgPrimarySpellKey")?.addEventListener("change", () => {
  renderOverviewColumns();
  void (async () => {
    await saveConfigImmediate();
    if (state.isLcuConnected && state.lastKnownPhase === "ChampSelect") {
      const profile = state.profileList;
      const myChamp = overviewMyChampId > 0 ? profile.find((c) => c.id === overviewMyChampId) : undefined;
      const secId = effectiveSecondarySpell(myChamp);
      const [spell1Id, spell2Id] = resolveSpellPair(secId, primarySpellKeyFromUI());
      const label = `D ${spellName(spell1Id)} ＋ F ${spellName(spell2Id)}（主／副鍵位對調）`;
      await invoke("apply_summoner_spells", { spell1Id, spell2Id, label }).catch((err) =>
        addLog("err", "切換召喚師技能失敗", String(err))
      );
    }
  })();
});

document.getElementById("btnResetSpellOverrides")?.addEventListener("click", () => {
  const list = state.profileList;
  let cleared = 0;
  list.forEach((c) => {
    if (c.secSpell != null) {
      c.secSpell = undefined;
      cleared += 1;
    }
  });
  renderSpellOverrideCount();
  renderOverviewColumns();
  debouncedSaveConfig();
  addLog(
    "act",
    "已清除英雄專屬副技能記憶",
    `共清除 ${cleared} 位英雄的個別記憶，回歸共用預設副技能`
  );
});

function applyAcceptModesToUI() {
  document.querySelectorAll<HTMLElement>("#acceptModes button").forEach((b) => {
    b.classList.toggle("on", acceptModes.includes(b.dataset.v || ""));
  });
}

document.getElementById("acceptModes")?.addEventListener("click", () => {
  acceptModes = Array.from(document.querySelectorAll<HTMLElement>("#acceptModes button.on")).map(
    (b) => b.dataset.v || ""
  );
});

/* ---------- Accent Themes ---------- */
// ink: text on an accent background. text: accent-colored text on an accent-tinted background.
const ACCENTS: Record<string, { accent: string; ink: string; text?: string }> = {
  ivory: { accent: "#EDE8DF", ink: "#141416" },
  crimson: { accent: "#EF4444", ink: "#141416", text: "#F87171" },
  amber: { accent: "#E5A93C", ink: "#0E0E11" },
  emerald: { accent: "#34D399", ink: "#061C14" },
  violet: { accent: "#C084FC", ink: "#160826" },
};
function setAccent(a: string) {
  const cfg = ACCENTS[a] || ACCENTS.ivory;
  document.documentElement.style.setProperty("--accent", cfg.accent);
  document.documentElement.style.setProperty("--accent-ink", cfg.ink);
  document.documentElement.style.setProperty("--accent2", cfg.accent);
  document.documentElement.style.setProperty("--accent-text", cfg.text ?? cfg.accent);
  document.querySelectorAll("#accentPicker button").forEach((b) =>
    b.classList.toggle("on", (b as HTMLElement).dataset.accent === a)
  );
  localStorage.setItem("app-accent", a);
}
document.querySelectorAll("#accentPicker button").forEach((b) =>
  b.addEventListener("click", () => {
    const chosen = (b as HTMLElement).dataset.accent || "ivory";
    setAccent(chosen);
    debouncedSaveConfig();
  })
);
setAccent(localStorage.getItem("app-accent") || "ivory");

/* ---------- Display Scale ---------- */
/** Current dropdown value in percent (80–200), already snapped to the grid. */
function uiScalePercent(): number {
  return clampUiScalePercent(numberValue("cfgUiScale", UI_SCALE_DEFAULT));
}

/** Zoom the webview; the backend clamps the same way and does the actual set_zoom. */
function applyUiScale(percent: number) {
  const snapped = clampUiScalePercent(percent);
  const select = document.getElementById("cfgUiScale") as HTMLSelectElement | null;
  if (select) select.value = String(snapped);
  invoke("set_ui_scale", { scale: snapped / 100 }).catch((e) =>
    console.error("Failed to apply display scale:", e)
  );
}

/** Apply a new scale and save it (dropdown and shortcuts). */
function commitUiScale(percent: number) {
  applyUiScale(percent);
  debouncedSaveConfig();
}

document
  .getElementById("cfgUiScale")
  ?.addEventListener("change", () => commitUiScale(uiScalePercent()));

/** Text fields keep their own Ctrl+`=` / Ctrl+`-` / Ctrl+`0` behaviour. */
function isTextEntry(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && (el as HTMLInputElement).type !== "range";
}

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (isTextEntry(e.target as HTMLElement | null)) return;
  const current = uiScalePercent();
  let next: number;
  if (e.key === "=" || e.key === "+") next = stepUiScalePercent(current, 1);
  else if (e.key === "-" || e.key === "_") next = stepUiScalePercent(current, -1);
  else if (e.key === "0") next = UI_SCALE_DEFAULT;
  else return;
  // WebView2 zooms the page itself on Ctrl+= / Ctrl+-; the setting owns the zoom.
  e.preventDefault();
  commitUiScale(next);
});

/* ---------- Log Engine ---------- */
initLogFilter();

/* ---------- Overview Tiles ---------- */
// Tiles were removed from the overview per user feedback (duplicated by the
// settings pages). The toggle settings themselves are unaffected.

/* ---------- Config Persistence Triggers ---------- */
const SAVE_ON_CHANGE_IDS = [
  "cfgAutoCardExecute",
  "cfgLockStopBench",
  "cfgAutoBenchExecute",
  "cfgFfTime",
  "cfgFfCooldownReminder",
  "cfgCloseToTray",
  "cfgAutoStart",
  "cfgRememberSpells",
];
SAVE_ON_CHANGE_IDS.forEach((id) => {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  const handler = () => {
    debouncedSaveConfig();
  };
  el.addEventListener("change", handler);
  el.addEventListener("input", handler);
});

// Memory on/off changes which secondary spell the overview shows.
document.getElementById("cfgRememberSpells")?.addEventListener("change", () => renderOverviewColumns());

/* ---------- Champions & Tiers Data ---------- */

function renderTiers() {
  const list = state.profileList;
  const sc = calculateScores(list);
  const container = document.getElementById("tiers");
  if (!container) return;

  container.innerHTML = TIERS.map(
    ([t, hi, lo]) => `
    <div class="tier" data-t="${t}">
      <div class="tier-label">${t}${hi != null ? `<small>${lo}–${hi}</small>` : ""}</div>
      <div class="tier-drop" data-t="${t}">
        ${list
          .filter((c) => c.t === t)
          .map(
            (c) => `
          <div class="chip" draggable="true" data-id="${c.id}" title="${c.f ? FLAG_NAME[c.f] : "點圖示切換標記"}">
            ${img(c.id, c.n)}
            <span>${escapeHtml(c.n)}</span>
            <span class="sc">${sc[c.id] ?? "—"}</span>
            <span class="fl ${c.f ? "set" : ""}" data-flag>${FLAG_ICON[c.f] || "🔒"}</span>
          </div>`
          )
          .join("")}
      </div>
    </div>`
  ).join("");

  applySearch();
  renderTradeSim();
}

let dragId: number | null = null;
const tiersContainer = document.getElementById("tiers");
tiersContainer?.addEventListener("dragstart", (e) => {
  const chip = (e.target as HTMLElement).closest(".chip") as HTMLElement | null;
  if (!chip) return;
  dragId = +chip.dataset.id!;
  // WebView2 needs a payload before it fires `dragover`/`drop` reliably.
  e.dataTransfer?.setData("text/plain", String(dragId));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  chip.classList.add("dragging");
});
tiersContainer?.addEventListener("dragend", () => {
  dragId = null;
  renderTiers();
  debouncedSaveConfig();
});
tiersContainer?.addEventListener("dragover", (e) => {
  const dropZone = (e.target as HTMLElement).closest(".tier-drop") as HTMLElement | null;
  // Only our own chip drags are droppable; stray text / file drags are ignored.
  if (!dropZone || dragId == null) return;
  e.preventDefault();
  tiersContainer.querySelectorAll(".over").forEach((x) => x !== dropZone && x.classList.remove("over"));
  dropZone.classList.add("over");
});
tiersContainer?.addEventListener("drop", (e) => {
  const dropZone = (e.target as HTMLElement).closest(".tier-drop") as HTMLElement | null;
  if (!dropZone || dragId == null) return;
  e.preventDefault();

  const targetChip = (e.target as HTMLElement).closest(".chip") as HTMLElement | null;
  // Dropping a chip onto itself must be a no-op instead of jumping to the tier end.
  if (targetChip && +targetChip.dataset.id! === dragId) return;

  const list = state.profileList;
  const fromIdx = list.findIndex((c) => c.id === dragId);
  if (fromIdx < 0) return;
  const [targetItem] = list.splice(fromIdx, 1);
  targetItem.t = dropZone.dataset.t!;

  let insertIdx = list.length;
  if (targetChip) {
    const r = targetChip.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    insertIdx = list.findIndex((c) => c.id === +targetChip.dataset.id!) + (after ? 1 : 0);
  } else {
    const lastInTier = list.map((c) => c.t).lastIndexOf(targetItem.t);
    if (lastInTier >= 0) insertIdx = lastInTier + 1;
  }

  list.splice(insertIdx, 0, targetItem);
  // renderTiers() detaches the dragged chip, so its dragend never reaches us.
  dragId = null;
  renderTiers();
  debouncedSaveConfig();
});
tiersContainer?.addEventListener("click", (e) => {
  const flagBtn = (e.target as HTMLElement).closest("[data-flag]");
  if (!flagBtn) return;
  const chip = flagBtn.closest(".chip") as HTMLElement;
  const champion = state.profileList.find((x) => x.id === +chip.dataset.id!);
  if (!champion) return;
  champion.f = FLAGS[(FLAGS.indexOf(champion.f) + 1) % FLAGS.length];
  renderTiers();
  debouncedSaveConfig();
});

function applySearch() {
  const q = (document.getElementById("search") as HTMLInputElement)?.value.trim() || "";
  tiersContainer
    ?.querySelectorAll(".chip")
    .forEach((c) => c.classList.toggle("hide", Boolean(q && !c.textContent?.includes(q))));
}
document.getElementById("search")?.addEventListener("input", applySearch);

/* ---------- Trade Simulator ---------- */
const simMine = document.getElementById("simMine") as HTMLSelectElement | null;
const simOffer = document.getElementById("simOffer") as HTMLSelectElement | null;
const simIsFriend = document.getElementById("simIsFriend") as HTMLSelectElement | null;
function fillTradeOptions() {
  if (!simMine || !simOffer) return;
  const list = state.profileList;
  const options = list.map((c) => `<option value="${c.id}">${escapeHtml(c.n)}</option>`).join("");
  const pick = (previous: string, preferredId: number, index: number) => {
    if (list.some((c) => String(c.id) === previous)) return previous;
    if (list.some((c) => c.id === preferredId)) return String(preferredId);
    return String(list[index]?.id ?? list[0]?.id ?? "");
  };
  const previousMine = simMine.value;
  const previousOffer = simOffer.value;
  simMine.innerHTML = options;
  simOffer.innerHTML = options;
  simMine.value = pick(previousMine, 81, 0); // Ezreal
  simOffer.value = pick(previousOffer, 267, 1); // Nami
}

function renderTradeSim() {
  if (!simMine?.value || !simOffer?.value) return;
  const list = state.profileList;
  const sc = calculateScores(list);
  const myChamp = list.find((c) => c.id === +simMine.value);
  const offerChamp = list.find((c) => c.id === +simOffer.value);
  if (!myChamp || !offerChamp) return;

  const th = numberValue("thAccept", 10);
  const rejTier = (document.querySelector("#rejTier .on") as HTMLElement)?.dataset.v || "";
  const friendPolicy = activeSegValue("friendTradePolicy") || "manual";
  const isFriend = simIsFriend?.value === "1";
  const isMyHoldHigh = rejTier.length > 0 && rejTier.includes(myChamp.t);
  const label = (c: TierChampion, score: number) => `${c.n} (${c.t} ${score})`;

  let kind: "accept" | "reject" | "skip" = "skip";
  let why = "";

  if (myChamp.id === offerChamp.id) {
    kind = "skip";
    why = "同一隻英雄，無需交換";
  } else if (isFriend && friendPolicy === "auto_accept") {
    kind = "accept";
    why = `🤝 組排/好友換角特權：建議同意讓出【${myChamp.n}】換取【${offerChamp.n}】`;
  } else if (isFriend && friendPolicy === "manual") {
    kind = "skip";
    why = `🤝 組排/好友發起換角（想用【${offerChamp.n}】換你的【${myChamp.n}】），保留由你手動決定`;
  } else if (myChamp.f === "lock") {
    kind = "reject";
    why = `🔒 ${myChamp.n} 標記為【不換出】`;
  } else if (offerChamp.f === "nograb") {
    kind = "reject";
    why = `⛔ ${offerChamp.n} 標記為【不搶】`;
  } else if (myChamp.f === "give") {
    kind = "accept";
    why = `🎁 ${myChamp.n} 標記為【隨時可換】`;
  } else if (sc[offerChamp.id] == null) {
    if (isMyHoldHigh) {
      kind = "reject";
      why = `手上是【${myChamp.t}】等級英雄【${myChamp.n}】，自動拒絕未分類英雄【${offerChamp.n}】`;
    } else {
      kind = "skip";
      why = `對方英雄【${offerChamp.n}】未分類，保留手動決定`;
    }
  } else if (sc[myChamp.id] == null && (offerChamp.t === "封印" || offerChamp.t === "勉強")) {
    kind = "skip";
    why = `手上【${myChamp.n}】未分類，對方【${offerChamp.n}】為${offerChamp.t}，保留手動決定`;
  } else {
    const myScore = sc[myChamp.id] ?? UNRANKED_BASELINE_SCORE;
    const offerScore = sc[offerChamp.id] as number;
    const diff = offerScore - myScore;
    const reachThreshold = diff >= th;

    if (isMyHoldHigh && reachThreshold) {
      kind = "skip";
      why = `⚠️ 規則衝突：對方高出 +${diff} 分達接受門檻，但手上是【${myChamp.t}】，不自動覆蓋，留給你手動決定！`;
    } else if (reachThreshold) {
      kind = "accept";
      why = `${label(offerChamp, offerScore)} − ${label(myChamp, myScore)} = +${diff}，達到門檻 ${th} 分`;
    } else if (isMyHoldHigh) {
      kind = "reject";
      why = `手上是【${myChamp.t}】等級，設定為自動拒絕`;
    } else {
      kind = "skip";
      why = `${label(offerChamp, offerScore)} − ${label(myChamp, myScore)} = ${diff >= 0 ? "+" : ""}${diff}，未達門檻 ${th} 分，條件外留給手動處理`;
    }
  }

  const v = document.getElementById("verdict");
  if (v) {
    v.className = "verdict " + kind;
    v.innerHTML = `<span class="big">${{ accept: "接受", reject: "拒絕", skip: "不處理" }[kind]}</span><span class="why">${escapeHtml(
      why
    )}</span>`;
  }
}
simMine?.addEventListener("change", renderTradeSim);
simOffer?.addEventListener("change", renderTradeSim);
simIsFriend?.addEventListener("change", renderTradeSim);
document.getElementById("thAccept")?.addEventListener("input", renderTradeSim);
document.getElementById("thAccept")?.addEventListener("change", renderTradeSim);
document.getElementById("rejTier")?.addEventListener("change", renderTradeSim);
document.getElementById("friendTradePolicy")?.addEventListener("change", renderTradeSim);

/* ---------- Chat Messages ---------- */
let chatMessages = ["謝啦！{new} 交給我", "感謝換角，這把順風～", "{old} 給你，{new} 我來 🙏"];
function renderChatMessages() {
  const container = document.getElementById("msgs");
  if (!container) return;
  container.innerHTML = chatMessages
    .map(
      (m, i) => `
    <div class="msg">
      <span>${escapeHtml(m).replace(/\{(old|new)\}/g, '<span class="var">{$1}</span>')}</span>
      <button data-del="${i}" title="刪除">✕</button>
    </div>`
    )
    .join("");

  const sample = (chatMessages[0] || "").replace("{old}", "伊澤瑞爾").replace("{new}", "阿璃");
  const preview = document.getElementById("msgPreview");
  if (preview) {
    preview.innerHTML = chatMessages.length
      ? `預覽（伊澤瑞爾 → 阿璃）：<b>${escapeHtml(sample)}</b>`
      : "沒有自訂訊息時將不會發話。";
  }
}
document.getElementById("msgs")?.addEventListener("click", (e) => {
  const d = (e.target as HTMLElement).closest("[data-del]") as HTMLElement | null;
  if (d) {
    chatMessages.splice(+d.dataset.del!, 1);
    renderChatMessages();
    debouncedSaveConfig();
  }
});
const addMessage = () => {
  const input = document.getElementById("msgIn") as HTMLInputElement;
  if (input?.value.trim()) {
    chatMessages.push(input.value.trim());
    input.value = "";
    renderChatMessages();
    debouncedSaveConfig();
  }
};
document.getElementById("msgAdd")?.addEventListener("click", addMessage);
document.getElementById("msgIn")?.addEventListener("keydown", (e) => e.key === "Enter" && addMessage());

/* ---------- Two-Stage Classifier & Pairwise PK Engine (src/battle.ts) ---------- */
initBattle({ renderTiers, saveConfigReport, debouncedSaveConfig });

/* ---------- Named Ranking Saves (排序存檔) (src/rankingSaveBar.ts) ---------- */
initRankingSaveBar({ renderTiers, saveConfigImmediate });

/* ---------- Priority Toolbar & Account Mastery Auto-Seed ---------- */
async function importMasteryToProfile() {
  try {
    const masteryList = await invoke<ChampionMasteryItem[]>("get_champion_mastery");
    if (!Array.isArray(masteryList) || masteryList.length === 0) {
      addLog("skip", "尚無專精資料可匯入", "請確認英雄聯盟客戶端已開啟並登入帳號");
      return;
    }
    const classified = state.profileList.filter((c) => c.t !== "未分類").length;
    if (classified > 0) {
      const ok = await confirmDialog(
        "依帳號專精重新初排？",
        `會覆蓋目前 ${classified} 隻已分類英雄的階層與順序，並把二選一權重重設為專精順序。執行前會先自動備份到 backups/。`,
        "備份並初排"
      );
      if (!ok) return;
    }
    if (!(await backupBeforeBulkEdit("mastery-seed", "專精初排"))) return;

    const masteryMap = new Map<number, ChampionMasteryItem>();
    for (const m of masteryList) {
      if (m.championId > 0 && m.championId < 10000) {
        masteryMap.set(m.championId, m);
      }
    }

    const list = state.profileList;
    const played = list
      .filter((c) => (masteryMap.get(c.id)?.championPoints ?? 0) > 0 && c.t !== "封印")
      .sort((a, b) => {
        const ma = masteryMap.get(a.id)!;
        const mb = masteryMap.get(b.id)!;
        if (mb.championPoints !== ma.championPoints) return mb.championPoints - ma.championPoints;
        if (mb.championLevel !== ma.championLevel) return mb.championLevel - ma.championLevel;
        return mb.lastPlayTime - ma.lastPlayTime;
      });

    const totalPlayed = played.length;
    const nBenming = Math.min(15, Math.max(3, Math.round(totalPlayed * 0.12)));
    const nAijiao = Math.min(25, Math.max(5, Math.round(totalPlayed * 0.22)));
    const nShunshou = Math.max(8, Math.round(totalPlayed * 0.36));

    played.forEach((c, idx) => {
      if (idx < nBenming) c.t = "本命";
      else if (idx < nBenming + nAijiao) c.t = "愛角";
      else if (idx < nBenming + nAijiao + nShunshou) c.t = "順手";
      else c.t = "勉強";
    });

    const unplayed = list
      .filter((c) => (masteryMap.get(c.id)?.championPoints ?? 0) <= 0 && c.t !== "封印")
      .sort((a, b) => a.n.localeCompare(b.n, "zh-Hant"));
    unplayed.forEach((c) => {
      c.t = "未分類";
    });
    const sealed = list.filter((c) => c.t === "封印");

    state.profileList = [...played, ...sealed, ...unplayed];

    // Seed ELO from mastery order so pairwise PK starts from the mastery ranking;
    // the old match counts described the replaced weights, so they restart too.
    state.profileList.forEach((c, idx) => {
      eloMap[c.id] = 1700 - idx * 2;
      pkComparisonsMap[c.id] = 0;
    });
    if (draftVotes > 0) {
      resetDraft();
      addLog("skip", "已放棄本輪二選一草稿", "專精初排已重設權重，草稿不再適用");
    }

    renderTiers();
    syncFlashPool();
    syncBattlePool();
    debouncedSaveConfig();
    addLog(
      "act",
      "已依 LoL 帳號專精自動初排",
      `共匯入 ${totalPlayed} 位有專精紀錄之英雄（本命 ${nBenming} / 愛角 ${nAijiao} / 順手 ${Math.min(
        nShunshou,
        Math.max(0, totalPlayed - nBenming - nAijiao)
      )}），未遊玩 ${unplayed.length} 位保留於未分類`
    );
  } catch (err) {
    addLog("err", "讀取 LoL 帳號專精失敗", `請確認已開啟英雄聯盟大廳（${String(err)}）`);
  }
}

document.getElementById("btnImportMastery")?.addEventListener("click", () => {
  void importMasteryToProfile();
});

document.getElementById("btnResetTiers")?.addEventListener("click", async () => {
  const ok = await confirmDialog(
    "重置全部英雄分級？",
    "所有英雄會回到未分類、清除 🔒/🎁/⛔ 標記。二選一權重保留。執行前會先自動備份到 backups/。",
    "備份並重置"
  );
  if (!ok || !(await backupBeforeBulkEdit("reset-tiers", "重置"))) return;
  const list = state.profileList;
  list.forEach((c) => {
    c.t = "未分類";
    c.f = "";
  });
  list.sort((a, b) => a.n.localeCompare(b.n, "zh-Hant"));
  resetFlashState();
  renderTiers();
  syncFlashPool();
  syncBattlePool();
  debouncedSaveConfig();
  addLog("act", "已重置英雄分級", `已將全部 ${list.length} 位英雄重置回未分類`);
});

document.getElementById("btnSortUnranked")?.addEventListener("click", () => {
  const list = state.profileList;
  const unranked = list.filter((c) => c.t === "未分類").sort((a, b) => a.n.localeCompare(b.n, "zh-Hant"));
  if (unranked.length === 0) return;
  let k = 0;
  list.forEach((c, i) => {
    if (c.t === "未分類") list[i] = unranked[k++];
  });
  renderTiers();
  syncFlashPool();
  debouncedSaveConfig();
  addLog("act", "未分類英雄已重新排序", `已依名稱排列 ${unranked.length} 位未分類英雄`);
});

/* ---------- General Settings: JSON Export / Import ---------- */
document.getElementById("btnExportJson")?.addEventListener("click", async () => {
  const text = JSON.stringify(collectConfig(), null, 2);
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
    applyConfigToUI(parsed as AppConfig);
    if (await saveConfigImmediate()) addLog("act", "已匯入設定檔", `${file.name}（匯入前設定已備份到 backups/）`);
  } catch (err) {
    addLog("err", "匯入設定檔失敗", String(err));
  } finally {
    input.value = "";
  }
});

/* ---------- Config Persistence (Debounced) ---------- */
function collectConfig(): AppConfig {
  // Snapshot the visible form into the single shared settings/profile state.
  state.currentSettings = readModeSettingsFromUI();
  ffTime = textValue("cfgFfTime", "08:00");

  // One shared ranking: both modes are written from the same list.
  const serializedProfile: ProfileItemConfig[] = state.profileList.map((c) => ({
    id: c.id,
    name: c.n,
    tier: c.t,
    flag: c.f,
    elo: eloMap[c.id],
    matches: pkComparisonsMap[c.id],
    secondary_spell: c.secSpell,
  }));

  return {
    master_enabled: masterEnabled,
    accent_color: localStorage.getItem("app-accent") || "ivory",
    ui_scale: uiScalePercent() / 100,
    auto_summoner_spells: checkboxValue("cfgAutoSpells", true),
    remember_champion_spells: checkboxValue("cfgRememberSpells", true),
    primary_spell_key: primarySpellKeyFromUI(),
    auto_accept: checkboxValue("cfgAutoAccept", true),
    accept_delay_sec: numberValue("cfgAcceptDelay", 2),
    accept_modes: [...acceptModes],
    accept_notify: activeSegValue("cfgAcceptNotify") || "sound",
    aram_settings: state.currentSettings,
    mayhem_settings: { ...state.currentSettings },
    auto_chat_on_swap: checkboxValue("cfgAutoChat", true),
    chat_delay_sec: chatDelaySec,
    chat_messages: [...chatMessages],
    chat_on_accept_teammate: activeChkValues("cfgChatTriggers").includes("accept_teammate"),
    chat_on_teammate_accept_mine: activeChkValues("cfgChatTriggers").includes("teammate_accept_mine"),
    ff_reminder: checkboxValue("cfgAutoFf", false),
    ff_time_aram: ffTime,
    ff_time_mayhem: ffTime,
    ff_kill_diff_threshold: 0,
    ff_cooldown_reminder: checkboxValue("cfgFfCooldownReminder", false),
    ff_copy_clipboard: activeChkValues("cfgFfMethods").includes("clipboard"),
    ff_play_sound: activeChkValues("cfgFfMethods").includes("sound"),
    ff_desktop_notify: activeChkValues("cfgFfMethods").includes("notification"),
    ff_lead_sec: numberValue("cfgFfLead", 0),
    bench_retry_interval_ms: benchRetryIntervalMs,
    manual_snipe_interval_ms: numberValue("cfgManualSnipeMs", 120),
    client_close_action: activeSegValue("cfgClientCloseAction") || "wait",
    close_to_tray: checkboxValue("cfgCloseToTray", true),
    auto_start: checkboxValue("cfgAutoStart", false),
    aram_profile: serializedProfile,
    mayhem_profile: serializedProfile,
    // Every save carries its own last manual save, the active one included.
    ranking_saves: state.rankingSaves.map((s) => ({
      id: s.id,
      name: s.name,
      items: s.items.map(toProfileItemConfig),
    })),
    active_ranking_save: state.activeRankingSave,
  };
}

let saveTimer: any = null;
/** Last save error shown in the log, so a failing debounce loop logs once, not every 350ms. */
let lastSaveError: string | null = null;
/**
 * "saved": on disk. "memory-only": the backend runs on it but the file write
 * failed. "refused": like memory-only, but the unreadable-config guard refuses
 * every save until a restart loads the file (or the file is gone).
 * (An IPC failure before the command runs is also reported as memory-only.)
 */
async function saveConfigReport(): Promise<SaveResult> {
  clearTimeout(saveTimer);
  // Every edit path funnels through here, so this is where the 未儲存 state is kept current.
  renderRankingSaveBar();
  try {
    await invoke("save_app_config", { newConfig: collectConfig() });
    if (lastSaveError) addLog("sys", "設定已恢復正常寫入", "");
    lastSaveError = null;
    return "saved";
  } catch (e) {
    console.error("Failed to save config:", e);
    const { result, message } = classifySaveError(e);
    if (message !== lastSaveError) addLog("err", "設定寫入失敗", message);
    lastSaveError = message;
    return result;
  }
}

/** Persist the visible settings; resolves `false` (and logs once) when not on disk. */
async function saveConfigImmediate(): Promise<boolean> {
  return (await saveConfigReport()) === "saved";
}
function debouncedSaveConfig() {
  clearTimeout(saveTimer);
  // Show 未儲存 at once; the write itself waits for the debounce.
  renderRankingSaveBar();
  saveTimer = setTimeout(() => {
    void saveConfigImmediate();
  }, 350);
}

/* ---------- LCU Backend Integration ---------- */

async function initLcuBackend() {
  // 1. Register real-time listeners FIRST so we never miss an event during startup
  await listen<ConnectionStatus>("lcu-status", (event) => {
    state.isLcuConnected = event.payload.connected;
    updateConnectionUI(event.payload.connected, event.payload.port);
    if (event.payload.connected) {
      void loadChampionsFromLcu();
      void syncLivePhaseAndSession(true);
      addLog("sys", "LCU 已成功連線", `Port: ${event.payload.port || "未知"}`);
    } else {
      state.lastKnownPhase = "";
      clearOverviewSteps();
      resetOverviewMiniCards();
      addLog("sys", "與 LCU 斷開連線", "等待客戶端重新啟動...");
    }
  });

  await listen<{ kind: "act" | "skip" | "sys" | "err"; title: string; reason: string }>("lcu-log", (event) => {
    addLog(event.payload.kind, event.payload.title, event.payload.reason);
  });

  await listen<string>("lcu-ff-alert", (event) => {
    if (!checkboxValue("cfgAutoFf", false)) return;
    const methods = activeChkValues("cfgFfMethods");
    if (methods.includes("sound")) playBeepAlert();
    if (methods.includes("notification")) showDesktopNotification("⏰ 投降安全提醒", event.payload);
    addLog("act", "⏰ 投降安全提醒", event.payload);
  });

  await listen<LcuEvent>("lcu-event", (event) => {
    handleLcuEvent(event.payload);
  });

  // Backend-owned champ select verdicts (bench / trade / manual hold).
  await listen<ChampSelectUiState>("lcu-champ-select-state", (event) => {
    setChampUiState(event.payload);
    if (lastChampSelectData) renderOverviewColumns();
  });

  // Suggestion-only assists: the backend never acts on its own, the overview offers the click.
  await listen<AssistPayload>("lcu-assist", (event) => {
    applyAssistPayload(event.payload);
    renderOverviewColumns();
  });

  await listen("lcu-ready-accepted", () => {
    notifyAccept();
  });

  await listen<AppConfig>("config-updated", (event) => applyConfigToUI(event.payload));

  // Settings belong to the computer: an account switch only changes the name pill.
  await listen<ActiveAccount>("account-changed", (event) => updateAccountPill(event.payload));

  // 2. Load saved config
  try {
    const account = await invoke<ActiveAccount | null>("get_active_account");
    updateAccountPill(account);
  } catch {
    // Backend may predate the command; the badge simply stays hidden.
  }
  try {
    const config: AppConfig = await invoke("get_app_config");
    if (config) {
      applyConfigToUI(config);
      // Both modes share one ranking, so one short list means the roster still needs seeding.
      const aramLen = Array.isArray(config.aram_profile) ? config.aram_profile.length : 0;
      const mayhemLen = Array.isArray(config.mayhem_profile) ? config.mayhem_profile.length : 0;
      if (Math.max(aramLen, mayhemLen) < BUILTIN_CHAMPIONS.length) {
        debouncedSaveConfig();
      }
    }
  } catch (err) {
    console.warn("Could not load app config, using defaults:", err);
  }

  // 3. Check initial connection & sync live state
  await pollLiveOverviewStatus(true);

  // 4. Periodic 2.5s sync so lobby/queue/phase badges stay 100% accurate
  setInterval(() => {
    void pollLiveOverviewStatus(false);
  }, 2500);
}

async function pollLiveOverviewStatus(initial: boolean) {
  try {
    const status: ConnectionStatus = await invoke("get_connection_status");
    const changedConn = status.connected !== state.isLcuConnected;
    state.isLcuConnected = status.connected;
    updateConnectionUI(status.connected, status.port);
    if (status.connected) {
      const fresh = initial || changedConn;
      if (fresh) void loadChampionsFromLcu();
      // Champ select sessions arrive as lcu-event pushes; the periodic tick only
      // keeps the phase and queue label current (a lobby queue change has no event).
      await syncLivePhaseAndSession(fresh);
    } else if (changedConn) {
      state.lastKnownPhase = "";
      clearOverviewSteps();
      resetOverviewMiniCards();
    }
  } catch (err) {
    console.error("Failed to query LCU connection status:", err);
  }
}

function applyConfigToUI(cfg: AppConfig) {
  if (cfg.accent_color) setAccent(cfg.accent_color);
  applyUiScale((cfg.ui_scale ?? 1) * 100);

  masterEnabled = cfg.master_enabled ?? true;
  setCheckbox("cfgAutoSpells", cfg.auto_summoner_spells ?? true);
  setCheckbox("cfgRememberSpells", cfg.remember_champion_spells ?? true);
  setSegValue("cfgPrimarySpellKey", (cfg.primary_spell_key || "D").toUpperCase() === "F" ? "F" : "D");
  setCheckbox("cfgAutoAccept", cfg.auto_accept ?? true);
  setRangeValue("cfgAcceptDelay", cfg.accept_delay_sec ?? 2);
  acceptModes = normalizeAcceptModes(cfg.accept_modes);
  applyAcceptModesToUI();
  setSegValue("cfgAcceptNotify", cfg.accept_notify || "sound");

  state.currentSettings = normalizeModeSettings(cfg.aram_settings ?? cfg.mayhem_settings);
  writeModeSettingsToUI(state.currentSettings);

  setCheckbox("cfgAutoChat", cfg.auto_chat_on_swap ?? true);
  chatDelaySec = cfg.chat_delay_sec ?? 1;
  if (Array.isArray(cfg.chat_messages)) {
    chatMessages = cfg.chat_messages;
    renderChatMessages();
  }
  setChkValues(
    "cfgChatTriggers",
    [
      (cfg.chat_on_accept_teammate ?? true) ? "accept_teammate" : "",
      (cfg.chat_on_teammate_accept_mine ?? true) ? "teammate_accept_mine" : "",
    ].filter(Boolean)
  );

  setCheckbox("cfgAutoFf", cfg.ff_reminder ?? false);
  ffTime = cfg.ff_time_aram || cfg.ff_time_mayhem || "08:00";
  setTextInput("cfgFfTime", ffTime);
  setRangeValue("cfgFfLead", cfg.ff_lead_sec ?? 0);
  benchRetryIntervalMs = cfg.bench_retry_interval_ms ?? 80;
  setRangeValue("cfgManualSnipeMs", cfg.manual_snipe_interval_ms ?? 120);
  setCheckbox("cfgFfCooldownReminder", cfg.ff_cooldown_reminder ?? false);
  setChkValues(
    "cfgFfMethods",
    [
      (cfg.ff_copy_clipboard ?? false) ? "clipboard" : "",
      (cfg.ff_play_sound ?? true) ? "sound" : "",
      (cfg.ff_desktop_notify ?? false) ? "notification" : "",
    ].filter(Boolean)
  );
  setSegValue("cfgClientCloseAction", cfg.client_close_action || "wait");
  setCheckbox("cfgCloseToTray", cfg.close_to_tray ?? true);
  setCheckbox("cfgAutoStart", cfg.auto_start ?? false);

  const aramProfile = Array.isArray(cfg.aram_profile) ? cfg.aram_profile : [];
  const mayhemProfile = Array.isArray(cfg.mayhem_profile) ? cfg.mayhem_profile : [];
  const chosenProfile = richerProfile(aramProfile, mayhemProfile);
  // The incoming config is the whole truth: weights and roster from a previous
  // account (or a previous load) must never survive into this one.
  replaceWeights(eloMap, {});
  replaceWeights(pkComparisonsMap, {});
  state.profileList =
    chosenProfile.length > 0
      ? chosenProfile
          .filter((p) => p.id > 0 && p.id < 10000)
          .map((p) => {
            if (typeof p.elo === "number" && Number.isFinite(p.elo)) eloMap[p.id] = p.elo;
            if (typeof p.matches === "number" && Number.isFinite(p.matches)) {
              pkComparisonsMap[p.id] = p.matches;
            }
            return {
              id: p.id,
              n: typeof p.name === "string" ? p.name : "",
              t: TIER_NAMES.includes(p.tier) ? p.tier : "未分類",
              f: FLAGS.includes(p.flag) ? p.flag : "",
              secSpell: isSupportedSecondarySpell(p.secondary_spell) ? p.secondary_spell : undefined,
            };
          })
      : createDefaultRoster();
  ensureAllBuiltinChampions(state.profileList);
  // Blank names (hand-edited files) fall back to the built-in name.
  for (const c of state.profileList) {
    if (!c.n) c.n = BUILTIN_CHAMPIONS.find((b) => b.id === c.id)?.n ?? `#${c.id}`;
  }

  const normalizedSaves = normalizeSaves(cfg.ranking_saves, cfg.active_ranking_save);
  state.rankingSaves = normalizedSaves.saves;
  state.activeRankingSave = normalizedSaves.activeId;
  // An old-format save (or the auto-created 存檔 1) has no items yet: take the
  // working ranking as its first manual save so it starts clean instead of 未儲存.
  const activeSave = state.rankingSaves.find((s) => s.id === state.activeRankingSave);
  if (activeSave && activeSave.items.length === 0) {
    activeSave.items = captureLive(state.profileList, eloMap, pkComparisonsMap);
  }

  renderTiers();
  fillTradeOptions();
  renderDefaultSpellPicker();
  renderSpellOverrideCount();
  syncFlashPool();
  syncBattlePool();
  renderRankingSaveBar();
}

function updateConnectionUI(connected: boolean, port?: number) {
  const pill = document.getElementById("lcuPill");
  if (pill) {
    if (connected) {
      pill.className = "pill connected";
      pill.innerHTML = `<i class="dot"></i>LCU 已連線 (${port || "OK"})`;
    } else {
      pill.className = "pill warn";
      pill.innerHTML = `<i class="dot"></i>等待客戶端...`;
    }
  }
  if (!connected) {
    const phase = document.getElementById("overviewPhase");
    if (phase) phase.innerHTML = `<i></i><em>等待連線</em>`;
  }
}

/** Title-bar account badge: `gameName#tagLine`, hidden until LCU reports the account. */
function updateAccountPill(account: ActiveAccount | null) {
  const pill = document.getElementById("accountPill");
  if (!pill) return;
  if (!account) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.className = "pill account";
  pill.innerHTML = `<i class="dot"></i>${escapeHtml(account.display_name || "帳號")}`;
}

/** Merge LCU names and new champions into `target`; returns whether anything changed. */
function mergeLcuChampions(target: TierChampion[], champs: ChampionItem[]): boolean {
  const byId = new Map(target.map((c) => [c.id, c]));
  const seen = new Set<number>();
  let changed = false;
  for (const item of champs) {
    if (!(item.id > 0 && item.id < 10000) || seen.has(item.id)) continue;
    seen.add(item.id);
    const existing = byId.get(item.id);
    if (existing) {
      // Update the localized name in place so the user's ordering is preserved.
      if (existing.n !== item.name) {
        existing.n = item.name;
        changed = true;
      }
    } else {
      const fresh: TierChampion = { id: item.id, n: item.name, t: "未分類", f: "" };
      target.push(fresh);
      byId.set(item.id, fresh);
      changed = true;
    }
  }
  return changed;
}

async function loadChampionsFromLcu() {
  try {
    const champs: ChampionItem[] = await invoke("get_champions");
    const valid = Array.isArray(champs) ? champs.filter((c) => c.id > 0 && c.id < 10000) : [];
    if (valid.length === 0) return;

    addLog("sys", `已載入 ${valid.length} 位繁中英雄名稱資料`, "本地 LCU 資產解析完成");

    // One shared ranking: keep the loaded list in sync for both modes.
    const changed = mergeLcuChampions(state.profileList, valid);

    renderTiers();
    fillTradeOptions();
    syncFlashPool();
    syncBattlePool();
    // Reconnects usually bring the same list: write only when it added or renamed something.
    if (changed) debouncedSaveConfig();
  } catch (err) {
    console.warn("Could not fetch champions yet:", err);
  }
}

function handleLcuEvent(event: LcuEvent) {
  if (event.uri === "/lol-gameflow/v1/gameflow-phase") {
    const phase = String(event.data);
    void updateGameflowPhase(phase);
  } else if (event.uri === "/lol-champ-select/v1/session") {
    handleChampSelectLiveUI(event.data);
  }
}

/* ---------- Queue mode mapping ---------- */
let currentQueueId: number | null = null;

function currentModeLabel(): string {
  return currentQueueId == null ? "模式未知" : queueModeLabel(currentQueueId);
}

async function refreshCurrentQueueId() {
  try {
    currentQueueId = await invoke<number | null>("get_current_queue_id");
  } catch (e) {
    console.warn("Could not resolve current queue id:", e);
  }
}

initOverview({
  primarySpellKeyFromUI,
  renderDefaultSpellPicker,
  renderSpellOverrideCount,
  saveConfigImmediate,
});

/** Sync the phase (and queue label); `withSession` also pulls the champ select state, for a fresh connection. */
async function syncLivePhaseAndSession(withSession: boolean) {
  try {
    const phase = await invoke<string | null>("get_gameflow_phase");
    await updateGameflowPhase(phase || "None");
    if (withSession && phase === "ChampSelect") {
      // Reconnecting mid-champ-select: adopt the backend verdicts before rendering.
      try {
        const state = await invoke<ChampSelectUiState>("get_champ_select_ui_state");
        setChampUiState(state);
      } catch (e) {
        console.warn("Could not load champ select ui state:", e);
      }
      const session = await invoke<any>("get_champ_select_session");
      if (session) handleChampSelectLiveUI(session);
    }
  } catch (e) {
    console.warn("Could not sync initial gameflow phase:", e);
  }
}

function clearOverviewSteps() {
  const stepOrder = ["Lobby", "Matchmaking", "ReadyCheck", "ChampSelect", "InProgress"];
  stepOrder.forEach((stepPhase) => {
    const el = document.getElementById(`st-${stepPhase}`);
    if (!el) return;
    el.classList.remove("done", "now");
  });
}

async function updateGameflowPhase(phase: string) {
  const phaseChanged = phase !== state.lastKnownPhase;
  state.lastKnownPhase = phase;

  // The queue id can change between phases, so resolve it before labelling the phase.
  await refreshCurrentQueueId();

  const modeLabel = currentModeLabel();
  const phaseLabel = PHASE_LABELS[phase] || phase;

  // Single phase indicator lives in the overview header (titlebar keeps only
  // the connection pill now).
  const phaseNow = document.getElementById("overviewPhase");
  if (phaseNow) phaseNow.innerHTML = `<i></i><em>${escapeHtml(phaseLabel)} · ${escapeHtml(modeLabel)}</em>`;

  const stepOrder = ["Lobby", "Matchmaking", "ReadyCheck", "ChampSelect", "InProgress"];
  // When connected to the LoL client home screen ("None") or room ("Lobby"), light up "大廳" (index 0).
  // In-game sub-phases light "遊戲中"; post-game phases mark every step done.
  const IN_GAME_PHASES = ["GameStart", "InProgress", "Reconnect"];
  const POST_GAME_PHASES = ["WaitingForStats", "PreEndOfGame", "EndOfGame"];
  const normalizedPhase = state.isLcuConnected && (phase === "None" || phase === "")
    ? "Lobby"
    : IN_GAME_PHASES.includes(phase) ? "InProgress" : phase;
  const currentIdx = POST_GAME_PHASES.includes(phase) ? stepOrder.length : stepOrder.indexOf(normalizedPhase);
  stepOrder.forEach((stepPhase, idx) => {
    const el = document.getElementById(`st-${stepPhase}`);
    if (!el) return;
    el.classList.toggle("done", currentIdx > idx);
    el.classList.toggle("now", currentIdx === idx);
  });
  // Same phase mapping drives the label row under the bar.
  document.querySelectorAll<HTMLElement>(".plabels span").forEach((el, idx) => {
    el.classList.toggle("now", currentIdx === idx);
  });
  if (phase !== "ChampSelect") {
    resetOverviewMiniCards();
  }

  if (phaseChanged) {
    addLog("sys", `遊戲流程階段變更：${phase}`, "Gameflow Phase");
  }
}

function notifyAccept() {
  const mode = activeSegValue("cfgAcceptNotify") || "sound";
  if (mode === "mute") return;
  playBeepAlert();
  if (mode === "notification") {
    showDesktopNotification("已自動接受對戰", "配對已確認，祝你遊戲順利。");
  }
}

// Initial bootstrap
fillTradeOptions();
renderTiers();
renderChatMessages();
applyAcceptModesToUI();
writeModeSettingsToUI(state.currentSettings);
renderSpellOverrideCount();
syncFlashPool();
syncBattlePool();
resetOverviewMiniCards();
addLog("sys", "ARAM 助手啟動完成", "讀取本地設定與 LCU 連線核心中...");
initLcuBackend().catch(console.error);
initUpdaterUi();
