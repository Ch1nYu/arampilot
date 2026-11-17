//! Pure decision logic for the post-game automations (auto play-again / auto
//! start queue). No I/O here: the caller in `lib.rs` reads the LCU, feeds the
//! parsed lobby snapshot into these functions and performs the resulting
//! actions, so every rule below is unit testable.

/// What `/lol-lobby/v2/lobby` tells the auto-queue decision.
#[derive(Debug, Clone, PartialEq)]
pub struct LobbySnapshot {
    pub is_leader: bool,
    pub queue_id: Option<i32>,
    pub members: usize,
    /// Every member has confirmed ready (a member without `ready` counts as ready).
    pub all_ready: bool,
    /// The lobby allows starting matchmaking (missing = true).
    pub can_start: bool,
}

/// Parse an LCU lobby payload. Missing fields fall back to permissive
/// defaults (`ready` / `canStartActivity` missing = true), matching how the
/// real endpoint omits them in common lobbies.
pub fn lobby_snapshot(lobby: &serde_json::Value) -> LobbySnapshot {
    let is_leader = lobby
        .get("localMember")
        .and_then(|v| v.get("isLeader"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let queue_id = lobby
        .get("gameConfig")
        .and_then(|v| v.get("queueId"))
        .and_then(|v| v.as_i64())
        .map(|q| q as i32);
    let members_array = lobby.get("members").and_then(|v| v.as_array());
    let members = members_array.map(|a| a.len()).unwrap_or(0);
    let all_ready = members_array
        .map(|a| {
            a.iter()
                .all(|m| m.get("ready").and_then(|v| v.as_bool()).unwrap_or(true))
        })
        .unwrap_or(true);
    let can_start = lobby
        .get("canStartActivity")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    LobbySnapshot {
        is_leader,
        queue_id,
        members,
        all_ready,
        can_start,
    }
}

/// State machine for "auto start matchmaking once the party is back".
#[derive(Default)]
pub struct AutoQueueTracker {
    /// Set after a finished ARAM/Mayhem game; cleared on other phases and
    /// right before the matchmaking search fires, so it happens once per game.
    pub armed: bool,
    /// Party size of the game that just finished; the lobby needs at least
    /// this many members before the queue may start again.
    pub last_party_size: usize,
    /// Last "wait" reason logged, so unchanged reasons do not spam the log.
    pub last_wait_log: Option<String>,
}

/// What the caller should do about the auto start-queue feature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoQueueDecision {
    /// Everything checks out: fire the matchmaking search.
    Start,
    /// Conditions are not met yet but may still be: keep waiting.
    Wait { reason: String },
    /// Conditions can no longer be met this game: stop and disarm.
    GiveUp { reason: String },
}

/// Decide whether to auto-start matchmaking. The caller only calls this while
/// the tracker is `armed`.
pub fn decide_auto_queue(
    tr: &AutoQueueTracker,
    lobby: &LobbySnapshot,
    mode_ok: bool,
) -> AutoQueueDecision {
    if !mode_ok {
        return AutoQueueDecision::GiveUp {
            reason: "不是 ARAM / Mayhem 大廳".to_string(),
        };
    }
    if !lobby.is_leader {
        return AutoQueueDecision::GiveUp {
            reason: "你不是房主".to_string(),
        };
    }
    let needed = tr.last_party_size.max(1);
    if lobby.members < needed {
        return AutoQueueDecision::Wait {
            reason: format!("等隊友回到大廳（{}/{}）", lobby.members, needed),
        };
    }
    if !lobby.all_ready || !lobby.can_start {
        return AutoQueueDecision::Wait {
            reason: "大廳還不能開始配對".to_string(),
        };
    }
    AutoQueueDecision::Start
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker(party_size: usize) -> AutoQueueTracker {
        AutoQueueTracker {
            armed: true,
            last_party_size: party_size,
            last_wait_log: None,
        }
    }

    fn snapshot(members: usize, overrides: impl FnOnce(&mut LobbySnapshot)) -> LobbySnapshot {
        let mut snap = LobbySnapshot {
            is_leader: true,
            queue_id: Some(450),
            members,
            all_ready: true,
            can_start: true,
        };
        overrides(&mut snap);
        snap
    }

    #[test]
    fn test_starts_when_party_is_back() {
        let tr = tracker(3);
        let decision = decide_auto_queue(&tr, &snapshot(3, |_| {}), true);
        assert_eq!(decision, AutoQueueDecision::Start);
    }

    #[test]
    fn test_waits_when_a_member_is_missing() {
        let tr = tracker(3);
        let decision = decide_auto_queue(&tr, &snapshot(2, |_| {}), true);
        match decision {
            AutoQueueDecision::Wait { reason } => {
                assert!(
                    reason.contains("2/3"),
                    "reason should show 2/3, got: {reason}"
                );
            }
            other => panic!("expected Wait, got {other:?}"),
        }
    }

    #[test]
    fn test_gives_up_when_not_leader() {
        let tr = tracker(3);
        let lobby = snapshot(3, |s| s.is_leader = false);
        match decide_auto_queue(&tr, &lobby, true) {
            AutoQueueDecision::GiveUp { reason } => {
                assert_eq!(reason, "你不是房主");
            }
            other => panic!("expected GiveUp, got {other:?}"),
        }
    }

    #[test]
    fn test_gives_up_for_non_aram_queue() {
        let tr = tracker(3);
        let lobby = snapshot(3, |s| s.queue_id = Some(420)); // Summoner's Rift ranked
        match decide_auto_queue(&tr, &lobby, false) {
            AutoQueueDecision::GiveUp { reason } => {
                assert_eq!(reason, "不是 ARAM / Mayhem 大廳");
            }
            other => panic!("expected GiveUp, got {other:?}"),
        }
    }

    #[test]
    fn test_solo_starts_after_a_solo_game() {
        // `last_party_size` 0 = never queued yet, 1 = queued alone.
        for party_size in [0usize, 1] {
            let tr = tracker(party_size);
            let decision = decide_auto_queue(&tr, &snapshot(1, |_| {}), true);
            assert_eq!(
                decision,
                AutoQueueDecision::Start,
                "solo game with party size {party_size} must start at 1 member"
            );
        }
    }

    #[test]
    fn test_waits_when_lobby_cannot_start() {
        let tr = tracker(3);
        let not_can_start = snapshot(3, |s| s.can_start = false);
        assert_eq!(
            decide_auto_queue(&tr, &not_can_start, true),
            AutoQueueDecision::Wait {
                reason: "大廳還不能開始配對".to_string()
            }
        );
        let member_not_ready = snapshot(3, |s| s.all_ready = false);
        assert_eq!(
            decide_auto_queue(&tr, &member_not_ready, true),
            AutoQueueDecision::Wait {
                reason: "大廳還不能開始配對".to_string()
            }
        );
    }

    #[test]
    fn test_lobby_snapshot_parses_realistic_payload() {
        let lobby = serde_json::json!({
            "canStartActivity": true,
            "gameConfig": { "queueId": 450, "gameMode": "ARAM" },
            "localMember": {
                "isLeader": true,
                "ready": true,
                "summonerId": 12345
            },
            "members": [
                { "isLeader": true, "ready": true, "summonerId": 12345 },
                { "isLeader": false, "ready": true, "summonerId": 222 },
                { "isLeader": false, "ready": false, "summonerId": 333 }
            ]
        });
        let snap = lobby_snapshot(&lobby);
        assert!(snap.is_leader);
        assert_eq!(snap.queue_id, Some(450));
        assert_eq!(snap.members, 3);
        assert!(!snap.all_ready);
        assert!(snap.can_start);
    }

    #[test]
    fn test_lobby_snapshot_defaults_missing_fields() {
        // Missing `ready` on members = ready; missing `canStartActivity` = true.
        let lobby = serde_json::json!({
            "localMember": { "isLeader": false },
            "gameConfig": { "queueId": 3270 },
            "members": [
                { "isLeader": false },
                { "isLeader": true, "ready": false }
            ]
        });
        let snap = lobby_snapshot(&lobby);
        assert!(!snap.is_leader);
        assert_eq!(snap.queue_id, Some(3270));
        assert_eq!(snap.members, 2);
        // One explicit `ready: false` still blocks the start.
        assert!(!snap.all_ready);
        assert!(snap.can_start);

        // A lobby payload missing whole sections falls back to empty defaults.
        let bare = lobby_snapshot(&serde_json::json!({}));
        assert!(!bare.is_leader);
        assert_eq!(bare.queue_id, None);
        assert_eq!(bare.members, 0);
        assert!(bare.all_ready);
        assert!(bare.can_start);
    }
}
