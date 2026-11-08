use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::{SinkExt, StreamExt};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tokio::sync::{RwLock, broadcast};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LcuAuth {
    pub port: u16,
    pub token: String,
    pub auth_header: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChampionItem {
    pub id: i32,
    pub name: String,
    pub title: Option<String>,
    pub roles: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChampionMasteryItem {
    #[serde(rename = "championId")]
    pub champion_id: i32,
    #[serde(rename = "championLevel", default)]
    pub champion_level: i32,
    #[serde(rename = "championPoints", default)]
    pub champion_points: i64,
    #[serde(rename = "lastPlayTime", default)]
    pub last_play_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LcuEvent {
    pub uri: String,
    #[serde(rename = "eventType")]
    pub event_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub port: Option<u16>,
}

/// Whether a `champion-summary.json` entry is a playable standard champion.
///
/// The asset dump also contains Classic Mode-only duplicates (`Jade_*`, ids
/// starting at 60000), Teamfight Tactics units (`TFT*`) and dummy entries
/// (`id: -1`, alias `None`), which must never reach the champion pool.
pub fn is_valid_standard_champion(item: &serde_json::Value) -> bool {
    let id = match item.get("id").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => return false,
    };
    if id <= 0 || id >= 10000 {
        return false;
    }

    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return false;
    }

    let alias = item
        .get("alias")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if alias.starts_with("jade_") || alias.starts_with("tft") || alias == "none" {
        return false;
    }

    item.get("roles")
        .and_then(|v| v.as_array())
        .map(|roles| !roles.is_empty())
        .unwrap_or(false)
}

/// Parse a raw mastery JSON array into sorted, valid standard champion mastery items.
pub fn parse_mastery_items(raw: &serde_json::Value) -> Vec<ChampionMasteryItem> {
    let arr_opt = raw.as_array().or_else(|| {
        raw.get("masteries")
            .and_then(|v| v.as_array())
            .or_else(|| raw.get("championMasteries").and_then(|v| v.as_array()))
    });
    let Some(arr) = arr_opt else {
        return Vec::new();
    };
    let mut items: Vec<ChampionMasteryItem> = arr
        .iter()
        .filter_map(|v| {
            let champion_id = v.get("championId").and_then(|x| x.as_i64())? as i32;
            if !(0 < champion_id && champion_id < 10000) {
                return None;
            }
            let champion_level =
                v.get("championLevel").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
            let champion_points = v
                .get("championPoints")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let last_play_time = v.get("lastPlayTime").and_then(|x| x.as_i64()).unwrap_or(0);
            Some(ChampionMasteryItem {
                champion_id,
                champion_level,
                champion_points,
                last_play_time,
            })
        })
        .collect();

    items.sort_by(|a, b| {
        b.champion_points
            .cmp(&a.champion_points)
            .then_with(|| b.champion_level.cmp(&a.champion_level))
            .then_with(|| b.last_play_time.cmp(&a.last_play_time))
            .then_with(|| a.champion_id.cmp(&b.champion_id))
    });
    items
}

/// Parse the 2~3 ARAM / Mayhem offered champion card IDs from `/subset-champion-list`.
pub fn parse_subset_champion_list(raw: &serde_json::Value) -> Vec<i32> {
    let Some(arr) = raw.as_array() else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in arr {
        let id_opt = entry
            .as_i64()
            .or_else(|| entry.get("championId").and_then(|v| v.as_i64()))
            .or_else(|| entry.get("id").and_then(|v| v.as_i64()));
        if let Some(raw_id) = id_opt {
            let id = raw_id as i32;
            if id > 0 && id < 10000 && seen.insert(id) {
                out.push(id);
            }
        }
    }
    out
}

/// The logged-in account's identity used to pick which config file is active.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AccountIdentityInfo {
    pub puuid: String,
    /// `gameName#tagLine`, falling back to the legacy `displayName`.
    pub display_name: String,
}

/// Extract the identity from a `current-summoner` payload; `None` without a puuid.
pub fn parse_account_identity(raw: &serde_json::Value) -> Option<AccountIdentityInfo> {
    let puuid = raw
        .get("puuid")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())?;
    let game_name = raw
        .get("gameName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let tag_line = raw
        .get("tagLine")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let display_name = match (game_name, tag_line) {
        (Some(name), Some(tag)) => format!("{}#{}", name, tag),
        (Some(name), None) => name.to_string(),
        _ => raw
            .get("displayName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or_default()
            .to_string(),
    };
    Some(AccountIdentityInfo {
        puuid: puuid.to_string(),
        display_name,
    })
}

/// Extract premade party member and friend identifiers (`puuid`s and `summonerId`s),
/// excluding the local player.
pub fn extract_allied_identifiers(
    lobby: Option<&serde_json::Value>,
    friends: Option<&serde_json::Value>,
) -> (
    std::collections::HashSet<String>,
    std::collections::HashSet<i64>,
) {
    let mut puuids = std::collections::HashSet::new();
    let mut summoner_ids = std::collections::HashSet::new();

    let mut local_puuid: Option<String> = None;
    let mut local_summoner_id: Option<i64> = None;

    if let Some(l) = lobby {
        if let Some(local) = l.get("localMember") {
            if let Some(p) = local
                .get("puuid")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                local_puuid = Some(p.to_string());
            }
            if let Some(sid) = local
                .get("summonerId")
                .and_then(|v| v.as_i64())
                .filter(|&id| id > 0)
            {
                local_summoner_id = Some(sid);
            }
        }

        if let Some(members) = l.get("members").and_then(|v| v.as_array()) {
            // Only treat lobby members as premade when there is at least one other member in the party.
            if members.len() > 1 {
                for m in members {
                    if let Some(p) = m
                        .get("puuid")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        puuids.insert(p.to_string());
                    }
                    if let Some(sid) = m
                        .get("summonerId")
                        .and_then(|v| v.as_i64())
                        .filter(|&id| id > 0)
                    {
                        summoner_ids.insert(sid);
                    }
                }
            }
        }
    }

    if let Some(fr_arr) = friends.and_then(|v| v.as_array()) {
        for f in fr_arr {
            if let Some(p) = f
                .get("puuid")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                puuids.insert(p.to_string());
            }
            if let Some(sid) = f
                .get("summonerId")
                .and_then(|v| v.as_i64())
                .filter(|&id| id > 0)
            {
                summoner_ids.insert(sid);
            }
        }
    }

    if let Some(lp) = local_puuid {
        puuids.remove(&lp);
    }
    if let Some(lsid) = local_summoner_id {
        summoner_ids.remove(&lsid);
    }

    (puuids, summoner_ids)
}

/// Resolve an effective queue ID from `/lol-gameflow/v1/session` or `/lol-lobby/v2/lobby`.
///
/// Practice Tool (`gameMode == "PRACTICETOOL"`), Summoner's Rift (`mapId == 11`, `"CLASSIC"`),
/// and other non-Howling-Abyss custom modes often report `queueId: -1` (or `0`). Returning
/// `Some(-1)` instead of `None` lets callers distinguish "known non-ARAM mode" from "unknown".
/// Conversely, Custom Mayhem (`gameMode == "KIWI"`) and Custom Howling Abyss ARAM
/// (`gameMode == "ARAM"` on `mapId == 12`) with `queueId <= 0` are mapped to `3270` / `3200`.
pub fn resolve_queue_id_from_session_or_lobby(
    session: Option<&serde_json::Value>,
    lobby: Option<&serde_json::Value>,
) -> Option<i32> {
    if let Some(s) = session {
        let queue_obj = s.get("gameData").and_then(|gd| gd.get("queue"));
        let qid = queue_obj.and_then(|q| q.get("id")).and_then(|v| v.as_i64());
        let game_mode = queue_obj
            .and_then(|q| q.get("gameMode"))
            .and_then(|v| v.as_str())
            .or_else(|| {
                s.get("map")
                    .and_then(|m| m.get("gameMode"))
                    .and_then(|v| v.as_str())
            })
            .unwrap_or("");
        let map_id = s
            .get("map")
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_i64())
            .or_else(|| {
                queue_obj
                    .and_then(|q| q.get("mapId"))
                    .and_then(|v| v.as_i64())
            });
        if let Some(resolved) = classify_queue_info(qid, game_mode, map_id) {
            return Some(resolved);
        }
    }

    if let Some(l) = lobby {
        let gc = l.get("gameConfig");
        let qid = gc.and_then(|c| c.get("queueId")).and_then(|v| v.as_i64());
        let game_mode = gc
            .and_then(|c| c.get("gameMode"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let map_id = gc.and_then(|c| c.get("mapId")).and_then(|v| v.as_i64());
        if let Some(resolved) = classify_queue_info(qid, game_mode, map_id) {
            return Some(resolved);
        }
    }

    None
}

fn classify_queue_info(
    qid: Option<i64>,
    game_mode: &str,
    map_id: Option<i64>,
) -> Option<i32> {
    // Summoner's Rift (map 11) or Practice Tool is NEVER ARAM/Mayhem, regardless of custom queueId.
    if game_mode.eq_ignore_ascii_case("PRACTICETOOL")
        || game_mode.eq_ignore_ascii_case("CLASSIC")
        || map_id == Some(11)
    {
        return Some(qid.filter(|&id| id > 0 && id != 450 && id != 2400 && id != 3270).unwrap_or(-1) as i32);
    }

    if let Some(id) = qid
        && id > 0
    {
        return Some(id as i32);
    }

    if game_mode.eq_ignore_ascii_case("KIWI") {
        return Some(3270);
    }
    if game_mode.eq_ignore_ascii_case("ARAM") && map_id == Some(12) {
        return Some(3200);
    }

    if qid.is_some() || !game_mode.is_empty() || map_id.is_some() {
        return Some(-1);
    }

    None
}

pub struct LcuManager {
    auth: Arc<RwLock<Option<LcuAuth>>>,
    ws_connected: Arc<AtomicBool>,
    http_client: reqwest::Client,
    event_tx: broadcast::Sender<LcuEvent>,
    status_tx: broadcast::Sender<ConnectionStatus>,
}

impl Default for LcuManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LcuManager {
    pub fn new() -> Self {
        let http_client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(5))
            .build()
            .expect("Failed to build HTTP client");

        let (event_tx, _) = broadcast::channel(512);
        let (status_tx, _) = broadcast::channel(64);

        Self {
            auth: Arc::new(RwLock::new(None)),
            ws_connected: Arc::new(AtomicBool::new(false)),
            http_client,
            event_tx,
            status_tx,
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<LcuEvent> {
        self.event_tx.subscribe()
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<ConnectionStatus> {
        self.status_tx.subscribe()
    }

    pub async fn get_auth(&self) -> Option<LcuAuth> {
        self.auth.read().await.clone()
    }

    pub async fn is_connected(&self) -> bool {
        self.auth.read().await.is_some()
    }

    /// Detect LCU credentials from process cmdline or lockfile
    pub fn detect_auth() -> Option<LcuAuth> {
        // Method 1: Process inspection (fastest, works anywhere)
        let mut sys = System::new_with_specifics(RefreshKind::nothing().with_processes(
            ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::OnlyIfNotSet),
        ));
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::OnlyIfNotSet),
        );

        let port_re = Regex::new(r"--app-port=(\d+)").unwrap();
        let token_re = Regex::new(r"--remoting-auth-token=([\w-]+)").unwrap();

        for process in sys.processes().values() {
            let name = process.name().to_string_lossy();
            if name.eq_ignore_ascii_case("LeagueClientUx.exe") {
                let cmd: Vec<String> = process
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().to_string())
                    .collect();
                let cmd_str = cmd.join(" ");

                let port_match = port_re.captures(&cmd_str);
                let token_match = token_re.captures(&cmd_str);

                if let (Some(pm), Some(tm)) = (port_match, token_match)
                    && let Ok(port) = pm.get(1).unwrap().as_str().parse::<u16>()
                {
                    let token = tm.get(1).unwrap().as_str().to_string();
                    let raw = format!("riot:{}", token);
                    let auth_header = format!("Basic {}", BASE64.encode(raw.as_bytes()));
                    return Some(LcuAuth {
                        port,
                        token,
                        auth_header,
                    });
                }
            }
        }

        // Method 2: Fallback to common lockfile paths.
        // A lockfile survives a crash, so its PID must be proven alive first.
        let has_lcu_process = sys.processes().values().any(|p| {
            let name = p.name().to_string_lossy();
            name.eq_ignore_ascii_case("LeagueClient.exe")
                || name.eq_ignore_ascii_case("LeagueClientUx.exe")
        });

        let candidates = [
            r"C:\Riot Games\League of Legends\lockfile",
            r"D:\Riot Games\League of Legends\lockfile",
            r"E:\Riot Games\League of Legends\lockfile",
            r"D:\League of Legends\lockfile",
            r"E:\League of Legends\lockfile",
        ];

        for path in &candidates {
            if let Ok(content) = fs::read_to_string(Path::new(path)) {
                let parts: Vec<&str> = content.split(':').collect();
                if parts.len() >= 5 {
                    let pid_alive = parts[1]
                        .trim()
                        .parse::<u32>()
                        .map(|pid| sys.processes().contains_key(&sysinfo::Pid::from_u32(pid)))
                        .unwrap_or(false);
                    if !has_lcu_process && !pid_alive {
                        continue;
                    }
                    if let Ok(port) = parts[2].parse::<u16>() {
                        let token = parts[3].to_string();
                        let raw = format!("riot:{}", token);
                        let auth_header = format!("Basic {}", BASE64.encode(raw.as_bytes()));
                        return Some(LcuAuth {
                            port,
                            token,
                            auth_header,
                        });
                    }
                }
            }
        }

        None
    }

    /// Fetch all champion summaries in Traditional Chinese from local LCU assets
    pub async fn fetch_champions(&self) -> Result<Vec<ChampionItem>, String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-game-data/assets/v1/champion-summary.json",
            auth.port
        );

        let res = self
            .http_client
            .get(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("HTTP error {}", res.status()));
        }

        let raw: Vec<serde_json::Value> = res.json().await.map_err(|e| e.to_string())?;
        let mut list = Vec::new();

        for item in raw {
            if !is_valid_standard_champion(&item) {
                continue;
            }
            let id = item.get("id").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = item
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let roles = item.get("roles").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            });
            list.push(ChampionItem {
                id,
                name,
                title,
                roles,
            });
        }

        // Sort alphabetically by name
        list.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(list)
    }

    /// Accept ready check
    pub async fn accept_ready_check(&self) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-matchmaking/v1/ready-check/accept",
            auth.port
        );
        let res = self
            .http_client
            .post(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP error {}", res.status()));
        }
        Ok(())
    }

    /// Swap with champion on ARAM bench
    pub async fn swap_bench(&self, champion_id: i32) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-champ-select/v1/session/bench/swap/{}",
            auth.port, champion_id
        );
        let res = self
            .http_client
            .post(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if res.status().is_success() {
            return Ok(());
        }
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            let fallback_url = format!(
                "https://127.0.0.1:{}/lol-lobby-team-builder/champ-select/v1/session/bench/swap/{}",
                auth.port, champion_id
            );
            let fb_res = self
                .http_client
                .post(&fallback_url)
                .header("Authorization", &auth.auth_header)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if fb_res.status().is_success() {
                return Ok(());
            }
            return Err(format!("HTTP error {}", fb_res.status()));
        }
        Err(format!("HTTP error {}", res.status()))
    }

    /// Set our summoner spells (`spell1Id` = D, `spell2Id` = F) during champion select.
    pub async fn set_summoner_spells(&self, spell1_id: i32, spell2_id: i32) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-champ-select/v1/session/my-selection",
            auth.port
        );
        let payload = serde_json::json!({
            "spell1Id": spell1_id,
            "spell2Id": spell2_id
        });
        let res = self
            .http_client
            .patch(&url)
            .header("Authorization", &auth.auth_header)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if res.status().is_success() {
            return Ok(());
        }
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            let fallback_url = format!(
                "https://127.0.0.1:{}/lol-lobby-team-builder/champ-select/v1/session/my-selection",
                auth.port
            );
            let fb_res = self
                .http_client
                .patch(&fallback_url)
                .header("Authorization", &auth.auth_header)
                .json(&payload)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if fb_res.status().is_success() {
                return Ok(());
            }
            return Err(format!("HTTP error {}", fb_res.status()));
        }
        Err(format!("HTTP error {}", res.status()))
    }

    /// Fetch the local player's champion mastery list sorted by mastery points descending.
    pub async fn fetch_champion_mastery(&self) -> Result<Vec<ChampionMasteryItem>, String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let primary_url = format!(
            "https://127.0.0.1:{}/lol-champion-mastery/v1/local-player/champion-mastery",
            auth.port
        );

        match self
            .http_client
            .get(&primary_url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => {
                if let Ok(raw) = res.json::<serde_json::Value>().await {
                    return Ok(parse_mastery_items(&raw));
                }
            }
            _ => {}
        }

        // Fallback via current-summoner -> collections champion-mastery (for older client builds)
        let summoner_url = format!(
            "https://127.0.0.1:{}/lol-summoner/v1/current-summoner",
            auth.port
        );
        let Ok(summoner_res) = self
            .http_client
            .get(&summoner_url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
        else {
            return Ok(Vec::new());
        };
        if !summoner_res.status().is_success() {
            return Ok(Vec::new());
        }
        let summoner_json: serde_json::Value = match summoner_res.json().await {
            Ok(v) => v,
            Err(_) => return Ok(Vec::new()),
        };
        let Some(summoner_id) = summoner_json.get("summonerId").and_then(|v| v.as_i64()) else {
            return Ok(Vec::new());
        };

        let fallback_url = format!(
            "https://127.0.0.1:{}/lol-collections/v1/inventories/{}/champion-mastery",
            auth.port, summoner_id
        );
        let fb_res = self
            .http_client
            .get(&fallback_url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !fb_res.status().is_success() {
            return Ok(Vec::new());
        }
        let raw: serde_json::Value = fb_res.json().await.map_err(|e| e.to_string())?;
        Ok(parse_mastery_items(&raw))
    }

    /// Fetch the logged-in account (`GET /lol-summoner/v1/current-summoner`).
    pub async fn fetch_current_summoner(&self) -> Option<serde_json::Value> {
        let auth = self.auth.read().await.clone()?;
        let url = format!(
            "https://127.0.0.1:{}/lol-summoner/v1/current-summoner",
            auth.port
        );
        let res = self
            .http_client
            .get(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json().await.ok()
    }

    /// Fetch the current ReadyCheck state (`GET /lol-matchmaking/v1/ready-check`).
    pub async fn fetch_ready_check(&self) -> Option<serde_json::Value> {
        let auth = self.auth.read().await.clone()?;
        let url = format!(
            "https://127.0.0.1:{}/lol-matchmaking/v1/ready-check",
            auth.port
        );
        let res = self
            .http_client
            .get(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json().await.ok()
    }

    /// Fetch the 2~3 offered ARAM / Mayhem champion cards (`GET /lol-lobby-team-builder/champ-select/v1/subset-champion-list`).
    pub async fn fetch_subset_champion_list(&self) -> Result<Vec<i32>, String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-lobby-team-builder/champ-select/v1/subset-champion-list",
            auth.port
        );
        let res = self
            .http_client
            .get(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP error {}", res.status()));
        }
        let raw: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        Ok(parse_subset_champion_list(&raw))
    }

    /// Fetch premade party member and friend identifiers (`puuid`s and `summonerId`s).
    pub async fn fetch_allied_friend_identifiers(
        &self,
    ) -> (
        std::collections::HashSet<String>,
        std::collections::HashSet<i64>,
    ) {
        let Some(auth) = self.auth.read().await.clone() else {
            return Default::default();
        };

        let lobby_url = format!("https://127.0.0.1:{}/lol-lobby/v2/lobby", auth.port);
        let friends_url = format!("https://127.0.0.1:{}/lol-chat/v1/friends", auth.port);

        let lobby_val = match self
            .http_client
            .get(&lobby_url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
            _ => None,
        };

        let friends_val = match self
            .http_client
            .get(&friends_url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
            _ => None,
        };

        extract_allied_identifiers(lobby_val.as_ref(), friends_val.as_ref())
    }

    /// Complete our own champion pick action (initial reveal card selection)
    pub async fn select_champion_card(
        &self,
        action_id: i64,
        champion_id: i32,
    ) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-champ-select/v1/session/actions/{}",
            auth.port, action_id
        );
        let payload = serde_json::json!({
            "championId": champion_id,
            "completed": true
        });

        let res = self
            .http_client
            .patch(&url)
            .header("Authorization", &auth.auth_header)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("HTTP error {}", res.status()));
        }
        Ok(())
    }

    /// Resolve the queue id of the ongoing gameflow session or lobby (450 = ARAM, 2400/3270 = Mayhem, -1 = non-ARAM custom/Practice Tool)
    pub async fn fetch_current_queue_id(&self) -> Option<i32> {
        let auth = self.auth.read().await.clone()?;
        let url = format!("https://127.0.0.1:{}/lol-gameflow/v1/session", auth.port);

        let session_val = match self
            .http_client
            .get(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => res.json::<serde_json::Value>().await.ok(),
            _ => None,
        };
        if let Some(qid) = resolve_queue_id_from_session_or_lobby(session_val.as_ref(), None) {
            return Some(qid);
        }

        // Fallback to `/lol-lobby/v2/lobby` when sitting in Lobby / Matchmaking / ReadyCheck
        let lobby_url = format!("https://127.0.0.1:{}/lol-lobby/v2/lobby", auth.port);
        let lobby_val = match self
            .http_client
            .get(&lobby_url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => res.json::<serde_json::Value>().await.ok(),
            _ => None,
        };
        resolve_queue_id_from_session_or_lobby(None, lobby_val.as_ref())
    }

    /// Fetch the live champ-select session snapshot
    pub async fn fetch_champ_select_session(&self) -> Result<serde_json::Value, String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-champ-select/v1/session",
            auth.port
        );
        let res = self
            .http_client
            .get(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP error {}", res.status()));
        }
        res.json().await.map_err(|e| e.to_string())
    }

    /// Fetch the current gameflow phase (e.g. "ChampSelect", "InProgress")
    pub async fn fetch_gameflow_phase(&self) -> Option<String> {
        let auth = self.auth.read().await.clone()?;
        let url = format!(
            "https://127.0.0.1:{}/lol-gameflow/v1/gameflow-phase",
            auth.port
        );
        let res = self
            .http_client
            .get(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<serde_json::Value>()
            .await
            .ok()?
            .as_str()
            .map(|s| s.to_string())
    }

    /// Accept trade with teammate.
    ///
    /// Riot renamed the swap API in recent client builds: `session/trades/{id}` no longer
    /// exists and the live route is `session/champion-swaps/{id}`. Both the new
    /// lobby-team-builder route and the legacy one are tried.
    pub async fn accept_trade(&self, trade_id: i64) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let mut last_error = String::from("champion-swaps accept endpoint unavailable");
        for base in [
            "/lol-lobby-team-builder/champ-select/v1/session/champion-swaps",
            "/lol-champ-select/v1/session/champion-swaps",
        ] {
            let url = format!(
                "https://127.0.0.1:{}{}/{}/accept",
                auth.port, base, trade_id
            );
            let res = self
                .http_client
                .post(&url)
                .header("Authorization", &auth.auth_header)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                // The endpoint answers 204 even for an unknown swap id, so confirm the
                // swap really left the pending list before reporting success.
                if self.swap_resolved(trade_id).await {
                    return Ok(());
                }
                last_error = "LCU 未確認換角已完成".to_string();
                continue;
            }
            last_error = format!("HTTP error {}", res.status());
            // 404 means this route does not exist on this client build: try the next one.
            if res.status() != reqwest::StatusCode::NOT_FOUND {
                return Err(last_error);
            }
        }
        Err(last_error)
    }

    /// True when the swap is no longer pending (accepted or removed from the list).
    pub async fn swap_resolved(&self, trade_id: i64) -> bool {
        let Ok(session) = self.fetch_champ_select_session().await else {
            // Cannot verify (no session): assume it worked rather than blocking the flow.
            return true;
        };
        let pending = session
            .get("trades")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter().any(|t| {
                    t.get("id").and_then(|v| v.as_i64()) == Some(trade_id)
                        && matches!(
                            t.get("state").and_then(|v| v.as_str()).unwrap_or(""),
                            "RECEIVED" | "AVAILABLE" | "SENT" | "PENDING"
                        )
                })
            })
            .unwrap_or(false);
        !pending
    }

    /// Decline trade with teammate (see `accept_trade` for the endpoint history).
    pub async fn decline_trade(&self, trade_id: i64) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let mut last_error = String::from("champion-swaps decline endpoint unavailable");
        for base in [
            "/lol-lobby-team-builder/champ-select/v1/session/champion-swaps",
            "/lol-champ-select/v1/session/champion-swaps",
        ] {
            let url = format!(
                "https://127.0.0.1:{}{}/{}/decline",
                auth.port, base, trade_id
            );
            let res = self
                .http_client
                .post(&url)
                .header("Authorization", &auth.auth_header)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                return Ok(());
            }
            last_error = format!("HTTP error {}", res.status());
            if res.status() != reqwest::StatusCode::NOT_FOUND {
                return Err(last_error);
            }
        }
        Err(last_error)
    }

    /// Start a 1-player Custom Mayhem (queue 3270) champ-select session for quick testing.
    pub async fn start_custom_test_session(&self) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let lobby_url = format!("https://127.0.0.1:{}/lol-lobby/v2/lobby", auth.port);

        // Check if already in a custom lobby
        let in_lobby = match self
            .http_client
            .get(&lobby_url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => true,
            _ => false,
        };

        if !in_lobby {
            let create_payload = serde_json::json!({
                "queueId": 3270,
                "isCustom": true,
                "customGameLobby": {
                    "lobbyName": "ARAM Assistant Test",
                    "lobbyPassword": "",
                    "configuration": {
                        "mapId": 12,
                        "gameMode": "KIWI",
                        "gameTypeConfig": { "id": 21 },
                        "spectatorPolicy": "NotAllowed",
                        "teamSize": 5
                    }
                }
            });
            let _ = self
                .http_client
                .post(&lobby_url)
                .header("Authorization", &auth.auth_header)
                .json(&create_payload)
                .send()
                .await;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        let search_url = format!(
            "https://127.0.0.1:{}/lol-lobby/v2/lobby/matchmaking/search",
            auth.port
        );
        let res = self
            .http_client
            .post(&search_url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP error {}", res.status()));
        }
        Ok(())
    }

    /// Quit an active custom champ-select session back to the lobby without launching the game.
    pub async fn quit_custom_champ_select(&self) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-lobby-team-builder/champ-select/v1/session/quit",
            auth.port
        );
        let res = self
            .http_client
            .post(&url)
            .header("Authorization", &auth.auth_header)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP error {}", res.status()));
        }
        Ok(())
    }
    pub async fn send_chat_message(&self, chat_id: &str, body: &str) -> Result<(), String> {
        let auth = self.auth.read().await.clone().ok_or("LCU not connected")?;
        let url = format!(
            "https://127.0.0.1:{}/lol-chat/v1/conversations/{}/messages",
            auth.port, chat_id
        );
        let payload = serde_json::json!({
            "body": body,
            "type": "chat"
        });
        let res = self
            .http_client
            .post(&url)
            .header("Authorization", &auth.auth_header)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP error {}", res.status()));
        }
        Ok(())
    }

    /// Start the background watcher loop
    pub fn start_watcher(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                let detected = Self::detect_auth();

                match detected {
                    Some(new_auth) => {
                        let current = self.auth.read().await.clone();
                        let changed = match &current {
                            None => true,
                            Some(curr) => {
                                curr.port != new_auth.port || curr.token != new_auth.token
                            }
                        };

                        if changed {
                            *self.auth.write().await = Some(new_auth.clone());
                            let _ = self.status_tx.send(ConnectionStatus {
                                connected: true,
                                port: Some(new_auth.port),
                            });
                        }

                        // Reconnect the websocket whenever the previous one died.
                        if !self.ws_connected.load(Ordering::SeqCst) {
                            self.ws_connected.store(true, Ordering::SeqCst);
                            let manager_clone = Arc::clone(&self);
                            let auth_clone = new_auth.clone();
                            tauri::async_runtime::spawn(async move {
                                manager_clone.run_websocket(auth_clone).await;
                            });
                        }
                    }
                    None => {
                        if self.auth.read().await.is_some() {
                            *self.auth.write().await = None;
                            let _ = self.status_tx.send(ConnectionStatus {
                                connected: false,
                                port: None,
                            });
                        }
                    }
                }

                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
    }

    /// Run the persistent WebSocket listener to receive LCU events
    async fn run_websocket(&self, auth: LcuAuth) {
        self.run_websocket_inner(auth).await;
        // Whatever ended the stream (connect/subscribe error, close, stream error),
        // flag it so the watcher spawns a fresh connection on its next tick.
        self.ws_connected.store(false, Ordering::SeqCst);
    }

    async fn run_websocket_inner(&self, auth: LcuAuth) {
        let ws_url = format!("wss://127.0.0.1:{}/", auth.port);

        let mut request = match ws_url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Invalid WS URL: {}", e);
                return;
            }
        };

        if let Ok(val) = HeaderValue::from_str(&auth.auth_header) {
            request.headers_mut().insert("Authorization", val);
        }

        let mut tls_builder = native_tls::TlsConnector::builder();
        tls_builder.danger_accept_invalid_certs(true);
        let connector = match tls_builder.build() {
            Ok(c) => tokio_tungstenite::Connector::NativeTls(c),
            Err(e) => {
                eprintln!("Failed to build TLS connector: {}", e);
                return;
            }
        };

        match tokio_tungstenite::connect_async_tls_with_config(
            request,
            None,
            false,
            Some(connector),
        )
        .await
        {
            Ok((mut ws_stream, _)) => {
                // Subscribe to all JSON API events: [5, "OnJsonApiEvent"]
                let sub_msg = serde_json::json!([5, "OnJsonApiEvent"]).to_string();
                if let Err(e) = ws_stream.send(Message::Text(sub_msg.into())).await {
                    eprintln!("Failed to subscribe to LCU events: {}", e);
                    return;
                }

                while let Some(msg_result) = ws_stream.next().await {
                    match msg_result {
                        Ok(Message::Text(txt)) => {
                            // Text format is: [8, "OnJsonApiEvent", { uri: "...", data: ..., eventType: "..." }]
                            if let Ok(serde_json::Value::Array(arr)) =
                                serde_json::from_str::<serde_json::Value>(&txt)
                                && arr.len() >= 3
                                && arr[0].as_i64() == Some(8)
                                && let Ok(event) =
                                    serde_json::from_value::<LcuEvent>(arr[2].clone())
                            {
                                // Only broadcast the gameflow, ready-check, champ-select and
                                // current-summoner URIs we actually use so noisy LCU telemetry/
                                // presence events never lag the channel or flood IPC. The
                                // summoner URI catches account switches that happen while the
                                // LCU connection stays up (no reconnect, no status event).
                                if matches!(
                                    event.uri.as_str(),
                                    "/lol-gameflow/v1/gameflow-phase"
                                        | "/lol-matchmaking/v1/ready-check"
                                        | "/lol-champ-select/v1/session"
                                        | "/lol-summoner/v1/current-summoner"
                                ) {
                                    let _ = self.event_tx.send(event);
                                }
                            }
                        }
                        Ok(Message::Close(_)) => break,
                        Err(_) => break,
                        _ => {}
                    }
                }
            }
            Err(e) => {
                eprintln!("Failed to connect to LCU websocket: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_standard_champion_is_valid() {
        let item = json!({
            "id": 103,
            "name": "阿璃",
            "alias": "Ahri",
            "roles": ["mage", "assassin"]
        });
        assert!(is_valid_standard_champion(&item));
    }

    #[test]
    fn test_dummy_champion_is_rejected() {
        let item = json!({
            "id": -1,
            "name": "-1",
            "alias": "None",
            "roles": []
        });
        assert!(!is_valid_standard_champion(&item));
    }

    #[test]
    fn test_classic_mode_champion_is_rejected() {
        let item = json!({
            "id": 60001,
            "name": "Jade_Annie",
            "alias": "Jade_Annie",
            "roles": ["mage"]
        });
        assert!(!is_valid_standard_champion(&item));

        // A normal id with a Jade_/TFT alias must be rejected as well.
        let jade_alias = json!({
            "id": 900,
            "name": "安妮",
            "alias": "Jade_Annie",
            "roles": ["mage"]
        });
        assert!(!is_valid_standard_champion(&jade_alias));

        let tft_alias = json!({
            "id": 901,
            "name": "測試單位",
            "alias": "TFT_Unit",
            "roles": ["mage"]
        });
        assert!(!is_valid_standard_champion(&tft_alias));
    }

    #[test]
    fn test_parse_mastery_items_filters_and_sorts_descending() {
        let raw = json!([
            { "championId": 81, "championLevel": 5, "championPoints": 45000, "lastPlayTime": 100 },
            { "championId": 60001, "championLevel": 9, "championPoints": 999999, "lastPlayTime": 200 },
            { "championId": 103, "championLevel": 10, "championPoints": 180000, "lastPlayTime": 300 },
            { "championId": -1, "championLevel": 1, "championPoints": 500, "lastPlayTime": 50 }
        ]);
        let parsed = parse_mastery_items(&raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].champion_id, 103);
        assert_eq!(parsed[0].champion_points, 180000);
        assert_eq!(parsed[1].champion_id, 81);
    }

    #[test]
    fn test_parse_subset_champion_list_handles_ints_and_objects() {
        let raw_ints = json!([103, 81, 267, 103, -1, 60001]);
        assert_eq!(parse_subset_champion_list(&raw_ints), vec![103, 81, 267]);

        let raw_objs = json!([{ "championId": 99 }, { "id": 115 }]);
        assert_eq!(parse_subset_champion_list(&raw_objs), vec![99, 115]);
    }

    #[test]
    fn test_parse_account_identity_prefers_game_name_and_tag() {
        let raw = json!({
            "puuid": "summoner-puuid",
            "gameName": "測試玩家",
            "tagLine": "TW1"
        });
        let info = parse_account_identity(&raw).expect("Should parse");
        assert_eq!(info.puuid, "summoner-puuid");
        assert_eq!(info.display_name, "測試玩家#TW1");
    }

    #[test]
    fn test_parse_account_identity_falls_back_to_display_name_and_rejects_missing_puuid() {
        let legacy = json!({ "puuid": "p", "displayName": "舊名" });
        assert_eq!(
            parse_account_identity(&legacy).expect("Should parse").display_name,
            "舊名"
        );
        let no_puuid = json!({ "gameName": "無名", "tagLine": "X" });
        assert!(parse_account_identity(&no_puuid).is_none());
        let empty_puuid = json!({ "puuid": "", "gameName": "無名" });
        assert!(parse_account_identity(&empty_puuid).is_none());
    }

    #[test]
    fn test_extract_allied_identifiers_excludes_self_and_includes_party_and_friends() {
        let lobby = json!({
            "localMember": { "puuid": "me-puuid", "summonerId": 1001 },
            "members": [
                { "puuid": "me-puuid", "summonerId": 1001 },
                { "puuid": "premade-puuid", "summonerId": 1002 }
            ]
        });
        let friends = json!([
            { "puuid": "friend-puuid", "summonerId": 2001 }
        ]);

        let (puuids, sids) = extract_allied_identifiers(Some(&lobby), Some(&friends));
        assert!(!puuids.contains("me-puuid"));
        assert!(!sids.contains(&1001));
        assert!(puuids.contains("premade-puuid"));
        assert!(sids.contains(&1002));
        assert!(puuids.contains("friend-puuid"));
        assert!(sids.contains(&2001));
    }

    #[test]
    fn test_resolve_queue_id_distinguishes_practice_tool_and_sr_from_aram_mayhem() {
        // Practice tool on Summoner's Rift (queueId -1, map 11, PRACTICETOOL) -> -1 (not None!)
        let practice_session = json!({
            "gameData": { "queue": { "id": -1, "gameMode": "PRACTICETOOL" } },
            "map": { "id": 11, "gameMode": "PRACTICETOOL" }
        });
        assert_eq!(
            resolve_queue_id_from_session_or_lobby(Some(&practice_session), None),
            Some(-1)
        );

        // Summoner's Rift Solo/Duo Ranked (420)
        let sr_ranked = json!({
            "gameData": { "queue": { "id": 420, "gameMode": "CLASSIC" } },
            "map": { "id": 11, "gameMode": "CLASSIC" }
        });
        assert_eq!(
            resolve_queue_id_from_session_or_lobby(Some(&sr_ranked), None),
            Some(420)
        );

        // Custom Mayhem lobby where queueId is -1 but gameMode is KIWI -> 3270
        let custom_mayhem_lobby = json!({
            "gameConfig": { "queueId": -1, "gameMode": "KIWI", "mapId": 12 }
        });
        assert_eq!(
            resolve_queue_id_from_session_or_lobby(None, Some(&custom_mayhem_lobby)),
            Some(3270)
        );

        // Custom Howling Abyss ARAM lobby where queueId is -1 -> 3200
        let custom_aram_lobby = json!({
            "gameConfig": { "queueId": -1, "gameMode": "ARAM", "mapId": 12 }
        });
        assert_eq!(
            resolve_queue_id_from_session_or_lobby(None, Some(&custom_aram_lobby)),
            Some(3200)
        );
    }
}
