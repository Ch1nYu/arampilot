/**
 * Champ select assist suggestions: a pure reducer over `lcu-assist` payloads.
 *
 * The backend no longer picks cards, swaps bench champions, answers trades or
 * sends chat by itself. It emits one suggestion instead, and the overview shows
 * it with a one-click button. Keeping that state machine here (no DOM, no Tauri
 * imports) keeps the payload handling unit-testable.
 */

export interface CardSuggestion {
  champId: number;
  actionId: number;
  reason: string;
}

export interface BenchSuggestion {
  champId: number;
  reason: string;
}

export interface TradeSuggestion {
  verdict: "accept" | "reject";
  reason: string;
}

export interface ChatSuggestion {
  chatId: string;
  text: string;
}

/** One champ select session worth of suggestions. */
export interface AssistState {
  card?: CardSuggestion;
  bench?: BenchSuggestion;
  /** Keyed by trade id: several teammates can ask in the same session. */
  trades: Record<number, TradeSuggestion>;
  chat?: ChatSuggestion;
}

export type AssistClearTarget = "card" | "bench" | "trade" | "chat" | "all";

/** Payload of the backend `lcu-assist` event (snake_case keys, as emitted by Rust). */
export type AssistPayload =
  | { kind: "card"; champ_id: number; action_id: number; reason?: string }
  | { kind: "bench"; champ_id: number; reason?: string }
  | { kind: "trade"; trade_id: number; verdict: "accept" | "reject"; reason?: string }
  | { kind: "chat"; chat_id: string; text: string }
  | { kind: "clear"; target: AssistClearTarget };

export function emptyAssist(): AssistState {
  return { trades: {} };
}

/**
 * Fold one suggestion into the state. Always returns a new object and never
 * mutates `state`; a new card / bench / chat suggestion replaces the previous one.
 */
export function applyAssist(state: AssistState, payload: AssistPayload): AssistState {
  switch (payload.kind) {
    case "card":
      return {
        ...state,
        card: {
          champId: Number(payload.champ_id) || 0,
          actionId: Number(payload.action_id) || 0,
          reason: payload.reason || "",
        },
      };
    case "bench":
      return {
        ...state,
        bench: { champId: Number(payload.champ_id) || 0, reason: payload.reason || "" },
      };
    case "trade":
      return {
        ...state,
        trades: {
          ...state.trades,
          [Number(payload.trade_id) || 0]: {
            verdict: payload.verdict === "reject" ? "reject" : "accept",
            reason: payload.reason || "",
          },
        },
      };
    case "chat":
      return { ...state, chat: { chatId: String(payload.chat_id ?? ""), text: payload.text ?? "" } };
    case "clear":
      return clearAssist(state, payload.target);
    default:
      return state;
  }
}

/** Drop one kind of suggestion, or everything for `all`. */
function clearAssist(state: AssistState, target: AssistClearTarget): AssistState {
  if (target === "all") return emptyAssist();
  const next: AssistState = { ...state, trades: { ...state.trades } };
  switch (target) {
    case "card":
      delete next.card;
      break;
    case "bench":
      delete next.bench;
      break;
    case "trade":
      next.trades = {};
      break;
    case "chat":
      delete next.chat;
      break;
  }
  return next;
}
