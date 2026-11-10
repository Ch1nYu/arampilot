import { describe, expect, it } from "vitest";
import { friendlyUpdateError, isBusyPhase, progressLabel, releaseNotes } from "./updater";

describe("friendlyUpdateError", () => {
  it("reports a missing release manifest", () => {
    expect(
      friendlyUpdateError("Could not fetch a valid release JSON from the remote: 404 Not Found")
    ).toBe("目前沒有可用的發布版本");
  });

  it("reports a signature failure regardless of case", () => {
    expect(friendlyUpdateError("signature verification failed")).toBe(
      "更新檔簽章驗證失敗，已取消安裝"
    );
    expect(friendlyUpdateError("Invalid SIGNATURE in minisign block")).toBe(
      "更新檔簽章驗證失敗，已取消安裝"
    );
  });

  it("reports a request that never reached the server", () => {
    expect(friendlyUpdateError("error sending request for url (https://api.github.com/...)")).toBe(
      "無法連線到更新伺服器"
    );
  });

  it("reports DNS, timeout and connect failures", () => {
    expect(friendlyUpdateError("dns error: failed to lookup address information")).toBe(
      "無法連線到更新伺服器"
    );
    expect(friendlyUpdateError("operation timed out")).toBe("無法連線到更新伺服器");
    expect(friendlyUpdateError("error trying to connect: connection refused")).toBe(
      "無法連線到更新伺服器"
    );
  });

  it("falls back to the generic message", () => {
    expect(friendlyUpdateError("some unexpected backend failure")).toBe("檢查更新失敗");
    expect(friendlyUpdateError("")).toBe("檢查更新失敗");
  });
});

describe("isBusyPhase", () => {
  it("is true for champ select and every in-game phase", () => {
    for (const phase of ["ChampSelect", "GameStart", "InProgress", "Reconnect"]) {
      expect(isBusyPhase(phase)).toBe(true);
    }
  });

  it("is false elsewhere", () => {
    for (const phase of ["", "None", "Lobby", "Matchmaking", "ReadyCheck", "EndOfGame"]) {
      expect(isBusyPhase(phase)).toBe(false);
    }
  });
});

describe("progressLabel", () => {
  it("shows an integer percent when the total size is known", () => {
    expect(progressLabel(45, 100)).toBe("下載中 45%");
    expect(progressLabel(0, 1000)).toBe("下載中 0%");
    expect(progressLabel(666, 1000)).toBe("下載中 67%");
  });

  it("clamps the percent to 0-100", () => {
    expect(progressLabel(1500, 1000)).toBe("下載中 100%");
    expect(progressLabel(-50, 1000)).toBe("下載中 0%");
  });

  it("shows one decimal MB when the total size is unknown or zero", () => {
    expect(progressLabel(1258291, undefined)).toBe("下載中 1.2 MB");
    expect(progressLabel(0, undefined)).toBe("下載中 0.0 MB");
    expect(progressLabel(1048576, 0)).toBe("下載中 1.0 MB");
  });
});

describe("releaseNotes", () => {
  it("trims the release notes", () => {
    expect(releaseNotes("  修正選角判斷  \n")).toBe("修正選角判斷");
  });

  it("cuts long notes and marks the cut", () => {
    const long = "x".repeat(700);
    const notes = releaseNotes(long);
    expect(notes).toBe(`${"x".repeat(600)}…`);
    expect(notes.length).toBe(601);
  });

  it("keeps notes of exactly the limit untouched", () => {
    const exact = "y".repeat(600);
    expect(releaseNotes(exact)).toBe(exact);
  });

  it("falls back when there are no notes", () => {
    expect(releaseNotes(undefined)).toBe("沒有更新說明");
    expect(releaseNotes(null)).toBe("沒有更新說明");
    expect(releaseNotes("   \n\t ")).toBe("沒有更新說明");
  });
});
