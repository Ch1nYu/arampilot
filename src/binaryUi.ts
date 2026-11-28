// Third classification method: binary-divide ordering of one tier. Drives src/binarySort.ts and writes every
// answer straight into the real ranking, so there is no draft or apply step (unlike the PK tab).

import {
  applyTierOrder,
  chooseBinary,
  createBinarySession,
  isDone,
  orderedIds,
  pivotIndex,
  resumeSortedCount,
  stepsLeft,
  type BinaryAction,
  type BinarySession,
} from "./binarySort";
import { escapeHtml, img } from "./html";
import { state } from "./state";
import type { TierChampion } from "./types";

/** Hooks that stay in battle.ts and are handed over once by `initBinaryUi`. */
export interface BinaryDeps {
  renderTiers: () => void;
  debouncedSaveConfig: () => void;
}
let deps: BinaryDeps;

/** Tiers this method offers; 封印 and 未分類 are never sorted here. */
type BinaryTier = "本命" | "愛角" | "順手" | "勉強";

const PROGRESS_KEY = "arampilot.binarySort.v1";

let currentTier: BinaryTier = "本命";
/** One session per tier, kept while that tier still shows the order the session last produced. */
let sessions: Partial<Record<BinaryTier, BinarySession>> = {};
/** Sessions to go back to, one stack per tier. */
let undoStacks: Partial<Record<BinaryTier, BinarySession[]>> = {};

/** Members of `tier` in list order: what the tier shows right now. */
function tierIds(tier: BinaryTier): number[] {
  return state.profileList.filter((c) => c.t === tier).map((c) => c.id);
}

function sameOrder(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Stored progress, keyed by tier; garbage (or disabled storage) reads as empty. */
function readStoredProgress(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Remember the tier's order and lock count so a reload resumes where it stopped. */
function storeProgress(tier: BinaryTier, session: BinarySession) {
  try {
    const all = readStoredProgress();
    all[tier] = { ids: orderedIds(session), sortedCount: session.sorted.length };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    // Storage disabled or full: progress simply lives in memory for this run.
  }
}

function pushUndo(tier: BinaryTier, session: BinarySession) {
  const stack = undoStacks[tier] ?? (undoStacks[tier] = []);
  stack.push(session);
}

/**
 * Called whenever the binary stage becomes visible: keep the tier's session while it still matches the
 * tier's order, otherwise start (or resume) one from the stored progress.
 */
export function syncBinaryPool() {
  const ids = tierIds(currentTier);
  const session = sessions[currentTier];
  if (!session || !sameOrder(orderedIds(session), ids)) {
    sessions[currentTier] = createBinarySession(
      currentTier,
      ids,
      resumeSortedCount(readStoredProgress()[currentTier], ids)
    );
    undoStacks[currentTier] = [];
  }
  renderBinary();
}

/** Answer the current comparison: lock one champion, reorder the tier and save right away. */
export function binaryAct(action: BinaryAction) {
  const old = sessions[currentTier];
  if (!old) {
    // A ranking-save switch dropped the sessions: rebuild this tier instead of leaving dead cards.
    syncBinaryPool();
    return;
  }
  if (!sameOrder(orderedIds(old), tierIds(currentTier))) {
    // The tier was reordered elsewhere (priority tab, mastery import): rebuild instead of overwriting it.
    syncBinaryPool();
    return;
  }
  if (isDone(old)) return;
  pushUndo(currentTier, old);
  const next = chooseBinary(old, action);
  sessions[currentTier] = next;
  applyTierOrder(state.profileList, currentTier, orderedIds(next));
  deps.renderTiers();
  deps.debouncedSaveConfig();
  storeProgress(currentTier, next);
  renderBinary();
}

/** Put the tier back to the order it had before the last answer. */
export function undoBinary() {
  const current = sessions[currentTier];
  if (!current || !sameOrder(orderedIds(current), tierIds(current.tier as BinaryTier))) {
    syncBinaryPool();
    return;
  }
  const prev = undoStacks[currentTier]?.pop();
  if (!prev) return;
  sessions[currentTier] = prev;
  applyTierOrder(state.profileList, currentTier, orderedIds(prev));
  deps.renderTiers();
  deps.debouncedSaveConfig();
  storeProgress(currentTier, prev);
  renderBinary();
}

/** Start this tier over from its current order; the list itself is not touched until the next answer. */
function restartBinary() {
  const session = createBinarySession(currentTier, tierIds(currentTier), 1);
  sessions[currentTier] = session;
  undoStacks[currentTier] = [];
  storeProgress(currentTier, session);
  renderBinary();
}

function fighterHtml(c: TierChampion, meta: string, hint: string): string {
  return `
    ${img(c.id, c.n)}
    <div class="nm">${escapeHtml(c.n)}</div>
    <div class="meta">${escapeHtml(meta)}</div>
    <span class="key">${escapeHtml(hint)}</span>`;
}

function setDisabled(id: string, disabled: boolean) {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  if (el) el.disabled = disabled;
}

function renderBinary() {
  document.querySelectorAll("#binaryTierSeg button").forEach((b) =>
    b.classList.toggle("on", (b as HTMLElement).dataset.tier === currentTier)
  );

  const champions = state.profileList.filter((c) => c.t === currentTier);
  const total = champions.length;
  const session = sessions[currentTier];
  const active = session && !isDone(session) ? session : null;

  const pText = document.getElementById("binaryProgressText");
  if (pText) {
    pText.textContent = active
      ? `已鎖定 ${active.sorted.length} / ${total} 隻 · 本層已點 ${active.clicks} 下 · 最多再 ${stepsLeft(active)} 下鎖定這隻`
      : `【${currentTier}】${total} 隻已全部排好`;
  }
  const pBar = document.getElementById("binaryProgressBar");
  if (pBar) {
    const locked = session ? session.sorted.length : 0;
    const pct = total > 0 ? Math.min(100, Math.round((locked / total) * 100)) : 0;
    pBar.style.width = `${pct}%`;
  }

  const elL = document.getElementById("binL");
  const elR = document.getElementById("binR");
  if (elL && elR) {
    let pairRendered = false;
    if (total < 2) {
      elL.innerHTML = `
      <div class="nm">此階層英雄不足 2 隻</div>
      <div class="meta">請先用「閃卡五分類」把英雄放進這個階層，或切換上方範圍。</div>`;
      elR.innerHTML = `<div class="nm">—</div>`;
    } else if (!active) {
      elL.innerHTML = `
      <div class="nm">【${currentTier}】排序完成</div>
      <div class="meta">可以按「重排本層」從頭再排一次，或到「優先序」頁拖曳微調。</div>`;
      elR.innerHTML = `<div class="nm">—</div>`;
    } else {
      const mid = pivotIndex(active);
      const pivotId = active.sorted[mid];
      const challenger = state.profileList.find((c) => c.id === active.current);
      const pivot = state.profileList.find((c) => c.id === pivotId);
      pairRendered = Boolean(challenger && pivot);
      elL.innerHTML =
        challenger && pivot
          ? fighterHtml(challenger, `待定位 · 剩 ${active.queue.length + 1} 隻`, `← 比較想玩：排到【${pivot.n}】前面`)
          : `<div class="nm">—</div>`;
      elR.innerHTML =
        challenger && pivot
          ? fighterHtml(pivot, `第 ${mid + 1} 名（守門員）`, `→ 比較想玩：【${challenger.n}】排到後面`)
          : `<div class="nm">—</div>`;
    }
    elL.classList.toggle("is-empty", !pairRendered);
    elR.classList.toggle("is-empty", !pairRendered);
  }

  setDisabled("binUndo", (undoStacks[currentTier]?.length ?? 0) === 0);
  for (const id of ["binTie", "binTop", "binBottom"]) setDisabled(id, !active);
  setDisabled("binRestart", total < 2);
}

/** Register the binary-tab listeners; battle.ts hands over the same deps it got. */
export function initBinaryUi(d: BinaryDeps) {
  deps = d;

  document.getElementById("binaryTierSeg")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    const tier = b?.dataset.tier as BinaryTier | undefined;
    if (!tier || tier === currentTier) return;
    currentTier = tier;
    syncBinaryPool();
  });

  const onClick = (id: string, fn: () => void) =>
    document.getElementById(id)?.addEventListener("click", fn);
  // The left card is the challenger, the right card the gatekeeper: clicking a card is that answer.
  onClick("binL", () => binaryAct("challenger"));
  onClick("binR", () => binaryAct("pivot"));
  onClick("binUndo", undoBinary);
  onClick("binTie", () => binaryAct("tie"));
  onClick("binTop", () => binaryAct("top"));
  onClick("binBottom", () => binaryAct("bottom"));
  onClick("binRestart", restartBinary);
}

/** Drop the sessions and undo stacks (not the stored progress): the ranking they described is gone. */
export function resetBinaryState() {
  sessions = {};
  undoStacks = {};
}
