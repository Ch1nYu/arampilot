//! Match history: one record per game, built from the execution log.
//!
//! Pure data and functions. The caller in `lib.rs` opens a record when champ
//! select starts, forwards every execution-log line of that game, and closes
//! the record when the game ends. Win/loss and the ids champ select never saw
//! are filled in afterwards from the LoL client's match-history JSON. Nothing
//! here touches Tauri, the network or globals; the JSONL helpers at the bottom
//! are driven explicitly by the caller.

use serde::{Deserialize, Serialize};
use std::io::Write;

/// How many records `match-history.jsonl` keeps.
pub const KEEP_RECORDS: usize = 200;
/// How many execution-log lines one record keeps.
pub const MAX_LOG_LINES: usize = 300;

/// One `exec-log.jsonl` line, kept as-is for the per-game detail view.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LogLine {
    pub date: String,
    pub time: String,
    pub kind: String,
    pub title: String,
    pub reason: String,
}

/// How the game ended, as far as the app can tell.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MatchResult {
    Win,
    Loss,
    /// Champ select ended without the game starting (dodge, no pick).
    NotPlayed,
    /// The game started but no match history was found for it yet.
    Unknown,
}

/// One collected game.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchRecord {
    pub game_id: Option<i64>,
    /// Champ select start, `YYYY-MM-DD`.
    pub date: String,
    /// Champ select start, `HH:MM:SS`.
    pub time: String,
    pub queue_id: Option<i32>,
    pub champion_id: Option<i64>,
    pub result: MatchResult,
    pub actions: Vec<String>,
    pub log: Vec<LogLine>,
    /// Per-game detail from `GET /lol-match-history/v1/games/{gameId}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<GameDetail>,
}

/// One augment of the augment lookup table, as the LCU names it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AugmentInfo {
    pub name: String,
    /// `silver`, `gold`, `prismatic` or empty when unknown.
    pub rarity: String,
}

/// One augment a player picked in a game, named from the lookup table.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AugmentPick {
    pub id: i64,
    pub name: String,
    pub rarity: String,
}

/// One participant of a game, flattened for the detail view.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStats {
    pub team_id: i64,
    pub win: bool,
    pub is_me: bool,
    /// `gameName#tagLine`.
    pub name: String,
    pub champion_id: i64,
    /// `stats.champLevel`.
    pub level: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    /// `stats.totalDamageDealtToChampions`.
    pub damage_to_champions: i64,
    /// `stats.totalDamageTaken`.
    pub damage_taken: i64,
    /// `stats.totalHeal`.
    pub healing: i64,
    /// `stats.timeCCingOthers`, in seconds.
    #[serde(default)]
    pub cc_sec: i64,
    /// `stats.goldEarned`.
    pub gold: i64,
    /// `stats.item0..item6` in order, zeros dropped.
    pub items: Vec<i64>,
    /// `stats.playerAugment1..6` in order, zeros dropped.
    pub augments: Vec<AugmentPick>,
    /// `spell1Id`, `spell2Id`.
    pub spells: Vec<i64>,
}

/// Bumped when [`GameDetail`] gains fields, so records parsed before are re-fetched
/// while the client still lists the game. 2: `ccSec`.
pub const DETAIL_VERSION: u32 = 2;

/// Everything the detail view needs from one game.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameDetail {
    /// [`DETAIL_VERSION`] when parsed; older records (0) are fetched again.
    #[serde(default)]
    pub version: u32,
    /// Top-level `gameDuration`, in seconds.
    pub duration_sec: i64,
    /// Payload order (the LCU lists team 100 first, then team 200).
    pub players: Vec<PlayerStats>,
}

/// Collects the open record of one game at a time.
#[derive(Default)]
pub struct MatchCollector {
    current: Option<MatchRecord>,
    /// `mark_game_started` was called for the open record.
    played: bool,
}

impl MatchCollector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opens a record. If one is already open, it is finished first and returned.
    pub fn start(&mut self, date: &str, time: &str, queue_id: Option<i32>) -> Option<MatchRecord> {
        let previous = self.finish();
        self.current = Some(MatchRecord {
            game_id: None,
            date: date.to_string(),
            time: time.to_string(),
            queue_id,
            champion_id: None,
            result: MatchResult::Unknown, // decided in `finish`
            actions: Vec::new(),
            log: Vec::new(),
            detail: None,
        });
        self.played = false;
        previous
    }

    pub fn is_open(&self) -> bool {
        self.current.is_some()
    }

    /// Appends to the open record; no-op when none is open; keeps only the
    /// first [`MAX_LOG_LINES`] lines.
    pub fn record_log(&mut self, line: LogLine) {
        if let Some(record) = self.current.as_mut()
            && record.log.len() < MAX_LOG_LINES
        {
            record.log.push(line);
        }
    }

    /// The game really started (GameStart / InProgress). Sets `game_id` when
    /// `Some`; a later `Some` overwrites, `None` keeps what is there.
    pub fn mark_game_started(&mut self, game_id: Option<i64>) {
        if let Some(record) = self.current.as_mut() {
            self.played = true;
            if game_id.is_some() {
                record.game_id = game_id;
            }
        }
    }

    /// Ignores 0 and negative ids; a later valid id overwrites.
    pub fn set_champion(&mut self, champion_id: i64) {
        if champion_id <= 0 {
            return;
        }
        if let Some(record) = self.current.as_mut() {
            record.champion_id = Some(champion_id);
        }
    }

    /// Closes and returns the open record: `Unknown` if `mark_game_started` was
    /// called, else `NotPlayed`; actions come from the log. `None` when nothing
    /// is open.
    pub fn finish(&mut self) -> Option<MatchRecord> {
        let mut record = self.current.take()?;
        record.result = if self.played {
            MatchResult::Unknown
        } else {
            MatchResult::NotPlayed
        };
        record.actions = action_tags(&record.log);
        self.played = false;
        Some(record)
    }
}

/// Ordered, de-duplicated short tags for what the app did in champ select.
///
/// Only `kind == "act"` lines count, matched on the exact title. Unknown titles
/// are ignored, and the output order is fixed no matter the log order.
pub fn action_tags(log: &[LogLine]) -> Vec<String> {
    const TAGS: [&str; 4] = ["搶到板凳", "換角", "選卡", "帶技能"];
    let mut seen = [false; TAGS.len()];
    for line in log.iter().filter(|line| line.kind == "act") {
        let index = match line.title.as_str() {
            "已自動換成板凳英雄" | "已從板凳秒換偏好英雄" | "已手動搶下板凳英雄" => {
                0
            }
            "已手動同意隊友換角" => 1,
            "已自動選擇開局英雄卡" | "已選擇開局英雄卡" => 2,
            "已自動帶上召喚師技能" => 3,
            _ => continue,
        };
        seen[index] = true;
    }
    TAGS.iter()
        .zip(seen)
        .filter(|(_, hit)| *hit)
        .map(|(tag, _)| (*tag).to_string())
        .collect()
}

/// Fills win/loss, `champion_id` and `queue_id` from the LCU match-history
/// payload (`GET /lol-match-history/v1/products/lol/current-summoner/matches`).
///
/// Only records that are still `Unknown`, carry a `game_id` and match a game
/// are touched; ids already known are kept. Malformed JSON changes nothing.
/// Returns true when any record changed.
pub fn apply_match_history(records: &mut [MatchRecord], games: &serde_json::Value) -> bool {
    let Some(games) = games
        .get("games")
        .and_then(|games| games.get("games"))
        .and_then(|games| games.as_array())
    else {
        return false;
    };
    let mut changed = false;
    for record in records.iter_mut() {
        if record.result != MatchResult::Unknown {
            continue;
        }
        let Some(game_id) = record.game_id else {
            continue;
        };
        let Some(game) = games
            .iter()
            .find(|game| game.get("gameId").and_then(|id| id.as_i64()) == Some(game_id))
        else {
            continue;
        };
        let participant = game
            .get("participants")
            .and_then(|participants| participants.as_array())
            .and_then(|participants| participants.first());
        let Some(win) = participant
            .and_then(|participant| participant.get("stats"))
            .and_then(|stats| stats.get("win"))
            .and_then(|win| win.as_bool())
        else {
            continue;
        };
        record.result = if win {
            MatchResult::Win
        } else {
            MatchResult::Loss
        };
        if record.champion_id.is_none() {
            record.champion_id = participant
                .and_then(|participant| participant.get("championId"))
                .and_then(|id| id.as_i64());
        }
        if record.queue_id.is_none() {
            record.queue_id = game
                .get("queueId")
                .and_then(|id| id.as_i64())
                .map(|id| id as i32);
        }
        changed = true;
    }
    changed
}

/// Game ids of the client's recent match-history payload, read from the same
/// JSON path as [`apply_match_history`]. Malformed payloads list no games.
pub fn listed_game_ids(list: &serde_json::Value) -> std::collections::HashSet<i64> {
    let games = list
        .get("games")
        .and_then(|games| games.get("games"))
        .and_then(|games| games.as_array());
    games
        .map(|games| {
            games
                .iter()
                .filter_map(|game| game.get("gameId").and_then(|id| id.as_i64()))
                .collect()
        })
        .unwrap_or_default()
}

/// Reads a number field, `0` when it is missing or not a number.
fn int_at(value: Option<&serde_json::Value>, key: &str) -> i64 {
    value
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
}

/// The display name of an identity: `gameName#tagLine`, `gameName` when there
/// is no tag line, `summonerName` when there is no game name, else empty.
fn player_name(player: Option<&serde_json::Value>) -> String {
    let text = |key: &str| {
        player
            .and_then(|player| player.get(key))
            .and_then(|value| value.as_str())
            .unwrap_or("")
    };
    let game_name = text("gameName");
    let tag_line = text("tagLine");
    match (game_name.is_empty(), tag_line.is_empty()) {
        (false, false) => format!("{game_name}#{tag_line}"),
        (false, true) => game_name.to_string(),
        (true, _) => text("summonerName").to_string(),
    }
}

/// Parses one game of `GET /lol-match-history/v1/games/{gameId}` into the
/// per-game detail view.
///
/// `participants[]` is joined to `participantIdentities[]` on `participantId`
/// and keeps the payload order. `is_me` marks the identity whose `puuid` is
/// `my_puuid` (never when `my_puuid` is empty). Missing numbers read as `0`,
/// a missing `stats.win` as `false`. Returns `None` when `game` is not an
/// object or `participants` is missing, not an array or empty.
pub fn parse_game_detail(
    game: &serde_json::Value,
    my_puuid: &str,
    augments: &std::collections::HashMap<i64, AugmentInfo>,
) -> Option<GameDetail> {
    if !game.is_object() {
        return None;
    }
    let participants = game.get("participants")?.as_array()?;
    if participants.is_empty() {
        return None;
    }
    let identities: std::collections::HashMap<i64, &serde_json::Value> = game
        .get("participantIdentities")
        .and_then(|identities| identities.as_array())
        .map(|identities| {
            identities
                .iter()
                .filter_map(|identity| {
                    let id = identity.get("participantId")?.as_i64()?;
                    Some((id, identity.get("player")?))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut players = Vec::with_capacity(participants.len());
    for participant in participants {
        let stats = participant.get("stats");
        let player = participant
            .get("participantId")
            .and_then(|id| id.as_i64())
            .and_then(|id| identities.get(&id))
            .copied();
        let puuid = player
            .and_then(|player| player.get("puuid"))
            .and_then(|puuid| puuid.as_str())
            .unwrap_or("");
        players.push(PlayerStats {
            team_id: int_at(Some(participant), "teamId"),
            win: stats
                .and_then(|stats| stats.get("win"))
                .and_then(|win| win.as_bool())
                .unwrap_or(false),
            is_me: !my_puuid.is_empty() && puuid == my_puuid,
            name: player_name(player),
            champion_id: int_at(Some(participant), "championId"),
            level: int_at(stats, "champLevel"),
            kills: int_at(stats, "kills"),
            deaths: int_at(stats, "deaths"),
            assists: int_at(stats, "assists"),
            damage_to_champions: int_at(stats, "totalDamageDealtToChampions"),
            damage_taken: int_at(stats, "totalDamageTaken"),
            healing: int_at(stats, "totalHeal"),
            cc_sec: int_at(stats, "timeCCingOthers"),
            gold: int_at(stats, "goldEarned"),
            items: (0..=6)
                .map(|slot| int_at(stats, &format!("item{slot}")))
                .filter(|id| *id != 0)
                .collect(),
            augments: (1..=6)
                .map(|slot| int_at(stats, &format!("playerAugment{slot}")))
                .filter(|id| *id != 0)
                .map(|id| {
                    let info = augments.get(&id);
                    AugmentPick {
                        id,
                        name: info.map(|info| info.name.clone()).unwrap_or_default(),
                        rarity: info.map(|info| info.rarity.clone()).unwrap_or_default(),
                    }
                })
                .collect(),
            spells: vec![
                int_at(Some(participant), "spell1Id"),
                int_at(Some(participant), "spell2Id"),
            ],
        });
    }
    Some(GameDetail {
        version: DETAIL_VERSION,
        duration_sec: int_at(Some(game), "gameDuration"),
        players,
    })
}

/// Appends the non-zero ids of `prefix` + `slots` in `stats` to `out`, skipping
/// ids already there.
fn push_slot_ids(
    stats: &serde_json::Value,
    prefix: &str,
    slots: std::ops::RangeInclusive<usize>,
    out: &mut Vec<i64>,
) {
    for slot in slots {
        let id = int_at(Some(stats), &format!("{prefix}{slot}"));
        if id != 0 && !out.contains(&id) {
            out.push(id);
        }
    }
}

/// The non-zero augment and item ids of every participant of one game, so the
/// caller can look their names up in one go.
///
/// Both lists are de-duplicated and keep payload order. A game without
/// `participants` yields two empty lists.
pub fn picked_ids(game: &serde_json::Value) -> (Vec<i64>, Vec<i64>) {
    let mut augments = Vec::new();
    let mut items = Vec::new();
    let participants = game
        .get("participants")
        .and_then(|participants| participants.as_array());
    for stats in participants
        .into_iter()
        .flatten()
        .filter_map(|participant| participant.get("stats"))
    {
        push_slot_ids(stats, "playerAugment", 1..=6, &mut augments);
        push_slot_ids(stats, "item", 0..=6, &mut items);
    }
    (augments, items)
}

/// Stores the detail on the record and takes champion and win/loss from the
/// player that is me. A `NotPlayed` record keeps its result; without a player
/// that is me only `detail` changes.
pub fn apply_game_detail(record: &mut MatchRecord, detail: GameDetail) {
    if let Some(me) = detail.players.iter().find(|player| player.is_me) {
        record.champion_id = Some(me.champion_id);
        if record.result != MatchResult::NotPlayed {
            record.result = if me.win {
                MatchResult::Win
            } else {
                MatchResult::Loss
            };
        }
    }
    record.detail = Some(detail);
}

/// Whether the record still needs its per-game detail fetched.
pub fn needs_detail(record: &MatchRecord) -> bool {
    record.game_id.is_some()
        && record.detail.as_ref().is_none_or(|detail| detail.version < DETAIL_VERSION)
        && record.result != MatchResult::NotPlayed
}

/// Stores each detail on the record with that `game_id` that still needs one;
/// a record of another game, a `NotPlayed` one and an already detailed one are
/// left alone. Returns true when any record changed.
pub fn apply_details(records: &mut [MatchRecord], details: Vec<(i64, GameDetail)>) -> bool {
    let mut changed = false;
    for (game_id, detail) in details {
        let Some(record) = records
            .iter_mut()
            .find(|record| record.game_id == Some(game_id) && needs_detail(record))
        else {
            continue;
        };
        apply_game_detail(record, detail);
        changed = true;
    }
    changed
}

/// Missing file -> empty vec; lines that fail to parse are skipped. Oldest
/// first (file order).
pub fn read_records(path: &std::path::Path) -> Vec<MatchRecord> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Rewrites the whole file (creating parent dirs), one JSON object per line,
/// keeping only the last `keep` records.
pub fn write_records(
    path: &std::path::Path,
    records: &[MatchRecord],
    keep: usize,
) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let kept = &records[records.len().saturating_sub(keep)..];
    let mut text = String::new();
    for record in kept {
        let line = serde_json::to_string(record).map_err(std::io::Error::other)?;
        text.push_str(&line);
        text.push('\n');
    }
    std::fs::write(path, text)
}

/// Appends one record; if the file then holds more than `keep` records, it is
/// rewritten with the last `keep`.
pub fn append_record(
    path: &std::path::Path,
    record: &MatchRecord,
    keep: usize,
) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let line = serde_json::to_string(record).map_err(std::io::Error::other)?;
    {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
    }
    let records = read_records(path);
    if records.len() > keep {
        write_records(path, &records, keep)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(kind: &str, title: &str) -> LogLine {
        LogLine {
            date: "2026-11-25".to_string(),
            time: "20:31:05".to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            reason: String::new(),
        }
    }

    fn sample_record(game_id: Option<i64>, result: MatchResult) -> MatchRecord {
        MatchRecord {
            game_id,
            date: "2026-11-25".to_string(),
            time: "20:31:05".to_string(),
            queue_id: Some(2400),
            champion_id: None,
            result,
            actions: Vec::new(),
            log: Vec::new(),
            detail: None,
        }
    }

    /// Unique scratch dir per test so parallel runs never share a file.
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lolafk-match-history-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn games_payload() -> serde_json::Value {
        json!({ "games": { "games": [
            { "gameId": 464551151, "queueId": 2400,
              "participants": [ { "championId": 143, "stats": { "win": true } } ] },
            { "gameId": 464551152, "queueId": 450,
              "participants": [ { "championId": 99, "stats": { "win": false } } ] },
        ] } })
    }

    #[test]
    fn test_finish_marks_not_played_without_game_start() {
        let mut collector = MatchCollector::new();
        assert!(!collector.is_open());
        assert!(
            collector
                .start("2026-11-25", "20:31:05", Some(2400))
                .is_none()
        );
        assert!(collector.is_open());

        let record = collector.finish().unwrap();
        assert_eq!(record.result, MatchResult::NotPlayed);
        assert_eq!(record.game_id, None);
        assert_eq!(record.date, "2026-11-25");
        assert_eq!(record.time, "20:31:05");
        assert_eq!(record.queue_id, Some(2400));
        assert!(!collector.is_open());
        assert!(collector.finish().is_none());
    }

    #[test]
    fn test_finish_keeps_game_id_after_game_start() {
        let mut collector = MatchCollector::new();
        collector.start("2026-11-25", "20:31:05", None);
        collector.mark_game_started(Some(464551151));
        collector.mark_game_started(None); // does not clear
        collector.mark_game_started(Some(464551152)); // later Some overwrites

        let record = collector.finish().unwrap();
        assert_eq!(record.result, MatchResult::Unknown);
        assert_eq!(record.game_id, Some(464551152));
    }

    #[test]
    fn test_record_log_is_noop_without_open_record_and_caps_lines() {
        let mut collector = MatchCollector::new();
        collector.record_log(line("act", "已自動換成板凳英雄")); // no open record
        assert!(!collector.is_open());

        collector.start("2026-11-25", "20:31:05", None);
        for i in 0..(MAX_LOG_LINES + 5) {
            collector.record_log(LogLine {
                time: format!("20:31:{i:02}"),
                ..line("sys", "x")
            });
        }
        let record = collector.finish().unwrap();
        assert_eq!(record.log.len(), MAX_LOG_LINES);
        assert_eq!(record.log[0].time, "20:31:00");
        assert_eq!(
            record.log[MAX_LOG_LINES - 1].time,
            format!("20:31:{:02}", MAX_LOG_LINES - 1)
        );
    }

    #[test]
    fn test_start_while_open_returns_previous_record_finished() {
        let mut collector = MatchCollector::new();
        collector.start("2026-11-25", "20:31:05", Some(2400));
        collector.mark_game_started(Some(464551151));

        let previous = collector.start("2026-11-25", "21:02:00", Some(450));
        let previous = previous.expect("open record is returned finished");
        assert_eq!(previous.result, MatchResult::Unknown);
        assert_eq!(previous.game_id, Some(464551151));
        assert_eq!(previous.time, "20:31:05");

        // The new record starts empty and unplayed.
        let current = collector.finish().unwrap();
        assert_eq!(current.time, "21:02:00");
        assert_eq!(current.queue_id, Some(450));
        assert_eq!(current.game_id, None);
        assert_eq!(current.result, MatchResult::NotPlayed);
    }

    #[test]
    fn test_set_champion_ignores_invalid_ids_and_overwrites() {
        let mut collector = MatchCollector::new();
        collector.set_champion(143); // no open record

        collector.start("2026-11-25", "20:31:05", None);
        collector.set_champion(0);
        collector.set_champion(-5);
        assert_eq!(collector.finish().unwrap().champion_id, None);

        collector.start("2026-11-25", "21:02:00", None);
        collector.set_champion(143);
        collector.set_champion(99); // a later valid id overwrites
        assert_eq!(collector.finish().unwrap().champion_id, Some(99));
    }

    #[test]
    fn test_action_tags_use_only_act_lines_in_fixed_order() {
        let log = vec![
            line("act", "已自動帶上召喚師技能"),
            line("act", "已自動選擇開局英雄卡"),
            line("act", "已手動同意隊友換角"),
            line("act", "已從板凳秒換偏好英雄"),
            line("act", "已自動換成板凳英雄"), // same tag again
            line("sys", "已手動搶下板凳英雄"), // wrong kind
            line("act", "已自動接受對戰"),     // unmapped title
        ];
        assert_eq!(
            action_tags(&log),
            vec!["搶到板凳", "換角", "選卡", "帶技能"]
        );
    }

    #[test]
    fn test_action_tags_ignore_other_kinds_and_titles() {
        let log = vec![
            line("skip", "已自動換成板凳英雄"),
            line("act", "已自動接受對戰"),
            line("act", ""),
        ];
        assert!(action_tags(&log).is_empty());
        assert!(action_tags(&[]).is_empty());
    }

    #[test]
    fn test_action_tags_map_every_listed_title() {
        let cases = [
            ("已自動換成板凳英雄", "搶到板凳"),
            ("已從板凳秒換偏好英雄", "搶到板凳"),
            ("已手動搶下板凳英雄", "搶到板凳"),
            ("已手動同意隊友換角", "換角"),
            ("已自動選擇開局英雄卡", "選卡"),
            ("已選擇開局英雄卡", "選卡"),
            ("已自動帶上召喚師技能", "帶技能"),
        ];
        for (title, tag) in cases {
            assert_eq!(action_tags(&[line("act", title)]), vec![tag], "{title}");
        }
    }

    #[test]
    fn test_apply_match_history_fills_result_and_missing_ids() {
        let mut records = vec![
            sample_record(Some(464551151), MatchResult::Unknown),
            sample_record(Some(464551152), MatchResult::Unknown),
        ];
        assert!(apply_match_history(&mut records, &games_payload()));
        assert_eq!(records[0].result, MatchResult::Win);
        assert_eq!(records[0].champion_id, Some(143));
        assert_eq!(records[1].result, MatchResult::Loss);
        assert_eq!(records[1].champion_id, Some(99));
    }

    #[test]
    fn test_apply_match_history_keeps_known_champion_and_queue() {
        let mut records = vec![MatchRecord {
            champion_id: Some(7),
            queue_id: Some(450),
            ..sample_record(Some(464551151), MatchResult::Unknown)
        }];
        assert!(apply_match_history(&mut records, &games_payload()));
        assert_eq!(records[0].result, MatchResult::Win);
        assert_eq!(records[0].champion_id, Some(7));
        assert_eq!(records[0].queue_id, Some(450));
    }

    #[test]
    fn test_apply_match_history_leaves_other_records_alone() {
        let mut records = vec![
            sample_record(Some(464551151), MatchResult::Win), // already decided
            sample_record(Some(999), MatchResult::Unknown),   // not in history
            sample_record(None, MatchResult::Unknown),        // no game id
            sample_record(Some(464551152), MatchResult::NotPlayed),
        ];
        let before = records.clone();
        assert!(!apply_match_history(&mut records, &games_payload()));
        assert_eq!(records, before);
    }

    #[test]
    fn test_apply_match_history_ignores_malformed_payloads() {
        let mut records = vec![sample_record(Some(464551151), MatchResult::Unknown)];
        let before = records.clone();
        let payloads = [
            json!("not a payload"),
            json!({}),
            json!({ "games": null }),
            json!({ "games": { "games": {} } }),
            json!({ "games": { "games": [ { "gameId": "464551151" } ] } }),
            json!({ "games": { "games": [ { "gameId": 464551151, "participants": [] } ] } }),
            json!({ "games": { "games": [
                { "gameId": 464551151, "participants": [ { "stats": {} } ] }
            ] } }),
        ];
        for payload in payloads {
            assert!(!apply_match_history(&mut records, &payload), "{payload}");
            assert_eq!(records, before, "{payload}");
        }
    }

    #[test]
    fn test_append_record_trims_to_keep() {
        let dir = temp_dir("append-trim");
        let path = dir.join("match-history.jsonl");
        for i in 0..5 {
            let mut record = sample_record(Some(i), MatchResult::Win);
            record.time = format!("20:0{i}:00");
            append_record(&path, &record, 3).unwrap();
        }
        let records = read_records(&path);
        assert_eq!(
            records.iter().map(|r| r.game_id).collect::<Vec<_>>(),
            vec![Some(2), Some(3), Some(4)]
        );
        assert_eq!(records[0].time, "20:02:00");
        assert_eq!(records[2].time, "20:04:00");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_records_skips_corrupt_lines_and_missing_file() {
        let dir = temp_dir("read-corrupt");
        assert!(read_records(&dir.join("nothing.jsonl")).is_empty());

        let path = dir.join("match-history.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        let first = serde_json::to_string(&sample_record(Some(1), MatchResult::Win)).unwrap();
        let second = serde_json::to_string(&sample_record(Some(2), MatchResult::Loss)).unwrap();
        std::fs::write(&path, format!("{first}\nnot json\n\n{second}\n")).unwrap();
        let records = read_records(&path);
        assert_eq!(
            records.iter().map(|r| r.game_id).collect::<Vec<_>>(),
            vec![Some(1), Some(2)]
        );
        assert_eq!(records[1].result, MatchResult::Loss);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_records_keeps_last_and_creates_parents() {
        let dir = temp_dir("write-keep");
        let path = dir.join("nested").join("match-history.jsonl");
        let records = (0..4)
            .map(|i| sample_record(Some(i), MatchResult::Win))
            .collect::<Vec<_>>();
        write_records(&path, &records, 2).unwrap();
        assert_eq!(
            read_records(&path)
                .iter()
                .map(|r| r.game_id)
                .collect::<Vec<_>>(),
            vec![Some(2), Some(3)]
        );
        // One JSON object per line.
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(
            text.lines()
                .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_match_record_serializes_camel_case() {
        let record = MatchRecord {
            game_id: Some(464551151),
            queue_id: Some(2400),
            champion_id: Some(143),
            result: MatchResult::Win,
            actions: vec!["搶到板凳".to_string()],
            log: vec![line("act", "已自動換成板凳英雄")],
            ..sample_record(Some(464551151), MatchResult::Win)
        };
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["gameId"], 464551151);
        assert_eq!(value["queueId"], 2400);
        assert_eq!(value["championId"], 143);
        assert_eq!(value["result"], "win");
        assert_eq!(value["actions"][0], "搶到板凳");
        assert_eq!(value["log"][0]["kind"], "act");
        assert_eq!(value["log"][0]["title"], "已自動換成板凳英雄");
        assert!(value.get("game_id").is_none());

        // Round-trips back to the same record.
        let back: MatchRecord = serde_json::from_value(value).unwrap();
        assert_eq!(back, record);

        for (result, text) in [
            (MatchResult::Win, "win"),
            (MatchResult::Loss, "loss"),
            (MatchResult::NotPlayed, "notPlayed"),
            (MatchResult::Unknown, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(result).unwrap(), json!(text));
        }
    }

    /// One real, anonymized `GET /lol-match-history/v1/games/{gameId}` payload.
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("testdata/mayhem-game.json")).unwrap()
    }

    fn no_augments() -> std::collections::HashMap<i64, AugmentInfo> {
        std::collections::HashMap::new()
    }

    fn fixture_detail(my_puuid: &str) -> GameDetail {
        parse_game_detail(&fixture(), my_puuid, &no_augments()).expect("fixture parses")
    }

    #[test]
    fn test_parse_game_detail_reads_fixture() {
        let game = fixture();
        let detail = parse_game_detail(&game, "puuid-6", &no_augments()).unwrap();
        assert_eq!(detail.duration_sec, 1127);
        assert_eq!(detail.players.len(), 10);
        assert_eq!(
            detail.players.iter().map(|p| p.team_id).collect::<Vec<_>>(),
            vec![100, 100, 100, 100, 100, 200, 200, 200, 200, 200]
        );

        let mine = detail
            .players
            .iter()
            .filter(|p| p.is_me)
            .collect::<Vec<_>>();
        assert_eq!(mine.len(), 1);
        let me = mine[0];
        assert_eq!(me, &detail.players[5]); // participant 6
        assert_eq!(me.champion_id, 21);
        assert_eq!(me.team_id, 200);
        assert!(me.win);

        let first = &detail.players[0];
        assert!(!first.is_me);
        assert_eq!(first.name, "玩家1#TW2");
        assert_eq!(first.champion_id, 64);
        assert_eq!(first.team_id, 100);
        assert!(!first.win);
        assert_eq!(first.level, 18);
        assert_eq!((first.kills, first.deaths, first.assists), (19, 13, 25));
        assert_eq!(first.damage_to_champions, 70805);
        assert_eq!(first.damage_taken, 55052);
        assert_eq!(first.healing, 16145);
        assert_eq!(first.cc_sec, 32);
        assert_eq!(first.gold, 19658);
        assert_eq!(first.items, vec![6692, 226668, 3071, 6333, 3053]);
        assert_eq!(
            first.augments.iter().map(|a| a.id).collect::<Vec<_>>(),
            vec![2141, 1315, 1103, 3263]
        );
        let raw = &game["participants"][0];
        assert_eq!(
            first.spells,
            vec![
                raw["spell1Id"].as_i64().unwrap(),
                raw["spell2Id"].as_i64().unwrap()
            ]
        );
    }

    #[test]
    fn test_parse_game_detail_names_augments_from_table() {
        let mut augments = no_augments();
        augments.insert(
            2141,
            AugmentInfo {
                name: "究極九頭蛇".to_string(),
                rarity: "prismatic".to_string(),
            },
        );
        let detail = parse_game_detail(&fixture(), "puuid-6", &augments).unwrap();
        let picks = &detail.players[0].augments;
        assert_eq!(picks[0].id, 2141);
        assert_eq!(picks[0].name, "究極九頭蛇");
        assert_eq!(picks[0].rarity, "prismatic");
        for pick in &picks[1..] {
            assert_eq!(pick.name, "", "{pick:?}");
            assert_eq!(pick.rarity, "", "{pick:?}");
        }
    }

    #[test]
    fn test_parse_game_detail_unknown_puuid_and_malformed() {
        for puuid in ["puuid-404", ""] {
            let detail = parse_game_detail(&fixture(), puuid, &no_augments()).unwrap();
            assert_eq!(detail.players.len(), 10);
            assert!(detail.players.iter().all(|player| !player.is_me), "{puuid}");
        }

        for payload in [
            json!("not a game"),
            json!([]),
            json!(null),
            json!({}),
            json!({ "participants": null }),
            json!({ "participants": {} }),
            json!({ "participants": [] }),
        ] {
            assert!(
                parse_game_detail(&payload, "puuid-6", &no_augments()).is_none(),
                "{payload}"
            );
        }

        // A participant without stats or identity reads as zeros, never panics.
        let payload = json!({ "gameDuration": "1127", "participants": [ { "participantId": 1 } ] });
        let detail = parse_game_detail(&payload, "puuid-6", &no_augments()).unwrap();
        assert_eq!(detail.duration_sec, 0);
        assert_eq!(detail.players.len(), 1);
        let player = &detail.players[0];
        assert_eq!(player.name, "");
        assert!(!player.win);
        assert!(!player.is_me);
        assert_eq!(player.team_id, 0);
        assert_eq!(player.champion_id, 0);
        assert_eq!(player.level, 0);
        assert_eq!((player.kills, player.deaths, player.assists), (0, 0, 0));
        assert_eq!(player.damage_to_champions, 0);
        assert_eq!(player.damage_taken, 0);
        assert_eq!(player.healing, 0);
        assert_eq!(player.cc_sec, 0);
        assert_eq!(player.gold, 0);
        assert!(player.items.is_empty());
        assert!(player.augments.is_empty());
        assert_eq!(player.spells, vec![0, 0]);
    }

    #[test]
    fn test_parse_game_detail_name_falls_back_to_summoner_name() {
        let payload = json!({
            "participants": [
                { "participantId": 1, "stats": {} },
                { "participantId": 2, "stats": {} },
                { "participantId": 3, "stats": {} },
                { "participantId": 4, "stats": {} },
            ],
            "participantIdentities": [
                { "participantId": 1, "player": { "gameName": "只有名", "tagLine": "" } },
                { "participantId": 2, "player": { "gameName": "", "summonerName": "舊名字" } },
                { "participantId": 3, "player": { "gameName": "", "summonerName": "" } },
                { "participantId": 4 },
            ],
        });
        let detail = parse_game_detail(&payload, "", &no_augments()).unwrap();
        let names = detail
            .players
            .iter()
            .map(|player| player.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["只有名", "舊名字", "", ""]);
    }

    #[test]
    fn test_apply_game_detail_takes_result_and_champion_from_me() {
        // Unknown -> Win, champion overwritten from the player that is me.
        let mut record = MatchRecord {
            champion_id: Some(99),
            ..sample_record(Some(466486599), MatchResult::Unknown)
        };
        apply_game_detail(&mut record, fixture_detail("puuid-6"));
        assert_eq!(record.result, MatchResult::Win);
        assert_eq!(record.champion_id, Some(21));
        assert_eq!(record.detail.as_ref().unwrap().players.len(), 10);

        // Loss when my player lost.
        let mut record = sample_record(Some(466486599), MatchResult::Unknown);
        apply_game_detail(&mut record, fixture_detail("puuid-1"));
        assert_eq!(record.result, MatchResult::Loss);
        assert_eq!(record.champion_id, Some(64));

        // NotPlayed keeps its result but still records the detail.
        let mut record = sample_record(Some(466486599), MatchResult::NotPlayed);
        apply_game_detail(&mut record, fixture_detail("puuid-6"));
        assert_eq!(record.result, MatchResult::NotPlayed);
        assert_eq!(record.champion_id, Some(21));
        assert!(record.detail.is_some());

        // No player that is me: only the detail changes.
        let mut record = sample_record(Some(466486599), MatchResult::Unknown);
        let before = record.clone();
        apply_game_detail(&mut record, fixture_detail("puuid-404"));
        assert_eq!(record.result, before.result);
        assert_eq!(record.champion_id, before.champion_id);
        assert!(record.detail.is_some());
    }

    #[test]
    fn test_apply_details_fills_only_matching_records_that_need_one() {
        let mut detailed = sample_record(Some(2), MatchResult::Win);
        detailed.detail = Some(fixture_detail("puuid-6"));
        let mut records = vec![
            sample_record(Some(1), MatchResult::Unknown), // matching, filled
            detailed.clone(),                            // already detailed
            sample_record(Some(3), MatchResult::NotPlayed), // never played
            sample_record(Some(4), MatchResult::Unknown), // no detail supplied
        ];
        assert!(apply_details(
            &mut records,
            vec![(1, fixture_detail("puuid-6")), (3, fixture_detail("puuid-6"))]
        ));
        assert_eq!(records[0].result, MatchResult::Win);
        assert_eq!(records[0].champion_id, Some(21));
        assert_eq!(records[0].detail.as_ref().unwrap().players.len(), 10);
        assert_eq!(records[1], detailed);
        assert_eq!(records[2].result, MatchResult::NotPlayed);
        assert!(records[2].detail.is_none());
        assert!(records[3].detail.is_none());

        // Nothing left to fill: no change is reported.
        let before = records.clone();
        assert!(!apply_details(
            &mut records,
            vec![(1, fixture_detail("puuid-6"))]
        ));
        assert_eq!(records, before);
        assert!(!apply_details(&mut records, Vec::new()));
    }

    #[test]
    fn test_listed_game_ids_reads_the_same_path_as_apply_match_history() {
        assert_eq!(
            listed_game_ids(&games_payload()),
            std::collections::HashSet::from([464551151, 464551152])
        );
        // A non-numeric id is skipped, the rest of the list still counts.
        let mixed = json!({ "games": { "games": [
            { "gameId": 1 }, { "gameId": "2" }, {}
        ] } });
        assert_eq!(
            listed_game_ids(&mixed),
            std::collections::HashSet::from([1])
        );

        for payload in [
            json!("not a payload"),
            json!(null),
            json!({}),
            json!({ "games": null }),
            json!({ "games": { "games": {} } }),
        ] {
            assert!(listed_game_ids(&payload).is_empty(), "{payload}");
        }
    }

    #[test]
    fn test_picked_ids_reads_the_fixture_without_zeros_or_duplicates() {
        let (augments, items) = picked_ids(&fixture());
        assert_eq!(augments.len(), 39);
        assert_eq!(items.len(), 45);
        assert_eq!(augments[0], 2141);
        assert_eq!(items[0], 6692);
        assert!(augments.contains(&2141));
        assert!(items.contains(&226668));
        for id in augments.iter().chain(&items) {
            assert_ne!(*id, 0, "{id}");
        }
        for ids in [&augments, &items] {
            let unique = ids.iter().collect::<std::collections::HashSet<_>>();
            assert_eq!(unique.len(), ids.len(), "{ids:?}");
        }
        // The fixture picks both of these twice; the list keeps one.
        assert_eq!(augments.iter().filter(|id| **id == 3263).count(), 1);
        assert_eq!(items.iter().filter(|id| **id == 2503).count(), 1);
    }

    #[test]
    fn test_picked_ids_ignores_malformed_and_unknown_slots() {
        for payload in [
            json!("not a game"),
            json!({}),
            json!({ "participants": null }),
            json!({ "participants": [] }),
            json!({ "participants": [ {} ] }),
            json!({ "participants": [ { "stats": null } ] }),
        ] {
            assert_eq!(picked_ids(&payload), (Vec::new(), Vec::new()), "{payload}");
        }
        // Slot 7 is not one of the six augments, and zeros are dropped.
        let payload = json!({ "participants": [
            { "stats": { "playerAugment1": 2141, "playerAugment7": 9999, "item0": 0, "item1": 3071 } },
            { "stats": { "playerAugment1": 2141, "item1": 3071 } },
        ] });
        assert_eq!(picked_ids(&payload), (vec![2141], vec![3071]));
    }

    #[test]
    fn test_needs_detail_truth_table() {
        assert!(!needs_detail(&sample_record(None, MatchResult::Unknown)));
        assert!(!needs_detail(&sample_record(None, MatchResult::Win)));
        assert!(needs_detail(&sample_record(Some(1), MatchResult::Unknown)));
        assert!(needs_detail(&sample_record(Some(1), MatchResult::Win)));
        assert!(needs_detail(&sample_record(Some(1), MatchResult::Loss)));
        assert!(!needs_detail(&sample_record(
            Some(1),
            MatchResult::NotPlayed
        )));

        let mut record = sample_record(Some(1), MatchResult::Unknown);
        record.detail = Some(fixture_detail("puuid-6"));
        assert!(!needs_detail(&record));

        // A detail saved before `ccSec` existed (no `version` key) is fetched again,
        // and apply_details replaces it.
        let mut old = sample_record(Some(466486599), MatchResult::Win);
        let mut stale = fixture_detail("puuid-6");
        stale.version = 0;
        old.detail = Some(stale);
        let reread: MatchRecord = serde_json::from_value({
            let mut v = serde_json::to_value(&old).unwrap();
            v["detail"].as_object_mut().unwrap().remove("version");
            v
        })
        .unwrap();
        assert_eq!(reread.detail.as_ref().unwrap().version, 0);
        assert!(needs_detail(&reread));
        let mut records = vec![reread];
        assert!(apply_details(&mut records, vec![(466486599, fixture_detail("puuid-6"))]));
        assert_eq!(records[0].detail.as_ref().unwrap().version, DETAIL_VERSION);
        assert!(!needs_detail(&records[0]));
    }

    #[test]
    fn test_detail_is_optional_and_serializes_camel_case() {
        // Old lines without `detail` still deserialize, and re-serialize without it.
        let old = json!({ "gameId": 464551151, "date": "2026-11-25", "time": "20:31:05",
            "queueId": 2400, "championId": 143, "result": "win", "actions": [], "log": [] });
        let record: MatchRecord = serde_json::from_value(old).unwrap();
        assert_eq!(record.detail, None);
        let value = serde_json::to_value(&record).unwrap();
        assert!(value.get("detail").is_none(), "{value}");

        // A record with detail round-trips.
        let mut record = sample_record(Some(466486599), MatchResult::Win);
        record.detail = Some(fixture_detail("puuid-6"));
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["detail"]["durationSec"], 1127);
        let me = value["detail"]["players"]
            .as_array()
            .unwrap()
            .iter()
            .find(|player| player["isMe"] == json!(true))
            .expect("one player is me");
        assert_eq!(me["championId"], 21);
        assert_eq!(me["teamId"], 200);
        assert_eq!(value["detail"]["players"][0]["damageToChampions"], 70805);
        assert_eq!(value["detail"]["players"][0]["augments"][0]["id"], 2141);
        assert_eq!(value["detail"]["players"][0]["augments"][0]["rarity"], "");
        assert_eq!(me["spells"], json!([4, 6]));
        assert!(
            value["detail"]["players"][0]
                .get("damage_to_champions")
                .is_none()
        );
        let back: MatchRecord = serde_json::from_value(value).unwrap();
        assert_eq!(back, record);
    }

    #[test]
    fn test_cc_sec_is_optional_and_serializes_camel_case() {
        // A record written before `ccSec` existed still deserializes, as 0.
        let old = json!({ "gameId": 464551151, "date": "2026-11-25", "time": "20:31:05",
            "queueId": 2400, "championId": 143, "result": "win", "actions": [], "log": [],
            "detail": { "durationSec": 1127, "players": [ { "teamId": 100, "win": true,
                "isMe": false, "name": "玩家1#TW2", "championId": 64, "level": 18,
                "kills": 19, "deaths": 13, "assists": 25, "damageToChampions": 70805,
                "damageTaken": 55052, "healing": 16145, "gold": 19658,
                "items": [], "augments": [], "spells": [4, 6] } ] } });
        let record: MatchRecord = serde_json::from_value(old).unwrap();
        let player = &record.detail.as_ref().unwrap().players[0];
        assert_eq!(player.cc_sec, 0);
        // The field is written back in camelCase, so the page reads `ccSec`.
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["detail"]["players"][0]["ccSec"], 0);
        assert!(value["detail"]["players"][0].get("cc_sec").is_none());

        // A record with the field round-trips.
        let mut record = sample_record(Some(466486599), MatchResult::Win);
        record.detail = Some(fixture_detail("puuid-6"));
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["detail"]["players"][0]["ccSec"], 32);
        let back: MatchRecord = serde_json::from_value(value).unwrap();
        assert_eq!(back, record);
    }
}
