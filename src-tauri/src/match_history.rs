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
}
