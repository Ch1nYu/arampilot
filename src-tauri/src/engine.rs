use crate::config::{ChampionProfileItem, ModeSettings};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TradeDecision {
    Accept {
        trade_id: i64,
        offer_champ_id: i32,
        my_champ_id: i32,
        diff: i32,
        reason: String,
    },
    Reject {
        trade_id: i64,
        offer_champ_id: i32,
        my_champ_id: i32,
        reason: String,
    },
    Skip {
        trade_id: Option<i64>,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BenchDecision {
    Swap {
        target_champ_id: i32,
        diff: i32,
        reason: String,
    },
    Skip {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardDecision {
    Select { champ_id: i32, reason: String },
    Skip { reason: String },
}

pub const UNRANKED_BASELINE_SCORE: i32 = 40;

/// Summoner spell id of Flash, always present in one of the two slots.
pub const FLASH_SPELL_ID: i32 = 4;

/// Secondary spells the assistant is allowed to bring (Ghost, Mark and the
/// other ARAM picks). Anything else falls back to Ghost.
pub const SECONDARY_SPELL_IDS: [i32; 8] = [6, 32, 13, 3, 14, 21, 7, 1];

/// Traditional Chinese display name for a supported summoner spell.
pub fn spell_name(spell_id: i32) -> &'static str {
    match spell_id {
        4 => "閃現",
        6 => "鬼步",
        32 => "雪球",
        13 => "清晰",
        3 => "虛弱",
        14 => "點燃",
        21 => "光盾",
        7 => "治癒",
        1 => "淨化",
        _ => "未知技能",
    }
}

/// Resolve the `(spell1Id, spell2Id, secondary_spell_id, is_custom)` to bring.
///
/// Layer 1: Flash (`4`) is the primary spell and sits on the key chosen by
/// `primary_spell_key` (`"D"` = `spell1Id`, `"F"` = `spell2Id`).
/// Layer 2: the secondary spell comes from the per-champion memory when that
/// champion has a valid `secondary_spell`, otherwise from the mode default.
pub fn resolve_summoner_spells(
    my_champ_id: i32,
    profile: &[ChampionProfileItem],
    settings: &ModeSettings,
    primary_spell_key: &str,
) -> (i32, i32, i32, bool) {
    let remembered = profile
        .iter()
        .find(|c| c.id == my_champ_id)
        .and_then(|c| c.secondary_spell)
        .filter(|id| SECONDARY_SPELL_IDS.contains(id));

    let (secondary_id, is_custom) = match remembered {
        Some(id) => (id, true),
        None => {
            let default_id = settings.default_secondary_spell;
            let id = if SECONDARY_SPELL_IDS.contains(&default_id) {
                default_id
            } else {
                6
            };
            (id, false)
        }
    };

    if primary_spell_key.eq_ignore_ascii_case("F") {
        (secondary_id, FLASH_SPELL_ID, secondary_id, is_custom)
    } else {
        (FLASH_SPELL_ID, secondary_id, secondary_id, is_custom)
    }
}

/// Calculate 0~100 scores for champions based on tier and relative order within tier
pub fn calculate_champion_scores(profile: &[ChampionProfileItem]) -> HashMap<i32, i32> {
    let mut scores = HashMap::new();
    let tiers: [(&str, i32, i32); 5] = [
        ("本命", 100, 90),
        ("愛角", 89, 75),
        ("順手", 74, 60),
        ("勉強", 59, 40),
        ("封印", 39, 10),
    ];

    for (tier_name, hi, lo) in tiers {
        let members: Vec<&ChampionProfileItem> =
            profile.iter().filter(|c| c.tier == tier_name).collect();
        let count = members.len();
        for (i, item) in members.iter().enumerate() {
            let score = if count <= 1 {
                hi
            } else {
                // Mirror the frontend's `Math.round(...)` so both sides agree exactly.
                (hi as f64 - (hi - lo) as f64 * (i as f64 / (count - 1) as f64)).round() as i32
            };
            scores.insert(item.id, score);
        }
    }

    scores
}

pub struct ChampSelectRuleEngine;

impl ChampSelectRuleEngine {
    /// Evaluate a trade request received from a teammate
    pub fn evaluate_trade(
        trade_id: i64,
        my_champ_id: i32,
        offer_champ_id: i32,
        profile: &[ChampionProfileItem],
        settings: &ModeSettings,
        is_friend_or_premade: bool,
    ) -> TradeDecision {
        if !settings.auto_trade {
            return TradeDecision::Skip {
                trade_id: Some(trade_id),
                reason: "自動換角開關未啟用".to_string(),
            };
        }

        let champ_map: HashMap<i32, &ChampionProfileItem> =
            profile.iter().map(|c| (c.id, c)).collect();
        let scores = calculate_champion_scores(profile);

        let my_item = champ_map.get(&my_champ_id);
        let offer_item = champ_map.get(&offer_champ_id);

        let my_name = my_item.map(|c| c.name.as_str()).unwrap_or("未知");
        let offer_name = offer_item.map(|c| c.name.as_str()).unwrap_or("未知");

        let my_flag = my_item.map(|c| c.flag.as_str()).unwrap_or("");
        let offer_flag = offer_item.map(|c| c.flag.as_str()).unwrap_or("");

        let my_tier = my_item.map(|c| c.tier.as_str()).unwrap_or("未分類");
        let offer_tier = offer_item.map(|c| c.tier.as_str()).unwrap_or("未分類");

        // 0. 組排 / 好友專屬換角分流
        if is_friend_or_premade {
            match settings.friend_trade_policy.as_str() {
                "auto_accept" => {
                    return TradeDecision::Accept {
                        trade_id,
                        offer_champ_id,
                        my_champ_id,
                        diff: 0,
                        reason: format!(
                            "🤝 組排/好友換角特權：自動同意讓出【{}】換取【{}】",
                            my_name, offer_name
                        ),
                    };
                }
                "manual" => {
                    return TradeDecision::Skip {
                        trade_id: Some(trade_id),
                        reason: format!(
                            "🤝 組排/好友發起換角（想用【{}】換你的【{}】），保留由你手動決定",
                            offer_name, my_name
                        ),
                    };
                }
                _ => {
                    // "same_as_stranger" -> fall through to standard rules
                }
            }
        }

        // 1. 個別標記判定
        if my_flag == "lock" {
            return TradeDecision::Reject {
                trade_id,
                offer_champ_id,
                my_champ_id,
                reason: format!("🔒 手上英雄【{}】標記為【不換出】", my_name),
            };
        }
        if offer_flag == "nograb" {
            return TradeDecision::Reject {
                trade_id,
                offer_champ_id,
                my_champ_id,
                reason: format!("⛔ 對方英雄【{}】標記為【不搶】", offer_name),
            };
        }
        if my_flag == "give" {
            return TradeDecision::Accept {
                trade_id,
                offer_champ_id,
                my_champ_id,
                diff: 0,
                reason: format!("🎁 手上英雄【{}】標記為【隨時可換】", my_name),
            };
        }

        let is_my_hold_protected = settings.trade_reject_tiers.iter().any(|t| t == my_tier);

        // 對方提供未分類英雄時：若我手上是保護階層直接拒絕，否則留給手動決定
        let offer_score = match scores.get(&offer_champ_id) {
            Some(&s) => s,
            None => {
                if is_my_hold_protected {
                    return TradeDecision::Reject {
                        trade_id,
                        offer_champ_id,
                        my_champ_id,
                        reason: format!(
                            "手上已是【{}】等級英雄【{}】，自動拒絕未分類英雄【{}】",
                            my_tier, my_name, offer_name
                        ),
                    };
                }
                return TradeDecision::Skip {
                    trade_id: Some(trade_id),
                    reason: format!("對方英雄【{}】未分類，保留手動決定", offer_name),
                };
            }
        };

        // 手上英雄若為未分類：以基準分 40 分計算（若對方拿封印/勉強則不自動換，保留手動）
        let my_score = match scores.get(&my_champ_id) {
            Some(&s) => s,
            None => {
                if offer_tier == "封印" || offer_tier == "勉強" {
                    return TradeDecision::Skip {
                        trade_id: Some(trade_id),
                        reason: format!(
                            "手上【{}】未分類，對方【{}】為{}，保留手動決定",
                            my_name, offer_name, offer_tier
                        ),
                    };
                }
                UNRANKED_BASELINE_SCORE
            }
        };
        let diff = offer_score - my_score;
        let reaches_accept_threshold = diff >= settings.trade_accept_diff;

        // 2. 規則衝突保護：手上有本命/保護層級，且對方給予更高分
        if is_my_hold_protected && reaches_accept_threshold {
            return TradeDecision::Skip {
                trade_id: Some(trade_id),
                reason: format!(
                    "⚠️ 規則衝突：對方【{}】(+{}分)達接受門檻，但手上為【{}】等級，保留手動決定！",
                    offer_name, diff, my_tier
                ),
            };
        }

        // 3. 達標自動接受
        if reaches_accept_threshold {
            return TradeDecision::Accept {
                trade_id,
                offer_champ_id,
                my_champ_id,
                diff,
                reason: format!(
                    "【{}】({}) − 【{}】({}) = +{} 分，達門檻 {} 分",
                    offer_name, offer_score, my_name, my_score, diff, settings.trade_accept_diff
                ),
            };
        }

        // 4. 手上為保護層級且未達高額門檻 -> 自動拒絕
        if is_my_hold_protected {
            return TradeDecision::Reject {
                trade_id,
                offer_champ_id,
                my_champ_id,
                reason: format!("手上已是【{}】等級英雄【{}】，自動拒絕", my_tier, my_name),
            };
        }

        // 5. 其餘條件外 -> 留給玩家手動決定
        TradeDecision::Skip {
            trade_id: Some(trade_id),
            reason: format!(
                "【{}】({}) − 【{}】({}) = {} 分，未達門檻 {} 分，條件外由手動決定",
                offer_name, offer_score, my_name, my_score, diff, settings.trade_accept_diff
            ),
        }
    }

    /// Evaluate bench champions to snipe
    pub fn evaluate_bench(
        my_champ_id: i32,
        bench_champ_ids: &[i32],
        profile: &[ChampionProfileItem],
        settings: &ModeSettings,
        remaining_sec: i32,
        manual_bench_hold: Option<i32>,
    ) -> BenchDecision {
        // If the player manually picked a champion, do not auto-swap away from it!
        if let Some(held_id) = manual_bench_hold
            && held_id == my_champ_id
        {
            return BenchDecision::Skip {
                reason: "玩家已手動選擇英雄，保留手動選擇".to_string(),
            };
        }

        if !settings.auto_bench_swap {
            return BenchDecision::Skip {
                reason: "自動搶板凳開關未啟用".to_string(),
            };
        }

        if remaining_sec <= settings.stop_bench_remaining_sec {
            return BenchDecision::Skip {
                reason: format!(
                    "選角倒數剩餘 {} 秒 (≤ 門檻 {} 秒)，停止搶角以利微調配置",
                    remaining_sec, settings.stop_bench_remaining_sec
                ),
            };
        }

        let champ_map: HashMap<i32, &ChampionProfileItem> =
            profile.iter().map(|c| (c.id, c)).collect();
        let scores = calculate_champion_scores(profile);

        let my_item = champ_map.get(&my_champ_id);
        let my_name = my_item.map(|c| c.name.as_str()).unwrap_or("未知");
        let my_flag = my_item.map(|c| c.flag.as_str()).unwrap_or("");
        let my_tier = my_item.map(|c| c.tier.as_str()).unwrap_or("未分類");

        if settings.lock_stop_bench && my_flag == "lock" {
            return BenchDecision::Skip {
                reason: format!("🔒 手上英雄【{}】已標記為【不換出】，停止搶板凳", my_name),
            };
        }

        let my_score = scores
            .get(&my_champ_id)
            .copied()
            .unwrap_or(UNRANKED_BASELINE_SCORE);

        // Find the best eligible champion on bench
        let mut best_target: Option<(i32, i32, &str)> = None;

        for &bid in bench_champ_ids {
            let b_item = match champ_map.get(&bid) {
                Some(it) => it,
                None => continue,
            };

            // ⛔ 未分類/封印 的板凳英雄不搶；手上為未分類時也不自動搶「勉強」角色
            if b_item.tier == "未分類"
                || b_item.tier == "封印"
                || (my_tier == "未分類" && b_item.tier == "勉強")
            {
                continue;
            }

            // ⛔ 標記為不搶的跳過
            if b_item.flag == "nograb" {
                continue;
            }

            if let Some(&b_score) = scores.get(&bid) {
                let diff = b_score - my_score;
                if diff >= settings.bench_diff_threshold {
                    if let Some((_, best_diff, _)) = best_target {
                        if diff > best_diff {
                            best_target = Some((bid, diff, b_item.name.as_str()));
                        }
                    } else {
                        best_target = Some((bid, diff, b_item.name.as_str()));
                    }
                }
            }
        }

        if let Some((target_id, diff, target_name)) = best_target {
            BenchDecision::Swap {
                target_champ_id: target_id,
                diff,
                reason: format!(
                    "🎯 板凳英雄【{}】分差 +{} 分達標 (門檻: {} 分)",
                    target_name, diff, settings.bench_diff_threshold
                ),
            }
        } else {
            BenchDecision::Skip {
                reason: "板凳上無分差達標之偏好英雄".to_string(),
            }
        }
    }

    /// Evaluate initial reveal cards (first 15 seconds)
    pub fn evaluate_cards(
        offered_card_ids: &[i32],
        profile: &[ChampionProfileItem],
        settings: &ModeSettings,
    ) -> CardDecision {
        if !settings.auto_card_select {
            return CardDecision::Skip {
                reason: "開局自動選卡未啟用".to_string(),
            };
        }

        if offered_card_ids.is_empty() {
            return CardDecision::Skip {
                reason: "無候選卡片".to_string(),
            };
        }

        // Guard against full-roster pickableChampionIds (~170 champs) being passed by mistake.
        if offered_card_ids.len() > 10 {
            return CardDecision::Skip {
                reason: format!(
                    "候選卡片數量異常 ({} 張)，略過自動選卡以避免誤選未抽中英雄",
                    offered_card_ids.len()
                ),
            };
        }

        let champ_map: HashMap<i32, &ChampionProfileItem> =
            profile.iter().map(|c| (c.id, c)).collect();
        let scores = calculate_champion_scores(profile);

        let mut best: Option<(i32, i32, &str, &str)> = None;

        for &cid in offered_card_ids {
            if let Some(item) = champ_map.get(&cid) {
                if item.flag == "nograb" {
                    continue;
                }
                // 未分類/封印 的英雄不主動選
                if item.tier == "未分類" || item.tier == "封印" {
                    continue;
                }
                let Some(&score) = scores.get(&cid) else {
                    continue;
                };

                if settings.card_select_strategy == "only_top_tiers"
                    && item.tier != "本命"
                    && item.tier != "愛角"
                {
                    continue;
                }

                if let Some((_, best_score, _, _)) = best {
                    if score > best_score {
                        best = Some((cid, score, item.name.as_str(), item.tier.as_str()));
                    }
                } else {
                    best = Some((cid, score, item.name.as_str(), item.tier.as_str()));
                }
            }
        }

        if let Some((best_id, score, name, tier)) = best {
            CardDecision::Select {
                champ_id: best_id,
                reason: format!("開局卡池挑選【{}】(階層: {}, 分數: {})", name, tier, score),
            }
        } else {
            CardDecision::Skip {
                reason: "候選卡片中無符合策略之英雄，保留由客戶端隨機".to_string(),
            }
        }
    }
}

/// State tracker for active champ select session
#[derive(Default)]
pub struct ChampSelectSessionTracker {
    pub local_cell_id: i64,
    pub my_champ_id: i32,
    pub processed_trade_ids: HashSet<i64>,
    pub last_bench_swap_time: Option<std::time::Instant>,
    pub bench_retry_target: Option<i32>,
    pub manual_bench_hold: Option<i32>, // Champion the player manually picked; never auto-swap away from it
    pub bot_expected_champ: Option<i32>, // Champion the bot is acquiring, to tell bot swaps from manual picks
    /// Champion an overview "搶角" click is chasing. Getting it (by WS event or
    /// HTTP reply, in either order) always ends in a manual hold, and auto bench
    /// stays out of the way while it is set.
    pub manual_snipe_target: Option<i32>,
    pub our_offer_cards: Vec<i32>,       // The 2~3 cards offered to us
    pub our_pick_time: Option<std::time::Instant>, // When our initial selection happened
    pub card_picked: bool,
    pub current_queue_id: Option<i32>, // 450 = ARAM, 2400 = Mayhem
    pub swap_confirmed_chat_pending: Option<(i32, i32)>, // (old_id, new_id)
    pub sent_trade_chat_pending: Option<(i32, i32)>, // (old_id, new_id) for trades we sent
    pub allied_puuids: HashSet<String>,
    pub allied_summoner_ids: HashSet<i64>,
    pub allies_loaded: bool,
    pub allies_fetch_attempts: u32, // Retry ally detection while the fetch returns empty (transient LCU hiccups)
    pub last_bench_skip_log_key: Option<String>, // Dedup key for bench skip logs (my_champ_id + reason)
    pub last_bench_skip_log_time: Option<std::time::Instant>, // Throttle for bench skip logs
    pub manual_snipe_generation: u64, // Bumped per manual snipe so stale retry loops exit
    pub last_bench_verdict: Option<String>, // Backend bench verdict shown on the overview card
    /// Champion the backend currently suggests swapping to from the bench.
    /// Assist mode only: the swap itself waits for a player click, and this field
    /// dedupes the suggestion so it is emitted once per target.
    pub bench_suggest_target: Option<i32>,
    pub last_trade_verdict: Option<String>, // Backend trade verdict shown on the overview card
    /// `(champ_id, spell1_id, spell2_id)` we already pushed to LCU this session.
    pub last_applied_spells: Option<(i32, i32, i32)>,
    /// The `(spell1_id, spell2_id)` first seen on the local player in this session (or last confirmed).
    pub initial_client_spells: Option<(i32, i32)>,
    /// The `(spell1_id, spell2_id)` most recently pushed by our bot.
    pub bot_set_spells: Option<(i32, i32)>,
    /// True once the player manually changes their summoner spells in the LoL client during this session.
    pub manual_spell_override: bool,
    /// The bot's previous spell pair: session snapshots queued before the
    /// latest PATCH landed still carry it, and must not read as a manual change.
    pub prev_bot_set_spells: Option<(i32, i32)>,
}

impl ChampSelectSessionTracker {
    pub fn reset(&mut self) {
        self.local_cell_id = 0;
        self.my_champ_id = 0;
        self.processed_trade_ids.clear();
        self.last_bench_swap_time = None;
        self.bench_retry_target = None;
        self.manual_bench_hold = None;
        self.bot_expected_champ = None;
        self.manual_snipe_target = None;
        self.our_offer_cards.clear();
        self.our_pick_time = None;
        self.card_picked = false;
        self.current_queue_id = None;
        self.swap_confirmed_chat_pending = None;
        self.sent_trade_chat_pending = None;
        self.allied_puuids.clear();
        self.allied_summoner_ids.clear();
        self.allies_loaded = false;
        self.allies_fetch_attempts = 0;
        self.last_bench_skip_log_key = None;
        self.last_bench_skip_log_time = None;
        // manual_snipe_generation stays monotonic: a loop from the previous
        // session must never match the generation of a new snipe.
        self.last_bench_verdict = None;
        self.bench_suggest_target = None;
        self.last_trade_verdict = None;
        self.last_applied_spells = None;
        self.initial_client_spells = None;
        self.bot_set_spells = None;
        self.manual_spell_override = false;
        self.prev_bot_set_spells = None;
    }

    /// Classify our champion changing from `old_champ_id` to `new_champ_id`.
    ///
    /// The WS event and the HTTP reply of a swap can arrive in either order, so
    /// the outcome only depends on what the tracker expected:
    /// - the overview snipe target (or the held champion) → manual hold;
    /// - what the bot was acquiring (auto bench / auto trade) → bot swap, no hold;
    /// - anything else → the player picked it themselves → manual hold.
    pub fn observe_champion_change(&mut self, old_champ_id: i32, new_champ_id: i32) {
        if old_champ_id == 0 || new_champ_id == 0 || new_champ_id == old_champ_id {
            return;
        }
        let manual_snipe_landed = self.manual_snipe_target == Some(new_champ_id)
            || self.manual_bench_hold == Some(new_champ_id);
        let bot_initiated = self.bot_expected_champ == Some(new_champ_id)
            || self.bench_retry_target == Some(new_champ_id);
        self.manual_bench_hold = if manual_snipe_landed || !bot_initiated {
            Some(new_champ_id)
        } else {
            None
        };
        self.manual_snipe_target = None;
        self.bench_retry_target = None;
        self.bot_expected_champ = None;
    }

    /// Remember a spell pair the bot just applied (keeping the previous one).
    pub fn record_bot_spells(&mut self, pair: (i32, i32)) {
        if self.bot_set_spells != Some(pair) {
            self.prev_bot_set_spells = self.bot_set_spells;
        }
        self.bot_set_spells = Some(pair);
        self.initial_client_spells = Some(pair);
    }

    /// Observe the local player's `(spell1Id, spell2Id)` from a champ-select snapshot.
    ///
    /// Returns `true` the first time a manual summoner spell change in the LoL client is detected
    /// (i.e. spells changed away from the initial snapshot and do not match `bot_set_spells`).
    pub fn observe_client_spells(&mut self, current_spells: Option<(i32, i32)>) -> bool {
        let Some((s1, s2)) = current_spells.filter(|&(a, b)| a > 0 && b > 0) else {
            return false;
        };
        let pair = (s1, s2);
        match self.initial_client_spells {
            None => {
                self.initial_client_spells = Some(pair);
                false
            }
            Some(prev) => {
                if pair == prev
                    || Some(pair) == self.bot_set_spells
                    || Some(pair) == self.prev_bot_set_spells
                {
                    self.initial_client_spells = Some(pair);
                    false
                } else {
                    self.initial_client_spells = Some(pair);
                    let newly = !self.manual_spell_override;
                    self.manual_spell_override = true;
                    newly
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stale_snapshot_with_previous_bot_spells_is_not_manual() {
        let mut tr = ChampSelectSessionTracker::default();
        tr.record_bot_spells((4, 6)); // champion A
        assert!(!tr.observe_client_spells(Some((4, 6))));
        tr.record_bot_spells((4, 14)); // bench swap to B, PATCH in flight
        // A queued event still shows A's pair.
        assert!(!tr.observe_client_spells(Some((4, 6))));
        assert!(!tr.manual_spell_override);
        assert!(!tr.observe_client_spells(Some((4, 14))));
        // A pair the bot never set is a real manual change.
        assert!(tr.observe_client_spells(Some((4, 7))));
        assert!(tr.manual_spell_override);
    }

    #[test]
    fn test_manual_snipe_hold_survives_ws_before_http_reply() {
        // Overview snipe for 7 while holding 1; the WS event lands first.
        let mut tr = ChampSelectSessionTracker {
            manual_snipe_target: Some(7),
            bench_retry_target: Some(7),
            bot_expected_champ: Some(7),
            ..Default::default()
        };
        tr.observe_champion_change(1, 7);
        assert_eq!(tr.manual_bench_hold, Some(7));
        assert_eq!(tr.manual_snipe_target, None);
        assert_eq!(tr.bench_retry_target, None);
    }

    #[test]
    fn test_manual_snipe_hold_survives_http_reply_before_ws() {
        // HTTP success already set the hold and cleared the expectations.
        let mut tr = ChampSelectSessionTracker {
            manual_bench_hold: Some(7),
            ..Default::default()
        };
        tr.observe_champion_change(1, 7);
        assert_eq!(tr.manual_bench_hold, Some(7));
    }

    #[test]
    fn test_bot_swap_and_auto_trade_do_not_set_a_manual_hold() {
        let mut tr = ChampSelectSessionTracker {
            bot_expected_champ: Some(9),
            ..Default::default()
        };
        tr.observe_champion_change(1, 9);
        assert_eq!(tr.manual_bench_hold, None);
        assert_eq!(tr.bot_expected_champ, None);
    }

    #[test]
    fn test_unexpected_change_is_a_manual_pick() {
        let mut tr = ChampSelectSessionTracker {
            bot_expected_champ: Some(9),
            manual_snipe_target: Some(5),
            ..Default::default()
        };
        tr.observe_champion_change(1, 3);
        assert_eq!(tr.manual_bench_hold, Some(3));
        assert_eq!(tr.manual_snipe_target, None, "a manual pick ends the overview snipe");
    }

    fn sample_profile() -> Vec<ChampionProfileItem> {
        vec![
            ChampionProfileItem {
                id: 103,
                name: "阿璃".to_string(),
                tier: "本命".to_string(),
                flag: "lock".to_string(), // 🔒 不換出
                ..Default::default()
            },
            ChampionProfileItem {
                id: 99,
                name: "拉克絲".to_string(),
                tier: "本命".to_string(),
                flag: "".to_string(),
                ..Default::default()
            },
            ChampionProfileItem {
                id: 81,
                name: "伊澤瑞爾".to_string(),
                tier: "愛角".to_string(),
                flag: "".to_string(),
                ..Default::default()
            },
            ChampionProfileItem {
                id: 267,
                name: "娜米".to_string(),
                tier: "順手".to_string(),
                flag: "give".to_string(), // 🎁 隨時可換
                ..Default::default()
            },
            ChampionProfileItem {
                id: 157,
                name: "犽宿".to_string(),
                tier: "封印".to_string(),
                flag: "nograb".to_string(), // ⛔ 不搶
                ..Default::default()
            },
        ]
    }

    #[test]
    fn test_lock_flag_rejects_trade() {
        let profile = sample_profile();
        let settings = ModeSettings::default();

        // 阿璃 has flag "lock"
        let dec = ChampSelectRuleEngine::evaluate_trade(1, 103, 81, &profile, &settings, false);
        match dec {
            TradeDecision::Reject { reason, .. } => {
                assert!(reason.contains("不換出"));
            }
            _ => panic!("Expected reject due to lock flag"),
        }
    }

    #[test]
    fn test_nograb_flag_rejects_trade() {
        let profile = sample_profile();
        let settings = ModeSettings::default();

        // 犽宿 has flag "nograb"
        let dec = ChampSelectRuleEngine::evaluate_trade(2, 81, 157, &profile, &settings, false);
        match dec {
            TradeDecision::Reject { reason, .. } => {
                assert!(reason.contains("不搶"));
            }
            _ => panic!("Expected reject due to nograb flag"),
        }
    }

    #[test]
    fn test_conflict_protection_when_holding_benming() {
        let profile = sample_profile();
        let settings = ModeSettings {
            trade_accept_diff: 5,
            trade_reject_tiers: vec!["本命".to_string()],
            ..ModeSettings::default()
        };

        let mut prof = profile.clone();
        prof.iter_mut().find(|c| c.id == 103).unwrap().flag = "".to_string();

        let dec = ChampSelectRuleEngine::evaluate_trade(3, 99, 103, &prof, &settings, false);
        match dec {
            TradeDecision::Skip { reason, .. } => {
                assert!(reason.contains("規則衝突"), "Reason was: {}", reason);
            }
            _ => panic!(
                "Expected skip due to rule conflict protection! Got: {:?}",
                dec
            ),
        }
    }

    #[test]
    fn test_accept_when_diff_exceeds_threshold() {
        let profile = sample_profile();
        let settings = ModeSettings::default(); // threshold is 10

        let mut prof = profile.clone();
        prof.iter_mut().find(|c| c.id == 267).unwrap().flag = "".to_string();

        let dec = ChampSelectRuleEngine::evaluate_trade(4, 267, 81, &prof, &settings, false);
        match dec {
            TradeDecision::Accept { diff, reason, .. } => {
                assert!(diff >= 10);
                assert!(reason.contains("達門檻"));
            }
            _ => panic!("Expected accept due to diff reaching threshold"),
        }
    }

    #[test]
    fn test_bench_evaluation() {
        let profile = sample_profile();
        let settings = ModeSettings::default();

        // My: 267 (娜米, 順手 ~74)
        // Bench has 81 (伊澤瑞爾, 愛角 ~89) -> diff +15 >= 10
        let dec =
            ChampSelectRuleEngine::evaluate_bench(267, &[81, 157], &profile, &settings, 30, None);
        match dec {
            BenchDecision::Swap {
                target_champ_id,
                diff,
                ..
            } => {
                assert_eq!(target_champ_id, 81);
                assert!(diff >= 10);
            }
            _ => panic!("Expected bench swap"),
        }

        // Test stopping when countdown is low
        let dec_low =
            ChampSelectRuleEngine::evaluate_bench(267, &[81], &profile, &settings, 4, None);
        match dec_low {
            BenchDecision::Skip { reason } => {
                assert!(reason.contains("停止搶角"));
            }
            _ => panic!("Expected skip due to low remaining seconds"),
        }
    }

    #[test]
    fn test_bench_respects_manual_pick() {
        let profile = sample_profile();
        let settings = ModeSettings::default();

        // The player manually picked 267 (娜米, 順手) and the bench holds 81 (伊澤瑞爾, 愛角, +15 diff).
        // The bot must NOT swap the player back to a different champion.
        let dec =
            ChampSelectRuleEngine::evaluate_bench(267, &[81], &profile, &settings, 30, Some(267));
        match dec {
            BenchDecision::Skip { reason } => {
                assert!(reason.contains("手動"), "Reason was: {}", reason);
            }
            other => panic!(
                "Expected skip when the player manually picked, got: {:?}",
                other
            ),
        }

        // Once the player picks something else, the hold no longer matches and the bot may act again.
        let dec_other =
            ChampSelectRuleEngine::evaluate_bench(267, &[81], &profile, &settings, 30, Some(99));
        match dec_other {
            BenchDecision::Swap {
                target_champ_id, ..
            } => {
                assert_eq!(target_champ_id, 81);
            }
            other => panic!(
                "Expected swap once the manual hold no longer matches, got: {:?}",
                other
            ),
        }
    }

    #[test]
    fn test_give_flag_accepts_even_with_negative_diff() {
        let profile = sample_profile();
        let settings = ModeSettings::default();

        let dec = ChampSelectRuleEngine::evaluate_trade(10, 267, 81, &profile, &settings, false);
        match dec {
            TradeDecision::Accept {
                trade_id, reason, ..
            } => {
                assert_eq!(trade_id, 10);
                assert!(reason.contains("隨時可換"));
            }
            _ => panic!("Expected accept due to give flag"),
        }

        let dec_nograb =
            ChampSelectRuleEngine::evaluate_trade(10, 267, 157, &profile, &settings, false);
        match dec_nograb {
            TradeDecision::Reject { reason, .. } => {
                assert!(reason.contains("不搶"));
            }
            _ => panic!("Expected reject because offered champion is marked nograb!"),
        }
    }

    #[test]
    fn test_trade_when_unranked_offered_or_held() {
        let mut profile = sample_profile();
        profile.iter_mut().find(|c| c.id == 267).unwrap().flag = "".to_string();
        profile.push(ChampionProfileItem {
            id: 999,
            name: "測試路人角".to_string(),
            tier: "未分類".to_string(),
            flag: "".to_string(),
            ..Default::default()
        });
        let settings = ModeSettings::default();

        // 1. Teammate offers an 未分類 champion while we hold 愛角 (not in reject_tiers=["本命"]) -> Skip
        let dec_offer_unranked =
            ChampSelectRuleEngine::evaluate_trade(11, 81, 999, &profile, &settings, false);
        match dec_offer_unranked {
            TradeDecision::Skip { reason, .. } => {
                assert!(reason.contains("未分類"));
            }
            _ => panic!("Expected skip when teammate offers unranked champion"),
        }

        // 2. Teammate offers an 未分類 champion while we hold 本命 (protected) -> Reject!
        let dec_protected =
            ChampSelectRuleEngine::evaluate_trade(12, 99, 999, &profile, &settings, false);
        match dec_protected {
            TradeDecision::Reject { reason, .. } => {
                assert!(reason.contains("自動拒絕"));
            }
            other => panic!(
                "Expected reject when holding 本命 and offered unranked, got {:?}",
                other
            ),
        }

        // 3. We hold an 未分類 road-random champion (baseline 40) and teammate offers 本命 (99) or 順手 (267) -> Accept!
        let dec_hold_unranked =
            ChampSelectRuleEngine::evaluate_trade(13, 999, 267, &profile, &settings, false);
        match dec_hold_unranked {
            TradeDecision::Accept { diff, .. } => {
                assert!(
                    diff >= 20,
                    "Expected diff >= 20 over baseline 40, got {}",
                    diff
                );
            }
            other => panic!(
                "Expected accept when holding 未分類 and teammate offers 順手, got {:?}",
                other
            ),
        }
    }

    #[test]
    fn test_friend_or_premade_trade_policies() {
        let profile = sample_profile();
        // Even though 99 is 本命 (which a stranger would be auto-rejected from), friend policy controls it:
        let auto_settings = ModeSettings {
            friend_trade_policy: "auto_accept".to_string(),
            ..ModeSettings::default()
        };
        let dec_auto =
            ChampSelectRuleEngine::evaluate_trade(20, 99, 267, &profile, &auto_settings, true);
        match dec_auto {
            TradeDecision::Accept { reason, .. } => {
                assert!(reason.contains("組排/好友"));
            }
            other => panic!("Expected friend auto_accept, got {:?}", other),
        }

        let manual_settings = ModeSettings {
            friend_trade_policy: "manual".to_string(),
            ..ModeSettings::default()
        };
        let dec_manual =
            ChampSelectRuleEngine::evaluate_trade(21, 99, 267, &profile, &manual_settings, true);
        match dec_manual {
            TradeDecision::Skip { reason, .. } => {
                assert!(reason.contains("組排/好友"));
            }
            other => panic!("Expected friend manual skip, got {:?}", other),
        }

        let stranger_settings = ModeSettings {
            friend_trade_policy: "same_as_stranger".to_string(),
            ..ModeSettings::default()
        };
        let dec_stranger =
            ChampSelectRuleEngine::evaluate_trade(22, 99, 267, &profile, &stranger_settings, true);
        match dec_stranger {
            TradeDecision::Reject { .. } => {}
            other => panic!("Expected stranger reject on 本命, got {:?}", other),
        }
    }

    #[test]
    fn test_trade_disabled_returns_skip() {
        let profile = sample_profile();
        let settings = ModeSettings {
            auto_trade: false,
            ..ModeSettings::default()
        };

        let dec = ChampSelectRuleEngine::evaluate_trade(12, 267, 81, &profile, &settings, false);
        match dec {
            TradeDecision::Skip { reason, .. } => {
                assert!(reason.contains("未啟用"));
            }
            _ => panic!("Expected skip when auto trade disabled"),
        }
    }

    #[test]
    fn test_bench_disabled_returns_skip() {
        let profile = sample_profile();
        let settings = ModeSettings {
            auto_bench_swap: false,
            ..ModeSettings::default()
        };

        let dec = ChampSelectRuleEngine::evaluate_bench(267, &[81], &profile, &settings, 30, None);
        match dec {
            BenchDecision::Skip { reason } => {
                assert!(reason.contains("未啟用"));
            }
            _ => panic!("Expected skip when auto bench swap disabled"),
        }
    }

    #[test]
    fn test_card_selection_highest_score() {
        let profile = sample_profile();
        let settings = ModeSettings::default(); // card_select_strategy = "highest_score"

        // Cards: 267 (娜米, 順手 ~74), 81 (伊澤瑞爾, 愛角 ~89), 157 (犽宿, 封印, nograb)
        let dec = ChampSelectRuleEngine::evaluate_cards(&[267, 81, 157], &profile, &settings);
        match dec {
            CardDecision::Select { champ_id, reason } => {
                assert_eq!(champ_id, 81);
                assert!(reason.contains("伊澤瑞爾"));
            }
            _ => panic!("Expected highest score card 81 to be selected"),
        }
    }

    #[test]
    fn test_card_selection_only_top_tiers_skips_lower() {
        let profile = sample_profile();
        let settings = ModeSettings {
            card_select_strategy: "only_top_tiers".to_string(),
            ..ModeSettings::default()
        };

        // Cards only contain 267 (娜米, 順手) and 157 (犽宿, 封印)
        // Neither is 本命 or 愛角!
        let dec = ChampSelectRuleEngine::evaluate_cards(&[267, 157], &profile, &settings);
        match dec {
            CardDecision::Skip { reason } => {
                assert!(reason.contains("無符合策略"));
            }
            _ => panic!("Expected skip when no top tier cards available"),
        }
    }

    #[test]
    fn test_resolve_summoner_spells_primary_key_habit() {
        let profile: Vec<ChampionProfileItem> = Vec::new();
        let settings = ModeSettings::default(); // default_secondary_spell = 6 (Ghost)

        // D is the primary key: Flash on spell1, secondary on spell2.
        assert_eq!(
            resolve_summoner_spells(103, &profile, &settings, "D"),
            (4, 6, 6, false)
        );
        // F is the primary key: secondary on spell1, Flash on spell2.
        assert_eq!(
            resolve_summoner_spells(103, &profile, &settings, "F"),
            (6, 4, 6, false)
        );
        // Lowercase input is tolerated.
        assert_eq!(
            resolve_summoner_spells(103, &profile, &settings, "f"),
            (6, 4, 6, false)
        );
    }

    #[test]
    fn test_resolve_summoner_spells_mode_default_vs_champion_memory() {
        let mut profile = sample_profile();
        let settings = ModeSettings {
            default_secondary_spell: 32, // Mark / 雪球
            ..ModeSettings::default()
        };

        // No memory for 娜米: the mode default applies and is not custom.
        assert_eq!(
            resolve_summoner_spells(267, &profile, &settings, "D"),
            (4, 32, 32, false)
        );

        // A per-champion memory overrides the mode default.
        profile
            .iter_mut()
            .find(|c| c.id == 267)
            .unwrap()
            .secondary_spell = Some(14); // 點燃
        assert_eq!(
            resolve_summoner_spells(267, &profile, &settings, "D"),
            (4, 14, 14, true)
        );
        assert_eq!(
            resolve_summoner_spells(267, &profile, &settings, "F"),
            (14, 4, 14, true)
        );

        // A champion outside the profile keeps using the mode default.
        assert_eq!(
            resolve_summoner_spells(999, &profile, &settings, "D"),
            (4, 32, 32, false)
        );
    }

    #[test]
    fn test_resolve_summoner_spells_invalid_values_fall_back_to_ghost() {
        let mut profile = sample_profile();
        let settings = ModeSettings {
            default_secondary_spell: 999, // not a supported spell
            ..ModeSettings::default()
        };
        assert_eq!(
            resolve_summoner_spells(103, &profile, &settings, "D"),
            (4, 6, 6, false),
            "an unsupported mode default must fall back to Ghost"
        );

        profile
            .iter_mut()
            .find(|c| c.id == 103)
            .unwrap()
            .secondary_spell = Some(4); // Flash is not a valid secondary
        assert_eq!(
            resolve_summoner_spells(103, &profile, &settings, "D"),
            (4, 6, 6, false),
            "an unsupported per-champion memory must be ignored"
        );
    }

    #[test]
    fn test_spell_names_cover_every_supported_id() {
        assert_eq!(spell_name(4), "閃現");
        assert_eq!(spell_name(6), "鬼步");
        assert_eq!(spell_name(32), "雪球");
        assert_eq!(spell_name(13), "清晰");
        assert_eq!(spell_name(3), "虛弱");
        assert_eq!(spell_name(14), "點燃");
        assert_eq!(spell_name(21), "光盾");
        assert_eq!(spell_name(7), "治癒");
        assert_eq!(spell_name(1), "淨化");
        for id in SECONDARY_SPELL_IDS {
            assert_ne!(spell_name(id), "未知技能");
        }
    }

    #[test]
    fn test_session_tracker_reset() {
        let mut tracker = ChampSelectSessionTracker {
            local_cell_id: 3,
            my_champ_id: 81,
            processed_trade_ids: HashSet::from([100]),
            card_picked: true,
            current_queue_id: Some(2400),
            sent_trade_chat_pending: Some((81, 99)),
            last_applied_spells: Some((81, 4, 6)),
            ..ChampSelectSessionTracker::default()
        };

        tracker.reset();

        assert_eq!(tracker.local_cell_id, 0);
        assert_eq!(tracker.my_champ_id, 0);
        assert!(tracker.processed_trade_ids.is_empty());
        assert!(!tracker.card_picked);
        assert_eq!(tracker.current_queue_id, None);
        assert_eq!(tracker.sent_trade_chat_pending, None);
        assert_eq!(tracker.last_applied_spells, None);
        assert!(!tracker.manual_spell_override);
    }

    #[test]
    fn test_observe_client_spells_detects_manual_spell_change() {
        let mut tracker = ChampSelectSessionTracker::default();
        // 1. Initial snapshot in ChampSelect: D=4 (Flash), F=32 (Mark) -> not a manual change
        assert!(!tracker.observe_client_spells(Some((4, 32))));
        assert!(!tracker.manual_spell_override);

        // 2. Bot applies D=4, F=6 (Ghost) -> matches bot_set_spells -> not a manual change
        tracker.bot_set_spells = Some((4, 6));
        assert!(!tracker.observe_client_spells(Some((4, 6))));
        assert!(!tracker.manual_spell_override);

        // 3. Player manually changes F to 14 (Ignite) in the LoL client -> detected!
        assert!(tracker.observe_client_spells(Some((4, 14))));
        assert!(tracker.manual_spell_override);

        // 4. Subsequent snapshots with (4, 14) do not re-trigger the log flag, but override stays true
        assert!(!tracker.observe_client_spells(Some((4, 14))));
        assert!(tracker.manual_spell_override);
    }

    #[test]
    fn test_calculate_champion_scores_matches_frontend_rounding() {
        let profile: Vec<ChampionProfileItem> = [101, 102, 103, 104]
            .iter()
            .map(|&id| ChampionProfileItem {
                id,
                name: format!("英雄{}", id),
                tier: "本命".to_string(),
                flag: "".to_string(),
                ..Default::default()
            })
            .collect();

        let scores = calculate_champion_scores(&profile);

        // 100 - (100-90) * i/3 rounded -> 100, 97, 93, 90 (Math.round parity)
        assert_eq!(scores.get(&101), Some(&100));
        assert_eq!(scores.get(&102), Some(&97));
        assert_eq!(scores.get(&103), Some(&93));
        assert_eq!(scores.get(&104), Some(&90));
    }

    #[test]
    fn test_cards_skip_when_all_offered_are_sealed_or_unranked() {
        let mut profile = sample_profile();
        // 157 is 封印 in sample_profile; add an 未分類 champion as well.
        profile.push(ChampionProfileItem {
            id: 999,
            name: "測試角".to_string(),
            tier: "未分類".to_string(),
            flag: "".to_string(),
            ..Default::default()
        });
        let settings = ModeSettings {
            card_select_strategy: "highest_score".to_string(),
            ..ModeSettings::default()
        };

        let dec = ChampSelectRuleEngine::evaluate_cards(&[157, 999], &profile, &settings);
        match dec {
            CardDecision::Skip { reason } => {
                assert!(reason.contains("無符合策略"), "Reason was: {}", reason);
            }
            _ => panic!("Expected skip when every offered card is 封印/未分類"),
        }
    }

    #[test]
    fn test_bench_does_not_swap_unranked_holder_for_sealed_or_weak() {
        let mut profile = sample_profile();
        // Player holds an 未分類 champion -> treated as score 60 (lower bound of 順手).
        profile.push(ChampionProfileItem {
            id: 999,
            name: "測試角".to_string(),
            tier: "未分類".to_string(),
            flag: "".to_string(),
            ..Default::default()
        });
        // A 勉強 champion (40~59) must never be sniped from an unranked holder.
        profile.push(ChampionProfileItem {
            id: 555,
            name: "勉強角".to_string(),
            tier: "勉強".to_string(),
            flag: "".to_string(),
            ..Default::default()
        });
        let settings = ModeSettings::default(); // bench_diff_threshold = 10

        let dec =
            ChampSelectRuleEngine::evaluate_bench(999, &[555, 157], &profile, &settings, 30, None);
        match dec {
            BenchDecision::Skip { .. } => {}
            other => panic!("Expected skip for 封印/勉強 bench, got: {:?}", other),
        }

        // Sanity check: both 愛角 AND 順手 (even the lowest 順手 at 60) get sniped when holding 未分類 (baseline 40)!
        profile.push(ChampionProfileItem {
            id: 54,
            name: "墨菲特".to_string(),
            tier: "順手".to_string(),
            flag: "".to_string(),
            ..Default::default()
        });
        let dec_shunshou =
            ChampSelectRuleEngine::evaluate_bench(999, &[54], &profile, &settings, 30, None);
        match dec_shunshou {
            BenchDecision::Swap {
                target_champ_id,
                diff,
                ..
            } => {
                assert_eq!(target_champ_id, 54);
                assert_eq!(diff, 60 - UNRANKED_BASELINE_SCORE);
            }
            other => panic!(
                "Expected swap for 順手 (score 60) when holding 未分類, got: {:?}",
                other
            ),
        }
    }

    #[test]
    fn test_cards_reject_full_roster_pickable_champion_ids() {
        let profile = sample_profile();
        let settings = ModeSettings::default();
        let full_roster: Vec<i32> = (1..=170).collect();

        let dec = ChampSelectRuleEngine::evaluate_cards(&full_roster, &profile, &settings);
        match dec {
            CardDecision::Skip { reason } => {
                assert!(reason.contains("數量異常"));
            }
            other => panic!("Expected skip when >10 cards are passed, got {:?}", other),
        }
    }
}
