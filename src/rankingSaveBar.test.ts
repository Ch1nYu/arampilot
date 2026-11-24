import { beforeEach, describe, expect, it, vi } from "vitest";

const backupBeforeBulkEdit = vi.fn(async () => true);
const invoke = vi.fn(async () => undefined);
const confirmDialog = vi.fn(async (_title: string, _body: string, _ok: string) => true);

vi.mock("./backup", () => ({ backupBeforeBulkEdit, backupStamp: () => "20261125-000000" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./dialogs", () => ({ confirmDialog, choiceDialog: vi.fn(), promptDialog: vi.fn() }));
vi.mock("./logs", () => ({ addLog: vi.fn() }));
vi.mock("./battle", () => ({
  draftVotes: 0,
  eloMap: {},
  pkComparisonsMap: {},
  replaceWeights: (target: Record<number, number>, next: Record<number, number>) => {
    for (const k of Object.keys(target)) delete target[+k];
    Object.assign(target, next);
  },
  resetDraft: vi.fn(),
  resetFlashState: vi.fn(),
  syncBattlePool: vi.fn(),
  syncFlashPool: vi.fn(),
}));

const { initRankingSaveBar } = await import("./rankingSaveBar");
const { state } = await import("./state");

function clickDelete(): Promise<void> {
  const handlers: Record<string, () => void> = {};
  (globalThis as { document?: unknown }).document = {
    getElementById: (id: string) => ({
      addEventListener: (_type: string, fn: () => void) => {
        handlers[id] = fn;
      },
    }),
  };
  initRankingSaveBar({ renderTiers: vi.fn(), saveConfigImmediate: vi.fn(async () => true) });
  (globalThis as { document?: unknown }).document = { getElementById: () => null };
  handlers.btnRankSaveDelete();
  return new Promise((r) => setTimeout(r, 0));
}

describe("deleting a ranking save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.profileList = [{ id: 1, n: "A", t: "本命", f: "" }];
    state.rankingSaves = [
      { id: "a", name: "tmp", items: [{ id: 1, name: "A", tier: "本命", flag: "" }] },
      { id: "b", name: "Gua", items: [{ id: 1, name: "A", tier: "愛角", flag: "" }] },
    ];
    state.activeRankingSave = "a";
  });

  it("removes the save without writing a backup", async () => {
    await clickDelete();
    expect(state.rankingSaves.map((s) => s.id)).toEqual(["b"]);
    expect(state.activeRankingSave).toBe("b");
    expect(backupBeforeBulkEdit).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("backup_config_snapshot", expect.anything());
    expect(confirmDialog.mock.calls[0][1]).toContain("無法復原");
  });

  it("keeps the save when the user cancels", async () => {
    confirmDialog.mockResolvedValueOnce(false);
    await clickDelete();
    expect(state.rankingSaves.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
