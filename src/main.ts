import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BUILTIN_CHAMPIONS } from "./champions";

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
  auto_bench_swap: boolean;
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
  auto_summoner_spells: boolean;
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
  client_close_action: string; // "wait", "exit"
  close_to_tray: boolean;
  auto_start: boolean;
  aram_profile: ProfileItemConfig[];
  mayhem_profile: ProfileItemConfig[];
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
document.getElementById("btnMinimize")?.addEventListener("click", () => {
  invoke("minimize_window").catch(console.error);
});
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
  if (p === "battle") {
    syncFlashPool();
    syncBattlePool();
  }
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
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--p", `${pct}%`);
  };
  const upd = () => {
    paint();
    if (numBuddy && numBuddy.value !== input.value) {
      numBuddy.value = input.value;
    }
    if (!out) return;
    out.textContent =
      input.dataset.zero && +input.value === 0
        ? input.dataset.zero
        : (input.dataset.prefix || "") + input.value + (input.dataset.suffix || "");
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
        if (out) {
          out.textContent =
            input.dataset.zero && clamped === 0
              ? input.dataset.zero
              : (input.dataset.prefix || "") + clamped + (input.dataset.suffix || "");
        }
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
    auto_bench_swap: true,
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
    card_select_delay_sec: numberValue("cfgCardDelay", 3),
    card_select_strategy: activeSegValue("cardStrategy") || "highest_score",
    auto_bench_swap: checkboxValue("cfgAutoBench", true),
    bench_diff_threshold: numberValue("cfgBenchDiff", 10),
    lock_stop_bench: checkboxValue("cfgLockStopBench", true),
    stop_bench_remaining_sec: numberValue("cfgStopBenchTime", 5),
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
  setCheckbox("cfgAutoBench", s.auto_bench_swap);
  setRangeValue("cfgBenchDiff", s.bench_diff_threshold);
  setCheckbox("cfgLockStopBench", s.lock_stop_bench);
  setRangeValue("cfgStopBenchTime", s.stop_bench_remaining_sec);
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

function renderSpellOverrideCount() {
  const el = document.getElementById("spellOverrideCountText");
  if (!el) return;
  const list = profileList;
  const count = list.filter((c) => isSupportedSecondarySpell(c.secSpell)).length;
  el.textContent =
    count > 0
      ? `目前已記憶 ${count} 位英雄的專屬副技能（在總覽選角時點選副技能即自動記憶）`
      : "目前已記憶 0 位英雄的專屬副技能（在總覽選角時點選副技能即自動記憶）";
}

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
const ACCENTS: Record<string, { accent: string; ink: string }> = {
  crimson: { accent: "#EF4444", ink: "#FFFFFF" },
  amber: { accent: "#E5A93C", ink: "#0E0E11" },
  emerald: { accent: "#34D399", ink: "#061C14" },
  violet: { accent: "#C084FC", ink: "#160826" },
};
function setAccent(a: string) {
  const cfg = ACCENTS[a] || ACCENTS.crimson;
  document.documentElement.style.setProperty("--accent", cfg.accent);
  document.documentElement.style.setProperty("--accent-ink", cfg.ink);
  document.documentElement.style.setProperty("--accent2", cfg.accent);
  document.querySelectorAll("#accentPicker button").forEach((b) =>
    b.classList.toggle("on", (b as HTMLElement).dataset.accent === a)
  );
  localStorage.setItem("app-accent", a);
}
document.querySelectorAll("#accentPicker button").forEach((b) =>
  b.addEventListener("click", () => {
    const chosen = (b as HTMLElement).dataset.accent || "crimson";
    setAccent(chosen);
    debouncedSaveConfig();
  })
);
setAccent(localStorage.getItem("app-accent") || "crimson");

/* ---------- Log Engine ---------- */
interface LogRow {
  time: string;
  kind: "act" | "skip" | "sys" | "err";
  title: string;
  reason: string;
}
const logHistory: LogRow[] = [];
let logFilter: "all" | LogRow["kind"] = "all";

function addLog(kind: "act" | "skip" | "sys" | "err", title: string, reason: string) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(
    now.getSeconds()
  ).padStart(2, "0")}`;
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
  const elShort = document.getElementById("logShort");
  if (elShort) {
    const last = logHistory[0];
    elShort.innerHTML = last
      ? `<span class="t">${last.time}</span><span class="x">${escapeHtml(last.title)}</span><span class="r">${escapeHtml(last.reason)}</span>`
      : `<span class="x" style="color:var(--dim)">尚無紀錄</span>`;
  }
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
  "cfgLockStopBench",
  "cfgFfTime",
  "cfgFfCooldownReminder",
  "cfgCloseToTray",
  "cfgAutoStart",
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
  if (!dropZone) return;
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
    why = `🤝 組排/好友換角特權：自動同意讓出【${myChamp.n}】換取【${offerChamp.n}】`;
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
  document.querySelectorAll("#btStageSeg button").forEach((b) => {
    b.classList.toggle("on", (b as HTMLElement).dataset.stage === stage);
  });
  const flashWrap = document.getElementById("btFlashWrap");
  const pkWrap = document.getElementById("btPkWrap");
  if (flashWrap) flashWrap.style.display = stage === "flash" ? "" : "none";
  if (pkWrap) pkWrap.style.display = stage === "pk" ? "" : "none";
  if (stage === "flash") syncFlashPool();
  else syncBattlePool();
}

document.getElementById("btStageSeg")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
  const stage = b?.dataset.stage as BattleStage | undefined;
  if (stage === "flash" || stage === "pk") setBattleStage(stage);
});

document.getElementById("flashGoPk")?.addEventListener("click", () => {
  setBattleStage("pk");
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
const RECENT_CHAMP_LIMIT = 4;
const RECENT_PAIR_LIMIT = 20;

const eloMap: Record<number, number> = {};
const pkComparisonsMap: Record<number, number> = {};
let battleRoundCount = 1;
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
const recentBattleChampIds: number[] = [];
const recentPairKeys: string[] = [];

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const eloOf = (c: TierChampion) => eloMap[c.id] ?? 1500;
const compOf = (c: TierChampion) => pkComparisonsMap[c.id] ?? 0;

document.getElementById("pkTierSeg")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
  const tier = b?.dataset.tier;
  if (!tier) return;
  pkTargetScope = tier;
  document.querySelectorAll("#pkTierSeg button").forEach((x) => x.classList.toggle("on", x === b));
  currentPair = null;
  recentBattleChampIds.length = 0;
  recentPairKeys.length = 0;
  syncBattlePool();
});

function resolvePkPool(list: TierChampion[]): TierChampion[] {
  if (pkTargetScope === "top2") {
    return list.filter((c) => c.t === "本命" || c.t === "愛角");
  }
  if (pkTargetScope === "all") {
    return list.filter((c) => c.t !== "封印");
  }
  return list.filter((c) => c.t === pkTargetScope);
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
  for (let i = recentBattleChampIds.length - 1; i >= 0; i--) {
    if (!poolIds.has(recentBattleChampIds[i])) recentBattleChampIds.splice(i, 1);
  }
  for (let i = recentPairKeys.length - 1; i >= 0; i--) {
    const [x, y] = recentPairKeys[i].split("-").map(Number);
    if (!poolIds.has(x) || !poolIds.has(y)) recentPairKeys.splice(i, 1);
  }

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
    <div class="meta">${escapeHtml(c.t)} · 權重 ${Math.round(eloOf(c))} · 已比 ${compOf(c)} 次</div>
    <span class="key">${k}</span>`;

  const elL = document.getElementById("fL");
  const elR = document.getElementById("fR");
  if (battlePool.length < 2) {
    const msg = `<div class="nm">此範圍英雄不足 2 隻</div><div class="meta">請先用「① 閃卡五分類」或「帳號專精自動初排」放入英雄，或切換上方範圍。</div>`;
    if (elL) elL.innerHTML = msg;
    if (elR) elR.innerHTML = `<div class="nm">—</div>`;
  } else {
    if (elL) elL.innerHTML = currentPair ? card(currentPair[0], "←") : `<div class="nm">—</div>`;
    if (elR) elR.innerHTML = currentPair ? card(currentPair[1], "→") : `<div class="nm">—</div>`;
  }

  const est = estimatedPkRounds();
  const minPlayed = battlePool.length > 0 ? Math.min(...battlePool.map((c) => compOf(c))) : 0;
  const coveredCount = battlePool.filter((c) => compOf(c) > 0).length;
  const rEl = document.getElementById("btRound");
  if (rEl) {
    rEl.textContent = `第 ${battleRoundCount} 回合 · 已出場 ${coveredCount}/${battlePool.length} 隻（最少已比 ${minPlayed} 次）`;
  }
  const bEl = document.getElementById("btBar");
  if (bEl) {
    const coveragePct = battlePool.length > 0 ? (coveredCount / battlePool.length) * 100 : 0;
    const roundPct = (battleRoundCount / est) * 100;
    bEl.style.width = `${Math.min(100, Math.max(coveragePct, roundPct))}%`;
  }

  const rankEl = document.getElementById("rank");
  if (rankEl) {
    rankEl.innerHTML = [...battlePool]
      .sort((x, y) => eloOf(y) - eloOf(x))
      .slice(0, 12)
      .map(
        (c) =>
          `<li>${img(c.id, c.n)}<span>${escapeHtml(c.n)}</span><span class="elo">${Math.round(eloOf(c))}</span></li>`
      )
      .join("");
  }
}

function nextBattlePair() {
  if (battlePool.length < 2) {
    currentPair = null;
    renderBattle();
    return;
  }

  // 1. Exclude just-shown champions when the pool has >= 4 entries, then pick from the LEAST compared champions!
  const recentLimit = Math.max(0, Math.min(RECENT_CHAMP_LIMIT, battlePool.length - 2));
  const excluded = new Set(recentBattleChampIds.slice(-recentLimit));
  let candidatesA = battlePool.filter((c) => !excluded.has(c.id));
  if (candidatesA.length === 0) candidatesA = [...battlePool];

  const minCompA = Math.min(...candidatesA.map((c) => compOf(c)));
  const leastPlayedA = candidatesA.filter((c) => compOf(c) === minCompA);
  const a = leastPlayedA[Math.floor(Math.random() * leastPlayedA.length)];

  // 2. For partner B, avoid recent pairs with A and prioritize low comparison count + close Elo.
  const recentPairs = new Set(recentPairKeys);
  let candidatesB = battlePool.filter(
    (c) => c.id !== a.id && !excluded.has(c.id) && !recentPairs.has(pairKey(a.id, c.id))
  );
  if (candidatesB.length === 0) {
    candidatesB = battlePool.filter((c) => c.id !== a.id && !recentPairs.has(pairKey(a.id, c.id)));
  }
  if (candidatesB.length === 0) {
    candidatesB = battlePool.filter((c) => c.id !== a.id);
  }

  candidatesB.sort((x, y) => {
    const compDiff = compOf(x) - compOf(y);
    if (compDiff !== 0) return compDiff;
    return Math.abs(eloOf(x) - eloOf(a)) - Math.abs(eloOf(y) - eloOf(a));
  });

  const topB = candidatesB.slice(0, Math.min(4, candidatesB.length));
  const b = topB[Math.floor(Math.random() * topB.length)];

  currentPair = [a, b];
  if (Math.random() < 0.5) currentPair.reverse();

  recentBattleChampIds.push(currentPair[0].id, currentPair[1].id);
  while (recentBattleChampIds.length > RECENT_CHAMP_LIMIT) recentBattleChampIds.shift();
  recentPairKeys.push(pairKey(a.id, b.id));
  while (recentPairKeys.length > RECENT_PAIR_LIMIT) recentPairKeys.shift();

  renderBattle();
}

function syncOrderFromElo() {
  if (battlePool.length < 2) return;
  const sorted = [...battlePool].sort((x, y) => eloOf(y) - eloOf(x));
  const currentList = profileList;
  const poolIdSet = new Set(sorted.map((c) => c.id));

  if (pkTargetScope === "top2") {
    const numBenming = Math.max(1, Math.round(sorted.length * 0.35));
    sorted.forEach((c, i) => {
      c.t = i < numBenming ? "本命" : "愛角";
    });
  } else if (pkTargetScope === "all") {
    const n1 = Math.max(1, Math.round(sorted.length * 0.12));
    const n2 = Math.max(1, Math.round(sorted.length * 0.22));
    const n3 = Math.max(1, Math.round(sorted.length * 0.34));
    sorted.forEach((c, i) => {
      if (i < n1) c.t = "本命";
      else if (i < n1 + n2) c.t = "愛角";
      else if (i < n1 + n2 + n3) c.t = "順手";
      else c.t = "勉強";
    });
  }

  const slots: number[] = [];
  currentList.forEach((c, i) => {
    if (poolIdSet.has(c.id)) slots.push(i);
  });
  slots.forEach((slot, k) => {
    if (sorted[k]) currentList[slot] = sorted[k];
  });

  renderTiers();
  debouncedSaveConfig();
}

function voteBattle(winner: 0 | 1 | "tie" | "down") {
  if (!currentPair) return;
  const [a, b] = currentPair;
  const K = 32;
  const elo = eloMap;
  const comp = pkComparisonsMap;

  pkUndoHistory.push({
    aId: a.id,
    bId: b.id,
    prevEloA: eloOf(a),
    prevEloB: eloOf(b),
    prevCompA: compOf(a),
    prevCompB: compOf(b),
  });

  const ea = 1 / (1 + Math.pow(10, (eloOf(b) - eloOf(a)) / 400));
  const sa = winner === 0 ? 1 : winner === 1 ? 0 : winner === "tie" ? 0.5 : null;

  if (sa != null) {
    elo[a.id] = eloOf(a) + K * (sa - ea);
    elo[b.id] = eloOf(b) - K * (sa - ea);
  }
  if (winner === "down") {
    elo[a.id] = eloOf(a) - 18;
    elo[b.id] = eloOf(b) - 18;
  }
  comp[a.id] = compOf(a) + 1;
  comp[b.id] = compOf(b) + 1;

  battleRoundCount += 1;
  // Immediately persist the updated order & Elo after every single click!
  syncOrderFromElo();
  nextBattlePair();
}

function undoBattleVote() {
  const hist = pkUndoHistory;
  if (!hist || hist.length === 0) return;
  const last = hist.pop()!;
  const elo = eloMap;
  const comp = pkComparisonsMap;
  elo[last.aId] = last.prevEloA;
  elo[last.bId] = last.prevEloB;
  comp[last.aId] = last.prevCompA;
  comp[last.bId] = last.prevCompB;
  battleRoundCount = Math.max(1, battleRoundCount - 1);

  const a = battlePool.find((c) => c.id === last.aId);
  const b = battlePool.find((c) => c.id === last.bId);
  if (a && b) {
    currentPair = [a, b];
  }
  syncOrderFromElo();
  renderBattle();
}

document.getElementById("fL")?.addEventListener("click", () => voteBattle(0));
document.getElementById("fR")?.addEventListener("click", () => voteBattle(1));
document.getElementById("btTie")?.addEventListener("click", () => voteBattle("tie"));
document.getElementById("btDown")?.addEventListener("click", () => voteBattle("down"));
document.getElementById("btUndo")?.addEventListener("click", () => undoBattleVote());
document.getElementById("btSkip")?.addEventListener("click", () => {
  battleRoundCount += 1;
  nextBattlePair();
});

document.getElementById("btApply")?.addEventListener("click", () => {
  applyBattleToTiers();
});

function applyBattleToTiers() {
  syncOrderFromElo();
  addLog(
    "act",
    "二選一順位已套用",
    `已將 ${battlePool.length} 位英雄依對決權重寫入【共用 · ${pkTargetScope}】順位`
  );
  go("hero");
}

/* Hero page tabs: 優先序 / 二選一 */
function activateHeroTab(tab: string) {
  document.querySelectorAll("#heroTabs span").forEach((s) =>
    s.classList.toggle("on", (s as HTMLElement).dataset.heroTab === tab)
  );
  const priority = document.getElementById("tab-priority");
  const battle = document.getElementById("tab-battle");
  if (priority) priority.style.display = tab === "priority" ? "" : "none";
  if (battle) battle.style.display = tab === "battle" ? "" : "none";
  if (tab === "battle") {
    syncFlashPool();
    syncBattlePool();
  }
}
document.getElementById("heroTabs")?.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-hero-tab]") as HTMLElement | null;
  if (t?.dataset.heroTab) activateHeroTab(t.dataset.heroTab);
});
document.getElementById("btnGotoBattle")?.addEventListener("click", () => {
  go("hero");
  activateHeroTab("battle");
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
    battleRoundCount += 1;
    nextBattlePair();
  }
});

/* ---------- Priority Toolbar & Account Mastery Auto-Seed ---------- */
async function importMasteryToProfile() {
  try {
    const masteryList = await invoke<ChampionMasteryItem[]>("get_champion_mastery");
    if (!Array.isArray(masteryList) || masteryList.length === 0) {
      addLog("skip", "尚無專精資料可匯入", "請確認英雄聯盟客戶端已開啟並登入帳號");
      return;
    }

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

    // Seed ELO from mastery order so pairwise PK starts from the mastery ranking.
    profileList.forEach((c, idx) => {
      eloMap[c.id] = 1700 - idx * 2;
    });

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
document.getElementById("btnFlashImportMastery")?.addEventListener("click", () => {
  void importMasteryToProfile();
});

document.getElementById("btnResetTiers")?.addEventListener("click", () => {
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
document.getElementById("btnExportJson")?.addEventListener("click", () => {
  try {
    const blob = new Blob([JSON.stringify(collectConfig(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "aram-assistant-config.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    addLog("act", "已匯出設定檔", "aram-assistant-config.json");
  } catch (e) {
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
    const parsed = JSON.parse(await file.text()) as AppConfig;
    applyConfigToUI(parsed);
    debouncedSaveConfig();
    addLog("act", "已匯入設定檔", file.name);
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
    master_enabled: checkboxValue("master", true),
    accent_color: localStorage.getItem("app-accent") || "crimson",
    auto_summoner_spells: checkboxValue("cfgAutoSpells", true),
    primary_spell_key: primarySpellKeyFromUI(),
    auto_accept: checkboxValue("cfgAutoAccept", true),
    accept_delay_sec: numberValue("cfgAcceptDelay", 2),
    accept_modes: [...acceptModes],
    accept_notify: activeSegValue("cfgAcceptNotify") || "sound",
    aram_settings: currentSettings,
    mayhem_settings: { ...currentSettings },
    auto_chat_on_swap: checkboxValue("cfgAutoChat", true),
    chat_delay_sec: numberValue("cfgChatDelay", 1),
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
    client_close_action: activeSegValue("cfgClientCloseAction") || "wait",
    close_to_tray: checkboxValue("cfgCloseToTray", true),
    auto_start: checkboxValue("cfgAutoStart", false),
    aram_profile: serializedProfile,
    mayhem_profile: serializedProfile,
  };
}

let saveTimer: any = null;
async function saveConfigImmediate() {
  clearTimeout(saveTimer);
  try {
    await invoke("save_app_config", { newConfig: collectConfig(), expectedPuuid: activePuuid });
  } catch (e) {
    console.error("Failed to save config:", e);
  }
}
function debouncedSaveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveConfigImmediate();
  }, 350);
}

document.getElementById("master")?.addEventListener("change", () => {
  debouncedSaveConfig();
});

/* ---------- LCU Backend Integration ---------- */
let isLcuConnected = false;
let lastKnownPhase = "";
/** Puuid of the account the displayed settings belong to (null until detected). */
let activePuuid: string | null = null;

async function initLcuBackend() {
  // 1. Register real-time listeners FIRST so we never miss an event during startup
  await listen<ConnectionStatus>("lcu-status", (event) => {
    isLcuConnected = event.payload.connected;
    updateConnectionUI(event.payload.connected, event.payload.port);
    if (event.payload.connected) {
      void loadChampionsFromLcu();
      void syncLivePhaseAndSession();
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
    if (!(checkboxValue("master", true) && checkboxValue("cfgAutoFf", false))) return;
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

  await listen("lcu-ready-accepted", () => {
    notifyAccept();
  });

  await listen<AppConfig>("config-updated", (event) => applyConfigToUI(event.payload));

  await listen<ActiveAccount>("account-changed", (event) => {
    activePuuid = event.payload.puuid;
    updateAccountPill(event.payload);
    addLog("sys", "帳號設定已切換", event.payload.display_name || "未知帳號");
  });

  // 2. Load saved config
  try {
    const account = await invoke<ActiveAccount | null>("get_active_account");
    activePuuid = account?.puuid ?? null;
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
      if (initial || changedConn) {
        void loadChampionsFromLcu();
      }
      await syncLivePhaseAndSession();
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

  setCheckbox("master", cfg.master_enabled ?? true);
  setCheckbox("cfgAutoSpells", cfg.auto_summoner_spells ?? true);
  setSegValue("cfgPrimarySpellKey", (cfg.primary_spell_key || "D").toUpperCase() === "F" ? "F" : "D");
  setCheckbox("cfgAutoAccept", cfg.auto_accept ?? true);
  setRangeValue("cfgAcceptDelay", cfg.accept_delay_sec ?? 2);
  acceptModes = normalizeAcceptModes(cfg.accept_modes);
  applyAcceptModesToUI();
  setSegValue("cfgAcceptNotify", cfg.accept_notify || "sound");

  currentSettings = normalizeModeSettings(cfg.aram_settings ?? cfg.mayhem_settings);
  writeModeSettingsToUI(currentSettings);

  setCheckbox("cfgAutoChat", cfg.auto_chat_on_swap ?? true);
  setRangeValue("cfgChatDelay", cfg.chat_delay_sec ?? 1);
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
  if (chosenProfile.length > 0) {
    let totalMatches = 0;
    profileList = chosenProfile
      .filter((p) => p.id > 0 && p.id < 10000)
      .map((p) => {
        if (typeof p.elo === "number" && Number.isFinite(p.elo)) eloMap[p.id] = p.elo;
        if (typeof p.matches === "number" && Number.isFinite(p.matches)) {
          pkComparisonsMap[p.id] = p.matches;
          totalMatches += p.matches;
        }
        return {
          id: p.id,
          n: p.name,
          t: p.tier,
          f: p.flag,
          secSpell: isSupportedSecondarySpell(p.secondary_spell) ? p.secondary_spell : undefined,
        };
      });
    battleRoundCount = Math.max(1, Math.floor(totalMatches / 2) + 1);
  }
  ensureAllBuiltinChampions(profileList);

  renderTiers();
  fillTradeOptions();
  renderDefaultSpellPicker();
  renderSpellOverrideCount();
  syncFlashPool();
  syncBattlePool();
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
    auto_bench_swap: pickBool(s.auto_bench_swap, d.auto_bench_swap),
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
  if (connected) {
    updateMatchStatusBadge(`LCU 已連線 (${port || "OK"})`, "on");
  } else {
    updateMatchStatusBadge("等待客戶端", "warn");
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

function mergeLcuChampions(target: TierChampion[], champs: ChampionItem[]) {
  const byId = new Map(target.map((c) => [c.id, c]));
  const seen = new Set<number>();
  for (const item of champs) {
    if (!(item.id > 0 && item.id < 10000) || seen.has(item.id)) continue;
    seen.add(item.id);
    const existing = byId.get(item.id);
    if (existing) {
      // Update the localized name in place so the user's ordering is preserved.
      existing.n = item.name;
    } else {
      const fresh: TierChampion = { id: item.id, n: item.name, t: "未分類", f: "" };
      target.push(fresh);
      byId.set(item.id, fresh);
    }
  }
}

async function loadChampionsFromLcu() {
  try {
    const champs: ChampionItem[] = await invoke("get_champions");
    const valid = Array.isArray(champs) ? champs.filter((c) => c.id > 0 && c.id < 10000) : [];
    if (valid.length === 0) return;

    addLog("sys", `已載入 ${valid.length} 位繁中英雄名稱資料`, "本地 LCU 資產解析完成");

    // One shared ranking: keep the loaded list in sync for both modes.
    mergeLcuChampions(profileList, valid);

    renderTiers();
    fillTradeOptions();
    syncFlashPool();
    syncBattlePool();
    debouncedSaveConfig();
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

function updateMatchStatusBadge(text: string, state: "idle" | "on" | "warn" = "idle") {
  const el = document.getElementById("matchStatusBadge");
  if (!el) return;
  el.className = "right pill" + (state === "on" ? " connected" : state === "warn" ? " warn" : "");
  el.innerHTML = `<i class="dot"></i>${escapeHtml(text)}`;
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
let lastChampSelectData: any = null;
let overviewMyChampId = 0;

function isAlliedMember(member: any): boolean {
  if (!member) return false;
  const puuid = typeof member.puuid === "string" ? member.puuid : "";
  if (puuid && champUiState.allied_puuids.includes(puuid)) return true;
  const summonerId = Number(member.summonerId) || 0;
  return summonerId > 0 && champUiState.allied_summoner_ids.includes(summonerId);
}

function effectiveSecondarySpell(myChamp: TierChampion | undefined): number {
  const remembered = myChamp?.secSpell;
  if (isSupportedSecondarySpell(remembered)) return remembered;
  const fallback = currentSettings.default_secondary_spell;
  return isSupportedSecondarySpell(fallback) ? fallback : DEFAULT_SECONDARY_SPELL_ID;
}

function renderMyChampColumn(
  myChampId: number,
  myChamp: TierChampion | undefined,
  myScore: number | null,
  _benchDiff: number
) {
  const el = document.getElementById("miniMyChamp");
  if (!el) return;
  const name = myChamp?.n || (myChampId > 0 ? `ID:${myChampId}` : "—");
  const held =
    myChampId > 0 &&
    champUiState.manual_hold_champ_id != null &&
    champUiState.manual_hold_champ_id === myChampId;
  const locked = myChamp?.f === "lock";
  // Overview is read-only: spells are display-only here; editing lives in 設定.
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

/** Display-only spell chips for the overview (editing lives in 設定). */
function renderOverviewSpells(myChamp: TierChampion | undefined): string {
  const secId = effectiveSecondarySpell(myChamp);
  const primaryKey = primarySpellKeyFromUI();
  const flashId = FLASH_SPELL_ID;
  const spell = (id: number, key: string) =>
    `<span class="spell">${spellIconHtml(id)}<span class="key">${key}</span></span>`;
  const flashInPrimary = primaryKey === "D";
  return `<div class="spells">${flashInPrimary ? spell(flashId, "D") + spell(secId, "F") : spell(secId, "D") + spell(flashId, "F")}</div>`;
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
  const best = eligible.length ? eligible[0] : null;

  const rows = entries
    .map((e) => {
      const name = e.champ?.n || `ID:${e.id}`;
      const diff = e.score != null && baseScore != null ? e.score - baseScore : null;
      const retrying = champUiState.bench_retry_target === e.id;
      const swappedIn = myChampIdGlobal() === e.id;
      const hot = e.id === bestId && !swappedIn;
      const manual = hot && myChampIdGlobal() > 0;
      return `<div class="bench-row${hot ? " hot" : ""}"${
        manual ? ` data-swap-bench="${e.id}" title="點擊手動換上" style="cursor:pointer"` : ""
      }>${img(
        e.id,
        name
      )}
        <span class="nm">${escapeHtml(name)}</span>
        ${hot ? `<span class="will">${retrying ? "搶角中…" : "會換入"}</span>` : ""}
        <span class="delta">${signedDiff(diff)}</span>
      </div>`;
    })
    .join("");

  const caption = best
    ? `${escapeHtml(best.champ?.n || `ID:${best.id}`)}高於手上 ${signedDiff(best.score != null && baseScore != null ? best.score - baseScore : null)}（門檻 ${benchDiff}）`
    : champUiState.bench_verdict
      ? escapeHtml(champUiState.bench_verdict)
      : entries.length > 0
        ? `未達門檻（${benchDiff}），不會自動換入`
        : `還沒進選角`;

  el.innerHTML = `
    <h3>板凳<span class="sub">依權重排序</span></h3>
    <div class="bench-list">${rows || `<div class="ov-empty">板凳還沒解鎖</div>`}</div>
    <div class="bench-cap">${caption}</div>`;
}

// Overview column index passed via renderOverviewColumns (avoids extra params).
function myChampIdGlobal(): number {
  return overviewMyChampId;
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
  const buttons =
    tradeId > 0
      ? `<span class="btn primary" data-accept-trade="${tradeId}">同意</span><span class="btn" data-decline-trade="${tradeId}">拒絕</span>`
      : "";

  el.style.display = "";
  el.innerHTML = `
    <img src="${ICON(offeredId)}" alt="" />
    <span class="tx"><b>${escapeHtml(String(traderName))}</b>（${isFriend ? "隊友" : "路人"}）想用 <b>${escapeHtml(
      offered?.n || `ID:${offeredId}`
    )}</b> 換你的 <b>${escapeHtml(myName)}</b>・分差 ${signedDiff(diff)}（門檻 ${tradeDiff}）${verdict ? `・${verdict}` : ""}</span>
    <span class="btns">${buttons}</span>`;
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
  renderMyChampColumn(myChampId, myChamp, myScore, benchDiff);
  renderBenchColumn(bench, profile, scores, baseScore, benchDiff);
  renderTradeColumn(data, profile, scores, myChampId, baseScore, tradeDiff);
}

document.getElementById("miniBench")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-swap-bench]") as HTMLElement | null;
  if (!btn || btn.hasAttribute("disabled")) return;
  const championId = Number(btn.dataset.swapBench);
  if (championId > 0) {
    // The backend owns the bounded retry loop and logs every outcome itself.
    invoke("swap_bench_champion", { championId }).catch((err) =>
      addLog("err", "手動搶板凳失敗", String(err))
    );
  }
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

function resetOverviewMiniCards() {
  lastChampSelectData = null;
  champUiState = { ...EMPTY_UI_STATE };
  renderOverviewColumns();
}

async function syncLivePhaseAndSession() {
  try {
    const phase = await invoke<string | null>("get_gameflow_phase");
    await updateGameflowPhase(phase || "None");
    if (phase === "ChampSelect") {
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
  updateOverviewModeSub();

  const modeLabel = currentModeLabel();
  const phaseLabel = PHASE_LABELS[phase] || phase;

  // Single phase indicator lives in the overview header (titlebar keeps only
  // the connection pill now).
  const phaseNow = document.getElementById("overviewPhase");
  if (phaseNow) phaseNow.innerHTML = `<i></i><em>${phaseLabel} · ${modeLabel}</em>`;

  const stepOrder = ["Lobby", "Matchmaking", "ReadyCheck", "ChampSelect", "InProgress"];
  // When connected to the LoL client home screen ("None") or room ("Lobby"), light up "大廳" (index 0).
  const normalizedPhase = isLcuConnected && (phase === "None" || phase === "") ? "Lobby" : phase;
  const currentIdx = stepOrder.indexOf(normalizedPhase);
  stepOrder.forEach((stepPhase, idx) => {
    const el = document.getElementById(`st-${stepPhase}`);
    if (!el) return;
    el.classList.toggle("done", currentIdx > idx);
    el.classList.toggle("now", currentIdx === idx);
  });
  if (phase !== "ChampSelect") {
    resetOverviewMiniCards();
  }

  updateMatchStatusBadge(`${phaseLabel} · ${modeLabel}`, isLcuConnected ? "on" : "idle");

  if (phaseChanged) {
    addLog("sys", `遊戲流程階段變更：${phase}`, "Gameflow Phase");
  }
}

function updateOverviewModeSub() {
  // Mode is shown in the header phase indicator now; nothing to narrate here.
  return;
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
writeModeSettingsToUI(currentSettings);
renderSpellOverrideCount();
syncFlashPool();
syncBattlePool();
resetOverviewMiniCards();
addLog("sys", "ARAM 助手啟動完成", "讀取本地設定與 LCU 連線核心中...");
initLcuBackend().catch(console.error);
