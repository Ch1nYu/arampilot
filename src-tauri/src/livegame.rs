use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::broadcast;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LiveGameStats {
    pub game_mode: String,
    pub game_time: f64,
}

pub struct LiveGamePoller {
    http_client: reqwest::Client,
    /// Bumped by `stop_polling()` (and by every accepted `start_polling()`), so a
    /// task left over from a previous game exits instead of alerting for the new one.
    poll_gen: Arc<AtomicU64>,
    polling: Arc<AtomicBool>,
    alert_tx: broadcast::Sender<String>,
    /// Game time and wall-clock instant of the last alert. Survives a poller
    /// restart (LCU reconnect mid-game), so the same game is not alerted twice.
    last_alert: Arc<std::sync::Mutex<Option<(f64, std::time::Instant)>>>,
}

/// Whether an alert sent at `alert_game_time`, `alert_age_secs` ago, belongs to
/// the game now at `now_game_time`: in the same game both clocks advance together.
pub fn alert_is_same_game(alert_game_time: f64, alert_age_secs: f64, now_game_time: f64) -> bool {
    now_game_time >= alert_game_time && ((now_game_time - alert_game_time) - alert_age_secs).abs() <= 30.0
}

impl Default for LiveGamePoller {
    fn default() -> Self {
        Self::new()
    }
}

impl LiveGamePoller {
    pub fn new() -> Self {
        let http_client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(2))
            .build()
            .expect("Failed to build LiveGamePoller HTTP client");

        let (alert_tx, _) = broadcast::channel(10);

        Self {
            http_client,
            poll_gen: Arc::new(AtomicU64::new(0)),
            polling: Arc::new(AtomicBool::new(false)),
            alert_tx,
            last_alert: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    pub fn subscribe_alerts(&self) -> broadcast::Receiver<String> {
        self.alert_tx.subscribe()
    }

    pub fn is_polling(&self) -> bool {
        self.polling.load(Ordering::SeqCst)
    }

    pub fn start_polling(self: Arc<Self>, ff_seconds: f64, cooldown_reminder: bool) {
        if self.polling.swap(true, Ordering::SeqCst) {
            return; // already polling
        }
        let generation = self.poll_gen.fetch_add(1, Ordering::SeqCst) + 1;

        tauri::async_runtime::spawn(async move {
            let mut next_trigger_time = ff_seconds;
            let mut triggered_this_game = false;
            let mut first_reading = true;

            loop {
                if self.poll_gen.load(Ordering::SeqCst) != generation {
                    return; // superseded by stop_polling() or a newer start_polling()
                }

                let mut next_sleep = Duration::from_secs(2);
                if (!triggered_this_game || cooldown_reminder)
                    && let Ok(stats) = self.fetch_gamestats().await
                {
                    if first_reading {
                        first_reading = false;
                        // Restarted mid-game (e.g. LCU reconnect): resume after the
                        // alert this game already had instead of firing it again.
                        let previous = *self.last_alert.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some((alert_time, at)) = previous
                            && alert_is_same_game(alert_time, at.elapsed().as_secs_f64(), stats.game_time)
                        {
                            triggered_this_game = true;
                            if cooldown_reminder {
                                next_trigger_time = alert_time + 180.0;
                            } else {
                                tokio::time::sleep(next_sleep).await;
                                continue;
                            }
                        }
                    }
                    if stats.game_time >= next_trigger_time {
                        *self.last_alert.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((stats.game_time, std::time::Instant::now()));
                        triggered_this_game = true;
                        let _ = self.alert_tx.send(format!(
                            "遊戲時間已達 {:.0} 秒（最早可投降時間），可以 /ff 投降了！",
                            stats.game_time
                        ));
                        if cooldown_reminder {
                            next_trigger_time = stats.game_time + 180.0;
                        }
                    } else {
                        let rem = next_trigger_time - stats.game_time;
                        if rem <= 3.0 {
                            next_sleep = Duration::from_secs_f64(rem.clamp(0.15, 0.5));
                        }
                    }
                }

                tokio::time::sleep(next_sleep).await;
            }
        });
    }

    pub async fn stop_polling(&self) {
        self.polling.store(false, Ordering::SeqCst);
        // Invalidate any task still sleeping for the previous game.
        self.poll_gen.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn fetch_gamestats(&self) -> Result<LiveGameStats, String> {
        let url = "https://127.0.0.1:2999/liveclientdata/gamestats";
        let res = self
            .http_client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("Status {}", res.status()));
        }

        let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        let game_mode = json
            .get("gameMode")
            .and_then(|v| v.as_str())
            .unwrap_or("ARAM")
            .to_string();
        let game_time = json.get("gameTime").and_then(|v| v.as_f64()).unwrap_or(0.0);

        Ok(LiveGameStats {
            game_mode,
            game_time,
        })
    }

    /// Enemy kills minus ally kills for the active player (negative = we are ahead).
    pub async fn fetch_kill_deficit(&self) -> Option<i32> {
        let url = "https://127.0.0.1:2999/liveclientdata/allgamedata";
        let res = self.http_client.get(url).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let json: serde_json::Value = res.json().await.ok()?;
        compute_kill_deficit(&json)
    }
}

/// Pure helper for `fetch_kill_deficit` so the team/kill math is unit-testable.
pub fn compute_kill_deficit(data: &serde_json::Value) -> Option<i32> {
    let active_name = data
        .get("activePlayer")
        .and_then(|p| p.get("summonerName"))
        .and_then(|v| v.as_str())?;
    let players = data.get("allPlayers").and_then(|v| v.as_array())?;

    let my_team = players
        .iter()
        .find(|p| p.get("summonerName").and_then(|v| v.as_str()) == Some(active_name))
        .and_then(|p| p.get("team"))
        .and_then(|v| v.as_str())?;

    let mut ally_kills = 0i32;
    let mut enemy_kills = 0i32;

    for player in players {
        let Some(team) = player.get("team").and_then(|v| v.as_str()) else {
            continue;
        };
        let kills = player
            .get("scores")
            .and_then(|s| s.get("kills"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32;
        if team == my_team {
            ally_kills += kills;
        } else {
            enemy_kills += kills;
        }
    }

    Some(enemy_kills - ally_kills)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_poller_creation_and_subscription() {
        let poller = Arc::new(LiveGamePoller::new());
        let _rx = poller.subscribe_alerts();
        // Just verify channels and client build cleanly
        assert!(!poller.is_polling());
        assert_eq!(poller.poll_gen.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_alert_is_same_game_only_when_clocks_agree() {
        // Alert at 480s, 300s ago, game now at 781s: same game (reconnect).
        assert!(alert_is_same_game(480.0, 300.0, 781.0));
        // New game at 30s, alert from the previous game 20 minutes ago.
        assert!(!alert_is_same_game(480.0, 1200.0, 30.0));
        // New game already past 8:00 by the time we look, last alert long ago.
        assert!(!alert_is_same_game(480.0, 3600.0, 500.0));
    }

    #[test]
    fn test_compute_kill_deficit_behind() {
        let data = json!({
            "activePlayer": { "summonerName": "Me#TWN" },
            "allPlayers": [
                { "summonerName": "Me#TWN", "team": "ORDER", "scores": { "kills": 3 } },
                { "summonerName": "Ally", "team": "ORDER", "scores": { "kills": 2 } },
                { "summonerName": "E1", "team": "CHAOS", "scores": { "kills": 8 } },
                { "summonerName": "E2", "team": "CHAOS", "scores": { "kills": 4 } }
            ]
        });

        // enemy 12 - ally 5 = 7
        assert_eq!(compute_kill_deficit(&data), Some(7));
    }

    #[test]
    fn test_compute_kill_deficit_ahead_is_negative() {
        let data = json!({
            "activePlayer": { "summonerName": "Me#TWN" },
            "allPlayers": [
                { "summonerName": "Me#TWN", "team": "CHAOS", "scores": { "kills": 9 } },
                { "summonerName": "E1", "team": "ORDER", "scores": { "kills": 2 } }
            ]
        });

        assert_eq!(compute_kill_deficit(&data), Some(-7));
    }

    #[test]
    fn test_compute_kill_deficit_missing_data() {
        assert_eq!(compute_kill_deficit(&json!({})), None);
        assert_eq!(
            compute_kill_deficit(&json!({
                "activePlayer": { "summonerName": "Me#TWN" },
                "allPlayers": []
            })),
            None
        );
    }
}
