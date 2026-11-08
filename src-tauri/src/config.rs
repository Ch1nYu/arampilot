use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChampionProfileItem {
    pub id: i32,
    pub name: String,
    pub tier: String, // "本命", "愛角", "順手", "勉強", "封印", "未分類"
    pub flag: String, // "", "lock", "give", "nograb"
    #[serde(default)]
    pub elo: Option<f64>,
    #[serde(default)]
    pub matches: Option<u32>,
    /// Remembered secondary summoner spell (Ghost/Mark/...) for this champion.
    #[serde(default)]
    pub secondary_spell: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ModeSettings {
    pub auto_card_select: bool,
    pub card_select_delay_sec: f64,
    pub card_select_strategy: String, // "highest_score", "only_top_tiers"

    pub auto_bench_swap: bool,
    pub bench_diff_threshold: i32,
    pub lock_stop_bench: bool,
    pub stop_bench_remaining_sec: i32,

    pub auto_trade: bool,
    pub trade_accept_diff: i32,
    pub trade_reject_tiers: Vec<String>, // e.g. ["本命"]
    pub friend_trade_policy: String,     // "auto_accept", "manual", "same_as_stranger"

    pub default_secondary_spell: i32, // 6 = 鬼步 (Ghost) when no per-champion memory exists
}

impl Default for ModeSettings {
    fn default() -> Self {
        Self {
            auto_card_select: true,
            card_select_delay_sec: 1.5,
            card_select_strategy: "highest_score".to_string(),
            auto_bench_swap: true,
            bench_diff_threshold: 10,
            lock_stop_bench: true,
            stop_bench_remaining_sec: 5,
            auto_trade: true,
            trade_accept_diff: 10,
            trade_reject_tiers: vec!["本命".to_string()],
            friend_trade_policy: "manual".to_string(),
            default_secondary_spell: 6,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub master_enabled: bool,
    pub accent_color: String, // "crimson", "amber", "emerald", "violet"

    // Summoner spells
    pub auto_summoner_spells: bool,
    pub primary_spell_key: String, // "D" or "F"

    // Matchmaking
    pub auto_accept: bool,
    pub accept_delay_sec: f64,
    pub accept_modes: Vec<String>, // ["ARAM", "Mayhem"]
    pub accept_notify: String,     // "mute", "sound", "notification"

    // Mode-specific automation settings
    pub aram_settings: ModeSettings,
    pub mayhem_settings: ModeSettings,

    // Chat
    pub auto_chat_on_swap: bool,
    pub chat_delay_sec: f64,
    pub chat_messages: Vec<String>,
    pub chat_on_accept_teammate: bool,
    pub chat_on_teammate_accept_mine: bool,

    // Surrender reminder
    pub ff_reminder: bool,
    pub ff_time_aram: String,
    pub ff_time_mayhem: String,
    pub ff_kill_diff_threshold: i32,
    pub ff_cooldown_reminder: bool,
    pub ff_copy_clipboard: bool,
    pub ff_play_sound: bool,
    pub ff_desktop_notify: bool,

    // Window & behavior
    pub client_close_action: String, // "wait", "exit"
    pub close_to_tray: bool,
    pub auto_start: bool,

    // Profiles
    pub aram_profile: Vec<ChampionProfileItem>,
    pub mayhem_profile: Vec<ChampionProfileItem>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            master_enabled: true,
            accent_color: "crimson".to_string(),
            auto_summoner_spells: true,
            primary_spell_key: "D".to_string(),
            auto_accept: true,
            accept_delay_sec: 2.0,
            accept_modes: vec!["ARAM".to_string(), "Mayhem".to_string()],
            accept_notify: "sound".to_string(),
            aram_settings: ModeSettings::default(),
            mayhem_settings: ModeSettings::default(),
            auto_chat_on_swap: true,
            chat_delay_sec: 1.0,
            chat_messages: vec![
                "謝啦！{new} 交給我".to_string(),
                "感謝換角，這把順風～".to_string(),
                "{old} 給你，{new} 我來 🙏".to_string(),
            ],
            chat_on_accept_teammate: true,
            chat_on_teammate_accept_mine: true,
            ff_reminder: false,
            ff_time_aram: "08:00".to_string(),
            ff_time_mayhem: "08:00".to_string(),
            ff_kill_diff_threshold: 0,
            ff_cooldown_reminder: false,
            ff_copy_clipboard: false,
            ff_play_sound: true,
            ff_desktop_notify: false,
            client_close_action: "wait".to_string(),
            close_to_tray: true,
            auto_start: false,
            aram_profile: Vec::new(),
            mayhem_profile: Vec::new(),
        }
    }
}

impl AppConfig {
    /// Drop classic-mode / dummy champion ids and duplicate entries from saved profiles, then
    /// unify ARAM and Mayhem into one shared ranking so both modes use the same champion order.
    pub fn sanitize(&mut self) {
        sanitize_profile(&mut self.aram_profile);
        sanitize_profile(&mut self.mayhem_profile);
        let unified = unify_profiles(&self.aram_profile, &self.mayhem_profile);
        self.aram_profile = unified.clone();
        self.mayhem_profile = unified;
    }
}

/// Keep only standard champion ids (`0 < id < 10000`) and dedupe by id, preserving order.
fn sanitize_profile(profile: &mut Vec<ChampionProfileItem>) {
    let mut seen: std::collections::HashSet<i32> = std::collections::HashSet::new();
    profile.retain(|item| item.id > 0 && item.id < 10000 && seen.insert(item.id));
}

fn classified_count(profile: &[ChampionProfileItem]) -> usize {
    profile.iter().filter(|c| c.tier != "未分類").count()
}

fn is_main_pick(item: &ChampionProfileItem) -> bool {
    item.tier == "本命"
}

/// Pick the richer of the two profiles and merge the other one into it.
///
/// Both modes share one ranking, so every `elo` / `matches` / `secondary_spell` value from
/// either side is preserved on the unified list.
fn unify_profiles(
    aram: &[ChampionProfileItem],
    mayhem: &[ChampionProfileItem],
) -> Vec<ChampionProfileItem> {
    let aram_classified = classified_count(aram);
    let mayhem_classified = classified_count(mayhem);
    let mayhem_is_primary = mayhem_classified > aram_classified
        || (mayhem_classified == aram_classified
            && !mayhem.is_empty()
            && (mayhem.iter().filter(|c| is_main_pick(c)).count()
                > aram.iter().filter(|c| is_main_pick(c)).count()
                || mayhem.iter().filter(|c| c.secondary_spell.is_some()).count()
                    > aram.iter().filter(|c| c.secondary_spell.is_some()).count()));

    let (primary, secondary) = if mayhem_is_primary {
        (mayhem, aram)
    } else {
        (aram, mayhem)
    };

    let mut unified: Vec<ChampionProfileItem> = primary
        .iter()
        .map(|item| {
            let mut merged = item.clone();
            if let Some(donor) = secondary.iter().find(|c| c.id == item.id) {
                if merged.elo.is_none() {
                    merged.elo = donor.elo;
                }
                if merged.matches.is_none() {
                    merged.matches = donor.matches;
                }
                if merged.secondary_spell.is_none() {
                    merged.secondary_spell = donor.secondary_spell;
                }
                if merged.flag.is_empty() {
                    merged.flag = donor.flag.clone();
                }
            }
            merged
        })
        .collect();

    for item in secondary {
        if item.id > 0 && item.id < 10000 && !unified.iter().any(|c| c.id == item.id) {
            unified.push(item.clone());
        }
    }
    unified
}

pub struct ConfigManager {
    dir: PathBuf,
    config_path: PathBuf,
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigManager {
    pub fn new() -> Self {
        Self::at(dirs_fallback())
    }

    /// A manager rooted at an explicit directory (tests and per-account files).
    pub fn at(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let config_path = dir.join("config.json");
        Self { dir, config_path }
    }

    /// Bind to the file owned by the account identified by `puuid`.
    ///
    /// Every account owns its own `config-<puuid>.json`, however many there are;
    /// there is no primary/secondary hierarchy. With no account logged in, the
    /// last used account's file is restored (or `config.json` before any account
    /// has ever been seen).
    pub fn for_account(puuid: Option<&str>) -> Self {
        Self::for_account_in(&dirs_fallback(), puuid)
    }

    /// `for_account` rooted at an explicit directory (tests).
    pub fn for_account_in(dir: &std::path::Path, puuid: Option<&str>) -> Self {
        let base = Self::at(dir.to_path_buf());
        let config_path = base.account_config_path(puuid);
        Self {
            dir: base.dir,
            config_path,
        }
    }

    fn accounts_index_path(&self) -> PathBuf {
        self.dir.join("accounts.json")
    }

    /// The puuid of the account used most recently, if one has been recorded.
    pub fn last_puuid(&self) -> Option<String> {
        let content = fs::read_to_string(self.accounts_index_path()).ok()?;
        let index: serde_json::Value = serde_json::from_str(&content).ok()?;
        index
            .get("last_puuid")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// Remember `puuid` as the most recently used account (startup restore).
    pub fn record_last_puuid(&self, puuid: &str) {
        let index = serde_json::json!({ "last_puuid": puuid });
        let Ok(json) = serde_json::to_string_pretty(&index) else {
            return;
        };
        let _ = fs::write(self.accounts_index_path(), json);
    }

    /// Resolve which file `puuid` owns. Pure mapping lives in
    /// [`account_config_file_name`].
    fn account_config_path(&self, puuid: Option<&str>) -> PathBuf {
        let puuid = match puuid.map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => p.to_string(),
            None => match self.last_puuid() {
                Some(last) => last,
                None => return self.dir.join("config.json"),
            },
        };
        let file = account_config_file_name(&puuid);
        self.dir.join(file)
    }

    pub fn load(&self) -> AppConfig {
        if self.config_path.exists()
            && let Ok(content) = fs::read_to_string(&self.config_path)
            && let Ok(mut config) = serde_json::from_str::<AppConfig>(&content)
        {
            let aram_before = config.aram_profile.clone();
            let mayhem_before = config.mayhem_profile.clone();
            let modes_differed = aram_before != mayhem_before;
            config.sanitize();
            if modes_differed
                || config.aram_profile != aram_before
                || config.mayhem_profile != mayhem_before
            {
                let _ = self.save(&config);
            }
            return config;
        }
        let default_config = AppConfig::default();
        let _ = self.save(&default_config);
        default_config
    }

    pub fn save(&self, config: &AppConfig) -> Result<(), String> {
        let mut sanitized = config.clone();
        sanitized.sanitize();
        let json = serde_json::to_string_pretty(&sanitized).map_err(|e| e.to_string())?;
        fs::write(&self.config_path, json).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Which file owns `puuid`: every account owns its own `config-<puuid>.json`,
/// however many accounts there are. There is no primary/secondary hierarchy.
pub fn account_config_file_name(puuid: &str) -> String {
    format!("config-{}.json", safe_file_stem(puuid))
}

/// Keep a puuid safe to embed in a file name (alphanumeric, `_`, `-`; max 64 chars).
pub fn safe_file_stem(puuid: &str) -> String {
    let stem: String = puuid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    stem.chars().take(64).collect()
}

/// Mirror the `auto_start` setting into the current user's Windows Run key.
///
/// Only the Tauri command calls this so unit tests never touch the registry.
#[cfg(target_os = "windows")]
pub fn sync_windows_auto_start(enabled: bool) {
    use std::os::windows::process::CommandExt;

    // CREATE_NO_WINDOW keeps a console window from flashing on every save.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "LoLAramAssistant";

    let mut command = std::process::Command::new("reg");
    command.stdin(std::process::Stdio::null());
    if enabled {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let launch = format!("\"{}\" --minimized", exe.display());
        command.args([
            "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", &launch, "/f",
        ]);
    } else {
        command.args(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
        // Suppress the "registry key not found" noise when auto-start was never enabled.
        command.stderr(std::process::Stdio::null());
    }
    let _ = command.creation_flags(CREATE_NO_WINDOW).status();
}

#[cfg(not(target_os = "windows"))]
pub fn sync_windows_auto_start(_enabled: bool) {}

fn dirs_fallback() -> PathBuf {
    if let Some(app_data) = std::env::var_os("APPDATA") {
        PathBuf::from(app_data).join("lol-aram-assistant")
    } else {
        PathBuf::from("config")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_item(id: i32) -> ChampionProfileItem {
        ChampionProfileItem {
            id,
            name: format!("英雄{}", id),
            tier: "本命".to_string(),
            flag: "".to_string(),
            elo: None,
            matches: None,
            secondary_spell: None,
        }
    }

    fn ids(profile: &[ChampionProfileItem]) -> Vec<i32> {
        profile.iter().map(|c| c.id).collect()
    }

    #[test]
    fn test_app_config_default_values() {
        let cfg = AppConfig::default();
        assert!(cfg.master_enabled);
        assert_eq!(cfg.accent_color, "crimson");
        assert!(cfg.auto_accept);
        assert_eq!(cfg.accept_delay_sec, 2.0);
        assert_eq!(cfg.accept_notify, "sound");
        assert_eq!(cfg.aram_settings.bench_diff_threshold, 10);
        assert_eq!(cfg.aram_settings.trade_accept_diff, 10);
        assert_eq!(cfg.aram_settings.trade_reject_tiers, vec!["本命"]);
        assert_eq!(cfg.aram_settings.friend_trade_policy, "manual");
        assert!(cfg.auto_chat_on_swap);
        assert!(!cfg.chat_messages.is_empty());
        assert!(cfg.chat_on_accept_teammate);
        assert!(cfg.chat_on_teammate_accept_mine);
        assert!(!cfg.ff_copy_clipboard);
        assert!(cfg.ff_play_sound);
        assert!(!cfg.ff_desktop_notify);
        assert_eq!(cfg.client_close_action, "wait");
    }

    #[test]
    fn test_window_behavior_defaults() {
        let cfg = AppConfig::default();
        assert!(
            cfg.close_to_tray,
            "closing the window must retreat to the tray by default"
        );
        assert!(!cfg.auto_start, "Windows auto-start is opt-in");
    }

    #[test]
    fn test_legacy_config_without_new_fields_still_deserializes() {
        // A config.json written before the UI-toggle fields existed.
        let legacy = serde_json::json!({
            "master_enabled": false,
            "accent_color": "violet",
            "auto_accept": false,
            "accept_delay_sec": 1.5,
            "accept_modes": ["ARAM"],
            "aram_settings": {
                "auto_card_select": true,
                "card_select_delay_sec": 3.0,
                "card_select_strategy": "highest_score",
                "auto_bench_swap": true,
                "bench_diff_threshold": 10,
                "lock_stop_bench": true,
                "stop_bench_remaining_sec": 5,
                "auto_trade": true,
                "trade_accept_diff": 10,
                "trade_reject_tiers": ["本命"]
            },
            "mayhem_settings": {
                "auto_card_select": true,
                "card_select_delay_sec": 3.0,
                "card_select_strategy": "highest_score",
                "auto_bench_swap": true,
                "bench_diff_threshold": 10,
                "lock_stop_bench": true,
                "stop_bench_remaining_sec": 5,
                "auto_trade": true,
                "trade_accept_diff": 10,
                "trade_reject_tiers": ["本命"]
            },
            "auto_chat_on_swap": true,
            "chat_delay_sec": 1.0,
            "chat_messages": ["謝啦！{new} 交給我"],
            "ff_reminder": false,
            "ff_time_aram": "08:00",
            "ff_time_mayhem": "08:00",
            "ff_kill_diff_threshold": 0,
            "ff_cooldown_reminder": false,
            "close_to_tray": true,
            "auto_start": false,
            "aram_profile": [],
            "mayhem_profile": []
        });

        let cfg: AppConfig = serde_json::from_value(legacy).expect("Legacy config must load");
        assert!(!cfg.master_enabled);
        assert_eq!(cfg.accent_color, "violet");
        assert_eq!(cfg.accept_notify, "sound");
        assert_eq!(cfg.aram_settings.friend_trade_policy, "manual");
        assert_eq!(cfg.mayhem_settings.friend_trade_policy, "manual");
        assert!(cfg.chat_on_accept_teammate);
        assert!(cfg.chat_on_teammate_accept_mine);
        assert!(!cfg.ff_copy_clipboard);
        assert!(cfg.ff_play_sound);
        assert!(!cfg.ff_desktop_notify);
        assert_eq!(cfg.client_close_action, "wait");
    }

    #[test]
    fn test_config_json_roundtrip() {
        let mut cfg = AppConfig {
            accent_color: "emerald".to_string(),
            ..AppConfig::default()
        };
        cfg.aram_settings.bench_diff_threshold = 15;
        cfg.aram_profile.push(ChampionProfileItem {
            id: 103,
            name: "阿璃".to_string(),
            tier: "本命".to_string(),
            flag: "lock".to_string(),
            elo: Some(1650.0),
            matches: Some(5),
            secondary_spell: Some(32),
        });

        let serialized = serde_json::to_string(&cfg).expect("Serialization failed");
        let deserialized: AppConfig =
            serde_json::from_str(&serialized).expect("Deserialization failed");

        assert_eq!(deserialized.accent_color, "emerald");
        assert_eq!(deserialized.aram_settings.bench_diff_threshold, 15);
        assert_eq!(deserialized.aram_profile.len(), 1);
        assert_eq!(deserialized.aram_profile[0].name, "阿璃");
        assert_eq!(deserialized.aram_profile[0].flag, "lock");
        assert_eq!(deserialized.aram_profile[0].secondary_spell, Some(32));
        assert_eq!(deserialized.aram_profile[0].elo, Some(1650.0));
        assert_eq!(deserialized.aram_profile[0].matches, Some(5));
    }

    #[test]
    fn test_summoner_spell_defaults() {
        let cfg = AppConfig::default();
        assert!(cfg.auto_summoner_spells, "auto summoner spells is on by default");
        assert_eq!(cfg.primary_spell_key, "D", "Flash goes on D by default");
        assert_eq!(cfg.aram_settings.default_secondary_spell, 6, "Ghost by default");
        assert_eq!(cfg.mayhem_settings.default_secondary_spell, 6);
        assert_eq!(
            ChampionProfileItem::default().secondary_spell,
            None,
            "no per-champion memory until the user picks one"
        );
    }

    #[test]
    fn test_summoner_spell_json_roundtrip() {
        let mut cfg = AppConfig {
            auto_summoner_spells: false,
            primary_spell_key: "F".to_string(),
            ..AppConfig::default()
        };
        cfg.aram_settings.default_secondary_spell = 32;
        cfg.mayhem_settings.default_secondary_spell = 13;
        cfg.aram_profile.push(ChampionProfileItem {
            id: 81,
            name: "伊澤瑞爾".to_string(),
            tier: "愛角".to_string(),
            flag: "".to_string(),
            elo: Some(1700.0),
            matches: Some(9),
            secondary_spell: Some(14),
        });

        let serialized = serde_json::to_string(&cfg).expect("Serialization failed");
        let back: AppConfig = serde_json::from_str(&serialized).expect("Deserialization failed");

        assert!(!back.auto_summoner_spells);
        assert_eq!(back.primary_spell_key, "F");
        assert_eq!(back.aram_settings.default_secondary_spell, 32);
        assert_eq!(back.mayhem_settings.default_secondary_spell, 13);
        assert_eq!(back.aram_profile[0].secondary_spell, Some(14));
        assert_eq!(back.aram_profile[0].elo, Some(1700.0));
        assert_eq!(back.aram_profile[0].matches, Some(9));
    }

    #[test]
    fn test_profile_without_secondary_spell_still_loads() {
        // Profiles saved before per-champion spell memory existed.
        let legacy = serde_json::json!({
            "id": 103,
            "name": "阿璃",
            "tier": "本命",
            "flag": "",
            "elo": 1620.0,
            "matches": 4
        });
        let item: ChampionProfileItem =
            serde_json::from_value(legacy).expect("Legacy profile item must load");
        assert_eq!(item.id, 103);
        assert_eq!(item.secondary_spell, None);
        assert_eq!(item.elo, Some(1620.0));
        assert_eq!(item.matches, Some(4));
    }

    #[test]
    fn test_config_manager_temp_file_save_and_load() {
        let temp_dir = std::env::temp_dir().join(format!("lol_cfg_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let config_file = temp_dir.join("config.json");

        let cm = ConfigManager::at(temp_dir.clone());

        // File does not exist yet -> should return default
        let loaded_default = cm.load();
        assert_eq!(loaded_default.accent_color, "crimson");
        assert!(config_file.exists());

        // Modify and save
        let mut modified = loaded_default;
        modified.accent_color = "violet".to_string();
        modified.accept_delay_sec = 4.5;
        cm.save(&modified).expect("Save should succeed");

        // Load again
        let reloaded = cm.load();
        assert_eq!(reloaded.accent_color, "violet");
        assert_eq!(reloaded.accept_delay_sec, 4.5);

        // Cleanup
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_sanitize_removes_invalid_ids_and_duplicates() {
        let mut cfg = AppConfig {
            aram_profile: vec![
                profile_item(103),
                profile_item(60001),
                profile_item(-1),
                profile_item(0),
                profile_item(103),
                profile_item(81),
            ],
            mayhem_profile: vec![profile_item(267), profile_item(267), profile_item(60001)],
            ..AppConfig::default()
        };

        cfg.sanitize();

        // Both modes are unified onto the richer ARAM ranking, including Mayhem-only 267.
        assert_eq!(ids(&cfg.aram_profile), vec![103, 81, 267]);
        assert_eq!(ids(&cfg.mayhem_profile), vec![103, 81, 267]);
    }

    #[test]
    fn test_sanitize_unifies_aram_and_mayhem_profiles() {
        let mut cfg = AppConfig {
            aram_profile: vec![ChampionProfileItem {
                id: 103,
                name: "阿璃".to_string(),
                tier: "本命".to_string(),
                flag: "".to_string(),
                elo: Some(1650.0),
                matches: Some(7),
                secondary_spell: None,
            }],
            mayhem_profile: vec![
                ChampionProfileItem {
                    id: 103,
                    name: "阿璃".to_string(),
                    tier: "本命".to_string(),
                    flag: "".to_string(),
                    elo: None,
                    matches: None,
                    secondary_spell: Some(6),
                },
                ChampionProfileItem {
                    id: 498,
                    name: "剎雅".to_string(),
                    tier: "本命".to_string(),
                    flag: "".to_string(),
                    elo: Some(1580.0),
                    matches: Some(3),
                    secondary_spell: Some(6),
                },
            ],
            ..AppConfig::default()
        };

        cfg.sanitize();

        // Mayhem has the extra 本命 champion, so its order wins for both modes.
        assert_eq!(ids(&cfg.aram_profile), vec![103, 498]);
        assert_eq!(ids(&cfg.mayhem_profile), vec![103, 498]);
        assert_eq!(cfg.aram_profile, cfg.mayhem_profile);

        // ARAM-only elo/matches are backfilled; Mayhem's spell memory is kept.
        let aram_ahri = &cfg.aram_profile[0];
        assert_eq!(aram_ahri.elo, Some(1650.0));
        assert_eq!(aram_ahri.matches, Some(7));
        assert_eq!(aram_ahri.secondary_spell, Some(6));

        let xayah = &cfg.mayhem_profile[1];
        assert_eq!(xayah.name, "剎雅");
        assert_eq!(xayah.tier, "本命");
        assert_eq!(xayah.elo, Some(1580.0));
        assert_eq!(xayah.matches, Some(3));
        assert_eq!(xayah.secondary_spell, Some(6));
    }

    #[test]
    fn test_load_sanitizes_saved_profiles_and_writes_back() {
        let temp_dir =
            std::env::temp_dir().join(format!("lol_cfg_sanitize_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let config_file = temp_dir.join("config.json");

        let dirty = AppConfig {
            aram_profile: vec![profile_item(60001), profile_item(103), profile_item(103)],
            mayhem_profile: vec![profile_item(-1)],
            ..AppConfig::default()
        };
        fs::write(
            &config_file,
            serde_json::to_string(&dirty).expect("Serialization failed"),
        )
        .expect("Write should succeed");

        let cm = ConfigManager::at(temp_dir.clone());
        let loaded = cm.load();
        assert_eq!(ids(&loaded.aram_profile), vec![103]);
        assert_eq!(ids(&loaded.mayhem_profile), vec![103]);

        // The cleaned profile is persisted back to disk.
        let on_disk: AppConfig =
            serde_json::from_str(&fs::read_to_string(&config_file).expect("Read should succeed"))
                .expect("Deserialization failed");
        assert_eq!(ids(&on_disk.aram_profile), vec![103]);
        assert_eq!(ids(&on_disk.mayhem_profile), vec![103]);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_account_config_file_name_mapping() {
        // Every account owns its own file; no primary/secondary hierarchy.
        assert_eq!(account_config_file_name("puuid-a"), "config-puuid-a.json");
        assert_eq!(account_config_file_name("puuid-b"), "config-puuid-b.json");
    }

    #[test]
    fn test_safe_file_stem_sanitizes_puuid() {
        assert_eq!(safe_file_stem("abc-123_DEF"), "abc-123_DEF");
        assert_eq!(safe_file_stem("../evil path;x"), "---evil-path-x");
        assert_eq!(safe_file_stem(&"a".repeat(100)).len(), 64);
    }

    #[test]
    fn test_each_account_binds_to_its_own_file() {
        let temp_dir =
            std::env::temp_dir().join(format!("lol_cfg_account_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        let _ = fs::create_dir_all(&temp_dir);

        // Two accounts, two files; neither owns the shared config.json.
        let first = ConfigManager::for_account_in(&temp_dir, Some("puuid-one"));
        assert_eq!(first.config_path, temp_dir.join("config-puuid-one.json"));

        let second = ConfigManager::for_account_in(&temp_dir, Some("puuid-two"));
        assert_eq!(second.config_path, temp_dir.join("config-puuid-two.json"));

        // No account logged in: restore the most recently recorded account.
        let base = ConfigManager::at(temp_dir.clone());
        base.record_last_puuid("puuid-two");
        assert_eq!(base.last_puuid(), Some("puuid-two".to_string()));
        let restored = ConfigManager::for_account_in(&temp_dir, None);
        assert_eq!(restored.config_path, temp_dir.join("config-puuid-two.json"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_account_files_do_not_overwrite_each_other() {
        let temp_dir =
            std::env::temp_dir().join(format!("lol_cfg_isolate_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        let _ = fs::create_dir_all(&temp_dir);

        let mut main_cfg = AppConfig::default();
        main_cfg.accent_color = "violet".to_string();
        ConfigManager::for_account_in(&temp_dir, Some("puuid-main"))
            .save(&main_cfg)
            .expect("Save should succeed");

        let mut alt_cfg = AppConfig::default();
        alt_cfg.accent_color = "emerald".to_string();
        ConfigManager::for_account_in(&temp_dir, Some("puuid-alt"))
            .save(&alt_cfg)
            .expect("Save should succeed");

        let loaded_main = ConfigManager::for_account_in(&temp_dir, Some("puuid-main")).load();
        let loaded_alt = ConfigManager::for_account_in(&temp_dir, Some("puuid-alt")).load();
        assert_eq!(loaded_main.accent_color, "violet");
        assert_eq!(loaded_alt.accent_color, "emerald");

        let _ = fs::remove_dir_all(temp_dir);
    }
}
