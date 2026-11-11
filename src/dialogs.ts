import { escapeHtml } from "./html";

/** In-app yes/no dialog (native confirm() is not dependable inside WebView2). */
export function confirmDialog(title: string, body: string, okLabel = "確定"): Promise<boolean> {
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
export function choiceDialog(
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

/**
 * In-app text prompt on the confirm-dialog overlay (native prompt() is not
 * dependable inside WebView2). Resolves the trimmed value, or null on cancel.
 */
export function promptDialog(title: string, body: string, initial: string, okLabel = "確定"): Promise<string | null> {
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
