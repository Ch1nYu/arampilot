import { invoke } from "@tauri-apps/api/core";
import { backupBeforeBulkEdit } from "./backup";
import {
  draftVotes,
  eloMap,
  pkComparisonsMap,
  resetDraft,
  resetFlashState,
  syncBattlePool,
  syncFlashPool,
} from "./battle";
import { confirmDialog } from "./dialogs";
import { activeSegValue, numberValue } from "./formControls";
import { escapeHtml, img } from "./html";
import { addLog } from "./logs";
import { state } from "./state";
import { calculateScores, FLAG_ICON, FLAG_NAME, FLAGS, TIERS, UNRANKED_BASELINE_SCORE } from "./tiers";
import type { ChampionMasteryItem, TierChampion } from "./types";

/** Hooks that stay in main.ts and are handed over by the two init calls. */
export interface HeroPageDeps {
  debouncedSaveConfig: () => void;
}
let deps: HeroPageDeps;

/* ---------- Champions & Tiers Data ---------- */

export function renderTiers() {
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

function applySearch() {
  const q = (document.getElementById("search") as HTMLInputElement)?.value.trim() || "";
  document
    .getElementById("tiers")
    ?.querySelectorAll(".chip")
    .forEach((c) => c.classList.toggle("hide", Boolean(q && !c.textContent?.includes(q))));
}

/** Register the tier board listeners; called where the section used to run. */
export function initTierBoard(d: HeroPageDeps) {
  deps = d;
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
    deps.debouncedSaveConfig();
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
    deps.debouncedSaveConfig();
  });
  tiersContainer?.addEventListener("click", (e) => {
    const flagBtn = (e.target as HTMLElement).closest("[data-flag]");
    if (!flagBtn) return;
    const chip = flagBtn.closest(".chip") as HTMLElement;
    const champion = state.profileList.find((x) => x.id === +chip.dataset.id!);
    if (!champion) return;
    champion.f = FLAGS[(FLAGS.indexOf(champion.f) + 1) % FLAGS.length];
    renderTiers();
    deps.debouncedSaveConfig();
  });
  document.getElementById("search")?.addEventListener("input", applySearch);
}

/* ---------- Trade Simulator ---------- */

let simMine: HTMLSelectElement | null = null;
let simOffer: HTMLSelectElement | null = null;
let simIsFriend: HTMLSelectElement | null = null;

export function fillTradeOptions() {
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

export function renderTradeSim() {
  const mine = simMine;
  const offer = simOffer;
  if (!mine?.value || !offer?.value) return;
  const list = state.profileList;
  const sc = calculateScores(list);
  const myChamp = list.find((c) => c.id === +mine.value);
  const offerChamp = list.find((c) => c.id === +offer.value);
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

/** Register the trade-simulator listeners; called where the section used to run. */
export function initTradeSim() {
  simMine = document.getElementById("simMine") as HTMLSelectElement | null;
  simOffer = document.getElementById("simOffer") as HTMLSelectElement | null;
  simIsFriend = document.getElementById("simIsFriend") as HTMLSelectElement | null;
  simMine?.addEventListener("change", renderTradeSim);
  simOffer?.addEventListener("change", renderTradeSim);
  simIsFriend?.addEventListener("change", renderTradeSim);
  document.getElementById("thAccept")?.addEventListener("input", renderTradeSim);
  document.getElementById("thAccept")?.addEventListener("change", renderTradeSim);
  document.getElementById("rejTier")?.addEventListener("change", renderTradeSim);
  document.getElementById("friendTradePolicy")?.addEventListener("change", renderTradeSim);
}

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
    deps.debouncedSaveConfig();
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

/** Register the priority toolbar listeners; called where the section used to run. */
export function initPriorityToolbar(d: HeroPageDeps) {
  deps = d;
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
    deps.debouncedSaveConfig();
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
    deps.debouncedSaveConfig();
    addLog("act", "未分類英雄已重新排序", `已依名稱排列 ${unranked.length} 位未分類英雄`);
  });
}
