import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  actionsText,
  formatDuration,
  formatK,
  formatMatchTime,
  initMatchHistory,
  matchListHtml,
  personalHighlight,
  resultLabel,
  setLogView,
  teamCompare,
  teamOf,
  type GameDetail,
  type MatchRecord,
  type PlayerStats,
} from "./matchHistory";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => [] as MatchRecord[]),
  listenMock: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

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

/** Ten players; `spec` sets each index's numbers, index 0 being me and 5-9 the opponents. */
const ten = (spec: (i: number) => Partial<PlayerStats> = () => ({})): GameDetail => ({
  durationSec: 1127,
  players: Array.from({ length: 10 }, (_, i) =>
    i === 0
      ? me({ championId: 1, ...spec(i) })
      : player({ teamId: i < 5 ? 100 : 200, win: i < 5, championId: i + 1, ...spec(i) }),
  ),
});

/** A game where teammate #2 beats me on every axis, so no highlight rule holds by default. */
const beaten = (over: (i: number) => Partial<PlayerStats> = () => ({})): GameDetail =>
  ten((i) => ({
    assists: i === 1 ? 10 : 0,
    damageToChampions: i === 0 ? 20000 : i === 1 ? 50000 : 10000,
    damageTaken: i === 0 ? 10000 : i === 1 ? 40000 : 0,
    healing: i === 1 ? 1000 : 0,
    gold: 20000,
    ...over(i),
  }));

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

describe("teamOf", () => {
  it("returns my team, me included, and nobody from the other side", () => {
    const players = tenPlayers();
    const members = teamOf({ durationSec: 1127, players }, players[0]);
    expect(members).toHaveLength(5);
    expect(members.every((p) => p.teamId === 100)).toBe(true);
    expect(members).toContain(players[0]);
  });
});

describe("personalHighlight", () => {
  it("rule 1: the whole game, with my share of the team damage", () => {
    const detail = ten((i) => ({ damageToChampions: i === 0 ? 50000 : 10000 }));
    expect(personalHighlight(detail)).toBe("全場最高輸出，佔全隊傷害 56%");
  });

  it("rule 2: my team's top damage when an opponent out-damages me", () => {
    const detail = ten((i) => ({ damageToChampions: i === 0 ? 50000 : i === 5 ? 60000 : 10000 }));
    expect(personalHighlight(detail)).toBe("隊上主輸出，佔全隊傷害 56%");
  });

  it("rule 3: the most damage taken in my team", () => {
    const detail = ten((i) => ({
      damageToChampions: i === 0 ? 20000 : i === 1 ? 50000 : 10000,
      damageTaken: i === 0 ? 41000 : i === 1 ? 20000 : 0,
    }));
    expect(personalHighlight(detail)).toBe("承受 41.0k 傷害，全隊最多");
  });

  it("rule 4: the most crowd control in my team", () => {
    const detail = ten((i) => ({
      damageToChampions: i === 0 ? 20000 : i === 1 ? 50000 : 10000,
      damageTaken: i === 0 ? 10000 : i === 1 ? 40000 : 0,
      ccSec: i === 0 ? 32 : i === 1 ? 5 : 0,
    }));
    expect(personalHighlight(detail)).toBe("控場 32 秒，全隊最多");
  });

  it("rule 5: the most healing in my team", () => {
    const detail = ten((i) => ({
      damageToChampions: i === 0 ? 20000 : i === 1 ? 50000 : 10000,
      damageTaken: i === 0 ? 10000 : i === 1 ? 40000 : 0,
      healing: i === 0 ? 3000 : i === 1 ? 1000 : 0,
    }));
    expect(personalHighlight(detail)).toBe("治療 3.0k，全隊最多");
  });

  it("rule 6: the best damage per gold in my team", () => {
    const detail = ten((i) => ({
      damageToChampions: i === 0 ? 20000 : i === 1 ? 50000 : 10000,
      damageTaken: i === 0 ? 10000 : i === 1 ? 40000 : 0,
      gold: i === 0 ? 10000 : i === 1 ? 40000 : 20000,
    }));
    expect(personalHighlight(detail)).toBe("花錢效率全隊最高（每 1 金 2.00 傷害）");
  });

  it("rule 7: the most assists in my team", () => {
    const detail = ten((i) => ({
      assists: i === 0 ? 25 : i === 1 ? 24 : 0,
      damageToChampions: i === 0 ? 20000 : i === 1 ? 50000 : 10000,
      damageTaken: i === 0 ? 10000 : i === 1 ? 40000 : 0,
      gold: i === 0 ? 10000 : 20000,
    }));
    expect(personalHighlight(detail)).toBe("助攻 25，全隊最多");
  });

  it("takes the whole-game line over the team-top line", () => {
    const detail = ten((i) => ({
      assists: i === 0 ? 25 : 0,
      damageToChampions: i === 0 ? 50000 : i === 1 ? 49000 : 10000,
      damageTaken: i === 0 ? 41000 : 0,
    }));
    expect(personalHighlight(detail)).toBe("全場最高輸出，佔全隊傷害 39%");
  });

  it("takes crowd control over healing", () => {
    const detail = ten((i) => ({
      damageToChampions: i === 0 ? 20000 : i === 1 ? 50000 : 10000,
      damageTaken: i === 0 ? 10000 : i === 1 ? 40000 : 0,
      ccSec: i === 0 ? 32 : 0,
      healing: i === 0 ? 3000 : 0,
    }));
    expect(personalHighlight(detail)).toBe("控場 32 秒，全隊最多");
  });

  it("counts a tie in my team as first", () => {
    const detail = ten((i) => ({ damageToChampions: i === 5 ? 60000 : i < 2 ? 50000 : 10000 }));
    expect(personalHighlight(detail)).toBe("隊上主輸出，佔全隊傷害 38%");
  });

  it("returns null when a teammate beats me everywhere", () => {
    expect(personalHighlight(beaten())).toBeNull();
  });

  it("returns null without an isMe player", () => {
    const players = tenPlayers().map((p) => ({ ...p, isMe: false }));
    expect(personalHighlight({ durationSec: 1127, players })).toBeNull();
  });

  it("skips the crowd-control line when the record has no ccSec", () => {
    const withCc = (cc: Partial<PlayerStats>) => beaten((i) => ({ ...(i === 1 ? { ccSec: 5 } : {}), ...cc }));
    expect(personalHighlight(withCc({ ccSec: 32 }))).toBe("控場 32 秒，全隊最多");
    // same game, but stored before ccSec existed: the field is missing and reads as 0
    expect(personalHighlight(withCc({}))).toBeNull();
  });
});

describe("teamCompare", () => {
  const detail = (): GameDetail => ({ durationSec: 1127, players: tenPlayers() });

  it("reports my number, the team average, the team max and my rank", () => {
    expect(teamCompare(detail(), "damageToChampions")).toEqual({ mine: 70805, avg: 37161, max: 70805, rank: 1 });
    expect(teamCompare(detail(), "damageTaken")).toEqual({ mine: 40000, avg: 8000, max: 40000, rank: 1 });
    expect(teamCompare(detail(), "gold")).toEqual({ mine: 19658, avg: 14731.6, max: 19658, rank: 1 });
  });

  it("shares the better rank on a tie", () => {
    const tie = ten((i) => ({ damageToChampions: i < 2 ? 40000 : 0 }));
    expect(teamCompare(tie, "damageToChampions")).toEqual({ mine: 40000, avg: 16000, max: 40000, rank: 1 });
  });

  it("counts only the teammates above me", () => {
    const behind = ten((i) => ({ damageToChampions: i === 0 ? 20000 : i === 1 ? 50000 : i === 2 ? 30000 : 0 }));
    expect(teamCompare(behind, "damageToChampions")).toEqual({ mine: 20000, avg: 20000, max: 50000, rank: 3 });
  });

  it("has no team without an isMe player", () => {
    const players = tenPlayers().map((p) => ({ ...p, isMe: false }));
    expect(teamCompare({ durationSec: 1127, players }, "gold")).toEqual({ mine: 0, avg: 0, max: 0, rank: 0 });
  });
});

describe("the personal card", () => {
  /** The card is the first thing in the body, so it runs from `.me-card` to the duration line. */
  const cardOf = (html: string) =>
    html.slice(html.indexOf('<div class="me-card'), html.indexOf('<div class="match-dur">'));

  const withKda = (kills: number, deaths: number, assists: number): PlayerStats[] =>
    tenPlayers().map((p, i) => (i === 0 ? { ...p, kills, deaths, assists } : p));

  it("sits above both tables with my art, KDA, highlight and picks", () => {
    const html = matchListHtml([rec({ detail: { durationSec: 1127, players: withKda(9, 8, 39) } })], nameOf);
    const card = cardOf(html);
    expect(html.indexOf('class="me-card')).toBeLessThan(html.indexOf('class="match-dur"'));
    expect(html.indexOf('class="me-card')).toBeLessThan(html.indexOf("我方"));
    expect(card).toContain('<div class="me-card win">');
    expect(card).toContain('<img class="me-art" src="http://icon.localhost/loadscreen/1.jpg" data-n="英雄1" alt="">');
    expect(card).toContain('<span class="res win">勝</span> · ARAM · 18:47 · 英雄1');
    expect(card).toContain("<b>9 / 8 / 39</b>");
    expect(card).toContain("傷害佔 38%");
    expect(card).toContain('<div class="me-hl">全場最高輸出，佔全隊傷害 38%</div>');
    expect(card).toContain('<img class="aug aug-gold" src="http://icon.localhost/augment/123.png" data-n="閃電"');
    expect(card).toContain('src="http://icon.localhost/item/1001.png" data-n="裝"');
  });

  it("gives each compare row a bar, my value, the team average and my rank", () => {
    const card = cardOf(matchListHtml([detailed()], nameOf));
    expect(card.match(/class="me-cmp"/g) ?? []).toHaveLength(3);
    expect(card).toContain('<span class="k">傷害</span>');
    expect(card).toContain('<span class="k">承受</span>');
    expect(card).toContain('<span class="k">金錢</span>');
    expect(card.indexOf("傷害")).toBeLessThan(card.indexOf("承受"));
    expect(card.indexOf("承受")).toBeLessThan(card.indexOf("金錢"));
    expect(card).toContain('<i class="fill" style="width:100%"></i>');
    expect(card).toContain('<i class="avg" style="left:52%" title="隊上平均 37.2k"></i>');
    expect(card).toContain('<span class="v">70.8k</span>');
    expect(card).toContain('<span class="v">40.0k</span>');
    expect(card).toContain('<span class="v">19.7k</span>');
    expect(card).toContain('<span class="rk">第 1 / 5</span>');
  });

  it("uses the loss class and 敗 on a lost game", () => {
    const players = tenPlayers().map((p, i) => (i === 0 ? { ...p, win: false } : p));
    const card = cardOf(matchListHtml([rec({ result: "loss", detail: { durationSec: 1127, players } })], nameOf));
    expect(card).toContain('<div class="me-card loss">');
    expect(card).toContain('<span class="res loss">敗</span>');
  });

  it("is left out when the record has no detail or no isMe player", () => {
    expect(matchListHtml([rec()], nameOf)).not.toContain("me-card");
    const players = tenPlayers().map((p) => ({ ...p, isMe: false }));
    const html = matchListHtml([rec({ detail: { durationSec: 1127, players } })], nameOf);
    expect(html).not.toContain("me-card");
  });

  it("escapes the champion name it borrows from the profile", () => {
    const html = matchListHtml([detailed()], (id) => (id === 1 ? "<b>壞</b>" : `英雄${id}`));
    expect(html).toContain("&lt;b&gt;壞&lt;/b&gt;");
    expect(html).not.toContain("<b>壞");
  });

  it("opens only the newest game", () => {
    const html = matchListHtml([rec({ date: "2026-11-24" }), detailed({ date: "2026-11-25" })], nameOf);
    expect(html.match(/class="match" open/g) ?? []).toHaveLength(1);
    expect(html.indexOf('class="match" open')).toBeLessThan(html.indexOf('class="match">'));
  });

  it("renders list column header, expand chevron, icon grouping, team-avg track tooltip, and data-n fallbacks", () => {
    const html = matchListHtml([detailed()], nameOf);
    expect(html).toContain('<div class="match-list-hd"');
    expect(html).toContain('<span class="chev" aria-hidden="true">▸</span>');
    expect(html).toContain('<span class="me-icon-group me-augs">');
    expect(html).toContain('<span class="me-icon-sep" aria-hidden="true"></span>');
    expect(html).toContain('<span class="me-icon-group me-items">');
    expect(html).toContain('<span class="trk" title="隊上平均 37.2k">');
    expect(html).toContain('<img class="champ-ic" src="http://icon.localhost/champion/1.png" data-n="英雄1"');
    // Every <img> in matchListHtml must carry a non-empty data-n fallback.
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const tag of imgs) {
      expect(tag).toMatch(/\bdata-n="[^"]+"/);
    }
  });

  it("omits the icon group separator when a player only has items", () => {
    const players = tenPlayers().map((p, i) => (i === 0 ? { ...p, augments: [] } : p));
    const card = cardOf(matchListHtml([rec({ detail: { durationSec: 1127, players } })], nameOf));
    expect(card).toContain('class="me-icon-group me-items"');
    expect(card).not.toContain("me-icon-sep");
  });
});

describe("initMatchHistory log view routing (#14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("switches to the exec view when clicking overview's 查看完整紀錄 link", () => {
    const mkBtn = (v: string) => {
      const classes = new Set<string>(v === "matches" ? ["on"] : []);
      return {
        dataset: { v },
        classList: {
          toggle: (name: string, force?: boolean) => {
            if (force) classes.add(name);
            else classes.delete(name);
          },
          has: (name: string) => classes.has(name),
        },
      };
    };
    const btnMatches = mkBtn("matches");
    const btnExec = mkBtn("exec");
    const seg = {
      addEventListener: vi.fn(),
      querySelectorAll: () => [btnMatches, btnExec],
      contains: () => true,
    };
    const els: Record<string, unknown> = {
      logView: seg,
      matchView: { style: { display: "" } },
      execView: { style: { display: "none" } },
      logFilter: { style: { display: "none" } },
      matchList: { innerHTML: "" },
    };
    let docClick: ((e: unknown) => void) | undefined;
    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) => els[id] ?? null,
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === "click") docClick = fn;
      },
    };

    initMatchHistory();
    expect((els.matchView as { style: { display: string } }).style.display).toBe("");
    expect((els.execView as { style: { display: string } }).style.display).toBe("none");
    expect((els.logFilter as { style: { display: string } }).style.display).toBe("none");
    expect(btnMatches.classList.has("on")).toBe(true);
    expect(btnExec.classList.has("on")).toBe(false);

    // Click overview's 查看完整紀錄 -> should activate 執行紀錄 view and show logFilter
    const trigger = { dataset: { go: "log", logView: "exec" } };
    docClick?.({ target: { closest: (sel: string) => (sel === '[data-go="log"]' ? trigger : null) } });

    expect((els.matchView as { style: { display: string } }).style.display).toBe("none");
    expect((els.execView as { style: { display: string } }).style.display).toBe("");
    expect((els.logFilter as { style: { display: string } }).style.display).toBe("");
    expect(btnMatches.classList.has("on")).toBe(false);
    expect(btnExec.classList.has("on")).toBe(true);

    // Explicitly switching back via setLogView keeps toggle and panels in sync
    setLogView("matches");
    expect((els.matchView as { style: { display: string } }).style.display).toBe("");
    expect((els.execView as { style: { display: string } }).style.display).toBe("none");
    expect(btnMatches.classList.has("on")).toBe(true);
  });
});
