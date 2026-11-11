import { invoke } from "@tauri-apps/api/core";
import { applyAssist, emptyAssist, type AssistPayload, type AssistState } from "./assist";
import { checkboxValue } from "./formControls";
import { escapeHtml, ICON, img } from "./html";
import { addLog } from "./logs";
import { signedDiff } from "./queues";
import {
  DEFAULT_SECONDARY_SPELL_ID,
  EXTRA_SECONDARY_SPELL_IDS,
  FLASH_SPELL_ID,
  isSupportedSecondarySpell,
  MAIN_SECONDARY_SPELL_IDS,
  resolveSpellPair,
  spellIconHtml,
  spellName,
} from "./spells";
import { state } from "./state";
import { calculateScores, UNRANKED_BASELINE_SCORE } from "./tiers";
import type { ChampSelectUiState, TierChampion } from "./types";

/** Hooks that stay in main.ts and are handed over once by `initOverview`. */
export interface OverviewDeps {
  primarySpellKeyFromUI: () => string;
  renderDefaultSpellPicker: () => void;
  renderSpellOverrideCount: () => void;
  saveConfigImmediate: () => Promise<boolean>;
}
let deps: OverviewDeps;

/* ---------- Overview: champ select cards, bench, trade and assist banners ---------- */

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
export let lastChampSelectData: any = null;
export let overviewMyChampId = 0;
let ovSpellTrayOpen = false;

/** Adopt backend champ select verdicts; main.ts hands them over on `lcu-champ-select-state`. */
export function setChampUiState(next: Partial<ChampSelectUiState>) {
  champUiState = { ...EMPTY_UI_STATE, ...next };
}

/** Fold one `lcu-assist` suggestion into the assist state. */
export function applyAssistPayload(payload: AssistPayload) {
  assistState = applyAssist(assistState, payload);
}

function isAlliedMember(member: any): boolean {
  if (!member) return false;
  const puuid = typeof member.puuid === "string" ? member.puuid : "";
  if (puuid && champUiState.allied_puuids.includes(puuid)) return true;
  const summonerId = Number(member.summonerId) || 0;
  return summonerId > 0 && champUiState.allied_summoner_ids.includes(summonerId);
}

export function effectiveSecondarySpell(myChamp: TierChampion | undefined): number {
  const remembered = checkboxValue("cfgRememberSpells", true) ? myChamp?.secSpell : undefined;
  if (isSupportedSecondarySpell(remembered)) return remembered;
  const fallback = state.currentSettings.default_secondary_spell;
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
        ${
          myChampId > 0
            ? `<div class="nm">${escapeHtml(name)}</div>
        <div class="meta">${myChamp ? `${escapeHtml(myChamp.t || "未分類")} ${myScore ?? "—"} 分` : ""}</div>`
            : `<div class="nm idle">尚未選角</div>`
        }
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
  const primaryKey = deps.primarySpellKeyFromUI();
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
      ? ""
      : suggestedId != null
        ? `建議換上 ${escapeHtml(suggestedName)}${suggestedReason ? `・${escapeHtml(suggestedReason)}` : ""}`
        : `沒有建議換的英雄（${benchDiff} 分）`;

  el.innerHTML = `
    <h3>板凳<span class="sub">依權重排序</span></h3>
    <div class="bench-list">${rows || `<div class="ov-empty">${overviewMyChampId > 0 ? "板凳上還沒有英雄" : "進選角後顯示板凳英雄"}</div>`}</div>
    ${caption ? `<div class="bench-cap">${caption}</div>` : ""}`;
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
      const name = state.profileList.find((c) => c.id === card.champId)?.n || `ID:${card.champId}`;
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

export function renderOverviewColumns() {
  const data = lastChampSelectData;
  const profile = state.profileList;
  const scores = calculateScores(profile);
  const settings = state.currentSettings;
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

/** Remember the secondary spell for the held champion and push it to LCU right away. */
async function pickSecondarySpell(pickedId: number) {
  if (!isSupportedSecondarySpell(pickedId)) return;
  const myChampId = overviewMyChampId;
  const champ = myChampId > 0 ? state.profileList.find((c) => c.id === myChampId) : undefined;
  const modeDefault = state.currentSettings.default_secondary_spell;
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
    state.currentSettings.default_secondary_spell = pickedId;
    secId = pickedId;
    deps.renderDefaultSpellPicker();
  }

  ovSpellTrayOpen = false;
  // Persist to Rust BEFORE calling apply_summoner_spells so the ensuing LCU WebSocket
  // event never reads a stale config and reverts our newly chosen spell!
  await deps.saveConfigImmediate();

  if (state.isLcuConnected && state.lastKnownPhase === "ChampSelect") {
    const [spell1Id, spell2Id] = resolveSpellPair(secId, deps.primarySpellKeyFromUI());
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
  deps.renderSpellOverrideCount();
}

export function resetOverviewMiniCards() {
  lastChampSelectData = null;
  champUiState = { ...EMPTY_UI_STATE };
  assistState = emptyAssist();
  renderOverviewColumns();
}

export function handleChampSelectLiveUI(data: any) {
  if (!data) return;
  lastChampSelectData = data;
  renderOverviewColumns();
}

/** Bind the overview click handlers once; main.ts calls this where the section used to start. */
export function initOverview(d: OverviewDeps) {
  deps = d;

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
    const name = state.profileList.find((c) => c.id === championId)?.n || `ID:${championId}`;
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
}
