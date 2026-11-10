import { describe, expect, it } from "vitest";
import { classifySaveError } from "./saveResult";

describe("classifySaveError", () => {
  it("no longer treats an account switch as special (one config per computer)", () => {
    expect(classifySaveError({ kind: "accountSwitched", message: "x" }).result).toBe("memory-only");
  });

  it("reports the unreadable-config guard as refused", () => {
    expect(classifySaveError({ kind: "loadRefused", message: "設定檔讀取失敗" })).toEqual({
      result: "refused",
      message: "設定檔讀取失敗",
    });
  });

  it("reports a failed file write as memory-only with the backend text", () => {
    expect(classifySaveError({ kind: "writeFailed", message: "存取被拒" })).toEqual({
      result: "memory-only",
      message: "存取被拒",
    });
  });

  it("treats a plain string error as memory-only", () => {
    expect(classifySaveError("command save_app_config not found")).toEqual({
      result: "memory-only",
      message: "command save_app_config not found",
    });
  });

  it("treats an Error object as memory-only", () => {
    const err = new Error("IPC failed");
    expect(classifySaveError(err)).toEqual({ result: "memory-only", message: "Error: IPC failed" });
  });

  it("ignores an unknown kind instead of guessing", () => {
    expect(classifySaveError({ kind: "somethingElse", message: "x" })).toEqual({
      result: "memory-only",
      message: "[object Object]",
    });
  });
});
