//! Disk cache for champion and summoner-spell icon PNGs.
//!
//! The webview loads icons through the custom `icon` protocol; lookup order is
//! the cache folder, the local League client (LCU) assets, and the
//! CommunityDragon CDN as a last resort. Everything fetched is written back to
//! the cache folder, and the whole set is re-downloaded whenever the connected
//! client reports a different build version than the one stored in the folder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::lcu::LcuManager;

/// Which icon a protocol URL refers to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum IconKey {
    /// A champion portrait by champion id (e.g. 266).
    Champion(i32),
    /// A summoner-spell icon by file stem (e.g. `summoner_flash`).
    Spell(String),
}

/// Longest allowed spell icon file stem (guard against absurd URLs).
const SPELL_NAME_MAX: usize = 64;

/// Champion ids: 1..=6 ASCII digits and a positive value.
fn parse_champion_id(raw: &str) -> Option<i32> {
    if raw.is_empty() || raw.len() > 6 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id: i32 = raw.parse().ok()?;
    (id > 0).then_some(id)
}

/// Spell icon names: 1..=64 chars of `[a-z0-9_]`.
fn parse_spell_name(raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.len() > SPELL_NAME_MAX
        || !raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return None;
    }
    Some(raw.to_string())
}

/// Parse a protocol URL path (`/champion/266.png`, `/spell/summoner_flash.png`)
/// into an icon key. Anything else — other segments, uppercase, `..`,
/// backslash, `%`, extra slashes, missing or different extension, empty id —
/// is rejected so no caller-controlled string reaches the filesystem.
pub fn parse_icon_path(path: &str) -> Option<IconKey> {
    let rest = path.strip_prefix('/')?;
    let mut segments = rest.split('/');
    let kind = segments.next()?;
    let file = segments.next()?;
    // No extra segments (covers trailing slashes and traversal like `a/../b`).
    if segments.next().is_some() {
        return None;
    }
    let stem = file.strip_suffix(".png")?;
    match kind {
        "champion" => Some(IconKey::Champion(parse_champion_id(stem)?)),
        "spell" => Some(IconKey::Spell(parse_spell_name(stem)?)),
        _ => None,
    }
}

/// Cache file name for an icon key (`champion-266.png`, `spell-summoner_flash.png`).
pub fn file_name(key: &IconKey) -> String {
    match key {
        IconKey::Champion(id) => format!("champion-{id}.png"),
        IconKey::Spell(name) => format!("spell-{name}.png"),
    }
}

/// Inverse of [`file_name`], with the same validation as [`parse_icon_path`].
pub fn key_from_file_name(name: &str) -> Option<IconKey> {
    if let Some(rest) = name.strip_prefix("champion-") {
        return Some(IconKey::Champion(parse_champion_id(rest.strip_suffix(".png")?)?));
    }
    if let Some(rest) = name.strip_prefix("spell-") {
        return Some(IconKey::Spell(parse_spell_name(rest.strip_suffix(".png")?)?));
    }
    None
}

/// LCU asset path for an icon key.
pub fn lcu_path(key: &IconKey) -> String {
    match key {
        IconKey::Champion(id) => format!("/lol-game-data/assets/v1/champion-icons/{id}.png"),
        IconKey::Spell(name) => format!("/lol-game-data/assets/data/spells/icons2d/{name}.png"),
    }
}

/// CommunityDragon CDN URL for an icon key (last-resort source).
pub fn cdn_url(key: &IconKey) -> String {
    match key {
        IconKey::Champion(id) => format!(
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/{id}.png"
        ),
        IconKey::Spell(name) => format!(
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d/{name}.png"
        ),
    }
}

/// The 8-byte PNG file signature.
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Whether bytes start with the PNG file signature (cheap integrity check so
/// an error page or truncated download never lands in the cache).
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&PNG_SIGNATURE)
}

/// Whether a stored version means the cached icons are out of date: no stored
/// version, or a stored version that differs from `current` after trimming
/// whitespace (the version file may carry a trailing newline).
pub fn needs_refresh(stored: Option<&str>, current: &str) -> bool {
    match stored {
        None => true,
        Some(stored) => stored.trim() != current.trim(),
    }
}

/// Cache folder inside the app data directory.
pub fn cache_dir() -> PathBuf {
    crate::config::app_data_dir().join("icon-cache")
}

/// File in the cache folder holding the game build version the icons came from.
const VERSION_FILE: &str = "version.txt";

/// Write `bytes` to `dir/name` atomically: create the folder if missing, write
/// `<name>.tmp`, then rename it over `<name>` so a crash never leaves a
/// half-written icon file behind.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    // The page can ask for one icon twice at once, and the version refresh may
    // write it at the same moment: each writer gets its own temp file.
    static NEXT_TMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = NEXT_TMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.{seq}.tmp"));
    std::fs::write(&tmp, bytes)?;
    let renamed = std::fs::rename(&tmp, dir.join(name));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    renamed
}

/// Read the stored build version; `None` when the file is missing or blank.
pub fn read_version(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join(VERSION_FILE)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Store the build version the cached icons were fetched for.
pub fn write_version(dir: &Path, version: &str) {
    let _ = write_atomic(dir, VERSION_FILE, version.as_bytes());
}

/// Dedicated CDN client: default TLS verification (unlike the LCU client,
/// which accepts the client's self-signed cert) and an 8s total timeout.
fn cdn_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .unwrap_or_default()
    })
}

/// Load an icon by key. Lookup order: cache folder -> local client -> CDN.
///
/// The returned bytes always pass [`is_png`]; anything fetched is written to
/// the cache folder (a failed write is ignored, the bytes are still served).
pub async fn load(lcu: &LcuManager, dir: &Path, key: &IconKey) -> Option<Vec<u8>> {
    let name = file_name(key);

    // 1. Cache hit.
    if let Ok(bytes) = std::fs::read(dir.join(&name))
        && is_png(&bytes)
    {
        return Some(bytes);
    }

    // 2. Local client assets when a client is connected.
    let mut bytes: Option<Vec<u8>> = None;
    if lcu.is_connected().await
        && let Ok(fetched) = lcu.fetch_asset(&lcu_path(key)).await
    {
        bytes = Some(fetched);
    }

    // 3. CDN last resort: also covers an LCU reply that is not real PNG data.
    if bytes.as_ref().is_none_or(|b| !is_png(b)) {
        let res = cdn_client().get(cdn_url(key)).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        bytes = Some(res.bytes().await.ok()?.to_vec());
    }

    // 4. Only cache and serve verified PNG data.
    let bytes = bytes?;
    if !is_png(&bytes) {
        return None;
    }
    let _ = write_atomic(dir, &name, &bytes);
    Some(bytes)
}

/// Re-download every icon when the connected client's build version differs
/// from the one stored in the cache folder.
///
/// Returns the new version only when every icon was refreshed without a single
/// failure; otherwise the stored version stays untouched so the next connection
/// retries the whole refresh. `None` when no client is connected, the version
/// is unchanged, or the refresh did not fully succeed.
pub async fn refresh_if_version_changed(lcu: &LcuManager, dir: &Path) -> Option<String> {
    let current = lcu.fetch_build_version().await?;
    if !needs_refresh(read_version(dir).as_deref(), &current) {
        return None;
    }

    // Every playable champion from the client's roster plus every icon already
    // in the cache folder (spells and icons a roster fetch may not cover),
    // de-duplicated.
    let Ok(champions) = lcu.fetch_champions().await else {
        return None;
    };
    let mut seen: HashSet<IconKey> = HashSet::new();
    let mut keys: Vec<IconKey> = Vec::new();
    for champ in champions {
        let key = IconKey::Champion(champ.id);
        if seen.insert(key.clone()) {
            keys.push(key);
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if let Some(key) = key_from_file_name(name)
                && seen.insert(key.clone())
            {
                keys.push(key);
            }
        }
    }

    // Sequential on purpose: one request at a time keeps the client responsive.
    let mut failures = 0usize;
    for key in &keys {
        match lcu.fetch_asset(&lcu_path(key)).await {
            Ok(bytes) if is_png(&bytes) => {
                if write_atomic(dir, &file_name(key), &bytes).is_err() {
                    failures += 1;
                }
            }
            _ => failures += 1,
        }
    }

    if failures == 0 {
        write_version(dir, &current);
        return Some(current);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp folder for one test, cleared of any earlier run's leftovers.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arampilot-icon-cache-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Minimal bytes that pass `is_png`.
    fn png_bytes() -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(b"fake-image-data");
        bytes
    }

    #[test]
    fn test_parse_icon_path_accepts_valid_champion_and_spell_paths() {
        assert_eq!(parse_icon_path("/champion/266.png"), Some(IconKey::Champion(266)));
        assert_eq!(parse_icon_path("/champion/1.png"), Some(IconKey::Champion(1)));
        assert_eq!(
            parse_icon_path("/spell/summoner_flash.png"),
            Some(IconKey::Spell("summoner_flash".to_string()))
        );
        assert_eq!(parse_icon_path("/spell/summonerboost.png"), Some(IconKey::Spell("summonerboost".to_string())));
    }

    #[test]
    fn test_parse_icon_path_rejects_traversal_and_extra_segments() {
        assert_eq!(parse_icon_path("/champion/../x.png"), None);
        assert_eq!(parse_icon_path("/champion/266.png/extra.png"), None);
        assert_eq!(parse_icon_path("/other/266.png"), None);
        assert_eq!(parse_icon_path("champion/266.png"), None);
        assert_eq!(parse_icon_path("/champion/266.png/x"), None);
    }

    #[test]
    fn test_parse_icon_path_rejects_bad_champion_ids() {
        // Id 0 is not a champion; 7 digits exceed the 6-digit cap.
        assert_eq!(parse_icon_path("/champion/0.png"), None);
        assert_eq!(parse_icon_path("/champion/1000000.png"), None);
        assert_eq!(parse_icon_path("/champion/.png"), None);
        assert_eq!(parse_icon_path("/champion/12a4.png"), None);
    }

    #[test]
    fn test_parse_icon_path_rejects_bad_spell_names() {
        // Uppercase is not part of `[a-z0-9_]`.
        assert_eq!(parse_icon_path("/spell/Summoner_Flash.png"), None);
        assert_eq!(parse_icon_path("/spell/summoner%2fflash.png"), None);
        assert_eq!(parse_icon_path("/spell/..png"), None);
        assert_eq!(parse_icon_path("/spell/.png"), None);
        assert_eq!(parse_icon_path("/spell/summoner_flash.jpg"), None);
        assert_eq!(parse_icon_path("/spell/summoner_flash"), None);
        assert_eq!(parse_icon_path("/spell/with\\backslash.png"), None);
    }

    #[test]
    fn test_file_name_and_key_round_trip() {
        for key in [
            IconKey::Champion(266),
            IconKey::Champion(1),
            IconKey::Spell("summoner_flash".to_string()),
            IconKey::Spell("summonerboost".to_string()),
        ] {
            let name = file_name(&key);
            assert_eq!(key_from_file_name(&name), Some(key));
        }
        assert_eq!(file_name(&IconKey::Champion(266)), "champion-266.png");
        assert_eq!(file_name(&IconKey::Spell("summoner_flash".to_string())), "spell-summoner_flash.png");
    }

    #[test]
    fn test_key_from_file_name_rejects_non_icon_files() {
        assert_eq!(key_from_file_name("version.txt"), None);
        assert_eq!(key_from_file_name("champion-.png"), None);
        assert_eq!(key_from_file_name("champion-0.png"), None);
        assert_eq!(key_from_file_name("champion-266.txt"), None);
        assert_eq!(key_from_file_name("spell-Bad_Name.png"), None);
        assert_eq!(key_from_file_name("icon.png"), None);
    }

    #[test]
    fn test_lcu_path_and_cdn_url_exact_strings() {
        let champion = IconKey::Champion(266);
        assert_eq!(lcu_path(&champion), "/lol-game-data/assets/v1/champion-icons/266.png");
        assert_eq!(
            cdn_url(&champion),
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/266.png"
        );
        let spell = IconKey::Spell("summoner_flash".to_string());
        assert_eq!(
            lcu_path(&spell),
            "/lol-game-data/assets/data/spells/icons2d/summoner_flash.png"
        );
        assert_eq!(
            cdn_url(&spell),
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d/summoner_flash.png"
        );
    }

    #[test]
    fn test_is_png_checks_signature() {
        assert!(is_png(&png_bytes()));
        assert!(is_png(&PNG_SIGNATURE));
        assert!(!is_png(b""));
        assert!(!is_png(b"<html>404</html>"));
        assert!(!is_png(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0B]));
        assert!(!is_png(&PNG_SIGNATURE[..4]));
    }

    #[test]
    fn test_needs_refresh() {
        // No stored version: always refresh.
        assert!(needs_refresh(None, "16.22.834.8910"));
        // Same version: nothing to do, with or without a trailing newline.
        assert!(!needs_refresh(Some("16.22.834.8910"), "16.22.834.8910"));
        assert!(!needs_refresh(Some("16.22.834.8910\n"), "16.22.834.8910"));
        // A different version must refresh.
        assert!(needs_refresh(Some("16.21.0.0"), "16.22.834.8910"));
    }

    #[test]
    fn test_write_atomic_round_trip_and_no_tmp_left() {
        let dir = temp_dir("write-atomic");
        let bytes = png_bytes();
        write_atomic(&dir, "champion-266.png", &bytes).expect("write_atomic should succeed");

        let read_back = std::fs::read(dir.join("champion-266.png")).expect("cached file exists");
        assert_eq!(read_back, bytes);
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("list the folder")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no .tmp file may remain");
        // The folder was created on demand.
        assert!(dir.is_dir());
        std::fs::remove_dir_all(&dir).expect("temp folder removed");
    }

    #[test]
    fn test_write_atomic_overwrites_existing_file() {
        let dir = temp_dir("write-atomic-overwrite");
        write_atomic(&dir, "spell-x.png", b"old").expect("first write");
        write_atomic(&dir, "spell-x.png", b"new").expect("overwrite");
        assert_eq!(std::fs::read(dir.join("spell-x.png")).expect("read back"), b"new");
        std::fs::remove_dir_all(&dir).expect("temp folder removed");
    }

    #[test]
    fn test_version_round_trip() {
        let dir = temp_dir("version");
        assert_eq!(read_version(&dir), None, "missing file is None");
        write_version(&dir, "16.22.834.8910");
        assert_eq!(read_version(&dir), Some("16.22.834.8910".to_string()));

        // A blank file reads as None.
        std::fs::write(dir.join(VERSION_FILE), "  \n").expect("blank version file");
        assert_eq!(read_version(&dir), None);

        // A stored newline is trimmed away.
        std::fs::write(dir.join(VERSION_FILE), "16.22.834.8910\n").expect("version file");
        assert_eq!(read_version(&dir), Some("16.22.834.8910".to_string()));
        std::fs::remove_dir_all(&dir).expect("temp folder removed");
    }

    #[tokio::test]
    async fn test_load_serves_cached_png_without_lcu_or_network() {
        let dir = temp_dir("load-cache-hit");
        let bytes = png_bytes();
        write_atomic(&dir, "champion-266.png", &bytes).expect("seed the cache");

        // `LcuManager::new()` is not connected to any client; the cache hit
        // short-circuits before any network access.
        let loaded = load(&LcuManager::new(), &dir, &IconKey::Champion(266)).await;
        assert_eq!(loaded, Some(bytes));

        std::fs::remove_dir_all(&dir).expect("temp folder removed");
    }
}
