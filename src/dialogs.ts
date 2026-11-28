import { escapeHtml } from "./html";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

interface FocusableTarget {
  focus: () => void;
  isConnected?: boolean;
}

function capturePreviousFocus(): FocusableTarget | null {
  const active = document.activeElement as unknown as FocusableTarget | null;
  return active && typeof active.focus === "function" ? active : null;
}

function restorePreviousFocus(prev: FocusableTarget | null) {
  if (!prev || prev.isConnected === false) return;
  prev.focus();
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hidden && el.getAttribute("aria-hidden") !== "true"
  );
}

function trapTabKey(e: KeyboardEvent, box: HTMLElement | null) {
  if (!box) return;
  const focusables = getFocusableElements(box);
  e.preventDefault();
  if (focusables.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const idx = active ? focusables.indexOf(active) : -1;
  const nextIdx = e.shiftKey
    ? idx <= 0
      ? focusables.length - 1
      : idx - 1
    : idx === -1 || idx >= focusables.length - 1
      ? 0
      : idx + 1;
  focusables[nextIdx]?.focus();
}

/** Prefer the first safe (non-primary) action so Enter / Space never triggers a destructive or restart action by accident. */
function pickDefaultChoiceFocus(box: HTMLElement | null): HTMLButtonElement | null {
  if (!box) return null;
  const buttons = Array.from(box.querySelectorAll<HTMLButtonElement>("button[data-answer]:not([disabled])"));
  return buttons.find((btn) => !btn.classList.contains("primary")) ?? buttons[0] ?? null;
}

/** In-app yes/no dialog (native confirm() is not dependable inside WebView2). */
export function confirmDialog(title: string, body: string, okLabel = "確定"): Promise<boolean> {
  return new Promise((resolve) => {
    const prevFocus = capturePreviousFocus();
    let settled = false;
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
    const box = overlay.querySelector<HTMLElement>(".confirm-box");
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      restorePreviousFocus(prevFocus);
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      // Captured at document level so page shortcuts (1–5, arrows) never fire
      // underneath the dialog; Enter / Space still activate the focused button.
      e.stopPropagation();
      if (e.key === "Tab") {
        trapTabKey(e, box);
      } else if (e.key === "Escape") {
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
    overlay.querySelector<HTMLButtonElement>('[data-answer="no"]')?.focus();
  });
}

/**
 * In-app multi-choice dialog on the same overlay as `confirmDialog` (切換存檔
 * needs 取消 / 不儲存 / 儲存). Resolves the chosen value, null on cancel.
 */
export function choiceDialog(
  title: string,
  body: string,
  choices: { label: string; value: string; primary?: boolean }[]
): Promise<string | null> {
  return new Promise((resolve) => {
    const prevFocus = capturePreviousFocus();
    let settled = false;
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
    const box = overlay.querySelector<HTMLElement>(".confirm-box");
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      restorePreviousFocus(prevFocus);
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      // Captured at document level so page shortcuts (1–5, arrows) never fire
      // underneath the dialog; Enter / Space still activate the focused button.
      e.stopPropagation();
      if (e.key === "Tab") {
        trapTabKey(e, box);
      } else if (e.key === "Escape") {
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
    pickDefaultChoiceFocus(box)?.focus();
  });
}

/**
 * In-app text prompt on the confirm-dialog overlay (native prompt() is not
 * dependable inside WebView2). Resolves the trimmed value, or null on cancel.
 */
export function promptDialog(title: string, body: string, initial: string, okLabel = "確定"): Promise<string | null> {
  return new Promise((resolve) => {
    const prevFocus = capturePreviousFocus();
    let settled = false;
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="card confirm-box" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <div class="card-desc">${escapeHtml(body)}</div>
        <input class="input" maxlength="40" value="${escapeHtml(initial)}">
        <div class="confirm-error" role="alert" hidden>請輸入內容，不可為空白</div>
        <div class="confirm-actions">
          <button class="btn" data-answer="no">取消</button>
          <button class="btn primary" data-answer="yes">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    const box = overlay.querySelector<HTMLElement>(".confirm-box");
    const input = overlay.querySelector<HTMLInputElement>("input");
    const errorEl = overlay.querySelector<HTMLElement>(".confirm-error");
    const cancelBtn = overlay.querySelector<HTMLButtonElement>('[data-answer="no"]');
    const okBtn = overlay.querySelector<HTMLButtonElement>('[data-answer="yes"]');
    const syncValidation = (showErrorWhenEmpty: boolean): boolean => {
      const valid = (input?.value ?? "").trim().length > 0;
      if (okBtn) okBtn.disabled = !valid;
      const showError = !valid && showErrorWhenEmpty;
      if (errorEl) errorEl.hidden = !showError;
      if (input) {
        input.classList.toggle("invalid", showError);
        input.setAttribute("aria-invalid", String(showError));
      }
      return valid;
    };
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      restorePreviousFocus(prevFocus);
      resolve(answer);
    };
    const commit = () => {
      if (!syncValidation(true)) {
        input?.focus();
        return;
      }
      finish((input?.value ?? "").trim());
    };
    const onKey = (e: KeyboardEvent) => {
      // Captured at document level so page shortcuts never fire underneath,
      // while typing in the input still works.
      e.stopPropagation();
      if (e.key === "Tab") {
        trapTabKey(e, box);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      } else if (e.key === "Enter" && !e.isComposing) {
        if (document.activeElement === cancelBtn) return;
        // isComposing: Enter that confirms an IME candidate (Chinese input) is not a submit.
        e.preventDefault();
        commit();
      }
    };
    input?.addEventListener("input", () => {
      syncValidation(true);
    });
    overlay.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-answer]") as HTMLElement | null;
      if (!btn) {
        if (e.target === overlay) finish(null);
      } else if (btn.dataset.answer === "yes") commit();
      else finish(null);
    });
    syncValidation(false);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    input?.focus();
    input?.select();
  });
}
