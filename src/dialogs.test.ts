import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.3.3") }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));

import { choiceDialog, confirmDialog, promptDialog } from "./dialogs";
import { UPDATE_DIALOG_CHOICES } from "./updaterUi";

type Listener = (e: any) => void;

class FakeClassList {
  private set = new Set<string>();
  constructor(initial = "") {
    for (const c of initial.split(/\s+/).filter(Boolean)) this.set.add(c);
  }
  contains(name: string) {
    return this.set.has(name);
  }
  add(name: string) {
    this.set.add(name);
  }
  remove(name: string) {
    this.set.delete(name);
  }
  toggle(name: string, force?: boolean) {
    if (force === undefined) {
      if (this.set.has(name)) this.set.delete(name);
      else this.set.add(name);
    } else if (force) {
      this.set.add(name);
    } else {
      this.set.delete(name);
    }
  }
}

class FakeElement {
  tagName: string;
  className = "";
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  isConnected = true;
  selected = false;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private listeners = new Map<string, Listener[]>();
  private doc: FakeDocument;

  constructor(tag: string, doc: FakeDocument) {
    this.tagName = tag.toUpperCase();
    this.doc = doc;
  }

  set innerHTML(html: string) {
    this.children = [];
    // Parse the dialog elements used by src/dialogs.ts.
    const box = new FakeElement("div", this.doc);
    box.className = "card confirm-box";
    box.classList = new FakeClassList(box.className);
    box.parent = this;
    this.children.push(box);

    const inputMatch = html.match(/<input[^>]*value="([^"]*)"[^>]*>/);
    if (inputMatch) {
      const inp = new FakeElement("input", this.doc);
      inp.className = "input";
      inp.classList = new FakeClassList("input");
      inp.value = inputMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      inp.parent = box;
      box.children.push(inp);
    }

    if (html.includes('class="confirm-error"')) {
      const err = new FakeElement("div", this.doc);
      err.className = "confirm-error";
      err.classList = new FakeClassList("confirm-error");
      err.hidden = html.includes("confirm-error\" role=\"alert\" hidden");
      err.textContent = "請輸入內容，不可為空白";
      err.parent = box;
      box.children.push(err);
    }

    const btnRe = /<button class="([^"]*)" data-answer="([^"]*)">([^<]*)<\/button>/g;
    let m: RegExpExecArray | null;
    while ((m = btnRe.exec(html)) !== null) {
      const btn = new FakeElement("button", this.doc);
      btn.className = m[1];
      btn.classList = new FakeClassList(m[1]);
      btn.dataset.answer = m[2];
      btn.textContent = m[3];
      btn.parent = box;
      box.children.push(btn);
    }
  }

  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, val: string) {
    this.attrs[name] = val;
  }

  focus() {
    this.doc.activeElement = this;
  }

  select() {
    this.selected = true;
  }

  remove() {
    this.isConnected = false;
    this.doc.body.children = this.doc.body.children.filter((c) => c !== this);
  }

  addEventListener(type: string, fn: Listener) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  dispatch(type: string, event: any) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  closest(selector: string): FakeElement | null {
    if (selector === "[data-answer]") {
      let cur: FakeElement | null = this;
      while (cur) {
        if ("answer" in cur.dataset) return cur;
        cur = cur.parent;
      }
    }
    return null;
  }

  private descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const all = this.descendants();
    if (selector.includes("button:not([disabled])") && selector.includes("input:not([disabled])")) {
      return all.filter((el) => (el.tagName === "BUTTON" || el.tagName === "INPUT") && !el.disabled);
    }
    if (selector === "button[data-answer]:not([disabled])") {
      return all.filter((el) => el.tagName === "BUTTON" && "answer" in el.dataset && !el.disabled);
    }
    if (selector === ".confirm-box") return all.filter((el) => el.classList.contains("confirm-box"));
    if (selector === ".confirm-error") return all.filter((el) => el.classList.contains("confirm-error"));
    if (selector === "input") return all.filter((el) => el.tagName === "INPUT");
    const ansMatch = selector.match(/^\[data-answer="([^"]+)"\]$/);
    if (ansMatch) return all.filter((el) => el.dataset.answer === ansMatch[1]);
    return [];
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  body: { children: FakeElement[]; appendChild: (el: FakeElement) => void };
  private keyListeners: Listener[] = [];

  constructor() {
    this.body = {
      children: [],
      appendChild: (el: FakeElement) => {
        el.isConnected = true;
        this.body.children.push(el);
      },
    };
  }

  createElement(tag: string) {
    return new FakeElement(tag, this);
  }

  addEventListener(type: string, fn: Listener) {
    if (type === "keydown") this.keyListeners.push(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    if (type === "keydown") this.keyListeners = this.keyListeners.filter((l) => l !== fn);
  }

  pressKey(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}) {
    let prevented = false;
    let stopped = false;
    const event = {
      key,
      shiftKey: Boolean(opts.shiftKey),
      isComposing: Boolean(opts.isComposing),
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    };
    for (const fn of [...this.keyListeners]) fn(event);
    return { prevented, stopped };
  }
}

let doc: FakeDocument;
const originalDocument = (globalThis as { document?: unknown }).document;

beforeEach(() => {
  doc = new FakeDocument();
  (globalThis as { document?: unknown }).document = doc;
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = originalDocument;
});

describe("update dialog choices order (#15)", () => {
  it("places safe option on the left and primary install option on the right", () => {
    expect(UPDATE_DIALOG_CHOICES).toEqual([
      { label: "稍後", value: "later" },
      { label: "立即更新", value: "install", primary: true },
    ]);
  });
});

describe("confirmDialog (#15)", () => {
  it("focuses cancel by default, traps Tab/Shift+Tab, and restores previous focus on close", async () => {
    const trigger = doc.createElement("button");
    trigger.focus();

    const promise = confirmDialog("確認", "內容", "執行");
    const overlay = doc.body.children[0];
    const cancelBtn = overlay.querySelector('[data-answer="no"]')!;
    const okBtn = overlay.querySelector('[data-answer="yes"]')!;

    expect(doc.activeElement).toBe(cancelBtn);

    const tab1 = doc.pressKey("Tab");
    expect(tab1.prevented).toBe(true);
    expect(doc.activeElement).toBe(okBtn);

    doc.pressKey("Tab");
    expect(doc.activeElement).toBe(cancelBtn);

    doc.pressKey("Tab", { shiftKey: true });
    expect(doc.activeElement).toBe(okBtn);

    doc.pressKey("Escape");
    expect(await promise).toBe(false);
    expect(doc.activeElement).toBe(trigger);
    expect(doc.body.children).toHaveLength(0);
  });
});

describe("choiceDialog (#15)", () => {
  it("focuses the safe non-primary option by default even if a primary option is listed first", async () => {
    const trigger = doc.createElement("button");
    trigger.focus();

    const p1 = choiceDialog("更新", "說明", [...UPDATE_DIALOG_CHOICES]);
    const overlay1 = doc.body.children[0];
    expect(doc.activeElement).toBe(overlay1.querySelector('[data-answer="later"]'));
    doc.pressKey("Escape");
    expect(await p1).toBeNull();
    expect(doc.activeElement).toBe(trigger);

    const p2 = choiceDialog("防呆", "說明", [
      { label: "立即更新", value: "install", primary: true },
      { label: "稍後", value: "later" },
    ]);
    const overlay2 = doc.body.children[0];
    expect(doc.activeElement).toBe(overlay2.querySelector('[data-answer="later"]'));
    doc.pressKey("Tab");
    expect(doc.activeElement).toBe(overlay2.querySelector('[data-answer="install"]'));
    doc.pressKey("Tab");
    expect(doc.activeElement).toBe(overlay2.querySelector('[data-answer="later"]'));
    overlay2.dispatch("click", { target: overlay2.querySelector('[data-answer="install"]') });
    expect(await p2).toBe("install");
    expect(doc.activeElement).toBe(trigger);
  });
});

describe("promptDialog (#15)", () => {
  it("disables OK and shows inline feedback when trimmed input is empty, and skips disabled OK in focus trap", async () => {
    const trigger = doc.createElement("button");
    trigger.focus();

    const promise = promptDialog("改名", "輸入新名稱", "原始名稱");
    const overlay = doc.body.children[0];
    const input = overlay.querySelector("input")!;
    const errorEl = overlay.querySelector(".confirm-error")!;
    const cancelBtn = overlay.querySelector('[data-answer="no"]')!;
    const okBtn = overlay.querySelector('[data-answer="yes"]')!;

    expect(doc.activeElement).toBe(input);
    expect(input.selected).toBe(true);
    expect(okBtn.disabled).toBe(false);
    expect(errorEl.hidden).toBe(true);

    // Clear input to whitespace only.
    input.value = "   ";
    input.dispatch("input", { target: input });
    expect(okBtn.disabled).toBe(true);
    expect(errorEl.hidden).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    // Tab cycles only between input and cancel while OK is disabled.
    doc.pressKey("Tab");
    expect(doc.activeElement).toBe(cancelBtn);
    doc.pressKey("Tab");
    expect(doc.activeElement).toBe(input);

    // Pressing Enter while empty keeps dialog open and keeps error visible.
    doc.pressKey("Enter");
    expect(doc.body.children).toHaveLength(1);
    expect(errorEl.hidden).toBe(false);

    // Entering valid text re-enables OK and clears error.
    input.value = "  新排序  ";
    input.dispatch("input", { target: input });
    expect(okBtn.disabled).toBe(false);
    expect(errorEl.hidden).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("false");

    // Tab now reaches OK button too.
    doc.pressKey("Tab");
    expect(doc.activeElement).toBe(cancelBtn);
    doc.pressKey("Tab");
    expect(doc.activeElement).toBe(okBtn);
    doc.pressKey("Tab");
    expect(doc.activeElement).toBe(input);

    doc.pressKey("Enter");
    expect(await promise).toBe("新排序");
    expect(doc.activeElement).toBe(trigger);
  });

  it("does not submit when Enter is pressed on the focused cancel button", async () => {
    const promise = promptDialog("改名", "輸入新名稱", "有效名稱");
    const overlay = doc.body.children[0];
    const cancelBtn = overlay.querySelector('[data-answer="no"]')!;
    cancelBtn.focus();

    const res = doc.pressKey("Enter");
    expect(res.prevented).toBe(false);
    // Simulate native button activation closing the dialog as cancel.
    overlay.dispatch("click", { target: cancelBtn });
    expect(await promise).toBeNull();
  });
});
