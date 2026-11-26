import { describe, expect, it } from "vitest";
import {
  actionsText,
  formatDuration,
  formatK,
  formatMatchTime,
  matchListHtml,
  resultLabel,
  type MatchRecord,
  type PlayerStats,
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

const player = (over: Partial<PlayerStats> = {}): PlayerStats => ({
  teamId: 100,
  win: true,
  isMe: false,
  name: "",
  championId: 1,
  level: 18,
  kills: 0,
  deaths: 0,
  assists: 0,
  damageToChampions: 0,
  damageTaken: 0,
  healing: 0,
  gold: 0,
  items: [],
  augments: [],
  spells: [4, 7],
  ...over,
});

/** `player` with `isMe` set, so a game can be written without repeating the flag. */
const me = (over: Partial<PlayerStats> = {}): PlayerStats => player({ isMe: true, ...over });

const nameOf = (id: number) => `英雄${id}`;

/** Team tags and totals are markup-heavy, so compare the rendered text instead. */
const text = (html: string) => html.replace(/<[^>]+>/g, "");

/** Five players a side, my team winning, so the tables and totals are realistic. */
const tenPlayers = (): PlayerStats[] => [
  me({
    championId: 1,
    name: "我自己",
    kills: 19,
    deaths: 13,
    assists: 25,
    damageToChampions: 70805,
    damageTaken: 40000,
    gold: 19658,
    items: [1001, 1002],
    augments: [{ id: 123, name: "閃電", rarity: "gold" }],
  }),
  player({ championId: 2, name: "隊友一", kills: 12, deaths: 3, assists: 8, damageToChampions: 40000, gold: 15000 }),
  player({ championId: 3, name: "", kills: 10, deaths: 4, assists: 6, damageToChampions: 30000, gold: 14000 }),
  player({ championId: 4, name: "隊友三", kills: 12, deaths: 5, assists: 4, damageToChampions: 25000, gold: 13000 }),
  player({ championId: 5, name: "隊友四", kills: 10, deaths: 6, assists: 4, damageToChampions: 20000, gold: 12000 }),
  player({ teamId: 200, win: false, championId: 6, name: "對手一", kills: 5, damageToChampions: 19000, gold: 10000 }),
  player({ teamId: 200, win: false, championId: 7, name: "對手二", kills: 4, damageToChampions: 15000, gold: 10000 }),
  player({ teamId: 200, win: false, championId: 8, name: "對手三", kills: 3, damageToChampions: 10000, gold: 10000 }),
  player({ teamId: 200, win: false, championId: 9, name: "對手四", kills: 2, damageToChampions: 5000, gold: 10000 }),
  player({ teamId: 200, win: false, championId: 10, name: "對手五", kills: 1, damageToChampions: 0, gold: 10000 }),
];

const detailed = (over: Partial<MatchRecord> = {}): MatchRecord =>
  rec({ detail: { durationSec: 1127, players: tenPlayers() }, ...over });

describe("formatK", () => {
  it("keeps whole numbers under 1000", () => {
    expect(formatK(0)).toBe("0");
    expect(formatK(999)).toBe("999");
  });

  it("switches to one decimal and k from 1000 on", () => {
    expect(formatK(1000)).toBe("1.0k");
    expect(formatK(70805)).toBe("70.8k");
    expect(formatK(19658)).toBe("19.7k");
  });
});

describe("formatDuration", () => {
  it("renders m:ss", () => {
    expect(formatDuration(1127)).toBe("18:47");
    expect(formatDuration(61)).toBe("1:01");
    expect(formatDuration(0)).toBe("0:00");
  });
});

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

describe("matchListHtml with detail", () => {
  it("puts the own KDA, damage, gold and augment icons on the summary line", () => {
    const html = matchListHtml([detailed()], nameOf);
    const summary = html.slice(0, html.indexOf("</summary>"));
    expect(summary).toContain("19/13/25");
    expect(summary).toContain("70.8k");
    expect(summary).toContain("19.7k");
    expect(summary).toContain('src="http://icon.localhost/augment/123.png"');
  });

  it("renders both team tables newest-game-open with duration, totals and 10 rows", () => {
    const html = matchListHtml([detailed()], nameOf);
    expect(html).toContain("18:47");
    expect(html.indexOf("我方")).toBeLessThan(html.indexOf("敵方"));
    expect(html.match(/class="pl( me)?"/g) ?? []).toHaveLength(10);
    expect(html.match(/class="pl me"/g) ?? []).toHaveLength(1);
    const plain = text(html);
    expect(plain).toContain("我方 · 勝 · 擊殺 63 · 金錢 73.7k");
    expect(plain).toContain("敵方 · 敗 · 擊殺 15 · 金錢 50.0k");
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('<span class="lv">Lv18</span>');
    expect(html).toContain('src="http://icon.localhost/item/1001.png"');
    expect(html).toContain('src="http://icon.localhost/champion/1.png"');
  });

  it("falls back to the champion name for an empty player name", () => {
    const html = matchListHtml([detailed()], nameOf);
    expect(html).toContain('<span class="nm">英雄3</span>');
  });

  it("uses 藍方 and 紅方 when the game has no isMe player", () => {
    const players = tenPlayers().map((p) => ({ ...p, isMe: false }));
    const html = matchListHtml([rec({ detail: { durationSec: 1127, players } })], nameOf);
    expect(html.indexOf("藍方")).toBeLessThan(html.indexOf("紅方"));
    expect(html).not.toContain("我方");
    expect(html).not.toContain("敵方");
  });

  it("shows #id as the augment tooltip when the name is unknown and keeps the rarity class", () => {
    const players = tenPlayers().map((p, i) =>
      i === 0 ? { ...p, augments: [{ id: 1234, name: "", rarity: "gold" as const }] } : p,
    );
    const html = matchListHtml([rec({ detail: { durationSec: 1127, players } })], nameOf);
    expect(html).toContain('title="#1234"');
    expect(html).toContain("aug-gold");
    expect(html).toContain("http://icon.localhost/augment/1234.png");
  });

  it("folds the execution log into a collapsed sub-section when the detail is there", () => {
    const html = matchListHtml(
      [
        detailed({
          log: [{ date: "2026-11-25", time: "20:31:07", kind: "act", title: "選卡", reason: "" }],
        }),
      ],
      nameOf,
    );
    expect(html).toContain('<details class="match-log"><summary>App 做了什麼（1 行）</summary>');
    expect(html).toContain('<span class="tag act">執行</span>');
    // collapsed: the sub-section is not rendered open
    expect(html).not.toContain('class="match-log" open');
  });

  it("escapes a player name", () => {
    const players = tenPlayers().map((p, i) => (i === 1 ? { ...p, name: "<b>壞</b>" } : p));
    const html = matchListHtml([rec({ detail: { durationSec: 1127, players } })], nameOf);
    expect(html).toContain("&lt;b&gt;壞&lt;/b&gt;");
    expect(html).not.toContain("<b>壞");
  });
});

describe("matchListHtml without detail", () => {
  it("dashes the summary numbers and shows no augment icons", () => {
    const summary = matchListHtml([rec()], nameOf).split("</summary>")[0];
    expect(summary).toContain('<span class="kda">—</span>');
    expect(summary).toContain('<span class="dmg">—</span>');
    expect(summary).toContain('<span class="gold">—</span>');
    expect(summary).not.toContain("/augment/");
  });

  it("says the client no longer has the game", () => {
    expect(matchListHtml([rec({ result: "win" })], nameOf)).toContain("用戶端已沒有這場的詳細資料。");
    expect(matchListHtml([rec({ result: "notPlayed" })], nameOf)).not.toContain("用戶端已沒有這場的詳細資料。");
    expect(matchListHtml([rec({ result: "notPlayed" })], nameOf)).not.toContain('class="match-log"');
  });
});
