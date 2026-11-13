// Generic form controls: segmented buttons, switches, sliders and their gates.
// Everything here touches the DOM, so the listeners are registered by
// initFormControls() from main.ts at the original startup point.

/* ---------- Generic Controls ---------- */
const rangeUpdaters = new Map<string, () => void>();
const gateUpdaters = new Map<string, () => void>();

// Sliders may use fractional steps (0.1); trim float noise and trailing zeros.
export function formatRangeLabel(input: HTMLInputElement): string {
  const raw = Number(input.value);
  const shown = Number.isFinite(raw) ? String(Math.round(raw * 10) / 10) : input.value;
  if (input.dataset.zero && Number(shown) === 0) return input.dataset.zero;
  return (input.dataset.prefix || "") + shown + (input.dataset.suffix || "");
}

/**
 * Wires the segmented buttons, switches, sliders and gates; called from
 * main.ts at the original startup point.
 *
 * `onChange` is debounced by the caller while a slider is being dragged;
 * `onCommit` runs when the slider is released so the final value is written
 * immediately instead of waiting out the debounce.
 */
export function initFormControls(onChange: () => void, onCommit: () => void = onChange) {
  document.querySelectorAll("[data-seg]").forEach((seg) =>
    seg.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      seg.dispatchEvent(new Event("change"));
      onChange();
    })
  );
  document.querySelectorAll("[data-chk]").forEach((c) =>
    c.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b) {
        b.classList.toggle("on");
        onChange();
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
      onChange();
    });
    input.addEventListener("change", () => {
      upd();
      onCommit();
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
          onChange();
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
      onChange();
    });
    upd();
    if (input.id) gateUpdaters.set(input.id, upd);
  });
}

export function setCheckbox(id: string, on: boolean) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.checked = on;
  gateUpdaters.get(id)?.();
}

export function setRangeValue(id: string, value: number) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.value = String(value);
  rangeUpdaters.get(id)?.();
}

export function setTextInput(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (input) input.value = value;
}

export function setSegValue(id: string, value: string) {
  document.querySelectorAll<HTMLElement>(`#${id} button`).forEach((b) => {
    b.classList.toggle("on", (b.dataset.v || "") === value);
  });
}

export function activeSegValue(id: string): string {
  const el = document.querySelector(`#${id} .on`) as HTMLElement | null;
  return el?.dataset.v || "";
}

export function setChkValues(id: string, values: string[]) {
  document.querySelectorAll<HTMLElement>(`#${id} button`).forEach((b) => {
    b.classList.toggle("on", values.includes(b.dataset.v || ""));
  });
}

export function activeChkValues(id: string): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`#${id} button.on`)).map((b) => b.dataset.v || "");
}

export function checkboxValue(id: string, fallback: boolean): boolean {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return el ? el.checked : fallback;
}

export function numberValue(id: string, fallback: number): number {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const v = el ? Number(el.value) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

export function textValue(id: string, fallback: string): string {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const v = el?.value.trim() || "";
  return v || fallback;
}
