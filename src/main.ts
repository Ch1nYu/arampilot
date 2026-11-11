import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { friendlyUpdateError, isBusyPhase, progressLabel, releaseNotes } from "./updater";
import { BUILTIN_CHAMPIONS } from "./champions";
import { createPairMemory, pickPair } from "./pkPairing";
import { validateImportedConfig } from "./importValidation";
import { classifySaveError, type SaveResult } from "./saveResult";
import { clampUiScalePercent, stepUiScalePercent, UI_SCALE_DEFAULT } from "./uiScale";
import { applyAssist, emptyAssist, type AssistPayload, type AssistState } from "./assist";
import {
  captureLive,
  isDirty,
  MAX_RANKING_SAVES,
  newSaveId,
  nextSaveName,
  normalizeSaves,
  restoreSave,
  type RankingSave,
  type RankingSaveItem,
} from "./rankingSaves";

interface ChampionItem {
  id: number;
  name: string;
  title?: string;
  roles?: string[];
}

interface ChampionMasteryItem {
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number;
}

interface ConnectionStatus {
  connected: boolean;
  port?: number;
}

interface ActiveAccount {
  puuid: string;
  display_name: string;
}

interface LcuEvent {
  uri: string;
  eventType: string;
  data: any;
}

/** Backend-owned champ select state (verdicts are never recomputed here). */
interface ChampSelectUiState {
  manual_hold_champ_id: number | null;
  bench_retry_target: number | null;
  bench_verdict: string | null;
  trade_verdict: string | null;
  allied_puuids: string[];
  allied_summoner_ids: number[];
}

interface TierChampion {
  id: number;
  n: string;
  t: string; // "本命", "愛角", "順手", "勉強", "封印", "未分類"
  f: string; // "", "lock", "give", "nograb"
  secSpell?: number; // remembered secondary summoner spell id
}

interface ModeSettings {
  auto_card_select: boolean;
  card_select_delay_sec: number;
  card_select_strategy: string;
  auto_card_execute: boolean;
  auto_bench_swap: boolean;
  auto_bench_execute: boolean;
  bench_diff_threshold: number;
  lock_stop_bench: boolean;
  stop_bench_remaining_sec: number;
  auto_trade: boolean;
  trade_accept_diff: number;
  trade_reject_tiers: string[];
  friend_trade_policy: string;
  default_secondary_spell: number;
}

interface ProfileItemConfig {
  id: number;
  name: string;
  tier: string;
  flag: string;
  elo?: number;
  matches?: number;
  secondary_spell?: number;
}

interface AppConfig {
  master_enabled: boolean;
  accent_color: string;
  ui_scale?: number;
  auto_summoner_spells: boolean;
  remember_champion_spells?: boolean;
  primary_spell_key: string; // "D" | "F"
  auto_accept: boolean;
  accept_delay_sec: number;
  accept_modes: string[];
  accept_notify: string; // "mute", "sound", "notification"
  aram_settings: ModeSettings;
  mayhem_settings: ModeSettings;
  auto_chat_on_swap: boolean;
  chat_delay_sec: number;
  chat_messages: string[];
  chat_on_accept_teammate: boolean;
  chat_on_teammate_accept_mine: boolean;
  ff_reminder: boolean;
  ff_time_aram: string;
  ff_time_mayhem: string;
  ff_kill_diff_threshold: number;
  ff_cooldown_reminder: boolean;
  ff_copy_clipboard: boolean;
  ff_play_sound: boolean;
  ff_desktop_notify: boolean;
  ff_lead_sec: number;
  bench_retry_interval_ms: number;
  manual_snipe_interval_ms: number;
  client_close_action: string; // "wait", "exit"
  close_to_tray: boolean;
  auto_start: boolean;
  aram_profile: ProfileItemConfig[];
  mayhem_profile: ProfileItemConfig[];
  ranking_saves: RankingSaveConfig[];
  active_ranking_save: string;
}

/** One named ranking save as the config file stores it (active save: `items` empty). */
interface RankingSaveConfig {
  id: string;
  name: string;
  items: ProfileItemConfig[];
}

const ICON = (id: number) =>
  `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${id}.png`;

/* ---------- Summoner Spells ---------- */
const SPELL_ICON_BASE =
  "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d/";

interface SummonerSpellMeta {
  id: number;
  name: string;
  icon: string;
}

const FLASH_SPELL_ID = 4;
const SUMMONER_SPELLS: Record<number, SummonerSpellMeta> = {
  4: { id: 4, name: "閃現", icon: "summoner_flash.png" },
  6: { id: 6, name: "鬼步", icon: "summoner_haste.png" },
  32: { id: 32, name: "雪球", icon: "summoner_mark.png" },
  13: { id: 13, name: "清晰", icon: "summonermana.png" },
  3: { id: 3, name: "虛弱", icon: "summoner_exhaust.png" },
  14: { id: 14, name: "點燃", icon: "summonerignite.png" },
  21: { id: 21, name: "光盾", icon: "summonerbarrier.png" },
  7: { id: 7, name: "治癒", icon: "summoner_heal.png" },
  1: { id: 1, name: "淨化", icon: "summoner_boost.png" },
};
/** Always visible secondary options: Ghost and Mark (snowball). */
const MAIN_SECONDARY_SPELL_IDS = [6, 32];
/** Secondary options hidden behind the「其他」tray. */
const EXTRA_SECONDARY_SPELL_IDS = [13, 3, 14, 21, 7, 1];
const DEFAULT_SECONDARY_SPELL_ID = 6;

function isSupportedSecondarySpell(id: unknown): id is number {
  return typeof id === "number" && [...MAIN_SECONDARY_SPELL_IDS, ...EXTRA_SECONDARY_SPELL_IDS].includes(id);
}

function spellName(id: number): string {
  return SUMMONER_SPELLS[id]?.name || "未知技能";
}

function spellIconHtml(id: number): string {
  const meta = SUMMONER_SPELLS[id];
  return `<img class="spell-ic" src="${SPELL_ICON_BASE}${meta?.icon || "summoner_flash.png"}" data-n="${escapeHtml(
    meta?.name || "技能"
  )}" alt="">`;
}

/** D is spell1Id and F is spell2Id; Flash takes the primary key. */
function resolveSpellPair(secondaryId: number, primaryKey: string): [number, number] {
  return primaryKey.toUpperCase() === "F" ? [secondaryId, FLASH_SPELL_ID] : [FLASH_SPELL_ID, secondaryId];
}

function primarySpellKeyFromUI(): string {
  return (activeSegValue("cfgPrimarySpellKey") || "D").toUpperCase() === "F" ? "F" : "D";
}

const img = (id: number, n: string) => `<img src="${ICON(id)}" data-n="${escapeHtml(n)}" alt="">`;

/** Escape every dynamic string before it is concatenated into innerHTML. */
function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
const rangeUpdaters = new Map<string, () => void>();
const gateUpdaters = new Map<string, () => void>();

document.querySelectorAll("[data-seg]").forEach((seg) =>
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    seg.dispatchEvent(new Event("change"));
    debouncedSaveConfig();
  })
);
document.querySelectorAll("[data-chk]").forEach((c) =>
  c.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b) {
      b.classList.toggle("on");
      debouncedSaveConfig();
    }
  })
);
// Sliders may use fractional steps (0.1); trim float noise and trailing zeros.
function formatRangeLabel(input: HTMLInputElement): string {
  const raw = Number(input.value);
  const shown = Number.isFinite(raw) ? String(Math.round(raw * 10) / 10) : input.value;
  if (input.dataset.zero && Number(shown) === 0) return input.dataset.zero;
  return (input.dataset.prefix || "") + shown + (input.dataset.suffix || "");
}
document.querySelectorAll("input[type=range]").forEach((r) => {
  const input = r as HTMLInputElement;
  const numBuddy =
    input.nextElementSibling instanceof HTMLInputElement && input.nextElementSibling.type === "number"
      ? (input.nextElementSibling as HTMLInputElement)
      : null;
  const out = input.parentElement?.querySelector(".val") as HTMLElement | null;
  const paint = () => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const frac = max > min ? (Number(input.value) - min) / (max - min) : 0;
    // Unitless fraction; CSS aligns the fill edge to the thumb center.
    input.style.setProperty("--p", String(frac));
  };
  const upd = () => {
    paint();
    if (numBuddy && numBuddy.value !== input.value) {
      numBuddy.value = input.value;
    }
    if (!out) return;
    out.textContent = formatRangeLabel(input);
  };
  input.addEventListener("input", () => {
    upd();
    debouncedSaveConfig();
  });
  if (numBuddy) {
    numBuddy.addEventListener("input", () => {
      const min = Number(input.min || 0);
      const max = Number(input.max || 40);
      const raw = Number(numBuddy.value);
      if (Number.isFinite(raw)) {
        const clamped = Math.max(min, Math.min(max, Math.round(raw)));
        input.value = String(clamped);
        if (out) out.textContent = formatRangeLabel(input);
        input.dispatchEvent(new Event("change"));
        debouncedSaveConfig();
      }
    });
    numBuddy.addEventListener("change", () => {
      numBuddy.value = input.value;
    });
  }
  upd();
  if (input.id) rangeUpdaters.set(input.id, upd);
});
document.querySelectorAll("[data-gate]").forEach((sw) => {
  const input = sw as HTMLInputElement;
  const targetId = input.dataset.gate;
  const targetEl = targetId ? document.getElementById(targetId) : null;
  const upd = () => targetEl?.classList.toggle("dim-off", !input.checked);
  input.addEventListener("change", () => {
    upd();
    debouncedSaveConfig();
  });
  upd();
  if (input.id) gateUpdaters.set(input.id, upd);
});

function setCheckbox(id: string, on: boolean) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.checked = on;
  gateUpdaters.get(id)?.();
}

function setRangeValue(id: string, value: number) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.value = String(value);
  rangeUpdaters.get(id)?.();
}

function setTextInput(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (input) input.value = value;
}

function setSegValue(id: string, value: string) {
  document.querySelectorAll<HTMLElement>(`#${id} button`).forEach((b) => {
    b.classList.toggle("on", (b.dataset.v || "") === value);
  });
}

function activeSegValue(id: string): string {
  const el = document.querySelector(`#${id} .on`) as HTMLElement | null;
  return el?.dataset.v || "";
}

function setChkValues(id: string, values: string[]) {
  document.querySelectorAll<HTMLElement>(`#${id} button`).forEach((b) => {
    b.classList.toggle("on", values.includes(b.dataset.v || ""));
  });
}

function activeChkValues(id: string): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`#${id} button.on`)).map((b) => b.dataset.v || "");
}

/* ---------- Shared Mode Settings (ARAM + Mayhem) ---------- */
function defaultModeSettings(): ModeSettings {
  return {
    auto_card_select: true,
    card_select_delay_sec: 1.5,
    card_select_strategy: "highest_score",
    auto_card_execute: false,
    auto_bench_swap: true,
    auto_bench_execute: false,
    bench_diff_threshold: 10,
    lock_stop_bench: true,
    stop_bench_remaining_sec: 5,
    auto_trade: true,
    trade_accept_diff: 10,
    trade_reject_tiers: ["本命"],
    friend_trade_policy: "manual",
    default_secondary_spell: DEFAULT_SECONDARY_SPELL_ID,
  };
}

let currentSettings: ModeSettings = defaultModeSettings();
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

const ACCEPT_MODE_OPTIONS = ["ARAM", "Mayhem", "其他"];
let acceptModes: string[] = ["ARAM", "Mayhem"];

const REJECT_TIER_VALUES: Record<string, string[]> = {
  "本命": ["本命"],
  "本命愛角": ["本命", "愛角"],
  "": [],
};

function rejectTiersToValue(tiers: string[]): string {
  const top = tiers.includes("本命");
  const love = tiers.includes("愛角");
  if (top && love) return "本命愛角";
  return top ? "本命" : "";
}

function checkboxValue(id: string, fallback: boolean): boolean {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return el ? el.checked : fallback;
}

function numberValue(id: string, fallback: number): number {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const v = el ? Number(el.value) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

function textValue(id: string, fallback: string): string {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const v = el?.value.trim() || "";
  return v || fallback;
}

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
    default_secondary_spell: isSupportedSecondarySpell(currentSettings.default_secondary_spell)
      ? currentSettings.default_secondary_spell
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
  const id = currentSettings.default_secondary_spell;
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
  const remembered = profileList
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
  if (!profileList.some((c) => isSupportedSecondarySpell(c.secSpell))) return;
  spellMemListOpen = !spellMemListOpen;
  renderSpellOverrideCount();
});

document.getElementById("spellMemList")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-forget-spell]") as HTMLElement | null;
  if (!btn) return;
  const champ = profileList.find((c) => c.id === Number(btn.dataset.forgetSpell));
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
  currentSettings.default_secondary_spell = id;
  defaultSpellTrayOpen = false;
  renderDefaultSpellPicker();
  renderOverviewColumns();
  void (async () => {
    await saveConfigImmediate();
    if (isLcuConnected && lastKnownPhase === "ChampSelect") {
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
    if (isLcuConnected && lastKnownPhase === "ChampSelect") {
      const profile = profileList;
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
  const list = profileList;
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
/** Current slider value in percent (80–200), already snapped to the grid. */
function uiScalePercent(): number {
  return clampUiScalePercent(numberValue("cfgUiScale", UI_SCALE_DEFAULT));
}

/** Zoom the webview; the backend clamps the same way and does the actual set_zoom. */
function applyUiScale(percent: number) {
  const snapped = clampUiScalePercent(percent);
  setRangeValue("cfgUiScale", snapped);
  invoke("set_ui_scale", { scale: snapped / 100 }).catch((e) =>
    console.error("Failed to apply display scale:", e)
  );
}

/** Slider moves save through the generic range handler; shortcuts save here. */
function commitUiScale(percent: number) {
  applyUiScale(percent);
  debouncedSaveConfig();
}

document
  .getElementById("cfgUiScale")
  ?.addEventListener("input", () => applyUiScale(uiScalePercent()));

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
interface LogRow {
  time: string;
  kind: "act" | "skip" | "sys" | "err";
  title: string;
  reason: string;
}
const logHistory: LogRow[] = [];
let logFilter: "all" | LogRow["kind"] = "all";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function addLog(kind: "act" | "skip" | "sys" | "err", title: string, reason: string) {
  const now = new Date();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  logHistory.unshift({ time, kind, title, reason });
  if (logHistory.length > 80) logHistory.pop();
  renderLogs();
  invoke("append_exec_log", { time, kind, title, reason }).catch(() => {});
}
function renderLogs() {
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

document.getElementById("logFilter")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
  if (!b) return;
  logFilter = (b.dataset.v || "all") as typeof logFilter;
  renderLogs();
});

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
const UNRANKED_BASELINE_SCORE = 40;

function createDefaultRoster(): TierChampion[] {
  return BUILTIN_CHAMPIONS.map((c) => ({ id: c.id, n: c.n, t: "未分類", f: "" }));
}

function ensureAllBuiltinChampions(target: TierChampion[]) {
  const byId = new Map(target.map((c) => [c.id, c]));
  for (const item of BUILTIN_CHAMPIONS) {
    if (!byId.has(item.id)) {
      const fresh: TierChampion = { id: item.id, n: item.n, t: "未分類", f: "" };
      target.push(fresh);
      byId.set(item.id, fresh);
    }
  }
}

let profileList: TierChampion[] = createDefaultRoster();

const TIERS: [string, number | null, number | null][] = [
  ["本命", 100, 90],
  ["愛角", 89, 75],
  ["順手", 74, 60],
  ["勉強", 59, 40],
  ["封印", 39, 10],
  ["未分類", null, null],
];
const TIER_NAMES = TIERS.map(([t]) => t);
const FLAGS = ["", "lock", "give", "nograb"];
const FLAG_ICON: Record<string, string> = { lock: "🔒", give: "🎁", nograb: "⛔" };
const FLAG_NAME: Record<string, string> = { lock: "不換出", give: "隨時可換", nograb: "不搶" };

function calculateScores(list: TierChampion[]): Record<number, number | null> {
  const out: Record<number, number | null> = {};
  TIERS.forEach(([t, hi, lo]) => {
    const members = list.filter((c) => c.t === t);
    members.forEach((c, i) => {
      out[c.id] =
        hi == null || lo == null ? null : Math.round(hi - (hi - lo) * (members.length > 1 ? i / (members.length - 1) : 0));
    });
  });
  return out;
}

function renderTiers() {
  const list = profileList;
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

  const list = profileList;
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
  const champion = profileList.find((x) => x.id === +chip.dataset.id!);
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
  const list = profileList;
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
  const list = profileList;
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

/* ---------- Two-Stage Classifier & Pairwise PK Engine ---------- */
type BattleStage = "flash" | "pk";
let currentBattleStage: BattleStage = "flash";
let flashScope: "unranked" | "all" = "unranked";
let pkTargetScope = "本命";

const flashSkippedIds = new Set<number>();
const flashSeenAllIds = new Set<number>();
const TIER_ORDER = ["本命", "愛角", "順手", "勉強", "封印", "未分類"];

function findTierInsertIndex(list: TierChampion[], targetTier: string): number {
  const lastInTier = list.map((c) => c.t).lastIndexOf(targetTier);
  if (lastInTier >= 0) return lastInTier + 1;

  // targetTier is currently empty in list. Insert before the first champion of any subsequent tier.
  const targetIdx = TIER_ORDER.indexOf(targetTier);
  if (targetIdx >= 0) {
    for (let i = targetIdx + 1; i < TIER_ORDER.length; i++) {
      const nextTier = TIER_ORDER[i];
      const firstInNext = list.findIndex((c) => c.t === nextTier);
      if (firstInNext >= 0) return firstInNext;
    }
  }
  return list.length;
}

let flashUndoHistory: { id: number; prevTier: string; origIdx: number }[] = [];
let currentFlashChampion: TierChampion | null = null;

function setBattleStage(stage: BattleStage) {
  currentBattleStage = stage;
  const flashWrap = document.getElementById("btFlashWrap");
  const pkWrap = document.getElementById("btPkWrap");
  if (flashWrap) flashWrap.style.display = stage === "flash" ? "" : "none";
  if (pkWrap) pkWrap.style.display = stage === "pk" ? "" : "none";
  if (stage === "flash") syncFlashPool();
  else syncBattlePool();
}

document.getElementById("flashGoPk")?.addEventListener("click", () => {
  activateHeroTab("pk");
});

document.getElementById("flashScopeSeg")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
  const scope = b?.dataset.scope as "unranked" | "all" | undefined;
  if (!scope) return;
  flashScope = scope;
  document.querySelectorAll("#flashScopeSeg button").forEach((x) => x.classList.toggle("on", x === b));
  flashSkippedIds.clear();
  flashSeenAllIds.clear();
  syncFlashPool();
});

function syncFlashPool() {
  const list = profileList;
  const total = list.length;
  const unrankedList = list.filter((c) => c.t === "未分類");
  const classifiedCount = total - unrankedList.length;

  const skipped = flashSkippedIds;
  const seenAll = flashSeenAllIds;

  let candidates: TierChampion[] = [];
  if (flashScope === "unranked") {
    candidates = unrankedList.filter((c) => !skipped.has(c.id));
    if (candidates.length === 0 && unrankedList.length > 0) {
      skipped.clear();
      candidates = [...unrankedList];
    }
  } else {
    candidates = list.filter((c) => !seenAll.has(c.id));
    if (candidates.length === 0 && list.length > 0) {
      seenAll.clear();
      candidates = [...list];
    }
  }

  currentFlashChampion = candidates[0] || null;
  renderFlashCard(total, classifiedCount, unrankedList.length, seenAll.size);
}

function renderFlashCard(total: number, classifiedCount: number, unrankedCount: number, seenAllCount: number) {
  const pText = document.getElementById("flashProgressText");
  const pBar = document.getElementById("flashProgressBar");
  const cardEl = document.getElementById("flashCard");

  if (flashScope === "unranked") {
    if (pText) {
      pText.textContent = `已分類 ${classifiedCount} / ${total} 隻 · 剩餘未分類 ${unrankedCount} 隻`;
    }
    if (pBar) {
      const pct = total > 0 ? Math.min(100, Math.round((classifiedCount / total) * 100)) : 100;
      pBar.style.width = `${pct}%`;
    }
  } else {
    if (pText) {
      pText.textContent = `全英雄檢視進度：${seenAllCount} / ${total} 隻`;
    }
    if (pBar) {
      const pct = total > 0 ? Math.min(100, Math.round((seenAllCount / total) * 100)) : 100;
      pBar.style.width = `${pct}%`;
    }
  }

  if (!cardEl) return;
  if (!currentFlashChampion) {
    cardEl.innerHTML = `
      <div class="nm">🎉 全部英雄已分類完成！</div>
      <div class="meta">目前沒有剩餘的「未分類」英雄，可切換至「② 階層內二選一」排定細部順位，或切到「重新檢視全部英雄」。</div>`;
    return;
  }

  cardEl.innerHTML = `
    ${img(currentFlashChampion.id, currentFlashChampion.n)}
    <div class="nm">${escapeHtml(currentFlashChampion.n)}</div>
    <div class="meta">目前分級：${escapeHtml(currentFlashChampion.t)}</div>`;
}

function classifyCurrentFlashCard(targetTier: string) {
  if (!currentFlashChampion) return;
  const list = profileList;
  const idx = list.findIndex((c) => c.id === currentFlashChampion!.id);
  if (idx < 0) return;

  const champ = list[idx];
  const prevTier = champ.t;
  flashUndoHistory.push({ id: champ.id, prevTier, origIdx: idx });

  // Remove and insert into the proper tier position (never falling past unranked champions).
  list.splice(idx, 1);
  champ.t = targetTier;
  const insertIdx = findTierInsertIndex(list, targetTier);
  list.splice(insertIdx, 0, champ);

  flashSeenAllIds.add(champ.id);
  flashSkippedIds.delete(champ.id);

  renderTiers();
  debouncedSaveConfig();
  syncFlashPool();
}

function skipFlashCard() {
  if (!currentFlashChampion) return;
  if (flashScope === "unranked") {
    flashSkippedIds.add(currentFlashChampion.id);
  } else {
    flashSeenAllIds.add(currentFlashChampion.id);
  }
  syncFlashPool();
}

function undoFlashCard() {
  const hist = flashUndoHistory;
  if (!hist || hist.length === 0) return;
  const last = hist.pop()!;
  const list = profileList;
  const curIdx = list.findIndex((c) => c.id === last.id);
  if (curIdx < 0) return;

  const [champ] = list.splice(curIdx, 1);
  champ.t = last.prevTier;
  const restoreIdx = Math.max(0, Math.min(last.origIdx, list.length));
  list.splice(restoreIdx, 0, champ);

  flashSeenAllIds.delete(last.id);
  flashSkippedIds.delete(last.id);
  renderTiers();
  debouncedSaveConfig();
  currentFlashChampion = champ;
  const unrankedCount = list.filter((c) => c.t === "未分類").length;
  renderFlashCard(
    list.length,
    list.length - unrankedCount,
    unrankedCount,
    flashSeenAllIds.size
  );
}

document.getElementById("flashBuckets")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".flash-bucket") as HTMLElement | null;
  const tier = btn?.dataset.tier;
  if (tier) classifyCurrentFlashCard(tier);
});

const flashBucketsEl = document.getElementById("flashBuckets");
document.getElementById("flashCard")?.addEventListener("dragstart", (e) => {
  const id = currentFlashChampion?.id ?? 0;
  e.dataTransfer?.setData("text/plain", String(id));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
});
flashBucketsEl?.addEventListener("dragover", (e) => {
  const btn = (e.target as HTMLElement).closest(".flash-bucket") as HTMLElement | null;
  if (!btn) return;
  e.preventDefault();
  flashBucketsEl.querySelectorAll(".over").forEach((x) => x !== btn && x.classList.remove("over"));
  btn.classList.add("over");
});
flashBucketsEl?.addEventListener("dragleave", (e) => {
  const btn = (e.target as HTMLElement).closest(".flash-bucket") as HTMLElement | null;
  btn?.classList.remove("over");
});
flashBucketsEl?.addEventListener("drop", (e) => {
  const btn = (e.target as HTMLElement).closest(".flash-bucket") as HTMLElement | null;
  if (!btn) return;
  e.preventDefault();
  flashBucketsEl.querySelectorAll(".over").forEach((x) => x.classList.remove("over"));
  if (btn.dataset.tier) classifyCurrentFlashCard(btn.dataset.tier);
});

document.getElementById("flashSkip")?.addEventListener("click", skipFlashCard);
document.getElementById("flashUndo")?.addEventListener("click", undoFlashCard);

/* ---------- Stage 2: Intra-Tier Pairwise PK ---------- */

/** Committed weights: only an applied draft may change these. */
const eloMap: Record<number, number> = {};
const pkComparisonsMap: Record<number, number> = {};

/**
 * Draft weights for this session (champions voted on only). Votes never touch
 * `eloMap` / `pkComparisonsMap` or the saved file; they are merged in on 套用.
 */
let draftElo: Record<number, number> = {};
let draftComp: Record<number, number> = {};
let draftVotes = 0;
/** True while an apply is writing its backup / config; blocks votes and a second apply. */
let pkApplying = false;

interface PkUndoEntry {
  aId: number;
  bId: number;
  prevEloA: number;
  prevEloB: number;
  prevCompA: number;
  prevCompB: number;
}
let pkUndoHistory: PkUndoEntry[] = [];
let battlePool: TierChampion[] = [];
let currentPair: [TierChampion, TierChampion] | null = null;
const pairMemory = createPairMemory();

/** Battle-tab readers: draft first, committed weight as the fallback. */
const pkEloOf = (c: TierChampion) => draftElo[c.id] ?? eloMap[c.id] ?? 1500;
const pkCompOf = (c: TierChampion) => draftComp[c.id] ?? pkComparisonsMap[c.id] ?? 0;
/** Committed-only reader, used once the draft has been merged in. */
const committedEloOf = (c: TierChampion) => eloMap[c.id] ?? 1500;

/* ---- Draft persistence (survives a crash / reload) ---- */
const PK_DRAFT_KEY = "lolafk_pk_draft_v1";
/** One config per computer: the draft belongs to it, whatever account is logged in. */
interface StoredPkDraft {
  scope: string;
  draftElo: Record<number, number>;
  draftComp: Record<number, number>;
  draftVotes: number;
  undo: PkUndoEntry[];
}
/** Remember the draft so a crash or reload can offer to resume it. */
function storePkDraft() {
  try {
    if (draftVotes <= 0) return void localStorage.removeItem(PK_DRAFT_KEY);
    const payload: StoredPkDraft = { scope: pkTargetScope, draftElo, draftComp, draftVotes, undo: pkUndoHistory };
    localStorage.setItem(PK_DRAFT_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Could not store the PK draft:", e);
  }
}

/** The stored draft, when it has votes (older drafts also carry a `puuid`, now ignored). */
function readStoredPkDraft(): StoredPkDraft | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(PK_DRAFT_KEY) ?? "null") as StoredPkDraft | null;
    if (!parsed || typeof parsed !== "object") return null;
    return typeof parsed.draftVotes === "number" && parsed.draftVotes > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function clearStoredPkDraft() {
  try {
    localStorage.removeItem(PK_DRAFT_KEY);
  } catch {
    // Storage disabled: the draft simply lives in memory only.
  }
}

/** Drop the in-memory draft and everything derived from it (and the stored copy unless told not to). */
function resetDraft(clearStorage = true) {
  draftElo = {};
  draftComp = {};
  draftVotes = 0;
  pkUndoHistory = [];
  if (clearStorage) clearStoredPkDraft();
  hideApplyPreview();
  const confirmRow = document.getElementById("btDiscardConfirm");
  if (confirmRow) confirmRow.style.display = "none";
}

/** Pre-apply snapshot so 復原上次套用 can put the exact state back. */
interface PreApplySnapshot {
  profile: TierChampion[];
  elo: Record<number, number>;
  comp: Record<number, number>;
  /** `profileSignature()` right after the apply; any later edit invalidates the revert. */
  signature: string;
}
let preApplySnapshot: PreApplySnapshot | null = null;

function setPkScope(scope: string) {
  pkTargetScope = scope;
  document.querySelectorAll("#pkTierSeg button").forEach((b) =>
    b.classList.toggle("on", (b as HTMLElement).dataset.tier === scope)
  );
}
document.getElementById("pkTierSeg")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
  const tier = b?.dataset.tier;
  if (!tier || tier === pkTargetScope) return;
  // Apply only re-sorts the current scope, so a draft must not span scopes.
  if (draftVotes > 0) {
    addLog("skip", "範圍未切換", `本輪【${pkTargetScope}】還有 ${draftVotes} 票未套用，請先套用或放棄`);
    return;
  }
  setPkScope(tier);
  currentPair = null;
  syncBattlePool();
});

function resolvePkPool(list: TierChampion[], scope: string = pkTargetScope): TierChampion[] {
  if (scope === "top2") return list.filter((c) => c.t === "本命" || c.t === "愛角");
  if (scope === "all") return list.filter((c) => c.t !== "封印");
  return list.filter((c) => c.t === scope);
}

function syncBattlePool() {
  const list = profileList;
  battlePool = resolvePkPool(list);

  const elo = eloMap;
  const comp = pkComparisonsMap;
  battlePool.forEach((c, i) => {
    if (!Number.isFinite(elo[c.id])) {
      elo[c.id] = 1500 + (battlePool.length - i) * 6;
    }
    if (!Number.isFinite(comp[c.id])) {
      comp[c.id] = 0;
    }
  });

  const poolIds = new Set(battlePool.map((c) => c.id));

  if (currentPair && (!poolIds.has(currentPair[0].id) || !poolIds.has(currentPair[1].id))) {
    currentPair = null;
  }
  if (currentPair) renderBattle();
  else nextBattlePair();
}

function estimatedPkRounds(): number {
  return Math.max(6, Math.round(battlePool.length * 1.8));
}

function renderBattle() {
  const card = (c: TierChampion, k: string) => `
    ${img(c.id, c.n)}
    <div class="nm">${escapeHtml(c.n)}</div>
    <div class="meta">${escapeHtml(c.t)} · 權重 ${Math.round(pkEloOf(c))} · 已比 ${pkCompOf(c)} 次</div>
    <span class="key">${k}</span>`;

  const elL = document.getElementById("fL");
  const elR = document.getElementById("fR");
  if (battlePool.length < 2) {
    const msg = `<div class="nm">此範圍英雄不足 2 隻</div><div class="meta">請先用「閃卡五分類」或「優先序」頁的「帳號專精自動初排」放入英雄，或切換上方範圍。</div>`;
    if (elL) elL.innerHTML = msg;
    if (elR) elR.innerHTML = `<div class="nm">—</div>`;
  } else {
    if (elL) elL.innerHTML = currentPair ? card(currentPair[0], "←") : `<div class="nm">—</div>`;
    if (elR) elR.innerHTML = currentPair ? card(currentPair[1], "→") : `<div class="nm">—</div>`;
  }

  const est = estimatedPkRounds();
  const minPlayed = battlePool.length > 0 ? Math.min(...battlePool.map((c) => pkCompOf(c))) : 0;
  const coveredCount = battlePool.filter((c) => pkCompOf(c) > 0).length;
  const rEl = document.getElementById("btRound");
  if (rEl) {
    rEl.textContent = `本輪已比 ${draftVotes} 場 · 已出場 ${coveredCount}/${battlePool.length} 隻（最少已比 ${minPlayed} 次）`;
  }
  const bEl = document.getElementById("btBar");
  if (bEl) {
    const coveragePct = battlePool.length > 0 ? (coveredCount / battlePool.length) * 100 : 0;
    bEl.style.width = `${Math.min(100, Math.max(coveragePct, (draftVotes / est) * 100))}%`;
  }

  const rankEl = document.getElementById("rank");
  if (rankEl) {
    rankEl.innerHTML = [...battlePool]
      .sort((x, y) => pkEloOf(y) - pkEloOf(x))
      .slice(0, 12)
      .map(
        (c) =>
          `<li>${img(c.id, c.n)}<span>${escapeHtml(c.n)}</span><span class="elo">${Math.round(pkEloOf(c))}</span></li>`
      )
      .join("");
  }

  updateBattleButtons();
}

function nextBattlePair() {
  if (battlePool.length < 2) {
    currentPair = null;
    renderBattle();
    return;
  }

  currentPair = pickPair(battlePool, pairMemory, pkEloOf, pkCompOf);
  renderBattle();
}

/** Pure: the ordered / re-tiered copy of `list` for `scope`; the input is never mutated. */
function reorderListByScope(list: TierChampion[], weights: (c: TierChampion) => number, scope: string): TierChampion[] {
  const pool = resolvePkPool(list, scope);
  if (pool.length < 2) return list;

  const sorted = [...pool].sort((x, y) => weights(y) - weights(x)).map((c) => ({ ...c }));

  if (scope === "top2") {
    const numBenming = Math.max(1, Math.round(sorted.length * 0.35));
    sorted.forEach((c, i) => (c.t = i < numBenming ? "本命" : "愛角"));
  } else if (scope === "all") {
    const n1 = Math.max(1, Math.round(sorted.length * 0.12));
    const n2 = Math.max(1, Math.round(sorted.length * 0.22));
    const n3 = Math.max(1, Math.round(sorted.length * 0.34));
    sorted.forEach((c, i) => {
      c.t = i < n1 ? "本命" : i < n1 + n2 ? "愛角" : i < n1 + n2 + n3 ? "順手" : "勉強";
    });
  }

  const poolIdSet = new Set(sorted.map((c) => c.id));
  const next = [...list];
  const slots: number[] = [];
  list.forEach((c, i) => {
    if (poolIdSet.has(c.id)) slots.push(i);
  });
  slots.forEach((slot, k) => {
    if (sorted[k]) next[slot] = sorted[k];
  });
  return next;
}

/** Committed live path: recompute the order from committed weights and adopt it. */
function syncOrderFromElo() {
  profileList = reorderListByScope(profileList, committedEloOf, pkTargetScope);
}

interface ApplyPreview {
  moved: { name: string; from: number; to: number }[];
  tierChanges: { name: string; from: string; to: string }[];
}

/** What applying the draft would change, computed on a copy (nothing is mutated). */
function computeApplyPreview(): ApplyPreview {
  const next = reorderListByScope(profileList, pkEloOf, pkTargetScope);
  const before = new Map(profileList.map((c, i) => [c.id, { pos: i + 1, tier: c.t }]));
  const moved: ApplyPreview["moved"] = [];
  const tierChanges: ApplyPreview["tierChanges"] = [];
  next.forEach((c, i) => {
    const prev = before.get(c.id);
    if (!prev) return;
    if (prev.pos !== i + 1) moved.push({ name: c.n, from: prev.pos, to: i + 1 });
    if (prev.tier !== c.t) tierChanges.push({ name: c.n, from: prev.tier, to: c.t });
  });
  moved.sort((a, b) => a.to - b.to);
  return { moved, tierChanges };
}

function renderApplyPreview() {
  const panel = document.getElementById("btPreview");
  const body = document.getElementById("btPreviewBody");
  if (!panel || !body) return;
  const preview = computeApplyPreview();
  const shown = preview.moved.slice(0, 15);
  const rest = preview.moved.length - shown.length;
  const movedHtml = shown
    .map((m) => `<li>${escapeHtml(m.name)}：名次 ${m.from} → ${m.to}</li>`)
    .join("");
  const tierHtml = preview.tierChanges
    .map((t) => `<div>${escapeHtml(t.name)}：${escapeHtml(t.from)} → ${escapeHtml(t.to)}</div>`)
    .join("");
  body.innerHTML = `
    <div class="card-desc" style="margin:0">範圍【${escapeHtml(pkTargetScope)}】· 本輪 ${draftVotes} 票 · ${preview.moved.length} 隻名次變動</div>
    <div class="card-desc" style="margin:4px 0 0">套用會把整個【${escapeHtml(pkTargetScope)}】依權重重新排序，包含這輪沒比到的英雄；不想動到手排的順序就按取消。</div>
    ${shown.length > 0 ? `<ol class="preview-list">${movedHtml}</ol>` : `<div class="preview-more">名次不變</div>`}
    ${rest > 0 ? `<div class="preview-more">…還有 ${rest} 隻</div>` : ""}
    <div class="preview-tiers">${tierHtml || "階層不變"}</div>`;
  panel.style.display = "";
  panel.scrollIntoView({ block: "center", behavior: "smooth" });
}

function hideApplyPreview() {
  const panel = document.getElementById("btPreview");
  if (panel) panel.style.display = "none";
}

function updateBattleButtons() {
  const setDisabled = (id: string, disabled: boolean) => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = disabled;
  };
  setDisabled("btApply", draftVotes === 0 || pkApplying);
  setDisabled("btPreviewConfirm", draftVotes === 0 || pkApplying);
  setDisabled("btDiscard", draftVotes === 0 || pkApplying);
  const revertBtn = document.getElementById("btRevertApply");
  if (revertBtn) revertBtn.style.display = liveApplySnapshot() ? "" : "none";
}

/** While the "上次有 N 票未套用" banner is up, a new vote would overwrite that stored draft. */
function draftBannerBlocksVoting(): boolean {
  const banner = document.getElementById("btDraftBanner");
  if (!banner || banner.style.display === "none") return false;
  banner.classList.remove("nudge");
  void banner.offsetWidth;
  banner.classList.add("nudge");
  return true;
}

function voteBattle(winner: 0 | 1 | "tie" | "down") {
  if (!currentPair || pkApplying || draftBannerBlocksVoting()) return;
  hideApplyPreview();
  const [a, b] = currentPair;
  const K = 32;
  pkUndoHistory.push({
    aId: a.id,
    bId: b.id,
    prevEloA: pkEloOf(a),
    prevEloB: pkEloOf(b),
    prevCompA: pkCompOf(a),
    prevCompB: pkCompOf(b),
  });
  const ea = 1 / (1 + Math.pow(10, (pkEloOf(b) - pkEloOf(a)) / 400));
  const sa = winner === 0 ? 1 : winner === 1 ? 0 : winner === "tie" ? 0.5 : null;
  if (sa != null) {
    draftElo[a.id] = pkEloOf(a) + K * (sa - ea);
    draftElo[b.id] = pkEloOf(b) - K * (sa - ea);
  }
  if (winner === "down") {
    draftElo[a.id] = pkEloOf(a) - 18;
    draftElo[b.id] = pkEloOf(b) - 18;
  }
  draftComp[a.id] = pkCompOf(a) + 1;
  draftComp[b.id] = pkCompOf(b) + 1;
  draftVotes += 1;
  storePkDraft();
  nextBattlePair();
}

function undoBattleVote() {
  const hist = pkUndoHistory;
  if (!hist || hist.length === 0 || pkApplying) return;
  hideApplyPreview();
  const last = hist.pop()!;
  draftElo[last.aId] = last.prevEloA;
  draftElo[last.bId] = last.prevEloB;
  draftComp[last.aId] = last.prevCompA;
  draftComp[last.bId] = last.prevCompB;
  draftVotes = Math.max(0, draftVotes - 1);
  const a = battlePool.find((c) => c.id === last.aId);
  const b = battlePool.find((c) => c.id === last.bId);
  if (a && b) currentPair = [a, b];
  storePkDraft();
  renderBattle();
}

function discardDraft() {
  const votes = draftVotes;
  resetDraft();
  renderBattle();
  addLog("skip", "已放棄本輪二選一", `${votes} 票草稿已丟棄，優先序與權重未變動`);
}

/** Merge the draft into the committed weights and adopt the new order. */
async function confirmApplyDraft() {
  if (draftVotes === 0 || pkApplying) return;
  pkApplying = true;
  updateBattleButtons();
  try {
    await applyDraftOnce();
  } finally {
    pkApplying = false;
    updateBattleButtons();
  }
}

async function applyDraftOnce() {
  hideApplyPreview();

  // Never write without a backup: the backend snapshot must land first.
  try {
    await invoke("backup_config_snapshot", { reason: "pk-apply", stamp: backupStamp() });
  } catch (err) {
    addLog("err", "備份失敗，二選一未套用", `無法寫入備份檔，草稿仍保留（${String(err)}）`);
    return;
  }
  if (draftVotes === 0) return;

  const preview = computeApplyPreview();
  const scope = pkTargetScope;
  const votes = draftVotes;
  const snapshot: PreApplySnapshot = {
    profile: profileList.map((c) => ({ ...c })),
    elo: { ...eloMap },
    comp: { ...pkComparisonsMap },
    signature: "",
  };
  const draft = { elo: { ...draftElo }, comp: { ...draftComp }, votes: draftVotes, undo: [...pkUndoHistory] };
  for (const [key, value] of Object.entries(draftElo)) eloMap[Number(key)] = value;
  for (const [key, value] of Object.entries(draftComp)) pkComparisonsMap[Number(key)] = value;

  resetDraft(false);
  syncOrderFromElo();
  const saved = await saveConfigReport();
  /** Put the pre-apply order back and the votes back into a single draft. */
  const restoreDraft = () => {
    profileList = snapshot.profile.map((c) => ({ ...c }));
    replaceWeights(eloMap, snapshot.elo);
    replaceWeights(pkComparisonsMap, snapshot.comp);
    draftElo = draft.elo;
    draftComp = draft.comp;
    draftVotes = draft.votes;
    pkUndoHistory = draft.undo;
    storePkDraft();
  };
  if (saved === "memory-only") {
    // The backend already runs on the new order: keep the screen in step.
    // The draft is spent: a later successful save writes this order too, so
    // offering the votes again would count them twice.
    clearStoredPkDraft();
    snapshot.signature = profileSignature();
    preApplySnapshot = snapshot;
    renderTiers();
    addLog("err", "二選一只套用到本次執行", "設定檔暫時無法寫入；之後任何一次存檔成功就會一起寫入，重新啟動前都沒成功的話這幾票會遺失");
    activateHeroTab("priority");
    return;
  }
  if (saved === "refused") {
    // Nothing reaches the file this run: keep the votes as the one live draft
    // (not merged), so they can be applied once after a restart.
    restoreDraft();
    // The backend took the merged order into memory: hand it the restored one.
    await saveConfigReport();
    renderTiers();
    renderBattle();
    addLog("err", "二選一未套用", "設定檔讀取失敗保護中，這次執行無法存檔；優先序未變動，草稿已保留，重新啟動 App 後再套用");
    return;
  }
  clearStoredPkDraft();
  snapshot.signature = profileSignature();
  preApplySnapshot = snapshot;
  renderTiers();
  addLog("act", "二選一已套用", `${scope} · ${votes} 票 · ${preview.moved.length} 隻名次變動 · 已備份`);
  activateHeroTab("priority");
}

/** Order + tier + flag + spell of every champion: detects edits made after an apply. */
function profileSignature(): string {
  return profileList.map((c) => `${c.id}:${c.t}:${c.f}:${c.secSpell ?? ""}`).join("|");
}

/** The pre-apply snapshot, or null once the priority list was edited after the apply. */
function liveApplySnapshot(): PreApplySnapshot | null {
  if (preApplySnapshot && preApplySnapshot.signature !== profileSignature()) preApplySnapshot = null;
  return preApplySnapshot;
}

/** Put the exact pre-apply order, tiers and weights back. */
async function revertLastApply() {
  const snapshot = liveApplySnapshot();
  if (!snapshot) {
    updateBattleButtons();
    addLog("skip", "無法復原上次套用", "套用後優先序又改過；要回到套用前請匯入 backups/ 內的備份檔");
    return;
  }
  profileList = snapshot.profile.map((c) => ({ ...c }));
  replaceWeights(eloMap, snapshot.elo);
  replaceWeights(pkComparisonsMap, snapshot.comp);
  const saved = await saveConfigReport();
  // "memory-only" and "refused" also land here: the backend already runs on
  // the restored order, so the screen must show it too.
  preApplySnapshot = null;
  renderTiers();
  syncBattlePool();
  updateBattleButtons();
  if (saved !== "saved") {
    addLog("err", "復原只套用到本次執行", "設定檔沒有寫入；之後的存檔若都沒成功，重新啟動後會回到最後一次成功存檔時的排名");
    return;
  }
  addLog("act", "已復原上次套用", "二選一順位、階層與權重已還原為套用前狀態");
}

function replaceWeights(target: Record<number, number>, source: Record<number, number>) {
  for (const key of Object.keys(target)) delete target[Number(key)];
  for (const [key, value] of Object.entries(source)) target[Number(key)] = value;
}

/** Offer to resume a draft that was left behind by a crash / reload. */
function showDraftBannerIfAny() {
  const banner = document.getElementById("btDraftBanner");
  if (!banner) return;
  const stored = draftVotes > 0 ? null : readStoredPkDraft();
  if (!stored) {
    banner.style.display = "none";
    return;
  }
  const text = document.getElementById("btDraftBannerText");
  if (text) text.textContent = `上次有 ${stored.draftVotes} 票未套用`;
  banner.style.display = "";
}

function resumeStoredDraft() {
  const stored = readStoredPkDraft();
  if (!stored) return;
  draftElo = stored.draftElo ?? {};
  draftComp = stored.draftComp ?? {};
  draftVotes = stored.draftVotes;
  pkUndoHistory = Array.isArray(stored.undo) ? stored.undo : [];
  if (stored.scope) setPkScope(stored.scope);
  currentPair = null;
  syncBattlePool();
  showDraftBannerIfAny();
  updateBattleButtons();
  addLog("sys", "已接續上次未套用的二選一草稿", `${draftVotes} 票 · 範圍【${pkTargetScope}】`);
}

/* Battle-tab buttons. */
const onBattleClick = (id: string, fn: () => void) =>
  document.getElementById(id)?.addEventListener("click", fn);
onBattleClick("fL", () => voteBattle(0));
onBattleClick("fR", () => voteBattle(1));
onBattleClick("btTie", () => voteBattle("tie"));
onBattleClick("btDown", () => voteBattle("down"));
onBattleClick("btUndo", () => undoBattleVote());
onBattleClick("btSkip", () => nextBattlePair());
onBattleClick("btApply", () => renderApplyPreview());
onBattleClick("btPreviewCancel", () => hideApplyPreview());
onBattleClick("btPreviewConfirm", () => void confirmApplyDraft());
onBattleClick("btRevertApply", () => void revertLastApply());
onBattleClick("btDiscardYes", () => discardDraft());
onBattleClick("btDraftResume", () => resumeStoredDraft());
onBattleClick("btDiscard", () => {
  const count = document.getElementById("btDiscardCount");
  if (count) count.textContent = String(draftVotes);
  const row = document.getElementById("btDiscardConfirm");
  if (row) row.style.display = "";
});
onBattleClick("btDiscardNo", () => {
  const row = document.getElementById("btDiscardConfirm");
  if (row) row.style.display = "none";
});
onBattleClick("btDraftDrop", () => {
  clearStoredPkDraft();
  showDraftBannerIfAny();
  addLog("skip", "已丟棄上次未套用的二選一草稿", "優先序與權重未變動");
});

/* Hero page tabs: 優先序 | 分類方法：閃卡五分類 / 階層內二選一 */
type HeroTab = "priority" | BattleStage;
function activateHeroTab(tab: HeroTab) {
  document.querySelectorAll(".hero-tabs-row [data-hero-tab]").forEach((s) =>
    s.classList.toggle("on", (s as HTMLElement).dataset.heroTab === tab)
  );
  const priority = document.getElementById("tab-priority");
  const battle = document.getElementById("tab-battle");
  if (priority) priority.style.display = tab === "priority" ? "" : "none";
  if (battle) battle.style.display = tab === "priority" ? "none" : "";
  if (tab !== "priority") {
    setBattleStage(tab);
    showDraftBannerIfAny();
    updateBattleButtons();
  }
}
document.querySelector(".hero-tabs-row")?.addEventListener("click", (e) => {
  const tab = ((e.target as HTMLElement).closest("[data-hero-tab]") as HTMLElement | null)?.dataset.heroTab;
  if (tab === "priority" || tab === "flash" || tab === "pk") activateHeroTab(tab);
});

document.addEventListener("keydown", (e) => {
  const battlePage = document.getElementById("tab-battle");
  const heroPage = document.getElementById("p-hero");
  const tag = (e.target as HTMLElement)?.tagName;
  if (
    !heroPage?.classList.contains("on") ||
    battlePage?.style.display === "none" ||
    tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA"
  ) return;

  if (currentBattleStage === "flash") {
    const tierMap: Record<string, string> = {
      "1": "本命",
      "2": "愛角",
      "3": "順手",
      "4": "勉強",
      "5": "封印",
    };
    if (tierMap[e.key]) {
      e.preventDefault();
      classifyCurrentFlashCard(tierMap[e.key]);
    } else if (e.key === " ") {
      e.preventDefault();
      skipFlashCard();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      undoFlashCard();
    }
    return;
  }

  if (e.key === "ArrowLeft") {
    e.preventDefault();
    voteBattle(0);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    voteBattle(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    voteBattle("tie");
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    voteBattle("down");
  } else if (e.key === "Backspace") {
    e.preventDefault();
    undoBattleVote();
  } else if (e.key === " ") {
    e.preventDefault();
    nextBattlePair();
  }
});

/* ---------- Confirm dialog & safety backup ---------- */
/** In-app yes/no dialog (native confirm() is not dependable inside WebView2). */
function confirmDialog(title: string, body: string, okLabel = "確定"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="card confirm-box" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <div class="card-desc">${escapeHtml(body)}</div>
        <div class="confirm-actions">
          <button class="btn" data-answer="no">取消</button>
          <button class="btn primary" data-answer="yes">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    const finish = (answer: boolean) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      // Captured at document level so page shortcuts (1–5, arrows) never fire
      // underneath the dialog; Enter / Space still activate the focused button.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    overlay.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-answer]") as HTMLElement | null;
      if (btn) finish(btn.dataset.answer === "yes");
      else if (e.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    (overlay.querySelector('[data-answer="no"]') as HTMLButtonElement | null)?.focus();
  });
}

/**
 * In-app multi-choice dialog on the same overlay as `confirmDialog` (切換存檔
 * needs 取消 / 不儲存 / 儲存). Resolves the chosen value, null on cancel.
 */
function choiceDialog(
  title: string,
  body: string,
  choices: { label: string; value: string; primary?: boolean }[]
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="card confirm-box" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <div class="card-desc">${escapeHtml(body)}</div>
        <div class="confirm-actions">
          ${choices
            .map(
              (c) =>
                `<button class="btn${c.primary ? " primary" : ""}" data-answer="${escapeHtml(
                  c.value
                )}">${escapeHtml(c.label)}</button>`
            )
            .join("")}
        </div>
      </div>`;
    const finish = (answer: string | null) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      // Captured at document level so page shortcuts (1–5, arrows) never fire
      // underneath the dialog; Enter / Space still activate the focused button.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };
    overlay.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-answer]") as HTMLElement | null;
      if (btn) finish(btn.dataset.answer ?? null);
      else if (e.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    (overlay.querySelector("[data-answer]") as HTMLButtonElement | null)?.focus();
  });
}

/** Local `YYYYMMDD-HHMMSS`, the stamp format the backend accepts for backup names. */
function backupStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(
    d.getMinutes()
  )}${pad2(d.getSeconds())}`;
}

/** Snapshot the saved config before a bulk edit; false (and logged) when the backup failed. */
async function backupBeforeBulkEdit(reason: string, what: string): Promise<boolean> {
  try {
    await invoke("backup_config_snapshot", { reason, stamp: backupStamp() });
    return true;
  } catch (err) {
    addLog("err", `備份失敗，${what}已取消`, String(err));
    return false;
  }
}

/* ---------- Named Ranking Saves (排序存檔) ---------- */
// The working ranking (`profileList` + `eloMap` + `pkComparisonsMap`) keeps
// auto-saving to the config file, but it is not the active save: every save,
// the active one included, stores its own last manual save in `items`. While the
// working ranking differs from the active save it is 未儲存, and 儲存 / 還原 move
// it in and out by hand.
let rankingSaves: RankingSave[] = [];
let activeRankingSave = "";

/** Save item → config item; the remembered secondary spell stays per champion. */
function toProfileItemConfig(item: RankingSaveItem): ProfileItemConfig {
  const out: ProfileItemConfig = { id: item.id, name: item.name, tier: item.tier, flag: item.flag };
  if (item.elo !== undefined) out.elo = item.elo;
  if (item.matches !== undefined) out.matches = item.matches;
  return out;
}

function activeRankingSaveEntry(): RankingSave | undefined {
  return rankingSaves.find((s) => s.id === activeRankingSave);
}

/** Fill the save bar, the 未儲存 state and the actions that would break a limit. */
function renderRankingSaveBar() {
  const select = document.getElementById("rankSaveSelect") as HTMLSelectElement | null;
  if (select) {
    select.innerHTML = rankingSaves
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join("");
    select.value = activeRankingSave;
  }
  const del = document.getElementById("btnRankSaveDelete") as HTMLButtonElement | null;
  if (del) del.disabled = rankingSaves.length < 2;
  const add = document.getElementById("btnRankSaveNew") as HTMLButtonElement | null;
  if (add) add.disabled = rankingSaves.length >= MAX_RANKING_SAVES;

  const active = activeRankingSaveEntry();
  const dirty = active ? isDirty(active.items, profileList, eloMap, pkComparisonsMap) : false;
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
  if (save) save.items = captureLive(profileList, eloMap, pkComparisonsMap);
}

/** Show a save and make it the active one (the working ranking becomes its content). */
function loadSaveIntoLive(save: RankingSave) {
  const restored = restoreSave(save.items, profileList);
  profileList = restored.list;
  replaceWeights(eloMap, restored.elo);
  replaceWeights(pkComparisonsMap, restored.matches);
  activeRankingSave = save.id;
  // Same flash state reset as 重置: the pools belong to the previous ranking.
  flashSkippedIds.clear();
  flashSeenAllIds.clear();
  flashUndoHistory = [];
  renderTiers();
  syncFlashPool();
  syncBattlePool();
}

/** 儲存: the working ranking becomes the active save's content. */
async function saveActiveRankingSave() {
  const save = activeRankingSaveEntry();
  if (!save) return;
  saveWorkingIntoActive();
  renderRankingSaveBar();
  await saveConfigImmediate();
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
  await saveConfigImmediate();
  addLog("act", "已還原排序存檔", `「${save.name}」`);
}

async function switchRankingSave(targetId: string) {
  const target = rankingSaves.find((s) => s.id === targetId);
  if (!target || target.id === activeRankingSave) {
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
  if (active && isDirty(active.items, profileList, eloMap, pkComparisonsMap)) {
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
  await saveConfigImmediate();
  addLog("act", "已切換排序存檔", `「${target.name}」`);
}

async function saveAsNewRankingSave() {
  if (rankingSaves.length >= MAX_RANKING_SAVES) return;
  const previous = activeRankingSaveEntry();
  const previousName = previous ? previous.name : "目前的存檔";
  const body = `用畫面上目前的排序開一份新的存檔並切過去；「${previousName}」維持上次儲存的內容。`;
  const name = await promptDialog("複製成新的排序存檔", body, nextSaveName(rankingSaves));
  if (name === null) return;
  // The new save starts clean; the old one is left exactly as it was last saved.
  const save: RankingSave = {
    id: newSaveId(),
    name,
    items: captureLive(profileList, eloMap, pkComparisonsMap),
  };
  rankingSaves.push(save);
  activeRankingSave = save.id;
  renderRankingSaveBar();
  await saveConfigImmediate();
  addLog("act", "已複製成新的排序存檔", `「${name}」，之後的儲存都存在這份`);
}

async function renameRankingSave() {
  const save = activeRankingSaveEntry();
  if (!save) return;
  const name = await promptDialog("排序存檔改名", "新的名稱（最多 40 字）。", save.name);
  if (name === null) return;
  save.name = name;
  renderRankingSaveBar();
  await saveConfigImmediate();
  addLog("act", "已重新命名排序存檔", `「${name}」`);
}

async function deleteRankingSave() {
  if (rankingSaves.length < 2) return;
  const save = activeRankingSaveEntry();
  if (!save) return;
  const remaining = rankingSaves.filter((s) => s.id !== save.id);
  const next = remaining[0];
  const dirtyNote = isDirty(save.items, profileList, eloMap, pkComparisonsMap)
    ? "畫面上未儲存的修改也會一併捨棄。"
    : "";
  const draftNote = draftVotes > 0 ? `另有 ${draftVotes} 票二選一草稿尚未套用，會一併捨棄。` : "";
  const body = `這份存檔的排序、標記與二選一權重會刪除，改用「${next.name}」。${dirtyNote}${draftNote}刪除前會先自動備份到 backups/。`;
  if (!(await confirmDialog(`刪除排序存檔「${save.name}」？`, body, "備份並刪除"))) return;
  if (!(await backupBeforeBulkEdit("delete-ranking-save", "刪除存檔"))) return;
  if (draftVotes > 0) resetDraft();
  rankingSaves = remaining;
  // Load the next save the way 切換 does, but without capturing the deleted one.
  loadSaveIntoLive(next);
  renderRankingSaveBar();
  await saveConfigImmediate();
  addLog("act", "已刪除排序存檔", `「${save.name}」，改用「${next.name}」`);
}

/**
 * In-app text prompt on the confirm-dialog overlay (native prompt() is not
 * dependable inside WebView2). Resolves the trimmed value, or null on cancel.
 */
function promptDialog(title: string, body: string, initial: string, okLabel = "確定"): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="card confirm-box" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <div class="card-desc">${escapeHtml(body)}</div>
        <input class="input" maxlength="40" value="${escapeHtml(initial)}">
        <div class="confirm-actions">
          <button class="btn" data-answer="no">取消</button>
          <button class="btn primary" data-answer="yes">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    const input = overlay.querySelector("input") as HTMLInputElement | null;
    const finish = (answer: string | null) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(answer);
    };
    const commit = () => {
      const value = (input?.value ?? "").trim();
      if (value) finish(value);
    };
    const onKey = (e: KeyboardEvent) => {
      // Captured at document level so page shortcuts never fire underneath,
      // while typing in the input still works.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      } else if (e.key === "Enter" && !e.isComposing) {
        // isComposing: Enter that confirms an IME candidate (Chinese input) is not a submit.
        e.preventDefault();
        commit();
      }
    };
    overlay.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-answer]") as HTMLElement | null;
      if (!btn) {
        if (e.target === overlay) finish(null);
      } else if (btn.dataset.answer === "yes") commit();
      else finish(null);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    input?.focus();
    input?.select();
  });
}

document.getElementById("rankSaveSelect")?.addEventListener("change", (e) => {
  void switchRankingSave((e.target as HTMLSelectElement).value);
});
document.getElementById("btnRankSaveNew")?.addEventListener("click", () => void saveAsNewRankingSave());
document.getElementById("btnRankSaveSave")?.addEventListener("click", () => void saveActiveRankingSave());
document.getElementById("btnRankSaveRevert")?.addEventListener("click", () => void revertActiveRankingSave());
document.getElementById("btnRankSaveRename")?.addEventListener("click", () => void renameRankingSave());
document.getElementById("btnRankSaveDelete")?.addEventListener("click", () => void deleteRankingSave());

/* ---------- Priority Toolbar & Account Mastery Auto-Seed ---------- */
async function importMasteryToProfile() {
  try {
    const masteryList = await invoke<ChampionMasteryItem[]>("get_champion_mastery");
    if (!Array.isArray(masteryList) || masteryList.length === 0) {
      addLog("skip", "尚無專精資料可匯入", "請確認英雄聯盟客戶端已開啟並登入帳號");
      return;
    }
    const classified = profileList.filter((c) => c.t !== "未分類").length;
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

    const list = profileList;
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

    profileList = [...played, ...sealed, ...unplayed];

    // Seed ELO from mastery order so pairwise PK starts from the mastery ranking;
    // the old match counts described the replaced weights, so they restart too.
    profileList.forEach((c, idx) => {
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
  const list = profileList;
  list.forEach((c) => {
    c.t = "未分類";
    c.f = "";
  });
  list.sort((a, b) => a.n.localeCompare(b.n, "zh-Hant"));
  flashSkippedIds.clear();
  flashSeenAllIds.clear();
  flashUndoHistory = [];
  renderTiers();
  syncFlashPool();
  syncBattlePool();
  debouncedSaveConfig();
  addLog("act", "已重置英雄分級", `已將全部 ${list.length} 位英雄重置回未分類`);
});

document.getElementById("btnSortUnranked")?.addEventListener("click", () => {
  const list = profileList;
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

/* ---------- Web Audio Alert (Synthesized Beep) ---------- */
// One AudioContext for the whole session. Creating a fresh one per alert costs
// hundreds of ms on Windows/WebView2, can hit the browser's concurrent-context
// quota, and starts suspended — the main source of the perceived ff delay.
// Reusing one context + resuming when suspended makes the beep fire instantly.
let beepCtx: AudioContext | null = null;
function getBeepCtx(): AudioContext | null {
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!beepCtx) {
    beepCtx = new AudioCtx();
  }
  if (beepCtx.state === "suspended") {
    void beepCtx.resume();
  }
  return beepCtx;
}

function playBeepAlert() {
  try {
    const ctx = getBeepCtx();
    if (!ctx) return;
    const now = ctx.currentTime;

    // First tone: 880 Hz
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.setValueAtTime(880, now);
    gain1.gain.setValueAtTime(0.2, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.18);

    // Second tone: 1320 Hz
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.setValueAtTime(1320, now + 0.2);
    gain2.gain.setValueAtTime(0.25, now + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.2);
    osc2.stop(now + 0.52);
  } catch (e) {
    console.warn("AudioContext tone generation failed:", e);
  }
}

function showDesktopNotification(title: string, body: string) {
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      void Notification.requestPermission().then((permission) => {
        if (permission === "granted") new Notification(title, { body });
      });
    }
  } catch (e) {
    console.warn("Desktop notification failed:", e);
  }
}

/* ---------- Config Persistence (Debounced) ---------- */
function collectConfig(): AppConfig {
  // Snapshot the visible form into the single shared settings/profile state.
  currentSettings = readModeSettingsFromUI();
  ffTime = textValue("cfgFfTime", "08:00");

  // One shared ranking: both modes are written from the same list.
  const serializedProfile: ProfileItemConfig[] = profileList.map((c) => ({
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
    aram_settings: currentSettings,
    mayhem_settings: { ...currentSettings },
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
    ranking_saves: rankingSaves.map((s) => ({
      id: s.id,
      name: s.name,
      items: s.items.map(toProfileItemConfig),
    })),
    active_ranking_save: activeRankingSave,
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
let isLcuConnected = false;
let lastKnownPhase = "";

async function initLcuBackend() {
  // 1. Register real-time listeners FIRST so we never miss an event during startup
  await listen<ConnectionStatus>("lcu-status", (event) => {
    isLcuConnected = event.payload.connected;
    updateConnectionUI(event.payload.connected, event.payload.port);
    if (event.payload.connected) {
      void loadChampionsFromLcu();
      void syncLivePhaseAndSession(true);
      addLog("sys", "LCU 已成功連線", `Port: ${event.payload.port || "未知"}`);
    } else {
      lastKnownPhase = "";
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
    champUiState = { ...EMPTY_UI_STATE, ...event.payload };
    if (lastChampSelectData) renderOverviewColumns();
  });

  // Suggestion-only assists: the backend never acts on its own, the overview offers the click.
  await listen<AssistPayload>("lcu-assist", (event) => {
    assistState = applyAssist(assistState, event.payload);
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
    const changedConn = status.connected !== isLcuConnected;
    isLcuConnected = status.connected;
    updateConnectionUI(status.connected, status.port);
    if (status.connected) {
      const fresh = initial || changedConn;
      if (fresh) void loadChampionsFromLcu();
      // Champ select sessions arrive as lcu-event pushes; the periodic tick only
      // keeps the phase and queue label current (a lobby queue change has no event).
      await syncLivePhaseAndSession(fresh);
    } else if (changedConn) {
      lastKnownPhase = "";
      clearOverviewSteps();
      resetOverviewMiniCards();
    }
  } catch (err) {
    console.error("Failed to query LCU connection status:", err);
  }
}

/** Pick the richer of the two mirrored profiles (classified count first, then 本命 count). */
function richerProfile(aram: ProfileItemConfig[], mayhem: ProfileItemConfig[]): ProfileItemConfig[] {
  const classified = (list: ProfileItemConfig[]) => list.filter((p) => p.tier !== "未分類").length;
  const mainPicks = (list: ProfileItemConfig[]) => list.filter((p) => p.tier === "本命").length;
  const mayhemClassified = classified(mayhem);
  const aramClassified = classified(aram);
  if (mayhemClassified !== aramClassified) return mayhemClassified > aramClassified ? mayhem : aram;
  if (mayhem.length === 0) return aram;
  return mainPicks(mayhem) > mainPicks(aram) ? mayhem : aram;
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

  currentSettings = normalizeModeSettings(cfg.aram_settings ?? cfg.mayhem_settings);
  writeModeSettingsToUI(currentSettings);

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
  profileList =
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
  ensureAllBuiltinChampions(profileList);
  // Blank names (hand-edited files) fall back to the built-in name.
  for (const c of profileList) {
    if (!c.n) c.n = BUILTIN_CHAMPIONS.find((b) => b.id === c.id)?.n ?? `#${c.id}`;
  }

  const normalizedSaves = normalizeSaves(cfg.ranking_saves, cfg.active_ranking_save);
  rankingSaves = normalizedSaves.saves;
  activeRankingSave = normalizedSaves.activeId;
  // An old-format save (or the auto-created 存檔 1) has no items yet: take the
  // working ranking as its first manual save so it starts clean instead of 未儲存.
  const activeSave = rankingSaves.find((s) => s.id === activeRankingSave);
  if (activeSave && activeSave.items.length === 0) {
    activeSave.items = captureLive(profileList, eloMap, pkComparisonsMap);
  }

  renderTiers();
  fillTradeOptions();
  renderDefaultSpellPicker();
  renderSpellOverrideCount();
  syncFlashPool();
  syncBattlePool();
  renderRankingSaveBar();
}

function normalizeAcceptModes(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string" && ACCEPT_MODE_OPTIONS.includes(x))
    : [];
  return list.length > 0 ? list : ["ARAM", "Mayhem"];
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function normalizeModeSettings(src: ModeSettings | undefined): ModeSettings {
  const d = defaultModeSettings();
  const s = (src && typeof src === "object" ? src : {}) as Partial<ModeSettings>;
  return {
    auto_card_select: pickBool(s.auto_card_select, d.auto_card_select),
    card_select_delay_sec: pickNumber(s.card_select_delay_sec, d.card_select_delay_sec),
    card_select_strategy: pickString(s.card_select_strategy, d.card_select_strategy),
    auto_card_execute: pickBool(s.auto_card_execute, d.auto_card_execute),
    auto_bench_swap: pickBool(s.auto_bench_swap, d.auto_bench_swap),
    auto_bench_execute: pickBool(s.auto_bench_execute, d.auto_bench_execute),
    bench_diff_threshold: pickNumber(s.bench_diff_threshold, d.bench_diff_threshold),
    lock_stop_bench: pickBool(s.lock_stop_bench, d.lock_stop_bench),
    stop_bench_remaining_sec: pickNumber(s.stop_bench_remaining_sec, d.stop_bench_remaining_sec),
    auto_trade: pickBool(s.auto_trade, d.auto_trade),
    trade_accept_diff: pickNumber(s.trade_accept_diff, d.trade_accept_diff),
    trade_reject_tiers: Array.isArray(s.trade_reject_tiers)
      ? s.trade_reject_tiers.filter((x): x is string => typeof x === "string")
      : [...d.trade_reject_tiers],
    friend_trade_policy: pickString(s.friend_trade_policy, d.friend_trade_policy),
    default_secondary_spell: isSupportedSecondarySpell(s.default_secondary_spell)
      ? s.default_secondary_spell
      : d.default_secondary_spell,
  };
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
    const changed = mergeLcuChampions(profileList, valid);

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
const MAYHEM_QUEUE_IDS = new Set([2400, 2410, 3270]);
const ARAM_QUEUE_IDS = new Set([450, 720, 721, 860, 3200, 3210, 3220, 3230]);
const PHASE_LABELS: Record<string, string> = {
  None: "待機",
  Lobby: "大廳",
  Matchmaking: "配對中",
  ReadyCheck: "接受對戰",
  ChampSelect: "選角",
  InProgress: "遊戲中",
  EndOfGame: "結算",
};
let currentQueueId: number | null = null;

function queueModeLabel(queueId: number | null | undefined): string {
  if (queueId == null) return "其他";
  if (MAYHEM_QUEUE_IDS.has(queueId)) return "Mayhem";
  if (ARAM_QUEUE_IDS.has(queueId)) return "ARAM";
  return "其他";
}

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

function signedDiff(diff: number | null): string {
  if (diff == null) return "—";
  return `${diff >= 0 ? "+" : ""}${diff}`;
}

const EMPTY_UI_STATE: ChampSelectUiState = {
  manual_hold_champ_id: null,
  bench_retry_target: null,
  bench_verdict: null,
  trade_verdict: null,
  allied_puuids: [],
  allied_summoner_ids: [],
};
const TRADE_VERDICT_DEFAULT = "條件外或組排好友設為手動時，由你手動決定";

let champUiState: ChampSelectUiState = { ...EMPTY_UI_STATE };
/** Champ select suggestions pushed by the backend; the overview renders them with one-click buttons. */
let assistState: AssistState = emptyAssist();
let lastChampSelectData: any = null;
let overviewMyChampId = 0;
let ovSpellTrayOpen = false;

function isAlliedMember(member: any): boolean {
  if (!member) return false;
  const puuid = typeof member.puuid === "string" ? member.puuid : "";
  if (puuid && champUiState.allied_puuids.includes(puuid)) return true;
  const summonerId = Number(member.summonerId) || 0;
  return summonerId > 0 && champUiState.allied_summoner_ids.includes(summonerId);
}

function effectiveSecondarySpell(myChamp: TierChampion | undefined): number {
  const remembered = checkboxValue("cfgRememberSpells", true) ? myChamp?.secSpell : undefined;
  if (isSupportedSecondarySpell(remembered)) return remembered;
  const fallback = currentSettings.default_secondary_spell;
  return isSupportedSecondarySpell(fallback) ? fallback : DEFAULT_SECONDARY_SPELL_ID;
}

function renderMyChampColumn(myChampId: number, myChamp: TierChampion | undefined, myScore: number | null) {
  const el = document.getElementById("miniMyChamp");
  if (!el) return;
  const name = myChamp?.n || (myChampId > 0 ? `ID:${myChampId}` : "—");
  const held =
    myChampId > 0 &&
    champUiState.manual_hold_champ_id != null &&
    champUiState.manual_hold_champ_id === myChampId;
  const locked = myChamp?.f === "lock";
  const avatar = myChampId > 0 ? img(myChampId, name) : `<span class="ph">?</span>`;
  const tag =
    myChampId > 0 && held
      ? `<span class="tag">手動保護中</span>`
      : myChampId > 0 && locked
        ? `<span class="tag">已鎖定</span>`
        : "";

  el.innerHTML = `
    <h3>我的英雄</h3>
    <div class="hero">
      <span class="avatar">${avatar}</span>
      <div>
        <div class="nm">${escapeHtml(name)}</div>
        <div class="meta">${myChamp ? `${escapeHtml(myChamp.t || "未分類")} ${myScore ?? "—"} 分` : "尚未選角"}</div>
      </div>
    </div>
    ${myChampId > 0 ? renderOverviewSpells(myChamp) : ""}
    ${tag ? `<div class="hero-tag">${tag}</div>` : ""}`;
}

/**
 * Secondary spell chips for the overview: Flash slot plus clickable 鬼步 / 雪球 and a「⋯」tray
 * with the remaining spells. The effective secondary (champion memory or mode default) is marked
 * selected. Picking one writes the champion memory — see pickSecondarySpell.
 */
function renderOverviewSpells(myChamp: TierChampion | undefined): string {
  const secId = effectiveSecondarySpell(myChamp);
  const primaryKey = primarySpellKeyFromUI();
  const secKey = primaryKey === "F" ? "D" : "F";
  const extraSelected = EXTRA_SECONDARY_SPELL_IDS.includes(secId) ? secId : null;
  const pick = (id: number) => {
    const on = secId === id;
    return `<button class="spell${on ? " on" : ""}" data-pick-spell="${id}" title="${escapeHtml(
      `${secKey} 鍵帶${spellName(id)}（點擊立即切換並記住此英雄偏好）`
    )}">${spellIconHtml(id)}${on ? `<span class="key">${secKey}</span>` : ""}</button>`;
  };
  // Collapsed, an extra secondary is shown on the toggle chip so it stays visible as selected.
  const collapsedExtra = extraSelected != null && !ovSpellTrayOpen;
  const moreBtn = `<button class="spell more${collapsedExtra ? " on" : ""}" data-toggle-more-spells="1" title="${escapeHtml(
    collapsedExtra ? `其他召喚師技能（目前：${spellName(extraSelected)}）` : "展開其他召喚師技能"
  )}">${collapsedExtra ? `${spellIconHtml(extraSelected)}<span class="key">${secKey}</span>` : "⋯"}</button>`;
  const extras = ovSpellTrayOpen ? EXTRA_SECONDARY_SPELL_IDS.map(pick).join("") : "";
  const flash = `<span class="spell">${spellIconHtml(FLASH_SPELL_ID)}<span class="key">${primaryKey}</span></span>`;

  return `<div class="spells">${flash}${MAIN_SECONDARY_SPELL_IDS.map(pick).join("")}${moreBtn}${extras}</div>`;
}

function renderBenchColumn(
  bench: any[],
  profile: TierChampion[],
  scores: Record<number, number | null>,
  baseScore: number | null,
  benchDiff: number
) {
  const el = document.getElementById("miniBench");
  if (!el) return;

  const entries = bench
    .map((b) => Number(b?.championId) || 0)
    .filter((id) => id > 0)
    .map((id) => ({ id, champ: profile.find((c) => c.id === id), score: scores[id] ?? null }));
  // Highest score first; unranked (null score) entries go after the scored ones.
  entries.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const eligible = entries.filter(
    (e) =>
      e.champ &&
      e.champ.t !== "封印" &&
      e.champ.t !== "未分類" &&
      e.champ.f !== "nograb" &&
      e.score != null &&
      baseScore != null &&
      e.score - baseScore >= benchDiff
  );
  const bestId = eligible.length ? eligible[0].id : null;
  // A backend suggestion wins over the locally computed best candidate.
  const suggestedId = assistState.bench?.champId ?? bestId;

  const rows = entries
    .map((e) => {
      const name = e.champ?.n || `ID:${e.id}`;
      const diff = e.score != null && baseScore != null ? e.score - baseScore : null;
      const retrying = champUiState.bench_retry_target === e.id;
      const suggested = e.id === suggestedId;
      // 封印 / nograb champions are never grabbed; everything else is a manual candidate.
      const blocked = e.champ?.t === "封印" || e.champ?.f === "nograb";
      const grabbable = !blocked && !retrying && overviewMyChampId > 0;
      const action = blocked
        ? `<span class="ban">不搶</span>`
        : retrying
          ? `<span class="grabbing">搶角中…</span>`
          : grabbable
            ? suggested
              ? `<button class="grab primary" data-swap-bench="${e.id}" title="點擊換上建議的英雄">建議換</button>`
              : `<button class="grab" data-swap-bench="${e.id}" title="點擊手動換上">搶角</button>`
            : "";
      return `<div class="bench-row${suggested ? " hot" : ""}">${img(
        e.id,
        name
      )}
        <span class="nm">${escapeHtml(name)}</span>
        <span class="delta">${signedDiff(diff)}</span>
        ${action}
      </div>`;
    })
    .join("");

  const suggestedName =
    suggestedId != null
      ? entries.find((e) => e.id === suggestedId)?.champ?.n || `ID:${suggestedId}`
      : "";
  const suggestedReason = assistState.bench?.reason || "";
  const caption = champUiState.bench_verdict
    ? escapeHtml(champUiState.bench_verdict)
    : entries.length === 0
      ? `還沒進選角`
      : suggestedId != null
        ? `建議換上 ${escapeHtml(suggestedName)}${suggestedReason ? `・${escapeHtml(suggestedReason)}` : ""}`
        : `沒有建議換的英雄（${benchDiff} 分）`;

  el.innerHTML = `
    <h3>板凳<span class="sub">依權重排序</span></h3>
    <div class="bench-list">${rows || `<div class="ov-empty">板凳還沒解鎖</div>`}</div>
    <div class="bench-cap">${caption}</div>`;
}

function renderTradeColumn(
  data: any,
  profile: TierChampion[],
  scores: Record<number, number | null>,
  myChampId: number,
  baseScore: number | null,
  tradeDiff: number
) {
  const el = document.getElementById("tradeAlert");
  if (!el) return;
  const verdict = champUiState.trade_verdict
    ? escapeHtml(champUiState.trade_verdict)
    : TRADE_VERDICT_DEFAULT;

  const trades: any[] = Array.isArray(data?.trades) ? data.trades : [];
  const trade = trades.find((t) => t?.state === "RECEIVED");
  const member = trade && Array.isArray(data?.myTeam)
    ? data.myTeam.find((m: any) => m.cellId === trade.cellId)
    : undefined;
  const offeredId = Number(member?.championId) || 0;

  if (!trade || offeredId <= 0) {
    // No pending request: the banner takes zero space.
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }

  const offered = profile.find((c) => c.id === offeredId);
  const myChamp = myChampId > 0 ? profile.find((c) => c.id === myChampId) : undefined;
  const offeredScore = scores[offeredId] ?? null;
  const diff = offeredScore != null && baseScore != null ? offeredScore - baseScore : null;
  const isFriend = isAlliedMember(member);
  const traderName =
    member?.gameName ||
    member?.summonerName ||
    (typeof member?.riotId === "string" ? member.riotId : "") ||
    `隊友 #${trade.cellId}`;
  const myName = myChamp?.n || (myChampId > 0 ? `ID:${myChampId}` : "—");
  const tradeId = Number(trade.id) || 0;
  // A backend verdict marks the matching button as the suggestion; without one both stay plain.
  const suggestion = tradeId > 0 ? assistState.trades[tradeId] : undefined;
  const suggestLabel = suggestion ? (suggestion.verdict === "accept" ? "建議同意" : "建議拒絕") : "";
  const reasonText = suggestion?.reason ? escapeHtml(suggestion.reason) : verdict;
  const buttons =
    tradeId > 0
      ? `<span class="btn${suggestion?.verdict === "accept" ? " primary" : ""}" data-accept-trade="${tradeId}">同意</span><span class="btn${suggestion?.verdict === "reject" ? " primary" : ""}" data-decline-trade="${tradeId}">拒絕</span>`
      : "";

  el.style.display = "";
  el.innerHTML = `
    <img src="${ICON(offeredId)}" alt="" />
    <span class="tx"><b>${escapeHtml(String(traderName))}</b>（${isFriend ? "隊友" : "路人"}）想用 <b>${escapeHtml(
      offered?.n || `ID:${offeredId}`
    )}</b> 換你的 <b>${escapeHtml(myName)}</b>・分差 ${signedDiff(diff)}（門檻 ${tradeDiff}）${
      suggestLabel ? `・${suggestLabel}` : ""
    }${reasonText ? `・${reasonText}` : ""}</span>
    <span class="btns">${buttons}</span>`;
}

/**
 * Card and chat suggestions live in their own one-click banners above the columns.
 * Both stay in the DOM (hidden when empty) so their click handlers are bound once.
 */
function renderAssistBanners() {
  const cardEl = document.getElementById("cardSuggest");
  if (cardEl) {
    const card = assistState.card;
    if (!card || card.champId <= 0) {
      cardEl.style.display = "none";
      cardEl.innerHTML = "";
    } else {
      const name = profileList.find((c) => c.id === card.champId)?.n || `ID:${card.champId}`;
      cardEl.style.display = "";
      cardEl.innerHTML = `
    <img src="${ICON(card.champId)}" alt="" />
    <span class="tx"><b>${escapeHtml(name)}</b>・建議選這張${
        card.reason ? `<span class="reason">${escapeHtml(card.reason)}</span>` : ""
      }</span>
    <span class="btns"><span class="btn primary" data-pick-card="${card.champId}" data-pick-action="${
        card.actionId
      }">選這張</span></span>`;
    }
  }

  const chatEl = document.getElementById("chatSuggest");
  if (chatEl) {
    const chat = assistState.chat;
    if (!chat || !chat.text) {
      chatEl.style.display = "none";
      chatEl.innerHTML = "";
    } else {
      chatEl.style.display = "";
      chatEl.innerHTML = `
    <span class="tx">發送：<b>${escapeHtml(chat.text)}</b></span>
    <span class="btns"><span class="btn primary" data-send-chat="${escapeHtml(
      chat.chatId
    )}">發送</span><span class="btn" data-skip-chat="1">略過</span></span>`;
    }
  }
}

function renderOverviewColumns() {
  const data = lastChampSelectData;
  const profile = profileList;
  const scores = calculateScores(profile);
  const settings = currentSettings;
  const benchDiff = settings?.bench_diff_threshold ?? 10;
  const tradeDiff = settings?.trade_accept_diff ?? 10;

  const localCellId = data?.localPlayerCellId;
  let myChampId = 0;
  if (Array.isArray(data?.myTeam)) {
    for (const m of data.myTeam) {
      if (m.cellId === localCellId) {
        myChampId = m.championId || 0;
        break;
      }
    }
  }
  const myChamp = myChampId > 0 ? profile.find((c) => c.id === myChampId) : undefined;
  const myScore = myChampId > 0 ? (scores[myChampId] ?? null) : null;
  const baseScore = myScore ?? (myChampId > 0 ? UNRANKED_BASELINE_SCORE : null);
  const bench: any[] = Array.isArray(data?.benchChampions) ? data.benchChampions : [];

  overviewMyChampId = myChampId;
  renderMyChampColumn(myChampId, myChamp, myScore);
  renderBenchColumn(bench, profile, scores, baseScore, benchDiff);
  renderTradeColumn(data, profile, scores, myChampId, baseScore, tradeDiff);
  renderAssistBanners();
}

document.getElementById("miniBench")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-swap-bench]") as HTMLElement | null;
  if (!btn || btn.hasAttribute("disabled")) return;
  const championId = Number(btn.dataset.swapBench);
  // A retry in flight for the same champion must not fire a second swap request.
  if (champUiState.bench_retry_target === championId) return;
  if (championId > 0) {
    // The backend owns the bounded retry loop and logs every outcome itself.
    invoke("swap_bench_champion", { championId }).catch((err) =>
      addLog("err", "手動搶板凳失敗", String(err))
    );
  }
});

/** Remember the secondary spell for the held champion and push it to LCU right away. */
async function pickSecondarySpell(pickedId: number) {
  if (!isSupportedSecondarySpell(pickedId)) return;
  const myChampId = overviewMyChampId;
  const champ = myChampId > 0 ? profileList.find((c) => c.id === myChampId) : undefined;
  const modeDefault = currentSettings.default_secondary_spell;
  const defaultSpell = isSupportedSecondarySpell(modeDefault) ? modeDefault : DEFAULT_SECONDARY_SPELL_ID;

  let secId = pickedId;
  let isCustom = false;
  let champName = "";
  if (myChampId > 0 && champ && !checkboxValue("cfgRememberSpells", true)) {
    // Memory off: apply for this game only, keep stored memories untouched.
    secId = pickedId;
    champName = champ.n;
  } else if (myChampId > 0 && champ) {
    // Matching the default clears the override so the champion stays "預設".
    champ.secSpell = pickedId === defaultSpell ? undefined : pickedId;
    isCustom = isSupportedSecondarySpell(champ.secSpell);
    secId = isCustom ? champ.secSpell! : defaultSpell;
    champName = champ.n;
  } else {
    currentSettings.default_secondary_spell = pickedId;
    secId = pickedId;
    renderDefaultSpellPicker();
  }

  ovSpellTrayOpen = false;
  // Persist to Rust BEFORE calling apply_summoner_spells so the ensuing LCU WebSocket
  // event never reads a stale config and reverts our newly chosen spell!
  await saveConfigImmediate();

  if (isLcuConnected && lastKnownPhase === "ChampSelect") {
    const [spell1Id, spell2Id] = resolveSpellPair(secId, primarySpellKeyFromUI());
    const label = `${champName ? `【${champName}】` : ""}D ${spellName(spell1Id)} ＋ F ${spellName(
      spell2Id
    )}（${isCustom ? "英雄專屬記憶" : "模式預設"}）`;
    try {
      await invoke("apply_summoner_spells", { spell1Id, spell2Id, label });
    } catch (err) {
      addLog("err", "切換召喚師技能失敗", String(err));
    }
  }

  renderOverviewColumns();
  renderSpellOverrideCount();
}

document.getElementById("miniMyChamp")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-toggle-more-spells]")) {
    ovSpellTrayOpen = !ovSpellTrayOpen;
    renderOverviewColumns();
    return;
  }
  const pick = target.closest("[data-pick-spell]") as HTMLElement | null;
  if (!pick) return;
  void pickSecondarySpell(Number(pick.dataset.pickSpell));
});

document.getElementById("tradeAlert")?.addEventListener("click", (e) => {
  const acc = (e.target as HTMLElement).closest("[data-accept-trade]") as HTMLElement | null;
  if (acc) {
    const tradeId = Number(acc.dataset.acceptTrade);
    if (tradeId > 0) {
      invoke("accept_trade_request", { tradeId })
        .then(() => addLog("act", "已手動同意隊友換角", `Trade ID: ${tradeId}`))
        .catch((err) => addLog("err", "手動同意換角失敗", String(err)));
    }
    return;
  }
  const dec = (e.target as HTMLElement).closest("[data-decline-trade]") as HTMLElement | null;
  if (dec) {
    const tradeId = Number(dec.dataset.declineTrade);
    if (tradeId > 0) {
      invoke("decline_trade_request", { tradeId })
        .then(() => addLog("act", "已手動拒絕隊友換角", `Trade ID: ${tradeId}`))
        .catch((err) => addLog("err", "手動拒絕換角失敗", String(err)));
    }
  }
});

document.getElementById("cardSuggest")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-pick-card]") as HTMLElement | null;
  if (!btn) return;
  const championId = Number(btn.dataset.pickCard);
  const actionId = Number(btn.dataset.pickAction);
  if (championId <= 0 || actionId < 0) return;
  const name = profileList.find((c) => c.id === championId)?.n || `ID:${championId}`;
  invoke("pick_champion_card", { actionId, championId })
    .then(() => {
      assistState = applyAssist(assistState, { kind: "clear", target: "card" });
      addLog("act", "已選擇開局英雄卡", name);
      renderOverviewColumns();
    })
    .catch((err) => addLog("err", "選擇開局英雄卡失敗", String(err)));
});

document.getElementById("chatSuggest")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-skip-chat]")) {
    assistState = applyAssist(assistState, { kind: "clear", target: "chat" });
    renderOverviewColumns();
    return;
  }
  const btn = target.closest("[data-send-chat]") as HTMLElement | null;
  if (!btn) return;
  const chatId = btn.dataset.sendChat || "";
  const text = assistState.chat?.text || "";
  if (!chatId || !text) return;
  invoke("send_trade_chat", { chatId, text })
    .then(() => {
      assistState = applyAssist(assistState, { kind: "clear", target: "chat" });
      addLog("act", "已發送換角訊息", text);
      renderOverviewColumns();
    })
    .catch((err) => addLog("err", "發送換角訊息失敗", String(err)));
});

function resetOverviewMiniCards() {
  lastChampSelectData = null;
  champUiState = { ...EMPTY_UI_STATE };
  assistState = emptyAssist();
  renderOverviewColumns();
}

/** Sync the phase (and queue label); `withSession` also pulls the champ select state, for a fresh connection. */
async function syncLivePhaseAndSession(withSession: boolean) {
  try {
    const phase = await invoke<string | null>("get_gameflow_phase");
    await updateGameflowPhase(phase || "None");
    if (withSession && phase === "ChampSelect") {
      // Reconnecting mid-champ-select: adopt the backend verdicts before rendering.
      try {
        const state = await invoke<ChampSelectUiState>("get_champ_select_ui_state");
        champUiState = { ...EMPTY_UI_STATE, ...state };
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

function handleChampSelectLiveUI(data: any) {
  if (!data) return;
  lastChampSelectData = data;
  renderOverviewColumns();
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
  const phaseChanged = phase !== lastKnownPhase;
  lastKnownPhase = phase;

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
  const normalizedPhase = isLcuConnected && (phase === "None" || phase === "")
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

/* ---------- App Update (版本與更新) ---------- */
let appVersion = "";
const appVersionText = document.getElementById("appVersionText");
const updateStatusText = document.getElementById("updateStatusText");
const btnCheckUpdate = document.getElementById("btnCheckUpdate") as HTMLButtonElement | null;

function setUpdateStatus(text: string) {
  if (updateStatusText) updateStatusText.textContent = text;
}

/** Release notes, prefixed with a warning when a relaunch would interrupt a game. */
function updateDialogBody(body: string | undefined): string {
  const notes = releaseNotes(body);
  if (!isBusyPhase(lastKnownPhase)) return notes;
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

function initUpdaterUi() {
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

// Initial bootstrap
fillTradeOptions();
renderTiers();
renderChatMessages();
applyAcceptModesToUI();
writeModeSettingsToUI(currentSettings);
renderSpellOverrideCount();
syncFlashPool();
syncBattlePool();
resetOverviewMiniCards();
addLog("sys", "ARAM 助手啟動完成", "讀取本地設定與 LCU 連線核心中...");
initLcuBackend().catch(console.error);
initUpdaterUi();
