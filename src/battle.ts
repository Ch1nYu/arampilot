import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs";
import { escapeHtml, img } from "./html";
import { state } from "./state";
import { createPairMemory, pickPair } from "./pkPairing";
import { TIER_ORDER } from "./tiers";
import type { SaveResult } from "./saveResult";
import type { TierChampion } from "./types";
import { backupStamp } from "./backup";

/** Hooks that stay in main.ts and are handed over once by `initBattle`. */
export interface BattleDeps {
  renderTiers: () => void;
  saveConfigReport: () => Promise<SaveResult>;
  debouncedSaveConfig: () => void;
}
let deps: BattleDeps;

/* ---------- Two-Stage Classifier & Pairwise PK Engine ---------- */
type BattleStage = "flash" | "pk";
let currentBattleStage: BattleStage = "flash";
let flashScope: "unranked" | "all" = "unranked";
let pkTargetScope = "本命";

const flashSkippedIds = new Set<number>();
const flashSeenAllIds = new Set<number>();

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

/** Drop the flash pools and undo history; the pools belong to the previous ranking. */
export function resetFlashState() {
  flashSkippedIds.clear();
  flashSeenAllIds.clear();
  flashUndoHistory = [];
}

function setBattleStage(stage: BattleStage) {
  currentBattleStage = stage;
  const flashWrap = document.getElementById("btFlashWrap");
  const pkWrap = document.getElementById("btPkWrap");
  if (flashWrap) flashWrap.style.display = stage === "flash" ? "" : "none";
  if (pkWrap) pkWrap.style.display = stage === "pk" ? "" : "none";
  if (stage === "flash") syncFlashPool();
  else syncBattlePool();
}

export function syncFlashPool() {
  const list = state.profileList;
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
  const list = state.profileList;
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

  deps.renderTiers();
  deps.debouncedSaveConfig();
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
  const list = state.profileList;
  const curIdx = list.findIndex((c) => c.id === last.id);
  if (curIdx < 0) return;

  const [champ] = list.splice(curIdx, 1);
  champ.t = last.prevTier;
  const restoreIdx = Math.max(0, Math.min(last.origIdx, list.length));
  list.splice(restoreIdx, 0, champ);

  flashSeenAllIds.delete(last.id);
  flashSkippedIds.delete(last.id);
  deps.renderTiers();
  deps.debouncedSaveConfig();
  currentFlashChampion = champ;
  const unrankedCount = list.filter((c) => c.t === "未分類").length;
  renderFlashCard(
    list.length,
    list.length - unrankedCount,
    unrankedCount,
    flashSeenAllIds.size
  );
}

/* ---------- Stage 2: Intra-Tier Pairwise PK ---------- */

/** Committed weights: only an applied draft may change these. */
export const eloMap: Record<number, number> = {};
export const pkComparisonsMap: Record<number, number> = {};

/**
 * Draft weights for this session (champions voted on only). Votes never touch
 * `eloMap` / `pkComparisonsMap` or the saved file; they are merged in on 套用.
 */
let draftElo: Record<number, number> = {};
let draftComp: Record<number, number> = {};
export let draftVotes = 0;
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
export function resetDraft(clearStorage = true) {
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

function resolvePkPool(list: TierChampion[], scope: string = pkTargetScope): TierChampion[] {
  if (scope === "top2") return list.filter((c) => c.t === "本命" || c.t === "愛角");
  if (scope === "all") return list.filter((c) => c.t !== "封印");
  return list.filter((c) => c.t === scope);
}

export function syncBattlePool() {
  const list = state.profileList;
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
  state.profileList = reorderListByScope(state.profileList, committedEloOf, pkTargetScope);
}

interface ApplyPreview {
  moved: { name: string; from: number; to: number }[];
  tierChanges: { name: string; from: string; to: string }[];
}

/** What applying the draft would change, computed on a copy (nothing is mutated). */
function computeApplyPreview(): ApplyPreview {
  const next = reorderListByScope(state.profileList, pkEloOf, pkTargetScope);
  const before = new Map(state.profileList.map((c, i) => [c.id, { pos: i + 1, tier: c.t }]));
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
    profile: state.profileList.map((c) => ({ ...c })),
    elo: { ...eloMap },
    comp: { ...pkComparisonsMap },
    signature: "",
  };
  const draft = { elo: { ...draftElo }, comp: { ...draftComp }, votes: draftVotes, undo: [...pkUndoHistory] };
  for (const [key, value] of Object.entries(draftElo)) eloMap[Number(key)] = value;
  for (const [key, value] of Object.entries(draftComp)) pkComparisonsMap[Number(key)] = value;

  resetDraft(false);
  syncOrderFromElo();
  const saved = await deps.saveConfigReport();
  /** Put the pre-apply order back and the votes back into a single draft. */
  const restoreDraft = () => {
    state.profileList = snapshot.profile.map((c) => ({ ...c }));
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
    deps.renderTiers();
    addLog("err", "二選一只套用到本次執行", "設定檔暫時無法寫入；之後任何一次存檔成功就會一起寫入，重新啟動前都沒成功的話這幾票會遺失");
    activateHeroTab("priority");
    return;
  }
  if (saved === "refused") {
    // Nothing reaches the file this run: keep the votes as the one live draft
    // (not merged), so they can be applied once after a restart.
    restoreDraft();
    // The backend took the merged order into memory: hand it the restored one.
    await deps.saveConfigReport();
    deps.renderTiers();
    renderBattle();
    addLog("err", "二選一未套用", "設定檔讀取失敗保護中，這次執行無法存檔；優先序未變動，草稿已保留，重新啟動 App 後再套用");
    return;
  }
  clearStoredPkDraft();
  snapshot.signature = profileSignature();
  preApplySnapshot = snapshot;
  deps.renderTiers();
  addLog("act", "二選一已套用", `${scope} · ${votes} 票 · ${preview.moved.length} 隻名次變動 · 已備份`);
  activateHeroTab("priority");
}

/** Order + tier + flag + spell of every champion: detects edits made after an apply. */
function profileSignature(): string {
  return state.profileList.map((c) => `${c.id}:${c.t}:${c.f}:${c.secSpell ?? ""}`).join("|");
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
  state.profileList = snapshot.profile.map((c) => ({ ...c }));
  replaceWeights(eloMap, snapshot.elo);
  replaceWeights(pkComparisonsMap, snapshot.comp);
  const saved = await deps.saveConfigReport();
  // "memory-only" and "refused" also land here: the backend already runs on
  // the restored order, so the screen must show it too.
  preApplySnapshot = null;
  deps.renderTiers();
  syncBattlePool();
  updateBattleButtons();
  if (saved !== "saved") {
    addLog("err", "復原只套用到本次執行", "設定檔沒有寫入；之後的存檔若都沒成功，重新啟動後會回到最後一次成功存檔時的排名");
    return;
  }
  addLog("act", "已復原上次套用", "二選一順位、階層與權重已還原為套用前狀態");
}

export function replaceWeights(target: Record<number, number>, source: Record<number, number>) {
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

/**
 * Register the battle / flash listeners. main.ts calls this where the section
 * used to sit, so the order of the registrations stays the same.
 */
export function initBattle(d: BattleDeps) {
  deps = d;

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
}
