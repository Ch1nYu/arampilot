//! Pure rules for auto-accepting party invitations from chosen friends. No I/O
//! here: the caller in `lib.rs` reads the LCU (`/lol-lobby/v2/received-invitations`,
//! `/lol-chat/v1/friends`, `/lol-chat/v1/friend-groups`) and performs the accept,
//! so every rule below is unit testable.
//!
//! A friend counts as chosen when their puuid is listed or their friend group
//! name is listed. With both lists empty nothing is ever accepted.

use serde_json::Value;
use std::collections::HashSet;

/// `gameName#gameTag` of a friend entry; a client build without `gameTag`
/// answers just the game name, and an empty entry answers "".
fn friend_name(friend: &Value) -> String {
    let name = friend
        .get("gameName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let tag = friend
        .get("gameTag")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    match (name.is_empty(), tag.is_empty()) {
        (false, false) => format!("{name}#{tag}"),
        (false, true) => name.to_string(),
        _ => String::new(),
    }
}

/// The friend entry an invitation came from: `fromPuuid` first, then
/// `fromSummonerId` == friend `summonerId` for payloads without a puuid.
/// A sender missing from the friend list is not a friend, so this stays `None`.
fn find_sender<'a>(invitation: &Value, friends: &'a [Value]) -> Option<&'a Value> {
    let puuid = invitation
        .get("fromPuuid")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !puuid.is_empty() {
        return friends
            .iter()
            .find(|f| f.get("puuid").and_then(Value::as_str) == Some(puuid));
    }
    let summoner_id = invitation.get("fromSummonerId").and_then(Value::as_i64)?;
    friends
        .iter()
        .find(|f| f.get("summonerId").and_then(Value::as_i64) == Some(summoner_id))
}

/// Whether the user chose this friend, by puuid or by friend group name.
fn is_chosen(friend: &Value, groups: &[String], puuids: &[String]) -> bool {
    let puuid = friend.get("puuid").and_then(Value::as_str).unwrap_or("");
    if !puuid.is_empty() && puuids.iter().any(|chosen| chosen == puuid) {
        return true;
    }
    let group = friend
        .get("groupName")
        .and_then(Value::as_str)
        .unwrap_or("");
    !group.is_empty() && groups.iter().any(|chosen| chosen == group)
}

/// Pick the invitation to accept next: the oldest pending one from a chosen
/// friend that this run has not tried yet. `None` means "nothing to do".
pub fn pick_invitation(
    invitations: &Value,
    friends: &Value,
    groups: &[String],
    puuids: &[String],
    already_tried: &HashSet<String>,
) -> Option<(String, String)> {
    let invitations = invitations.as_array()?;
    // No friend list (LCU still starting) means nobody can be identified.
    let friends = friends.as_array()?;

    let mut best: Option<(String, String, &str)> = None;
    for invitation in invitations {
        if invitation.get("state").and_then(Value::as_str) != Some("Pending") {
            continue;
        }
        if invitation
            .get("canAcceptInvitation")
            .and_then(Value::as_bool)
            != Some(true)
        {
            continue;
        }
        if invitation.get("isSelfInvite").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(id) = invitation.get("invitationId").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() || already_tried.contains(id) {
            continue;
        }
        let Some(friend) = find_sender(invitation, friends) else {
            continue;
        };
        if !is_chosen(friend, groups, puuids) {
            continue;
        }
        let mut sender = friend_name(friend);
        if sender.is_empty() {
            sender = invitation
                .get("fromSummonerName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        // Oldest wins; equal timestamps keep the first one the LCU listed.
        let timestamp = invitation
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("");
        let older = best.as_ref().is_none_or(|(_, _, seen)| timestamp < *seen);
        if older {
            best = Some((id.to_string(), sender, timestamp));
        }
    }
    best.map(|(id, sender, _)| (id, sender))
}

/// Whether the player counts as idle: no party activity at all (`None`), or a
/// lobby they are alone in. Every other phase (Matchmaking, ReadyCheck,
/// ChampSelect, InProgress, post-game screens) already belongs to a game.
pub fn idle_for_invite(phase: &str, lobby_members: Option<usize>) -> bool {
    match phase {
        "None" => true,
        "Lobby" => lobby_members.is_some_and(|members| members <= 1),
        _ => false,
    }
}

/// Friend groups and friends for the settings picker:
/// `{ "groups": [{id, name}], "friends": [{puuid, name, groupName}] }`,
/// groups sorted by priority then name, friends by group name then name.
pub fn friend_directory(friends: &Value, groups: &Value) -> Value {
    let mut group_entries: Vec<(i64, String, Value)> = groups
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|group| {
                    let name = group.get("name").and_then(Value::as_str)?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    let priority = group.get("priority").and_then(Value::as_i64).unwrap_or(0);
                    let id = group.get("id").cloned().unwrap_or(Value::Null);
                    let entry = serde_json::json!({ "id": id, "name": name });
                    Some((priority, name.to_string(), entry))
                })
                .collect()
        })
        .unwrap_or_default();
    group_entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let mut friend_entries: Vec<(String, String, Value)> = friends
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|friend| {
                    let puuid = friend.get("puuid").and_then(Value::as_str)?.trim();
                    if puuid.is_empty() {
                        return None;
                    }
                    let name = friend_name(friend);
                    let group_name = friend
                        .get("groupName")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let entry = serde_json::json!({
                        "puuid": puuid,
                        "name": name,
                        "groupName": group_name,
                    });
                    Some((group_name, name, entry))
                })
                .collect()
        })
        .unwrap_or_default();
    friend_entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    serde_json::json!({
        "groups": group_entries
            .into_iter()
            .map(|(_, _, entry)| entry)
            .collect::<Vec<_>>(),
        "friends": friend_entries
            .into_iter()
            .map(|(_, _, entry)| entry)
            .collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn friends() -> Value {
        json!([
            {
                "puuid": "puuid-best",
                "summonerId": 1111,
                "gameName": "阿璃",
                "gameTag": "8888",
                "groupName": "**Default"
            },
            {
                "puuid": "puuid-aram",
                "summonerId": 2222,
                "gameName": "好運姐",
                "gameTag": "6666",
                "groupName": "ARAM 好友"
            }
        ])
    }

    fn invitation(id: &str, puuid: &str, timestamp: &str) -> Value {
        json!({
            "invitationId": id,
            "fromPuuid": puuid,
            "fromSummonerId": 1111,
            "fromSummonerName": "舊名字",
            "state": "Pending",
            "canAcceptInvitation": true,
            "isSelfInvite": false,
            "timestamp": timestamp
        })
    }

    fn tried(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn test_friend_by_puuid_is_accepted() {
        let picked = pick_invitation(
            &json!([invitation("inv-1", "puuid-best", "2026-11-20T10:00:00")]),
            &friends(),
            &[],
            &["puuid-best".to_string()],
            &HashSet::new(),
        );
        assert_eq!(picked, Some(("inv-1".to_string(), "阿璃#8888".to_string())));
    }

    #[test]
    fn test_friend_by_group_is_accepted() {
        let picked = pick_invitation(
            &json!([invitation("inv-2", "puuid-aram", "2026-11-20T10:00:00")]),
            &friends(),
            &["ARAM 好友".to_string()],
            &[],
            &HashSet::new(),
        );
        assert_eq!(
            picked,
            Some(("inv-2".to_string(), "好運姐#6666".to_string()))
        );
    }

    #[test]
    fn test_sender_outside_the_friend_list_is_never_accepted() {
        // Chosen by puuid, but the sender is a stranger whose puuid is not in friends.
        let picked = pick_invitation(
            &json!([invitation("inv-3", "puuid-stranger", "2026-11-20T10:00:00")]),
            &friends(),
            &["**Default".to_string()],
            &["puuid-stranger".to_string()],
            &HashSet::new(),
        );
        assert_eq!(picked, None);
    }

    #[test]
    fn test_friend_not_chosen_is_ignored() {
        assert_eq!(
            pick_invitation(
                &json!([invitation("inv-4", "puuid-best", "2026-11-20T10:00:00")]),
                &friends(),
                &["ARAM 好友".to_string()],
                &["puuid-other".to_string()],
                &HashSet::new(),
            ),
            None
        );
        // Both lists empty: the feature is off for every friend.
        assert_eq!(
            pick_invitation(
                &json!([invitation("inv-4", "puuid-best", "2026-11-20T10:00:00")]),
                &friends(),
                &[],
                &[],
                &HashSet::new(),
            ),
            None
        );
    }

    #[test]
    fn test_ineligible_invitations_are_skipped() {
        let chosen_puuid = ["puuid-best".to_string()];
        let mut not_pending = invitation("inv-a", "puuid-best", "2026-11-20T10:00:00");
        not_pending["state"] = json!("Accepted");
        let mut cannot_accept = invitation("inv-b", "puuid-best", "2026-11-20T10:00:00");
        cannot_accept["canAcceptInvitation"] = json!(false);
        let mut self_invite = invitation("inv-c", "puuid-best", "2026-11-20T10:00:00");
        self_invite["isSelfInvite"] = json!(true);
        let already = invitation("inv-d", "puuid-best", "2026-11-20T10:00:00");

        // Each one alone is the only candidate, so every case must answer None.
        let cases = [
            (not_pending, "state not Pending"),
            (cannot_accept, "cannot accept yet"),
            (self_invite, "self invite"),
            (already, "already tried"),
        ];
        for (candidate, reason) in cases {
            let tried_set = if reason == "already tried" {
                tried(&["inv-d"])
            } else {
                HashSet::new()
            };
            assert_eq!(
                pick_invitation(
                    &json!([candidate]),
                    &friends(),
                    &[],
                    &chosen_puuid,
                    &tried_set
                ),
                None,
                "{reason} must not be accepted"
            );
        }
    }

    #[test]
    fn test_oldest_pending_invitation_wins() {
        let picked = pick_invitation(
            &json!([
                invitation("inv-new", "puuid-best", "2026-11-20T10:05:00"),
                invitation("inv-old", "puuid-aram", "2026-11-20T10:00:00"),
            ]),
            &friends(),
            &["**Default".to_string(), "ARAM 好友".to_string()],
            &[],
            &HashSet::new(),
        );
        assert_eq!(picked.map(|(id, _)| id), Some("inv-old".to_string()));
    }

    #[test]
    fn test_summoner_id_fallback_matches_the_friend() {
        let mut no_puuid = invitation("inv-fallback", "", "2026-11-20T10:00:00");
        no_puuid["fromSummonerId"] = json!(2222);
        let picked = pick_invitation(
            &json!([no_puuid]),
            &friends(),
            &[],
            &["puuid-aram".to_string()],
            &HashSet::new(),
        );
        assert_eq!(
            picked,
            Some(("inv-fallback".to_string(), "好運姐#6666".to_string()))
        );
    }

    #[test]
    fn test_sender_name_falls_back_to_the_summoner_name() {
        let mut friend = friends()[0].clone();
        friend["gameName"] = json!("");
        friend["gameTag"] = json!("");
        let picked = pick_invitation(
            &json!([invitation("inv-name", "puuid-best", "2026-11-20T10:00:00")]),
            &json!([friend]),
            &[],
            &["puuid-best".to_string()],
            &HashSet::new(),
        );
        assert_eq!(picked, Some(("inv-name".to_string(), "舊名字".to_string())));
    }

    #[test]
    fn test_idle_for_invite_covers_the_game_phases() {
        assert!(idle_for_invite("None", None));
        assert!(idle_for_invite("Lobby", Some(1)));
        assert!(!idle_for_invite("Lobby", Some(2)));
        // Without a lobby snapshot the party size is unknown, so stay out.
        assert!(!idle_for_invite("Lobby", None));
        for phase in [
            "Matchmaking",
            "ReadyCheck",
            "ChampSelect",
            "GameStart",
            "InProgress",
            "Reconnect",
            "WaitingForStats",
            "PreEndOfGame",
            "EndOfGame",
        ] {
            assert!(!idle_for_invite(phase, Some(1)), "{phase} is not idle");
            assert!(!idle_for_invite(phase, None), "{phase} is not idle");
        }
    }

    #[test]
    fn test_friend_directory_shape_and_sorting() {
        let groups = json!([
            { "id": 1, "name": "ARAM 好友", "priority": 2 },
            { "id": -1, "name": "**Default", "priority": 0 },
            { "id": 0, "name": "AAA 好友", "priority": 2 },
            { "id": 9, "name": "  ", "priority": 0 }
        ]);
        let friends = json!([
            { "puuid": "puuid-b", "gameName": "好運姐", "gameTag": "6666", "groupName": "ARAM 好友" },
            { "puuid": "", "gameName": "沒有 puuid", "gameTag": "0000", "groupName": "ARAM 好友" },
            { "puuid": "puuid-a", "gameName": "阿璃", "gameTag": "8888", "groupName": "ARAM 好友" },
            { "puuid": "puuid-z", "gameName": "蓋倫", "gameTag": "9999", "groupName": "**Default" }
        ]);

        let directory = friend_directory(&friends, &groups);
        assert_eq!(
            directory["groups"],
            json!([
                { "id": -1, "name": "**Default" },
                { "id": 0, "name": "AAA 好友" },
                { "id": 1, "name": "ARAM 好友" }
            ])
        );
        assert_eq!(
            directory["friends"],
            json!([
                { "puuid": "puuid-z", "name": "蓋倫#9999", "groupName": "**Default" },
                { "puuid": "puuid-b", "name": "好運姐#6666", "groupName": "ARAM 好友" },
                { "puuid": "puuid-a", "name": "阿璃#8888", "groupName": "ARAM 好友" }
            ])
        );
    }

    #[test]
    fn test_friend_directory_tolerates_missing_payloads() {
        let directory = friend_directory(&json!(null), &json!(null));
        assert_eq!(directory, json!({ "groups": [], "friends": [] }));
    }
}
