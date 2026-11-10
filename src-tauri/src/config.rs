use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChampionProfileItem {
    pub id: i32,
    // name / tier / flag default so one hand-edited or foreign entry missing a
    // field cannot make the whole file unreadable.
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_tier")]
    pub tier: String, // "本命", "愛角", "順手", "勉強", "封印", "未分類"
    #[serde(default)]
    pub flag: String, // "", "lock", "give", "nograb"
    #[serde(default)]
    pub elo: Option<f64>,
    #[serde(default)]
    pub matches: Option<u32>,
    /// Remembered secondary summoner spell (Ghost/Mark/...) for this champion.
    #[serde(default)]
    pub secondary_spell: Option<i32>,
}

fn default_tier() -> String {
    "未分類".to_string()
}

/// Config files that existed but could not be loaded this run. The app keeps
/// going on safe defaults in memory, and `save` refuses to write them over the
/// user's file until a later load succeeds (or the file is gone).
fn unreadable_paths() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    static PATHS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    PATHS.get_or_init(Default::default)
}

/// `save` error text while the guard is armed; also the `lcu-log` reason the
/// frontend shows when a load failed.
pub const LOAD_FAILED_SAVE_REFUSED: &str =
    "設定檔讀取失敗，為避免用預設值覆蓋你的設定，已暫停存檔；請關閉占用設定檔的程式後重新啟動 App";

/// Why a save did not reach the disk. `Display` keeps the text the log and the
/// frontend show; the variant is what the caller switches on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveError {
    /// The unreadable-config guard refused the write.
    LoadRefused,
    /// Serializing or writing the file failed.
    Write(String),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::LoadRefused => f.write_str(LOAD_FAILED_SAVE_REFUSED),
            SaveError::Write(msg) => f.write_str(msg),
        }
    }
}

fn set_unreadable(path: &Path, unreadable: bool) {
    let mut paths = unreadable_paths().lock().unwrap_or_else(|e| e.into_inner());
    if unreadable {
        paths.insert(path.to_path_buf());
    } else {
        paths.remove(path);
    }
}

/// Write `contents` to `path` through a sibling temp file and a rename, so a
/// crash or a concurrent writer can never leave a truncated or interleaved file.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    // Unique per writer so two saves never share one temp file.
    let tmp = path.with_file_name(format!(
        "{}.{}-{}.tmp",
        file_name,
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
        drop(f);
        // Antivirus or an editor can hold the target briefly; retry the swap.
        let mut last = None;
        for attempt in 0..5 {
            match fs::rename(&tmp, path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(20 * (attempt + 1)));
                }
            }
        }
        Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())
}

/// Parse a saved config, tolerating a UTF-8 BOM left by some editors.
fn parse_config(content: &str) -> Result<AppConfig, serde_json::Error> {
    serde_json::from_str::<AppConfig>(content.trim_start_matches('\u{feff}'))
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
    pub accent_color: String, // "ivory", "crimson", "amber", "emerald", "violet"

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
    /// Seconds before the configured surrender time the reminder fires.
    pub ff_lead_sec: f64,

    // Retry spacing for automation loops
    pub bench_retry_interval_ms: u64,
    pub manual_snipe_interval_ms: u64,

    // Window & behavior
    pub client_close_action: String, // "wait", "exit"
    pub close_to_tray: bool,
    pub auto_start: bool,

    // Profiles
    pub aram_profile: Vec<ChampionProfileItem>,
    pub mayhem_profile: Vec<ChampionProfileItem>,

    /// Named ranking saves the user switches between. Each save's `items` is its
    /// last manual save; `aram_profile` / `mayhem_profile` stay the working ranking
    /// the automation uses, which may differ from the active save until it is saved.
    pub ranking_saves: Vec<RankingSave>,
    /// Id of the save the live profile belongs to ("" before the first save exists).
    pub active_ranking_save: String,
}

/// One named ranking: order, tier, flag and pairwise weights (`secondary_spell` unused).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RankingSave {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub items: Vec<ChampionProfileItem>,
}

/// Most saves kept; names longer than this many chars are cut.
pub const MAX_RANKING_SAVES: usize = 20;
const MAX_RANKING_SAVE_NAME: usize = 40;

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            master_enabled: true,
            accent_color: "ivory".to_string(),
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
            ff_lead_sec: 0.0,
            bench_retry_interval_ms: 80,
            manual_snipe_interval_ms: 120,
            client_close_action: "wait".to_string(),
            close_to_tray: true,
            auto_start: false,
            aram_profile: Vec::new(),
            mayhem_profile: Vec::new(),
            ranking_saves: Vec::new(),
            active_ranking_save: String::new(),
        }
    }
}

impl AppConfig {
    /// Settings to run on when the user's file exists but cannot be loaded:
    /// defaults with every automation off, so nothing the user never chose
    /// acts on their matches (they can still switch it on for this run).
    pub fn safe_fallback() -> Self {
        Self {
            master_enabled: false,
            ..Self::default()
        }
    }

    /// Drop classic-mode / dummy champion ids and duplicate entries from saved profiles, then
    /// unify ARAM and Mayhem into one shared ranking so both modes use the same champion order.
    pub fn sanitize(&mut self) {
        if !self.ff_lead_sec.is_finite() {
            self.ff_lead_sec = 0.0;
        }
        self.ff_lead_sec = self.ff_lead_sec.clamp(0.0, 15.0);
        // Hand-edited huge or NaN delays would panic `Duration::from_secs_f64`.
        self.accept_delay_sec = clamp_secs(self.accept_delay_sec, 10.0);
        self.chat_delay_sec = clamp_secs(self.chat_delay_sec, 10.0);
        for settings in [&mut self.aram_settings, &mut self.mayhem_settings] {
            settings.card_select_delay_sec = clamp_secs(settings.card_select_delay_sec, 30.0);
            settings.stop_bench_remaining_sec = settings.stop_bench_remaining_sec.clamp(0, 60);
        }
        self.bench_retry_interval_ms = self.bench_retry_interval_ms.clamp(50, 500);
        self.manual_snipe_interval_ms = self.manual_snipe_interval_ms.clamp(80, 500);
        sanitize_profile(&mut self.aram_profile);
        sanitize_profile(&mut self.mayhem_profile);
        let unified = unify_profiles(&self.aram_profile, &self.mayhem_profile);
        self.aram_profile = unified.clone();
        self.mayhem_profile = unified;
        sanitize_ranking_saves(&mut self.ranking_saves);
    }
}

/// Drop saves without an id and duplicate ids, trim and cap names, clean each
/// save's champion list, and keep at most `MAX_RANKING_SAVES`.
fn sanitize_ranking_saves(saves: &mut Vec<RankingSave>) {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    saves.retain(|s| !s.id.trim().is_empty() && seen.insert(s.id.clone()));
    saves.truncate(MAX_RANKING_SAVES);
    for save in saves.iter_mut() {
        let name: String = save.name.trim().chars().take(MAX_RANKING_SAVE_NAME).collect();
        save.name = name;
        sanitize_profile(&mut save.items);
    }
}

/// Clamp a delay in seconds to `0..=max`, mapping NaN / infinity to 0.
fn clamp_secs(value: f64, max: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, max) } else { 0.0 }
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
    /// The one config file this computer uses: `<data dir>/config.json`,
    /// whatever account is logged in.
    pub fn new() -> Self {
        Self::at(dirs_fallback())
    }

    /// A manager rooted at an explicit directory (tests and the migration).
    pub fn at(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let config_path = dir.join("config.json");
        Self { dir, config_path }
    }

    fn accounts_index_path(&self) -> PathBuf {
        self.dir.join("accounts.json")
    }

    /// The account used most recently while configs were still per account.
    ///
    /// Only [`migrate_account_configs`] reads this; nothing writes it any more.
    pub fn last_puuid(&self) -> Option<String> {
        let content = fs::read_to_string(self.accounts_index_path()).ok()?;
        let index: serde_json::Value = serde_json::from_str(&content).ok()?;
        index
            .get("last_puuid")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    pub fn load(&self) -> AppConfig {
        self.load_checked().0
    }

    /// `load`, plus whether this very call fell back to `safe_fallback` because
    /// the existing file could not be loaded. Concurrent loads of one file
    /// share the save-protection flag; this result belongs to this call alone.
    /// For single-caller paths (startup): load and set the save guard at once.
    pub fn load_checked(&self) -> (AppConfig, bool) {
        let (config, failed) = self.load_outcome();
        self.set_save_guard(failed);
        (config, failed)
    }

    /// Load without touching the save guard: the config, and whether it is
    /// the safe fallback because the existing file could not be loaded.
    pub fn load_outcome(&self) -> (AppConfig, bool) {
        match self.config_path.try_exists() {
            Ok(true) => {}
            Ok(false) => {
                // Fresh install: start from defaults.
                let default_config = AppConfig::default();
                let _ = self.write_unguarded(&default_config);
                return (default_config, false);
            }
            // Cannot even tell whether it exists: never write over it.
            Err(_) => return (AppConfig::safe_fallback(), true),
        }

        // A transient lock (antivirus, sync tool) must not look like a missing file.
        let mut content = None;
        for attempt in 0..3 {
            match fs::read_to_string(&self.config_path) {
                Ok(c) => {
                    content = Some(c);
                    break;
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(50 * (attempt + 1))),
            }
        }
        let Some(content) = content else {
            // Unreadable: leave the file untouched and run on defaults in memory;
            // `save` refuses to write them over it.
            return (AppConfig::safe_fallback(), true);
        };

        let mut config = match parse_config(&content) {
            Ok(config) => config,
            Err(_) => {
                // Unparseable: move it aside instead of overwriting the user's
                // ranking with defaults, then start from defaults.
                let aside = self
                    .config_path
                    .with_extension(format!("corrupt-{}.json", backup_timestamp_now()));
                if fs::rename(&self.config_path, &aside).is_err() {
                    return (AppConfig::safe_fallback(), true);
                }
                let default_config = AppConfig::default();
                let _ = self.write_unguarded(&default_config);
                return (default_config, false);
            }
        };
        {
            let aram_before = config.aram_profile.clone();
            let mayhem_before = config.mayhem_profile.clone();
            let modes_differed = aram_before != mayhem_before;
            config.sanitize();
            if modes_differed
                || config.aram_profile != aram_before
                || config.mayhem_profile != mayhem_before
            {
                let _ = self.write_unguarded(&config);
            }
        }
        (config, false)
    }

    /// Arm (`true`) or lift the save guard for this file. Whoever installs a
    /// loaded config as live sets it from that load's own outcome, so a
    /// concurrent load of the same file can never leave the guard wrong.
    pub fn set_save_guard(&self, load_failed: bool) {
        set_unreadable(&self.config_path, load_failed);
    }

    /// True when the config file exists but could not be loaded this run, so
    /// the settings in memory are defaults, not the user's.
    pub fn load_failed(&self) -> bool {
        unreadable_paths()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&self.config_path)
    }

    pub fn save(&self, config: &AppConfig) -> Result<(), SaveError> {
        // This run holds defaults, not the user's settings: writing them would
        // replace the real file. Refuse until a restart loads it successfully.
        if self.load_failed() {
            // Only a confirmed absence counts as gone; a metadata error (or a
            // sync tool mid-replace answering oddly) keeps the protection on.
            if !matches!(self.config_path.try_exists(), Ok(false)) {
                return Err(SaveError::LoadRefused);
            }
            // The file we could not read is gone: nothing left to protect.
            set_unreadable(&self.config_path, false);
        }
        self.write_unguarded(config).map_err(SaveError::Write)
    }

    /// Write without the unreadable guard: only for load's own repair writes,
    /// which happen right after this call read the file successfully (or saw
    /// it missing).
    fn write_unguarded(&self, config: &AppConfig) -> Result<(), String> {
        let mut sanitized = config.clone();
        sanitized.sanitize();
        let json = serde_json::to_string_pretty(&sanitized).map_err(|e| e.to_string())?;
        write_atomic(&self.config_path, &json)
    }
}

/// Which file owned `puuid` while configs were per account. Kept for the
/// one-time migration, which has to find those files by name.
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

/// What [`migrate_account_configs`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationOutcome {
    /// Whether the per-account rankings were merged into `config.json`.
    pub ran: bool,
    /// How many `ranking_saves` the merge appended to the base config.
    pub imported_saves: usize,
    /// Why it stopped short. `ran` is false when nothing was written.
    pub error: Option<String>,
}

impl MigrationOutcome {
    fn aborted(error: String) -> Self {
        Self {
            ran: false,
            imported_saves: 0,
            error: Some(error),
        }
    }
}

/// Order, id, tier, flag and weights of a ranking: what makes two rankings the
/// same for the merge.
type RankingKey = Vec<(i32, String, String, Option<f64>, Option<u32>)>;

fn ranking_key(items: &[ChampionProfileItem]) -> RankingKey {
    items
        .iter()
        .map(|i| (i.id, i.tier.clone(), i.flag.clone(), i.elo, i.matches))
        .collect()
}

/// Merge the per-account `config-<puuid>.json` files into the single
/// `config.json`, once, so settings and rankings survive the move to one config
/// per computer.
///
/// Runs only while `accounts.json` exists (per-account mode was in use). The
/// base config keeps its settings; every other account contributes its working
/// ranking and its own non-empty ranking saves as new `ranking_saves` entries.
/// The old files stay on disk as the user's backup.
pub fn migrate_account_configs(dir: &Path) -> MigrationOutcome {
    let index = dir.join("accounts.json");
    if !index.is_file() {
        return MigrationOutcome::default();
    }

    // Candidates: the per-account files that still parse. Temp files and the
    // copies `load_outcome` moved aside for being corrupt are not candidates.
    let Ok(entries) = fs::read_dir(dir) else {
        return MigrationOutcome::aborted(format!("無法讀取資料夾 {}", dir.display()));
    };
    let mut candidates: Vec<(PathBuf, AppConfig)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with("config-") || !name.ends_with(".json") {
            continue;
        }
        if name.contains(".corrupt-") {
            continue;
        }
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut cfg) = parse_config(&content) else {
            continue;
        };
        // Merge exactly the rankings the app would have run on.
        cfg.sanitize();
        candidates.push((path, cfg));
    }
    if candidates.is_empty() {
        // Nothing to merge: keep `accounts.json` so a later run can retry.
        return MigrationOutcome::default();
    }

    // Base: the last used account when its file parses, else the newest file.
    let last = ConfigManager::at(dir.to_path_buf()).last_puuid();
    let base_index = last
        .and_then(|puuid| {
            let wanted = account_config_file_name(&puuid);
            candidates.iter().position(|(path, _)| {
                path.file_name().and_then(|n| n.to_str()) == Some(wanted.as_str())
            })
        })
        .or_else(|| newest_candidate(&candidates))
        .unwrap_or(0);
    let (_, mut merged) = candidates.remove(base_index);

    // An unnamed working ranking that is already present (as the base ranking or
    // any save) adds nothing. A save the user named is kept unless a save with
    // the same name and the same ranking is already there: its name is what the
    // user looks for, even when its content matches the base ranking.
    let base_key = ranking_key(&merged.aram_profile);
    let mut seen: Vec<RankingKey> = Vec::with_capacity(1 + merged.ranking_saves.len());
    seen.push(base_key.clone());
    seen.extend(merged.ranking_saves.iter().map(|s| ranking_key(&s.items)));
    let mut seen_named: Vec<(String, RankingKey)> = merged
        .ranking_saves
        .iter()
        .map(|s| (s.name.clone(), ranking_key(&s.items)))
        .collect();
    let mut used_ids: std::collections::HashSet<String> =
        merged.ranking_saves.iter().map(|s| s.id.clone()).collect();
    let mut used_names: std::collections::HashSet<String> = merged
        .ranking_saves
        .iter()
        .map(|s| s.name.clone())
        .collect();
    let mut seq: u64 = 0;
    let mut imported = 0usize;

    'accounts: for (path, other) in &candidates {
        let label: String = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| {
                n.trim_start_matches("config-")
                    .trim_end_matches(".json")
                    .chars()
                    .take(8)
                    .collect()
            })
            .unwrap_or_default();
        let working_name = format!("舊帳號 {label}");
        let contributions = std::iter::once((working_name, other.aram_profile.clone(), false))
            .chain(
                other
                    .ranking_saves
                    .iter()
                    .filter(|s| !s.items.is_empty())
                    .map(|s| (s.name.clone(), s.items.clone(), true)),
            );
        for (name, items, named) in contributions {
            if merged.ranking_saves.len() >= MAX_RANKING_SAVES {
                break 'accounts;
            }
            if items.is_empty() {
                continue;
            }
            let key = ranking_key(&items);
            let duplicate = if named {
                seen_named.iter().any(|(n, k)| *n == name && *k == key)
            } else {
                seen.contains(&key)
            };
            if duplicate {
                continue;
            }
            seen_named.push((name.clone(), key.clone()));
            let name = unique_save_name(&name, &mut used_names);
            let id = fresh_save_id(&name, &mut seq, &mut used_ids);
            merged.ranking_saves.push(RankingSave {
                id,
                name,
                items,
            });
            seen.push(key);
            imported += 1;
        }
    }

    // Without an active save of its own, the base ranking belongs to the save
    // that holds exactly it, so that save shows as the current one, unchanged.
    if !merged
        .ranking_saves
        .iter()
        .any(|s| s.id == merged.active_ranking_save)
        && let Some(owner) = merged
            .ranking_saves
            .iter()
            .find(|s| ranking_key(&s.items) == base_key)
    {
        merged.active_ranking_save = owner.id.clone();
    }

    // A `config.json` from before the per-account mode is about to be replaced:
    // keep it in `backups/` first, and give up rather than lose it.
    let config_path = dir.join("config.json");
    if config_path.exists() {
        let contents = match fs::read_to_string(&config_path) {
            Ok(c) => c,
            Err(e) => return MigrationOutcome::aborted(format!("無法讀取既有設定檔：{e}")),
        };
        let stamp = backup_timestamp_now();
        if let Err(e) = write_config_backup(dir, "default", &stamp, "pre-merge", &contents) {
            return MigrationOutcome::aborted(format!("無法備份既有設定檔：{e}"));
        }
    }

    // `save` sanitizes and writes atomically; a failed write leaves every file
    // (and `accounts.json`) as it was, so a later run can retry.
    if let Err(e) = ConfigManager::at(dir.to_path_buf()).save(&merged) {
        return MigrationOutcome::aborted(format!("無法寫入 config.json：{e}"));
    }

    let mut outcome = MigrationOutcome {
        ran: true,
        imported_saves: imported,
        error: None,
    };
    // Only the marker goes away: the per-account files stay as the user's backup.
    if let Err(e) = fs::rename(&index, index.with_extension("json.migrated")) {
        outcome.error = Some(format!("已合併設定，但 accounts.json 無法改名：{e}"));
    }
    outcome
}

/// Index of the candidate written most recently (name as tie-break).
fn newest_candidate(candidates: &[(PathBuf, AppConfig)]) -> Option<usize> {
    candidates
        .iter()
        .enumerate()
        .max_by_key(|(_, (path, _))| {
            fs::metadata(path)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
        })
        .map(|(index, _)| index)
}

/// `name` if no save uses it yet, else `name (2)`, `name (3)`, ...
fn unique_save_name(name: &str, used: &mut std::collections::HashSet<String>) -> String {
    let trimmed: String = name.trim().chars().take(MAX_RANKING_SAVE_NAME).collect();
    let base = if trimmed.is_empty() {
        "舊帳號".to_string()
    } else {
        trimmed
    };
    if used.insert(base.clone()) {
        return base;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base} ({n})");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

/// A save id that collides with nothing in `used` (nor with earlier ones).
fn fresh_save_id(name: &str, seq: &mut u64, used: &mut std::collections::HashSet<String>) -> String {
    loop {
        *seq += 1;
        let id = format!("rs-mig-{}-{:08x}", *seq, fnv1a(name));
        if used.insert(id.clone()) {
            return id;
        }
    }
}

/// FNV-1a, only used to make migrated save ids stable and distinct.
fn fnv1a(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// How many snapshots are kept per account prefix; older ones rotate out.
pub const KEEP_CONFIG_BACKUPS: usize = 20;

/// Root data directory shared by every config file and the `backups/` folder.
pub fn app_data_dir() -> PathBuf {
    dirs_fallback()
}

/// Prefix used in backup file names: the first 8 chars of the puuid, or `default`.
pub fn backup_account_prefix(puuid: Option<&str>) -> String {
    match puuid.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => safe_file_stem(p).chars().take(8).collect(),
        None => "default".to_string(),
    }
}

/// `config-<prefix>-<stamp>-<reason>.json`
pub fn backup_file_name(prefix: &str, stamp: &str, reason: &str) -> String {
    format!("config-{}-{}-{}.json", prefix, stamp, safe_file_stem(reason))
}

/// Write `contents` as a new snapshot into `<dir>/backups/`, then rotate so only the
/// newest [`KEEP_CONFIG_BACKUPS`] snapshots of the same account prefix survive.
/// Returns the path that was written.
pub fn write_config_backup(
    dir: &Path,
    prefix: &str,
    stamp: &str,
    reason: &str,
    contents: &str,
) -> Result<PathBuf, String> {
    let backups = dir.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let path = backups.join(backup_file_name(prefix, stamp, reason));
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    prune_backups(&backups, prefix, KEEP_CONFIG_BACKUPS);
    Ok(path)
}

/// Drop the oldest snapshots of `prefix` so at most `keep` remain.
///
/// Age is the file's modified time (name as tie-break): stamps can mix the
/// frontend's local time with the UTC fallback, so name order alone is not age.
fn prune_backups(dir: &Path, prefix: &str, keep: usize) {
    let marker = format!("config-{}-", prefix);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, name))
        })
        .filter(|(_, name)| name.starts_with(&marker) && name.ends_with(".json"))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort();
    let names: Vec<String> = files.into_iter().map(|(_, name)| name).collect();
    let drop_count = names.len() - keep;
    for name in names.into_iter().take(drop_count) {
        let _ = fs::remove_file(dir.join(name));
    }
}

/// `YYYYMMDD-HHMMSS` (UTC) for backup file names, without pulling in a date crate.
pub fn backup_timestamp_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    backup_timestamp(secs)
}

/// True for a `YYYYMMDD-HHMMSS` stamp (digits only, so it is safe in a file name).
pub fn is_backup_stamp(s: &str) -> bool {
    s.len() == 15
        && s.char_indices()
            .all(|(i, c)| if i == 8 { c == '-' } else { c.is_ascii_digit() })
}

/// Format seconds since the Unix epoch as `YYYYMMDD-HHMMSS` (UTC).
fn backup_timestamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year,
        month,
        day,
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a civil `(year, month, day)` date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Applies an on/off setting on background threads so callers never block,
/// while the last apply to finish always uses the most recent request: the
/// request is recorded on the caller's thread, in call order, before spawning.
pub struct LatestRequest {
    desired: std::sync::atomic::AtomicBool,
    /// Last value applied: 0 = none yet, 1 = off, 2 = on.
    applied: std::sync::atomic::AtomicU8,
    apply_lock: std::sync::Mutex<()>,
}

fn applied_code(enabled: bool) -> u8 {
    if enabled { 2 } else { 1 }
}

impl LatestRequest {
    pub const fn new() -> Self {
        Self {
            desired: std::sync::atomic::AtomicBool::new(false),
            applied: std::sync::atomic::AtomicU8::new(0),
            apply_lock: std::sync::Mutex::new(()),
        }
    }

    /// Record `enabled` and apply it in the background; `None` when that value
    /// is already applied (no work spawned).
    /// `apply` returns whether it took effect; a failure is retried by the
    /// next request instead of being remembered as applied.
    pub fn request(
        &'static self,
        enabled: bool,
        apply: fn(bool) -> bool,
    ) -> Option<std::thread::JoinHandle<()>> {
        use std::sync::atomic::Ordering;
        self.desired.store(enabled, Ordering::SeqCst);
        if self.applied.load(Ordering::SeqCst) == applied_code(enabled) {
            // An apply still running re-checks `desired` when it finishes.
            return None;
        }
        Some(std::thread::spawn(move || {
            let _serialized = self.apply_lock.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                let want = self.desired.load(Ordering::SeqCst);
                if self.applied.load(Ordering::SeqCst) == applied_code(want) {
                    break;
                }
                if !apply(want) {
                    self.applied.store(0, Ordering::SeqCst);
                    // Retry only for a different value requested meanwhile;
                    // the same value waits for the next request.
                    if self.desired.load(Ordering::SeqCst) == want {
                        break;
                    }
                    continue;
                }
                self.applied.store(applied_code(want), Ordering::SeqCst);
                // A request skipped while we were applying an older value.
                if self.desired.load(Ordering::SeqCst) == want {
                    break;
                }
            }
        }))
    }
}

impl Default for LatestRequest {
    fn default() -> Self {
        Self::new()
    }
}

/// Mirror the `auto_start` setting into the current user's Windows Run key
/// (non-blocking). Only app code calls this, so unit tests never touch the
/// registry; call it while holding the config lock that decided `enabled`, so
/// requests are recorded in the same order as the settings changed.
#[cfg(target_os = "windows")]
pub fn sync_windows_auto_start(enabled: bool) {
    static AUTO_START: LatestRequest = LatestRequest::new();
    AUTO_START.request(enabled, apply_windows_auto_start);
}

#[cfg(target_os = "windows")]
/// A `reg.exe` invocation with no console window and no stdin attached.
///
/// CREATE_NO_WINDOW keeps a console window from flashing on every save.
fn reg_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = std::process::Command::new("reg");
    command.stdin(std::process::Stdio::null());
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(target_os = "windows")]
/// Returns whether the Run key now matches `enabled`, as far as reg.exe tells.
fn apply_windows_auto_start(enabled: bool) -> bool {
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "LoLAramAssistant";

    let mut command = reg_command();
    if enabled {
        let Ok(exe) = std::env::current_exe() else {
            return false;
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
    let status = command.status();
    let deleted_or_added = matches!(status, Ok(s) if s.success());
    if enabled || deleted_or_added {
        return deleted_or_added;
    }
    // `reg delete` exits 1 both when the value was never there and when it
    // was denied, and `reg query` exits 1 both for a missing value and for a
    // failed query. The value counts as gone only when its query fails while
    // the key itself reads fine; anything else is retried by the next request.
    let query = |args: &[&str]| {
        let mut command = reg_command();
        command
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    !query(&["query", RUN_KEY, "/v", VALUE_NAME]) && query(&["query", RUN_KEY])
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
        assert_eq!(cfg.accent_color, "ivory");
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
    fn test_ranking_saves_roundtrip_and_old_files_load_without_them() {
        let mut cfg = AppConfig {
            active_ranking_save: "rs-a".to_string(),
            ..AppConfig::default()
        };
        cfg.ranking_saves.push(RankingSave {
            id: "rs-b".to_string(),
            name: "雙人排".to_string(),
            items: vec![ChampionProfileItem {
                id: 103,
                tier: "本命".to_string(),
                elo: Some(1720.0),
                matches: Some(3),
                ..ChampionProfileItem::default()
            }],
        });
        let back: AppConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(back.active_ranking_save, "rs-a");
        assert_eq!(back.ranking_saves, cfg.ranking_saves);

        let old: AppConfig = serde_json::from_str(r#"{"aram_profile": []}"#).unwrap();
        assert!(old.ranking_saves.is_empty());
        assert_eq!(old.active_ranking_save, "");
    }

    #[test]
    fn test_sanitize_ranking_saves() {
        let item = |id: i32| ChampionProfileItem {
            id,
            ..ChampionProfileItem::default()
        };
        let save = |id: &str, name: &str, items: Vec<ChampionProfileItem>| RankingSave {
            id: id.to_string(),
            name: name.to_string(),
            items,
        };
        let mut cfg = AppConfig {
            ranking_saves: vec![
                save("", "no id", vec![]),
                save("rs-1", &format!("  {}  ", "長".repeat(50)), vec![item(103), item(103), item(0)]),
                save("rs-1", "duplicate id", vec![]),
            ],
            ..AppConfig::default()
        };
        for i in 0..30 {
            cfg.ranking_saves.push(save(&format!("rs-x{i}"), "extra", vec![]));
        }
        cfg.sanitize();
        assert_eq!(cfg.ranking_saves.len(), MAX_RANKING_SAVES);
        assert_eq!(cfg.ranking_saves[0].id, "rs-1");
        assert_eq!(cfg.ranking_saves[0].name, "長".repeat(MAX_RANKING_SAVE_NAME));
        assert_eq!(
            cfg.ranking_saves[0].items.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![103]
        );
        assert_eq!(cfg.ranking_saves[1].id, "rs-x0");
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
        assert_eq!(loaded_default.accent_color, "ivory");
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
    fn test_is_backup_stamp_accepts_only_digit_stamps() {
        assert!(is_backup_stamp("20261109-232920"));
        assert!(!is_backup_stamp("2026119-232920"));
        assert!(!is_backup_stamp("20261109_232920"));
        assert!(!is_backup_stamp("../../evil-0000"));
    }

    #[test]
    fn test_timing_fields_default_when_missing_from_json() {
        // Old config files predate the three timing fields; `#[serde(default)]` must fill them in.
        let json = r#"{"accent_color":"violet","ff_time_aram":"08:00"}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("Deserialization failed");
        assert_eq!(cfg.ff_lead_sec, 0.0);
        assert_eq!(cfg.bench_retry_interval_ms, 80);
        assert_eq!(cfg.manual_snipe_interval_ms, 120);
        assert_eq!(cfg.accent_color, "violet");
    }

    #[test]
    fn test_sanitize_clamps_timing_fields() {
        let mut cfg = AppConfig {
            ff_lead_sec: 99.0,
            bench_retry_interval_ms: 10,
            manual_snipe_interval_ms: 9999,
            ..AppConfig::default()
        };

        cfg.sanitize();

        assert_eq!(cfg.ff_lead_sec, 15.0);
        assert_eq!(cfg.bench_retry_interval_ms, 50);
        assert_eq!(cfg.manual_snipe_interval_ms, 500);

        // A non-finite lead resets to "on time".
        let mut broken = AppConfig {
            ff_lead_sec: f64::NAN,
            ..AppConfig::default()
        };
        broken.sanitize();
        assert_eq!(broken.ff_lead_sec, 0.0);
    }

    #[test]
    fn test_backup_file_name_uses_prefix_and_reason() {
        assert_eq!(
            backup_file_name("abcd1234", "20240101-120000", "pk-apply"),
            "config-abcd1234-20240101-120000-pk-apply.json"
        );
        assert_eq!(backup_account_prefix(None), "default");
        assert_eq!(backup_account_prefix(Some("  ")), "default");
        assert_eq!(backup_account_prefix(Some("0123456789abcdef")), "01234567");
    }

    #[test]
    fn test_backup_timestamp_formats_utc() {
        assert_eq!(backup_timestamp(0), "19700101-000000");
        assert_eq!(backup_timestamp(1_700_000_000), "20231114-221320");
    }

    #[test]
    fn test_backup_rotation_keeps_newest_twenty() {
        let temp_dir = std::env::temp_dir().join(format!("lol_cfg_backup_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        let prefix = "abcd1234";

        let mut last = PathBuf::new();
        for i in 0..22 {
            let stamp = format!("20240101-00{:02}00", i);
            last = write_config_backup(&temp_dir, prefix, &stamp, "pk-apply", "{}")
                .expect("Backup write should succeed");
        }

        let backups = temp_dir.join("backups");
        let mut names: Vec<String> = fs::read_dir(&backups)
            .expect("backups dir should exist")
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();

        assert_eq!(names.len(), KEEP_CONFIG_BACKUPS, "only 20 backups survive");
        assert!(!names.contains(&"config-abcd1234-20240101-000000-pk-apply.json".to_string()));
        assert!(!names.contains(&"config-abcd1234-20240101-000100-pk-apply.json".to_string()));
        assert_eq!(
            last,
            backups.join("config-abcd1234-20240101-002100-pk-apply.json")
        );
        assert!(last.exists(), "the newest snapshot is the one kept");

        let _ = fs::remove_dir_all(temp_dir);
    }

    fn temp_case(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lol_cfg_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_corrupt_config_is_moved_aside_not_overwritten() {
        let dir = temp_case("corrupt");
        let path = dir.join("config.json");
        fs::write(&path, "{\"aram_profile\": [ {\"id\": 1, ").unwrap();
        let cfg = ConfigManager::at(dir.clone()).load();
        assert_eq!(cfg.accent_color, "ivory", "falls back to defaults");
        let aside: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with("config.corrupt-"))
            .collect();
        assert_eq!(aside.len(), 1, "the broken file is kept for recovery");
        let kept = fs::read_to_string(dir.join(&aside[0])).unwrap();
        assert!(kept.contains("aram_profile"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_latest_request_wins_even_when_applies_overlap() {
        static APPLIED: std::sync::Mutex<Vec<bool>> = std::sync::Mutex::new(Vec::new());
        static SETTING: LatestRequest = LatestRequest::new();
        fn slow_apply(enabled: bool) -> bool {
            std::thread::sleep(std::time::Duration::from_millis(30));
            APPLIED.lock().unwrap().push(enabled);
            true
        }
        let handles = [
            SETTING.request(true, slow_apply),
            SETTING.request(false, slow_apply),
            SETTING.request(true, slow_apply),
            SETTING.request(false, slow_apply),
        ];
        for handle in handles.into_iter().flatten() {
            handle.join().unwrap();
        }
        {
            let applied = APPLIED.lock().unwrap();
            assert!((1..=4).contains(&applied.len()), "{applied:?}");
            assert_eq!(applied.last(), Some(&false), "{applied:?}");
        }
        // Asking again for the value already applied spawns nothing.
        assert!(SETTING.request(false, slow_apply).is_none());
        if let Some(handle) = SETTING.request(true, slow_apply) {
            handle.join().unwrap();
        }
        assert_eq!(APPLIED.lock().unwrap().last(), Some(&true));
    }

    #[test]
    fn test_failed_apply_is_retried_by_the_next_request() {
        static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        static SETTING: LatestRequest = LatestRequest::new();
        fn failing_apply(_enabled: bool) -> bool {
            CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            false
        }
        SETTING.request(true, failing_apply).unwrap().join().unwrap();
        // Not remembered as applied: asking again tries again.
        SETTING.request(true, failing_apply).expect("must retry").join().unwrap();
        assert_eq!(CALLS.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn test_failed_apply_still_runs_a_value_requested_meanwhile() {
        use std::sync::atomic::{AtomicBool, Ordering};
        static CALLS: std::sync::Mutex<Vec<bool>> = std::sync::Mutex::new(Vec::new());
        static STARTED: AtomicBool = AtomicBool::new(false);
        static RELEASE: AtomicBool = AtomicBool::new(false);
        static SETTING: LatestRequest = LatestRequest::new();
        // Turning on blocks until released, then fails; turning off works.
        fn apply(enabled: bool) -> bool {
            CALLS.lock().unwrap().push(enabled);
            if !enabled {
                return true;
            }
            STARTED.store(true, Ordering::SeqCst);
            while !RELEASE.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            false
        }
        SETTING.request(false, apply).unwrap().join().unwrap();
        let holder = SETTING.request(true, apply).unwrap();
        while !STARTED.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        // Off is still the applied value, so this spawns nothing and relies on
        // the running apply to pick it up even though that apply fails.
        assert!(SETTING.request(false, apply).is_none());
        RELEASE.store(true, Ordering::SeqCst);
        holder.join().unwrap();
        assert_eq!(*CALLS.lock().unwrap(), vec![false, true, false]);
    }

    #[test]
    fn test_load_checked_reports_its_own_outcome() {
        let dir = temp_case("outcome");
        let ok_dir = dir.join("ok");
        let bad_dir = dir.join("bad");
        fs::create_dir_all(&ok_dir).unwrap();
        fs::create_dir_all(bad_dir.join("config.json")).unwrap();
        fs::write(ok_dir.join("config.json"), "{\"accent_color\":\"violet\"}").unwrap();
        let (cfg, failed) = ConfigManager::at(ok_dir).load_checked();
        assert!(!failed);
        assert_eq!(cfg.accent_color, "violet");
        let (cfg, failed) = ConfigManager::at(bad_dir).load_checked();
        assert!(failed);
        assert!(!cfg.master_enabled);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_set_save_guard_overrides_whatever_another_load_left() {
        let dir = temp_case("guard_race");
        let path = dir.join("config.json");
        fs::write(&path, "{\"accent_color\":\"violet\"}").unwrap();
        let cm = ConfigManager::at(dir.clone());
        // The installer sets the guard from its own load's outcome, whatever a
        // concurrent load of the same file left behind.
        let (_, good_failed) = cm.load_outcome();
        set_unreadable(&path, true);
        cm.set_save_guard(good_failed);
        cm.save(&AppConfig::default()).unwrap();
        // And the other way round: an installed fallback stays protected.
        set_unreadable(&path, false);
        cm.set_save_guard(true);
        assert!(cm.save(&AppConfig::default()).is_err());
        cm.set_save_guard(false);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_unreadable_config_is_never_overwritten_until_it_loads_again() {
        let dir = temp_case("unreadable");
        // A directory where the file should be: it exists but cannot be read.
        fs::create_dir_all(dir.join("config.json")).unwrap();
        let cm = ConfigManager::at(dir.clone());
        let cfg = cm.load();
        assert!(cm.load_failed());
        assert!(!cfg.master_enabled, "no automation on settings the user never chose");
        assert_eq!(cm.save(&cfg), Err(SaveError::LoadRefused));
        assert!(dir.join("config.json").is_dir(), "the original is left untouched");

        // Once the file loads again, saving works normally.
        fs::remove_dir_all(dir.join("config.json")).unwrap();
        fs::write(dir.join("config.json"), "{\"accent_color\":\"violet\"}").unwrap();
        assert_eq!(cm.load().accent_color, "violet");
        assert!(!cm.load_failed());
        cm.save(&AppConfig::default()).unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_saves_work_again_once_the_unreadable_file_is_gone() {
        let dir = temp_case("unreadable_gone");
        let path = dir.join("config.json");
        fs::create_dir_all(&path).unwrap();
        let cm = ConfigManager::at(dir.clone());
        let _ = cm.load();
        assert!(cm.load_failed());
        // Removed (by the user or a sync tool): the next write is ours alone.
        fs::remove_dir_all(&path).unwrap();
        cm.save(&AppConfig::default()).unwrap();
        cm.save(&AppConfig::default()).unwrap();
        assert!(!cm.load_failed());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_locked_file_keeps_the_user_settings_on_disk() {
        let dir = temp_case("locked");
        let path = dir.join("config.json");
        fs::write(&path, "{\"accent_color\":\"violet\"}").unwrap();
        let cm = ConfigManager::at(dir.clone());
        // As if antivirus had held the file while this run loaded it.
        set_unreadable(&path, true);
        assert!(cm.save(&AppConfig::default()).is_err());
        assert!(fs::read_to_string(&path).unwrap().contains("violet"));
        set_unreadable(&path, false);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_load_accepts_bom_and_entries_missing_optional_fields() {
        let dir = temp_case("bom");
        let json = "\u{feff}{\"accent_color\":\"violet\",\"aram_profile\":[{\"id\":81,\"elo\":1600.0,\"matches\":3}]}";
        fs::write(dir.join("config.json"), json).unwrap();
        let cfg = ConfigManager::at(dir.clone()).load();
        assert_eq!(cfg.accent_color, "violet");
        assert_eq!(cfg.aram_profile.len(), 1);
        assert_eq!(cfg.aram_profile[0].tier, "未分類");
        assert_eq!(cfg.aram_profile[0].elo, Some(1600.0));
        assert_eq!(cfg.aram_profile[0].matches, Some(3));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_atomic_save_leaves_no_temp_files() {
        let dir = temp_case("atomic");
        let cm = ConfigManager::at(dir.clone());
        for i in 0..5 {
            let cfg = AppConfig {
                accept_delay_sec: i as f64,
                ..AppConfig::default()
            };
            cm.save(&cfg).unwrap();
        }
        assert_eq!(cm.load().accept_delay_sec, 4.0);
        let leftovers = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(dir);
    }

    fn write_account_file(dir: &Path, puuid: &str, cfg: &AppConfig) {
        let path = dir.join(account_config_file_name(puuid));
        fs::write(path, serde_json::to_string(cfg).unwrap()).unwrap();
    }

    fn write_accounts_index(dir: &Path, puuid: &str) {
        fs::write(
            dir.join("accounts.json"),
            serde_json::json!({ "last_puuid": puuid }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn test_migration_skips_when_no_accounts_index_exists() {
        let dir = temp_case("mig_none");
        let legacy = "{\"accent_color\":\"emerald\"}";
        fs::write(dir.join("config.json"), legacy).unwrap();
        write_account_file(&dir, "puuid-a", &AppConfig::default());

        let outcome = migrate_account_configs(&dir);

        assert!(!outcome.ran);
        assert_eq!(fs::read_to_string(dir.join("config.json")).unwrap(), legacy);
        assert!(!dir.join("backups").exists(), "no backup without a migration");
        assert!(dir.join(account_config_file_name("puuid-a")).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_migration_keeps_base_settings_and_skips_identical_rankings() {
        let dir = temp_case("mig_same");
        let base = AppConfig {
            accent_color: "violet".to_string(),
            aram_profile: vec![profile_item(103), profile_item(81)],
            ranking_saves: vec![RankingSave {
                id: "rs-duo".to_string(),
                name: "雙排用".to_string(),
                items: vec![profile_item(89)],
            }],
            ..AppConfig::default()
        };
        let other = AppConfig {
            accent_color: "emerald".to_string(),
            ..base.clone()
        };
        write_account_file(&dir, "puuid-base-0001", &base);
        write_account_file(&dir, "puuid-other-0002", &other);
        write_accounts_index(&dir, "puuid-base-0001");

        let outcome = migrate_account_configs(&dir);

        assert!(outcome.ran, "{outcome:?}");
        assert_eq!(outcome.imported_saves, 0, "identical rankings add nothing");
        let merged = ConfigManager::at(dir.clone()).load();
        assert_eq!(merged.accent_color, "violet", "settings come from the base");
        assert_eq!(ids(&merged.aram_profile), vec![103, 81]);
        assert_eq!(merged.ranking_saves.len(), 1);
        assert_eq!(merged.ranking_saves[0].name, "雙排用");
        assert!(dir.join("accounts.json.migrated").exists());
        assert!(!dir.join("accounts.json").exists());
        assert!(dir.join(account_config_file_name("puuid-base-0001")).exists());
        assert!(dir.join(account_config_file_name("puuid-other-0002")).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_migration_keeps_a_named_save_that_matches_the_base_ranking() {
        // Regression: the last used account had no saves and the same ranking as
        // the account holding a named save; that save was dropped as a duplicate.
        let dir = temp_case("mig_named");
        let base = AppConfig {
            aram_profile: vec![profile_item(103), profile_item(81)],
            ..AppConfig::default()
        };
        let other = AppConfig {
            active_ranking_save: "rs-duo".to_string(),
            ranking_saves: vec![RankingSave {
                id: "rs-duo".to_string(),
                name: "雙排用".to_string(),
                items: base.aram_profile.clone(),
            }],
            ..base.clone()
        };
        write_account_file(&dir, "puuid-last-0001", &base);
        write_account_file(&dir, "puuid-main-0002", &other);
        write_accounts_index(&dir, "puuid-last-0001");

        let outcome = migrate_account_configs(&dir);

        assert!(outcome.ran, "{outcome:?}");
        assert_eq!(outcome.imported_saves, 1);
        let merged = ConfigManager::at(dir.clone()).load();
        assert_eq!(merged.ranking_saves.len(), 1, "the identical working ranking adds nothing");
        assert_eq!(merged.ranking_saves[0].name, "雙排用");
        assert_eq!(ids(&merged.ranking_saves[0].items), vec![103, 81]);
        assert_eq!(
            merged.active_ranking_save, merged.ranking_saves[0].id,
            "the save holding the base ranking becomes the active one"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_migration_appends_other_accounts_rankings_with_unique_names() {
        let dir = temp_case("mig_other");
        let base = AppConfig {
            aram_profile: vec![profile_item(103)],
            ..AppConfig::default()
        };
        let clash_name = "舊帳號 abcdefgh".to_string();
        let other = AppConfig {
            aram_profile: vec![profile_item(81), profile_item(89)],
            ranking_saves: vec![
                RankingSave {
                    id: "rs-own".to_string(),
                    name: clash_name.clone(),
                    items: vec![profile_item(1), profile_item(2)],
                },
                RankingSave {
                    id: "rs-empty".to_string(),
                    name: "空".to_string(),
                    items: Vec::new(),
                },
            ],
            ..AppConfig::default()
        };
        write_account_file(&dir, "puuid-base", &base);
        write_account_file(&dir, "abcdefgh-1234", &other);
        write_accounts_index(&dir, "puuid-base");

        let outcome = migrate_account_configs(&dir);

        assert!(outcome.ran, "{outcome:?}");
        assert_eq!(outcome.imported_saves, 2, "one working ranking, one save");
        let merged = ConfigManager::at(dir.clone()).load();
        assert_eq!(ids(&merged.aram_profile), vec![103], "the base ranking stays live");
        assert_eq!(merged.ranking_saves.len(), 2);
        assert_eq!(merged.ranking_saves[0].name, clash_name);
        assert_eq!(ids(&merged.ranking_saves[0].items), vec![81, 89]);
        assert_eq!(merged.ranking_saves[1].name, "舊帳號 abcdefgh (2)");
        assert_eq!(ids(&merged.ranking_saves[1].items), vec![1, 2]);
        assert!(merged
            .ranking_saves
            .iter()
            .all(|s| s.id.starts_with("rs-mig-")));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_migration_picks_the_last_used_account_as_base_not_the_newest_file() {
        let dir = temp_case("mig_last");
        let base = AppConfig {
            accent_color: "violet".to_string(),
            aram_profile: vec![profile_item(103)],
            ..AppConfig::default()
        };
        let newer = AppConfig {
            accent_color: "emerald".to_string(),
            aram_profile: vec![profile_item(81)],
            ..AppConfig::default()
        };
        // The last used account's file is written first, so the other one is newer.
        write_account_file(&dir, "puuid-last", &base);
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_account_file(&dir, "puuid-newer", &newer);
        write_accounts_index(&dir, "puuid-last");

        let outcome = migrate_account_configs(&dir);

        assert!(outcome.ran, "{outcome:?}");
        let merged = ConfigManager::at(dir.clone()).load();
        assert_eq!(merged.accent_color, "violet", "accounts.json wins over mtime");
        assert_eq!(ids(&merged.aram_profile), vec![103]);
        assert_eq!(merged.ranking_saves.len(), 1);
        assert_eq!(merged.ranking_saves[0].name, "舊帳號 puuid-ne");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_migration_backs_up_the_legacy_config_before_replacing_it() {
        let dir = temp_case("mig_legacy");
        fs::write(dir.join("config.json"), "{\"accent_color\":\"emerald\"}").unwrap();
        let account = AppConfig {
            accent_color: "violet".to_string(),
            aram_profile: vec![profile_item(103)],
            ..AppConfig::default()
        };
        write_account_file(&dir, "puuid-a", &account);
        write_accounts_index(&dir, "puuid-a");

        let outcome = migrate_account_configs(&dir);

        assert!(outcome.ran, "{outcome:?}");
        let backups: Vec<PathBuf> = fs::read_dir(dir.join("backups"))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("config-default-") && n.ends_with("-pre-merge.json"))
            })
            .collect();
        assert_eq!(backups.len(), 1, "the pre-merge config.json is kept");
        assert!(fs::read_to_string(&backups[0]).unwrap().contains("emerald"));
        assert_eq!(ConfigManager::at(dir.clone()).load().accent_color, "violet");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_migration_leaves_everything_alone_when_no_account_file_parses() {
        let dir = temp_case("mig_broken");
        fs::write(dir.join("config-broken.json"), "{\"aram_profile\": [").unwrap();
        write_accounts_index(&dir, "broken");

        let outcome = migrate_account_configs(&dir);

        assert!(!outcome.ran);
        assert!(!dir.join("config.json").exists());
        assert!(dir.join("accounts.json").exists(), "a later run can retry");
        assert!(!dir.join("accounts.json.migrated").exists());
        assert!(dir.join("config-broken.json").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_sanitize_clamps_delay_seconds() {
        let mut cfg = AppConfig {
            accept_delay_sec: f64::NAN,
            chat_delay_sec: 1e20,
            ..AppConfig::default()
        };
        cfg.aram_settings.card_select_delay_sec = -3.0;
        cfg.mayhem_settings.card_select_delay_sec = f64::INFINITY;
        cfg.sanitize();
        assert_eq!(cfg.accept_delay_sec, 0.0);
        assert_eq!(cfg.chat_delay_sec, 10.0);
        assert_eq!(cfg.aram_settings.card_select_delay_sec, 0.0);
        assert_eq!(cfg.mayhem_settings.card_select_delay_sec, 0.0);
    }

    #[test]
    fn test_account_config_file_name_mapping() {
        // Only the migration builds these names now; the app uses config.json.
        assert_eq!(account_config_file_name("puuid-a"), "config-puuid-a.json");
        assert_eq!(account_config_file_name("puuid-b"), "config-puuid-b.json");
    }

    #[test]
    fn test_safe_file_stem_sanitizes_puuid() {
        assert_eq!(safe_file_stem("abc-123_DEF"), "abc-123_DEF");
        assert_eq!(safe_file_stem("../evil path;x"), "---evil-path-x");
        assert_eq!(safe_file_stem(&"a".repeat(100)).len(), 64);
    }
}
