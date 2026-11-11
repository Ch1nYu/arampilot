export interface ChampionItem {
  id: number;
  name: string;
  title?: string;
  roles?: string[];
}

export interface ChampionMasteryItem {
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number;
}

export interface ConnectionStatus {
  connected: boolean;
  port?: number;
}

export interface ActiveAccount {
  puuid: string;
  display_name: string;
}

export interface LcuEvent {
  uri: string;
  eventType: string;
  data: any;
}

/** Backend-owned champ select state (verdicts are never recomputed here). */
export interface ChampSelectUiState {
  manual_hold_champ_id: number | null;
  bench_retry_target: number | null;
  bench_verdict: string | null;
  trade_verdict: string | null;
  allied_puuids: string[];
  allied_summoner_ids: number[];
}

export interface TierChampion {
  id: number;
  n: string;
  t: string; // "本命", "愛角", "順手", "勉強", "封印", "未分類"
  f: string; // "", "lock", "give", "nograb"
  secSpell?: number; // remembered secondary summoner spell id
}

export interface ModeSettings {
  auto_card_select: boolean;
  card_select_delay_sec: number;
  card_select_strategy: string;
  auto_card_execute: boolean;
  auto_bench_swap: boolean;
  auto_bench_execute: boolean;
  bench_diff_threshold: number;
  lock_stop_bench: boolean;
  stop_bench_remaining_sec: number;
  auto_trade: boolean;
  trade_accept_diff: number;
  trade_reject_tiers: string[];
  friend_trade_policy: string;
  default_secondary_spell: number;
}

export interface ProfileItemConfig {
  id: number;
  name: string;
  tier: string;
  flag: string;
  elo?: number;
  matches?: number;
  secondary_spell?: number;
}

export interface AppConfig {
  master_enabled: boolean;
  accent_color: string;
  ui_scale?: number;
  auto_summoner_spells: boolean;
  remember_champion_spells?: boolean;
  primary_spell_key: string; // "D" | "F"
  auto_accept: boolean;
  accept_delay_sec: number;
  accept_modes: string[];
  accept_notify: string; // "mute", "sound", "notification"
  aram_settings: ModeSettings;
  mayhem_settings: ModeSettings;
  auto_chat_on_swap: boolean;
  chat_delay_sec: number;
  chat_messages: string[];
  chat_on_accept_teammate: boolean;
  chat_on_teammate_accept_mine: boolean;
  ff_reminder: boolean;
  ff_time_aram: string;
  ff_time_mayhem: string;
  ff_kill_diff_threshold: number;
  ff_cooldown_reminder: boolean;
  ff_copy_clipboard: boolean;
  ff_play_sound: boolean;
  ff_desktop_notify: boolean;
  ff_lead_sec: number;
  bench_retry_interval_ms: number;
  manual_snipe_interval_ms: number;
  client_close_action: string; // "wait", "exit"
  close_to_tray: boolean;
  auto_start: boolean;
  aram_profile: ProfileItemConfig[];
  mayhem_profile: ProfileItemConfig[];
  ranking_saves: RankingSaveConfig[];
  active_ranking_save: string;
}

/** One named ranking save as the config file stores it (active save: `items` empty). */
export interface RankingSaveConfig {
  id: string;
  name: string;
  items: ProfileItemConfig[];
}
