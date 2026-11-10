import { describe, expect, it } from "vitest";
import { applyAssist, emptyAssist, type AssistState, type AssistPayload } from "./assist";

const cardPayload: AssistPayload = {
  kind: "card",
  champ_id: 81,
  action_id: 5,
  reason: "分數最高（92）",
};
const benchPayload: AssistPayload = { kind: "bench", champ_id: 267, reason: "分差 +14" };
const tradePayload: AssistPayload = {
  kind: "trade",
  trade_id: 9,
  verdict: "accept",
  reason: "換進來分數更高",
};
const chatPayload: AssistPayload = { kind: "chat", chat_id: "chat-1", text: "謝謝交換" };

/** Every suggestion kind filled in, as the overview would hold it mid-session. */
function fullState(): AssistState {
  let state = emptyAssist();
  for (const payload of [cardPayload, benchPayload, tradePayload, chatPayload]) {
    state = applyAssist(state, payload);
  }
  return state;
}

describe("emptyAssist", () => {
  it("starts with no suggestion and no trade verdicts", () => {
    expect(emptyAssist()).toEqual({ trades: {} });
    expect(emptyAssist().card).toBeUndefined();
    expect(emptyAssist().bench).toBeUndefined();
    expect(emptyAssist().chat).toBeUndefined();
  });
});

describe("applyAssist payload kinds", () => {
  it("stores a card suggestion with its action id and reason", () => {
    expect(applyAssist(emptyAssist(), cardPayload).card).toEqual({
      champId: 81,
      actionId: 5,
      reason: "分數最高（92）",
    });
  });

  it("stores a bench suggestion", () => {
    expect(applyAssist(emptyAssist(), benchPayload).bench).toEqual({
      champId: 267,
      reason: "分差 +14",
    });
  });

  it("stores an accept verdict for a trade", () => {
    expect(applyAssist(emptyAssist(), tradePayload).trades).toEqual({
      9: { verdict: "accept", reason: "換進來分數更高" },
    });
  });

  it("stores a reject verdict for a trade", () => {
    const state = applyAssist(emptyAssist(), {
      kind: "trade",
      trade_id: 9,
      verdict: "reject",
      reason: "換進來分數更高",
    });
    expect(state.trades[9]).toEqual({ verdict: "reject", reason: "換進來分數更高" });
  });

  it("stores a chat suggestion", () => {
    expect(applyAssist(emptyAssist(), chatPayload).chat).toEqual({
      chatId: "chat-1",
      text: "謝謝交換",
    });
  });

  it("falls back to an empty reason when the payload omits it", () => {
    const state = applyAssist(emptyAssist(), { kind: "bench", champ_id: 1 });
    expect(state.bench).toEqual({ champId: 1, reason: "" });
  });
});

describe("applyAssist replacement", () => {
  it("replaces the previous card suggestion", () => {
    const first = applyAssist(emptyAssist(), cardPayload);
    const second = applyAssist(first, {
      kind: "card",
      champ_id: 1,
      action_id: 2,
      reason: "改選這張",
    });
    expect(second.card).toEqual({ champId: 1, actionId: 2, reason: "改選這張" });
  });

  it("replaces the previous bench suggestion", () => {
    const first = applyAssist(emptyAssist(), benchPayload);
    const second = applyAssist(first, { kind: "bench", champ_id: 7, reason: "分差 +20" });
    expect(second.bench).toEqual({ champId: 7, reason: "分差 +20" });
  });

  it("replaces the previous chat suggestion", () => {
    const first = applyAssist(emptyAssist(), chatPayload);
    const second = applyAssist(first, { kind: "chat", chat_id: "chat-2", text: "換好了" });
    expect(second.chat).toEqual({ chatId: "chat-2", text: "換好了" });
  });

  it("keeps every trade verdict, keyed by trade id", () => {
    let state = applyAssist(emptyAssist(), tradePayload);
    state = applyAssist(state, { kind: "trade", trade_id: 12, verdict: "reject", reason: "本命不換" });
    expect(Object.keys(state.trades).sort()).toEqual(["12", "9"]);
    expect(state.trades[9].verdict).toBe("accept");
    expect(state.trades[12].verdict).toBe("reject");
  });

  it("overwrites the verdict of the same trade id", () => {
    let state = applyAssist(emptyAssist(), tradePayload);
    state = applyAssist(state, { kind: "trade", trade_id: 9, verdict: "reject", reason: "改判" });
    expect(state.trades[9]).toEqual({ verdict: "reject", reason: "改判" });
    expect(Object.keys(state.trades)).toEqual(["9"]);
  });
});

describe("applyAssist clear", () => {
  it("drops only the card suggestion", () => {
    const state = applyAssist(fullState(), { kind: "clear", target: "card" });
    expect(state.card).toBeUndefined();
    expect(state.bench).toBeDefined();
    expect(state.trades[9]).toBeDefined();
    expect(state.chat).toBeDefined();
  });

  it("drops only the bench suggestion", () => {
    const state = applyAssist(fullState(), { kind: "clear", target: "bench" });
    expect(state.bench).toBeUndefined();
    expect(state.card).toBeDefined();
    expect(state.trades[9]).toBeDefined();
    expect(state.chat).toBeDefined();
  });

  it("drops every trade verdict", () => {
    let state = applyAssist(fullState(), { kind: "trade", trade_id: 12, verdict: "reject" });
    state = applyAssist(state, { kind: "clear", target: "trade" });
    expect(state.trades).toEqual({});
    expect(state.card).toBeDefined();
    expect(state.bench).toBeDefined();
    expect(state.chat).toBeDefined();
  });

  it("drops only the chat suggestion", () => {
    const state = applyAssist(fullState(), { kind: "clear", target: "chat" });
    expect(state.chat).toBeUndefined();
    expect(state.card).toBeDefined();
    expect(state.bench).toBeDefined();
    expect(state.trades[9]).toBeDefined();
  });

  it("resets everything for target all", () => {
    expect(applyAssist(fullState(), { kind: "clear", target: "all" })).toEqual({ trades: {} });
  });
});

describe("applyAssist immutability", () => {
  it("does not mutate the previous state", () => {
    const before = fullState();
    const snapshot = JSON.parse(JSON.stringify(before));
    applyAssist(before, { kind: "clear", target: "all" });
    applyAssist(before, { kind: "card", champ_id: 3, action_id: 1 });
    applyAssist(before, { kind: "trade", trade_id: 4, verdict: "reject" });
    applyAssist(before, { kind: "bench", champ_id: 5 });
    applyAssist(before, { kind: "chat", chat_id: "c", text: "t" });
    expect(before).toEqual(snapshot);
    // The trade map is copied, not shared, so an update cannot leak backwards.
    expect(applyAssist(before, tradePayload).trades).not.toBe(before.trades);
  });

  it("returns a new state object for every payload", () => {
    const before = fullState();
    const payloads: AssistPayload[] = [
      cardPayload,
      benchPayload,
      tradePayload,
      chatPayload,
      { kind: "clear", target: "card" },
      { kind: "clear", target: "all" },
    ];
    for (const payload of payloads) {
      expect(applyAssist(before, payload)).not.toBe(before);
    }
  });
});
