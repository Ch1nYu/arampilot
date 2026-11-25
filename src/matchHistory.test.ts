import { describe, expect, it } from "vitest";
import {
  actionsText,
  formatMatchTime,
  matchListHtml,
  resultLabel,
  type MatchRecord,
} from "./matchHistory";

const rec = (over: Partial<MatchRecord> = {}): MatchRecord => ({
  gameId: 1,
  date: "2026-11-25",
  time: "20:31:07",
  queueId: 450,
  championId: 1,
  result: "win",
  actions: ["自動選卡"],
  log: [],
  ...over,
});

const nameOf = (id: number) => `英雄${id}`;

describe("formatMatchTime", () => {
  it("renders MM/DD HH:MM without the seconds", () => {
    expect(formatMatchTime("2026-11-25", "20:31:07")).toBe("11/25 20:31");
    expect(formatMatchTime("2026-01-02", "09:05:00")).toBe("01/02 09:05");
  });

  it("keeps the time as given when the input is malformed", () => {
    expect(formatMatchTime("25/11/2026", "20:31:07")).toBe("20:31:07");
    expect(formatMatchTime("", "20:31:07")).toBe("20:31:07");
    expect(formatMatchTime("2026-11-25", "晚間八點")).toBe("晚間八點");
  });
});

describe("resultLabel", () => {
  it("maps every result to its label and class", () => {
    expect(resultLabel("win")).toEqual({ text: "勝", cls: "win" });
    expect(resultLabel("loss")).toEqual({ text: "敗", cls: "loss" });
    expect(resultLabel("notPlayed")).toEqual({ text: "沒開打", cls: "other" });
    expect(resultLabel("unknown")).toEqual({ text: "未知", cls: "other" });
  });
});

describe("actionsText", () => {
  it("joins the actions with a middle dot", () => {
    expect(actionsText(["自動選卡", "自動拿板凳"])).toBe("自動選卡 · 自動拿板凳");
  });

  it("says so when the app did nothing", () => {
    expect(actionsText([])).toBe("沒有動作");
  });
});

describe("matchListHtml", () => {
  it("lists the newest game first without touching the input order", () => {
    const records = [
      rec({ date: "2026-11-24", championId: 1 }),
      rec({ date: "2026-11-25", championId: 2 }),
    ];
    const html = matchListHtml(records, nameOf);
    expect(html.indexOf("11/25")).toBeLessThan(html.indexOf("11/24"));
    expect(html.indexOf("英雄2")).toBeLessThan(html.indexOf("英雄1"));
    expect(records.map((r) => r.championId)).toEqual([1, 2]);
  });

  it("shows the empty state when nothing was recorded", () => {
    const html = matchListHtml([], nameOf);
    expect(html).toContain("還沒有對戰紀錄。");
    expect(html).not.toContain("<details");
  });

  it("renders the line: time, mode, champion, result and actions", () => {
    const html = matchListHtml([rec({ queueId: 2400 })], nameOf);
    expect(html).toContain('<span class="t">11/25 20:31</span>');
    expect(html).toContain("<span>Mayhem</span>");
    expect(html).toContain('<span class="champ">英雄1</span>');
    expect(html).toContain('<span class="res win">勝</span>');
    expect(html).toContain('<span class="acts">自動選卡</span>');
  });

  it("shows an em dash instead of a name when champ select saw no champion", () => {
    const html = matchListHtml([rec({ championId: null })], (id) => `不該用到${id}`);
    expect(html).toContain('<span class="champ">—</span>');
  });

  it("escapes the title of a log line", () => {
    const html = matchListHtml(
      [rec({ log: [{ date: "2026-11-25", time: "20:31:07", kind: "act", title: "<b>選卡</b>", reason: "a & b" }] })],
      nameOf,
    );
    expect(html).toContain("&lt;b&gt;選卡&lt;/b&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).not.toContain("<b>");
    expect(html).toContain('<span class="tag act">執行</span>');
  });

  it("marks a game with no log lines", () => {
    expect(matchListHtml([rec({ log: [] })], nameOf)).toContain("這場沒有紀錄。");
    const withLog = matchListHtml(
      [rec({ log: [{ date: "2026-11-25", time: "20:31:07", kind: "skip", title: "略過選卡", reason: "" }] })],
      nameOf,
    );
    expect(withLog).not.toContain("這場沒有紀錄。");
  });
});
