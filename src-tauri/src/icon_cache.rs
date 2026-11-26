//! Disk cache for champion, summoner-spell, augment and item icon PNGs and
//! champion loading-screen JPEGs.
//!
//! The webview loads icons through the custom `icon` protocol; lookup order is
//! the cache folder, the local League client (LCU) assets, and the
//! CommunityDragon CDN as a last resort. Everything fetched is written back to
//! the cache folder, and the whole set is re-downloaded whenever the connected
//! client reports a different build version than the one stored in the folder.
//!
//! Champions and spells have a fixed asset path. An augment or item icon exists
//! only in the client's own tables (`crate::game_data`), so its path is unknown
//! until that table has been fetched; such a key is skipped, not fetched.
//! Loading-screen art is a JPEG whose path sits in the champion JSON, so it is
//! resolved per request and never part of a version refresh.

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
    /// An augment icon by augment id (e.g. 2141).
    Augment(i64),
    /// An item icon by item id (e.g. 226668).
    Item(i64),
    /// A champion loading-screen image by champion id (e.g. 21).
    LoadScreen(i32),
}

/// Longest allowed spell icon file stem (guard against absurd URLs).
const SPELL_NAME_MAX: usize = 64;

/// Prefix every client asset path carries.
const ASSET_PREFIX: &str = "/lol-game-data/assets/";

/// CommunityDragon tree that mirrors [`ASSET_PREFIX`].
const CDN_ASSET_PREFIX: &str =
    "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/";

/// Champion ids: 1..=6 ASCII digits and a positive value.
fn parse_champion_id(raw: &str) -> Option<i32> {
    if raw.is_empty() || raw.len() > 6 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id: i32 = raw.parse().ok()?;
    (id > 0).then_some(id)
}

/// Augment and item ids: 1..=7 ASCII digits and a positive value.
fn parse_table_id(raw: &str) -> Option<i64> {
    if raw.is_empty() || raw.len() > 7 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id: i64 = raw.parse().ok()?;
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

/// Parse a protocol URL path (`/champion/266.png`, `/spell/summoner_flash.png`,
/// `/augment/2141.png`, `/item/226668.png`, `/loadscreen/21.jpg`) into an icon
/// key. Anything else — other segments, uppercase, `..`, backslash, `%`, extra
/// slashes, missing or different extension, empty id — is rejected so no
/// caller-controlled string reaches the filesystem.
pub fn parse_icon_path(path: &str) -> Option<IconKey> {
    let rest = path.strip_prefix('/')?;
    let mut segments = rest.split('/');
    let kind = segments.next()?;
    let file = segments.next()?;
    // No extra segments (covers trailing slashes and traversal like `a/../b`).
    if segments.next().is_some() {
        return None;
    }
    match kind {
        "champion" => Some(IconKey::Champion(parse_champion_id(file.strip_suffix(".png")?)?)),
        "spell" => Some(IconKey::Spell(parse_spell_name(file.strip_suffix(".png")?)?)),
        "augment" => Some(IconKey::Augment(parse_table_id(file.strip_suffix(".png")?)?)),
        "item" => Some(IconKey::Item(parse_table_id(file.strip_suffix(".png")?)?)),
        // Loading-screen art is a JPEG; the id rules are the champion ones.
        "loadscreen" => Some(IconKey::LoadScreen(parse_champion_id(
            file.strip_suffix(".jpg")?,
        )?)),
        _ => None,
    }
}

/// Cache file name for an icon key (`champion-266.png`, `spell-summoner_flash.png`,
/// `augment-2141.png`, `item-226668.png`, `loadscreen-21.jpg`).
pub fn file_name(key: &IconKey) -> String {
    match key {
        IconKey::Champion(id) => format!("champion-{id}.png"),
        IconKey::Spell(name) => format!("spell-{name}.png"),
        IconKey::Augment(id) => format!("augment-{id}.png"),
        IconKey::Item(id) => format!("item-{id}.png"),
        IconKey::LoadScreen(id) => format!("loadscreen-{id}.jpg"),
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
    if let Some(rest) = name.strip_prefix("augment-") {
        return Some(IconKey::Augment(parse_table_id(rest.strip_suffix(".png")?)?));
    }
    if let Some(rest) = name.strip_prefix("item-") {
        return Some(IconKey::Item(parse_table_id(rest.strip_suffix(".png")?)?));
    }
    if let Some(rest) = name.strip_prefix("loadscreen-") {
        return Some(IconKey::LoadScreen(parse_champion_id(rest.strip_suffix(".jpg")?)?));
    }
    None
}

/// LCU asset path for an icon key; `None` for an augment or item the client's
/// table has no icon path for (or has not been asked for yet), and for
/// loading-screen art, whose path lives in the champion JSON fetched by
/// [`load`].
pub fn lcu_path(key: &IconKey) -> Option<String> {
    match key {
        IconKey::Champion(id) => Some(format!("/lol-game-data/assets/v1/champion-icons/{id}.png")),
        IconKey::Spell(name) => Some(format!("/lol-game-data/assets/data/spells/icons2d/{name}.png")),
        IconKey::Augment(_) | IconKey::Item(_) => crate::game_data::icon_asset_path(key),
        IconKey::LoadScreen(_) => None,
    }
}

/// CommunityDragon URL of one client asset path (the CDN's mirror of it).
///
/// Mirror rule: only paths under `/lol-game-data/assets/` exist there, the rest
/// of the path is lowercased, and the CDN tree root is prefixed. `None` when
/// the path is not one of those client assets.
pub fn cdn_url_for_asset(asset_path: &str) -> Option<String> {
    let rest = asset_path.strip_prefix(ASSET_PREFIX)?;
    if rest.is_empty() {
        return None;
    }
    Some(format!("{CDN_ASSET_PREFIX}{}", rest.to_ascii_lowercase()))
}

/// CommunityDragon CDN URL for an icon key (last-resort source); `None` under
/// the same condition as [`lcu_path`].
pub fn cdn_url(key: &IconKey) -> Option<String> {
    match key {
        IconKey::Champion(id) => Some(format!(
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/{id}.png"
        )),
        IconKey::Spell(name) => Some(format!(
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d/{name}.png"
        )),
        IconKey::Augment(_) | IconKey::Item(_) => {
            cdn_url_for_asset(&crate::game_data::icon_asset_path(key)?)
        }
        // Loading-screen art is mirrored under the path in its champion JSON.
        IconKey::LoadScreen(_) => None,
    }
}

/// Champion table path of one champion in the client's assets.
fn champion_json_path(id: i32) -> String {
    format!("/lol-game-data/assets/v1/champions/{id}.json")
}

/// CommunityDragon mirror of [`champion_json_path`].
fn cdn_champion_json_url(id: i32) -> String {
    format!("{CDN_ASSET_PREFIX}v1/champions/{id}.json")
}

/// The champion JSON of one champion: the local client when connected, else
/// the CDN copy of the same table.
async fn champion_json(lcu: &LcuManager, id: i32) -> Option<serde_json::Value> {
    if lcu.is_connected().await
        && let Ok(bytes) = lcu.fetch_asset(&champion_json_path(id)).await
        && let Ok(champion) = serde_json::from_slice(&bytes)
    {
        return Some(champion);
    }
    let res = cdn_client().get(cdn_champion_json_url(id)).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json().await.ok()
}

/// The loading-screen asset path of a champion's base skin.
///
/// The skin flagged `isBase` wins over the first entry in `skins`; a champion
/// without any usable path yields `None`.
pub fn base_load_screen_path(champion: &serde_json::Value) -> Option<String> {
    let path = |skin: &serde_json::Value| {
        skin.get("loadScreenPath")
            .and_then(|path| path.as_str())
            .filter(|path| !path.is_empty())
            .map(str::to_string)
    };
    let skins = champion.get("skins")?.as_array()?;
    let base = skins
        .iter()
        .find(|skin| skin.get("isBase").and_then(|is_base| is_base.as_bool()).unwrap_or(false));
    base.and_then(path).or_else(|| skins.first().and_then(path))
}

/// The loading-screen asset path of one champion, resolved from its JSON.
async fn load_screen_asset(lcu: &LcuManager, id: i32) -> Option<String> {
    base_load_screen_path(&champion_json(lcu, id).await?)
}

/// The 8-byte PNG file signature.
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// The 3-byte JPEG start-of-image marker.
const JPEG_SIGNATURE: [u8; 3] = [0xFF, 0xD8, 0xFF];

/// Whether bytes start with the PNG file signature (cheap integrity check so
/// an error page or truncated download never lands in the cache).
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&PNG_SIGNATURE)
}

/// Whether bytes start with the JPEG start-of-image marker, the same cheap
/// integrity check as [`is_png`] for the loading-screen art.
pub fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&JPEG_SIGNATURE)
}

/// `Content-Type` of the bytes [`load`] serves for `key`.
pub fn content_type(key: &IconKey) -> &'static str {
    match key {
        IconKey::LoadScreen(_) => "image/jpeg",
        _ => "image/png",
    }
}

/// Whether `bytes` are the image format `key` is served in: JPEG for
/// loading-screen art, PNG for every icon.
fn is_served_image(key: &IconKey, bytes: &[u8]) -> bool {
    match key {
        IconKey::LoadScreen(_) => is_jpeg(bytes),
        _ => is_png(bytes),
    }
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
/// The returned bytes always pass [`is_png`], or [`is_jpeg`] for loading-screen
/// art; anything fetched is written to the cache folder (a failed write is
/// ignored, the bytes are still served).
pub async fn load(lcu: &LcuManager, dir: &Path, key: &IconKey) -> Option<Vec<u8>> {
    let name = file_name(key);

    // 1. Cache hit, in the image format the key is served in.
    if let Ok(bytes) = std::fs::read(dir.join(&name))
        && is_served_image(key, &bytes)
    {
        return Some(bytes);
    }

    // 2. The asset path: fixed for most keys, from the champion JSON for
    //    loading-screen art (so the JSON is fetched before the image).
    let asset = match key {
        IconKey::LoadScreen(id) => load_screen_asset(lcu, *id).await,
        _ => lcu_path(key),
    };
    let mut bytes: Option<Vec<u8>> = None;
    if let Some(asset) = asset.as_deref()
        && lcu.is_connected().await
        && let Ok(fetched) = lcu.fetch_asset(asset).await
    {
        bytes = Some(fetched);
    }

    // 3. CDN last resort: also covers an LCU reply that is not real image data.
    // An unknown asset path (an augment or item the table does not know, or a
    // champion whose JSON named no loading screen) has no CDN mirror either,
    // so the icon is simply unavailable.
    if bytes.as_ref().is_none_or(|b| !is_served_image(key, b)) {
        let url = match key {
            IconKey::LoadScreen(_) => cdn_url_for_asset(asset.as_deref()?),
            _ => cdn_url(key),
        }?;
        let res = cdn_client().get(url).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        bytes = Some(res.bytes().await.ok()?.to_vec());
    }

    // 4. Only cache and serve verified image data.
    let bytes = bytes?;
    if !is_served_image(key, &bytes) {
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
    // A key without a known asset path (an augment or item the table has no
    // entry for, and loading-screen art, whose path only the champion JSON
    // names) is neither a success nor a failure: nothing to download.
    let mut failures = 0usize;
    for key in &keys {
        let Some(path) = lcu_path(key) else {
            continue;
        };
        match lcu.fetch_asset(&path).await {
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

    /// Minimal bytes that pass `is_jpeg`.
    fn jpeg_bytes() -> Vec<u8> {
        let mut bytes = JPEG_SIGNATURE.to_vec();
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
    fn test_parse_icon_path_accepts_valid_augment_and_item_paths() {
        assert_eq!(parse_icon_path("/augment/2141.png"), Some(IconKey::Augment(2141)));
        assert_eq!(parse_icon_path("/item/226668.png"), Some(IconKey::Item(226668)));
        // 7 digits still fit, the value only has to stay positive.
        assert_eq!(parse_icon_path("/item/9999999.png"), Some(IconKey::Item(9999999)));
    }

    #[test]
    fn test_parse_icon_path_accepts_load_screen_paths() {
        assert_eq!(parse_icon_path("/loadscreen/21.jpg"), Some(IconKey::LoadScreen(21)));
        assert_eq!(parse_icon_path("/loadscreen/1.jpg"), Some(IconKey::LoadScreen(1)));
    }

    #[test]
    fn test_parse_icon_path_rejects_bad_load_screen_paths() {
        // JPEG only, the champion id rules, and a lowercase kind segment.
        assert_eq!(parse_icon_path("/loadscreen/21.png"), None);
        assert_eq!(parse_icon_path("/loadscreen/21"), None);
        assert_eq!(parse_icon_path("/loadscreen/0.jpg"), None);
        assert_eq!(parse_icon_path("/LoadScreen/21.jpg"), None);
        assert_eq!(parse_icon_path("/loadscreen/1000000.jpg"), None);
        assert_eq!(parse_icon_path("/loadscreen/.jpg"), None);
        assert_eq!(parse_icon_path("/loadscreen/12a4.jpg"), None);
        assert_eq!(parse_icon_path("/loadscreen/../21.jpg"), None);
        assert_eq!(parse_icon_path("/loadscreen/21.jpg/extra.jpg"), None);
    }

    #[test]
    fn test_parse_icon_path_rejects_bad_augment_and_item_paths() {
        // Zero is not a table id; 8 digits exceed the cap.
        assert_eq!(parse_icon_path("/augment/0.png"), None);
        assert_eq!(parse_icon_path("/item/12345678.png"), None);
        // The kind segment is lowercase and the id is digits only.
        assert_eq!(parse_icon_path("/Augment/1.png"), None);
        assert_eq!(parse_icon_path("/Item/226668.png"), None);
        assert_eq!(parse_icon_path("/item/ab.png"), None);
        assert_eq!(parse_icon_path("/augment/.png"), None);
        assert_eq!(parse_icon_path("/item/226668.jpg"), None);
        assert_eq!(parse_icon_path("/item/226668"), None);
        // Same segment and traversal rules as the other kinds.
        assert_eq!(parse_icon_path("/item/../226668.png"), None);
        assert_eq!(parse_icon_path("/item/226668.png/extra.png"), None);
        assert_eq!(parse_icon_path("item/226668.png"), None);
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
            IconKey::Augment(2141),
            IconKey::Item(226668),
            IconKey::LoadScreen(21),
        ] {
            let name = file_name(&key);
            assert_eq!(key_from_file_name(&name), Some(key));
        }
        assert_eq!(file_name(&IconKey::Champion(266)), "champion-266.png");
        assert_eq!(file_name(&IconKey::Spell("summoner_flash".to_string())), "spell-summoner_flash.png");
        assert_eq!(file_name(&IconKey::Augment(2141)), "augment-2141.png");
        assert_eq!(file_name(&IconKey::Item(226668)), "item-226668.png");
        assert_eq!(file_name(&IconKey::LoadScreen(21)), "loadscreen-21.jpg");
    }

    #[test]
    fn test_key_from_file_name_rejects_non_icon_files() {
        assert_eq!(key_from_file_name("version.txt"), None);
        assert_eq!(key_from_file_name("champion-.png"), None);
        assert_eq!(key_from_file_name("champion-0.png"), None);
        assert_eq!(key_from_file_name("champion-266.txt"), None);
        assert_eq!(key_from_file_name("spell-Bad_Name.png"), None);
        assert_eq!(key_from_file_name("augment-0.png"), None);
        assert_eq!(key_from_file_name("item-12345678.png"), None);
        assert_eq!(key_from_file_name("item-226668.png.tmp"), None);
        assert_eq!(key_from_file_name("loadscreen-21.png"), None);
        assert_eq!(key_from_file_name("loadscreen-0.jpg"), None);
        assert_eq!(key_from_file_name("loadscreen-21.jpg.tmp"), None);
        assert_eq!(key_from_file_name("icon.png"), None);
    }

    #[test]
    fn test_lcu_path_and_cdn_url_exact_strings() {
        let champion = IconKey::Champion(266);
        assert_eq!(lcu_path(&champion).as_deref(), Some("/lol-game-data/assets/v1/champion-icons/266.png"));
        assert_eq!(
            cdn_url(&champion).as_deref(),
            Some(
                "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/266.png"
            )
        );
        let spell = IconKey::Spell("summoner_flash".to_string());
        assert_eq!(
            lcu_path(&spell).as_deref(),
            Some("/lol-game-data/assets/data/spells/icons2d/summoner_flash.png")
        );
        assert_eq!(
            cdn_url(&spell).as_deref(),
            Some(
                "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d/summoner_flash.png"
            )
        );
    }

    #[test]
    fn test_unknown_table_ids_have_no_path() {
        // Ids no real table can carry, so the assertion holds whatever the
        // process cache was loaded from; champion and spell stay unaffected.
        let augment = IconKey::Augment(i64::MAX - 1);
        let item = IconKey::Item(i64::MAX - 2);
        assert_eq!(lcu_path(&augment), None);
        assert_eq!(cdn_url(&augment), None);
        assert_eq!(lcu_path(&item), None);
        assert_eq!(cdn_url(&item), None);
    }

    #[test]
    fn test_load_screen_has_no_fixed_path() {
        // Its asset path only the champion JSON names, so neither the LCU path
        // nor the CDN URL can be built without that lookup.
        let key = IconKey::LoadScreen(21);
        assert_eq!(lcu_path(&key), None);
        assert_eq!(cdn_url(&key), None);
        assert_eq!(champion_json_path(21), "/lol-game-data/assets/v1/champions/21.json");
        assert_eq!(
            cdn_champion_json_url(21),
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champions/21.json"
        );
    }

    #[test]
    fn test_base_load_screen_path_prefers_the_base_skin() {
        // `isBase` wins even when it is not the first entry.
        let champion = serde_json::json!({
            "skins": [
                { "isBase": false,
                  "loadScreenPath": "/lol-game-data/assets/ASSETS/Characters/MissFortune/Skins/Skin01/MissFortuneLoadScreen.jpg" },
                { "isBase": true,
                  "loadScreenPath": "/lol-game-data/assets/ASSETS/Characters/MissFortune/Skins/Base/MissFortuneLoadScreen.jpg" },
            ]
        });
        assert_eq!(
            base_load_screen_path(&champion).as_deref(),
            Some("/lol-game-data/assets/ASSETS/Characters/MissFortune/Skins/Base/MissFortuneLoadScreen.jpg")
        );

        // No `isBase` flag: the first skin is used.
        let champion = serde_json::json!({
            "skins": [
                { "loadScreenPath": "/first.jpg" },
                { "isBase": false, "loadScreenPath": "/second.jpg" },
            ]
        });
        assert_eq!(base_load_screen_path(&champion).as_deref(), Some("/first.jpg"));

        // A base skin without a path falls back to the first skin.
        let champion = serde_json::json!({
            "skins": [
                { "loadScreenPath": "/first.jpg" },
                { "isBase": true, "loadScreenPath": "" },
            ]
        });
        assert_eq!(base_load_screen_path(&champion).as_deref(), Some("/first.jpg"));

        // Nothing usable: no skins, blank or non-string paths, not an object.
        for champion in [
            serde_json::json!({}),
            serde_json::json!({ "skins": [] }),
            serde_json::json!({ "skins": null }),
            serde_json::json!({ "skins": [ { "isBase": true } ] }),
            serde_json::json!({ "skins": [ { "loadScreenPath": "" } ] }),
            serde_json::json!({ "skins": [ { "loadScreenPath": 42 } ] }),
            serde_json::json!(null),
        ] {
            assert_eq!(base_load_screen_path(&champion), None, "{champion}");
        }
    }

    #[test]
    fn test_cdn_url_for_asset_mirrors_client_assets() {
        assert_eq!(
            cdn_url_for_asset("/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/UltraHydra_small.png")
                .as_deref(),
            Some(
                "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/ux/kiwi/augments/icons/ultrahydra_small.png"
            )
        );
        assert_eq!(
            cdn_url_for_asset(
                "/lol-game-data/assets/ASSETS/Items/Icons2D/3071_Fighter_T3_BlackCleaver.png"
            )
            .as_deref(),
            Some(
                "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/items/icons2d/3071_fighter_t3_blackcleaver.png"
            )
        );
        // Anything not under the client asset prefix has no mirror.
        assert_eq!(cdn_url_for_asset("/assets/Items/Icons2D/3071.png"), None);
        assert_eq!(cdn_url_for_asset("/lol-game-data/assets/"), None);
        assert_eq!(cdn_url_for_asset(""), None);
        assert_eq!(cdn_url_for_asset("https://example.com/x.png"), None);
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
    fn test_is_jpeg_checks_start_of_image_marker() {
        assert!(is_jpeg(&jpeg_bytes()));
        assert!(is_jpeg(&JPEG_SIGNATURE));
        assert!(!is_jpeg(b""));
        assert!(!is_jpeg(b"<html>404</html>"));
        assert!(!is_jpeg(&png_bytes()));
        assert!(!is_jpeg(&JPEG_SIGNATURE[..2]));
        assert!(!is_jpeg(&[0xFF, 0xD8, 0xFE]));
    }

    #[test]
    fn test_is_served_image_matches_the_kind() {
        assert!(is_served_image(&IconKey::Champion(266), &png_bytes()));
        assert!(!is_served_image(&IconKey::Champion(266), &jpeg_bytes()));
        assert!(is_served_image(&IconKey::LoadScreen(21), &jpeg_bytes()));
        assert!(!is_served_image(&IconKey::LoadScreen(21), &png_bytes()));
    }

    #[test]
    fn test_content_type_follows_the_kind() {
        assert_eq!(content_type(&IconKey::LoadScreen(21)), "image/jpeg");
        for key in [
            IconKey::Champion(266),
            IconKey::Spell("summoner_flash".to_string()),
            IconKey::Augment(2141),
            IconKey::Item(226668),
        ] {
            assert_eq!(content_type(&key), "image/png", "{key:?}");
        }
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

    #[tokio::test]
    async fn test_load_serves_cached_jpeg_load_screen_without_lcu_or_network() {
        let dir = temp_dir("load-cache-hit-loadscreen");
        let bytes = jpeg_bytes();
        write_atomic(&dir, "loadscreen-21.jpg", &bytes).expect("seed the cache");

        let loaded = load(&LcuManager::new(), &dir, &IconKey::LoadScreen(21)).await;
        assert_eq!(loaded, Some(bytes));

        std::fs::remove_dir_all(&dir).expect("temp folder removed");
    }
}
