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

/// State machine for "auto start matchmaking once the party is back", plus
/// the premade party snapshot the auto honor needs.
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
    /// Every lobby member puuid (the player included) when the queue started;
    /// auto honor only touches these. Kept in memory, never logged or stored.
    pub party_puuids: Vec<String>,
    /// The player's own puuid, so auto honor never honors itself.
    pub own_puuid: Option<String>,
    /// `gameId` already honored, so the ballot is spent once per game.
    pub honored_game_id: Option<i64>,
}

/// Party puuids (`members[].puuid`) and the player's own puuid
/// (`localMember.puuid`) from an LCU lobby payload.
pub fn lobby_party_puuids(lobby: &serde_json::Value) -> (Vec<String>, Option<String>) {
    let own = lobby
        .get("localMember")
        .and_then(|m| m.get("puuid"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let party = lobby
        .get("members")
        .and_then(|v| v.as_array())
        .map(|members| {
            members
                .iter()
                .filter_map(|m| m.get("puuid").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    (party, own)
}

/// Puuids of the player's premade group (the player included) from
/// `/lol-gameflow/v1/session`: teammates sharing the player's
/// `teamParticipantId`. Empty when the player is not listed.
///
/// Fallback for when the lobby snapshot taken at `Matchmaking` is missing,
/// e.g. the app was restarted mid-game (2026-11-18 21:18).
pub fn premade_puuids(gameflow_session: &serde_json::Value, own_puuid: &str) -> Vec<String> {
    let Some(game_data) = gameflow_session.get("gameData") else {
        return Vec::new();
    };
    for team_key in ["teamOne", "teamTwo"] {
        let Some(team) = game_data.get(team_key).and_then(|v| v.as_array()) else {
            continue;
        };
        let puuid_of = |p: &serde_json::Value| p.get("puuid").and_then(|v| v.as_str()).map(str::to_string);
        let group_of = |p: &serde_json::Value| p.get("teamParticipantId").and_then(|v| v.as_i64());
        let Some(me) = team.iter().find(|p| puuid_of(p).as_deref() == Some(own_puuid)) else {
            continue;
        };
        let Some(group) = group_of(me) else {
            return vec![own_puuid.to_string()];
        };
        return team
            .iter()
            .filter(|p| group_of(p) == Some(group))
            .filter_map(puuid_of)
            .collect();
    }
    Vec::new()
}

/// The `gameId` a honor ballot belongs to; `None` when the ballot carries none.
pub fn ballot_game_id(ballot: &serde_json::Value) -> Option<i64> {
    ballot.get("gameId").and_then(|v| v.as_i64())
}

/// Pick the ballot entries to honor: premade party allies, the player and
/// anyone already honored excluded, at most `votePool.votes` of them.
/// Returns `(summonerId, puuid)` pairs; an absent or empty ballot yields none.
pub fn honor_targets(
    ballot: &serde_json::Value,
    party_puuids: &[String],
    own_puuid: Option<&str>,
) -> Vec<(u64, String)> {
    let Some(votes) = ballot
        .get("votePool")
        .and_then(|v| v.get("votes"))
        .and_then(|v| v.as_u64())
    else {
        return Vec::new();
    };
    let already_honored: Vec<&str> = ballot
        .get("honoredPlayers")
        .and_then(|v| v.as_array())
        .map(|players| {
            players
                .iter()
                .filter_map(|p| p.get("recipientPuuid").and_then(|v| v.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let allies = ballot
        .get("eligibleAllies")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();

    let mut targets: Vec<(u64, String)> = Vec::new();
    for ally in allies {
        if targets.len() as u64 >= votes {
            break;
        }
        let Some(puuid) = ally.get("puuid").and_then(|v| v.as_str()) else {
            continue;
        };
        if Some(puuid) == own_puuid || already_honored.contains(&puuid) {
            continue;
        }
        if !party_puuids.iter().any(|member| member == puuid) {
            continue;
        }
        let Some(summoner_id) = ally.get("summonerId").and_then(|v| v.as_u64()) else {
            continue;
        };
        targets.push((summoner_id, puuid.to_string()));
    }
    targets
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
            ..AutoQueueTracker::default()
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

    #[test]
    fn test_premade_puuids_groups_by_team_participant_id() {
        // Shape seen live 2026-11-18: our teamParticipantId 3 shared by two allies.
        let flow = serde_json::json!({ "gameData": {
            "teamOne": [
                { "puuid": "me", "teamParticipantId": 3 },
                { "puuid": "a", "teamParticipantId": 2 },
                { "puuid": "f1", "teamParticipantId": 3 },
                { "puuid": "f2", "teamParticipantId": 3 }
            ],
            "teamTwo": [{ "puuid": "x", "teamParticipantId": 3 }]
        }});
        assert_eq!(premade_puuids(&flow, "me"), vec!["me", "f1", "f2"]);
        assert!(premade_puuids(&flow, "nobody").is_empty());
        assert!(premade_puuids(&serde_json::json!({}), "me").is_empty());
    }

    /// Ballot payload shaped like the live one; `allies` are `(summonerId, puuid)`.
    fn ballot_payload(votes: u64, allies: &[(u64, &str)], honored: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "eligibleAllies": allies
                .iter()
                .map(|(summoner_id, puuid)| serde_json::json!({
                    "botPlayer": false,
                    "championId": 22,
                    "puuid": puuid,
                    "summonerId": summoner_id,
                    "summonerName": "someone",
                }))
                .collect::<Vec<_>>(),
            "eligibleOpponents": [],
            "gameId": 464551151,
            "honoredPlayers": honored
                .iter()
                .map(|puuid| serde_json::json!({ "honorType": "HEART", "recipientPuuid": puuid }))
                .collect::<Vec<_>>(),
            "votePool": {
                "votes": votes,
                "fromGamePlayed": 1,
                "fromHighHonor": 0,
                "fromRecentHonors": 1,
                "fromRollover": 1,
            },
        })
    }

    #[test]
    fn test_honors_two_premade_teammates_out_of_three() {
        // Party of three (the player plus two premates) among five allies.
        let party = vec!["me".to_string(), "p1".into(), "p2".into()];
        let ballot = ballot_payload(
            3,
            &[
                (1, "p1"),
                (2, "random-a"),
                (3, "me"),
                (4, "p2"),
                (5, "random-b"),
            ],
            &[],
        );
        assert_eq!(
            honor_targets(&ballot, &party, Some("me")),
            vec![(1, "p1".to_string()), (4, "p2".to_string())]
        );
    }

    #[test]
    fn test_solo_game_honors_nobody() {
        let party = vec!["me".to_string()];
        let ballot = ballot_payload(3, &[(3, "me"), (4, "random")], &[]);
        assert!(honor_targets(&ballot, &party, Some("me")).is_empty());
    }

    #[test]
    fn test_honors_are_capped_by_the_vote_count() {
        let party = vec!["me".to_string(), "p1".into(), "p2".into(), "p3".into()];
        let ballot = ballot_payload(2, &[(1, "p1"), (2, "p2"), (3, "p3")], &[]);
        assert_eq!(
            honor_targets(&ballot, &party, Some("me")),
            vec![(1, "p1".to_string()), (2, "p2".to_string())]
        );
        let none_left = ballot_payload(0, &[(1, "p1")], &[]);
        assert!(honor_targets(&none_left, &party, Some("me")).is_empty());
    }

    #[test]
    fn test_already_honored_party_member_is_skipped() {
        let party = vec!["me".to_string(), "p1".into(), "p2".into()];
        let ballot = ballot_payload(3, &[(1, "p1"), (2, "p2")], &["p1"]);
        assert_eq!(
            honor_targets(&ballot, &party, Some("me")),
            vec![(2, "p2".to_string())]
        );
    }

    #[test]
    fn test_missing_or_empty_ballot_honors_nobody() {
        let party = vec!["me".to_string(), "p1".into()];
        assert!(honor_targets(&serde_json::json!({}), &party, Some("me")).is_empty());
        let empty = serde_json::json!({
            "eligibleAllies": [],
            "honoredPlayers": [],
            "votePool": { "votes": 3 },
        });
        assert!(honor_targets(&empty, &party, Some("me")).is_empty());
        // A party that was never recorded cannot match any ally.
        let ballot = ballot_payload(3, &[(1, "p1")], &[]);
        assert!(honor_targets(&ballot, &[], Some("me")).is_empty());
        assert_eq!(ballot_game_id(&ballot), Some(464551151));
        assert_eq!(ballot_game_id(&serde_json::json!({})), None);
    }

    #[test]
    fn test_lobby_party_puuids_reads_members_and_local_member() {
        let lobby = serde_json::json!({
            "localMember": { "puuid": "me", "isLeader": true },
            "members": [
                { "puuid": "me" },
                { "puuid": "p1" },
                { "summonerId": 1 }
            ]
        });
        let (party, own) = lobby_party_puuids(&lobby);
        assert_eq!(party, vec!["me".to_string(), "p1".to_string()]);
        assert_eq!(own.as_deref(), Some("me"));
        let (party, own) = lobby_party_puuids(&serde_json::json!({}));
        assert!(party.is_empty());
        assert_eq!(own, None);
    }
}
